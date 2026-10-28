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
  source: null,     // { type: 'instagram', id, permalink, timestamp } when brought over from Instagram
  batch: [],        // drafts for the several-at-once view
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
// browser can do (the server never sees pixel sizes it can trust). Takes a
// plain draft so the composer and the Instagram batch view share it.
function draftProblems({ platforms, media, caption, captions: own = {} }) {
  const out = [];
  const captionFor = (p) => own[p] || caption || '';
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
    if (t.length > LIMITS.threads.text) out.push(`Threads: text is ${t.length} characters (max ${LIMITS.threads.text}). Give Threads its own caption.`);
    if (media.length > LIMITS.threads.media) out.push(`Threads: at most ${LIMITS.threads.media} items.`);
  }
  return out;
}

function problems() {
  const out = draftProblems({ platforms: selectedPlatforms(), media: state.media, caption: $('#caption').value, captions: captions() });
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
  $('#reset').hidden = !state.editingId && !state.source && !state.media.length && !$('#caption').value;
  $('#composer-title').textContent = state.editingId ? 'Edit scheduled post' : 'New post';
  const src = $('#composer-source');
  src.hidden = !state.source;
  if (state.source) {
    src.innerHTML = `From your Instagram post of ${esc(fmtDay(state.source.timestamp))}${state.source.permalink ? ` · <a href="${esc(state.source.permalink)}" target="_blank" rel="noopener">view ↗</a>` : ''}`;
  }
}

for (const el of [$('#caption'), ...$$('[data-cap]'), $('#scheduled-at')]) el.addEventListener('input', renderComposer);
for (const el of $$('input[name="platform"]')) el.addEventListener('change', renderComposer);

function resetComposer() {
  for (const m of state.media) if (m.preview) URL.revokeObjectURL(m.preview);
  state.media = [];
  state.editingId = null;
  state.source = null;
  $('#needs-captions').checked = false;
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
      source: state.source,
      needsCaptions: $('#needs-captions').checked,
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

// ─── From Instagram ──────────────────────────────────────────────────────────
// Pick existing Instagram posts; each becomes its own Facebook + Threads post.
// One pick opens in the composer, several open the batch view.

const igSheet = $('#ig-sheet');
const ig = { items: [], next: null, picked: [] };
const IG_KIND = { carousel: (n) => `⧉ ${n}`, reel: () => '▶ Reel', video: () => '▶ Video', photo: () => '' };

function fmtDay(ts) {
  return ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

function sharedLabel(shared) {
  if (!shared) return '';
  return { scheduled: 'Scheduled', publishing: 'Posting', published: 'Shared', partial: 'Shared', failed: 'Failed' }[shared.status] || '';
}

function renderIgGrid() {
  $('#ig-grid').innerHTML = ig.items.map((it) => {
    const n = ig.picked.indexOf(it.id);
    const badge = IG_KIND[it.kind](it.count);
    const shared = sharedLabel(it.shared);
    return `<button class="pick ${shared ? 'is-shared' : ''}" type="button" data-ig="${esc(it.id)}" aria-pressed="${n >= 0}" data-order="${n + 1}"
        title="${esc(fmtDay(it.timestamp))} — ${esc(it.caption.slice(0, 120))}">
      <img src="${esc(it.thumb || '')}" alt="" loading="lazy" referrerpolicy="no-referrer">
      ${badge ? `<span class="badge">${esc(badge)}</span>` : ''}
      ${shared ? `<span class="shared">${shared}</span>` : ''}</button>`;
  }).join('') || '<p class="empty">No Instagram posts found.</p>';
  $('#ig-more').hidden = !ig.next;
  $('#ig-add').hidden = ig.picked.length === 0;
  $('#ig-add').textContent = `Add ${ig.picked.length}`;
}

async function loadIg(more = false) {
  if (!more) { ig.items = []; ig.next = null; ig.picked = []; $('#ig-grid').innerHTML = '<p class="empty">Loading your posts…</p>'; }
  try {
    const page = await api(`/api/instagram${more && ig.next ? `?after=${encodeURIComponent(ig.next)}` : ''}`);
    ig.items.push(...page.items);
    ig.next = page.next;
    renderIgGrid();
  } catch (err) {
    $('#ig-grid').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

$('#open-ig').addEventListener('click', () => { igSheet.showModal(); loadIg(); });
$('#ig-close').addEventListener('click', () => igSheet.close());
$('#ig-more').addEventListener('click', () => loadIg(true));
$('#ig-grid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-ig]');
  if (!btn) return;
  const id = btn.dataset.ig;
  ig.picked = ig.picked.includes(id) ? ig.picked.filter((p) => p !== id) : [...ig.picked, id];
  renderIgGrid();
});

$('#ig-add').addEventListener('click', async () => {
  const ids = [...ig.picked];
  const already = ig.items.filter((it) => ids.includes(it.id) && it.shared);
  if (already.length && !confirm(`${already.length === 1 ? 'One of these has' : `${already.length} of these have`} already been brought over (${already.map((a) => sharedLabel(a.shared).toLowerCase()).join(', ')}). Add again anyway?`)) return;
  igSheet.close();

  const drafts = [];
  for (const [i, id] of ids.entries()) {
    toast(`Copying ${i + 1} of ${ids.length} from Instagram…`, 60000);
    try {
      drafts.push((await api('/api/instagram', { method: 'POST', body: { id } })).draft);
    } catch (err) {
      toast(err.message, 6000);
    }
  }
  $('#toast').hidden = true;
  if (drafts.length === 1) openDraftInComposer(drafts[0]);
  else if (drafts.length > 1) openBatch(drafts);
});

function mediaFromDraft(draft) {
  return draft.media.map((m) => ({
    id: nextId++, kind: m.type, name: m.pathname || 'instagram', source: null,
    url: m.url, pathname: m.pathname, width: null, height: null, fit: 'original', preview: null,
  }));
}

function openDraftInComposer(draft) {
  resetComposer();
  state.media = mediaFromDraft(draft);
  state.source = draft.source;
  $('#caption').value = draft.caption;
  for (const ta of $$('[data-cap]')) ta.value = draft.captions[ta.dataset.cap] || '';
  $('#custom').open = Object.keys(draft.captions).length > 0;
  for (const el of $$('input[name="platform"]')) el.checked = el.value !== 'instagram';
  showTab('compose');
  renderComposer();
}

// ─── Batch view ──

const batchPlatforms = () => $$('input[name="batch-platform"]:checked').map((i) => i.value);
const batchSpread = () => $('input[name="batch-when"]:checked').value === 'spread';

// Whole-day intervals step by calendar day, so "6 pm every day" stays 6 pm
// across a daylight-saving change instead of drifting to 5 or 7.
function addHours(ms, hours) {
  if (hours % 24 !== 0) return ms + hours * 3600e3;
  const d = new Date(ms);
  d.setDate(d.getDate() + hours / 24);
  return d.getTime();
}

function batchTimes() {
  if (!batchSpread()) return state.batch.map(() => null);
  const start = $('#batch-start').value ? new Date($('#batch-start').value).getTime() : NaN;
  const every = Number($('#batch-every').value);
  return state.batch.map((_, i) => (Number.isNaN(start) ? NaN : addHours(start, i * every)));
}

function batchDraftProblems(d) {
  return draftProblems({ platforms: batchPlatforms(), media: d.media.map((m) => ({ kind: m.type })), caption: d.caption, captions: d.captions });
}

// New batches carry on from the last post already scheduled, one interval
// later, so separate batches chain into one steady rhythm instead of
// doubling up or leaving gaps. Nothing scheduled: tomorrow at 6 pm.
function defaultBatchStart() {
  const every = Number($('#batch-every').value);
  const last = Math.max(0, ...state.posts.filter((p) => p.status === 'scheduled').map((p) => p.scheduledAt));
  if (last && addHours(last, every) > Date.now()) return addHours(last, every);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(18, 0, 0, 0);
  return tomorrow.getTime();
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
function clashFor(at) {
  return state.posts.find((p) => p.status === 'scheduled' && sameDay(p.scheduledAt, at));
}

async function openBatch(drafts) {
  state.batch = drafts;
  state.batchStartTouched = false;
  try { state.posts = (await api('/api/posts')).posts; } catch { /* the default just won't chain */ }
  $('#batch-start').value = toLocalInput(defaultBatchStart());
  $('#batch-start').min = toLocalInput(Date.now());
  $('#composer').hidden = true;
  $('#batch').hidden = false;
  showTab('compose');
  renderBatch();
}

function closeBatch() {
  state.batch = [];
  $('#batch').hidden = true;
  $('#composer').hidden = false;
}

function renderBatch() {
  const times = batchTimes();
  const platforms = batchPlatforms();
  $('#batch-title').textContent = `${state.batch.length} posts from Instagram`;
  $('#batch-spread').hidden = !batchSpread();
  $('#batch-items').innerHTML = state.batch.map((d, i) => {
    const first = d.media[0];
    const cover = first.type === 'video'
      ? `<video class="cover" src="${esc(first.url)}" muted playsinline preload="metadata"></video>`
      : `<img class="cover" src="${esc(first.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    const when = times[i] ? fmtTime(times[i]) : 'Now';
    const clash = times[i] && clashFor(times[i]);
    const probs = batchDraftProblems(d);
    const threads = platforms.includes('threads')
      ? `<label class="label" for="bt-${i}">Threads${d.captions.threads ? ' (shortened)' : ''} · <span data-bcount="${i}">${(d.captions.threads || d.caption).length}</span>/500</label>
         <textarea id="bt-${i}" data-bi="${i}" data-bfield="threads" placeholder="uses the caption above when empty">${esc(d.captions.threads || '')}</textarea>`
      : '';
    return `<div class="bitem">
      ${cover}
      <div>
        <div class="when-line">${esc(when)} <span class="label">· from ${esc(fmtDay(d.source.timestamp))}${d.media.length > 1 ? ` · ${d.media.length} items` : ''}</span></div>
        ${clash ? `<p class="clash">Another post already goes out that day, at ${esc(new Date(clash.scheduledAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}.</p>` : ''}
        <label class="label" for="bc-${i}">Caption</label>
        <textarea id="bc-${i}" data-bi="${i}" data-bfield="caption">${esc(d.caption)}</textarea>
        ${threads}
        <ul class="problems">${probs.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
        <div class="row"><button type="button" class="btn small ghost danger" data-bremove="${i}">Leave this one out</button></div>
      </div></div>`;
  }).join('');
  updateBatchSubmit();
}

function updateBatchSubmit() {
  const times = batchTimes();
  const bad = state.batch.some((d) => batchDraftProblems(d).length)
    || !batchPlatforms().length
    || (batchSpread() && (Number.isNaN(times[0]) || times[0] < Date.now() - 60e3));
  $('#batch-submit').disabled = bad || state.batch.length === 0;
  $('#batch-submit').textContent = batchSpread() ? `Schedule ${state.batch.length}` : `Post ${state.batch.length} now`;
  const last = times[times.length - 1];
  $('#batch-note').textContent = batchSpread() && last && !Number.isNaN(last) ? `Last one ${fmtTime(last)}` : '';
}

// Typing only refreshes counters and problems; re-rendering would steal focus.
$('#batch-items').addEventListener('input', (e) => {
  const ta = e.target.closest('[data-bi]');
  if (!ta) return;
  const d = state.batch[Number(ta.dataset.bi)];
  if (ta.dataset.bfield === 'caption') d.caption = ta.value;
  else if (ta.value.trim()) d.captions.threads = ta.value;
  else delete d.captions.threads;
  const count = $(`[data-bcount="${ta.dataset.bi}"]`);
  if (count) count.textContent = (d.captions.threads || d.caption).length;
  const item = ta.closest('.bitem');
  item.querySelector('.problems').innerHTML = batchDraftProblems(d).map((p) => `<li>${esc(p)}</li>`).join('');
  updateBatchSubmit();
});
$('#batch-items').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-bremove]');
  if (!btn) return;
  state.batch.splice(Number(btn.dataset.bremove), 1);
  if (state.batch.length === 0) closeBatch(); else renderBatch();
});
for (const el of [...$$('input[name="batch-platform"]'), ...$$('input[name="batch-when"]'), $('#batch-start'), $('#batch-every')]) {
  el.addEventListener('change', renderBatch);
}
$('#batch-start').addEventListener('input', () => { state.batchStartTouched = true; });
// Changing the interval moves the chained start too, unless it was picked by hand.
$('#batch-every').addEventListener('change', () => {
  if (!state.batchStartTouched) { $('#batch-start').value = toLocalInput(defaultBatchStart()); renderBatch(); }
});
$('#batch-discard').addEventListener('click', () => { if (confirm('Discard these drafts?')) closeBatch(); });

$('#batch').addEventListener('submit', async (e) => {
  e.preventDefault();
  const times = batchTimes();
  const platforms = batchPlatforms();
  const submit = $('#batch-submit');
  submit.disabled = true;
  let done = 0;
  try {
    for (const [i, d] of state.batch.entries()) {
      submit.textContent = `Saving ${i + 1}/${state.batch.length}…`;
      await api('/api/posts', {
        method: 'POST',
        body: {
          caption: d.caption,
          captions: platforms.includes('threads') ? d.captions : {},
          media: d.media,
          platforms,
          source: d.source,
          needsCaptions: $('#batch-needs-captions').checked,
          ...(times[i] ? { scheduledAt: new Date(times[i]).toISOString() } : { publishNow: true }),
        },
      });
      done += 1;
    }
    toast(batchSpread() ? `Scheduled ${done} posts` : `Posting ${done} now — watch them in Queue`);
    closeBatch();
    showTab('queue');
  } catch (err) {
    // Keep only what didn't go through, so pressing the button again doesn't double-post.
    state.batch.splice(0, done);
    if (batchSpread() && done) $('#batch-start').value = toLocalInput(times[done]);
    toast(`${done ? `${done} saved. ` : ''}${err.message}`, 7000);
    renderBatch();
  }
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
  if (p.status === 'scheduled' && p.needsCaptions) {
    actions.push(`<button class="btn small" data-act="release" data-id="${p.id}">Post as is</button>`);
  }
  if (p.status === 'scheduled') {
    actions.push(`<button class="btn small" data-act="edit" data-id="${p.id}">Edit</button>`);
    actions.push(`<button class="btn small danger" data-act="cancel" data-id="${p.id}">Cancel</button>`);
  }
  if (p.status === 'failed' || p.status === 'partial') actions.push(`<button class="btn small" data-act="retry" data-id="${p.id}">Retry failed</button>`);
  if (['published', 'failed', 'partial', 'cancelled'].includes(p.status)) actions.push(`<button class="btn small ghost" data-act="remove" data-id="${p.id}">Remove from list</button>`);
  const when = p.status === 'scheduled' ? `Goes out ${fmtTime(p.scheduledAt)}` : fmtTime(p.scheduledAt);
  const desk = p.status !== 'scheduled' ? ''
    : p.held ? '<p class="clash">Held: its time came before the caption desk ran. Run /captions, or post it as is.</p>'
    : p.needsCaptions ? '<p class="from-ig" style="margin:0 0 8px"><span class="chip desk">Waiting for the caption desk</span></p>'
    : p.captionsBy === 'claude' ? '<p class="from-ig" style="margin:0 0 8px"><span class="chip desk">Captions by Claude: review</span></p>'
    : '';

  return `<article class="card post">
    ${cover}
    <div>
      <div class="status ${p.status}">${p.status}</div>
      <div class="when">${when}</div>
      ${desk}
      <p class="caption">${esc(p.captions?.facebook || p.captions?.threads || p.caption || '')}</p>
      ${p.source?.permalink ? `<p class="from-ig" style="margin:0 0 8px">From <a href="${esc(p.source.permalink)}" target="_blank" rel="noopener">Instagram ↗</a></p>` : ''}
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
    if (act === 'release') await api(`/api/posts?id=${id}&action=release`, { method: 'POST' });
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
  state.source = post.source || null;
  $('#needs-captions').checked = Boolean(post.needsCaptions);
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
