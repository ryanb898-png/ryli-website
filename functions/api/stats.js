/**
 * Admin-only usage summary — reads the same USAGE_KV namespace ping.js
 * writes to. Requires a secret token (`?token=...`) matching the
 * ADMIN_TOKEN environment variable set on the Pages project (via the
 * Cloudflare dashboard or `wrangler pages secret put` — never committed to
 * the repo). Without a matching token, responds 404 rather than 401/403,
 * so the endpoint's existence isn't hinted at to anyone probing the site.
 *
 * Query params:
 *   token  (required) — the admin secret
 *   days   (optional, default 30) — how many trailing days to sum
 */
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token || !env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
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
