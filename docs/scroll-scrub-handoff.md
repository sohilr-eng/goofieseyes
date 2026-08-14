# Handoff — scroll-scrub hero smoothness

Working notes for whoever picks this up. Written 2026-08-14 after two commits
shipped to `claude/desktop-recent-changes-56iv8g` and the user tested on real
hardware. **Read the traps section before writing any code or running any
benchmark** — several non-obvious things will waste your time otherwise.

Delete this file when the work lands.

---

## 1. Where things stand

Branch `claude/desktop-recent-changes-56iv8g`, two commits ahead of `master`:

| commit | what |
|---|---|
| `f3e2723` | JS/CSS: playhead pipeline rewrite, rails fix, loop gating, compositing, preload/cache |
| `830255d` | Re-encode: 1080p, keyframe every 24 frames, B-frames removed |

**Not merged. Not live.** Production serves `master` (`09b5e07`). Nothing the
user sees on `goofieseyes.live` includes any of this yet.

Current assets on the branch:

```
assets/video/vinyl-desktop-v2.mp4   6.31 MB   1920x1080  g=24  no B-frames
assets/video/vinyl-mobile-v2.mp4    2.91 MB   1280x720   g=24  no B-frames
+ matching -poster.jpg for each, extracted from frame 0 of their own clip
```

### User's real-hardware verdict

- **PC — still choppy.** Note: they briefly reported it as smooth, then
  corrected themselves — they had been scrolling the Higgsfield demo site, not
  this one. Treat PC as unfixed.
- **iOS — much better, except scrolling *up*,** which is still choppy.
- **New, unrelated complaint:** "it takes 5 scrolls to get into actually
  scrolling the website." Not yet addressed. See §4.

---

## 2. What is decided but NOT implemented

The user answered these, then the session was interrupted before implementation.
**These are approved — build them.**

1. **Desktop re-encode → 1280×720, keyframe every 8 frames.** Measured 5.03 MB,
   *smaller* than the 6.31 MB currently on the branch, at roughly half the
   per-seek cost. This is the main fix for PC choppiness.
2. **Mobile re-encode to match** (960×540 suggested, g=8).
3. **Soften the smoothing** for mouse-wheel input. `SMOOTH` in
   `assets/scroll-scrub.js` is currently `13.4` (per second). Try `9.0`. The
   user can then fine-tune live via `?smooth=` without a redeploy.

### The master film

The user has a ~52 MB master at:

```
C:\Users\sohil\claude-workspace\goofieseyes\assets\higgsfield asset\hf_20260814_031522_481166dd-55d1-43c0-883d-b0f51c2a9ba5 (1).mp4
```

It is **not in the repo** and was never committed. The user has confirmed a
local desktop session *can* read that path — if that is you, encode from it.

If you cannot reach it, encoding from `vinyl-desktop-v2.mp4` is an acceptable
fallback: measured PSNR 47.5 dB / SSIM 0.992 against the file it replaced, which
is visually transparent, because the re-encode runs at roughly twice its
source's bitrate. **Never commit the master** — add it to `.gitignore` if it
sits in the working tree.

If you are running locally with real Chrome, you also get a better benchmark
than any of the numbers in §6: Chrome decodes H.264, so `scripts/scrub-bench.js`
will measure the actual shipped files instead of a VP9 stand-in. Re-baseline
before and after your change rather than comparing against the proxy figures
below.

Since the target is 720p, the master matters less than it sounds: downscaling
discards more detail than the generation loss does. Do not block on it.

### Encode commands

Replace `$SRC` with the master if available, else `assets/video/vinyl-desktop-v2.mp4`.
Use **new versioned filenames** (`-v3`) — see trap 6.

```bash
# desktop
ffmpeg -i "$SRC" -an -vf "scale=1280:720:flags=lanczos,fps=24" \
  -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p \
  -g 8 -keyint_min 8 -sc_threshold 0 -bf 0 -refs 1 \
  -crf 21 -preset slow -movflags +faststart \
  assets/video/vinyl-desktop-v3.mp4

# mobile
ffmpeg -i "$SRC" -an -vf "scale=960:540:flags=lanczos,fps=24" \
  -c:v libx264 -profile:v high -level 3.1 -pix_fmt yuv420p \
  -g 8 -keyint_min 8 -sc_threshold 0 -bf 0 -refs 1 \
  -crf 22 -preset slow -movflags +faststart \
  assets/video/vinyl-mobile-v3.mp4

# posters — from the ENCODES, not the master (see trap 8)
ffmpeg -i assets/video/vinyl-desktop-v3.mp4 -frames:v 1 -q:v 3 assets/video/vinyl-desktop-v3-poster.jpg
ffmpeg -i assets/video/vinyl-mobile-v3.mp4  -frames:v 1 -q:v 3 assets/video/vinyl-mobile-v3-poster.jpg
```

Why each flag: `-g 8 -keyint_min 8 -sc_threshold 0` forces a keyframe every 8
frames (`-sc_threshold 0` is required, or x264 places them on scene cuts and you
get no guaranteed interval on a continuous take). `-bf 0` removes B-frames,
which decode out of order and add latency to every seek — as important as the
GOP. `-refs 1` shrinks decoder state setup per seek.

Then update references in `index.html` (6 places: two `<link rel=preload href>`,
`data-clip`, `data-mobile-clip`, the poster `<source srcset>` and `<img src>`),
`git rm` the `-v2` files, and confirm nothing stale remains:

```bash
grep -rn 'vinyl-.*-v2' --include=*.html --include=*.js --include=*.json .
```

### Verify the encode before touching anything else

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,nb_frames,has_b_frames -of default=noprint_wrappers=1 assets/video/vinyl-desktop-v3.mp4
ffprobe -v error -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -of csv=p=0 assets/video/vinyl-desktop-v3.mp4 | wc -l
```

Expect `has_b_frames=0`, `nb_frames=361`, and ~46 keyframes (was 2 originally,
16 on the current `-v2`).

---

## 3. Traps — read these first

1. **The Playwright Chromium has no H.264 at all.** `canPlayType('video/mp4;
   codecs="avc1.42E01E")` returns `""`. Any harness that loads the real `.mp4`
   will hang forever at "waiting for video ready". Workaround used here: encode a
   VP9 `.webm` proxy and intercept the request with
   `page.route('**/vinyl-*.mp4', r => r.fulfill({contentType:'video/webm', body}))`.
   **If you are on a desktop with real Chrome, you do not need this** — Chrome
   has H.264 and you can benchmark the actual shipped files, which is strictly
   better. `scripts/scrub-bench.js` auto-detects and tells you which mode it used.

2. **`scroll-scrub.js` is a deferred script, so it initialises before any
   `DOMContentLoaded` hook.** Deferred scripts run with
   `document.readyState === 'interactive'`, so the module's own
   `readyState === 'loading'` check is false and it calls `init()` immediately.
   You cannot swap `data-clip` from a `DOMContentLoaded` listener — it is already
   too late. Intercept at the network layer instead.

3. **At 1080p, denser keyframes stop helping.** Measured: g=24 → 32.9 ms per
   seek, g=8 → 32.7 ms, g=4 → 31.4 ms. All the same. The cost is *pixels*, not
   the dependency chain. Only at 720p does g=8 drop to 16.3 ms. **Resolution is
   the lever above ~720p; GOP is the lever below it.** Do not burn time making
   the GOP denser at 1080p — it only inflates the file.

4. **Do not race `seeked` against `requestVideoFrameCallback`.** It was tried and
   measured *worse*: 1.47 seeks per presented frame versus 1.04. `seeked` fires
   before composition, so the pipeline outruns the compositor and spends decodes
   on frames superseded before anyone sees them. The seek chain must settle on
   rVFC only. `seeked` is still used as a one-shot fallback for lifting the
   poster, which is correct and different.

5. **The backward-scroll penalty does not reproduce in the headless harness.**
   Measured 32.4 ms backward vs 33.0 ms forward — no asymmetry. This is because
   software VP9 decode gains nothing from decoder state, so forward is *equally*
   slow. On real hardware H.264, forward continues from decoder state while
   backward must flush and restart from a keyframe. **The iOS scroll-up chop is
   real but is not measurable in this container.** Do not conclude it is fixed
   because the harness looks symmetric. Denser keyframes and lower resolution are
   the levers; verify on a real device.

6. **`/assets/video/` is served `immutable` for one year** (`vercel.json`). Every
   re-encode **must** use a new filename or cached clients keep the old file for
   a year. Hence `-v2`, `-v3`.

7. **`vercel.json` header precedence is deliberately avoided, not resolved.** The
   two rules use mutually exclusive patterns — `/assets/video/(.*)` and
   `/assets/((?!video/).*)` — because it was unclear whether Vercel applies
   first-match or last-match for a duplicated `Cache-Control` key. Keep them
   mutually exclusive; do not "simplify" back to overlapping patterns.

8. **Posters must be extracted from the encodes, not the master.** The poster is
   shown until the video's first frame paints, and a mismatch is a visible jump
   at the handoff. Extracting from a different source guarantees a mismatch.

9. **ffmpeg is not preinstalled in the remote container.**
   `apt-get update && apt-get install -y ffmpeg` (the `update` is required — the
   index is stale and the install 404s without it). The Playwright-bundled
   binary at `/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux` is built
   `--disable-everything` with only VP8/webm/mjpeg/png — **no libx264, no mp4
   muxer** — it cannot do this job.

10. **Outbound network is allowlisted.** `goofieseyes.live` returns a proxy 403.
    You cannot fetch the live site or a Vercel preview from the remote container.

---

## 4. Open questions for the user — do not decide these alone

**The "5 scrolls" complaint and the scroll track length are the same question,
and they pull against each other.**

The hero band is `min-height: 340svh` (inline style on `.scroll-scrub__chapter`
in `index.html`) — about 3060 px on a 900 px viewport, mapping 361 video frames
onto that distance at roughly 8.5 px per frame. Consequences:

- Five wheel notches ≈ 500 px ≈ 16% of the way in, so the page reads as frozen
  while it is actually scrubbing. That is the design working as specified.
- **Shortening the track** makes it feel responsive but puts *more* video frames
  under each pixel of scroll, which is choppier.
- **Lengthening it** scrubs more smoothly but makes the "stuck" feeling worse.

There is no setting that fixes both. The user has to choose the trade. A third
option worth offering: keep the track long but let the copy/CTA make it obvious
the film is responding, so the pin does not read as a frozen page.

Also open:
- Whether to analyse the Higgsfield demo. The user finds it smoother. The
  high-value, low-effort version is to get the video file *their* demo serves and
  probe its resolution and keyframe spacing — that answers whether their
  advantage is the encode or a different technique, in about a minute.
- Never verified anywhere: **iOS Safari priming path** and **120 Hz displays**.
  Both need real hardware.

---

## 5. Design decisions to preserve

Do not undo these; each was measured or reasoned and the reasons are not obvious
from the code alone.

- **No shared rAF scheduler.** An earlier plan called for one. Once both loops
  are IntersectionObserver-gated and idle-exit, measured idle cost is 0 either
  way, and a scheduler adds a cross-file lifecycle dependency between `site.js`
  and `scroll-scrub.js` for one saved callback in a narrow overlap band.
- **The poster keeps `fetchpriority="high"`.** A plan had it demoted. It is
  ~110 KB, it is the first thing on screen, and the hero is black without it.
- **Seek watchdog (`SEEK_TIMEOUT`) and generation counter (`seekGen`) are load
  bearing.** Once seeks are serialised, one dropped `seeked` would latch the
  pipeline shut for the life of the page; and a seek the watchdog abandoned can
  still land late and clobber whatever is in flight. Do not remove either.
- **`SNAP = 0.2`** teleports the playhead on large jumps. Without it, a reload
  mid-page or following `#the-crate` seeks the whole way from frame 0.
- **`svh`, not `dvh`,** on the stage, chapter-pin, story margin and the inline
  track height. `dvh` changes when the mobile URL bar hides, resizing a sticky
  element mid-scroll while the JS's cached geometry goes stale. All four must
  stay consistent or the scroll-to-progress mapping breaks.
- **`--ss-progress` is written on `.scroll-scrub__progress span`, not the
  section root.** Custom properties inherit, so writing it on the root
  invalidated style for the whole hero subtree — including the pinned copy and
  its full-bleed gradient scrim — every frame.

### Constraints

- **No build step.** `vercel.json` has `buildCommand: null`, `outputDirectory: "."`.
  Whatever is in `assets/*.js` ships verbatim.
- **ES5 only** in `assets/*.js` — `var`, function expressions, no arrow
  functions, no `const`/`let`. Verify with
  `npx acorn@8 --ecma5 --silent assets/scroll-scrub.js`.
- Keep the reduced-motion path (no clip ever fetched, poster permanent) and the
  iOS priming path (play/pause on first gesture) intact.

---

## 6. How to verify

Two scripts are in `scripts/`. Both need Playwright; on the remote container it
is global at `/opt/node22/lib/node_modules/playwright` with Chromium at
`/opt/pw-browsers/chromium`.

```bash
node scripts/scrub-regress.js          # 15 correctness checks, exits non-zero on failure
node scripts/scrub-bench.js            # cadence + seek latency, forward and backward
```

`scrub-regress.js` covers: reduced-motion fetches nothing and idles, exactly one
clip request per breakpoint, the right encode per breakpoint, poster lifts after
first seek, progress property on the bar not the root, rails single-instance and
still transforming, and no page errors on the four other pages. **Run it before
every commit.**

### Baseline numbers to beat

4 s scroll across the band, VP9 proxies in headless Chromium. These are
**relative A/B numbers only** — absolute decode cost does not transfer to H.264
on real hardware.

| | frames presented | cadence | lag p50 | idle rAF |
|---|---|---|---|---|
| original code + original encode | 27 | 143 ± 119 ms | 2.41 s | 120 |
| current branch (`830255d`) | 114 | 35 ± 15 ms | 0.26 s | 0 |
| target (720p, g=8) | ~189 | ~21 ± 8 ms | — | 0 |

Seek latency, write → presented, by encode:

| encode | frames decoded per seek | p50 |
|---|---|---|
| 1080p g=24 (current branch) | ~10 | 32.9 ms |
| 1080p g=8 | 3.4 | 32.7 ms |
| 1080p g=4 | 1.6 | 31.4 ms |
| **720p g=8 (target)** | 3.8 | **16.3 ms** |

16.3 ms is one 60 Hz display frame — decode stops being the bottleneck. 33 ms is
two, which caps presentation at 30 fps and is what the user perceives as choppy.

---

## 7. Working agreement with this user

They test on real hardware and report precisely; take the reports seriously even
when the harness disagrees — the harness has been wrong twice (traps 1 and 5).

They asked directly for an honest recommendation when a plan looked wrong, and
they were right to. One judgement call already went wrong and is worth learning
from: g=24 was shipped over the planned g=8 on the strength of a
"zero stalls over 100 ms" metric that was too coarse to see the 33 ms vs 16 ms
gap. **Pick metrics fine enough to resolve the thing the user will actually
feel.**

Flag size and quality trade-offs explicitly with real measured numbers rather
than estimates — an early "roughly 2×" guess turned out to be 3.7×, and
measuring the variants took two minutes.
