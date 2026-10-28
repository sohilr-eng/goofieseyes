/**
 * `npm run dev` — the studio on http://localhost:3100 without Vercel.
 *
 * Serves public/, routes /api/<name> to api/<name>.js exactly as Vercel would,
 * keeps posts in memory, and runs scheduled posts with setTimeout instead of
 * QStash. Uploads go to an in-memory /api/dev-upload rather than Blob.
 *
 * Password is `dev` unless STUDIO_PASSWORD is set. With STUDIO_FAKE_META=1,
 * Facebook/Instagram/Threads are simulated (test/fake-meta.js), so nothing
 * real is ever posted; without it, real tokens in the environment are used.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.STUDIO_DEV = '1';
process.env.STUDIO_PASSWORD = process.env.STUDIO_PASSWORD || 'dev';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (process.env.STUDIO_FAKE_META) {
  process.env.META_SYSTEM_USER_TOKEN = process.env.META_SYSTEM_USER_TOKEN || 'fake';
  process.env.THREADS_ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN || 'fake';
  require('./test/fake-meta').installFakeMeta();
}

const PORT = Number(process.env.PORT) || 3100;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const uploads = new Map();

const { setDevRunner } = require('./lib/queue');
const { runPost } = require('./lib/posts');
setDevRunner((message) => runPost(message).then(
  (r) => console.log('[worker]', message.postId, r),
  (err) => console.error('[worker]', message.postId, err),
));

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/dev-upload' && req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const name = `${crypto.randomBytes(4).toString('hex')}-${path.basename(url.searchParams.get('name') || 'media')}`;
    uploads.set(name, { type: req.headers['content-type'], data: Buffer.concat(chunks) });
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ url: `http://localhost:${PORT}/dev-media/${name}`, pathname: `media/${name}` }));
  }
  if (url.pathname.startsWith('/dev-media/')) {
    const file = uploads.get(url.pathname.slice('/dev-media/'.length));
    if (!file) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', file.type);
    return res.end(file.data);
  }

  const api = url.pathname.match(/^\/api\/([a-z-]+)$/);
  if (api) {
    const file = path.join(__dirname, 'api', `${api[1]}.js`);
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('{}'); }
    return require(file)(req, res);
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end('Not found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`studio dev server on http://localhost:${PORT}  (password: ${process.env.STUDIO_PASSWORD === 'dev' ? 'dev' : 'from STUDIO_PASSWORD'})${process.env.STUDIO_FAKE_META ? '  [fake Meta]' : ''}`);
});
