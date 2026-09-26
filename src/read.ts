import type { Env } from './types';
import { normalizeBrand, normalizeUpc } from './normalize';

/**
 * Public read API for the app. No auth: everything here is already-public
 * recall information. Kept entirely separate from the /admin routes.
 *
 * The unit of this API is a recall *event*, not a database row. openFDA splits
 * one recall across many enforcement reports — one per product or lot, each
 * with its own recall number but a shared event_id. Left ungrouped, a single
 * barcode scan returns sixteen results for what is one recall. Everything below
 * groups on that event_id and nests the individual reports as variants.
 *
 * Responses are self-contained — products, UPCs and variants are embedded — so
 * rendering a list never costs a second round trip.
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_TIER_MATCHES = 20;
const CACHE_SECONDS = 300;

/** How far apart two reports of the same recall may sit before we stop merging. */
const MERGE_WINDOW_DAYS = 90;

/**
 * The grouping key. openFDA carries event_id inside the stored payload; the
 * press feed has no equivalent and every one of its items is its own event.
 * Anything without an event_id falls back to its own row id, so ungrouped
 * records pass through untouched rather than collapsing into a null bucket.
 */
const EVENT_KEY = `CASE
  WHEN r.source = 'fda' AND json_extract(r.raw_json, '$.event_id') IS NOT NULL
  THEN 'fda_event:' || json_extract(r.raw_json, '$.event_id')
  ELSE r.id
END`;

/** D1 caps bound parameters at 100 per statement. Stay clear of the edge. */
const MAX_BOUND_PARAMS = 80;

/**
 * True for a press announcement that an enforcement report already covers.
 *
 * Written as a correlated subquery carrying no bound parameters, so it can sit
 * inside a paginated WHERE clause without competing for the parameter budget —
 * binding one id per superseded record does not survive contact with a growing
 * press feed.
 */
const SUPERSEDED = `(r.source = 'fda_press' AND EXISTS (
  SELECT 1 FROM recalls c
   WHERE c.source = 'fda' AND c.id <> r.id
     AND (r.recall_date IS NULL OR c.recall_date IS NULL
          OR ABS(JULIANDAY(c.recall_date) - JULIANDAY(r.recall_date)) <= ${MERGE_WINDOW_DAYS})
     AND (
       EXISTS (
         SELECT 1 FROM recall_upcs ua
           JOIN recall_upcs ub ON ub.upc = ua.upc
          WHERE ua.recall_id = r.id AND ub.recall_id = c.id
       )
       OR EXISTS (
         SELECT 1 FROM recall_products pa
           JOIN recall_products pb
             ON pb.brand_id = pa.brand_id
            AND LOWER(TRIM(pb.product_name)) = LOWER(TRIM(pa.product_name))
          WHERE pa.recall_id = r.id AND pb.recall_id = c.id
            AND pa.brand_id IS NOT NULL
            AND pa.product_name IS NOT NULL
            AND TRIM(pa.product_name) <> ''
       )
     )
))`;

const TIERS = {
  upc_exact: { rank: 1, label: 'Exact barcode match' },
  brand_product: { rank: 2, label: 'Same brand and product' },
  brand_only: { rank: 3, label: 'Same brand, different product' },
} as const;

type TierKey = keyof typeof TIERS;

export async function handleRead(
  req: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;

  const path = url.pathname;
  const isRead = path === '/recalls' || path === '/brands' || path.startsWith('/upc/');
  if (!isRead) return null;

  const cache = caches.default;
  const hit = await cache.match(req);
  if (hit) return hit;

  let res: Response;
  try {
    if (path === '/recalls') {
      res = json(await listRecalls(env.DB, url));
    } else if (path === '/brands') {
      res = json(await listBrands(env.DB, url));
    } else {
      res = json(await matchUpc(env.DB, decodeURIComponent(path.slice('/upc/'.length)), url));
    }
  } catch (err) {
    // A read failure must not surface as a bare 1101 either.
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }

  if (res.status === 200) ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}

// ---------------------------------------------------------------------------
// Cross-source de-duplication
// ---------------------------------------------------------------------------

interface DupPair {
  duplicate_id: string;
  canonical_id: string;
}

/**
 * A recall can be announced by the company (fda_press) and then published as a
 * classified enforcement report (fda) weeks later. Those are one event, and the
 * enforcement report is canonical — it carries the recall number, classification
 * and status.
 *
 * Matching is on exact keys only: a shared UPC, or a shared resolved brand plus
 * an identical product name, both within MERGE_WINDOW_DAYS. Brand alone is
 * deliberately not enough — one brand can have several unrelated recalls, and
 * collapsing those would hide one from the person who needed to see it.
 */
async function duplicatePairs(db: D1Database): Promise<DupPair[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id AS duplicate_id, MIN(c.id) AS canonical_id
         FROM recalls p
         JOIN recalls c
           ON c.source = 'fda'
          AND c.id <> p.id
          AND (p.recall_date IS NULL OR c.recall_date IS NULL
               OR ABS(JULIANDAY(c.recall_date) - JULIANDAY(p.recall_date)) <= ?)
        WHERE p.source = 'fda_press'
          AND (
            EXISTS (
              SELECT 1 FROM recall_upcs ua
                JOIN recall_upcs ub ON ub.upc = ua.upc
               WHERE ua.recall_id = p.id AND ub.recall_id = c.id
            )
            OR EXISTS (
              SELECT 1 FROM recall_products pa
                JOIN recall_products pb
                  ON pb.brand_id = pa.brand_id
                 AND LOWER(TRIM(pb.product_name)) = LOWER(TRIM(pa.product_name))
               WHERE pa.recall_id = p.id
                 AND pb.recall_id = c.id
                 AND pa.brand_id IS NOT NULL
                 AND pa.product_name IS NOT NULL
                 AND TRIM(pa.product_name) <> ''
            )
          )
        GROUP BY p.id`,
    )
    .bind(MERGE_WINDOW_DAYS)
    .all<DupPair>();

  return results;
}

// ---------------------------------------------------------------------------
// GET /recalls
// ---------------------------------------------------------------------------

async function listRecalls(db: D1Database, url: URL) {
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000);
  const category = url.searchParams.get('category');
  const species = url.searchParams.get('species');

  const dups = await duplicatePairs(db);

  const where: string[] = ['r.extraction_version IS NOT NULL', `NOT ${SUPERSEDED}`];
  const binds: unknown[] = [];

  // Filters match at record level, so an event surfaces when any of its reports
  // matches. Never hiding a relevant event matters more than a tidy card.
  if (category) {
    where.push('r.category = ?');
    binds.push(category);
  }
  if (species) {
    where.push('r.species LIKE ?');
    binds.push(`%"${species}"%`);
  }

  const whereSql = where.join(' AND ');

  const totalRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT ${EVENT_KEY} AS k FROM recalls r WHERE ${whereSql} GROUP BY k)`,
    )
    .bind(...binds)
    .first<{ n: number }>();

  const { results: keyRows } = await db
    .prepare(
      `SELECT ${EVENT_KEY} AS event_key, MAX(r.recall_date) AS sort_date
         FROM recalls r
        WHERE ${whereSql}
        GROUP BY event_key
        ORDER BY sort_date DESC, event_key DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all<{ event_key: string; sort_date: string | null }>();

  const events = await loadEvents(db, keyRows.map((k) => k.event_key), dups);
  const total = totalRow?.n ?? 0;

  return {
    recalls: events,
    page: {
      limit,
      offset,
      total,
      returned: events.length,
      has_more: offset + events.length < total,
      next_offset: offset + events.length < total ? offset + events.length : null,
    },
    filters: { category: category ?? null, species: species ?? null },
    grouping: 'event',
    merged_duplicates: dups.length,
  };
}

// ---------------------------------------------------------------------------
// GET /upc/:code
// ---------------------------------------------------------------------------

async function matchUpc(db: D1Database, rawCode: string, url: URL) {
  const normalized = normalizeUpc(rawCode);

  if (!normalized) {
    // Say why rather than returning an empty match, which reads as "not
    // recalled" and is the one wrong answer that matters here.
    return {
      upc: { queried: rawCode, normalized: null, valid: false },
      reason: 'Not a valid 12, 13 or 14 digit barcode with a correct check digit.',
      matched: false,
      matches: [],
      counts: { upc_exact: 0, brand_product: 0, brand_only: 0 },
    };
  }

  const dups = await duplicatePairs(db);
  const hidden = new Set(dups.map((d) => d.duplicate_id));

  // Tier 1 — the barcode itself, collapsed to the events behind it.
  const { results: exactRows } = await db
    .prepare(
      `SELECT DISTINCT ${EVENT_KEY} AS event_key, r.id
         FROM recalls r
         JOIN recall_upcs u ON u.recall_id = r.id
        WHERE u.upc = ?`,
    )
    .bind(normalized)
    .all<{ event_key: string; id: string }>();

  const exactKeys = uniq(exactRows.filter((r) => !hidden.has(r.id)).map((r) => r.event_key))
    .slice(0, MAX_TIER_MATCHES);
  const claimed = new Set(exactKeys);

  // Widen to the brand behind the barcode. Where an exact match identified the
  // product, use its brand; otherwise the caller can supply what it knows.
  const brandIds = new Set<number>();
  const productNames = new Set<string>();

  const exactRecordIds = exactRows.filter((r) => !hidden.has(r.id)).map((r) => r.id);
  if (exactRecordIds.length) {
    const results = await selectIn<{ brand_id: number; product_name: string | null }>(
      db,
      (ph) =>
        `SELECT brand_id, product_name FROM recall_products
          WHERE recall_id IN (${ph}) AND brand_id IS NOT NULL`,
      exactRecordIds,
    );

    for (const p of results) {
      brandIds.add(p.brand_id);
      if (p.product_name) productNames.add(p.product_name.trim().toLowerCase());
    }
  }

  const brandParam = url.searchParams.get('brand');
  if (brandParam) {
    for (const id of await resolveBrandIds(db, brandParam)) brandIds.add(id);
  }
  const productParam = url.searchParams.get('product');
  if (productParam) productNames.add(productParam.trim().toLowerCase());

  let brandProductKeys: string[] = [];
  let brandOnlyKeys: string[] = [];

  if (brandIds.size) {
    // Two IN lists share one statement's parameter budget, so both are bounded.
    const ids = [...brandIds].slice(0, 25);

    if (productNames.size) {
      const names = [...productNames].slice(0, 25);
      const { results } = await db
        .prepare(
          `SELECT DISTINCT ${EVENT_KEY} AS event_key, r.id
             FROM recalls r
             JOIN recall_products p ON p.recall_id = r.id
            WHERE p.brand_id IN (${placeholders(ids.length)})
              AND LOWER(TRIM(p.product_name)) IN (${placeholders(names.length)})`,
        )
        .bind(...ids, ...names)
        .all<{ event_key: string; id: string }>();

      brandProductKeys = uniq(
        results.filter((r) => !hidden.has(r.id)).map((r) => r.event_key),
      )
        .filter((k) => !claimed.has(k))
        .slice(0, MAX_TIER_MATCHES);
      for (const k of brandProductKeys) claimed.add(k);
    }

    const { results } = await db
      .prepare(
        `SELECT DISTINCT ${EVENT_KEY} AS event_key, r.id
           FROM recalls r
           JOIN recall_products p ON p.recall_id = r.id
          WHERE p.brand_id IN (${placeholders(ids.length)})`,
      )
      .bind(...ids)
      .all<{ event_key: string; id: string }>();

    brandOnlyKeys = uniq(results.filter((r) => !hidden.has(r.id)).map((r) => r.event_key))
      .filter((k) => !claimed.has(k))
      .slice(0, MAX_TIER_MATCHES);
  }

  const events = await loadEvents(
    db,
    [...exactKeys, ...brandProductKeys, ...brandOnlyKeys],
    dups,
  );
  const byKey = new Map(events.map((e) => [e.id, e]));

  const matches = [
    ...tier('upc_exact', exactKeys, byKey),
    ...tier('brand_product', brandProductKeys, byKey),
    ...tier('brand_only', brandOnlyKeys, byKey),
  ];

  return {
    upc: { queried: rawCode, normalized, valid: true },
    matched: exactKeys.length > 0,
    counts: {
      upc_exact: exactKeys.length,
      brand_product: brandProductKeys.length,
      brand_only: brandOnlyKeys.length,
    },
    grouping: 'event',
    tiers: TIERS,
    matches,
  };
}

function tier(key: TierKey, keys: string[], byKey: Map<string, RecallEvent>) {
  return keys
    .map((k) => byKey.get(k))
    .filter((e): e is RecallEvent => Boolean(e))
    .map((recall) => ({ tier: key, rank: TIERS[key].rank, label: TIERS[key].label, recall }));
}

async function resolveBrandIds(db: D1Database, raw: string): Promise<number[]> {
  const normalized = normalizeBrand(raw);
  if (!normalized) return [];

  const { results } = await db
    .prepare(
      `SELECT id FROM brands WHERE normalized_name = ?
        UNION
       SELECT brand_id AS id FROM brand_aliases WHERE alias_normalized = ?`,
    )
    .bind(normalized, normalized)
    .all<{ id: number }>();

  return results.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// GET /brands
// ---------------------------------------------------------------------------

async function listBrands(db: D1Database, url: URL) {
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000);
  const q = url.searchParams.get('q');
  const category = url.searchParams.get('category');

  // brands.recall_count is never maintained by the ingest path, so it is
  // counted here — and counted in events, so a brand caught in one 16-report
  // recall reads as one recall rather than sixteen.
  //
  // SUPERSEDED is a correlated subquery. Inlined into this WHERE it ran once per
  // joined brand/product row — about 7 s and 40M rows read per statement, so a
  // cold search took ~14 s. Evaluated once over the press rows as a CTE it is
  // the same set, for ~0.3 s.
  const where: string[] = ['p.brand_id IS NOT NULL', 'r.id NOT IN (SELECT id FROM superseded)'];
  const binds: unknown[] = [];

  if (q) {
    const normalized = normalizeBrand(q);
    where.push('(b.normalized_name LIKE ? OR LOWER(b.canonical_name) LIKE ?)');
    binds.push(`%${normalized ?? q.toLowerCase()}%`, `%${q.toLowerCase()}%`);
  }
  if (category) {
    where.push('r.category = ?');
    binds.push(category);
  }

  const whereSql = where.join(' AND ');
  const supersededCte = `WITH superseded AS MATERIALIZED (
    SELECT r.id FROM recalls r WHERE r.source = 'fda_press' AND ${SUPERSEDED}
  )`;

  // One round trip for both statements.
  const [totalResult, pageResult] = await db.batch([
    db
      .prepare(
        `${supersededCte}
       SELECT COUNT(*) AS n FROM (
         SELECT b.id FROM brands b
           JOIN recall_products p ON p.brand_id = b.id
           JOIN recalls r ON r.id = p.recall_id
          WHERE ${whereSql}
          GROUP BY b.id)`,
      )
      .bind(...binds),
    db
      .prepare(
        `${supersededCte}
       SELECT b.id, b.canonical_name, b.normalized_name,
              COUNT(DISTINCT ${EVENT_KEY}) AS recall_count,
              COUNT(DISTINCT p.recall_id) AS report_count,
              MAX(r.recall_date) AS latest_recall_date,
              GROUP_CONCAT(DISTINCT r.category) AS categories
         FROM brands b
         JOIN recall_products p ON p.brand_id = b.id
         JOIN recalls r ON r.id = p.recall_id
        WHERE ${whereSql}
        GROUP BY b.id
        ORDER BY recall_count DESC, b.canonical_name ASC
        LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset),
  ]);

  const results = pageResult.results as {
    id: number;
    canonical_name: string;
    normalized_name: string;
    recall_count: number;
    report_count: number;
    latest_recall_date: string | null;
    categories: string | null;
  }[];
  const total = (totalResult.results[0] as { n: number } | undefined)?.n ?? 0;

  return {
    brands: results.map((b) => ({
      id: b.id,
      name: b.canonical_name,
      normalized_name: b.normalized_name,
      recall_count: b.recall_count,
      report_count: b.report_count,
      latest_recall_date: b.latest_recall_date,
      categories: (b.categories ?? '').split(',').filter(Boolean).sort(),
    })),
    page: {
      limit,
      offset,
      total,
      returned: results.length,
      has_more: offset + results.length < total,
      next_offset: offset + results.length < total ? offset + results.length : null,
    },
    filters: { q: q ?? null, category: category ?? null },
    grouping: 'event',
  };
}

// ---------------------------------------------------------------------------
// Event assembly
// ---------------------------------------------------------------------------

interface RecordRow {
  event_key: string;
  id: string;
  source: string;
  source_id: string;
  title: string | null;
  category: string | null;
  species: string | null;
  classification: string | null;
  status: string | null;
  recall_date: string | null;
  recalling_firm: string | null;
  states: string | null;
  url: string | null;
  extraction_confidence: string | null;
}

interface ProductOut {
  brand: string | null;
  product_name: string | null;
  package_sizes: string[];
  lot_codes: string[];
  establishment_number: string | null;
}

interface RecallEvent {
  id: string;
  event_id: string | null;
  source: string;
  report_count: number;
  title: string | null;
  category: string | null;
  categories: string[];
  species: string[];
  classification: string | null;
  status: string | null;
  recall_date: string | null;
  first_reported_date: string | null;
  recalling_firm: string | null;
  states: string[];
  url: string | null;
  confidence: string | null;
  products: ProductOut[];
  upcs: string[];
  variants: Array<{
    id: string;
    source_id: string;
    title: string | null;
    classification: string | null;
    status: string | null;
    recall_date: string | null;
    upcs: string[];
  }>;
  also_reported_by: Array<{ id: string; source: string; url: string | null }>;
}

/**
 * Load every report belonging to the given events and fold each set into one
 * entry. Deliberately not filtered by the caller's category or species: a card
 * should show the whole event, including the reports that did not match.
 */
async function loadEvents(
  db: D1Database,
  keys: string[],
  dups: DupPair[],
): Promise<RecallEvent[]> {
  const ordered = uniq(keys);
  if (ordered.length === 0) return [];

  const rows = await selectIn<RecordRow>(
    db,
    (ph) =>
      `SELECT ${EVENT_KEY} AS event_key, r.id, r.source, r.source_id, r.title,
              r.category, r.species, r.classification, r.status, r.recall_date,
              r.recalling_firm, r.states, r.url, r.extraction_confidence
         FROM recalls r
        WHERE ${EVENT_KEY} IN (${ph})
        ORDER BY r.recall_date DESC, r.source_id ASC`,
    ordered,
  );

  if (rows.length === 0) return [];

  const recordIds = rows.map((r) => r.id);

  const [products, upcRows] = await Promise.all([
    selectIn<{
      recall_id: string;
      brand_raw: string | null;
      product_name: string | null;
      package_sizes: string | null;
      lot_codes: string | null;
      establishment_number: string | null;
    }>(
      db,
      (ph) =>
        `SELECT recall_id, brand_raw, product_name, package_sizes, lot_codes,
                establishment_number
           FROM recall_products WHERE recall_id IN (${ph}) ORDER BY id`,
      recordIds,
    ),
    selectIn<{ recall_id: string; upc: string }>(
      db,
      (ph) => `SELECT recall_id, upc FROM recall_upcs WHERE recall_id IN (${ph})`,
      recordIds,
    ),
  ]);

  const productsBy = groupBy(products, (p) => p.recall_id);
  const upcsBy = groupBy(upcRows, (u) => u.recall_id);

  // Press announcements folded into an enforcement report, so the app can cite
  // the earlier company notice alongside it.
  const dupByCanonical = groupBy(dups, (d) => d.canonical_id);
  const relevantDupIds = dups
    .filter((d) => rows.some((r) => r.id === d.canonical_id))
    .map((d) => d.duplicate_id);

  let dupById = new Map<string, { id: string; source: string; url: string | null }>();
  if (relevantDupIds.length) {
    const found = await selectIn<{ id: string; source: string; url: string | null }>(
      db,
      (ph) => `SELECT id, source, url FROM recalls WHERE id IN (${ph})`,
      relevantDupIds,
    );
    dupById = new Map(found.map((d) => [d.id, d]));
  }

  const byKey = groupBy(rows, (r) => r.event_key);

  return ordered
    .filter((k) => byKey.has(k))
    .map((key) => buildEvent(key, byKey.get(key)!, productsBy, upcsBy, dupByCanonical, dupById));
}

function buildEvent(
  key: string,
  records: RecordRow[],
  productsBy: Map<string, Array<{
    recall_id: string;
    brand_raw: string | null;
    product_name: string | null;
    package_sizes: string | null;
    lot_codes: string | null;
    establishment_number: string | null;
  }>>,
  upcsBy: Map<string, Array<{ recall_id: string; upc: string }>>,
  dupByCanonical: Map<string, DupPair[]>,
  dupById: Map<string, { id: string; source: string; url: string | null }>,
): RecallEvent {
  const primary = records[0];
  const dates = records.map((r) => r.recall_date).filter((d): d is string => Boolean(d)).sort();

  const categories = uniq(records.map((r) => r.category).filter((c): c is string => Boolean(c)));
  const products: ProductOut[] = [];
  const seenProduct = new Set<string>();
  const upcs = new Set<string>();

  for (const rec of records) {
    for (const p of productsBy.get(rec.id) ?? []) {
      const sizes = jsonArray(p.package_sizes);
      const fingerprint = `${p.brand_raw ?? ''}|${p.product_name ?? ''}|${sizes.join(',')}`;
      if (seenProduct.has(fingerprint)) continue;
      seenProduct.add(fingerprint);
      products.push({
        brand: p.brand_raw,
        product_name: p.product_name,
        package_sizes: sizes,
        lot_codes: jsonArray(p.lot_codes),
        establishment_number: p.establishment_number,
      });
    }
    for (const u of upcsBy.get(rec.id) ?? []) upcs.add(u.upc);
  }

  const alsoBy = records.flatMap((r) => dupByCanonical.get(r.id) ?? []);

  return {
    id: key,
    event_id: key.startsWith('fda_event:') ? key.slice('fda_event:'.length) : null,
    source: primary.source,
    report_count: records.length,
    title: primary.title,
    // Most common category across the event, with the safety-relevant one
    // winning a tie, and every category listed so nothing is hidden by the pick.
    category: pickCategory(records),
    categories,
    species: uniq(records.flatMap((r) => jsonArray(r.species))),
    // Most severe class and most active status across the event: an event is as
    // serious as its worst report.
    classification: pickClassification(records),
    status: pickStatus(records),
    recall_date: dates.length ? dates[dates.length - 1] : null,
    first_reported_date: dates.length > 1 ? dates[0] : null,
    recalling_firm: primary.recalling_firm,
    states: uniq(records.flatMap((r) => jsonArray(r.states))),
    url: records.find((r) => r.url)?.url ?? null,
    confidence: pickConfidence(records),
    products,
    upcs: [...upcs],
    variants: records.map((r) => ({
      id: r.id,
      source_id: r.source_id,
      title: r.title,
      classification: r.classification,
      status: r.status,
      recall_date: r.recall_date,
      upcs: (upcsBy.get(r.id) ?? []).map((u) => u.upc),
    })),
    also_reported_by: alsoBy
      .map((d) => dupById.get(d.duplicate_id))
      .filter((d): d is { id: string; source: string; url: string | null } => Boolean(d)),
  };
}

const CATEGORY_PRIORITY = ['pet_food', 'human_food', 'drug', 'device', 'other'];

function pickCategory(records: RecordRow[]): string | null {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (!r.category) continue;
    counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  let best: string | null = null;
  for (const [cat, n] of counts) {
    if (best === null) { best = cat; continue; }
    const bestN = counts.get(best)!;
    if (n > bestN) best = cat;
    else if (n === bestN &&
             CATEGORY_PRIORITY.indexOf(cat) < CATEGORY_PRIORITY.indexOf(best)) best = cat;
  }
  return best;
}

function pickClassification(records: RecordRow[]): string | null {
  const rank = (c: string | null) => {
    const s = (c ?? '').toLowerCase();
    if (s.includes('class i') && !s.includes('class ii')) return 1;
    if (s.includes('class iii')) return 3;
    if (s.includes('class ii')) return 2;
    return 9;
  };
  const sorted = records
    .map((r) => r.classification)
    .filter((c): c is string => Boolean(c))
    .sort((a, b) => rank(a) - rank(b));
  return sorted[0] ?? null;
}

function pickStatus(records: RecordRow[]): string | null {
  const statuses = records.map((r) => (r.status ?? '').toLowerCase()).filter(Boolean);
  if (statuses.includes('ongoing')) return 'ongoing';
  return records.find((r) => r.status)?.status ?? null;
}

function pickConfidence(records: RecordRow[]): string | null {
  const order = ['high', 'medium', 'low'];
  const found = records
    .map((r) => r.extraction_confidence)
    .filter((c): c is string => Boolean(c))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return found[0] ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run an IN (...) query in chunks that respect D1's per-statement parameter
 * cap, concatenating the results. Callers receive one flat list.
 */
async function selectIn<T>(
  db: D1Database,
  build: (placeholderList: string) => string,
  values: unknown[],
): Promise<T[]> {
  const out: T[] = [];

  for (let i = 0; i < values.length; i += MAX_BOUND_PARAMS) {
    const chunk = values.slice(i, i + MAX_BOUND_PARAMS);
    const { results } = await db
      .prepare(build(placeholders(chunk.length)))
      .bind(...chunk)
      .all<T>();
    out.push(...results);
  }

  return out;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

function jsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw === null || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 ? `public, max-age=${CACHE_SECONDS}` : 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
