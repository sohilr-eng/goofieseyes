#!/usr/bin/env node
/**
 * Plumbing for the caption desk (`/captions` in Claude Code). Claude does the
 * writing; this only moves data to and from the studio.
 *
 *   node studio/scripts/caption-desk.js pull
 *     Fetches the posts marked "needs captions", downloads their photos (and a
 *     frame from each video, when ffmpeg is installed) into a temp folder so
 *     Claude can look at them, and prints a summary with the local paths.
 *
 *   node studio/scripts/caption-desk.js push <captions.json>
 *     Sends captions back. The file is [{ "id": "...", "captions": { "facebook": "...",
 *     "threads": "...", "instagram": "..." } }]. Each one is checked first (Threads
 *     under 500 characters, no hashtags) and anything that fails is reported and skipped.
 *
 * Needs the studio's agent token, from STUDIO_AGENT_TOKEN, a file at
 * ~/.goofieseyes-studio/agent-token, or (in a Claude Code cloud session) a
 * network secret for studio.goofieseyes.live, which Anthropic's proxy adds to
 * the request so the session never holds the token. STUDIO_URL overrides the address.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE = (process.env.STUDIO_URL || 'https://studio.goofieseyes.live').replace(/\/$/, '');
const WORK = path.join(os.tmpdir(), 'caption-desk');
const THREADS_LIMIT = 500;

const TOKEN_FILE = path.join(os.homedir(), '.goofieseyes-studio', 'agent-token');

// null means "send no header and let a cloud network secret add it".
function token() {
  if (process.env.STUDIO_AGENT_TOKEN) return process.env.STUDIO_AGENT_TOKEN.trim();
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  return null;
}

async function call(method, route, body) {
  const t = token();
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !t) {
    throw new Error(`The studio refused: no agent token. Set STUDIO_AGENT_TOKEN, put it in ${TOKEN_FILE}, or (in a cloud session) add a network secret for studio.goofieseyes.live.`);
  }
  if (!res.ok) throw new Error(data.error || `Studio answered HTTP ${res.status}`);
  return data;
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { timeout: 10000 }).status === 0;

// A frame one second in (past any fade from black). Returns null on success,
// or why it couldn't, so the desk knows whether to write from the notes.
function videoFrame(url, file) {
  if (!HAS_FFMPEG) return 'ffmpeg is not installed';
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1', '-i', url, '-frames:v', '1', '-vf', 'scale=1280:-2', file], { timeout: 60000 });
  if (r.status === 0 && fs.existsSync(file)) return null;
  const lastLine = String(r.stderr || '').trim().split(/\r?\n/).pop();
  return `ffmpeg couldn't read it (${lastLine || 'no output'})`;
}

async function pull() {
  const { posts, recentEndings } = await call('GET', '/api/agent');
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  for (const post of posts) {
    const dir = path.join(WORK, post.id);
    fs.mkdirSync(dir, { recursive: true });
    post.images = [];
    for (const [i, m] of post.media.entries()) {
      const file = path.join(dir, `${i + 1}.jpg`);
      try {
        if (m.type === 'image') { await download(m.url, file); post.images.push(file); continue; }
        const failed = videoFrame(m.url, file);
        post.images.push(failed ? `(video ${i + 1}: no frame, ${failed}; write from the notes)` : file);
      } catch (err) {
        post.images.push(`(item ${i + 1} failed to download: ${err.message})`);
      }
    }
  }

  fs.writeFileSync(path.join(WORK, 'manifest.json'), JSON.stringify({ posts, recentEndings }, null, 2));
  if (!posts.length) {
    console.log('Nothing waiting for captions.');
    return;
  }
  console.log(`${posts.length} post(s) waiting for captions. Manifest: ${path.join(WORK, 'manifest.json')}\n`);
  for (const p of posts) {
    console.log(`── ${p.id}  ${p.held ? 'HELD, its time has passed, it goes out as soon as captions land' : `goes out ${p.scheduledAt}`}`);
    console.log(`   platforms: ${p.platforms.join(', ')}`);
    if (p.instagram) console.log(`   from Instagram: ${p.instagram}`);
    console.log(`   notes / original caption: ${p.notes ? JSON.stringify(p.notes) : '(none)'}`);
    for (const img of p.images) console.log(`   image: ${img}`);
    console.log('');
  }
  if (recentEndings.length) {
    console.log('How recent Facebook/Threads captions ended (word this batch differently):');
    for (const e of recentEndings) console.log(`   • ${e}`);
  }
}

function check(entry) {
  const problems = [];
  const c = entry.captions || {};
  for (const [platform, text] of Object.entries(c)) {
    if (/(^|\s)#[^\s#]+/.test(text)) problems.push(`${platform} has a hashtag`);
  }
  if (c.threads && c.threads.length > THREADS_LIMIT) problems.push(`threads is ${c.threads.length} characters (max ${THREADS_LIMIT})`);
  if (!Object.keys(c).length) problems.push('no captions');
  return problems;
}

async function push(file) {
  if (!file) { console.error('Usage: caption-desk.js push <captions.json>'); process.exit(2); }
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  let ok = 0;
  for (const entry of entries) {
    const problems = check(entry);
    if (problems.length) { console.log(`✗ ${entry.id}: ${problems.join('; ')}, not sent`); continue; }
    try {
      const r = await call('POST', `/api/agent?id=${encodeURIComponent(entry.id)}`, { captions: entry.captions });
      console.log(`✓ ${entry.id}: captions saved, goes out ${r.scheduledAt}`);
      ok += 1;
    } catch (err) {
      console.log(`✗ ${entry.id}: ${err.message}`);
    }
  }
  console.log(`\n${ok}/${entries.length} sent.`);
  if (ok < entries.length) process.exitCode = 1;
}

const [cmd, arg] = process.argv.slice(2);
(cmd === 'pull' ? pull() : cmd === 'push' ? push(arg) : Promise.reject(new Error('Use: pull | push <captions.json>')))
  .catch((err) => { console.error(err.message); process.exitCode = 1; });
