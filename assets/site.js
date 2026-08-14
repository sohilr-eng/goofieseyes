/* goofieseyes — shared behaviour.
 *
 * Loaded by every page. Everything here is namespaced under `gf` / `.gf-*` and
 * is inert on pages that have not been converted to the record-crate markup.
 *
 * The album derivation below is the single source of truth for catalogue
 * numbers and pigments. index.html, portfolios.html and collection.html all
 * call it so they can never disagree about what "GE-004" means.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------ albums ---- */

  /* The four pigments from the design brief, in cycle order. */
  var GF_PIGMENTS = ['coral', 'sakura', 'chartreuse', 'teal'];

  /* Taste escape hatch: force a specific collection to a specific pigment.
   * Lives here in code, not in portfolios.json, because the admin app creates
   * new portfolios with a fixed shape and would never carry such a field.
   * Anything not listed falls back to the round-robin cycle. */
  var GF_PIGMENT_OVERRIDES = {};

  /* Portfolio ids look like "tobago-1775076165587". The epoch suffix is the
   * creation time and is the only reliable ordering we have — array order is
   * whatever the admin last wrote. Ids without a suffix sort last, and because
   * Array#sort is stable they keep their relative order. */
  function gfEpoch(portfolio) {
    var match = /-(\d{10,})$/.exec(portfolio.id || '');
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  }

  function gfEscape(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * Turn raw portfolios.json into the album shape the record-crate design wants.
   * Everything is derived — nothing here is stored in the JSON, so adding a
   * collection in the admin app needs no code change.
   */
  function gfAlbums(portfolios) {
    return (portfolios || [])
      .filter(function (p) {
        return (p.photos && p.photos.length) || p.cover;
      })
      .slice()
      .sort(function (a, b) {
        return gfEpoch(a) - gfEpoch(b);
      })
      .map(function (p, i) {
        var photos = (p.photos || []).slice().sort(function (a, b) {
          return (a.order == null ? 999 : a.order) - (b.order == null ? 999 : b.order);
        });
        var coverFile = p.cover || (photos[0] && photos[0].filename) || null;

        return {
          slug: p.slug,
          title: p.name || p.slug,
          note: p.description || '',
          catalogue: 'GE-' + String(i + 1).padStart(3, '0'),
          pigment: GF_PIGMENT_OVERRIDES[p.slug] || GF_PIGMENTS[i % GF_PIGMENTS.length],
          cover: coverFile ? '/content/photos/' + coverFile : null,
          frames: photos.length,
          photos: photos,
          href: 'collection.html?slug=' + encodeURIComponent(p.slug)
        };
      });
  }

  /** Fetch portfolios.json once per page and hand back derived albums. */
  var albumsPromise = null;
  function gfLoadAlbums() {
    if (!albumsPromise) {
      albumsPromise = fetch('/content/data/portfolios.json')
        .then(function (res) {
          if (!res.ok) throw new Error('portfolios.json ' + res.status);
          return res.json();
        })
        .then(function (data) {
          return gfAlbums(data.portfolios);
        });
    }
    return albumsPromise;
  }

  /** Markup for one record in a crate rail. */
  function gfRecordHTML(album) {
    var disc = album.cover
      ? '<img src="' + gfEscape(album.cover) + '" alt="' + gfEscape(album.title) +
        '" loading="lazy" decoding="async">'
      : '<span>' + gfEscape(album.catalogue) + '</span>';

    return '' +
      '<a class="gf-record" href="' + gfEscape(album.href) + '"' +
      ' style="--gf-label: var(--gf-' + album.pigment + ')">' +
      '<div class="gf-record-disc"' + (album.cover ? '' : ' data-empty="true"') + '>' +
      disc +
      '<span class="gf-record-label"></span>' +
      '</div>' +
      '<div class="gf-record-meta">' +
      '<div>' +
      '<h3>' + gfEscape(album.title) + '</h3>' +
      '<p>' + album.frames + (album.frames === 1 ? ' frame' : ' frames') + '</p>' +
      '</div>' +
      '<span class="gf-record-cat">' + gfEscape(album.catalogue) + '</span>' +
      '</div>' +
      '</a>';
  }

  /* ------------------------------------------------------- crate rails ---- */

  /**
   * Two shelf rails drifting in opposite directions as the visitor scrolls.
   *
   * The source design used a fixed travel distance, which slides the records
   * sideways and exposes bare paper whenever a rail is narrower than the
   * viewport (which it is, with only 3-4 records on a wide desktop). Travel is
   * clamped to the actual overflow here, so a rail that fits simply sits still.
   */
  function gfInitRails(wrap) {
    if (!wrap) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    var rails = [].slice.call(wrap.querySelectorAll('.gf-rail'));
    if (rails.length < 2) return;

    /* The page script calls this again once the records have been rendered —
     * the first call, from gfInit(), measures empty rails. That second call
     * needs a re-measure, not a second scroll listener and a second rAF chain
     * writing to the same two elements. */
    if (wrap.gfRails) {
      wrap.gfRails.measure();
      return;
    }

    var travels = [];
    var frame = 0;
    var visible = true;

    /* Reads only, and only when the geometry can actually have changed.
     * These used to be read inside the write loop below, which forced a
     * synchronous layout on every rail on every scroll frame. */
    function measure() {
      var vw = window.innerWidth;
      for (var i = 0; i < rails.length; i++) {
        var overflow = Math.max(0, rails[i].scrollWidth - rails[i].clientWidth);
        travels[i] = Math.min(340, vw * 0.34, overflow / 2);
      }
      schedule();
    }

    /* One read, then writes only. */
    function update() {
      frame = 0;
      var rect = wrap.getBoundingClientRect();
      var span = rect.height + window.innerHeight;
      if (span <= 0) return;
      var progress = Math.min(1, Math.max(0, (window.innerHeight - rect.top) / span));
      for (var i = 0; i < rails.length; i++) {
        var offset = (progress - 0.5) * 2 * travels[i];
        rails[i].style.transform =
          'translate3d(' + (i % 2 ? offset : -offset) + 'px,0,0)';
      }
    }

    function schedule() {
      if (frame || !visible) return;
      frame = window.requestAnimationFrame(update);
    }

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', measure);

    /* The crate sits a viewport below the hero, so this loop used to run for
     * the whole time the film was being scrubbed, for elements nobody could
     * see. */
    if (window.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) schedule();
        else if (frame) {
          window.cancelAnimationFrame(frame);
          frame = 0;
        }
      }, { rootMargin: '150px 0px' }).observe(wrap);
    }

    wrap.gfRails = { measure: measure };
    measure();
  }

  /* --------------------------------------------------------- mobile nav --- */

  function gfInitNav() {
    var burger = document.querySelector('.gf-burger');
    var menu = document.querySelector('.gf-mobile-menu');
    if (!burger || !menu) return;

    function setOpen(open) {
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      menu.classList.toggle('is-open', open);
      document.body.style.overflow = open ? 'hidden' : '';
    }

    burger.addEventListener('click', function () {
      setOpen(burger.getAttribute('aria-expanded') !== 'true');
    });

    menu.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') setOpen(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false);
    });
  }

  /* ------------------------------------------------------------- misc ----- */

  /* Carried over from the previous site: make casual image lifting awkward.
   * Not real protection, and deliberately not applied to the whole document. */
  function gfProtectImages() {
    document.addEventListener('contextmenu', function (e) {
      if (e.target.tagName === 'IMG') e.preventDefault();
    });
    document.addEventListener('dragstart', function (e) {
      if (e.target.tagName === 'IMG') e.preventDefault();
    });
  }

  /* Disc rotation mode, so the two candidates can be compared on the real page
   * with the real photographs. `?spin=full` / `?spin=label` / `?spin=hover`
   * sets it and remembers the choice; the markup default is "label". */
  function gfInitSpin() {
    var modes = ['label', 'full', 'hover', 'none'];
    var wanted = null;
    try {
      wanted = new URLSearchParams(window.location.search).get('spin');
      if (wanted && modes.indexOf(wanted) !== -1) {
        window.localStorage.setItem('gf-spin', wanted);
      } else {
        wanted = window.localStorage.getItem('gf-spin');
      }
    } catch (e) {
      /* private mode / blocked storage — fall through to the markup default */
    }
    if (wanted && modes.indexOf(wanted) !== -1) {
      document.documentElement.setAttribute('data-gf-spin', wanted);
    }
  }

  function gfInit() {
    gfInitSpin();
    gfInitNav();
    gfProtectImages();
    gfInitRails(document.querySelector('[data-gf-rails]'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', gfInit);
  } else {
    gfInit();
  }

  /* Exposed for page-level scripts. */
  window.gf = {
    albums: gfAlbums,
    loadAlbums: gfLoadAlbums,
    recordHTML: gfRecordHTML,
    escape: gfEscape,
    initRails: gfInitRails,
    PIGMENTS: GF_PIGMENTS
  };
})();
