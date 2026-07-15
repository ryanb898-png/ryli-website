// One-off asset-prep script — flood-fills the near-black background
// surrounding the phone (starting from the image border) into a real
// alpha channel, WITHOUT touching dark pixels inside the phone's screen
// (which aren't connected to the outer edge). Not part of the deployed site.
import sharp from 'sharp';

const SRC = 'C:/Users/ryanb/OneDrive/Desktop/RYLI/streamiphone.png';
const OUT = 'C:/Users/ryanb/OneDrive/Desktop/ryli-website/assets/images/hero-phone.png';
const THRESHOLD = 12; // max channel value still considered "background black"

const img = sharp(SRC);
const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;

const isBackground = (idx) => {
  const r = data[idx], g = data[idx + 1], b = data[idx + 2];
  return r <= THRESHOLD && g <= THRESHOLD && b <= THRESHOLD;
};

const alpha = new Uint8Array(width * height).fill(255); // start fully opaque
const visited = new Uint8Array(width * height);
const stack = [];

// Seed the flood fill from every border pixel that is background-colored.
for (let x = 0; x < width; x++) {
  stack.push(x, 0);            // top row
  stack.push(x, height - 1);   // bottom row
}
for (let y = 0; y < height; y++) {
  stack.push(0, y);            // left col
  stack.push(width - 1, y);    // right col
}

while (stack.length) {
  const y = stack.pop();
  const x = stack.pop();
  if (x < 0 || x >= width || y < 0 || y >= height) continue;
  const p = y * width + x;
  if (visited[p]) continue;
  visited[p] = 1;
  const idx = p * channels;
  if (!isBackground(idx)) continue;
  alpha[p] = 0; // mark transparent
  stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
}

const alphaBuf = Buffer.from(alpha);

await sharp(data, { raw: { width, height, channels } })
  .joinChannel(alphaBuf, { raw: { width, height, channels: 1 } })
  .png()
  .toFile(OUT);

const removedCount = alpha.filter((a) => a === 0).length;
console.log(`done. ${removedCount} / ${width * height} pixels made transparent (${(100 * removedCount / (width * height)).toFixed(1)}%)`);
