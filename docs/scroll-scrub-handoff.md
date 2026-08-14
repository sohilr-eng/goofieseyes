# Handoff — scroll-scrub hero smoothness

Working notes for whoever picks this up. Updated 2026-08-14 after a local
desktop session that had the master film, real Chrome and ffmpeg — none of which
the earlier remote session had. **Read the traps section before writing any code
or running any benchmark.**

Delete this file when the work lands on `master`.

---

## 1. Where things stand

Branch `claude/desktop-recent-changes-56iv8g`, five commits ahead of `master`:

| commit | what |
|---|---|
| `f3e2723` | JS/CSS: playhead pipeline rewrite, rails fix, loop gating, compositing, preload/cache |
| `830255d` | Re-encode: 1080p, keyframe every 24 frames, B-frames removed |
| `79e2d69` | Handoff notes, benchmark tooling |
| *(new)* | Re-encode at 720p/540p, keyframe every 8 frames, cut from the master |
| *(new)* | `SMOOTH` 13.4 → 9.0, `?track=` knob |

**Not merged. Not live.** Production serves `master` (`09b5e07`).

Current assets on the branch:

```
assets/video/vinyl-desktop-v3.mp4   5.02 MB   1280x720   g=8   no B-frames
assets/video/vinyl-mobile-v3.mp4    2.92 MB    960x540   g=8   no B-frames
+ matching -poster.jpg for each, extracted from frame 0 of their own clip
```

Both cut from the master, not from a previous encode, so there is no generation
loss. Verified: `has_b_frames=0`, `nb_frames=361`, 46 keyframes each.

### What is still unverified

The whole point of the change is how it feels on **the user's PC** and **their
iPhone**, and neither has been tested since the re-encode. Everything below is
bench data from one Windows desktop with hardware H.264 decode.

Specifically still open:
- **PC choppiness** — the complaint that motivated all of this.
- **iOS scrolling *up*** — reported choppy, and see trap 5.
- **120 Hz displays** and the **iOS Safari priming path** — never verified anywhere.

---

## 2. What was decided and is now implemented

All three items the previous session left pending are done.

1. **Desktop re-encode → 1280×720, keyframe every 8 frames.** Done, from the
   master. 5.02 MB, *smaller* than the 6.31 MB it replaces.
2. **Mobile re-encode → 960×540, g=8.** Done. 2.92 MB, effectively unchanged in
   size — the denser keyframes eat the resolution saving.
3. **`SMOOTH` 13.4 → 9.0.** Done. Still overridable live with `?smooth=`.

Plus one addition the user chose when asked about the "5 scrolls" complaint:

4. **`?track=` knob.** Overrides the hero band height in `svh` at runtime,
   clamped to 50–1000, falling back to the markup default on anything invalid.
   The default stays `min-height: 340svh` on `.scroll-scrub__chapter` in
   `index.html`. This exists because the trade in §4 cannot be resolved from a
   bench — it needs the user's eye on the user's hardware.

### The master film

```
C:\Users\sohil\claude-workspace\goofieseyes\assets\higgsfield asset\hf_20260814_031522_481166dd-55d1-43c0-883d-b0f51c2a9ba5 (1).mp4
```

1920×1080, 24 fps, 361 frames, 29 Mbps H.264, ~52 MB. A local desktop session
can read it. It is now covered by `.gitignore` (`assets/higgsfield asset/`), so
it can sit in the working tree safely. **Never commit it.**

### Encode commands

These are the ones actually used. `$SRC` is the master.

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

Any future re-encode needs a **new filename** (`-v4`) — see trap 6 — plus the
6 references in `index.html` (two `<link rel=preload href>`, `data-clip`,
`data-mobile-clip`, the poster `<source srcset>` and `<img src>`). Then confirm:

```bash
grep -rn 'vinyl-.*-v3' --include=*.html --include=*.js --include=*.json .
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,nb_frames,has_b_frames -of default=noprint_wrappers=1 assets/video/vinyl-desktop-v4.mp4
ffprobe -v error -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -of csv=p=0 assets/video/vinyl-desktop-v4.mp4 | wc -l
```

---

## 3. Traps — read these first

1. **Playwright's bundled Chromium has no H.264 at all.**
   `canPlayType('video/mp4; codecs="avc1.42E01E")` returns `""`, and any harness
   loading the real `.mp4` hangs forever at "waiting for video ready". The remote
   session worked around this with a VP9 `.webm` proxy.
   **On Windows with Chrome installed, do not use the proxy** — point Playwright
   at real Chrome and you measure the actual shipped files:

   ```bash
   npm install --no-save playwright        # PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
   CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe" node scripts/scrub-regress.js
   ```

   `node_modules` is gitignored and `--no-save` leaves `package.json` alone.
   Both scripts print which decoder they got; want "native H.264".

2. **`scroll-scrub.js` is a deferred script, so it initialises before any
   `DOMContentLoaded` hook.** Deferred scripts run with
   `document.readyState === 'interactive'`, so the module's own
   `readyState === 'loading'` check is false and it calls `init()` immediately.
   You cannot swap `data-clip` from a `DOMContentLoaded` listener — it is already
   too late. Intercept at the network layer instead.

3. **At 1080p, denser keyframes stop helping.** Measured: g=24 → 32.9 ms per
   seek, g=8 → 32.7 ms, g=4 → 31.4 ms. The cost is *pixels*, not the dependency
   chain. **Resolution is the lever above ~720p; GOP is the lever below it.**

4. **Do not race `seeked` against `requestVideoFrameCallback`.** Measured
   *worse*: 1.47 seeks per presented frame versus 1.04. `seeked` fires before
   composition, so the pipeline outruns the compositor and spends decodes on
   frames superseded before anyone sees them. The seek chain must settle on rVFC
   only. `seeked` is still used as a one-shot fallback for lifting the poster,
   which is correct and different.

5. **The backward-scroll penalty does not reproduce on a bench — in either
   container.** The remote VP9 harness measured no asymmetry, and real Chrome
   with real H.264 measured backward *faster* than forward (5.3 ms vs 6.9 ms
   p50), because a fully-buffered blob makes Chrome's seek path symmetric.
   **The iOS scroll-up chop is real but is not reproducible in Chrome.** Do not
   conclude it is fixed because a bench looks symmetric; verify on the device.

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
   at the handoff.

9. **Never rewrite `index.html` through PowerShell `Get-Content`/`Set-Content`.**
   The file is UTF-8 with no BOM; `Get-Content -Raw` decodes it as ANSI and
   writing it back turns every em-dash into `â€”` across the whole file,
   including the `<title>` and the JSON-LD block. This happened once and was
   caught only by a byte-exact backup. Use the editing tools, or `git checkout`
   to restore. Check with `Select-String -Pattern 'â€'` — want zero hits.

10. **The Claude in-app Browser pane does not composite while hidden.**
    `document.hidden` stays true, so `requestAnimationFrame` never fires, the
    scrub loop never runs, and `requestVideoFrameCallback` never resolves — the
    page looks broken when it is fine. Screenshots fail with an explicit message.
    For anything involving rAF or presentation, drive Playwright instead. The
    `_bench` harness used for encode A/B has a `mode=seeked` fallback for this,
    since `seeked` fires on decode completion regardless of visibility.

11. **On Windows, a static-file server needs `path.resolve` on its root.**
    `path.join` returns backslashes, so a forward-slash root fails the
    `f.startsWith(ROOT)` traversal guard and 404s every request. Cost twenty
    minutes of debugging a harness that looked like a page bug.

12. **ffmpeg is not preinstalled in the remote container** (it is on this
    desktop, via winget, at 8.0.1). `apt-get update && apt-get install -y ffmpeg`
    — the `update` is required. The Playwright-bundled binary is built
    `--disable-everything`: no libx264, no mp4 muxer.

13. **Outbound network is allowlisted in the remote container.**
    `goofieseyes.live` returns a proxy 403.

---

## 4. Open questions for the user

**The track length trade is now tunable rather than decided.** The user chose
the knob over a fixed value, so the answer comes from their hardware.

The hero band defaults to `min-height: 340svh` — about 3060 px on a 900 px
viewport, mapping 361 frames at roughly 8.5 px per frame. Five wheel notches
≈ 500 px ≈ 16% in, which is why the page reads as frozen at first.

- **Shorter** feels responsive but puts more film under each pixel.
- **Longer** scrubs more smoothly but makes the "stuck" feeling worse.

What changed: that trade used to be expensive, because a seek cost 16–39 ms. At
5 ms it is much cheaper, so shortening is viable in a way it was not when this
document was first written. Measured with `?track=`, an 850 px scroll reaches
0.312 of the film at 340svh, 0.544 at 170svh, 0.190 at 600svh.

Ask the user for the value that feels right on both devices, then bake it into
the inline style in `index.html` and keep the knob for future tuning.

Also still open:
- Whether to analyse the Higgsfield demo the user finds smoother. The
  high-value, low-effort version is to grab the video file *their* demo serves
  and probe its resolution and keyframe spacing — that answers whether their
  advantage is the encode or a different technique, in about a minute.

---

## 5. Design decisions to preserve

Do not undo these; each was measured or reasoned and the reasons are not obvious
from the code alone.

- **No shared rAF scheduler.** Once both loops are IntersectionObserver-gated
  and idle-exit, measured idle cost is 0 either way, and a scheduler adds a
  cross-file lifecycle dependency between `site.js` and `scroll-scrub.js`.
- **The poster keeps `fetchpriority="high"`.** It is the first thing on screen
  and the hero is black without it.
- **Seek watchdog (`SEEK_TIMEOUT`) and generation counter (`seekGen`) are load
  bearing.** Once seeks are serialised, one dropped `seeked` would latch the
  pipeline shut for the life of the page; and a seek the watchdog abandoned can
  still land late and clobber whatever is in flight. Do not remove either.
- **`SNAP = 0.2`** teleports the playhead on large jumps. Without it, a reload
  mid-page or following `#the-crate` seeks the whole way from frame 0.
- **`svh`, not `dvh`,** on the stage, chapter-pin, story margin, the inline track
  height and the `?track=` override. `dvh` changes when the mobile URL bar hides,
  resizing a sticky element mid-scroll while the JS's cached geometry goes stale.
  All five must stay consistent or the scroll-to-progress mapping breaks.
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

```bash
node scripts/scrub-regress.js          # 15 correctness checks, exits non-zero on failure
node scripts/scrub-bench.js            # cadence + seek latency, forward and backward
```

Set `CHROME` to real Chrome (trap 1). **Run the regression before every commit.**

### Real H.264 measurements

Same harness, same machine, real Chrome, 4 s scroll across the band. These
replace the VP9-proxy figures the earlier revision of this document carried —
those were relative-only and understated the gain.

| | v2 (1080p g=24) | v3 (720p g=8) |
|---|---|---|
| distinct frames presented, forward | 215 | **356** |
| distinct frames presented, backward | 207 | **360** |
| seek latency p50 | 16.3 ms | **4.9 ms** |
| seek latency p95 | 38.7 ms | **5.1 ms** |
| jitter (std dev) | 12.1 ms | **2.5 ms** |
| holds over 100 ms | 0 | 0 |
| long tasks | 0 | 0 |
| idle rAF, hero off screen | 0 | 0 |

Per-seek latency measured directly against each file, 181 seeks per direction:

| encode | fwd p50 | fwd p90 | back p50 | back p90 |
|---|---|---|---|---|
| desktop v2 — 1080p g=24 | 18.3 ms | 31.2 ms | 16.3 ms | 28.6 ms |
| **desktop v3 — 720p g=8** | **6.9 ms** | **12.9 ms** | **5.3 ms** | **8.7 ms** |
| mobile v2 — 720p g=24 | 9.7 ms | 16.8 ms | 8.9 ms | 14.5 ms |
| **mobile v3 — 540p g=8** | **6.4 ms** | **10.1 ms** | **4.2 ms** | **6.2 ms** |

Note the "holds over 100 ms" row: **identical for both encodes**, while p95 and
jitter show a 7× gap. That is exactly the metric that caused g=24 to ship over
g=8 last time. Do not use it to decide anything.

---

## 7. Working agreement with this user

They test on real hardware and report precisely; take the reports seriously even
when the harness disagrees — the harness has now been wrong three times
(traps 1, 5 and 10).

They asked directly for an honest recommendation when a plan looked wrong, and
they were right to. One judgement call already went wrong: g=24 was shipped over
the planned g=8 on the strength of a "zero stalls over 100 ms" metric that was
too coarse to see the gap. **Pick metrics fine enough to resolve the thing the
user will actually feel.**

Flag size and quality trade-offs explicitly with real measured numbers rather
than estimates — an early "roughly 2×" guess turned out to be 3.7×, and
measuring the variants took two minutes. When a decision is genuinely theirs,
ask, and offer a runtime knob so the answer can come from their eye rather than
a bench.
