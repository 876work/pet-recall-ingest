import type { Extraction, RawRecord } from './types';
import { normalizeBrand, sha256 } from './normalize';
import { EXTRACTION_VERSION } from './extract';

export type UpsertResult = 'inserted' | 'updated' | 'unchanged';

export interface UpsertSummary {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Left for a later run because the per-invocation budget ran out. */
  skipped: number;
  errors: string[];
}

/** Statements per db.batch() call. One batch costs one binding call. */
const STATEMENTS_PER_BATCH = 100;

type Planned = { id: string; rec: RawRecord; hash: string; kind: UpsertResult };

/**
 * Upsert a batch of source records.
 *
 * Reads every known content hash in one query and writes through db.batch(),
 * so a full corpus costs a couple of dozen binding calls rather than three per
 * record. Doing it per-record blows the per-invocation binding-call limit once
 * the corpus reaches a few hundred notices.
 *
 * A record whose hash is unchanged only gets its volatile fields refreshed,
 * which is how we avoid paying for extraction on every run. A real change
 * clears extraction_version so the extraction pass picks it up again.
 */
export async function upsertRecalls(
  db: D1Database,
  recs: RawRecord[],
  limit: number,
): Promise<UpsertSummary> {
  const summary: UpsertSummary = {
    inserted: 0, updated: 0, unchanged: 0, skipped: 0, errors: [],
  };
  if (recs.length === 0) return summary;

  // One read instead of a SELECT per record. The recall corpus is small by
  // design (low thousands of rows), so pulling every hash stays cheap.
  const { results } = await db
    .prepare('SELECT id, content_hash FROM recalls')
    .all<{ id: string; content_hash: string }>();
  const known = new Map(results.map((r) => [r.id, r.content_hash]));

  const planned: Planned[] = [];
  for (const rec of recs) {
    const id = `${rec.source}:${rec.sourceId}`;

    // Hash only fields whose change should trigger re-extraction. Deliberately
    // excludes status, so a recall closing does not burn an LLM call.
    const hash = await sha256(
      JSON.stringify([rec.description, rec.reason, rec.title, rec.recallingFirm]),
    );

    const prior = known.get(id);
    const kind: UpsertResult =
      prior === hash ? 'unchanged' : prior === undefined ? 'inserted' : 'updated';

    planned.push({ id, rec, hash, kind });
  }

  // New and changed records first. An unchanged row only needs a cheap volatile
  // refresh, so it is the right thing to defer when the budget runs out.
  planned.sort(
    (a, b) => (a.kind === 'unchanged' ? 1 : 0) - (b.kind === 'unchanged' ? 1 : 0),
  );

  const selected = planned.slice(0, limit);
  summary.skipped = planned.length - selected.length;

  // Each record's statements stay adjacent so the recalls row is always written
  // before the notify_queue row whose foreign key references it.
  const ops = selected.map((p) => ({ kind: p.kind, statements: statementsFor(db, p) }));

  for (let i = 0; i < ops.length; ) {
    const chunk: typeof ops = [];
    let count = 0;
    while (
      i < ops.length &&
      (count === 0 || count + ops[i].statements.length <= STATEMENTS_PER_BATCH)
    ) {
      count += ops[i].statements.length;
      chunk.push(ops[i]);
      i++;
    }

    try {
      await db.batch(chunk.flatMap((o) => o.statements));
      for (const o of chunk) summary[o.kind]++;
    } catch (err) {
      // A batch runs as one transaction, so the whole chunk rolled back. Those
      // records were never written; the next run sees them as new and retries.
      summary.errors.push(`upsert batch of ${chunk.length}: ${msg(err)}`);
    }
  }

  return summary;
}

function statementsFor(db: D1Database, p: Planned): D1PreparedStatement[] {
  const { id, rec, hash } = p;

  if (p.kind === 'unchanged') {
    // Volatile fields only; they are cheap and free of LLM cost.
    return [
      db
        .prepare(
          `UPDATE recalls SET status = ?, states = ?, updated_at = datetime('now') WHERE id = ?`,
        )
        .bind(rec.status, JSON.stringify(rec.states), id),
    ];
  }

  return [
    db
      .prepare(
        `INSERT INTO recalls (
           id, source, source_id, title, raw_description, reason, classification,
           status, recall_date, recalling_firm, states, url, raw_json, content_hash,
           extraction_version
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           raw_description = excluded.raw_description,
           reason = excluded.reason,
           classification = excluded.classification,
           status = excluded.status,
           recall_date = excluded.recall_date,
           recalling_firm = excluded.recalling_firm,
           states = excluded.states,
           url = excluded.url,
           raw_json = excluded.raw_json,
           content_hash = excluded.content_hash,
           extraction_version = NULL,
           updated_at = datetime('now')`,
      )
      .bind(
        id, rec.source, rec.sourceId, rec.title, rec.description, rec.reason,
        rec.classification, rec.status, rec.recallDate, rec.recallingFirm,
        JSON.stringify(rec.states), rec.url, JSON.stringify(rec.raw), hash,
      ),
    db
      .prepare(
        `INSERT INTO notify_queue (recall_id, reason) VALUES (?, ?)
         ON CONFLICT(recall_id) DO NOTHING`,
      )
      .bind(id, p.kind === 'updated' ? 'updated' : 'new'),
  ];
}

/** Records awaiting extraction, oldest first. */
export async function pendingExtraction(
  db: D1Database,
  limit: number,
): Promise<Array<{ id: string; source: string; title: string | null; raw_description: string; reason: string | null; recalling_firm: string | null }>> {
  const { results } = await db
    .prepare(
      `SELECT id, source, title, raw_description, reason, recalling_firm
         FROM recalls
        WHERE extraction_version IS NULL OR extraction_version < ?
        ORDER BY recall_date DESC
        LIMIT ?`,
    )
    .bind(EXTRACTION_VERSION, limit)
    .all();

  return results as any;
}

export async function saveExtraction(
  db: D1Database,
  recallId: string,
  ex: Extraction,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  // Extraction is idempotent: wipe derived rows and rewrite them.
  statements.push(db.prepare('DELETE FROM recall_products WHERE recall_id = ?').bind(recallId));
  statements.push(db.prepare('DELETE FROM recall_upcs WHERE recall_id = ?').bind(recallId));

  for (const p of ex.products) {
    const brandId = p.brand ? await resolveBrand(db, p.brand) : null;
    statements.push(
      db
        .prepare(
          `INSERT INTO recall_products
             (recall_id, brand_raw, brand_id, product_name, package_sizes, lot_codes, establishment_number)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .bind(
          recallId, p.brand, brandId, p.product_name,
          JSON.stringify(p.package_sizes), JSON.stringify(p.lot_codes),
          p.establishment_number,
        ),
    );
  }

  for (const upc of ex.upcs) {
    statements.push(
      db
        .prepare('INSERT OR IGNORE INTO recall_upcs (recall_id, upc, upc_raw) VALUES (?,?,?)')
        .bind(recallId, upc, upc),
    );
  }

  statements.push(
    db
      .prepare(
        `UPDATE recalls SET
           category = ?, species = ?, extraction_version = ?,
           extraction_confidence = ?, extracted_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(ex.category, JSON.stringify(ex.species), EXTRACTION_VERSION, ex.confidence, recallId),
  );

  await db.batch(statements);
}

/**
 * Resolve a raw brand string to a brand row. Checks the hand-maintained alias
 * table first, then exact normalized match, then creates. No fuzzy matching by
 * design — see the note in normalize.ts.
 */
async function resolveBrand(db: D1Database, raw: string): Promise<number | null> {
  const normalized = normalizeBrand(raw);
  if (!normalized) return null;

  const alias = await db
    .prepare('SELECT brand_id FROM brand_aliases WHERE alias_normalized = ?')
    .bind(normalized)
    .first<{ brand_id: number }>();
  if (alias) return alias.brand_id;

  const existing = await db
    .prepare('SELECT id FROM brands WHERE normalized_name = ?')
    .bind(normalized)
    .first<{ id: number }>();
  if (existing) return existing.id;

  const inserted = await db
    .prepare(
      'INSERT INTO brands (canonical_name, normalized_name) VALUES (?, ?) RETURNING id',
    )
    .bind(raw.trim(), normalized)
    .first<{ id: number }>();

  return inserted?.id ?? null;
}

export async function markExtractionFailed(db: D1Database, recallId: string): Promise<void> {
  // Park it at version 0 so it stops blocking the queue but stays findable:
  //   SELECT * FROM recalls WHERE extraction_version = 0;
  await db
    .prepare(
      `UPDATE recalls SET extraction_version = 0, extraction_confidence = 'low',
         extracted_at = datetime('now') WHERE id = ?`,
    )
    .bind(recallId)
    .run();
}

export async function startRun(db: D1Database, source: string): Promise<number> {
  const row = await db
    .prepare(`INSERT INTO ingest_runs (source, started_at) VALUES (?, datetime('now')) RETURNING id`)
    .bind(source)
    .first<{ id: number }>();
  return row!.id;
}

export async function finishRun(
  db: D1Database,
  runId: number,
  stats: { fetched: number; inserted: number; updated: number; extracted: number; errors: string[] },
): Promise<void> {
  await db
    .prepare(
      `UPDATE ingest_runs SET finished_at = datetime('now'),
         fetched = ?, inserted = ?, updated = ?, extracted = ?, errors = ?
       WHERE id = ?`,
    )
    .bind(
      stats.fetched, stats.inserted, stats.updated, stats.extracted,
      stats.errors.length ? JSON.stringify(stats.errors) : null, runId,
    )
    .run();
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
