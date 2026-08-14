/**
 * scrub-regress.js
 * Usage: node scripts/scrub-regress.js
 *
 * Correctness checks for the scroll-scrub hero. Exits non-zero if any fail.
 * Run before every commit that touches scroll-scrub.js, site.js, the hero
 * markup, or the video assets.
 *
 * H.264 note: browsers without an H.264 decoder (Playwright's Chromium among
 * them) cannot load the real clips. Set PROXY=/path/to/proxy.webm to serve a
 * VP9 stand-in; see scripts/scrub-bench.js for how to build one. Real Chrome
 * needs no proxy.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8777);
const PROXY = process.env.PROXY || '';

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
const { chromium } = loadPlaywright();
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        res.writeHead(404); res.end('nope'); return;
      }
      const b = fs.readFileSync(f);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Content-Length': b.length });
      res.end(b);
    });
    s.listen(PORT, () => resolve(s));
  });
}

const STRESS = PROXY && fs.existsSync(PROXY) ? fs.readFileSync(PROXY) : null;

/* Only intercept when this browser genuinely cannot decode H.264. With real
 * Chrome the checks run against the actual shipped files, which is stronger. */
async function maybeProxy(page, canH264) {
  if (canH264 || !STRESS) return;
  await page.route('**/vinyl-*.mp4', (r) =>
    r.fulfill({ status: 200, contentType: 'video/webm', body: STRESS }));
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || '/opt/pw-browsers/chromium',
  });

  const probe = await browser.newPage();
  const canH264 = await probe.evaluate(() =>
    document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"') !== '');
  await probe.close();
  if (!canH264 && !STRESS) {
    console.error('\nThis browser has no H.264 decoder and no PROXY was set.');
    console.error('Set PROXY=/path/to/proxy.webm — see scripts/scrub-bench.js.\n');
    await browser.close(); server.close(); process.exit(1);
  }
  console.log(canH264
    ? 'decoder: native H.264 — checking the real assets'
    : 'decoder: VP9 proxy standing in for the clips');

  // ---- 1. reduced motion: no clip fetched, no rAF spin -------------------
  {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const clipReqs = [];
    page.on('request', (r) => { if (/\.(mp4|webm)$/.test(r.url())) clipReqs.push(r.url()); });
    await page.addInitScript(() => {
      window.__n = 0;
      const n = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = function (cb) { window.__n++; return n(cb); };
    });
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const before = await page.evaluate(() => window.__n);
    await page.waitForTimeout(2000);
    const after = await page.evaluate(() => window.__n);
    check('reduced-motion: no clip requested', clipReqs.length === 0, clipReqs.join(',') || 'none');
    check('reduced-motion: rAF idle when stationary', after - before === 0, `${after - before} frames in 2s`);
    const posterVisible = await page.evaluate(() =>
      !document.querySelector('[data-scroll-scrub-layer]').dataset.videoPainted);
    check('reduced-motion: poster still the visual', posterVisible);
    await ctx.close();
  }

  // ---- 2. desktop: one clip request only, and it is the desktop encode ---
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const reqs = [];
    page.on('request', (r) => { if (/vinyl-.*\.mp4/.test(r.url())) reqs.push(r.url()); });
    await maybeProxy(page, canH264);
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const v = document.querySelector('.scroll-scrub__video');
      return v && v.readyState >= 1;
    }, { timeout: 30000 });
    await page.waitForTimeout(500);
    check('desktop: exactly one clip request', reqs.length === 1, `${reqs.length}: ${reqs.map((u) => u.split('/').pop()).join(',')}`);
    check('desktop: fetched the desktop encode', /vinyl-desktop/.test(reqs[0] || ''), reqs[0] || 'none');

    // poster lifts after a scroll
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.waitForTimeout(900);
    const painted = await page.evaluate(() =>
      document.querySelector('[data-scroll-scrub-layer]').dataset.videoPainted === 'true');
    check('desktop: poster lifts after first seek', painted);

    // progress bar custom property is on the bar, not the section
    const propHost = await page.evaluate(() => ({
      onBar: !!document.querySelector('.scroll-scrub__progress span').style.getPropertyValue('--ss-progress'),
      onRoot: !!document.querySelector('.scroll-scrub').style.getPropertyValue('--ss-progress'),
    }));
    check('progress property written on the bar, not the section',
      propHost.onBar && !propHost.onRoot, JSON.stringify(propHost));

    // rails: single instance, transforms applied
    const rails = await page.evaluate(async () => {
      window.scrollTo(0, document.querySelector('#crate').offsetTop);
      await new Promise((r) => setTimeout(r, 800));
      const w = document.querySelector('[data-gf-rails]');
      return {
        hasInstance: !!(w && w.gfRails),
        transforms: [].slice.call(document.querySelectorAll('.gf-rail')).map((r) => r.style.transform),
      };
    });
    check('rails: single memoised instance', rails.hasInstance);
    check('rails: transforms applied', rails.transforms.every((t) => /translate3d/.test(t)),
      JSON.stringify(rails.transforms));
    await ctx.close();
  }

  // ---- 3. mobile viewport picks the mobile encode ------------------------
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    });
    const page = await ctx.newPage();
    const reqs = [];
    page.on('request', (r) => { if (/vinyl-.*\.mp4/.test(r.url())) reqs.push(r.url()); });
    await maybeProxy(page, canH264);
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    check('mobile: exactly one clip request', reqs.length === 1, `${reqs.length}`);
    check('mobile: fetched the mobile encode', /vinyl-mobile/.test(reqs[0] || ''), reqs[0] || 'none');
    await ctx.close();
  }

  // ---- 4. other pages still initialise -----------------------------------
  for (const p of ['portfolios.html', 'prints.html', 'journal.html', 'collection.html']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`http://localhost:${PORT}/${p}`, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    check(`${p}: no page errors`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
