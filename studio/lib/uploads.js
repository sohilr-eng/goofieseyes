/**
 * What may be uploaded to the Blob store, and short-lived client tokens for it.
 *
 * The browser gets its token through handleUpload (api/blob-upload.js); a desk
 * on the owner's computer asks /api/agent?action=upload-token and then sends
 * the file straight to Vercel Blob itself. Either way BLOB_READ_WRITE_TOKEN
 * never leaves the server, and every token carries the same limits.
 */

const { generateClientTokenFromReadWriteToken } = require('@vercel/blob/client');
const { httpError } = require('./http');

const MAX_BYTES = 300 * 1024 * 1024;
const CONTENT_TYPES = ['image/jpeg', 'video/mp4', 'video/quicktime'];
const TOKEN_MINUTES = 15;

// The options both kinds of token are issued with.
const TOKEN_LIMITS = {
  allowedContentTypes: CONTENT_TYPES,
  maximumSizeInBytes: MAX_BYTES,
  addRandomSuffix: true,
  allowOverwrite: false,
};

function checkPathname(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('media/')) throw httpError(400, 'Uploads go under media/');
  const name = pathname.slice('media/'.length);
  if (!name || name.length > 200 || !/^[\w.-]+$/.test(name) || name.startsWith('.')) {
    throw httpError(400, 'pathname must be media/<name> using letters, numbers, dots, dashes and underscores.');
  }
}

/**
 * A client token a desk can upload one file with. `contentType` narrows the
 * token to that one type. Returns { clientToken, pathname, expiresAt }.
 */
async function deskUploadToken({ pathname, contentType, size } = {}, now = Date.now()) {
  checkPathname(pathname);
  if (!CONTENT_TYPES.includes(contentType)) throw httpError(400, `contentType must be one of ${CONTENT_TYPES.join(', ')}.`);
  if (!Number.isInteger(size) || size <= 0) throw httpError(400, 'size must be the file size in bytes.');
  if (size > MAX_BYTES) throw httpError(413, `That file is ${Math.ceil(size / 1048576)} MB; the limit is ${MAX_BYTES / 1048576} MB.`);
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw httpError(503, 'The Blob store is not connected (BLOB_READ_WRITE_TOKEN is not set).');

  const validUntil = now + TOKEN_MINUTES * 60e3;
  const clientToken = await generateClientTokenFromReadWriteToken({
    token: process.env.BLOB_READ_WRITE_TOKEN,
    pathname,
    ...TOKEN_LIMITS,
    allowedContentTypes: [contentType],
    validUntil,
  });
  return { clientToken, pathname, expiresAt: new Date(validUntil).toISOString() };
}

// Only links into our own public Blob store are accepted from a desk.
function isBlobUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && !u.port
    && /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i.test(u.hostname)
    && u.pathname.length > 1;
}

module.exports = { MAX_BYTES, CONTENT_TYPES, TOKEN_LIMITS, deskUploadToken, isBlobUrl };
