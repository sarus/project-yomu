// Copies prebuilt audio WASM assets out of node_modules and into public/,
// which is served as-is by @fastify/static (src/main.ts). There's no
// frontend bundler in this project, so these can't be resolved via import
// specifiers at runtime the way each package's own demo does — they need to
// be plain static files the browser can fetch by URL.
//
// The output (public/vendor/**) is committed to git, not gitignored: the
// Dockerfile's runtime stage does `COPY public ./public` straight from the
// build context, not from any build-stage output, so anything generated
// only at build/install time would never reach the deployed image. Re-run
// `npm run vendor:audio` manually after bumping either package below.
const fs = require('fs');
const path = require('path');

const NODE_MODULES = path.join(__dirname, '..', 'node_modules');
const PUBLIC_VENDOR = path.join(__dirname, '..', 'public', 'vendor');

const ASSETS = [
  {
    srcDir: path.join(NODE_MODULES, '@sapphi-red', 'web-noise-suppressor', 'dist'),
    destDir: path.join(PUBLIC_VENDOR, 'gtcrn'),
    files: [
      ['index.js', 'index.js'],
      ['gtcrn.wasm', 'gtcrn.wasm'],
      [path.join('gtcrn', 'workletProcessor.js'), 'workletProcessor.js'],
    ],
  },
  {
    srcDir: path.join(NODE_MODULES, '@echogarden', 'fvad-wasm'),
    destDir: path.join(PUBLIC_VENDOR, 'fvad'),
    files: [
      ['fvad.js', 'fvad.js'],
      ['fvad.wasm', 'fvad.wasm'],
    ],
  },
];

for (const { srcDir, destDir, files } of ASSETS) {
  if (!fs.existsSync(srcDir)) {
    console.warn(`[copy-audio-assets] ${srcDir} not found — skipping (run npm install first)`);
    continue;
  }

  fs.mkdirSync(destDir, { recursive: true });

  for (const [from, to] of files) {
    fs.copyFileSync(path.join(srcDir, from), path.join(destDir, to));
    console.log(`[copy-audio-assets] copied ${from} -> ${path.relative(path.join(__dirname, '..'), path.join(destDir, to))}`);
  }
}
