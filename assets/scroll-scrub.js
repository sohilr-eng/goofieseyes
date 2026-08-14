/* Scroll-scrub hero — vanilla port of the design's React component.
 *
 * The film is fetched once as a blob and driven by scroll position through
 * video.currentTime. Fetching the whole file up front (rather than letting the
 * browser Range-request while seeking) is the entire trick: seeking a streamed
 * video stutters badly, seeking a fully-buffered blob does not.
 *
 * Simplified for a single scene: the source supports multiple clips joined by
 * connector segments, with layer crossfades and a chapter nav. There is one
 * continuous take here, so all of that is gone. Everything that makes the
 * scrub itself feel right is kept, in particular the iOS priming path.
 */
(function () {
  'use strict';

  var clamp = function (v, min, max) {
    return Math.min(max === undefined ? 1 : max, Math.max(min === undefined ? 0 : min, v));
  };

  /**
   * Slow the middle of the clip without moving either seam frame.
   * At amount 0 this is linear; higher values hold the midpoint longer, which
   * is what makes the push-in read as directed rather than mechanical.
   */
  function lingerEase(value, amount) {
    var x = clamp(value);
    var linger = clamp(amount, 0, 0.6);
    var centered = x - 0.5;
    return (1 - linger) * x + linger * (4 * Math.pow(centered, 3) + 0.5);
  }

  function gfScrollScrub(root) {
    if (!root) return;

    var layer = root.querySelector('[data-scroll-scrub-layer]');
    var band = root.querySelector('[data-scroll-scrub-band]');
    if (!layer || !band) return;

    var clip = root.dataset.clip;
    var mobileClip = root.dataset.mobileClip;
    var linger = parseFloat(root.dataset.linger || '0');

    var FPS = parseFloat(root.dataset.fps || '24');
    var FRAMES = parseInt(root.dataset.frames || '0', 10);

    /* Smoothing rate, per second. 13.4 reproduced the old fixed 0.2-per-frame
     * lerp exactly at 60Hz — 1 - exp(-13.4/60) = 0.2 — and expressing it as a
     * rate means a 120Hz display converges at the same wall-clock rate instead
     * of twice as fast. Softened to 9.0 because a wheel notch arrives as one
     * large discrete jump: at 13.4 the filter tracked it closely enough that
     * each notch still read as a step. Tune by eye with ?smooth= before
     * changing this. */
    var SMOOTH = parseFloat(root.dataset.smooth || '9.0');
    var SNAP = 0.2;          /* jump further than this and teleport */
    var SEEK_TIMEOUT = 400;  /* ms before assuming a seek was dropped */

    /* These three want tuning by eye on the real page with the real film, on
     * real hardware, and none is worth a deploy to try. Follows the ?spin=
     * precedent in site.js. */
    try {
      var query = new URLSearchParams(window.location.search);
      if (query.get('linger') !== null && !isNaN(parseFloat(query.get('linger')))) {
        linger = parseFloat(query.get('linger'));
      }
      if (query.get('smooth') !== null && !isNaN(parseFloat(query.get('smooth')))) {
        SMOOTH = parseFloat(query.get('smooth'));
      }
      /* Band height decides how much scroll the film is spread across, and it
       * trades two ways: longer scrubs more smoothly but makes the pin read as
       * a frozen page, shorter feels responsive but puts more film under every
       * pixel. There is no value that wins both, so it has to be chosen by
       * feel. The default stays on the markup — this only overrides it, and
       * only within a range that still leaves a scrubbable band. Units are
       * svh, matching the stage, the pin and the story margin; dvh would
       * resize this mid-scroll when the mobile URL bar hides. */
      var track = parseFloat(query.get('track'));
      if (query.get('track') !== null && !isNaN(track) && track >= 50 && track <= 1000) {
        band.style.minHeight = track + 'svh';
      }
    } catch (e) {
      /* blocked or unsupported — the markup defaults stand */
    }

    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var coarsePointer = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    var smallViewport = window.matchMedia('(max-width: 860px)');

    function isMobile() {
      return coarsePointer || smallViewport.matches;
    }

    function sourceFor() {
      return isMobile() && mobileClip ? mobileClip : clip;
    }

    var state = {
      current: 0,
      target: 0,
      start: 0,
      end: 0,
      ready: false,
      loading: false,
      failed: false,
      loadedSource: null,
      video: null,
      objectUrl: null,
      abort: null
    };

    var rootTop = 0;
    var total = 1;
    var viewportHeight = window.innerHeight;
    var layoutWidth = window.innerWidth;
    var dirty = true;
    var frame = 0;
    var userReady = false;
    var destroyed = false;

    var running = false;
    var visible = true;
    var lastFrameTime = 0;

    var seekPending = false;
    var seekIssuedAt = 0;
    var seekGen = 0;         /* invalidates a seek the watchdog gave up on */
    var shownIndex = -1;     /* frame index we believe is on screen */

    var bar = root.querySelector('.scroll-scrub__progress span');
    var lastBar = -1;
    var scrolled = false;
    var observer = null;

    function unloadClip() {
      if (state.abort) state.abort.abort();
      if (state.video) state.video.remove();
      if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
      state.abort = null;
      state.video = null;
      state.objectUrl = null;
      state.loadedSource = null;
      state.loading = false;
      state.ready = false;
      state.failed = false;
      state.current = state.target;
      seekPending = false;
      shownIndex = -1;
      delete layer.dataset.videoPainted;
      delete layer.dataset.videoFailed;
    }

    /* iOS will not paint a seek on a video that has never been played, so the
     * first user gesture gets a play/pause pair. Silent failure is fine — the
     * poster stays up and a later gesture retries. */
    function primeVideo(video) {
      if (!video || !isMobile()) return;
      var played = video.play();
      if (played && played.then) {
        played.then(function () { video.pause(); }).catch(function () {});
      } else {
        try { video.pause(); } catch (e) {}
      }
    }

    function loadClip() {
      var source = sourceFor();
      if (reduceMotion || destroyed || state.loading || state.ready || state.failed || !source) {
        return;
      }

      state.loading = true;
      state.loadedSource = source;
      state.abort = new AbortController();
      var request = state.abort;

      fetch(source, { signal: request.signal })
        .then(function (response) {
          if (!response.ok) throw new Error('Clip failed: ' + response.status);
          return response.blob();
        })
        .then(function (blob) {
          if (destroyed || request.signal.aborted || state.loadedSource !== source) return;

          var objectUrl = URL.createObjectURL(blob);
          var video = document.createElement('video');
          video.className = 'scroll-scrub__video';
          video.muted = true;
          video.playsInline = true;
          video.preload = 'auto';
          video.setAttribute('muted', '');
          video.setAttribute('playsinline', '');
          video.src = objectUrl;

          video.addEventListener('loadedmetadata', function () {
            if (state.video !== video || state.loadedSource !== source) return;
            state.ready = true;
            state.loading = false;
            /* Land on wherever the visitor already is. Someone who reloaded
             * mid-page, or followed #the-crate, would otherwise start at frame
             * zero and seek the whole way there. */
            readScroll();
            state.current = state.target;
            shownIndex = -1;
            dirty = true;
            kick();
          }, { once: true });

          video.addEventListener('loadeddata', function () {
            if (userReady && state.video === video && state.loadedSource === source) {
              primeVideo(video);
            }
          }, { once: true });

          video.addEventListener('error', function () {
            if (state.video !== video) return;
            video.remove();
            URL.revokeObjectURL(objectUrl);
            state.video = null;
            state.objectUrl = null;
            state.failed = true;
            state.loading = false;
            state.ready = false;
            delete layer.dataset.videoPainted;
            layer.dataset.videoFailed = 'true';
          }, { once: true });

          /* Lift the poster on the first frame the compositor actually shows.
           * `seeked` fires when the element's internal seek finishes, which in
           * Chrome is before the frame is on screen; rVFC fires on presentation,
           * which is what this flag is really asserting. Race both — Firefox
           * has no rVFC, and rVFC alone would never fire if a seek resolved to
           * the frame already displayed. */
          var painted = false;
          function markPainted() {
            if (painted || state.video !== video || state.loadedSource !== source) return;
            painted = true;
            layer.dataset.videoPainted = 'true';
          }
          if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(markPainted);
          video.addEventListener('seeked', markPainted, { once: true });

          layer.appendChild(video);
          state.objectUrl = objectUrl;
          state.video = video;
        })
        .catch(function (error) {
          if (request.signal.aborted || error.name === 'AbortError' || state.loadedSource !== source) {
            return;
          }
          layer.dataset.videoFailed = 'true';
          state.failed = true;
          state.loading = false;
        });
    }

    function layout() {
      var pageY = window.scrollY || window.pageYOffset;
      rootTop = root.getBoundingClientRect().top + pageY;
      viewportHeight = window.innerHeight;
      layoutWidth = window.innerWidth;

      /* Crossing the mobile breakpoint means the other encode should be used. */
      if (state.loadedSource && state.loadedSource !== sourceFor()) {
        unloadClip();
        loadClip();
      }

      var rect = band.getBoundingClientRect();
      state.start = rect.top + pageY - rootTop;
      state.end = state.start + rect.height;
      total = Math.max(state.end, viewportHeight);
      dirty = true;
      kick();
    }

    function readScroll() {
      var pageY = window.scrollY || window.pageYOffset;
      var y = clamp(pageY - rootTop, 0, total);
      var length = Math.max(state.end - state.start, 1);
      var local = clamp((y - state.start) / length);

      state.target = linger ? lingerEase(local, linger) : local;

      /* On the bar itself, not on the section. An unregistered custom property
       * inherits, so setting it on the root invalidated style for the whole
       * hero subtree every frame — including the pinned copy and its
       * full-bleed gradient scrim, which then had to be re-rastered. */
      var p = Math.round(clamp(y / total) * 1000) / 1000;
      if (bar && p !== lastBar) {
        lastBar = p;
        bar.style.setProperty('--ss-progress', String(p));
      }

      var isScrolled = y > viewportHeight * 0.15;
      if (isScrolled !== scrolled) {
        scrolled = isScrolled;
        if (isScrolled) root.dataset.scrolled = 'true';
        else delete root.dataset.scrolled;
      }
    }

    /* ------------------------------------------------- playhead pipeline --- */

    function lastFrameIndex(video) {
      var n = FRAMES > 0 ? FRAMES : Math.round((video.duration || 1) * FPS);
      return Math.max(0, n - 1);
    }

    /* Advance the smoothing in real time, whether or not a seek is in flight.
     * The old code returned early on video.seeking, which froze the filter for
     * the whole decode and then took a single 20% bite out of a target that had
     * run away in the meantime — that is the visible stepping. */
    function advance(now) {
      var dt = lastFrameTime ? (now - lastFrameTime) / 1000 : 0;
      lastFrameTime = now;
      if (dt > 0.05) dt = 0.05;   /* tab switch — don't fast-forward the filter */

      var delta = state.target - state.current;
      if (Math.abs(delta) > SNAP) state.current = state.target;
      else if (dt > 0) state.current += delta * (1 - Math.exp(-SMOOTH * dt));
    }

    function settleSeek(video, index, generation) {
      var done = false;
      var handle = 0;

      function settle() {
        if (done) return;
        done = true;
        video.removeEventListener('seeked', settle);
        if (handle && video.cancelVideoFrameCallback) {
          try { video.cancelVideoFrameCallback(handle); } catch (e) {}
        }
        /* A seek the watchdog already gave up on can still land late. Applying
         * it would clobber the state of whatever is in flight now. */
        if (destroyed || state.video !== video || generation !== seekGen) return;
        seekPending = false;
        shownIndex = index;
        /* Issue the next seek straight away rather than waiting for the next
         * rAF — the decoder stays busy instead of idling up to 16ms per frame. */
        pump();
      }

      /* Chain on presentation, not on `seeked`. In Chrome `seeked` fires when
       * the element's internal seek finishes, which is before the frame is on
       * screen — chaining on it lets the pipeline outrun the compositor and
       * spend decodes on frames that are superseded before anyone sees them.
       * rVFC is the true painted signal. Where it does not exist, `seeked` is
       * the best available; where it does, the watchdog covers the case of a
       * seek that resolves to the frame already displayed. */
      if (video.requestVideoFrameCallback) {
        handle = video.requestVideoFrameCallback(settle);
      } else {
        video.addEventListener('seeked', settle);
      }
    }

    /* Land on the centre of a real frame. The old epsilon was 0.008s — a fifth
     * of a frame at 24fps — so most writes cost a full decode and painted the
     * picture that was already on screen, while delaying the seek that would
     * have changed it. The source is 24fps, so quantising removes no state the
     * viewer could ever have seen. */
    function pump() {
      var video = state.video;
      if (!video || !state.ready || seekPending) return;

      var wanted = Math.round(clamp(state.current) * lastFrameIndex(video));
      if (wanted === shownIndex) return;

      seekPending = true;
      seekGen++;
      seekIssuedAt = window.performance ? window.performance.now() : Date.now();
      try {
        video.currentTime = (wanted + 0.5) / FPS;
        settleSeek(video, wanted, seekGen);
      } catch (e) {
        seekPending = false;
      }
    }

    function tick(now) {
      if (destroyed) return;
      if (dirty) {
        dirty = false;
        readScroll();
      }
      advance(now);

      /* WebKit occasionally drops `seeked`. Without this, one lost event would
       * latch the pipeline shut for the life of the page. */
      if (seekPending && (now - seekIssuedAt) > SEEK_TIMEOUT) {
        seekPending = false;
        seekGen++;
        shownIndex = -1;
      }
      pump();

      /* Nothing is moving and nothing is in flight — stop burning frames. */
      if (!dirty && !seekPending && Math.abs(state.target - state.current) < 1e-4) {
        running = false;
        frame = 0;
        lastFrameTime = 0;
        return;
      }
      frame = window.requestAnimationFrame(tick);
    }

    function kick() {
      if (running || destroyed || !visible) return;
      running = true;
      lastFrameTime = 0;   /* dt restarts from this frame, so no jump on resume */
      frame = window.requestAnimationFrame(tick);
    }

    function onScroll() {
      dirty = true;
      kick();
    }

    /* Mobile browsers fire resize when the URL bar hides. Re-laying out on that
     * causes a visible jump, so only react to genuine width changes. */
    function onResize() {
      if (coarsePointer && window.innerWidth === layoutWidth) return;
      layout();
    }

    function onFirstGesture() {
      if (userReady) return;
      userReady = true;
      primeVideo(state.video);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', layout);
    window.addEventListener('pointerdown', onFirstGesture, { once: true, passive: true });
    window.addEventListener('touchstart', onFirstGesture, { once: true, passive: true });

    /* The loop used to run from DOMContentLoaded to unload, including while the
     * hero was nowhere near the viewport. `visible` starts true so init works
     * before the observer's first async callback corrects it. */
    if (window.IntersectionObserver) {
      observer = new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) {
          dirty = true;
          kick();
        } else if (frame) {
          window.cancelAnimationFrame(frame);
          frame = 0;
          running = false;
        }
      }, { rootMargin: '250px 0px' });
      observer.observe(root);
    }

    layout();
    loadClip();
    kick();

    return function destroy() {
      destroyed = true;
      window.cancelAnimationFrame(frame);
      if (observer) observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', layout);
      window.removeEventListener('pointerdown', onFirstGesture);
      window.removeEventListener('touchstart', onFirstGesture);
      unloadClip();
      if (bar) bar.style.removeProperty('--ss-progress');
    };
  }

  function init() {
    gfScrollScrub(document.querySelector('.scroll-scrub'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.gfScrollScrub = gfScrollScrub;
})();
