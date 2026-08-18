import type { Env } from './types';

/**
 * Drains notify_queue and delivers Expo push notifications.
 *
 * Four things about this queue drive the whole design, and each of them is a
 * way to get it badly wrong:
 *
 * 1. ROWS ARRIVE BEFORE EXTRACTION. store.ts queues a recall during upsert,
 *    when it has no products and no UPCs yet. Draining such a row would match
 *    nobody, mark it sent, and silently destroy that recall's only chance to
 *    reach the people it affects. Unextracted rows are therefore SKIPPED and
 *    left pending, not processed.
 *
 * 2. ONE RECALL IS MANY ROWS. openFDA splits a single recall across one
 *    enforcement report per product or lot — sixteen rows for one event is
 *    normal — and each gets its own queue row. Sent per row, that is sixteen
 *    push notifications for one recall. Everything below groups on the same
 *    event key the read API uses before it sends anything.
 *
 * 3. THE QUEUE HOLDS A HISTORICAL BACKFILL. At the time of writing there are
 *    799 pending rows covering months of already-published recalls. Pushing
 *    those would be an alarm about food nobody still has. Anything older than
 *    NOTIFY_MAX_AGE_DAYS is drained without sending — the row is processed, but
 *    no notification goes out.
 *
 * 4. A SILENT FAILURE IS WORSE THAN A DUPLICATE. If a send fails, the event's
 *    rows stay pending and the next cron retries, which can re-notify a device
 *    that already got it. Delivery is deliberately at-least-once: a repeated
 *    recall alert is an annoyance, a dropped one is the product failing.
 */

/** Events processed per run. Bounds D1 calls inside one cron invocation. */
const NOTIFY_BATCH = 40;

/**
 * Recalls older than this drain without notifying. Long enough to cover a slow
 * ingest or a missed cron, short enough that nobody is alerted about a recall
 * they have already lived through.
 */
const NOTIFY_MAX_AGE_DAYS = 21;

/** Expo accepts at most 100 messages per request. */
const EXPO_CHUNK = 100;
const EXPO_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/** D1 caps bound parameters per statement; the read API uses the same ceiling. */
const MAX_BOUND_PARAMS = 80;

/**
 * Mirrors the EVENT_KEY expression in read.ts. Duplicated rather than imported
 * because read.ts does not export it and this stage must not modify it — if
 * that expression ever changes, this one has to change with it.
 */
const EVENT_KEY = `CASE
  WHEN r.source = 'fda' AND json_extract(r.raw_json, '$.event_id') IS NOT NULL
  THEN 'fda_event:' || json_extract(r.raw_json, '$.event_id')
  ELSE r.id
END`;

interface PendingRow {
  recall_id: string;
  event_key: string;
  title: string | null;
  classification: string | null;
  category: string | null;
  recall_date: string | null;
  recalling_firm: string | null;
  url: string | null;
}

interface EventGroup {
  eventKey: string;
  recallIds: string[];
  title: string | null;
  classification: string | null;
  recallingFirm: string | null;
  recallDate: string | null;
  url: string | null;
}

export interface NotifySummary {
  ok: boolean;
  events: number;
  /** Queue rows left pending because their recall is not extracted yet. */
  awaiting_extraction: number;
  /** Events drained without sending because the recall is too old. */
  stale: number;
  notifications: number;
  recipients: number;
  tokens_removed: number;
  marked_sent: number;
  errors: string[];
}

export async function drainNotifyQueue(
  env: Env,
  limit = NOTIFY_BATCH,
): Promise<NotifySummary> {
  const errors: string[] = [];
  const summary: NotifySummary = {
    ok: true,
    events: 0,
    awaiting_extraction: 0,
    stale: 0,
    notifications: 0,
    recipients: 0,
    tokens_removed: 0,
    marked_sent: 0,
    errors,
  };

  try {
    // Rows whose recall has not been extracted are counted, then excluded —
    // see note 1. They stay pending for a later run.
    const awaiting = await env.DB.prepare(
      `SELECT COUNT(*) AS n
         FROM notify_queue q
         JOIN recalls r ON r.id = q.recall_id
        WHERE q.sent_at IS NULL AND r.extraction_version IS NULL`,
    ).first<{ n: number }>();
    summary.awaiting_extraction = awaiting?.n ?? 0;

    const { results: pending } = await env.DB.prepare(
      `SELECT q.recall_id, ${EVENT_KEY} AS event_key, r.title, r.classification,
              r.category, r.recall_date, r.recalling_firm, r.url
         FROM notify_queue q
         JOIN recalls r ON r.id = q.recall_id
        WHERE q.sent_at IS NULL
          AND r.extraction_version IS NOT NULL
        ORDER BY r.recall_date DESC
        LIMIT ?`,
    )
      .bind(limit * 8) // one event can span many rows; group before bounding
      .all<PendingRow>();

    if (pending.length === 0) return summary;

    const groups = groupEvents(pending).slice(0, limit);
    summary.events = groups.length;

    const cutoff = Date.now() - NOTIFY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const deadTokens = new Set<string>();
    const processed: string[] = [];

    for (const group of groups) {
      // Note 3 — drain, do not deliver.
      if (isStale(group.recallDate, cutoff)) {
        summary.stale++;
        processed.push(...group.recallIds);
        continue;
      }

      try {
        const recipients = await findRecipients(env.DB, group.recallIds);
        if (recipients.size === 0) {
          processed.push(...group.recallIds);
          continue;
        }

        const messages = [...recipients.entries()].map(([token, match]) =>
          buildMessage(token, group, match),
        );

        const outcome = await sendExpo(env, messages);
        errors.push(...outcome.errors);
        for (const token of outcome.deadTokens) deadTokens.add(token);

        summary.notifications += outcome.accepted;
        summary.recipients += messages.length;

        // Note 4 — only a fully attempted event is retired. A transport
        // failure leaves the rows pending so the next cron tries again.
        if (outcome.delivered) processed.push(...group.recallIds);
      } catch (err) {
        errors.push(`event ${group.eventKey}: ${msg(err)}`);
      }
    }

    if (deadTokens.size) {
      summary.tokens_removed = await removeTokens(env.DB, [...deadTokens], errors);
    }

    if (processed.length) {
      summary.marked_sent = await markSent(env.DB, processed, errors);
    }
  } catch (err) {
    errors.push(`notify aborted: ${msg(err)}`);
  }

  summary.ok = errors.length === 0;
  return summary;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/** Fold queue rows into one entry per recall event — see note 2. */
function groupEvents(rows: PendingRow[]): EventGroup[] {
  const byKey = new Map<string, EventGroup>();

  for (const row of rows) {
    const existing = byKey.get(row.event_key);
    if (!existing) {
      byKey.set(row.event_key, {
        eventKey: row.event_key,
        recallIds: [row.recall_id],
        title: row.title,
        classification: row.classification,
        recallingFirm: row.recalling_firm,
        recallDate: row.recall_date,
        url: row.url,
      });
      continue;
    }

    existing.recallIds.push(row.recall_id);
    // An event is as serious as its worst report, and as recent as its latest.
    if (rankClass(row.classification) < rankClass(existing.classification)) {
      existing.classification = row.classification;
    }
    if (row.recall_date && (!existing.recallDate || row.recall_date > existing.recallDate)) {
      existing.recallDate = row.recall_date;
    }
    if (!existing.title && row.title) existing.title = row.title;
    if (!existing.url && row.url) existing.url = row.url;
    if (!existing.recallingFirm && row.recalling_firm) {
      existing.recallingFirm = row.recalling_firm;
    }
  }

  return [...byKey.values()];
}

function rankClass(classification: string | null): number {
  const s = (classification ?? '').toLowerCase();
  if (s.includes('class i') && !s.includes('class ii')) return 1;
  if (s.includes('class iii')) return 3;
  if (s.includes('class ii')) return 2;
  return 9;
}

function isStale(recallDate: string | null, cutoff: number): boolean {
  if (!recallDate) return false; // undated: treat as current rather than drop it
  const at = Date.parse(recallDate);
  return Number.isFinite(at) && at < cutoff;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

type MatchReason = 'pantry' | 'brand';

/**
 * Why a device is being notified, and — for a pantry match — which of its saved
 * barcodes matched. The app needs that barcode to deep link straight to the
 * result for the item the owner actually has; without it a tap can only land
 * on the feed and leave them to find it.
 */
interface Match {
  reason: MatchReason;
  upc?: string;
}

/**
 * Devices to notify about one event, and why.
 *
 * A device can match on both a saved barcode and a followed brand. It gets one
 * notification, and `pantry` wins the wording — "something you own" is a
 * sharper statement than "a brand you follow", and it is the one that should
 * survive the collapse.
 */
async function findRecipients(
  db: D1Database,
  recallIds: string[],
): Promise<Map<string, Match>> {
  const recipients = new Map<string, Match>();

  const [brandIds, upcs] = await Promise.all([
    selectIn<{ brand_id: number }>(
      db,
      (ph) =>
        `SELECT DISTINCT brand_id FROM recall_products
          WHERE recall_id IN (${ph}) AND brand_id IS NOT NULL`,
      recallIds,
    ),
    selectIn<{ upc: string }>(
      db,
      (ph) => `SELECT DISTINCT upc FROM recall_upcs WHERE recall_id IN (${ph})`,
      recallIds,
    ),
  ]);

  // Brand first, so a pantry match can overwrite it below.
  if (brandIds.length) {
    const rows = await selectIn<{ token: string }>(
      db,
      (ph) =>
        `SELECT DISTINCT d.token
           FROM devices d, json_each(d.followed_brand_ids) j
          WHERE CAST(j.value AS INTEGER) IN (${ph})`,
      brandIds.map((b) => b.brand_id),
    );
    for (const row of rows) recipients.set(row.token, { reason: 'brand' });
  }

  if (upcs.length) {
    // Carry the matched value back, not just the token, so the notification can
    // name the barcode this device actually has.
    const rows = await selectIn<{ token: string; upc: string }>(
      db,
      (ph) =>
        `SELECT DISTINCT d.token, j.value AS upc
           FROM devices d, json_each(d.pantry_upcs) j
          WHERE j.value IN (${ph})`,
      upcs.map((u) => u.upc),
    );
    for (const row of rows) recipients.set(row.token, { reason: 'pantry', upc: row.upc });
  }

  return recipients;
}

// ---------------------------------------------------------------------------
// Expo delivery
// ---------------------------------------------------------------------------

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  priority: 'high';
  data: Record<string, unknown>;
}

function buildMessage(token: string, group: EventGroup, match: Match): ExpoMessage {
  const { reason } = match;
  const cls = group.classification ? `${group.classification} · ` : '';
  const what = group.title?.trim() || group.recallingFirm?.trim() || 'A product was recalled';

  return {
    to: token,
    title: reason === 'pantry' ? 'Recall in your pantry' : 'A brand you follow issued a recall',
    body: `${cls}${truncate(what, 140)}`,
    sound: 'default',
    priority: 'high',
    data: {
      eventKey: group.eventKey,
      recallIds: group.recallIds,
      url: group.url,
      reason,
      // Present only for a pantry match; the app deep links on it.
      matchedUpc: match.upc ?? null,
    },
  };
}

interface ExpoTicket {
  status?: string;
  message?: string;
  details?: { error?: string };
}

interface SendOutcome {
  /** Every chunk got a response — the event may be retired. */
  delivered: boolean;
  accepted: number;
  deadTokens: string[];
  errors: string[];
}

async function sendExpo(env: Env, messages: ExpoMessage[]): Promise<SendOutcome> {
  const outcome: SendOutcome = { delivered: true, accepted: 0, deadTokens: [], errors: [] };

  for (let i = 0; i < messages.length; i += EXPO_CHUNK) {
    const chunk = messages.slice(i, i + EXPO_CHUNK);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    // Optional. Expo only requires it when the project enables push security.
    if (env.EXPO_ACCESS_TOKEN) {
      headers.Authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
    }

    let response: Response;
    try {
      response = await fetch(EXPO_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(chunk),
      });
    } catch (err) {
      outcome.delivered = false;
      outcome.errors.push(`expo send: ${msg(err)}`);
      continue;
    }

    if (!response.ok) {
      outcome.delivered = false;
      outcome.errors.push(`expo send: HTTP ${response.status}`);
      continue;
    }

    let payload: { data?: ExpoTicket[]; errors?: unknown };
    try {
      payload = (await response.json()) as { data?: ExpoTicket[] };
    } catch (err) {
      outcome.delivered = false;
      outcome.errors.push(`expo response: ${msg(err)}`);
      continue;
    }

    const tickets = payload.data ?? [];
    // Tickets come back positionally, so a missing one cannot be attributed to
    // a token and is only counted as an error.
    tickets.forEach((ticket, index) => {
      if (ticket.status === 'ok') {
        outcome.accepted++;
        return;
      }

      const token = chunk[index]?.to;
      const code = ticket.details?.error;

      // The token is gone for good: the app was uninstalled, or Expo rotated
      // it. Keeping it would retry a guaranteed failure on every future recall.
      if (token && (code === 'DeviceNotRegistered' || code === 'InvalidCredentials')) {
        outcome.deadTokens.push(token);
        return;
      }

      outcome.errors.push(`expo ticket${token ? ` ${token}` : ''}: ${ticket.message ?? code ?? 'unknown'}`);
    });
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function markSent(
  db: D1Database,
  recallIds: string[],
  errors: string[],
): Promise<number> {
  let marked = 0;

  for (let i = 0; i < recallIds.length; i += MAX_BOUND_PARAMS) {
    const chunk = recallIds.slice(i, i + MAX_BOUND_PARAMS);
    try {
      const result = await db
        .prepare(
          `UPDATE notify_queue SET sent_at = datetime('now')
            WHERE sent_at IS NULL AND recall_id IN (${placeholders(chunk.length)})`,
        )
        .bind(...chunk)
        .run();
      marked += result.meta.changes ?? 0;
    } catch (err) {
      errors.push(`mark sent: ${msg(err)}`);
    }
  }

  return marked;
}

async function removeTokens(
  db: D1Database,
  tokens: string[],
  errors: string[],
): Promise<number> {
  let removed = 0;

  for (let i = 0; i < tokens.length; i += MAX_BOUND_PARAMS) {
    const chunk = tokens.slice(i, i + MAX_BOUND_PARAMS);
    try {
      const result = await db
        .prepare(`DELETE FROM devices WHERE token IN (${placeholders(chunk.length)})`)
        .bind(...chunk)
        .run();
      removed += result.meta.changes ?? 0;
    } catch (err) {
      errors.push(`remove tokens: ${msg(err)}`);
    }
  }

  return removed;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
