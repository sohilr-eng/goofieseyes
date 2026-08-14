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
            dirty = true;
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

          video.addEventListener('seeked', function () {
            if (state.video === video && state.loadedSource === source) {
              layer.dataset.videoPainted = 'true';
            }
          }, { once: true });

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
    }

    function readScroll() {
      var pageY = window.scrollY || window.pageYOffset;
      var y = clamp(pageY - rootTop, 0, total);
      var length = Math.max(state.end - state.start, 1);
      var local = clamp((y - state.start) / length);

      state.target = linger ? lingerEase(local, linger) : local;
      root.style.setProperty('--ss-progress', String(clamp(y / total)));
      if (y > viewportHeight * 0.15) root.dataset.scrolled = 'true';
      else delete root.dataset.scrolled;
    }

    function updateVideo() {
      var video = state.video;
      if (!video || !state.ready || video.seeking) return;

      state.current += (state.target - state.current) * 0.2;
      var targetTime = clamp(state.current, 0, 0.999) * (video.duration || 1);
      /* Writing currentTime for sub-frame deltas makes Safari thrash. */
      var epsilon = isMobile() ? 0.02 : 0.008;
      if (Math.abs(video.currentTime - targetTime) > epsilon) {
        try {
          video.currentTime = targetTime;
        } catch (e) {
          /* Keep the last painted frame while the browser catches up. */
        }
      }
    }

    function tick() {
      if (destroyed) return;
      if (dirty) {
        dirty = false;
        readScroll();
      }
      updateVideo();
      frame = window.requestAnimationFrame(tick);
    }

    function onScroll() {
      dirty = true;
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

    layout();
    loadClip();
    frame = window.requestAnimationFrame(tick);

    return function destroy() {
      destroyed = true;
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', layout);
      window.removeEventListener('pointerdown', onFirstGesture);
      window.removeEventListener('touchstart', onFirstGesture);
      unloadClip();
      root.style.removeProperty('--ss-progress');
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
