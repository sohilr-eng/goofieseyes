/**
 * Small request/response helpers shared by every studio function.
 *
 * Vercel's Node runtime makes `req.body` a lazy getter that JSON-parses on
 * first access and replays the raw bytes on the request's 'data'/'end' events
 * (see api/stripe-webhook.js in the site for the long version). The worker
 * verifies QStash signatures over the exact bytes, so everything here reads the
 * stream and never touches `req.body`.
 */

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readRawBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    const err = new Error('Request body is not valid JSON');
    err.status = 400;
    throw err;
  }
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function query(req) {
  return new URL(req.url, 'http://studio.local').searchParams;
}

// Wraps a handler so a thrown error becomes a JSON reply instead of a bare 500.
// `err.status` picks the code; anything without one is our bug, so it's logged.
function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (!err.status) console.error('[studio]', err);
      if (!res.headersSent) send(res, err.status || 500, { error: err.message || 'Something went wrong' });
    }
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { readRawBody, readJson, send, query, handler, httpError };
