/**
 * Batch reprocess all existing photos in /content/photos/
 * Compresses to max 1200px wide, WebP quality 70.
 * Skips files already ≤1200px wide AND under 300KB.
 *
 * Usage: node admin/reprocess-photos.js
 */

const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');

const PHOTOS_DIR     = path.join(__dirname, '..', 'content', 'photos');
const MAX_WIDTH      = 1200;
const QUALITY        = 70;
const SKIP_SIZE_KB   = 300;

async function reprocess() {
  if (!fs.existsSync(PHOTOS_DIR)) {
    console.error(`[reprocess] Photos directory not found: ${PHOTOS_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(PHOTOS_DIR).filter(f => f.toLowerCase().endsWith('.webp'));

  if (files.length === 0) {
    console.log('[reprocess] No .webp files found — nothing to do.');
    return;
  }

  console.log(`[reprocess] Found ${files.length} .webp file(s) in ${PHOTOS_DIR}\n`);

  let processed = 0;
  let skipped   = 0;
  let totalSavedBytes = 0;

  for (const file of files) {
    const filePath = path.join(PHOTOS_DIR, file);

    try {
      const statBefore = fs.statSync(filePath);
      const sizeBeforeBytes = statBefore.size;

      // Check dimensions before deciding whether to skip
      const meta = await sharp(filePath).metadata();
      const width = meta.width || 0;

      if (width <= MAX_WIDTH && sizeBeforeBytes < SKIP_SIZE_KB * 1024) {
        console.log(`[reprocess] Skip: ${file} (${width}px, ${(sizeBeforeBytes / 1024).toFixed(0)}KB — already small)`);
        skipped++;
        continue;
      }

      // Write to a temp file first so the original is safe if sharp throws
      const tempPath = filePath + '.tmp';
      await sharp(filePath)
        .resize({ width: MAX_WIDTH, withoutEnlargement: true, fit: 'inside' })
        .webp({ quality: QUALITY })
        .toFile(tempPath);

      const statAfter = fs.statSync(tempPath);
      const sizeAfterBytes = statAfter.size;

      // Only replace if the result is actually smaller (safety check)
      if (sizeAfterBytes >= sizeBeforeBytes) {
        fs.unlinkSync(tempPath);
        console.log(`[reprocess] Skip: ${file} — reprocessed version was not smaller, keeping original`);
        skipped++;
        continue;
      }

      fs.renameSync(tempPath, filePath);

      const savedBytes = sizeBeforeBytes - sizeAfterBytes;
      totalSavedBytes += savedBytes;
      processed++;

      const wasMB  = (sizeBeforeBytes / (1024 * 1024)).toFixed(2) + 'MB';
      const nowKB  = (sizeAfterBytes  / 1024).toFixed(0) + 'KB';
      console.log(`[reprocess] Done: ${file} (was ${wasMB} → now ${nowKB})`);

    } catch (err) {
      // Clean up temp file if it was left behind
      const tempPath = filePath + '.tmp';
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
      }
      console.error(`[reprocess] Error: ${file} — ${err.message}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────');
  console.log(`[reprocess] Processed : ${processed}`);
  console.log(`[reprocess] Skipped   : ${skipped}`);
  if (totalSavedBytes > 0) {
    const savedMB = (totalSavedBytes / (1024 * 1024)).toFixed(2);
    console.log(`[reprocess] Space saved: ${savedMB}MB`);
  }
  console.log('─────────────────────────────────────');
}

reprocess();
