// Generates src/us-blips.js — one anchor point + scatter extent per state, so
// the growth map can drop BLIPS inside each state instead of shading its
// outline.
//
// Derived from the same path data the outlines use, so the two can never drift
// apart, and precomputed for the same reason us-paths.js is: a Worker should
// not be parsing 51 path strings on every dashboard load.
//
// The anchor is the true area centroid of the state's LARGEST ring (shoelace),
// not the average of its vertices and not the bounding-box centre. Both of
// those land outside the shape for states with long coastlines or a detached
// peninsula — vertex-averaging drags the point toward whichever coast has the
// most detail, and a bbox centre for Florida or Michigan sits in open water.
//
//   node scripts/generate-blip-anchors.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'us-paths.js'), 'utf8');
const json = src.slice(src.indexOf('export default') + 'export default'.length).trim().replace(/;\s*$/, '');
const PATHS = JSON.parse(json);

// Split "M… L… Z M… Z" into rings of [x,y] points. The data only uses absolute
// M/L/Z, so this needs no curve handling.
function rings(d) {
  const out = [];
  for (const chunk of d.split(/(?=M)/)) {
    const nums = chunk.match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 6) continue;
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([Number(nums[i]), Number(nums[i + 1])]);
    if (pts.length >= 3) out.push(pts);
  }
  return out;
}

// Shoelace area + area-weighted centroid of one ring.
function ringStats(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  a *= 0.5;
  if (!a) return null;
  return { area: Math.abs(a), cx: cx / (6 * a), cy: cy / (6 * a) };
}

const out = {};
for (const [ab, d] of Object.entries(PATHS)) {
  const rs = rings(d).map((pts) => ({ pts, s: ringStats(pts) })).filter((r) => r.s);
  if (!rs.length) continue;
  rs.sort((p, q) => q.s.area - p.s.area);
  const main = rs[0];
  const xs = main.pts.map((p) => p[0]);
  const ys = main.pts.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  // Scatter extent: a conservative fraction of the state's own size, so blips
  // stay visually inside even where the shape is concave. Clamped so tiny
  // states (RI, DE, DC) still get a usable spread and huge ones don't sprawl.
  const rx = Math.max(3, Math.min(26, w * 0.26));
  const ry = Math.max(3, Math.min(20, h * 0.26));
  out[ab] = [
    Number(main.s.cx.toFixed(1)),
    Number(main.s.cy.toFixed(1)),
    Number(rx.toFixed(1)),
    Number(ry.toFixed(1)),
  ];
}

const header = `// GENERATED — do not edit by hand. Run scripts/generate-blip-anchors.mjs.
//
// [centreX, centreY, scatterX, scatterY] per state, in the same 960x600
// coordinate space as us-paths.js. The centre is the area centroid of the
// state's largest ring, so it sits inside the shape rather than in the water
// (which a bounding-box centre does for Florida and Michigan).
`;
fs.writeFileSync(
  path.join(here, '..', 'src', 'us-blips.js'),
  header + 'export default ' + JSON.stringify(out) + ';\n'
);
console.log('wrote src/us-blips.js for', Object.keys(out).length, 'states');
