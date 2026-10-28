/**
 * One password, one owner.
 *
 * The studio holds a token that can post to every account and, from phase 3,
 * spend money on ads, so every route except the QStash worker and the daily
 * cron (which have their own signatures) sits behind this.
 *
 * Env vars:
 *   STUDIO_PASSWORD  (required) — what you type on the login page
 *   SESSION_SECRET   (required) — any long random string; signs the cookie.
 *                                 Changing it signs every device out.
 *
 * The session is a signed cookie, not a server-side record: `<payload>.<hmac>`
 * where payload is base64url JSON `{ exp }`. HttpOnly + Secure + SameSite=Strict
 * keeps it away from page scripts and other sites.
 */

const crypto = require('crypto');
const { getStore } = require('./store');
const { httpError } = require('./http');

const COOKIE = 'gs_session';
const SESSION_DAYS = 30;
const MAX_ATTEMPTS = 8;          // per IP...
const ATTEMPT_WINDOW = 15 * 60;  // ...per 15 minutes

function secrets() {
  const password = process.env.STUDIO_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  if (!password || !secret) {
    throw httpError(503, 'STUDIO_PASSWORD and SESSION_SECRET must be set in Vercel → Settings → Environment Variables.');
  }
  return { password, secret };
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function isAuthed(req) {
  const { secret } = secrets();
  const value = readCookie(req, COOKIE);
  if (!value) return false;
  const [payload, mac] = value.split('.');
  if (!payload || !mac || !safeEqual(sign(payload, secret), mac)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

function requireAuth(req) {
  if (!isAuthed(req)) throw httpError(401, 'Not signed in');
}

function cookieAttrs(maxAge) {
  // `Secure` would stop the cookie being set over plain http on localhost.
  const secure = process.env.VERCEL ? '; Secure' : '';
  return `; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

async function login(req, res, password) {
  const store = getStore();
  const key = `login-attempts:${clientIp(req)}`;
  const attempts = await store.incr(key);
  if (attempts === 1) await store.expire(key, ATTEMPT_WINDOW);
  if (attempts > MAX_ATTEMPTS) throw httpError(429, 'Too many attempts. Try again in 15 minutes.');

  const { password: expected, secret } = secrets();
  if (!safeEqual(password || '', expected)) throw httpError(401, 'Wrong password');

  await store.del(key);
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 86400e3 })).toString('base64url');
  res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${sign(payload, secret)}${cookieAttrs(SESSION_DAYS * 86400)}`);
}

function logout(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=${cookieAttrs(0)}`);
}

module.exports = { requireAuth, isAuthed, login, logout };
