import type { Env } from './types';
import { normalizeUpc } from './normalize';

/**
 * Device registration for push delivery.
 *
 * Public and unauthenticated, like the read API — but unlike the read API this
 * WRITES, so everything it accepts is treated as hostile: the token must look
 * like an Expo token, ids must be integers, barcodes go through the same
 * normaliser the matcher uses, and both lists are capped.
 *
 * The endpoint is a full upsert, not a patch. The app already holds the whole
 * followed-brand set and the whole pantry locally, so sending both in full on
 * every change makes the server's copy a mirror rather than a log that can
 * drift out of step with the phone.
 */

/** Bounds on one device's subscriptions. Past these, a payload is abuse. */
const MAX_BRANDS = 300;
const MAX_UPCS = 1000;

/**
 * Expo issues tokens in two shapes. Anything else cannot be delivered, so it is
 * rejected at the door rather than stored and retried forever by the notifier.
 */
const TOKEN_PATTERN = /^Ex(?:ponent|po)PushToken\[[A-Za-z0-9._%+-]+\]$/;

interface RegisterBody {
  token?: unknown;
  platform?: unknown;
  followedBrandIds?: unknown;
  pantryUpcs?: unknown;
}

export async function handleDevices(
  req: Request,
  url: URL,
  env: Env,
): Promise<Response | null> {
  if (url.pathname !== '/devices/register' && url.pathname !== '/devices/unregister') {
    return null;
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  let body: RegisterBody;
  try {
    body = (await req.json()) as RegisterBody;
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!TOKEN_PATTERN.test(token)) {
    return json({ error: 'token must be an Expo push token' }, 400);
  }

  if (url.pathname === '/devices/unregister') {
    await env.DB.prepare('DELETE FROM devices WHERE token = ?').bind(token).run();
    return json({ ok: true, unregistered: true });
  }

  const platform =
    body.platform === 'ios' || body.platform === 'android' ? body.platform : null;

  const brandIds = toIntArray(body.followedBrandIds).slice(0, MAX_BRANDS);

  // Normalised on the way in, so the matcher compares like with like. A barcode
  // that will not normalise is dropped rather than stored: it could never match
  // recall_upcs, and keeping it would only make the pantry count lie.
  const upcs: string[] = [];
  for (const raw of toStringArray(body.pantryUpcs)) {
    const normalized = normalizeUpc(raw);
    if (normalized && !upcs.includes(normalized)) upcs.push(normalized);
    if (upcs.length >= MAX_UPCS) break;
  }

  await env.DB.prepare(
    `INSERT INTO devices (token, platform, followed_brand_ids, pantry_upcs)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET
       platform           = excluded.platform,
       followed_brand_ids = excluded.followed_brand_ids,
       pantry_upcs        = excluded.pantry_upcs,
       updated_at         = datetime('now')`,
  )
    .bind(token, platform, JSON.stringify(brandIds), JSON.stringify(upcs))
    .run();

  return json({
    ok: true,
    platform,
    followed_brands: brandIds.length,
    // Reported back so the app can see how many of its barcodes were usable.
    pantry_upcs: upcs.length,
  });
}

function toIntArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const value of raw) {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(),
    },
  });
}
