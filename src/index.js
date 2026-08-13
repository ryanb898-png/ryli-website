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

import US_PATHS from './us-paths.js';
import US_BLIPS from './us-blips.js';

// Every `daily:` bucket is keyed to a calendar day in THIS timezone, not UTC.
// Buckets were UTC until 2026-08-04, which meant the dashboard rolled over to
// "tomorrow" at 8pm Eastern — an empty next-day row would appear while it was
// still today, and an evening's activity landed on the following day's row.
// Switched while the dataset was ~1 week old and tiny; the seam between the
// old UTC days and these is negligible at that size and only gets more
// expensive to fix later. Change this one constant to re-home the reporting
// day; historical keys keep whatever boundary they were written under.
const REPORT_TZ = 'America/New_York';

// 'en-CA' formats as YYYY-MM-DD, which is what every KV key expects and what
// sorts lexically (relied on by the range cutoff comparison in handleStats).
// Intl handles DST on its own, so this stays correct across the spring/fall
// changeover without any offset arithmetic here.
function dayKey(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: REPORT_TZ });
}

// Walk back `n` calendar days from a YYYY-MM-DD string. Anchored at 12:00 UTC
// rather than midnight so a DST shift can never bump the arithmetic across a
// date boundary and duplicate or skip a day.
function shiftDay(dayStr, n) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d, 12) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

// Coarse location for the growth map, read off Cloudflare's own `request.cf`.
// Two things worth being precise about, because they are the whole privacy
// story:
//
//   1. We never see, store, or log an IP address. Cloudflare resolves the
//      geography at their edge — they already terminate the connection to
//      serve this site — and hands us the answer. Nothing is collected from
//      the visitor that wasn't already flowing through.
//   2. STATE level, deliberately — never city, never coordinates, even though
//      `request.cf` offers both. Paired with a persistent install id, a city
//      (or a small town) gets close to identifying one specific seller. A
//      state is the resolution the map actually colours, so finer data would
//      be held for no benefit. Don't "improve" this.
//
// Returns 'US-CT' style for the US, a bare country code elsewhere, and
// 'unknown' when Cloudflare has no answer (local dev, some VPNs, bots).
function geoKey(request) {
  const cf = request.cf || {};
  const country = typeof cf.country === 'string' ? cf.country.toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(country)) return 'unknown';
  if (country !== 'US') return country;
  const region = typeof cf.regionCode === 'string' ? cf.regionCode.toUpperCase() : '';
  return /^[A-Z]{2}$/.test(region) ? `US-${region}` : 'US';
}

// KV has no atomic increment, so this is a read-modify-write and two requests
// landing together can lose a count. Accepted deliberately: every other
// counter in this file works the same way, the map is a morale readout rather
// than billing, and the alternative (Durable Objects) is real infrastructure
// for a rounding error at this scale.
async function bumpGeo(env, kind, key) {
  const k = `geo:${kind}:${key}`;
  try {
    const raw = await env.USAGE_KV.get(k);
    await env.USAGE_KV.put(k, String(parseInt(raw || '0', 10) + 1));
  } catch {
    // A missed map pixel must never fail the request it rode in on.
  }
}

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
  const today = dayKey();

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
  // Count an install's location the first time we ever LEARN it, not the
  // first time we see the install. Those differ: every install that existed
  // before the map shipped already has a record with no `geo`, and keying
  // off isBrandNewInstall would mean none of them ever appear. This way they
  // backfill themselves on their next daily ping.
  const geo = geoKey(request);
  const geoIsNew = !existing || !existing.geo;
  if (geoIsNew) await bumpGeo(env, 'install', geo);
  // Keep the previously-recorded geo once known, so an install that pings
  // from a coffee shop one day doesn't hop across the map. First location
  // wins — this is "where our hosts are", not "where they are today".
  const geoStored = (existing && existing.geo) || geo;

  await env.USAGE_KV.put(key, JSON.stringify({ lastSeen: today, isPro, version, geo: geoStored }), {
    metadata: { lastSeen: today, isPro, version, geo: geoStored },
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
  const today = dayKey();
  const key = `daily:${today}:visits`;
  try {
    const raw = await env.USAGE_KV.get(key);
    await env.USAGE_KV.put(key, String(parseInt(raw || '0', 10) + 1));
  } catch {
    // Never fail the page load over a missed count.
  }
  // Same coarse geography as the install ping, on the same terms — see
  // geoKey(). Every pageview counts here, not unique visitors, because
  // that's what this beacon has always measured and inventing a visitor id
  // to de-dupe would be exactly the tracking this site promises not to do.
  await bumpGeo(env, 'visit', geoKey(request));
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
const STATE_NAMES = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'Washington DC',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming' };

// The map. Two visual channels rather than one blended heat value: install
// density is the FILL, website visits are the glowing OUTLINE. They measure
// different things (people running the app vs people looking at the site) and
// averaging them into a single colour would say nothing true about either.
function renderGeoPanel(geo) {
  const installs = {};
  const visits = {};
  const countries = {};
  for (const [k, n] of Object.entries((geo && geo.install) || {})) {
    if (k.startsWith('US-')) installs[k.slice(3)] = n;
    else if (k !== 'unknown') countries[k] = (countries[k] || 0) + n;
  }
  for (const [k, n] of Object.entries((geo && geo.visit) || {})) {
    if (k.startsWith('US-')) visits[k.slice(3)] = n;
  }

  const maxI = Math.max(1, ...Object.values(installs));
  const maxV = Math.max(1, ...Object.values(visits));

  // Base map: every state drawn as a quiet outline. It exists for orientation
  // only now \u2014 the DATA lives in the blips below, not in the fill. Each state
  // still carries its own tooltip and hover, so pointing at an empty state
  // still answers "is there anything here".
  const paths = Object.entries(US_PATHS).map(([ab, d]) => {
    const i = installs[ab] || 0;
    const v = visits[ab] || 0;
    const name = STATE_NAMES[ab] || ab;
    const tip = `${name} \u2014 ${i} install${i === 1 ? '' : 's'}, ${v} site visit${v === 1 ? '' : 's'}`;
    return `<path class="us${i ? ' us--has' : ''}" d="${d}"><title>${escapeHtml(tip)}</title></path>`;
  }).join('');

  // Deterministic scatter. Seeded from the state code + index so a blip sits in
  // the same spot on every load \u2014 a dot that jumps around between refreshes
  // reads as noise rather than as a place.
  const jitter = (ab, i) => {
    let h = 2166136261;
    const s = ab + ':' + i;
    for (let j = 0; j < s.length; j++) { h ^= s.charCodeAt(j); h = Math.imul(h, 16777619); }
    const a = ((h >>> 0) % 1000) / 1000;
    const b = ((Math.imul(h, 2654435761) >>> 0) % 1000) / 1000;
    // sqrt on the radius keeps the scatter even across the disc instead of
    // clumping everything toward the centre.
    const rad = Math.sqrt(a);
    const ang = b * Math.PI * 2;
    return [Math.cos(ang) * rad, Math.sin(ang) * rad];
  };

  // One blip per install, up to a cap \u2014 past that the dots grow instead of
  // multiplying, so a breakout state reads as intense rather than as a smear.
  const MAX_BLIPS = 14;
  const blipsFor = (map, ab, kind, max) => {
    const n = map[ab] || 0;
    if (!n) return '';
    const anchor = US_BLIPS[ab];
    if (!anchor) return '';
    const [cx, cy, rx, ry] = anchor;
    const shown = Math.min(n, MAX_BLIPS);
    const over = n / MAX_BLIPS;
    const r = kind === 'i'
      ? (2.2 + 1.9 * Math.min(1, Math.log2(1 + n) / Math.log2(1 + max))).toFixed(2)
      : (1.5 + 1.2 * Math.min(1, Math.log2(1 + n) / Math.log2(1 + max))).toFixed(2);
    let out = '';
    for (let k = 0; k < shown; k++) {
      const [jx, jy] = jitter(ab + kind, k);
      const x = (cx + jx * rx).toFixed(1);
      const y = (cy + jy * ry).toFixed(1);
      // Staggered so a busy state fills in rather than snapping on at once.
      const delay = ((k * 0.09) + (kind === 'v' ? 0.25 : 0)).toFixed(2);
      out += `<circle class="blip blip--${kind}" cx="${x}" cy="${y}" r="${r}" style="--d:${delay}s"></circle>`;
    }
    // A single soft halo for states past the cap, so "a lot" still reads.
    if (over > 1) {
      out += `<circle class="blip-halo blip-halo--${kind}" cx="${cx}" cy="${cy}" r="${(Math.min(rx, ry) * 1.25).toFixed(1)}"></circle>`;
    }
    return out;
  };

  const blips = Object.keys(US_BLIPS).map((ab) => {
    const bi = blipsFor(installs, ab, 'i', maxI);
    const bv = blipsFor(visits, ab, 'v', maxV);
    if (!bi && !bv) return '';
    const name = STATE_NAMES[ab] || ab;
    const tip = `${name} \u2014 ${installs[ab] || 0} install${(installs[ab] || 0) === 1 ? '' : 's'}, ${visits[ab] || 0} site visit${(visits[ab] || 0) === 1 ? '' : 's'}`;
    // Visits behind installs, so an install blip is never hidden by a pageview.
    return `<g class="blip-g"><title>${escapeHtml(tip)}</title>${bv}${bi}</g>`;
  }).join('');

  const usTotal = Object.values(installs).reduce((a, b) => a + b, 0);
  const intlTotal = Object.values(countries).reduce((a, b) => a + b, 0);
  const chips = Object.entries(countries).sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `<span class="geo-chip"><b>${escapeHtml(c)}</b>${n}</span>`).join('');
  const countryCount = Object.keys(countries).length + (usTotal ? 1 : 0);

  return `<div class="panel">
    <div class="panel__head">
      <div class="panel__title">Where RYLI is running <span class="panel__note">all time</span></div>
      <div class="geo-toggle"><button data-geo="both" class="active">Both</button><button data-geo="installs">Installs</button><button data-geo="visits">Site visits</button></div>
    </div>
    <div class="geo-stats"><span><b class="blue">${(usTotal + intlTotal).toLocaleString()}</b>installs mapped</span><span><b class="blue">${Object.keys(installs).length}</b>states</span><span><b class="purple">${countryCount}</b>countries</span></div>
    <div class="geo-map" data-mode="both"><svg viewBox="0 0 960 600" role="img" aria-label="Map of the United States shaded by RYLI install count per state">
      <defs>
        <radialGradient id="geobg" cx="50%" cy="45%" r="60%"><stop offset="0%" stop-color="#6AAEFF" stop-opacity=".10"/><stop offset="100%" stop-color="#6AAEFF" stop-opacity="0"/></radialGradient>
        <filter id="geoglow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      <rect width="960" height="600" fill="url(#geobg)"/>
      <g>${paths}</g>
      <g class="blips">${blips}</g>
    </svg></div>
    <div class="geo-legend"><span><i class="geo-sw geo-sw--i"></i>Installs &mdash; one blip each</span><span><i class="geo-sw geo-sw--v"></i>Website visits</span></div>
    ${chips ? `<div class="geo-intl"><div class="geo-intl__h">Outside the US</div>${chips}</div>` : ''}
    <div class="note" style="margin-top:14px;">Location comes from Cloudflare's edge at request time &mdash; country and state only, never a city, coordinate, or IP address. An install's location is recorded once, on first sight.</div>
  </div>`;
}

function renderStatsHtml(data, token) {
  const {
    rangeDays, pingsInRange, proPingsInRange, newInRange, visitsInRange,
    installsEverSeen, uniqueActiveInRange, uniqueActiveProInRange, versionBreakdown, perDay,
    timezone, previous, retention,
  } = data;
  // "(1d)" reads as a typo. Every range-dependent label goes through these so
  // the Today view reads like a sentence rather than a unit.
  const rangeLabel = rangeDays === 1 ? 'today' : `${rangeDays}d`;
  const rangeWords = rangeDays === 1 ? 'today' : `last ${rangeDays} days`;
  const freeInRange = pingsInRange - proPingsInRange;

  // "vs previous period" chip. A jump from zero has no meaningful percentage,
  // so say what actually happened instead of printing an infinity.
  const delta = (now, before) => {
    if (before === 0 && now === 0) return '<span class="d d--flat">no change</span>';
    if (before === 0) return `<span class="d d--up">new this period</span>`;
    const pct = Math.round(((now - before) / before) * 100);
    if (pct === 0) return '<span class="d d--flat">flat</span>';
    const cls = pct > 0 ? 'd--up' : 'd--down';
    return `<span class="d ${cls}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%</span>`;
  };
  const growthRows = [
    ['Active days', pingsInRange, previous.pings, 'Days an install opened the app, summed. Same install on 3 days = 3.'],
    ['New installs', newInRange, previous.newInstalls, 'Installs pinging for the very first time ever.'],
    ['Pageviews', visitsInRange, previous.visits, 'Raw site pageviews — not unique visitors.'],
  ].map(([label, now, before, note]) => `<tr>
      <td>${escapeHtml(label)}<div class="note">${escapeHtml(note)}</div></td>
      <td class="num">${now.toLocaleString()}</td>
      <td class="num" style="color:#7c8aa8;">${before.toLocaleString()}</td>
      <td>${delta(now, before)}</td>
    </tr>`).join('');

  const retTotal = retention.active7 + retention.active8to30 + retention.dormant + retention.unknown;
  const retRow = (label, n, color, note) => {
    const pct = retTotal > 0 ? Math.round((n / retTotal) * 100) : 0;
    return `<tr>
      <td><span class="dot" style="background:${color}"></span>${escapeHtml(label)}<div class="note">${escapeHtml(note)}</div></td>
      <td class="num">${n.toLocaleString()}</td>
      <td class="num" style="color:#7c8aa8;">${pct}%</td>
    </tr>`;
  };
  const retentionRows = [
    retRow('Still active', retention.active7, '#45e0a0', 'Opened the app in the last 7 days.'),
    retRow('Drifting', retention.active8to30, '#f5c542', 'Last seen 8–30 days ago.'),
    retRow('Gone quiet', retention.dormant, '#ff6b6b', "Nothing for 30+ days — installed, then stopped."),
    retention.unknown > 0
      ? retRow('Unknown', retention.unknown, '#556', 'Installed before this was tracked; will sort itself on their next launch.')
      : '',
  ].join('');
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
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .note { color: #6f7b91; font-size: 11px; line-height: 1.45; margin-top: 3px; font-weight: 400; text-transform: none; letter-spacing: 0; }
  .d { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 999px; white-space: nowrap; }
  .d--up { color: #45e0a0; background: rgba(69,224,160,0.12); }
  .d--down { color: #ff6b6b; background: rgba(255,107,107,0.12); }
  .d--flat { color: #7c8aa8; background: rgba(124,138,168,0.12); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
  .footer a { color: #667; }
  .hint { color: #556; font-size: 12px; margin-top: 14px; line-height: 1.5; }
  .panel__head { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .geo-stats { display: flex; gap: 24px; flex-wrap: wrap; font-size: 13px; color: #8b95a8; margin: 10px 0 12px; }
  .geo-stats b { font-size: 21px; font-weight: 700; margin-right: 7px; }
  .geo-map { border-radius: 10px; overflow: hidden; }
  .geo-map svg { width: 100%; height: auto; display: block; }
  /* Base map is now scenery, not data — the blips carry the numbers. A state
     with something in it gets a slightly lifted outline so the shape reads
     under its dots without competing with them. */
  .us { fill: #161d2b; stroke: #333e56; stroke-width: .7; transition: fill .25s, stroke .25s; }
  .us--has { fill: #1b2436; stroke: #46557a; }
  .us:hover { fill: #24304a; stroke: #7DE7FF; }

  /* Blips. Scale/opacity only, both GPU-composited, so a hundred of them still
     cost nothing. They fade in staggered rather than all at once, which is what
     makes a busy state look like it is filling up. */
  .blip { transform-box: fill-box; transform-origin: center; opacity: 0;
          animation: blipIn .5s ease-out forwards var(--d), blipPulse 4s ease-in-out infinite var(--d); }
  .blip--i { fill: #6AAEFF; filter: url(#geoglow); }
  .blip--v { fill: #B388FF; }
  .blip-halo { fill: none; stroke-width: 1.2; opacity: .5; animation: blipPulse 5s ease-in-out infinite; }
  .blip-halo--i { stroke: rgba(106,174,255,.55); }
  .blip-halo--v { stroke: rgba(179,136,255,.4); }
  .blip-g:hover .blip { fill: #7DE7FF; }
  @keyframes blipIn { from { opacity: 0; transform: scale(.3); } to { opacity: .95; transform: scale(1); } }
  @keyframes blipPulse { 0%,100% { opacity: .95; } 50% { opacity: .62; } }
  /* The toggle hides a layer outright rather than restyling it — with blips
     there is no "half on" state to express, unlike the old outline shading. */
  .geo-map[data-mode="installs"] .blip--v,
  .geo-map[data-mode="installs"] .blip-halo--v,
  .geo-map[data-mode="visits"] .blip--i,
  .geo-map[data-mode="visits"] .blip-halo--i { display: none; }
  @media (prefers-reduced-motion: reduce) {
    .blip, .blip-halo { animation: none; opacity: .95; }
  }
  .geo-toggle button { background: none; border: 1px solid rgba(255,255,255,0.1); color: #8b95a8; font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; margin-left: 6px; cursor: pointer; }
  .geo-toggle button.active { color: #6AAEFF; border-color: #6AAEFF; }
  .geo-legend { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px; color: #8b95a8; margin-top: 10px; }
  .geo-sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 7px; vertical-align: middle; }
  .geo-sw--i { background: rgba(106,174,255,.95); box-shadow: 0 0 9px rgba(106,174,255,.75); }
  .geo-sw--v { background: transparent; border: 2px solid #B388FF; }
  .geo-intl { margin-top: 16px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.06); }
  .geo-intl__h { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8b95a8; margin-bottom: 10px; }
  .geo-chip { display: inline-block; font-size: 12px; color: #c8d2e4; background: rgba(179,136,255,0.12); border: 1px solid rgba(179,136,255,0.25); border-radius: 999px; padding: 4px 10px; margin: 0 6px 6px 0; }
  .geo-chip b { color: #B388FF; margin-right: 6px; }
  @media (prefers-color-scheme: light) {
    body { background: radial-gradient(ellipse at top, #eef2fb 0%, #fff 60%); color: #0D1117; }
    .card, .panel { background: rgba(0,0,0,0.03); border-color: rgba(0,0,0,0.08); }
    .sub, .card__label, th { color: #5b6472; }
    .hint { color: #7b8492; }
    .us { fill: #e7ecf6; stroke: #c3ccdd; }
    .us--has { fill: #dde5f3; stroke: #9fb0cd; }
    .us:hover { fill: #ccd8ee; stroke: #2e6fe0; }
    .blip--i { fill: #2e6fe0; }
    .blip--v { fill: #7c4dff; }
    .blip-halo--i { stroke: rgba(46,111,224,.5); }
    .blip-halo--v { stroke: rgba(124,77,255,.4); }
    .geo-stats, .geo-legend, .geo-intl__h { color: #5b6472; }
  }
</style>
</head><body>
<div class="wrap">
  <h1>RYLI Usage Stats</h1>
  <div class="sub">Anonymous, aggregate install activity &middot; ${rangeWords}</div>

  ${renderGeoPanel(data.geo)}


  <div class="cards">
    <div class="card"><div class="card__label">Installs ever seen</div><div class="card__value">${installsEverSeen.toLocaleString()}</div></div>
    <div class="card"><div class="card__label">Unique active (${rangeLabel})</div><div class="card__value blue">${uniqueActiveInRange.toLocaleString()}</div></div>
    <div class="card"><div class="card__label">...of those, Pro</div><div class="card__value purple">${uniqueActiveProInRange.toLocaleString()}</div></div>
    <div class="card"><div class="card__label">New installs (${rangeLabel})</div><div class="card__value cyan">${newInRange.toLocaleString()}</div></div>
    <div class="card"><div class="card__label">Website pageviews (${rangeLabel})</div><div class="card__value">${visitsInRange.toLocaleString()}</div></div>
  </div>

  <div class="panel">
    <div class="panel__head">
      <div class="panel__title">Daily pings</div>
      <div class="range-links">
        <a href="${dayLink(1)}" class="${rangeDays === 1 ? 'active' : ''}">Today</a>
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
    <div class="panel__title" style="margin-bottom:6px;">Are people sticking around?</div>
    <div class="note" style="margin-bottom:14px;">Every install that has ever run RYLI, grouped by how recently it last opened. This is the retention picture — the counts above can't show it.</div>
    <table>
      <thead><tr><th>Status</th><th class="num">Installs</th><th class="num">Share</th></tr></thead>
      <tbody>${retentionRows || '<tr><td colspan="3" style="color:#556;">No installs yet</td></tr>'}</tbody>
    </table>
  </div>

  <div class="panel">
    <div class="panel__title" style="margin-bottom:6px;">Growth &mdash; ${rangeWords} vs the ${rangeDays === 1 ? 'day' : rangeDays + ' days'} before</div>
    <div class="note" style="margin-bottom:14px;">Direction, not just a snapshot. Built from daily counters, so it compares like for like.</div>
    <table>
      <thead><tr><th>Measure</th><th class="num">This period</th><th class="num">Previous</th><th>Change</th></tr></thead>
      <tbody>${growthRows}</tbody>
    </table>
  </div>

  <div class="panel">
    <div class="panel__title" style="margin-bottom:6px;">By day</div>
    <div class="note" style="margin-bottom:14px;">Days run on ${escapeHtml(timezone)} time, so a day ends at your midnight &mdash; not UTC's.</div>
    <table>
      <thead><tr><th>Date</th><th>Total</th><th>Pro</th><th>Free</th><th>New</th><th>Pageviews</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" style="color:#556;">No data yet</td></tr>'}</tbody>
    </table>
  </div>

  <div class="footer">RYLI &middot; days in ${escapeHtml(timezone)} &middot; refreshes on every page load &middot; <a href="${dayLink(rangeDays)}&format=json">raw JSON</a></div>
</div>
<script>
document.querySelectorAll('.geo-toggle button').forEach(function (b) {
  b.addEventListener('click', function () {
    document.querySelectorAll('.geo-toggle button').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    document.querySelector('.geo-map').dataset.mode = b.dataset.geo;
  });
});
<\/script>
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

  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days') || '1', 10) || 1));
  const todayKey = dayKey();
  const dayStrings = [];
  for (let i = 0; i < days; i++) dayStrings.push(shiftDay(todayKey, -i));

  // The equivalent window immediately before this one, for a like-for-like
  // "vs previous period" comparison. Deliberately built from the same daily
  // counters rather than from install metadata: an install stores only its
  // LAST seen day, so a genuine unique-active count for a PAST window can't
  // be reconstructed after the fact (anyone active in both windows now reads
  // as current-only). Summed day counts are the honest comparable here.
  const prevDayStrings = [];
  for (let i = days; i < days * 2; i++) prevDayStrings.push(shiftDay(todayKey, -i));

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

  let prevTotal = 0;
  let prevNew = 0;
  let prevVisits = 0;
  for (const day of prevDayStrings) {
    const [t, n, v] = await Promise.all([
      env.USAGE_KV.get(`daily:${day}:total`),
      env.USAGE_KV.get(`daily:${day}:new`),
      env.USAGE_KV.get(`daily:${day}:visits`),
    ]);
    prevTotal += parseInt(t || '0', 10);
    prevNew += parseInt(n || '0', 10);
    prevVisits += parseInt(v || '0', 10);
  }

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
  // Retention, from the lastSeen each install already carries — no extra
  // data collected, and it answers the question the raw counts above can't:
  // are installs still running the app, or did they try it and stop? Bucket
  // boundaries are fixed at 7/30 days regardless of the selected range, so
  // the shape doesn't change meaning when you switch the range links.
  const cutoff7 = shiftDay(todayKey, -6); // today plus the 6 before it
  const cutoff30 = shiftDay(todayKey, -29);
  let retActive7 = 0;
  let retActive30 = 0; // active 8-30 days ago (drifting), NOT cumulative
  let retDormant = 0; // nothing for 30+ days
  let retUnknown = 0; // pre-metadata installs; can't be placed, counted honestly
  let cursor;
  do {
    const page = await env.USAGE_KV.list({ prefix: 'install:', cursor });
    for (const k of page.keys) {
      installsEverSeen++;
      const meta = k.metadata;
      if (!meta) { retUnknown++; continue; } // installs written before this metadata field existed — harmless, just excluded from the breakdowns below until they ping again
      if (meta.lastSeen >= cutoff) {
        uniqueActiveInRange++;
        if (meta.isPro) uniqueActiveProInRange++;
      }
      if (meta.lastSeen >= cutoff7) retActive7++;
      else if (meta.lastSeen >= cutoff30) retActive30++;
      else retDormant++;
      // Version uptake counts only installs seen in the last 30 DAYS, not every
      // install ever recorded. Counting all of them answered the wrong question:
      // an install last seen weeks ago still reports its old version forever, so
      // the breakdown claimed people were sitting on stale builds when they had
      // simply stopped opening the app. What this needs to answer is "of the
      // people actually running RYLI, who has the update yet".
      //
      // Keyed to a FIXED 30 days rather than the selected range, so switching to
      // the Today view does not collapse it to whoever launched in the last few
      // hours.
      if (meta.lastSeen >= cutoff30) {
        const v = meta.version || 'unknown';
        versionCounts.set(v, (versionCounts.get(v) || 0) + 1);
      }
    }
    cursor = page.cursor;
  } while (cursor);
  const versionBreakdown = [...versionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([version, count]) => ({ version, count }));

  // Geography. One list() sweep over the `geo:` prefix rather than a GET per
  // state — 50 states plus countries plus two kinds would otherwise be ~100
  // round trips on every dashboard load. The counts live in the values, so
  // this does need the GETs, but only for keys that actually exist (a state
  // nobody has installed from is simply absent, not zero).
  const geo = { install: {}, visit: {} };
  try {
    let cursor;
    const geoKeys = [];
    do {
      const page = await env.USAGE_KV.list({ prefix: 'geo:', cursor });
      geoKeys.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    await Promise.all(geoKeys.map(async (name) => {
      // geo:<kind>:<region> — region can itself contain a dash (US-CT), so
      // split on the first two colons only.
      const rest = name.slice('geo:'.length);
      const sep = rest.indexOf(':');
      if (sep < 0) return;
      const kind = rest.slice(0, sep);
      const region = rest.slice(sep + 1);
      if (kind !== 'install' && kind !== 'visit') return;
      const raw = await env.USAGE_KV.get(name);
      const n = parseInt(raw || '0', 10);
      if (n > 0) geo[kind][region] = n;
    }));
  } catch {
    // A map that can't load must not take the whole dashboard down with it.
  }

  const data = {
    geo,
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
    timezone: REPORT_TZ,
    previous: { pings: prevTotal, newInstalls: prevNew, visits: prevVisits },
    retention: { active7: retActive7, active8to30: retActive30, dormant: retDormant, unknown: retUnknown },
  };

  if (url.searchParams.get('format') === 'json') {
    return new Response(JSON.stringify(data, null, 2), { headers: { 'content-type': 'application/json' } });
  }

  return new Response(renderStatsHtml(data, token), { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

// RYLI's own Polar organization id — same constant desktop/bridge/licenseStore.js
// hardcodes for activate/validate/deactivate calls. Kept as an independent copy
// here rather than a shared import (this is a separate repo/runtime), matching
// this app's existing convention of not trusting a shared constant stays in
// sync forever across separate codebases.
const POLAR_ORG_ID = '9c6abd6b-a3d9-4de9-a0c2-02558b6c03aa';

// Real, official Polar API calls, using env.POLAR_OAT — a narrowly-scoped
// (checkouts:read + license_keys:read ONLY, no write/refund/product access)
// Organization Access Token, set via `wrangler secret put POLAR_OAT` and never
// exposed to the browser. Reconstructs the "show the license key on the
// thank-you page" UX LemonSqueezy gave for free — Polar has no equivalent of
// LemonSqueezy's `?key=` success-URL interpolation, so this does it server-side
// instead: look up the checkout's resulting customer, then scan this org's
// granted license keys for the one issued to that customer.
async function handleCheckoutLicense(request, env) {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
  const url = new URL(request.url);
  const checkoutId = (url.searchParams.get('checkout_id') || '').trim();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(checkoutId)) {
    return jsonResponse({ ok: false, reason: 'invalid_checkout_id' }, 400);
  }
  const oat = env.POLAR_OAT;
  if (!oat) return jsonResponse({ ok: false, reason: 'not_configured' }, 500);
  const authHeaders = { Authorization: `Bearer ${oat}`, Accept: 'application/json' };

  let checkout;
  try {
    const res = await fetch(`https://api.polar.sh/v1/checkouts/${checkoutId}`, { headers: authHeaders });
    if (!res.ok) return jsonResponse({ ok: false, reason: 'checkout_lookup_failed' }, 502);
    checkout = await res.json();
  } catch {
    return jsonResponse({ ok: false, reason: 'checkout_lookup_failed' }, 502);
  }

  // 'confirmed' = the customer clicked Pay but Polar hasn't fully settled the
  // payment yet; 'succeeded' = done. Either way there may not be a customer_id
  // (and definitely no granted license key) for a few seconds yet — treat both
  // as "keep polling", never as an error, matching the checkout's own documented
  // status semantics rather than guessing.
  if (checkout.status !== 'succeeded' && checkout.status !== 'confirmed') {
    return jsonResponse({ ok: false, reason: 'processing' });
  }
  const customerId = checkout.customer_id;
  if (!customerId) return jsonResponse({ ok: false, reason: 'processing' });

  // The List License Keys endpoint has no customer_id filter (per Polar's own
  // API reference — only organization_id/benefit_id/status/page/limit), so this
  // walks every granted key for the org looking for the one issued to this
  // customer. Fine at this org's real scale (a handful of subscribers so far);
  // revisit with a benefit_id filter or a different lookup if that ever grows
  // into thousands of keys.
  let page = 1;
  const limit = 100;
  for (;;) {
    let data;
    try {
      const res = await fetch(
        `https://api.polar.sh/v1/license-keys/?organization_id=${POLAR_ORG_ID}&status=granted&page=${page}&limit=${limit}`,
        { headers: authHeaders }
      );
      if (!res.ok) return jsonResponse({ ok: false, reason: 'license_lookup_failed' }, 502);
      data = await res.json();
    } catch {
      return jsonResponse({ ok: false, reason: 'license_lookup_failed' }, 502);
    }
    const match = (data.items || []).find((k) => k.customer_id === customerId);
    if (match) return jsonResponse({ ok: true, key: match.key });
    const maxPage = (data.pagination && data.pagination.max_page) || 1;
    if (page >= maxPage) break;
    page++;
  }
  // Checkout succeeded but Polar hasn't provisioned the license key yet (it's
  // granted via webhook shortly after payment, not synchronously) — a real,
  // expected race in the first few seconds. The client retries; this is never
  // treated as a permanent failure.
  return jsonResponse({ ok: false, reason: 'processing' });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ping') return handlePing(request, env);
    if (url.pathname === '/api/visit') return handleVisit(request, env);
    if (url.pathname === '/api/stats') return handleStats(request, env);
    if (url.pathname === '/api/checkout-license') return handleCheckoutLicense(request, env);
    // Anything else reaching this script has no matching static file
    // (real pages are served automatically without ever invoking this
    // handler) — hand it to the asset server for the site's real 404 page.
    return env.ASSETS.fetch(request);
  },
};
