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
 * matching file: /api/ping, /api/visit, /api/stats, and any genuinely
 * missing URL (which falls through to env.ASSETS.fetch() for the site's
 * real 404 page).
 *
 * Anonymous usage ping — see CLAUDE.md's "Anonymous usage ping" section in
 * the main RYLI repo for the full design rationale. `id` is a random UUID
 * generated once per app install, never tied to a license key, email, or
 * Whatnot handle.
 *
 * KV layout (binding: USAGE_KV):
 *   install:<id>                 -> JSON { lastSeen: "YYYY-MM-DD", isPro, version },
 *                                    ALSO written with the same fields as KV metadata
 *                                    (see handlePing) so handleStats can compute a
 *                                    version breakdown and a real unique-active count
 *                                    from a single list() sweep, with no per-key GET.
 *   daily:<YYYY-MM-DD>:total     -> integer, unique installs seen that day
 *   daily:<YYYY-MM-DD>:pro       -> integer, unique Pro installs seen that day
 *   daily:<YYYY-MM-DD>:new       -> integer, installs seen for the very first time ever, that day
 *   daily:<YYYY-MM-DD>:visits    -> integer, website pageviews that day (see handleVisit) —
 *                                    a raw pageview counter, NOT unique visitors: no cookie,
 *                                    no fingerprint, no visitor id is ever set, matching this
 *                                    site's existing no-tracking privacy stance.
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
  const isBrandNewInstall = !existing;

  // `metadata` is returned inline by KV's list() for every key, with no
  // per-key GET needed — that's what lets handleStats compute a version
  // breakdown and a real (de-duped) active-install count cheaply, even
  // across many thousands of installs. Keep this in sync with the value
  // body above; they're the same three fields, just also mirrored where
  // list() can see them without fetching each value.
  await env.USAGE_KV.put(key, JSON.stringify({ lastSeen: today, isPro, version }), {
    metadata: { lastSeen: today, isPro, version },
  });

  // Only bump the daily aggregates the FIRST time this install is seen on a
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
    // Distinct from "total" above — this is the growth signal (a genuinely
    // new install, never pinged before at all), not just "someone was
    // active today" (which is dominated by returning installs on any
    // established day).
    if (isBrandNewInstall) {
      const newKey = `daily:${today}:new`;
      const newRaw = await env.USAGE_KV.get(newKey);
      await env.USAGE_KV.put(newKey, String(parseInt(newRaw || '0', 10) + 1));
    }
  }

  return new Response('ok', { status: 200 });
}

// Website pageview beacon — fired once per page load from script.js (loaded
// on every real page: index/privacy/terms/setup-guide/thank-you). Counts
// raw pageviews, not unique visitors: no cookie, no fingerprint, no visitor
// id is ever created or read, matching the same "anonymous, aggregate only"
// stance already documented for the app's own usage ping. Answers "is
// anyone actually looking at the site" without adding any real tracking.
async function handleVisit(request, env) {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const today = new Date().toISOString().slice(0, 10);
  const key = `daily:${today}:visits`;
  try {
    const raw = await env.USAGE_KV.get(key);
    await env.USAGE_KV.put(key, String(parseInt(raw || '0', 10) + 1));
  } catch {
    // Never fail the page load over a missed count.
  }
  return new Response(null, { status: 204 });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Renders the admin stats as a small dark-themed dashboard (RYLI brand
// colors) instead of raw JSON. The token stays in the day-range links since
// the whole page is already gated behind it in the URL either way — this
// changes presentation, not the trust model. Raw JSON is still available via
// &format=json for anything that wants to script against it later.
function renderStatsHtml(data, token) {
  const {
    rangeDays, pingsInRange, proPingsInRange, newInRange, visitsInRange,
    installsEverSeen, uniqueActiveInRange, uniqueActiveProInRange, versionBreakdown, perDay,
  } = data;
  const freeInRange = pingsInRange - proPingsInRange;
  const maxTotal = Math.max(1, ...perDay.map((d) => d.total));
  const dayLink = (n) => `/api/stats?token=${encodeURIComponent(token)}&days=${n}`;

  const bars = perDay
    .map((d) => {
      const totalPct = Math.max(2, Math.round((d.total / maxTotal) * 100));
      const proPct = d.total > 0 ? Math.round((d.pro / d.total) * 100) : 0;
      return `<div class="bar" title="${escapeHtml(d.day)}: ${d.total} total, ${d.pro} pro">
        <div class="bar__fill" style="height:${totalPct}%">
          <div class="bar__pro" style="height:${proPct}%"></div>
        </div>
      </div>`;
    })
    .join('');

  const rows = perDay
    .slice()
    .reverse()
    .map((d) => `<tr><td>${escapeHtml(d.day)}</td><td>${d.total}</td><td>${d.pro}</td><td>${d.total - d.pro}</td><td>${d.newInstalls}</td><td>${d.visits}</td></tr>`)
    .join('');

  const versionRows = versionBreakdown
    .map((v) => {
      const pct = installsEverSeen > 0 ? Math.round((v.count / installsEverSeen) * 1000) / 10 : 0;
      return `<tr><td>${escapeHtml(v.version)}</td><td>${v.count.toLocaleString()}</td><td>${pct}%</td></tr>`;
    })
    .join('');

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RYLI Usage Stats</title>
<style>
  :root { --blue:#6AAEFF; --purple:#B388FF; --cyan:#7DE7FF; --slate:#0D1117; --frost:#F2F6FF; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 20px 60px;
    background: radial-gradient(ellipse at top, #131a26 0%, var(--slate) 60%);
    color: var(--frost); font-family: -apple-system, "Segoe UI", Inter, sans-serif; min-height: 100vh;
  }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 {
    font-size: 28px; margin: 0 0 4px; display: inline-block;
    background: linear-gradient(90deg, var(--blue), var(--purple));
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .sub { color: #8b95a8; font-size: 14px; margin-bottom: 32px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap: 16px; margin-bottom: 28px; }
  .card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 20px; }
  .card__label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #8b95a8; margin-bottom: 8px; }
  .card__value { font-size: 32px; font-weight: 700; }
  .card__value.blue { color: var(--blue); }
  .card__value.purple { color: var(--purple); }
  .card__value.cyan { color: var(--cyan); }
  .panel { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  .panel__head { display:flex; align-items:center; justify-content:space-between; margin-bottom: 20px; }
  .panel__title { font-size: 15px; font-weight: 600; }
  .range-links a { color: #8b95a8; text-decoration: none; font-size: 13px; margin-left: 10px; padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); }
  .range-links a.active { color: var(--blue); border-color: var(--blue); }
  .chart { display: flex; align-items: flex-end; gap: 3px; height: 140px; }
  .bar { flex: 1; height: 100%; display: flex; align-items: flex-end; min-width: 2px; }
  .bar__fill { width: 100%; background: rgba(106,174,255,0.35); border-radius: 3px 3px 0 0; display: flex; align-items: flex-end; }
  .bar__pro { width: 100%; background: var(--purple); border-radius: 3px 3px 0 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); }
  th { color: #8b95a8; font-weight: 600; font-size: 11px; text-transform: uppercase; }
  .legend { display: flex; gap: 16px; font-size: 12px; color: #8b95a8; margin-top: 12px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot.total { background: rgba(106,174,255,0.6); }
  .dot.pro { background: var(--purple); }
  .footer { color: #556; font-size: 12px; margin-top: 30px; text-align: center; }
  .footer a { color: #667; }
  .hint { color: #556; font-size: 12px; margin-top: 14px; line-height: 1.5; }
  @media (prefers-color-scheme: light) {
    body { background: radial-gradient(ellipse at top, #eef2fb 0%, #fff 60%); color: #0D1117; }
    .card, .panel { background: rgba(0,0,0,0.03); border-color: rgba(0,0,0,0.08); }
    .sub, .card__label, th { color: #5b6472; }
    .hint { color: #7b8492; }
  }
</style>
</head><body>
<div class="wrap">
  <h1>RYLI Usage Stats</h1>
  <div class="sub">Anonymous, aggregate install activity &middot; last ${rangeDays} days</div>

  <div class="cards">
    <div class="card"><div class="card__label">Installs ever seen</div><div class="card__value">${installsEverSeen.toLocaleString()}</div></div>
    <div class="card"><div class="card__label">Unique active (${rangeDays}d)</div><div class="card__value blue">${uniqueActiveInRange.toLocaleString()}</div></div>
    <div class="card"><div class="card__label">...of those, Pro</div><div class="card__value purple">${uniqueActiveProInRange.toLocaleString()}</div></div>
    <div class="card"><div class="card__label">New installs (${rangeDays}d)</div><div class="card__value cyan">${newInRange.toLocaleString()}</div></div>
    <div class="card"><div class="card__label">Website pageviews (${rangeDays}d)</div><div class="card__value">${visitsInRange.toLocaleString()}</div></div>
  </div>

  <div class="panel">
    <div class="panel__head">
      <div class="panel__title">Daily pings</div>
      <div class="range-links">
        <a href="${dayLink(7)}" class="${rangeDays === 7 ? 'active' : ''}">7d</a>
        <a href="${dayLink(30)}" class="${rangeDays === 30 ? 'active' : ''}">30d</a>
        <a href="${dayLink(90)}" class="${rangeDays === 90 ? 'active' : ''}">90d</a>
      </div>
    </div>
    <div class="chart">${bars || '<span style="color:#556;font-size:13px;">No data yet</span>'}</div>
    <div class="legend"><span><i class="dot total"></i>Total pings</span><span><i class="dot pro"></i>Pro</span></div>
    <div class="hint">"Total pings" sums each day's activity — an install that opens RYLI on 10 different days in this range adds 10 here. See "Unique active" above for the real de-duped headcount.</div>
  </div>

  <div class="panel">
    <div class="panel__title" style="margin-bottom:16px;">By version</div>
    <table>
      <thead><tr><th>Version</th><th>Installs</th><th>Share</th></tr></thead>
      <tbody>${versionRows || '<tr><td colspan="3" style="color:#556;">No data yet</td></tr>'}</tbody>
    </table>
    <div class="hint">Every install ever seen, by the version it last pinged from — a stale version share here is the real signal for "people aren't updating."</div>
  </div>

  <div class="panel">
    <div class="panel__title" style="margin-bottom:16px;">By day</div>
    <table>
      <thead><tr><th>Date</th><th>Total</th><th>Pro</th><th>Free</th><th>New</th><th>Pageviews</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" style="color:#556;">No data yet</td></tr>'}</tbody>
    </table>
  </div>

  <div class="footer">RYLI &middot; refreshes on every page load &middot; <a href="${dayLink(rangeDays)}&format=json">raw JSON</a></div>
</div>
</body></html>`;
}

// Admin-only usage summary. Requires a secret token (`?token=...`) matching
// the ADMIN_TOKEN secret (set via `wrangler secret put ADMIN_TOKEN`, never
// committed). Without a matching token, responds 404 rather than 401/403,
// so the endpoint's existence isn't hinted at to anyone probing the site.
// Renders as an HTML dashboard by default; add &format=json for raw data.
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
  let periodNew = 0;
  let periodVisits = 0;
  const perDay = [];
  for (const day of dayStrings) {
    const [totalRaw, proRaw, newRaw, visitsRaw] = await Promise.all([
      env.USAGE_KV.get(`daily:${day}:total`),
      env.USAGE_KV.get(`daily:${day}:pro`),
      env.USAGE_KV.get(`daily:${day}:new`),
      env.USAGE_KV.get(`daily:${day}:visits`),
    ]);
    const total = parseInt(totalRaw || '0', 10);
    const pro = parseInt(proRaw || '0', 10);
    const newInstalls = parseInt(newRaw || '0', 10);
    const visits = parseInt(visitsRaw || '0', 10);
    periodTotal += total;
    periodPro += pro;
    periodNew += newInstalls;
    periodVisits += visits;
    perDay.push({ day, total, pro, newInstalls, visits });
  }
  perDay.reverse(); // oldest first

  // One list() sweep over every install:* key covers three things at once,
  // using the metadata each key already carries (see handlePing) — no
  // per-key GET needed even with many thousands of installs:
  //   1. installsEverSeen   — just the key count, as before.
  //   2. uniqueActiveInRange — a REAL de-duped count of installs whose
  //      lastSeen falls within the selected range. This is the number
  //      pingsInRange (below) is NOT: that one sums each day's count, so
  //      the same install pinging on 10 different days counts 10 times.
  //      This one counts it once, however many days it showed up.
  //   3. versionCounts      — how many active-ever installs report each
  //      app version, letting you see real update uptake.
  const cutoff = dayStrings[dayStrings.length - 1]; // oldest day string in range (YYYY-MM-DD sorts lexically)
  let installsEverSeen = 0;
  let uniqueActiveInRange = 0;
  let uniqueActiveProInRange = 0;
  const versionCounts = new Map();
  let cursor;
  do {
    const page = await env.USAGE_KV.list({ prefix: 'install:', cursor });
    for (const k of page.keys) {
      installsEverSeen++;
      const meta = k.metadata;
      if (!meta) continue; // installs written before this metadata field existed — harmless, just excluded from the two breakdowns below until they ping again
      if (meta.lastSeen >= cutoff) {
        uniqueActiveInRange++;
        if (meta.isPro) uniqueActiveProInRange++;
      }
      const v = meta.version || 'unknown';
      versionCounts.set(v, (versionCounts.get(v) || 0) + 1);
    }
    cursor = page.cursor;
  } while (cursor);
  const versionBreakdown = [...versionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([version, count]) => ({ version, count }));

  const data = {
    rangeDays: days,
    pingsInRange: periodTotal, // sum of unique-installs-seen-per-day, not de-duped across days — see uniqueActiveInRange for the real figure
    proPingsInRange: periodPro,
    newInRange: periodNew,
    visitsInRange: periodVisits,
    installsEverSeen,
    uniqueActiveInRange,
    uniqueActiveProInRange,
    versionBreakdown,
    perDay,
  };

  if (url.searchParams.get('format') === 'json') {
    return new Response(JSON.stringify(data, null, 2), { headers: { 'content-type': 'application/json' } });
  }

  return new Response(renderStatsHtml(data, token), { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ping') return handlePing(request, env);
    if (url.pathname === '/api/visit') return handleVisit(request, env);
    if (url.pathname === '/api/stats') return handleStats(request, env);
    // Anything else reaching this script has no matching static file
    // (real pages are served automatically without ever invoking this
    // handler) — hand it to the asset server for the site's real 404 page.
    return env.ASSETS.fetch(request);
  },
};
