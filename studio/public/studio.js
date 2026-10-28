// goofieseyes studio — compose, queue and connections in one page.
//
// Media never passes through a function: each file is converted in the browser
// (photos → JPEG, which Instagram requires) and sent straight to Vercel Blob
// with a short-lived token from /api/blob-upload. The post itself only carries
// the resulting public URLs.

import { upload } from 'https://esm.sh/@vercel/blob@2.8.2/client';

const IG_MIN_RATIO = 0.8;   // 4:5
const IG_MAX_RATIO = 1.91;  // 1.91:1
const MAX_EDGE = 2048;
const LIMITS = { instagram: { caption: 2200, hashtags: 30, media: 10 }, threads: { text: 500, media: 20 } };
const NAMES = { facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  media: [],        // { id, kind, name, source, jpeg, preview, url, pathname, width, height, fit, duration }
  editingId: null,
  posts: [],
  status: null,
};
let nextId = 1;

// ─── API ─────────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(message, ms = 3200) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

function showTab(name) {
  for (const tab of $$('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const panel of $$('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
  if (name === 'queue') loadQueue();
  if (name === 'connections') loadConnections();
}
for (const tab of $$('.tab')) tab.addEventListener('click', () => showTab(tab.dataset.tab));

$('#logout').addEventListener('click', async () => {
  await fetch('/api/login?logout', { method: 'POST' });
  location.href = '/login.html';
});

// ─── Media: reading and converting ──────────────────────────────────────────

function igRatioOk(w, h) {
  const r = w / h;
  return r >= IG_MIN_RATIO - 0.005 && r <= IG_MAX_RATIO + 0.005;
}

// Renders `source` as a JPEG. `fit` only matters when the shape is outside
// Instagram's 4:5 … 1.91:1 range: 'crop' trims to the nearest allowed shape,
// 'pad' adds white borders to reach it, 'original' leaves it alone.
async function renderJpeg(source, fit) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    throw new Error('This browser can’t read that photo. Export it as JPEG first (iPhone HEIC files sometimes do this).');
  }
  const sw = bitmap.width;
  const sh = bitmap.height;
  const ratio = sw / sh;
  const target = ratio < IG_MIN_RATIO ? IG_MIN_RATIO : ratio > IG_MAX_RATIO ? IG_MAX_RATIO : ratio;

  let crop = { x: 0, y: 0, w: sw, h: sh };
  let frameW = sw;
  let frameH = sh;
  if (fit === 'crop' && target !== ratio) {
    if (ratio < target) { const h = sw / target; crop = { x: 0, y: (sh - h) / 2, w: sw, h }; }
    else { const w = sh * target; crop = { x: (sw - w) / 2, y: 0, w, h: sh }; }
    frameW = crop.w; frameH = crop.h;
  } else if (fit === 'pad' && target !== ratio) {
    if (ratio < target) frameW = sh * target; else frameH = sw / target;
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(frameW, frameH));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(frameW * scale);
  canvas.height = Math.round(frameH * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const dw = crop.w * scale;
  const dh = crop.h * scale;
  ctx.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  bitmap.close?.();

  const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  return { jpeg, width: canvas.width, height: canvas.height };
}

function readVideo(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration });
    v.onerror = () => resolve({ width: null, height: null, duration: null });
    v.src = URL.createObjectURL(file);
  });
}

async function addSource(source, name) {
  const isVideo = source.type.startsWith('video/');
  const item = { id: nextId++, kind: isVideo ? 'video' : 'image', name, source, fit: 'original', url: null };
  if (isVideo) {
    if (!['video/mp4', 'video/quicktime'].includes(source.type)) throw new Error(`${name}: use MP4 or MOV video.`);
    Object.assign(item, await readVideo(source));
    item.preview = URL.createObjectURL(source);
  } else {
    // Never crop or pad on our own: a tall portrait gets a warning on its tile
    // and the owner picks Crop or Border.
    Object.assign(item, await renderJpeg(source, 'original'));
    item.preview = URL.createObjectURL(item.jpeg);
  }
  state.media.push(item);
}

async function addFiles(files) {
  for (const file of files) {
    try {
      await addSource(file, file.name);
    } catch (err) {
      toast(err.message, 5000);
    }
  }
  renderComposer();
}

async function refit(item, fit) {
  item.fit = fit;
  Object.assign(item, await renderJpeg(item.source, fit));
  URL.revokeObjectURL(item.preview);
  item.preview = URL.createObjectURL(item.jpeg);
  item.url = null; // the uploaded copy (if any) is the old shape
  renderComposer();
}

$('#files').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); });

// ─── Media: tray ─────────────────────────────────────────────────────────────

function selectedPlatforms() {
  return $$('input[name="platform"]:checked').map((i) => i.value);
}

function renderTray() {
  const tray = $('#tray');
  const ig = selectedPlatforms().includes('instagram');
  tray.innerHTML = state.media.map((m, i) => {
    const ratioBad = m.kind === 'image' && m.width && !igRatioOk(m.width, m.height);
    const chips = [];
    if (m.kind === 'video') chips.push(`<span class="chip">Video${m.duration ? ` · ${Math.round(m.duration)}s` : ''}</span>`);
    if (m.width) chips.push(`<span class="chip">${m.width}×${m.height}</span>`);
    if (ig && ratioBad) chips.push('<span class="chip warn">Too tall/wide for Instagram</span>');
    const fitControls = m.kind === 'image' && m.source && (ratioBad || m.fit !== 'original')
      ? `<div class="row">${['original', 'crop', 'pad'].map((f) => `<button type="button" class="mini" data-fit="${f}" data-id="${m.id}" aria-pressed="${m.fit === f}">${{ original: 'As is', crop: 'Crop 4:5', pad: 'Border 4:5' }[f]}</button>`).join('')}</div>`
      : '';
    const move = state.media.length > 1
      ? `<div class="row"><button type="button" class="mini" data-move="-1" data-id="${m.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move earlier">←</button><button type="button" class="mini" data-move="1" data-id="${m.id}" ${i === state.media.length - 1 ? 'disabled' : ''} aria-label="Move later">→</button></div>`
      : '';
    const thumb = m.kind === 'video'
      ? `<video class="thumb" src="${esc(m.preview || m.url)}" muted playsinline preload="metadata"></video>`
      : `<img class="thumb" src="${esc(m.preview || m.url)}" alt="">`;
    return `<div class="tile">${thumb}<span class="num">${i + 1}</span>
      <button type="button" class="remove" data-remove="${m.id}" aria-label="Remove">✕</button>
      <div class="meta"><div class="row">${chips.join('')}</div>${fitControls}${move}</div></div>`;
  }).join('');
  $('#media-count').textContent = state.media.length ? `${state.media.length} item${state.media.length === 1 ? '' : 's'}` : '';
}

$('#tray').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = Number(btn.dataset.id || btn.dataset.remove);
  const index = state.media.findIndex((m) => m.id === id);
  if (index < 0) return;
  if (btn.dataset.remove) {
    const [gone] = state.media.splice(index, 1);
    if (gone.preview) URL.revokeObjectURL(gone.preview);
  } else if (btn.dataset.fit) {
    await refit(state.media[index], btn.dataset.fit);
    return;
  } else if (btn.dataset.move) {
    const to = index + Number(btn.dataset.move);
    [state.media[index], state.media[to]] = [state.media[to], state.media[index]];
  }
  renderComposer();
});

// ─── Captions, validation ────────────────────────────────────────────────────

function captions() {
  const out = {};
  for (const ta of $$('[data-cap]')) if (ta.value.trim()) out[ta.dataset.cap] = ta.value;
  return out;
}
function captionFor(platform) {
  return captions()[platform] || $('#caption').value;
}
const hashtagCount = (t) => (t.match(/(^|\s)#[^\s#]+/g) || []).length;

// Mirrors validatePost() in lib/publish.js, plus the shape check only the
// browser can do (the server never sees pixel sizes it can trust).
function problems() {
  const out = [];
  const platforms = selectedPlatforms();
  const media = state.media;
  const images = media.filter((m) => m.kind === 'image');
  const videos = media.filter((m) => m.kind === 'video');
  if (!platforms.length) out.push('Pick at least one platform.');
  if (platforms.includes('facebook')) {
    if (!captionFor('facebook').trim() && !media.length) out.push('Facebook: add a caption or some media.');
    if (videos.length > 1 || (videos.length && images.length)) out.push('Facebook: a post is either photos or one video, not a mix.');
  }
  if (platforms.includes('instagram')) {
    const t = captionFor('instagram');
    if (!media.length) out.push('Instagram: needs at least one photo or video.');
    if (media.length > LIMITS.instagram.media) out.push(`Instagram: at most ${LIMITS.instagram.media} items in a carousel.`);
    if (t.length > LIMITS.instagram.caption) out.push(`Instagram: caption is ${t.length} characters (max ${LIMITS.instagram.caption}).`);
    if (hashtagCount(t) > LIMITS.instagram.hashtags) out.push(`Instagram: at most ${LIMITS.instagram.hashtags} hashtags.`);
    if (images.some((m) => m.width && !igRatioOk(m.width, m.height))) out.push('Instagram: some photos are taller than 4:5 or wider than 1.91:1. Pick Crop or Border on them.');
  }
  if (platforms.includes('threads')) {
    const t = captionFor('threads');
    if (!t.trim() && !media.length) out.push('Threads: add text or some media.');
    if (t.length > LIMITS.threads.text) out.push(`Threads: text is ${t.length} characters (max ${LIMITS.threads.text}). Give Threads its own caption below.`);
    if (media.length > LIMITS.threads.media) out.push(`Threads: at most ${LIMITS.threads.media} items.`);
  }
  if (laterSelected()) {
    const at = scheduledAt();
    if (!at) out.push('Pick a date and time.');
    else if (at < Date.now() - 60e3) out.push('That time has already passed.');
  }
  return out;
}

function renderCounters() {
  const platforms = selectedPlatforms();
  const chip = (p) => {
    const t = captionFor(p);
    if (p === 'threads') return `<span class="chip ${t.length > 500 ? 'bad' : ''}">Threads ${t.length}/500</span>`;
    if (p === 'instagram') {
      const bad = t.length > 2200 || hashtagCount(t) > 30;
      return `<span class="chip ${bad ? 'bad' : ''}">Instagram ${t.length}/2200 · #${hashtagCount(t)}/30</span>`;
    }
    return `<span class="chip">Facebook ${t.length}</span>`;
  };
  $('#counters').innerHTML = platforms.map(chip).join('');
  for (const el of $$('[data-count]')) {
    const own = $(`[data-cap="${el.dataset.count}"]`).value;
    el.textContent = own ? `${own.length}` : '';
  }
  for (const field of $$('details.custom .field')) field.hidden = !platforms.includes(field.dataset.platform);
}

// ─── When ────────────────────────────────────────────────────────────────────

const laterSelected = () => $('input[name="when"]:checked').value === 'later';
function scheduledAt() {
  const v = $('#scheduled-at').value;
  return v ? new Date(v).getTime() : null;
}
function toLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
for (const r of $$('input[name="when"]')) {
  r.addEventListener('change', () => {
    const later = laterSelected();
    $('#scheduled-at').hidden = !later;
    if (later && !$('#scheduled-at').value) $('#scheduled-at').value = toLocalInput(Date.now() + 3600e3);
    $('#scheduled-at').min = toLocalInput(Date.now());
    renderComposer();
  });
}

function renderComposer() {
  renderTray();
  renderCounters();
  const list = problems();
  $('#problems').innerHTML = list.map((p) => `<li>${esc(p)}</li>`).join('');
  const later = laterSelected();
  $('#submit').textContent = state.editingId ? 'Save changes' : later ? 'Schedule' : 'Post now';
  $('#submit').disabled = list.length > 0;
  const at = scheduledAt();
  $('#submit-note').textContent = later && at
    ? new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : '';
  $('#reset').hidden = !state.editingId && !state.media.length && !$('#caption').value;
  $('#composer-title').textContent = state.editingId ? 'Edit scheduled post' : 'New post';
}

for (const el of [$('#caption'), ...$$('[data-cap]'), $('#scheduled-at')]) el.addEventListener('input', renderComposer);
for (const el of $$('input[name="platform"]')) el.addEventListener('change', renderComposer);

function resetComposer() {
  for (const m of state.media) if (m.preview) URL.revokeObjectURL(m.preview);
  state.media = [];
  state.editingId = null;
  $('#caption').value = '';
  for (const ta of $$('[data-cap]')) ta.value = '';
  $('#custom').open = false;
  for (const el of $$('input[name="platform"]')) el.checked = true;
  $('input[name="when"][value="now"]').checked = true;
  $('#scheduled-at').hidden = true;
  $('#scheduled-at').value = '';
  renderComposer();
}
$('#reset').addEventListener('click', resetComposer);

// ─── Upload + submit ─────────────────────────────────────────────────────────

function slug(name) {
  return String(name).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'media';
}

async function uploadOne(item, onProgress) {
  const body = item.kind === 'image' ? item.jpeg : item.source;
  const ext = item.kind === 'image' ? 'jpg' : item.source.type === 'video/quicktime' ? 'mov' : 'mp4';
  const pathname = `media/${Date.now()}-${slug(item.name)}.${ext}`;

  if (state.status?.devUploads) {
    const res = await fetch(`/api/dev-upload?name=${encodeURIComponent(pathname)}`, { method: 'POST', body, headers: { 'Content-Type': body.type } });
    if (!res.ok) throw new Error('Dev upload failed');
    return res.json();
  }
  const blob = await upload(pathname, body, {
    access: 'public',
    handleUploadUrl: '/api/blob-upload',
    contentType: item.kind === 'image' ? 'image/jpeg' : item.source.type,
    multipart: body.size > 20 * 1024 * 1024,
    onUploadProgress: ({ percentage }) => onProgress(percentage),
  });
  return { url: blob.url, pathname: blob.pathname };
}

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (problems().length) return;
  const submit = $('#submit');
  const bar = $('#progress');
  submit.disabled = true;

  try {
    const pending = state.media.filter((m) => !m.url);
    if (pending.length) {
      bar.hidden = false;
      for (const [i, item] of pending.entries()) {
        submit.textContent = `Uploading ${i + 1}/${pending.length}…`;
        Object.assign(item, await uploadOne(item, (pct) => {
          bar.firstElementChild.style.width = `${((i + pct / 100) / pending.length) * 100}%`;
        }));
      }
    }
    submit.textContent = 'Saving…';
    const payload = {
      caption: $('#caption').value,
      captions: captions(),
      platforms: selectedPlatforms(),
      media: state.media.map((m) => ({ url: m.url, pathname: m.pathname, type: m.kind, width: m.width, height: m.height })),
      ...(laterSelected() ? { scheduledAt: new Date(scheduledAt()).toISOString() } : { publishNow: true }),
    };
    const { post } = state.editingId
      ? await api(`/api/posts?id=${encodeURIComponent(state.editingId)}`, { method: 'PUT', body: payload })
      : await api('/api/posts', { method: 'POST', body: payload });

    toast(laterSelected() ? `Scheduled for ${new Date(post.scheduledAt).toLocaleString()}` : 'Publishing now — watch it in Queue');
    resetComposer();
    showTab('queue');
  } catch (err) {
    toast(err.message, 6000);
    renderComposer();
  } finally {
    bar.hidden = true;
    bar.firstElementChild.style.width = '0';
  }
});

// ─── Site picker ─────────────────────────────────────────────────────────────

const sheet = $('#site-sheet');
let portfolios = null;
let picked = [];
let openAlbum = null;

async function showAlbums() {
  openAlbum = null;
  picked = [];
  $('#site-title').textContent = 'From goofieseyes.live';
  $('#site-back').hidden = true;
  $('#site-add').hidden = true;
  const body = $('#site-body');
  if (!portfolios) {
    body.innerHTML = '<p class="empty">Loading collections…</p>';
    try {
      portfolios = (await api('/api/site?portfolios')).portfolios || [];
    } catch (err) {
      body.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
      return;
    }
  }
  body.innerHTML = `<div class="albums">${portfolios.map((p, i) => `
    <button class="album" type="button" data-album="${i}">
      <img src="/api/site?photo=${encodeURIComponent(p.cover || p.photos[0]?.filename || '')}" alt="" loading="lazy">
      <span><strong>${esc(p.name)}</strong><br><span class="n">${p.photos.length} photos</span></span>
    </button>`).join('')}</div>`;
}

function showAlbum(index) {
  openAlbum = portfolios[index];
  $('#site-title').textContent = openAlbum.name;
  $('#site-back').hidden = false;
  renderPicks();
}

function renderPicks() {
  const photos = [...openAlbum.photos].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  $('#site-body').innerHTML = `<div class="photos">${photos.map((ph) => {
    const n = picked.indexOf(ph.filename);
    return `<button class="pick" type="button" data-photo="${esc(ph.filename)}" aria-pressed="${n >= 0}" data-order="${n + 1}">
      <img src="/api/site?photo=${encodeURIComponent(ph.filename)}" alt="${esc(ph.alt || ph.title || '')}" loading="lazy"></button>`;
  }).join('')}</div>`;
  $('#site-add').hidden = picked.length === 0;
  $('#site-add').textContent = `Add ${picked.length}`;
}

$('#open-site').addEventListener('click', () => { sheet.showModal(); showAlbums(); });
$('#site-close').addEventListener('click', () => sheet.close());
$('#site-back').addEventListener('click', showAlbums);
$('#site-body').addEventListener('click', (e) => {
  const album = e.target.closest('[data-album]');
  if (album) return showAlbum(Number(album.dataset.album));
  const photo = e.target.closest('[data-photo]');
  if (photo) {
    const name = photo.dataset.photo;
    picked = picked.includes(name) ? picked.filter((p) => p !== name) : [...picked, name];
    renderPicks();
  }
});
$('#site-add').addEventListener('click', async () => {
  const names = [...picked];
  sheet.close();
  toast(`Adding ${names.length} photo${names.length === 1 ? '' : 's'}…`);
  for (const name of names) {
    try {
      const res = await fetch(`/api/site?photo=${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`Couldn't load ${name}`);
      await addSource(await res.blob(), name);
    } catch (err) {
      toast(err.message, 5000);
    }
  }
  renderComposer();
});

// ─── Queue ───────────────────────────────────────────────────────────────────

const TARGET_LABEL = { pending: 'Waiting', processing: 'Processing…', published: 'Live', failed: 'Failed' };

function fmtTime(ms) {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function postCard(p) {
  const first = p.media?.[0];
  const cover = !first
    ? '<div class="cover text">Aa</div>'
    : first.type === 'video'
      ? `<video class="cover" src="${esc(first.url)}" muted playsinline preload="metadata"></video>`
      : `<img class="cover" src="${esc(first.url)}" alt="" loading="lazy">`;
  const targets = p.platforms.map((pl) => {
    const t = p.targets?.[pl] || {};
    const state = p.status === 'scheduled' || p.status === 'cancelled' ? '' : (TARGET_LABEL[t.state] || 'Waiting');
    const link = t.permalink ? ` <a href="${esc(t.permalink)}" target="_blank" rel="noopener">View ↗</a>` : '';
    const err = t.error ? `<span class="err">${esc(t.error)}</span>` : '';
    return `<div class="target"><span class="name">${NAMES[pl]}</span><span>${state}${link}</span>${err}</div>`;
  }).join('');
  const actions = [];
  if (p.status === 'scheduled') {
    actions.push(`<button class="btn small" data-act="edit" data-id="${p.id}">Edit</button>`);
    actions.push(`<button class="btn small danger" data-act="cancel" data-id="${p.id}">Cancel</button>`);
  }
  if (p.status === 'failed' || p.status === 'partial') actions.push(`<button class="btn small" data-act="retry" data-id="${p.id}">Retry failed</button>`);
  if (['published', 'failed', 'partial', 'cancelled'].includes(p.status)) actions.push(`<button class="btn small ghost" data-act="remove" data-id="${p.id}">Remove from list</button>`);
  const when = p.status === 'scheduled' ? `Goes out ${fmtTime(p.scheduledAt)}` : fmtTime(p.scheduledAt);

  return `<article class="card post">
    ${cover}
    <div>
      <div class="status ${p.status}">${p.status}</div>
      <div class="when">${when}</div>
      <p class="caption">${esc(p.caption || Object.values(p.captions || {})[0] || '')}</p>
      <div class="targets">${targets}</div>
      <div class="btn-row">${actions.join('')}</div>
    </div>
  </article>`;
}

let pollTimer = null;
async function loadQueue() {
  clearTimeout(pollTimer);
  try {
    state.posts = (await api('/api/posts')).posts;
  } catch (err) {
    $('#queue').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    return;
  }
  const upcoming = state.posts.filter((p) => p.status === 'scheduled').sort((a, b) => a.scheduledAt - b.scheduledAt);
  const rest = state.posts.filter((p) => p.status !== 'scheduled');
  $('#queue-count').textContent = upcoming.length ? String(upcoming.length) : '';
  $('#queue').innerHTML = state.posts.length
    ? [
      upcoming.length ? `<p class="label">Scheduled</p>${upcoming.map(postCard).join('')}` : '',
      rest.length ? `<p class="label" style="margin-top:20px">Recent</p>${rest.map(postCard).join('')}` : '',
    ].join('')
    : '<p class="empty">Nothing yet. Compose a post and it shows up here.</p>';

  // Keep watching while anything is mid-publish and the queue is on screen.
  if (state.posts.some((p) => p.status === 'publishing') && !$('[data-panel="queue"]').hidden) {
    pollTimer = setTimeout(loadQueue, 5000);
  }
}

$('#queue').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  const post = state.posts.find((p) => p.id === id);
  try {
    if (act === 'edit') return editPost(post);
    if (act === 'cancel' && !confirm('Cancel this scheduled post?')) return;
    if (act === 'remove' && !confirm('Remove it from this list? Nothing is deleted on Facebook, Instagram or Threads.')) return;
    btn.disabled = true;
    if (act === 'cancel') await api(`/api/posts?id=${id}&action=cancel`, { method: 'POST' });
    if (act === 'retry') await api(`/api/posts?id=${id}&action=retry`, { method: 'POST' });
    if (act === 'remove') await api(`/api/posts?id=${id}`, { method: 'DELETE' });
    loadQueue();
  } catch (err) {
    toast(err.message, 5000);
    btn.disabled = false;
  }
});

function editPost(post) {
  resetComposer();
  state.editingId = post.id;
  state.media = (post.media || []).map((m) => ({
    id: nextId++, kind: m.type, name: m.pathname || 'media', source: null, url: m.url, pathname: m.pathname,
    width: m.width, height: m.height, fit: 'original', preview: null,
  }));
  $('#caption').value = post.caption || '';
  for (const ta of $$('[data-cap]')) ta.value = post.captions?.[ta.dataset.cap] || '';
  $('#custom').open = Object.keys(post.captions || {}).length > 0;
  for (const el of $$('input[name="platform"]')) el.checked = post.platforms.includes(el.value);
  $('input[name="when"][value="later"]').checked = true;
  $('#scheduled-at').hidden = false;
  $('#scheduled-at').value = toLocalInput(post.scheduledAt);
  showTab('compose');
  renderComposer();
}

// ─── Connections ─────────────────────────────────────────────────────────────

async function loadConnections() {
  const box = $('#connections');
  try {
    state.status = await api('/api/status');
  } catch (err) {
    box.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    return;
  }
  const s = state.status;
  const row = (name, c, extra = '') => `<div class="conn"><span class="dot ${c.ok ? 'ok' : ''}"></span>
    <div><strong>${name}</strong><div class="detail">${c.ok ? esc(c.name) + extra : esc(c.error)}</div></div></div>`;
  const expiry = s.threads.ok && s.threads.expiresAt ? ` · token renews daily, current one good until ${new Date(s.threads.expiresAt).toLocaleDateString()}` : '';
  const svc = (ok, label) => `<div class="conn"><span class="dot ${ok ? 'ok' : ''}"></span><div><strong>${label}</strong><div class="detail">${ok ? 'Connected' : 'Not connected yet (setup step 6)'}</div></div></div>`;
  box.innerHTML = row('Facebook Page', s.facebook) + row('Instagram', s.instagram) + row('Threads', s.threads, expiry)
    + svc(s.services.uploads || s.devUploads, 'Media uploads (Vercel Blob)')
    + svc(s.services.storage, 'Post storage (Upstash Redis)')
    + svc(s.services.scheduler, 'Scheduler (Upstash QStash)');
}

// ─── Boot ────────────────────────────────────────────────────────────────────

(async () => {
  const { authed } = await api('/api/login');
  if (!authed) { location.href = '/login.html'; return; }
  renderComposer();
  loadConnections();
  loadQueue();
})();
