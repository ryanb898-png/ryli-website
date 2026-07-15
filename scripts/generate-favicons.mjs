// One-time/rerunnable favicon generator. Not part of the deployed site —
// its output (assets/favicon/*) is committed as plain static files.
// Run: npm run favicons
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'assets/images/ryliring.png');
const OUT = path.join(ROOT, 'assets/favicon');
const THEME_COLOR = '#0D1117'; // Slate

mkdirSync(OUT, { recursive: true });

const sizes = [
  { file: 'favicon-16x16.png', size: 16 },
  { file: 'favicon-32x32.png', size: 32 },
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'android-chrome-192x192.png', size: 192 },
  { file: 'android-chrome-512x512.png', size: 512 },
];

async function main() {
  for (const { file, size } of sizes) {
    await sharp(SOURCE)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(OUT, file));
    console.log('wrote', file);
  }

  // favicon.ico bundles 16/32/48 for legacy taskbar/browser-tab use
  const icoSizes = [16, 32, 48];
  const icoBuffers = await Promise.all(
    icoSizes.map((size) =>
      sharp(SOURCE)
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer(),
    ),
  );
  const ico = await pngToIco(icoBuffers);
  writeFileSync(path.join(OUT, 'favicon.ico'), ico);
  console.log('wrote favicon.ico');

  const manifest = {
    name: 'RYLI',
    short_name: 'RYLI',
    icons: [
      { src: '/assets/favicon/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/assets/favicon/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    theme_color: THEME_COLOR,
    background_color: THEME_COLOR,
    display: 'standalone',
  };
  writeFileSync(path.join(OUT, 'site.webmanifest'), JSON.stringify(manifest, null, 2));
  console.log('wrote site.webmanifest');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
