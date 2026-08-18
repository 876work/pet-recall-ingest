import type { RawRecord } from '../types';
import { parseStates } from '../normalize';

const BASE = 'https://api.fda.gov/food/enforcement.json';
const PAGE_SIZE = 100; // openFDA hard-caps limit at 100

/**
 * openFDA food enforcement reports.
 *
 * Pet food lives in this endpoint, not in /animalandveterinary/ (that one is
 * adverse events, not recalls). There is no reliable "is this pet food" field,
 * so we pull everything in the window and let the extractor classify. Cheap,
 * and it means you can widen to human food later without touching ingest.
 *
 * Fields returned by this endpoint (stable, documented):
 *   recall_number, reason_for_recall, product_description, classification,
 *   status, distribution_pattern, recalling_firm, report_date,
 *   recall_initiation_date, code_info, product_type, city, state, country
 *
 * Dates come back as YYYYMMDD with no separators.
 */
export async function fetchOpenFda(
  apiKey: string,
  sinceDays = 120,
): Promise<RawRecord[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const until = new Date(Date.now() + 86_400_000);
  const range = `[${ymd(since)}+TO+${ymd(until)}]`;

  const out: RawRecord[] = [];
  let skip = 0;

  for (;;) {
    const url =
      `${BASE}?api_key=${encodeURIComponent(apiKey)}` +
      `&search=report_date:${range}` +
      `&limit=${PAGE_SIZE}&skip=${skip}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'pet-recall-ingest (contact: you@example.com)' },
    });

    // openFDA returns 404 with a NOT_FOUND error body when a query matches
    // nothing. That is a normal empty result, not a failure.
    if (res.status === 404) break;
    if (!res.ok) {
      throw new Error(`openFDA ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as { results?: FdaEnforcement[] };
    const results = body.results ?? [];
    if (results.length === 0) break;

    out.push(...results.map(toRawRecord));

    skip += results.length;
    if (results.length < PAGE_SIZE) break;
    if (skip >= 5000) break; // openFDA refuses skip beyond ~26k; stay well clear
  }

  return out;
}

interface FdaEnforcement {
  recall_number: string;
  reason_for_recall?: string;
  product_description?: string;
  classification?: string;
  status?: string;
  distribution_pattern?: string;
  recalling_firm?: string;
  report_date?: string;
  recall_initiation_date?: string;
  code_info?: string;
  product_type?: string;
  event_id?: string;
}

function toRawRecord(r: FdaEnforcement): RawRecord {
  // code_info carries lot codes and often UPCs. Feed it to the extractor.
  const description = [r.product_description, r.code_info]
    .filter(Boolean)
    .join('\n\nCODE INFO:\n');

  return {
    source: 'fda',
    sourceId: r.recall_number,
    title: truncate(r.product_description ?? r.recall_number, 200),
    description,
    reason: r.reason_for_recall ?? null,
    classification: r.classification ?? null,
    status: (r.status ?? '').toLowerCase() || null,
    recallDate: isoDate(r.recall_initiation_date ?? r.report_date),
    recallingFirm: r.recalling_firm ?? null,
    states: parseStates(r.distribution_pattern),
    url: r.event_id
      ? `https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts`
      : null,
    raw: r,
  };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** '20260814' -> '2026-08-14' */
function isoDate(v: string | undefined): string | null {
  if (!v || v.length !== 8) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
