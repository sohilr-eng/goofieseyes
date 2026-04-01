/**
 * GoofiesEyes Admin Portal - Express Server
 * Run via: npm run admin (from repo root) or node admin/server.js
 * Listens on http://localhost:3000
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const matter = require('gray-matter');

// ─── Paths ────────────────────────────────────────────────────────────────────
const repoRoot = path.join(__dirname, '..');
const CONTENT_DIR = path.join(repoRoot, 'content');
const PHOTOS_DIR = path.join(CONTENT_DIR, 'photos');
const RAW_UPLOADS_DIR = path.join(CONTENT_DIR, 'raw-uploads');
const POSTS_DIR = path.join(CONTENT_DIR, 'posts');
const DATA_DIR = path.join(CONTENT_DIR, 'data');
const PORTFOLIOS_FILE = path.join(DATA_DIR, 'portfolios.json');
const PRINTS_FILE = path.join(DATA_DIR, 'prints.json');

// ─── Ensure directories exist ─────────────────────────────────────────────────
[PHOTOS_DIR, RAW_UPLOADS_DIR, POSTS_DIR, DATA_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Ensure data files exist ──────────────────────────────────────────────────
if (!fs.existsSync(PORTFOLIOS_FILE)) {
  fs.writeFileSync(PORTFOLIOS_FILE, JSON.stringify({ portfolios: [] }, null, 2));
}
if (!fs.existsSync(PRINTS_FILE)) {
  fs.writeFileSync(PRINTS_FILE, JSON.stringify({ prints: [] }, null, 2));
}

// ─── App setup ────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve admin UI
app.use(express.static(path.join(__dirname, 'public')));

// Serve content files (photos, etc.) so admin pages can load thumbnails
app.use('/content', express.static(CONTENT_DIR));

// ─── Multer (file uploads to temp dir) ───────────────────────────────────────
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, RAW_UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${file.originalname}`;
    cb(null, unique);
  }
});
const upload = multer({ storage: uploadStorage });

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseFrontmatter(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = matter(raw);
    return { data: parsed.data, content: parsed.content };
  } catch {
    return null;
  }
}

// ─── API: Photos ──────────────────────────────────────────────────────────────

// POST /api/upload — receive image, optimize with Sharp, save to /content/photos/
app.post('/api/upload', upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const { title, portfolio, tags, alt, printAvailable, printPrice } = req.body;
  const tempPath = req.file.path;

  try {
    const sharp = require('sharp');
    const ext = path.extname(req.file.originalname).toLowerCase();
    const RAW_EXTENSIONS = ['.nef', '.cr2', '.arw', '.dng', '.orf', '.rw2', '.raf'];

    if (RAW_EXTENSIONS.includes(ext)) {
      return res.status(400).json({
        error: `RAW file detected (${ext}). Please convert to JPEG/PNG first, then re-upload.`
      });
    }

    const baseName = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const safeBase = slugify(baseName) || `photo-${Date.now()}`;
    const outputFilename = `${safeBase}.webp`;
    const outputPath = path.join(PHOTOS_DIR, outputFilename);

    // If file already exists, add timestamp suffix
    let finalFilename = outputFilename;
    let finalPath = outputPath;
    if (fs.existsSync(outputPath)) {
      finalFilename = `${safeBase}-${Date.now()}.webp`;
      finalPath = path.join(PHOTOS_DIR, finalFilename);
    }

    await sharp(tempPath)
      .resize({ width: 2400, withoutEnlargement: true, fit: 'inside' })
      .webp({ quality: 88 })
      .toFile(finalPath);

    // Clean up temp file
    fs.unlinkSync(tempPath);

    // Build photo metadata object
    const photoMeta = {
      filename: finalFilename,
      title: title || baseName,
      tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      alt: alt || title || baseName,
      printAvailable: printAvailable === 'true' || printAvailable === true,
      printPrice: printPrice ? parseFloat(printPrice) : 0,
      order: 999,
      uploadedAt: new Date().toISOString()
    };

    // Add to portfolio if specified
    if (portfolio) {
      const data = readJSON(PORTFOLIOS_FILE) || { portfolios: [] };
      const port = data.portfolios.find((p) => p.id === portfolio || p.slug === portfolio);
      if (port) {
        port.photos = port.photos || [];
        photoMeta.order = port.photos.length + 1;
        port.photos.push(photoMeta);
        writeJSON(PORTFOLIOS_FILE, data);
      }
    }

    console.log(`[upload] Saved: ${finalFilename}`);
    res.json({ success: true, filename: finalFilename, photo: photoMeta });
  } catch (err) {
    // Clean up temp file on error
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    console.error('[upload] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/photos — all photos from all portfolios (deduplicated) + orphan files
app.get('/api/photos', (req, res) => {
  try {
    const data = readJSON(PORTFOLIOS_FILE) || { portfolios: [] };
    const seen = new Set();
    const photos = [];

    for (const port of data.portfolios) {
      for (const photo of port.photos || []) {
        if (!seen.has(photo.filename)) {
          seen.add(photo.filename);
          photos.push({ ...photo, portfolioId: port.id, portfolioName: port.name });
        }
      }
    }

    // Include photos on disk that aren't in any portfolio
    if (fs.existsSync(PHOTOS_DIR)) {
      const files = fs.readdirSync(PHOTOS_DIR).filter((f) => f.endsWith('.webp'));
      for (const file of files) {
        if (!seen.has(file)) {
          photos.push({
            filename: file,
            title: file.replace('.webp', ''),
            tags: [],
            alt: file.replace('.webp', ''),
            printAvailable: false,
            printPrice: 0,
            order: 999,
            portfolioId: null,
            portfolioName: null
          });
        }
      }
    }

    res.json({ photos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Portfolios ──────────────────────────────────────────────────────────

app.get('/api/portfolios', (req, res) => {
  const data = readJSON(PORTFOLIOS_FILE) || { portfolios: [] };
  res.json(data);
});

app.post('/api/portfolios', (req, res) => {
  try {
    writeJSON(PORTFOLIOS_FILE, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Posts ───────────────────────────────────────────────────────────────

app.get('/api/posts', (req, res) => {
  try {
    if (!fs.existsSync(POSTS_DIR)) return res.json({ posts: [] });

    const files = fs.readdirSync(POSTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse();

    const posts = files.map((file) => {
      const filePath = path.join(POSTS_DIR, file);
      const parsed = parseFrontmatter(filePath);
      if (!parsed) return null;
      return {
        filename: file,
        slug: parsed.data.slug || file.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace('.md', ''),
        title: parsed.data.title || 'Untitled',
        date: parsed.data.date || '',
        status: parsed.data.status || 'draft',
        tags: parsed.data.tags || [],
        coverImage: parsed.data.coverImage || null
      };
    }).filter(Boolean);

    res.json({ posts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/posts/:slug', (req, res) => {
  try {
    const { slug } = req.params;
    if (!fs.existsSync(POSTS_DIR)) return res.status(404).json({ error: 'Posts dir not found' });

    const files = fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md'));
    const match = files.find((f) => {
      const parsed = parseFrontmatter(path.join(POSTS_DIR, f));
      if (!parsed) return false;
      const fileSlug = parsed.data.slug || f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace('.md', '');
      return fileSlug === slug || f.replace('.md', '') === slug;
    });

    if (!match) return res.status(404).json({ error: 'Post not found' });

    const parsed = parseFrontmatter(path.join(POSTS_DIR, match));
    res.json({ filename: match, frontmatter: parsed.data, body: parsed.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts', (req, res) => {
  try {
    const { title, slug, date, status, tags, coverImage, body } = req.body;

    if (!title) return res.status(400).json({ error: 'Title is required' });

    const postSlug = slug || slugify(title);
    const postDate = date || new Date().toISOString().split('T')[0];
    const filename = `${postDate}-${postSlug}.md`;
    const filePath = path.join(POSTS_DIR, filename);

    const frontmatter = {
      title,
      slug: postSlug,
      date: postDate,
      status: status || 'draft',
      tags: Array.isArray(tags) ? tags : (tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : []),
      coverImage: coverImage || ''
    };

    const fileContent = matter.stringify(body || '', frontmatter);
    fs.writeFileSync(filePath, fileContent, 'utf8');

    console.log(`[posts] Saved: ${filename}`);
    res.json({ success: true, filename, slug: postSlug });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Prints ──────────────────────────────────────────────────────────────

app.get('/api/prints', (req, res) => {
  const data = readJSON(PRINTS_FILE) || { prints: [] };
  res.json(data);
});

app.post('/api/prints', (req, res) => {
  try {
    writeJSON(PRINTS_FILE, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/posts/:slug — update existing post
app.put('/api/posts/:slug', (req, res) => {
  try {
    const { slug } = req.params;
    const { title, newSlug, date, status, tags, coverImage, body } = req.body;

    if (!fs.existsSync(POSTS_DIR)) return res.status(404).json({ error: 'Posts dir not found' });

    const files = fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md'));
    const match = files.find((f) => {
      const parsed = parseFrontmatter(path.join(POSTS_DIR, f));
      if (!parsed) return false;
      const fileSlug = parsed.data.slug || f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace('.md', '');
      return fileSlug === slug || f.replace('.md', '') === slug;
    });

    if (!match) return res.status(404).json({ error: 'Post not found' });

    const oldPath = path.join(POSTS_DIR, match);
    const postSlug = newSlug || slug;
    const postDate = date || (match.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || new Date().toISOString().split('T')[0];
    const newFilename = `${postDate}-${postSlug}.md`;
    const newPath = path.join(POSTS_DIR, newFilename);

    const frontmatter = {
      title: title || 'Untitled',
      slug: postSlug,
      date: postDate,
      status: status || 'draft',
      tags: Array.isArray(tags) ? tags : (tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : []),
      coverImage: coverImage || ''
    };

    const fileContent = matter.stringify(body || '', frontmatter);
    if (newPath !== oldPath && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    fs.writeFileSync(newPath, fileContent, 'utf8');

    console.log(`[posts] Updated: ${newFilename}`);
    res.json({ success: true, filename: newFilename, slug: postSlug });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/posts/:slug — delete a post
app.delete('/api/posts/:slug', (req, res) => {
  try {
    const { slug } = req.params;
    if (!fs.existsSync(POSTS_DIR)) return res.status(404).json({ error: 'Post not found' });

    const files = fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md'));
    const match = files.find((f) => {
      const parsed = parseFrontmatter(path.join(POSTS_DIR, f));
      if (!parsed) return false;
      const fileSlug = parsed.data.slug || f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace('.md', '');
      return fileSlug === slug || f.replace('.md', '') === slug;
    });

    if (!match) return res.status(404).json({ error: 'Post not found' });

    fs.unlinkSync(path.join(POSTS_DIR, match));
    console.log(`[posts] Deleted: ${match}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/photos/:filename — delete a photo from disk and all portfolios
app.delete('/api/photos/:filename', (req, res) => {
  try {
    const safe = path.basename(req.params.filename);
    const photoPath = path.join(PHOTOS_DIR, safe);

    if (!fs.existsSync(photoPath)) return res.status(404).json({ error: 'Photo not found' });

    fs.unlinkSync(photoPath);

    // Remove from all portfolios
    const data = readJSON(PORTFOLIOS_FILE) || { portfolios: [] };
    for (const port of data.portfolios) {
      port.photos = (port.photos || []).filter((p) => p.filename !== safe);
    }
    writeJSON(PORTFOLIOS_FILE, data);

    console.log(`[photos] Deleted: ${safe}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Git ─────────────────────────────────────────────────────────────────

app.get('/api/git-status', (req, res) => {
  const proc = spawn('git', ['status', '--short'], { cwd: repoRoot, shell: true });
  let output = '';
  let errOutput = '';

  proc.stdout.on('data', (d) => { output += d.toString(); });
  proc.stderr.on('data', (d) => { errOutput += d.toString(); });

  proc.on('close', (code) => {
    if (code !== 0 && errOutput) {
      return res.json({ status: `Error: ${errOutput}`, hasChanges: false });
    }
    res.json({ status: output || 'Working tree clean', hasChanges: output.trim().length > 0 });
  });

  proc.on('error', (err) => {
    res.json({ status: `Git not available: ${err.message}`, hasChanges: false });
  });
});

app.post('/api/publish', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const timestamp = new Date().toISOString();
  const commitMessage = `content update [${timestamp}]`;
  const send = (msg) => {
    console.log(msg);
    res.write(msg + '\n');
  };

  send(`[publish] Starting at ${timestamp}`);

  const runStep = (label, args) => {
    return new Promise((resolve, reject) => {
      send(`\n[publish] Running: git ${args.join(' ')}`);
      const proc = spawn('git', args, { cwd: repoRoot, shell: true });

      proc.stdout.on('data', (d) => { const t = d.toString(); send(t.trim()); });
      proc.stderr.on('data', (d) => { const t = d.toString(); send(t.trim()); });

      proc.on('close', (code) => {
        if (code === 0 || (args[0] === 'commit' && code === 1)) {
          // git commit exits 1 when nothing to commit — treat as ok
          resolve(code);
        } else {
          reject(new Error(`git ${args[0]} failed with exit code ${code}`));
        }
      });

      proc.on('error', (err) => reject(err));
    });
  };

  (async () => {
    try {
      await runStep('add', ['add', '.']);
      const commitCode = await runStep('commit', ['commit', '-m', commitMessage]).catch((err) => {
        // Check if it's "nothing to commit" — still ok
        if (err.message.includes('exit code 1')) return 1;
        throw err;
      });

      if (commitCode === 1) {
        send('\n[publish] Nothing new to commit.');
      }

      await runStep('push', ['push', 'origin', 'master']);
      send('\n✅ SUCCESS — site published and live!');
      res.end();
    } catch (err) {
      send(`\n❌ FAILED: ${err.message}`);
      send('\nCheck the output above for the specific git error.');
      res.end();
    }
  })();
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\nGoofiesEyes Admin Portal running at http://localhost:${PORT}`);
  console.log(`Repo root: ${repoRoot}\n`);

  // Auto-open browser on Windows
  try {
    setTimeout(() => {
      const { exec } = require('child_process');
      exec('start http://localhost:3000');
    }, 1000);
  } catch (e) {
    // ignore
  }
});
