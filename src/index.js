/**
 * ryli.app Worker entry point.
 *
 * This site is deployed as a "Worker with static assets" (wrangler.jsonc's
 * `assets` + `main`), NOT classic Cloudflare Pages — `wrangler pages
 * project list` returns nothing for this account, only `wrangler
 * deployments list` (the Workers command) does. That matters because Pages
 * Functions (a `functions/api/*.js` file-based-routing convention) simply
 * doesn't apply here; everything has to go through this one fetch handler.
 *
 * Routing: by default (assets.run_worker_first is unset, i.e. false),
 * Cloudflare serves any request that matches a real static file WITHOUT
 * ever invoking this script at all — so index.html/privacy.html/etc. are
 * untouched by anything below. This script only runs for paths with no
 * matching file: /api/ping, /api/stats, and any genuinely missing URL
 * (which falls through to env.ASSETS.fetch() for the site's real 404 page).
 *
 * Anonymous usage ping — see CLAUDE.md's "Anonymous usage ping" section in
 * the main RYLI repo for the full design rationale. `id` is a random UUID
 * generated once per app install, never tied to a license key, email, or
 * Whatnot handle.
 *
 * KV layout (binding: USAGE_KV):
 *   install:<id>              -> JSON { lastSeen: "YYYY-MM-DD", isPro, version }
 *   daily:<YYYY-MM-DD>:total  -> integer, unique installs seen that day
 *   daily:<YYYY-MM-DD>:pro    -> integer, unique Pro installs seen that day
 */

async function handlePing(request, env) {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
    return new Response('bad request', { status: 400 });
  }
  const isPro = !!body.isPro;
  const version = typeof body.version === 'string' ? body.version.slice(0, 32) : 'unknown';
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC

  const key = `install:${id}`;
  let existing = null;
  try {
    const raw = await env.USAGE_KV.get(key);
    existing = raw ? JSON.parse(raw) : null;
  } catch {
    existing = null;
  }
  const alreadyCountedToday = existing && existing.lastSeen === today;

  await env.USAGE_KV.put(key, JSON.stringify({ lastSeen: today, isPro, version }));

  // Only bump the daily aggregate the FIRST time this install is seen on a
  // given day — the app already throttles to one ping/day client-side, but
  // don't trust that alone (a retried/duplicate request must not double-count).
  if (!alreadyCountedToday) {
    const totalKey = `daily:${today}:total`;
    const proKey = `daily:${today}:pro`;
    const totalRaw = await env.USAGE_KV.get(totalKey);
    await env.USAGE_KV.put(totalKey, String(parseInt(totalRaw || '0', 10) + 1));
    if (isPro) {
      const proRaw = await env.USAGE_KV.get(proKey);
      await env.USAGE_KV.put(proKey, String(parseInt(proRaw || '0', 10) + 1));
    }
  }

  return new Response('ok', { status: 200 });
}

// Admin-only usage summary. Requires a secret token (`?token=...`) matching
// the ADMIN_TOKEN secret (set via `wrangler secret put ADMIN_TOKEN`, never
// committed). Without a matching token, responds 404 rather than 401/403,
// so the endpoint's existence isn't hinted at to anyone probing the site.
async function handleStats(request, env) {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
  const url = new URL(request.url);
  const token = (url.searchParams.get('token') || '').trim();
  // .trim() on the secret too — `wrangler secret put` piped from a shell
  // can silently include a trailing newline depending on how it's fed in,
  // and a secret that "looks right" but fails to match byte-for-byte is a
  // nasty thing to debug blind. Trimming both sides is cheap insurance.
  const expected = (env.ADMIN_TOKEN || '').trim();
  if (!token || !expected || token !== expected) {
    return new Response('not found', { status: 404 });
  }

  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days') || '30', 10) || 30));
  const dayStrings = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    dayStrings.push(d.toISOString().slice(0, 10));
  }

  let periodTotal = 0;
  let periodPro = 0;
  const perDay = [];
  for (const day of dayStrings) {
    const [totalRaw, proRaw] = await Promise.all([
      env.USAGE_KV.get(`daily:${day}:total`),
      env.USAGE_KV.get(`daily:${day}:pro`),
    ]);
    const total = parseInt(totalRaw || '0', 10);
    const pro = parseInt(proRaw || '0', 10);
    periodTotal += total;
    periodPro += pro;
    perDay.push({ day, total, pro });
  }
  perDay.reverse(); // oldest first

  // Total unique installs ever seen (cheap — just counts key names, not values).
  let installsEverSeen = 0;
  let cursor;
  do {
    const page = await env.USAGE_KV.list({ prefix: 'install:', cursor });
    installsEverSeen += page.keys.length;
    cursor = page.cursor;
  } while (cursor);

  return new Response(
    JSON.stringify(
      {
        rangeDays: days,
        pingsInRange: periodTotal, // sum of unique-installs-seen-per-day, not de-duped across days
        proPingsInRange: periodPro,
        installsEverSeen,
        perDay,
      },
      null,
      2,
    ),
    { headers: { 'content-type': 'application/json' } },
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ping') return handlePing(request, env);
    if (url.pathname === '/api/stats') return handleStats(request, env);
    // Anything else reaching this script has no matching static file
    // (real pages are served automatically without ever invoking this
    // handler) — hand it to the asset server for the site's real 404 page.
    return env.ASSETS.fetch(request);
  },
};
