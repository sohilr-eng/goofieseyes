/**
 * Thin fetch wrapper for Meta's Graph APIs (graph.facebook.com and
 * graph.threads.net share the same error shape).
 *
 * Every failure becomes a GraphError carrying `transient`, which the publisher
 * uses to decide between "try again in a minute" and "tell the owner". Meta
 * marks some errors `is_transient` itself; the codes below are the documented
 * rate-limit and temporary-outage ones it doesn't always mark.
 */

const API_VERSION = process.env.META_API_VERSION || 'v24.0';
const FACEBOOK = `https://graph.facebook.com/${API_VERSION}`;
const THREADS = 'https://graph.threads.net/v1.0';

// 1/2 unknown/temporary, 4/17/32/613 rate limits, 341 app limit, 368 temporary block,
// 9004 "media could not be fetched" (usually the CDN being slow on a fresh upload),
// 2207001/2207003 IG "server error"/"timeout while downloading media".
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613, 9004]);
const TRANSIENT_SUBCODES = new Set([2207001, 2207003]);

class GraphError extends Error {
  constructor(message, { code, subcode, transient, status } = {}) {
    super(message);
    this.code = code;
    this.subcode = subcode;
    this.transient = Boolean(transient);
    this.httpStatus = status;
  }
}

async function call(base, method, path, params = {}, token) {
  const url = new URL(base + path);
  const body = new URLSearchParams();
  // graph.facebook.com takes the token as a Bearer header, which keeps it out
  // of URLs. Threads only documents the access_token parameter, so it gets that.
  const all = base === THREADS ? { ...params, access_token: token } : params;
  for (const [k, v] of Object.entries(all)) {
    if (v === undefined || v === null) continue;
    const value = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (method === 'GET') url.searchParams.set(k, value); else body.set(k, value);
  }
  const init = { method, headers: base === THREADS ? {} : { Authorization: `Bearer ${token}` } };
  if (method !== 'GET') init.body = body;

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new GraphError(`Couldn't reach Meta: ${err.message}`, { transient: true });
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok && !data.error) return data;

  const e = data.error || {};
  const message = e.error_user_msg || e.message || `Meta answered HTTP ${res.status}`;
  throw new GraphError(message, {
    code: e.code,
    subcode: e.error_subcode,
    status: res.status,
    transient: e.is_transient || TRANSIENT_CODES.has(e.code) || TRANSIENT_SUBCODES.has(e.error_subcode) || res.status >= 500,
  });
}

const facebook = {
  get: (path, params, token) => call(FACEBOOK, 'GET', path, params, token),
  post: (path, params, token) => call(FACEBOOK, 'POST', path, params, token),
};
const threads = {
  get: (path, params, token) => call(THREADS, 'GET', path, params, token),
  post: (path, params, token) => call(THREADS, 'POST', path, params, token),
};

module.exports = { facebook, threads, GraphError, API_VERSION };
