/**
 * make-discs.js — square crops for the crate's circular record covers.
 *
 * Usage: node scripts/make-discs.js [--force]
 *
 * The design files every collection as a vinyl record: a circle. Portfolio
 * covers are whatever aspect the camera shot — mostly 2:3 portraits here — and
 * `object-fit: cover` on a circle keeps only a middle horizontal band of those,
 * which decapitates the subject. This pre-crops each cover to a square so the
 * circle is showing a frame that was composed for it.
 *
 * Crop rules:
 *   portrait  — square pulled from the UPPER part of the frame, not the middle.
 *               Subjects sit above centre far more often than below, so a centre
 *               crop of a portrait is the one that loses heads.
 *   landscape — centred. Horizons and subjects sit mid-frame.
 *
 * Output is 800x800 WebP in content/discs/, named after the source file. The
 * crate renders at most 320px, so 800 covers 2x displays with room to spare —
 * and replaces a 1200x1800 download with roughly a tenth of the bytes.
 *
 * Re-runnable: skips a disc that is already newer than its source unless
 * --force. Re-run after changing a collection's cover in the admin portal.
 *
 * Uses ffmpeg rather than sharp: sharp is an optional dependency of the admin
 * tooling and is not installed in every checkout, but ffmpeg is already a hard
 * requirement for the hero film.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PHOTOS = path.join(ROOT, 'content', 'photos');
const DISCS = path.join(ROOT, 'content', 'discs');
const PORTFOLIOS = path.join(ROOT, 'content', 'data', 'portfolios.json');

const SIZE = 800;
const QUALITY = 82;

/* How far down a portrait frame the crop window starts, as a fraction of the
 * leftover height. 0 = flush top, 0.5 = centred. 0.22 keeps the head room a
 * portrait is usually composed with while still cutting most of the feet. */
const PORTRAIT_BIAS = 0.22;

function probe(file) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
     '-of', 'csv=s=x:p=0', file],
    { encoding: 'utf8' }
  ).trim();
  const [width, height] = out.split('x').map(Number);
  if (!width || !height) throw new Error(`could not read dimensions from ${file}`);
  return { width, height };
}

/** The square crop window for a frame of the given size. */
function cropWindow(width, height) {
  const side = Math.min(width, height);
  if (height > width) {
    return { side, x: 0, y: Math.round((height - side) * PORTRAIT_BIAS) };
  }
  return { side, x: Math.round((width - side) / 2), y: 0 };
}

function makeDisc(sourceFile) {
  const source = path.join(PHOTOS, sourceFile);
  const target = path.join(DISCS, sourceFile);

  if (!fs.existsSync(source)) return { file: sourceFile, status: 'missing source' };

  if (!process.argv.includes('--force') && fs.existsSync(target)) {
    if (fs.statSync(target).mtimeMs >= fs.statSync(source).mtimeMs) {
      return { file: sourceFile, status: 'up to date' };
    }
  }

  const { width, height } = probe(source);
  const { side, x, y } = cropWindow(width, height);

  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', source,
    '-vf', `crop=${side}:${side}:${x}:${y},scale=${SIZE}:${SIZE}:flags=lanczos`,
    '-c:v', 'libwebp', '-quality', String(QUALITY),
    target
  ]);

  const before = fs.statSync(source).size;
  const after = fs.statSync(target).size;
  return {
    file: sourceFile,
    status: `${width}x${height} -> ${SIZE}x${SIZE}` +
            ` (${(before / 1024).toFixed(0)}kB -> ${(after / 1024).toFixed(0)}kB)`
  };
}

function main() {
  if (!fs.existsSync(DISCS)) fs.mkdirSync(DISCS, { recursive: true });

  const { portfolios } = JSON.parse(fs.readFileSync(PORTFOLIOS, 'utf8'));

  /* Mirrors the cover resolution in assets/site.js: an explicit cover, else the
   * first photograph by display order. */
  const covers = portfolios
    .map((p) => {
      const photos = (p.photos || [])
        .slice()
        .sort((a, b) => (a.order == null ? 999 : a.order) - (b.order == null ? 999 : b.order));
      return { slug: p.slug, cover: p.cover || (photos[0] && photos[0].filename) || null };
    })
    .filter((entry) => entry.cover);

  for (const { slug, cover } of covers) {
    const result = makeDisc(cover);
    console.log(`${slug.padEnd(28)} ${result.file.padEnd(32)} ${result.status}`);
  }
}

main();
