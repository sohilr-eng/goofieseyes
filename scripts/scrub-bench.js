/**
 * scrub-bench.js
 * Usage: node scripts/scrub-bench.js [label]
 *
 * Benchmarks the scroll-scrub hero: how many distinct video frames actually
 * reach the screen during a controlled scroll, how regular their cadence is,
 * and how long each seek takes from currentTime write to presented frame.
 * Reports forward and backward separately — they differ on real hardware.
 *
 * H.264 note: some Chromium builds (including Playwright's) ship without any
 * H.264 decoder, so the real clips never load. This detects that and falls back
 * to serving a VP9 proxy in their place, which keeps the pipeline measurable but
 * makes absolute decode cost meaningless. Build a proxy with:
 *
 *   ffmpeg -i assets/video/vinyl-desktop-v2.mp4 -an -c:v libvpx-vp9 \
 *     -g 8 -keyint_min 8 -sc_threshold 0 -b:v 2200k -speed 8 -row-mt 1 \
 *     -deadline realtime /tmp/scrub-proxy.webm
 *
 * and point PROXY at it. With real Chrome, no proxy is needed and the numbers
 * describe the actual shipped files.
 *
 * Always treat results as a relative A/B against the same harness, never as
 * absolute performance.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LABEL = process.argv[2] || 'run';
const PROXY = process.env.PROXY || '';
const PORT = Number(process.env.PORT || 8710);
const SCROLL_MS = Number(process.env.SCROLL_MS || 4000);
const FPS = Number(process.env.FPS || 24);

function loadPlaywright() {
  const candidates = [
    'playwright',
    '/opt/node22/lib/node_modules/playwright',
    path.join(ROOT, 'node_modules', 'playwright'),
  ];
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* next */ }
  }
  console.error('playwright not found. Install it, or set NODE_PATH to a global install.');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.xml': 'application/xml',
};

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      const body = fs.readFileSync(f);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream',
        'Content-Length': body.length,
      });
      res.end(body);
    });
    s.listen(PORT, () => resolve(s));
  });
}

const pct = (a, p) => (a.length
  ? +a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1)
  : 0);

(async () => {
  const { chromium } = loadPlaywright();
  const server = await serve();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || '/opt/pw-browsers/chromium',
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const canH264 = await page.evaluate(() =>
    document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"') !== '');

  if (!canH264) {
    if (!PROXY || !fs.existsSync(PROXY)) {
      console.error('\nThis browser cannot decode H.264 and no VP9 proxy was given.');
      console.error('Set PROXY=/path/to/proxy.webm — see the header of this file.\n');
      await browser.close(); server.close(); process.exit(1);
    }
    const body = fs.readFileSync(PROXY);
    await page.route('**/vinyl-*.mp4', (r) =>
      r.fulfill({ status: 200, contentType: 'video/webm', body }));
  }

  // Timestamp every currentTime write so it can be paired with its presented frame.
  await page.addInitScript(() => {
    window.__s = { pending: null, seeks: [], long: 0, longN: 0, raf: 0 };
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      get() { return d.get.call(this); },
      set(v) {
        window.__s.pending = { t: performance.now(), to: v, from: d.get.call(this) };
        d.set.call(this, v);
      },
      configurable: true,
    });
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) { window.__s.long += e.duration; window.__s.longN++; }
      }).observe({ type: 'longtask', buffered: true });
    } catch (e) { /* unsupported */ }

    /* Count rAF registrations made by the PAGE. Deliberately not a probe loop
     * of our own: a self-perpetuating counter keeps requesting frames forever
     * and reports its own activity as if the page were busy. */
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function (cb) { window.__s.raf++; return raf(cb); };
  });

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const v = document.querySelector('.scroll-scrub__video');
    return v && v.readyState >= 1 && v.duration > 0;
  }, { timeout: 60000 });

  await page.evaluate(() => {
    const v = document.querySelector('.scroll-scrub__video');
    if (!v.requestVideoFrameCallback) return;
    function rv(now, meta) {
      const p = window.__s.pending;
      if (p) {
        window.__s.seeks.push({ lat: now - p.t, to: p.to, from: p.from, mt: meta.mediaTime });
        window.__s.pending = null;
      }
      v.requestVideoFrameCallback(rv);
    }
    v.requestVideoFrameCallback(rv);
  });

  const band = await page.evaluate(() =>
    document.querySelector('[data-scroll-scrub-band]').getBoundingClientRect().height);

  async function run(dir) {
    await page.evaluate((y) => window.scrollTo(0, y), dir > 0 ? 0 : band);
    await page.waitForTimeout(900);
    await page.evaluate(() => { window.__s.seeks.length = 0; });
    await page.evaluate(async ({ band, dir, ms }) => {
      await new Promise((resolve) => {
        const t0 = performance.now();
        (function step(now) {
          const t = Math.min(1, (now - t0) / ms);
          window.scrollTo(0, Math.round((dir > 0 ? t : 1 - t) * band));
          if (t < 1) requestAnimationFrame(step); else resolve();
        })(t0);
      });
    }, { band, dir, ms: SCROLL_MS });
    await page.waitForTimeout(400);
    return page.evaluate(() => window.__s.seeks.slice());
  }

  function summarise(name, seeks) {
    const idx = seeks.map((s) => Math.round(s.mt * FPS));
    const times = seeks.map((s, i) => ({ i, f: idx[i] }));
    const gaps = [];
    let last = null;
    seeks.forEach((s, i) => {
      if (last !== null && idx[i] !== idx[last]) gaps.push(s.lat);
      last = i;
    });
    void times;
    const lat = seeks.map((s) => s.lat);
    const mean = lat.reduce((a, b) => a + b, 0) / (lat.length || 1);
    const sd = Math.sqrt(lat.reduce((a, b) => a + (b - mean) ** 2, 0) / (lat.length || 1));
    return {
      scenario: name,
      distinctFrames: new Set(idx).size,
      seeksIssued: seeks.length,
      latencyP50: pct(lat, 0.5),
      latencyP95: pct(lat, 0.95),
      latencyMax: +Math.max(0, ...lat).toFixed(1),
      latencyStdDev: +sd.toFixed(1),
      holdsOver100ms: lat.filter((l) => l > 100).length,
    };
  }

  const forward = summarise('forward', await run(1));
  const backward = summarise('backward', await run(-1));

  const idleOff = await page.evaluate(async () => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((r) => setTimeout(r, 800));
    const n = window.__s.raf;
    await new Promise((r) => setTimeout(r, 2000));
    return window.__s.raf - n;
  });

  const cost = await page.evaluate(() => ({
    longMs: +window.__s.long.toFixed(1), longN: window.__s.longN,
  }));

  console.log(`\n=== scrub-bench: ${LABEL} ===`);
  console.log(`decoder: ${canH264 ? 'native H.264 — numbers describe the real files'
    : 'VP9 proxy (no H.264 in this browser) — RELATIVE COMPARISON ONLY'}`);
  for (const r of [forward, backward]) {
    console.log(`\n${r.scenario}`);
    console.log(`  distinct frames presented : ${r.distinctFrames}`);
    console.log(`  seeks issued              : ${r.seeksIssued}`);
    console.log(`  seek latency p50/p95/max  : ${r.latencyP50} / ${r.latencyP95} / ${r.latencyMax} ms`);
    console.log(`  latency std dev           : ${r.latencyStdDev} ms   (jitter — lower is smoother)`);
    console.log(`  holds over 100ms          : ${r.holdsOver100ms}`);
  }
  console.log(`\nlong tasks: ${cost.longN} totalling ${cost.longMs} ms`);
  console.log(`rAF frames while idle, hero off screen (want 0): ${idleOff}\n`);

  await browser.close();
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
