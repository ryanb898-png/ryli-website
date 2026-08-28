/**
 * SITE INTEGRITY CHECK — run before every deploy.
 *
 *   node scripts/check-site.mjs
 *
 * Three things have gone wrong on this site that nothing could see:
 *
 * 1. THE FAQ EXISTS TWICE. Once as visible <details>, once mirrored into a
 *    JSON-LD FAQPage that Google reads and can surface as a rich result. They
 *    drifted, and the structured data kept serving "Is RYLI Whatnot-only?
 *    Today, yes" long after the page stopped saying it. A rich result is
 *    cached for weeks; you cannot take it back.
 *
 * 2. ORPHAN IMAGES ACCUMULATED SILENTLY. 21MB of files referenced by nothing,
 *    uploaded to Cloudflare on every deploy and publicly reachable at
 *    guessable URLs.
 *
 * 3. A REFERENCED FILE THAT DOES NOT EXIST is invisible until someone looks at
 *    the page. Cloudflare's edge caches a 404 and the token here cannot purge.
 *
 * Exits non-zero on any of them.
 */
import fs from 'fs';
import path from 'path';

// Only ./public is served, so only ./public is checked. See wrangler.jsonc.
const ROOT = path.join(import.meta.dirname, '..', 'public');
const PAGES = ['index.html', 'engagement.html', 'breaker-tools.html', 'pricing.html', 'system-requirements.html', 'changelog.html', 'setup-guide.html',
  'privacy.html', 'terms.html', 'thank-you.html'];

let fails = 0;
const ok = (n, cond, detail) => {
  if (cond) console.log('  PASS ' + n);
  else { fails++; console.log('  FAIL ' + n + (detail === undefined ? '' : '  ' + detail)); }
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---- 1. the FAQ, both copies -------------------------------------------
console.log('\n  THE FAQ EXISTS TWICE');
{
  const html = read('index.html');

  const visible = [...html.matchAll(
    /<summary>([\s\S]*?)<\/summary>\s*<div class="faq-body">([\s\S]*?)<\/div>/g)]
    .map((m) => ({ q: m[1], a: m[2] }));

  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  let faq = null;
  for (const b of blocks) {
    let parsed;
    try { parsed = JSON.parse(b[1]); } catch { continue; }
    if (parsed && parsed['@type'] === 'FAQPage') faq = parsed;
  }
  ok('every JSON-LD block parses',
    blocks.every((b) => { try { JSON.parse(b[1]); return true; } catch { return false; } }));
  ok('a FAQPage block exists', !!faq);

  if (faq) {
    const structured = faq.mainEntity.map((q) => ({ q: q.name, a: q.acceptedAnswer.text }));
    ok('the two FAQs have the same number of questions',
      visible.length === structured.length,
      'visible=' + visible.length + ' structured=' + structured.length);

    // Compare on TEXT, not markup: the visible copy carries tags and entities
    // the JSON copy cannot. Anything that survives both is what a reader and a
    // crawler actually see.
    const flat = (t) => t
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&amp;/g, '&')
      .replace(/&rsquo;|&#39;/g, '’').replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
      .replace(/\s+/g, ' ').trim();

    const drift = [];
    const n = Math.min(visible.length, structured.length);
    for (let i = 0; i < n; i++) {
      if (flat(visible[i].q) !== flat(structured[i].q)) drift.push('Q' + (i + 1) + ' question');
      if (flat(visible[i].a) !== flat(structured[i].a)) drift.push('Q' + (i + 1) + ' answer: ' + flat(visible[i].q));
    }
    ok('every question and answer matches its structured-data twin',
      drift.length === 0, drift.join(' | '));
  }
}

// ---- 2. images: nothing orphaned, nothing missing -----------------------
console.log('\n  IMAGES');
{
  const dir = path.join(ROOT, 'assets', 'images');
  const files = fs.readdirSync(dir);
  const sources = [...PAGES, 'styles.css', 'script.js']
    .filter((f) => fs.existsSync(path.join(ROOT, f)))
    .map(read).join('\n');

  // Superseded files are kept for exactly one deploy so cached HTML pointing at
  // the old name does not 404. List them here and delete them next time.
  const GRACE = new Set([
    'og-cover.png', 'screenshot-themes-v2.png', 'screenshot-insights-v2.png', 'ryliring.png',
    // Superseded by real overlay footage in assets/video (shoot-overlay.js).
    // These were phone screenshots of the OLD overlay -- July pixels, from
    // before frame-v3 and Broadcast Glass shipped. DELETE NEXT DEPLOY.
    'carousel-1-lotwon-v3.png', 'carousel-2-livecamera-v3.png',
    'carousel-3-recentwins-v3.png', 'carousel-4-taphearts-v3.png', 'hero-phone.png',
    // The board illustration, replaced by real footage of the board filling.
    'breaker-board-v4.png',
    // Hero portrait, now served as WebP at a quarter the size.
    'hero-ryli-live.png',
    // Superseded by the OBS-badge version; eBay Live is not supported.
    'hero-ryli-live-v2.webp',
    // Superseded by a current, seeded capture of the real store grid.
    'store-screenshot-v3.png',
  ]);

  const orphans = files.filter((f) => !sources.includes(f) && !GRACE.has(f));
  const mb = orphans.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0) / 1048576;
  ok('no orphaned images', orphans.length === 0,
    orphans.length ? mb.toFixed(1) + 'MB: ' + orphans.join(', ') : '');

  const referenced = new Set();
  for (const m of sources.matchAll(/assets\/images\/([A-Za-z0-9._-]+)/g)) referenced.add(m[1]);
  const missing = [...referenced].filter((f) => !fs.existsSync(path.join(dir, f)));
  ok('every referenced image exists', missing.length === 0, missing.join(', '));
}

// ---- 2b. video: the same two checks, for assets/video -------------------
// A missing clip is exactly as invisible as a missing image was, and the edge
// caches a 404 that the API token available here cannot purge.
console.log('\n  VIDEO');
{
  const dir = path.join(ROOT, 'assets', 'video');
  if (!fs.existsSync(dir)) {
    ok('assets/video exists', false, 'directory missing');
  } else {
    const files = fs.readdirSync(dir);
    const sources = [...PAGES, 'styles.css', 'script.js']
      .filter((f) => fs.existsSync(path.join(ROOT, f)))
      .map(read).join('\n');

    const orphans = files.filter((f) => !sources.includes(f));
    const mb = orphans.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0) / 1048576;
    ok('no orphaned video', orphans.length === 0,
      orphans.length ? mb.toFixed(1) + 'MB: ' + orphans.join(', ') : '');

    const referenced = new Set();
    for (const m of sources.matchAll(/assets\/video\/([A-Za-z0-9._-]+)/g)) referenced.add(m[1]);
    const missing = [...referenced].filter((f) => !fs.existsSync(path.join(dir, f)));
    ok('every referenced clip exists', missing.length === 0, missing.join(', '));

    // The webm is the real asset -- it carries the alpha the capture pipeline
    // exists to produce. h264 cannot, so the mp4 is there precisely for the
    // browsers that will not play the webm. Shipping one without the other is
    // a silently blank slide for somebody.
    const html = read('index.html');
    const webms = [...html.matchAll(/assets\/video\/(overlay-[a-z]+-v\d+)\.webm/g)].map((m) => m[1]);
    const unpaired = webms.filter((b) => !html.includes(b + '.mp4'));
    ok('every webm has an mp4 fallback', unpaired.length === 0, unpaired.join(', '));

    // Without a poster the slide is empty until the clip decodes its first
    // frame, which on a cold load is a visible hole where the product should be.
    const noPoster = [...html.matchAll(/<video[^>]*>/g)].filter((m) => !m[0].includes('poster=')).length;
    ok('every video has a poster', noPoster === 0, noPoster + ' without');
  }
}

// ---- 3. claims that went stale before ----------------------------------
console.log('\n  STALE CLAIMS');
{
  const all = PAGES.map((f) => [f, read(f)]);
  const banned = [
    [/Whatnot-only\?\s*<\/summary>[\s\S]{0,60}Today, yes/i, 'the old Whatnot-only FAQ answer'],
    [/for Whatnot live sellers/i, 'seller-only audience in metadata'],
    [/"softwareVersion":\s*"1\.0\.4[0-5]"/, 'a stale version in structured data'],
  ];
  for (const [re, what] of banned) {
    const hit = all.filter(([, h]) => re.test(h)).map(([f]) => f);
    ok('no ' + what, hit.length === 0, hit.join(', '));
  }
  // The struck-through price is real; the structured-data one must match the
  // price actually charged.
  const idx = read('index.html');
  const hp = (idx.match(/"highPrice":\s*"([\d.]+)"/) || [])[1];
  const shown = (idx.match(/class="strike">\$[\d.]+<\/span>\$([\d.]+)/) || [])[1];
  ok('structured-data price matches the price on the page',
    hp && shown && hp === shown, 'highPrice=' + hp + ' shown=' + shown);
}

console.log('');
console.log(fails ? '  FAILURES: ' + fails : '  ALL PASS');
process.exit(fails ? 1 : 0);
