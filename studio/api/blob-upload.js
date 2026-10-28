/**
 * POST /api/blob-upload — hands the browser a short-lived token so it can send
 * a photo or video straight to Vercel Blob.
 *
 * Going direct matters for video: a function only accepts 4.5 MB of request
 * body, and a Reel is easily 100 MB. The token is only issued to a signed-in
 * session, and only for JPEG images and MP4/MOV video.
 *
 * Instagram and Threads fetch media from a public URL, so the Blob store must
 * be created with public access. Paths get a random suffix, which makes them
 * unguessable; the daily cron deletes them a couple of days after publishing.
 *
 * Env: BLOB_READ_WRITE_TOKEN (set when the Blob store is connected to the project).
 */

const { handleUpload } = require('@vercel/blob/client');
const { handler, readJson, send, httpError } = require('../lib/http');
const { requireAuth } = require('../lib/auth');

const MAX_BYTES = 300 * 1024 * 1024;

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
  // No onUploadCompleted callback is registered, so the only caller is the
  // signed-in browser asking for a token.
  requireAuth(req);
  const body = await readJson(req);

  const result = await handleUpload({
    body,
    request: req,
    onBeforeGenerateToken: async (pathname) => {
      if (!pathname.startsWith('media/')) throw httpError(400, 'Uploads go under media/');
      return {
        allowedContentTypes: ['image/jpeg', 'video/mp4', 'video/quicktime'],
        maximumSizeInBytes: MAX_BYTES,
        addRandomSuffix: true,
      };
    },
  });
  send(res, 200, result);
});
