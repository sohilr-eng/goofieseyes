/**
 * optimize-images.js
 * Usage: node scripts/optimize-images.js <inputPath> <outputDir>
 * Resizes to max 2400px wide, converts to WebP at quality 88.
 * For RAW files (NEF, CR2, ARW): copies to /content/raw-uploads/ and throws an error.
 */

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const RAW_EXTENSIONS = ['.nef', '.cr2', '.arw', '.dng', '.orf', '.rw2', '.raf'];

/**
 * Optimize a single image file.
 * @param {string} inputPath - Absolute path to the source image
 * @param {string} outputDir - Directory to write the optimized WebP
 * @returns {Promise<string>} - The output filename (basename only)
 */
async function optimizeImage(inputPath, outputDir) {
  const ext = path.extname(inputPath).toLowerCase();
  const baseName = path.basename(inputPath, path.extname(inputPath));

  // Handle RAW files
  if (RAW_EXTENSIONS.includes(ext)) {
    const rawUploadsDir = path.join(__dirname, '..', 'content', 'raw-uploads');
    if (!fs.existsSync(rawUploadsDir)) {
      fs.mkdirSync(rawUploadsDir, { recursive: true });
    }
    const rawDest = path.join(rawUploadsDir, path.basename(inputPath));
    fs.copyFileSync(inputPath, rawDest);
    throw new Error(
      `RAW file detected (${ext}). Copied to /content/raw-uploads/. ` +
      `RAW files require dcraw or darktable for conversion before optimization. ` +
      `Please convert to JPEG/TIFF first, then re-upload.`
    );
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputFilename = `${baseName}.webp`;
  const outputPath = path.join(outputDir, outputFilename);

  await sharp(inputPath)
    .resize({
      width: 2400,
      withoutEnlargement: true,
      fit: 'inside'
    })
    .webp({ quality: 88 })
    .toFile(outputPath);

  return outputFilename;
}

module.exports = { optimizeImage };

// CLI usage
if (require.main === module) {
  const [, , inputPath, outputDir] = process.argv;

  if (!inputPath || !outputDir) {
    console.error('Usage: node scripts/optimize-images.js <inputPath> <outputDir>');
    process.exit(1);
  }

  const absInput = path.resolve(inputPath);
  const absOutput = path.resolve(outputDir);

  optimizeImage(absInput, absOutput)
    .then((filename) => {
      console.log(`Optimized: ${filename}`);
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}
