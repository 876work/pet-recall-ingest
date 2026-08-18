import type { RawRecord } from '../types';

const FEED =
  'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml';

const USER_AGENT = 'pet-recall-ingest (contact: you@example.com)';

/** Per-page fetch timeout. A slow release must not stall the whole run. */
const BODY_TIMEOUT_MS = 12_000;

/** Pause between page fetches, so a batch does not burst at fda.gov. */
const BODY_STAGGER_MS = 250;

/**
 * Ceiling on page fetches per run. The feed window is 20 items so this is not
 * reached in normal operation; it is here so a feed change cannot turn one
 * ingest into an unbounded crawl.
 */
const MAX_BODY_FETCHES = 20;

/**
 * A body has to be substantial to be worth preferring over the blurb. FDA can
 * serve an interstitial or a stub, and replacing a good summary with page
 * furniture would be worse than not fetching at all.
 */
const MIN_BODY_CHARS = 400;

/**
 * FDA "Recalls, Market Withdrawals & Safety Alerts" press release feed.
 *
 * Company announcements published the day they are issued. This is the fast
 * path: openFDA enforcement reports for the same event, when they exist at all,
 * land weeks later after classification.
 *
 * ⚠️ THIS FEED IS A ROLLING WINDOW OF 20 ITEMS. There is no pagination, no
 * cursor and no date filter. If more than 20 notices post between two cron
 * runs, the overflow is gone for good. The 6-hour cron makes that unlikely but
 * not impossible during a large multi-firm event.
 *
 * ⚠️ IDENTITY DOES NOT CROSS SOURCES. sourceId is the press release URL slug,
 * which is stable, so re-running never duplicates a record from this feed. It
 * says nothing about the openFDA enforcement report for the same recall, which
 * carries a recall_number this feed never exposes and therefore lands as a
 * separate row. Reconciling the two needs a real identity mapping, not a
 * heuristic — see the note on fuzzy matching in normalize.ts.
 *
 * Item shape (verified against the live feed):
 *   title, link, description, pubDate, dc:creator, guid
 *
 * The feed's own `description` is a one-sentence summary capped around 300
 * characters — the FDA press release publishes its UPC table further down the
 * page, so extracting from the blurb alone lost every barcode before the
 * extractor ever saw one. Each item's release is therefore fetched and its
 * article body used as the description instead; the blurb stays as the
 * fallback. That costs one subrequest per item per run, which is the price of
 * this source being useful at all for pantry matching.
 *
 * The fetches are sequential with a pause between them. Twenty pages in
 * parallel is a burst fda.gov has no reason to absorb, and a 6-hourly cron has
 * no deadline that would justify one.
 *
 * A body is fetched ONCE. Re-fetching all twenty every run cost twenty
 * subrequests against a fifty-subrequest invocation ceiling and starved
 * extraction of the budget it needs — so when `db` is supplied, releases whose
 * body we already hold are skipped and their stored text reused verbatim.
 *
 * Reusing the stored text is not an optimisation, it is the whole correctness
 * requirement: `description` feeds the content hash in store.ts. Letting the
 * short RSS blurb through for a record whose stored description is the full
 * body would read as a change, overwrite the good text with the blurb, and
 * reset extraction — undoing the fetch on every single run.
 *
 * Skipping is safe because FDA publishes a revision as a NEW feed item with a
 * new slug ("updated-<original-slug>"), which lands as its own record and gets
 * its own fetch. A slug's body does not change under it.
 */
export async function fetchFdaPress(
  sinceDays = 120,
  db?: D1Database,
): Promise<RawRecord[]> {
  const res = await fetch(FEED, {
    headers: {
      Accept: 'application/rss+xml, application/xml;q=0.9',
      'User-Agent': USER_AGENT,
    },
  });

  if (!res.ok) {
    throw new Error(`FDA press ${res.status}: ${await res.text()}`);
  }

  const xml = await res.text();
  const cutoff = Date.now() - sinceDays * 86_400_000;

  const records = parseItems(xml)
    .map(toRawRecord)
    .filter((r): r is RawRecord => r !== null)
    // Keep anything we could not date rather than silently dropping it.
    .filter((r) => r.recallDate === null || Date.parse(r.recallDate) >= cutoff);

  return withNoticeBodies(records, db);
}

// ---------------------------------------------------------------------------
// Full notice text
// ---------------------------------------------------------------------------

/**
 * Replace each record's blurb with the text of its press release.
 *
 * Every failure mode here resolves to "keep the blurb". A release we cannot
 * read is still a recall worth storing, and losing the record would be a far
 * worse outcome than extracting less from it — so nothing in this path throws
 * and nothing is dropped.
 *
 * Note for anyone touching store.ts later: `description` is part of the content
 * hash, so a record whose body arrives for the first time reads as changed and
 * is re-queued for extraction on its own. A record whose fetch fails keeps the
 * identical blurb, hashes the same, and correctly costs nothing.
 */
async function withNoticeBodies(
  records: RawRecord[],
  db?: D1Database,
): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  let fetches = 0;

  // One D1 read in place of up to twenty page fetches.
  const stored = db ? await storedBodies(db, records) : new Map<string, string>();

  for (const rec of records) {
    // Already held. Reuse the exact stored text so the content hash matches and
    // store.ts sees 'unchanged' — no rewrite, no re-extraction, no LLM spend.
    const held = stored.get(rowId(rec));
    if (held) {
      out.push(withBodyFlag({ ...rec, description: held }, true));
      continue;
    }

    if (!rec.url || fetches >= MAX_BODY_FETCHES) {
      out.push(withBodyFlag(rec, false));
      continue;
    }

    // Sequential, with a pause before every fetch after the first. This is the
    // whole staggering strategy: one page in flight at a time.
    if (fetches > 0) await sleep(BODY_STAGGER_MS);
    fetches++;

    const body = await fetchNoticeBody(rec.url);
    out.push(
      body === null
        ? withBodyFlag(rec, false)
        : withBodyFlag({ ...rec, description: body }, true),
    );
  }

  return out;
}

/**
 * Mirrors the id store.ts builds (`${source}:${sourceId}`). Duplicated rather
 * than imported because store.ts does not export it and must not be changed
 * for this — same arrangement as the EVENT_KEY copy in notify.ts. If that
 * expression ever changes, this has to change with it.
 */
function rowId(rec: RawRecord): string {
  return `${rec.source}:${rec.sourceId}`;
}

/**
 * The already-fetched body text for whichever of these releases we hold one.
 *
 * Keyed on the body_fetched flag rather than on description length: length is a
 * guess, the flag is a statement this adapter wrote itself. Records predating
 * the flag come back absent and are simply fetched once more, after which they
 * carry it.
 *
 * A failure here degrades to fetching, which is the previous behaviour and
 * still correct — never to dropping a record.
 */
async function storedBodies(
  db: D1Database,
  records: RawRecord[],
): Promise<Map<string, string>> {
  const ids = records.map(rowId);
  if (ids.length === 0) return new Map();

  try {
    const { results } = await db
      .prepare(
        `SELECT id, raw_description
           FROM recalls
          WHERE id IN (${ids.map(() => '?').join(',')})
            AND json_extract(raw_json, '$.body_fetched') = 1
            AND raw_description IS NOT NULL
            AND LENGTH(raw_description) >= ?`,
      )
      .bind(...ids, MIN_BODY_CHARS)
      .all<{ id: string; raw_description: string }>();

    return new Map(results.map((r) => [r.id, r.raw_description]));
  } catch {
    return new Map();
  }
}

/**
 * Recorded in raw_json so an operator can tell a full notice from a fallback
 * without diffing lengths. Not part of the content hash, so setting it can
 * never by itself trigger a re-extraction.
 */
function withBodyFlag(rec: RawRecord, fetched: boolean): RawRecord {
  return { ...rec, raw: { ...(rec.raw as Record<string, unknown>), body_fetched: fetched } };
}

async function fetchNoticeBody(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BODY_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) return null;

    return noticeText(await res.text());
  } catch {
    // Timeout, abort, DNS, a redirect loop — indistinguishable to the caller,
    // which keeps the blurb in every one of those cases.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The article body of a press release page.
 *
 * Deliberately returns null rather than falling back to the whole document when
 * the container is missing. The page is ~40KB of navigation, banners and
 * footer around ~4KB of notice; handing all of that to the extractor would bury
 * the product table it is being asked to read. If FDA ever restructures the
 * page, keeping the blurb is the safe failure — and the body_fetched flag makes
 * it visible rather than silent.
 */
function noticeText(page: string): string | null {
  const article = /<article\b[^>]*id="main-content"[^>]*>([\s\S]*?)<\/article>/i.exec(page);
  if (!article) return null;

  const text = pageToText(article[1]);
  return text.length >= MIN_BODY_CHARS ? text : null;
}

/**
 * Page-grade HTML to text.
 *
 * Separate from stripHtml above, which handles small RSS fields and is left
 * alone. Two differences matter for a full page: script and style bodies have
 * to go before tags are dropped, or their contents land in the text; and table
 * cells need a visible separator, because these notices carry the product and
 * UPC grid as a table and collapsing a row would run the barcodes together.
 */
function pageToText(fragment: string): string {
  const stripped = fragment
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');

  // Entities are decoded after tags are gone, not before: an encoded "&lt;p&gt;"
  // in the copy must end up as literal text, never as a tag to strip.
  return decodeEntities(decodeNumericEntities(stripped))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** FDA copy uses curly quotes and dashes, which arrive as numeric entities. */
function decodeNumericEntities(s: string): string {
  return s
    .replace(/&#(\d{1,7});/g, (whole, d: string) => codePoint(Number(d), whole))
    .replace(/&#x([0-9a-f]{1,6});/gi, (whole, h: string) => codePoint(parseInt(h, 16), whole));
}

/** Out-of-range values are left as written rather than throwing the run away. */
function codePoint(n: number, fallback: string): string {
  if (!Number.isInteger(n) || n < 1 || n > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(n);
  } catch {
    return fallback;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PressItem {
  title: string | null;
  link: string | null;
  description: string | null;
  pubDate: string | null;
  guid: string | null;
}

function toRawRecord(item: PressItem): RawRecord | null {
  const sourceId = slugFrom(item);
  if (!sourceId) return null;

  const description = item.description ?? item.title ?? '';
  if (!description) return null;

  return {
    source: 'fda_press',
    sourceId,
    title: item.title,
    description,
    reason: reasonFromTitle(item.title),
    // Press releases predate classification by design; that is the whole point
    // of this feed. Leave it null rather than inventing a class.
    classification: null,
    // A notice on this feed is an active recall at time of publication. It will
    // not be revised here: items age out of the window and never come back, so
    // this value does not track a later termination.
    status: 'ongoing',
    recallDate: isoDate(item.pubDate),
    recallingFirm: firmFromTitle(item.title),
    // No distribution field exists on this feed. parseStates() over prose would
    // be actively harmful — it uppercases its input, so "in" reads as IN and
    // "or" as OR. Better to record nothing than fabricate a distribution list.
    states: [],
    url: item.link,
    raw: item,
  };
}

// ---------------------------------------------------------------------------
// RSS parsing. Workers have no DOMParser, and the feed is a flat, well-formed
// document, so regex extraction is sufficient here — same approach fsis.ts
// takes with its HTML fields.
// ---------------------------------------------------------------------------

function parseItems(xml: string): PressItem[] {
  const items: PressItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    items.push({
      title: tagText(block, 'title'),
      link: tagText(block, 'link'),
      description: tagText(block, 'description'),
      pubDate: tagText(block, 'pubDate'),
      guid: tagText(block, 'guid'),
    });
  }

  return items;
}

function tagText(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  if (!m) return null;

  const text = stripHtml(decodeEntities(unwrapCdata(m[1])));
  return text.length > 0 ? text : null;
}

function unwrapCdata(s: string): string {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? m[1] : s;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#039;|&apos;|&#39;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // Ampersand last, so "&amp;lt;" does not decode twice into a tag.
    .replace(/&amp;/g, '&');
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Stable per-release identifier: the trailing URL slug, which FDA does not
 * revise once published. guid is marked isPermaLink and equals link, but prefer
 * guid so a future change to link formatting does not re-key existing rows.
 */
function slugFrom(item: PressItem): string | null {
  const raw = item.guid ?? item.link;
  if (!raw) return null;

  const path = raw.split(/[?#]/)[0].replace(/\/+$/, '');
  const slug = path.slice(path.lastIndexOf('/') + 1);
  return slug.length > 0 ? slug : null;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * RFC-822 pubDate -> ISO date, e.g. 'Wed, 12 Aug 2026 17:55:00 EDT'.
 *
 * Read the literal components rather than going through Date. An evening
 * EDT timestamp converts to the following day in UTC, which would file the
 * recall under the wrong date.
 */
function isoDate(v: string | null): string | null {
  if (!v) return null;

  const m = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/.exec(v);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month) return `${m[3]}-${month}-${m[1].padStart(2, '0')}`;
  }

  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Titles follow '<Firm> Voluntarily Recalls <product> Because of <hazard>'.
 * Both helpers below copy a literal substring of the title and return null
 * when the shape does not match. Neither infers a value that is not written —
 * the extractor still sees the full title and description regardless.
 */
function firmFromTitle(title: string | null): string | null {
  if (!title) return null;
  const m =
    /^(.{3,45}?)\s+(?:Voluntarily|Issues|Initiates|Announces|Expands|Recalls|Recall)\b/.exec(
      title,
    );
  return m ? m[1].trim() : null;
}

function reasonFromTitle(title: string | null): string | null {
  if (!title) return null;
  const m = /\b(?:because of|due to|over)\s+(.{4,120})$/i.exec(title);
  return m ? m[1].trim() : null;
}
