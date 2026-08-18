import type { Env, RawRecord } from './types';
import { fetchOpenFda } from './sources/openfda';
import { fetchFdaPress } from './sources/fda_press';
import { extract } from './extract';
import { handleRead } from './read';
import { handleDevices } from './devices';
import { drainNotifyQueue, type NotifySummary } from './notify';
import {
  finishRun, markExtractionFailed, pendingExtraction, saveExtraction,
  startRun, upsertRecalls,
} from './store';

/** Extraction budget per run. Keeps a cron invocation inside CPU limits. */
const EXTRACT_BATCH = 25;

/**
 * Upsert budget per run. Batching already makes the writes cheap; this bounds
 * a cold-start backfill so one invocation cannot approach the per-invocation
 * binding-call limit. New and changed records are always taken first, so the
 * remainder is only deferred volatile refreshes and cron drains it next run.
 */
const UPSERT_BATCH = 500;

/**
 * Drain passes per /admin/notify call.
 *
 * The notifier deliberately bounds itself to 40 events so a cron invocation
 * stays inside its limits, which leaves a backlog needing many runs. This route
 * loops the same drain instead, and the ceiling is what keeps one HTTP request
 * from running past the invocation's own budget. Each pass costs a couple of D1
 * calls plus, per event that actually has recipients, a few more and one Expo
 * request — so the real cost depends on how much of the backlog is deliverable,
 * not on the pass count. The response reports `remaining` and `done` so an
 * operator can simply call it again rather than have this number guessed larger.
 */
const NOTIFY_MAX_PASSES = 25;

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return json({ ok: true });
    }

    // Public read API for the app. Returns null for anything it does not own,
    // so the admin routing below is unchanged.
    const read = await handleRead(req, url, env, ctx);
    if (read) return read;

    // Device registration. Public like the read API — the app has no account to
    // authenticate with — but it writes, so devices.ts validates everything it
    // accepts. Sits above the admin gate because the app has no admin token.
    const devices = await handleDevices(req, url, env);
    if (devices) return devices;

    // Everything below is admin-only.
    if (req.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
      return json({ error: 'unauthorized' }, 401);
    }

    // /admin/extract and /admin/stats have no internal recovery of their own,
    // so without this a D1 or binding-limit failure returns an opaque 1101.
    try {
      if (url.pathname === '/admin/ingest') {
        const days = clamp(url.searchParams.get('days'), 120, 1, 3650);
        return json(await runIngest(env, days));
      }

      if (url.pathname === '/admin/extract') {
        // Never exceed the per-invocation budget, whatever the caller asks for.
        const limit = clamp(url.searchParams.get('limit'), EXTRACT_BATCH, 1, EXTRACT_BATCH);
        return json(await runExtraction(env, limit));
      }

      if (url.pathname === '/admin/stats') {
        return json(await stats(env.DB));
      }

      if (url.pathname === '/admin/notify') {
        const passes = clamp(url.searchParams.get('passes'), NOTIFY_MAX_PASSES, 1, NOTIFY_MAX_PASSES);
        return json(await runNotifyBacklog(env, passes));
      }
    } catch (err) {
      return json({ ok: false, error: msg(err) }, 500);
    }

    return json({ error: 'not found' }, 404);
  },
};

/**
 * The cron body: ingest, then deliver.
 *
 * Notification runs AFTER ingest and extraction, and strictly after them — the
 * notifier skips any queued recall that is not extracted yet, so draining first
 * would leave this run's new recalls sitting until the next cron six hours
 * later. `runIngest` handles its own failures and returns a summary rather than
 * throwing, so delivery still happens on a partial ingest.
 */
async function runScheduled(env: Env) {
  const ingest = await runIngest(env);
  const notify = await drainNotifyQueue(env);
  return { ingest, notify };
}

async function runIngest(env: Env, days = 120) {
  const errors: string[] = [];
  let runId: number | null = null;
  let fetched = 0, inserted = 0, updated = 0, unchanged = 0, skipped = 0, extracted = 0;

  // A binding-limit or D1 failure anywhere below must not surface as a bare
  // 1101. Report what did land and let the next run continue from there.
  try {
    runId = await startRun(env.DB, 'all');

    // FSIS was removed: the endpoint 403s Akamai against Worker egress and the
    // adapter never returned a single record. Restoring it needs a way through
    // that block first, not a new field map.
    const sources: Array<[string, () => Promise<RawRecord[]>]> = [
      ['fda', () => fetchOpenFda(env.OPENFDA_API_KEY, days)],
      // env.DB lets the adapter skip re-fetching a release body it already
      // holds; without it every run spends 20 subrequests re-reading the same
      // pages and starves extraction. See the note in fda_press.ts.
      ['fda_press', () => fetchFdaPress(days, env.DB)],
    ];

    // Sources are independent: one being down must not block the other.
    const records: RawRecord[] = [];
    for (const [name, fn] of sources) {
      try {
        const rows = await fn();
        fetched += rows.length;
        records.push(...rows);
      } catch (err) {
        errors.push(`${name} fetch: ${msg(err)}`);
      }
    }

    const up = await upsertRecalls(env.DB, records, UPSERT_BATCH);
    inserted = up.inserted;
    updated = up.updated;
    unchanged = up.unchanged;
    skipped = up.skipped;
    errors.push(...up.errors);

    const ex = await runExtraction(env, EXTRACT_BATCH);
    extracted = ex.extracted;
    errors.push(...ex.errors);
  } catch (err) {
    errors.push(`run aborted: ${msg(err)}`);
  }

  const summary = { fetched, inserted, updated, unchanged, skipped, extracted, errors };

  // Closing the audit row is best-effort: if this is what failed, the summary
  // still goes back to the caller rather than vanishing into an exception.
  if (runId !== null) {
    try {
      await finishRun(env.DB, runId, summary);
    } catch (err) {
      errors.push(`finish run ${runId}: ${msg(err)}`);
    }
  }

  return { ok: errors.length === 0, ...summary };
}

async function runExtraction(env: Env, limit: number) {
  const pending = await pendingExtraction(env.DB, limit);
  const errors: string[] = [];
  let extracted = 0;

  for (const row of pending) {
    try {
      const result = await extract(env.ANTHROPIC_API_KEY, {
        source: row.source as any,
        sourceId: row.id,
        title: row.title,
        description: row.raw_description,
        reason: row.reason,
        classification: null,
        status: null,
        recallDate: null,
        recallingFirm: row.recalling_firm,
        states: [],
        url: null,
        raw: null,
      });

      await saveExtraction(env.DB, row.id, result);
      extracted++;
    } catch (err) {
      errors.push(`extract ${row.id}: ${msg(err)}`);
      try {
        await markExtractionFailed(env.DB, row.id);
      } catch (markErr) {
        // Parking the row failed too, so stop: this is what a binding-limit
        // exhaustion looks like, and the rest of the batch will only repeat it.
        errors.push(`mark failed ${row.id}: ${msg(markErr)}`);
        break;
      }
    }
  }

  return { extracted, pending: pending.length, errors };
}

/**
 * Drain the notify backlog in one request.
 *
 * This calls the notifier repeatedly rather than reimplementing it: every rule
 * that makes delivery safe — skipping unextracted rows, grouping an event's many
 * reports into one push, retiring stale recalls without notifying, leaving a
 * failed send pending — lives in drainNotifyQueue and stays there.
 *
 * Stopping correctly is the whole difficulty. The queue being non-empty is NOT
 * a reason to keep going: rows awaiting extraction are skipped by design, and a
 * failing send deliberately leaves its rows pending for the next attempt. Either
 * would make a naive "loop until empty" spin on the same rows forever, and in
 * the failing-send case it would hammer Expo with the retry each time. Progress
 * is therefore measured by rows actually retired, and a pass that retires none
 * ends the run.
 */
async function runNotifyBacklog(env: Env, maxPasses: number) {
  const totals = {
    events: 0,
    stale: 0,
    notifications: 0,
    recipients: 0,
    tokens_removed: 0,
    marked_sent: 0,
  };
  const errors: string[] = [];
  const passSummaries: NotifySummary[] = [];

  let passes = 0;
  let stopped = 'drained';

  for (let i = 0; i < maxPasses; i++) {
    const pass = await drainNotifyQueue(env);
    passes++;
    passSummaries.push(pass);

    totals.events += pass.events;
    totals.stale += pass.stale;
    totals.notifications += pass.notifications;
    totals.recipients += pass.recipients;
    totals.tokens_removed += pass.tokens_removed;
    totals.marked_sent += pass.marked_sent;
    errors.push(...pass.errors);

    // Nothing eligible left to look at.
    if (pass.events === 0) break;

    // Events were found but none could be retired — see the note above. Running
    // again would repeat the identical work on the identical rows.
    if (pass.marked_sent === 0) {
      stopped = 'no_progress';
      break;
    }

    if (i === maxPasses - 1) stopped = 'pass_limit';
  }

  const remaining = await pendingNotifyCount(env.DB, errors);

  return {
    ok: errors.length === 0,
    passes,
    stopped,
    ...totals,
    ...remaining,
    // `remaining` can be non-zero on a clean run: rows awaiting extraction are
    // held back on purpose and are not a backlog this route can clear.
    done: stopped === 'drained',
    // One line per pass, so a partial drain shows where it stalled.
    pass_summaries: passSummaries.map((p) => ({
      events: p.events,
      stale: p.stale,
      notifications: p.notifications,
      marked_sent: p.marked_sent,
      errors: p.errors.length,
    })),
    errors: errors.slice(0, 20),
    error_count: errors.length,
  };
}

/** Read-only. Lets the caller see whether another /admin/notify call is worth it. */
async function pendingNotifyCount(db: D1Database, errors: string[]) {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS pending,
                SUM(CASE WHEN r.extraction_version IS NULL THEN 1 ELSE 0 END) AS awaiting_extraction
           FROM notify_queue q
           JOIN recalls r ON r.id = q.recall_id
          WHERE q.sent_at IS NULL`,
      )
      .first<{ pending: number; awaiting_extraction: number | null }>();

    return {
      remaining: row?.pending ?? 0,
      remaining_awaiting_extraction: row?.awaiting_extraction ?? 0,
    };
  } catch (err) {
    errors.push(`pending count: ${msg(err)}`);
    return { remaining: -1, remaining_awaiting_extraction: -1 };
  }
}

async function stats(db: D1Database) {
  const [totals, byCategory, byConfidence, lastRun] = await Promise.all([
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM recalls)          AS recalls,
         (SELECT COUNT(*) FROM recall_products)  AS products,
         (SELECT COUNT(*) FROM recall_upcs)      AS upcs,
         (SELECT COUNT(*) FROM brands)           AS brands,
         (SELECT COUNT(*) FROM recalls WHERE extraction_version IS NULL) AS pending,
         (SELECT COUNT(*) FROM recalls WHERE extraction_version = 0)     AS failed`,
    ).first(),
    db.prepare('SELECT category, COUNT(*) AS n FROM recalls GROUP BY category').all(),
    db.prepare(
      'SELECT extraction_confidence AS confidence, COUNT(*) AS n FROM recalls GROUP BY 1',
    ).all(),
    db.prepare('SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1').first(),
  ]);

  return {
    totals,
    byCategory: byCategory.results,
    byConfidence: byConfidence.results,
    lastRun,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Query params are attacker-controlled; a NaN here would defeat the budget. */
function clamp(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw === null || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}
