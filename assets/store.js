/* GoofiesEyes store: catalogue, cart and the three store pages.
 *
 * Catalogue = prints.json (photographs, written by the admin portal) merged
 * with store.json (everything else: digital products, merch). Each page sets
 * <body data-gf-store="storefront|product|cart"> and this file renders it.
 *
 * Prices shown here are for display only. api/create-checkout-session.js
 * re-reads both catalogues and prices every line itself, so an edited cart in
 * localStorage cannot change what anyone pays.
 *
 * Loaded with `defer` after site.js, so window.gf (escape, printName,
 * printAlt) normally exists by the time this runs; every use is still guarded
 * because /assets/* is cached for an hour and a stale site.js can pair with a
 * fresh page right after a deploy.
 */
(function () {
  'use strict';

  var CART_KEY = 'gf-cart-v1';
  var MAX_QTY = 10;
  var MAX_LINES = 20;

  /* ── helpers ─────────────────────────────────────────────────────────── */

  function esc(value) {
    if (window.gf && window.gf.escape) return window.gf.escape(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function money(n) {
    n = Number(n) || 0;
    return '$' + (n % 1 === 0 ? n.toFixed(0) : n.toFixed(2));
  }

  function byId(id) { return document.getElementById(id); }

  var ARROW =
    '<svg aria-hidden="true" viewBox="0 0 24 12" width="20" height="10" fill="none">' +
    '<path d="M0 6h22M17 1l5 5-5 5" stroke="currentColor" stroke-width="1"/></svg>';

  /* ── catalogue ───────────────────────────────────────────────────────── */

  function fromPrint(print) {
    var named = window.gf && window.gf.printName
      ? window.gf.printName(print)
      : { heading: print.title || print.portfolioName || 'Fine art print', sub: print.portfolioName || '' };
    var alt = window.gf && window.gf.printAlt
      ? window.gf.printAlt(print)
      : (print.alt || print.title || '');

    var hasSizes = !!(print.sizes && print.sizes.length);
    var physical = print.physicalPrice != null ? print.physicalPrice : (print.price || 0);
    var digital = print.digitalPrice != null ? print.digitalPrice : (print.price || 0);

    var formats = {};
    if (hasSizes && physical > 0) formats.physical = { label: 'Fine art print', price: physical, sizes: print.sizes.slice() };
    if (digital > 0) formats.digital = { label: 'Digital file', price: digital };

    var prices = Object.keys(formats).map(function (k) { return formats[k].price; });

    return {
      id: print.filename,
      collection: 'prints',
      kind: 'print',
      status: 'live',
      title: named.heading,
      subtitle: named.sub,
      image: '/content/photos/' + print.filename,
      imageAlt: alt,
      description: 'Limited edition fine art print' +
        (print.portfolioName ? ' from the ' + print.portfolioName + ' series' : '') +
        '. Archival paper, signed and numbered. Also available as a full-resolution digital file.',
      formats: formats,
      fromPrice: prices.length ? Math.min.apply(null, prices) : 0,
      multiplePrices: prices.length > 1 || hasSizes
    };
  }

  function fromStoreItem(item) {
    var price = Number(item.price) || 0;
    var formats = {};
    formats[item.kind === 'merch' ? 'physical' : 'digital'] = {
      label: item.kind === 'merch' ? 'Merch' : 'Digital download',
      price: price,
      sizes: item.sizes || null
    };
    return {
      id: item.id,
      collection: item.collection || (item.kind === 'merch' ? 'merch' : 'digital'),
      kind: item.kind,
      status: item.status || 'live',
      featured: !!item.featured,
      badge: item.badge || '',
      title: item.title,
      subtitle: item.subtitle || '',
      image: item.image,
      imageLarge: item.imageLarge || item.image,
      imageAlt: item.imageAlt || item.title,
      description: item.description || '',
      includes: item.includes || [],
      formats: formats,
      fromPrice: price,
      multiplePrices: !!(item.sizes && item.sizes.length > 1)
    };
  }

  var catalogue = null;

  function loadCatalogue() {
    if (catalogue) return catalogue;
    function get(url) {
      return fetch(url).then(function (res) {
        if (!res.ok) throw new Error(url + ' ' + res.status);
        return res.json();
      });
    }
    catalogue = Promise.all([
      get('/content/data/prints.json'),
      // A missing store.json must not take the prints down with it.
      get('/content/data/store.json').catch(function () { return { collections: [], products: [] }; })
    ]).then(function (both) {
      var prints = (both[0].prints || []).map(fromPrint);
      var others = (both[1].products || []).map(fromStoreItem);
      var products = others.concat(prints);
      var index = {};
      products.forEach(function (p) { index[p.id] = p; });
      return {
        collections: both[1].collections || [],
        products: products,
        get: function (id) { return index[id] || null; }
      };
    });
    return catalogue;
  }

  /* ── cart (localStorage) ─────────────────────────────────────────────── */

  function readCart() {
    try {
      var lines = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
      return Array.isArray(lines) ? lines.filter(function (l) { return l && l.id && l.format; }) : [];
    } catch (e) {
      return [];
    }
  }

  function writeCart(lines) {
    try { localStorage.setItem(CART_KEY, JSON.stringify(lines.slice(0, MAX_LINES))); } catch (e) { /* private mode */ }
    updateCount();
  }

  function lineKey(l) { return l.id + '|' + l.format + '|' + (l.size || ''); }

  function addToCart(item) {
    var lines = readCart();
    var key = lineKey(item);
    var existing = lines.filter(function (l) { return lineKey(l) === key; })[0];
    if (existing) {
      // One copy of a file is all anyone needs.
      existing.qty = item.format === 'digital' ? 1 : Math.min(MAX_QTY, (existing.qty || 1) + (item.qty || 1));
    } else {
      lines.push({ id: item.id, format: item.format, size: item.size || null, qty: item.format === 'digital' ? 1 : Math.min(MAX_QTY, item.qty || 1) });
    }
    writeCart(lines);
  }

  function cartCount() {
    return readCart().reduce(function (n, l) { return n + (l.qty || 1); }, 0);
  }

  function updateCount() {
    var n = cartCount();
    document.querySelectorAll('[data-gf-cart-count]').forEach(function (el) {
      el.textContent = n ? '(' + n + ')' : '';
    });
  }

  /* ── storefront ──────────────────────────────────────────────────────── */

  function priceLabel(p) {
    if (p.status === 'coming-soon') return p.fromPrice === 0 ? 'Free · Coming soon' : 'Coming soon';
    if (p.fromPrice === 0) return 'Free';
    return (p.multiplePrices ? 'From ' : '') + money(p.fromPrice);
  }

  function tile(p) {
    var href = 'product.html?id=' + encodeURIComponent(p.id);
    var square = p.kind !== 'print';
    return '' +
      '<a class="gf-tile' + (p.featured ? ' gf-tile--featured' : '') + '" href="' + esc(href) + '">' +
        '<div class="gf-tile-img' + (square ? ' gf-tile-img--square' : '') + '">' +
          '<img src="' + esc(p.image) + '" alt="' + esc(p.imageAlt) + '" loading="lazy" decoding="async">' +
          (p.badge ? '<span class="gf-tile-badge">' + esc(p.badge) + '</span>' : '') +
        '</div>' +
        '<div class="gf-tile-body">' +
          '<h3>' + esc(p.title) + '</h3>' +
          (p.subtitle ? '<p class="gf-tile-sub">' + esc(p.subtitle) + '</p>' : '') +
          '<p class="gf-tile-price"><span>' + esc(priceLabel(p)) + '</span>' + ARROW + '</p>' +
        '</div>' +
      '</a>';
  }

  function soonTile(collection) {
    return '' +
      '<div class="gf-tile gf-tile--soon">' +
        '<div class="gf-tile-img gf-tile-img--square gf-tile-soon">' +
          '<span class="gf-tile-badge">Coming soon</span>' +
          '<span class="gf-tile-soon-title">' + esc(collection.name) + '</span>' +
        '</div>' +
        '<div class="gf-tile-body">' +
          '<h3>' + esc(collection.name) + '</h3>' +
          '<p class="gf-tile-sub">' + esc(collection.blurb || 'Coming soon.') + '</p>' +
        '</div>' +
      '</div>';
  }

  function initStorefront() {
    var grid = byId('store-grid');
    var tabs = byId('store-tabs');
    var blurb = byId('store-blurb');

    loadCatalogue().then(function (cat) {
      var collections = [{ id: 'all', name: 'All' }].concat(cat.collections);

      function show(id) {
        if (!collections.some(function (c) { return c.id === id; })) id = 'all';

        tabs.querySelectorAll('button').forEach(function (b) {
          b.setAttribute('aria-pressed', String(b.dataset.c === id));
        });

        var col = collections.filter(function (c) { return c.id === id; })[0];
        blurb.textContent = col.blurb || '';
        blurb.hidden = !col.blurb;

        var html = '';
        if (id === 'all') {
          // Featured first, then each collection in catalogue order, then a
          // "coming soon" card for any collection with nothing in it yet.
          var featured = cat.products.filter(function (p) { return p.featured; });
          var rest = [];
          cat.collections.forEach(function (c) {
            rest = rest.concat(cat.products.filter(function (p) { return !p.featured && p.collection === c.id; }));
          });
          html = featured.concat(rest).map(tile).join('');
          cat.collections.forEach(function (c) {
            if (!cat.products.some(function (p) { return p.collection === c.id; })) html += soonTile(c);
          });
        } else {
          var items = cat.products.filter(function (p) { return p.collection === id; });
          html = items.length ? items.map(tile).join('') : soonTile(col);
        }
        grid.innerHTML = html;

        var url = new URL(window.location.href);
        if (id === 'all') url.searchParams.delete('c'); else url.searchParams.set('c', id);
        history.replaceState(null, '', url);
      }

      tabs.innerHTML = collections.map(function (c) {
        return '<button type="button" class="gf-tab" data-c="' + esc(c.id) + '" aria-pressed="false">' + esc(c.name) + '</button>';
      }).join('');
      tabs.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-c]');
        if (b) show(b.dataset.c);
      });

      show(new URLSearchParams(window.location.search).get('c') || 'all');
    }).catch(function (err) {
      grid.innerHTML = '<p class="gf-state">The store could not be loaded. Please refresh.</p>';
      console.error(err);
    });
  }

  /* ── product page ────────────────────────────────────────────────────── */

  function initProduct() {
    var params = new URLSearchParams(window.location.search);
    var id = params.get('id');
    if (!id) { window.location.replace('store.html'); return; }

    loadCatalogue().then(function (cat) {
      var p = cat.get(id);
      if (!p) { window.location.replace('store.html'); return; }

      document.title = p.title + (p.subtitle ? ' · ' + p.subtitle : '') + ' | GoofiesEyes';
      var crumb = cat.collections.filter(function (c) { return c.id === p.collection; })[0];
      var back = byId('product-back');
      back.href = 'store.html' + (crumb ? '?c=' + encodeURIComponent(crumb.id) : '');
      byId('product-back-label').textContent = 'Back to ' + (crumb ? crumb.name.toLowerCase() : 'store');

      var img = byId('product-img');
      img.src = p.imageLarge || p.image;
      img.alt = p.imageAlt;
      byId('product-img-wrap').classList.toggle('gf-product-img--square', p.kind !== 'print');

      byId('product-kicker').textContent = p.subtitle || (crumb ? crumb.name : '');
      byId('product-title').textContent = p.title;
      byId('product-desc').textContent = p.description;

      if (p.includes && p.includes.length) {
        byId('product-includes').innerHTML = p.includes.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
        byId('product-includes-wrap').hidden = false;
      }

      if (p.status === 'coming-soon') {
        byId('product-price').textContent = priceLabel(p);
        byId('product-buy').hidden = true;
        byId('product-notify').hidden = false;
        initNotify(p);
        return;
      }

      var formatKeys = Object.keys(p.formats);
      var state = {
        format: formatKeys.indexOf(params.get('format')) >= 0 ? params.get('format') : formatKeys[0],
        size: null,
        qty: 1
      };

      var formatWrap = byId('product-formats');
      if (formatKeys.length > 1) {
        formatWrap.innerHTML = formatKeys.map(function (k) {
          return '<button type="button" class="gf-size" data-format="' + esc(k) + '" aria-pressed="false">' +
            esc(p.formats[k].label) + '</button>';
        }).join('');
        byId('product-format-section').hidden = false;
        formatWrap.addEventListener('click', function (e) {
          var b = e.target.closest('[data-format]');
          if (!b) return;
          state.format = b.dataset.format;
          state.size = null;
          render();
        });
      }

      byId('product-sizes').addEventListener('click', function (e) {
        var b = e.target.closest('[data-size]');
        if (!b) return;
        state.size = b.dataset.size;
        render();
      });

      byId('product-qty').addEventListener('change', function (e) {
        state.qty = Math.max(1, Math.min(MAX_QTY, parseInt(e.target.value, 10) || 1));
        e.target.value = state.qty;
      });

      function render() {
        var f = p.formats[state.format];
        formatWrap.querySelectorAll('[data-format]').forEach(function (b) {
          b.setAttribute('aria-pressed', String(b.dataset.format === state.format));
        });

        var sizes = f.sizes || [];
        byId('product-size-section').hidden = !sizes.length;
        if (sizes.length && sizes.indexOf(state.size) < 0) state.size = sizes[0];
        byId('product-sizes').innerHTML = sizes.map(function (s) {
          return '<button type="button" class="gf-size" data-size="' + esc(s) + '" aria-pressed="' +
            String(s === state.size) + '">' + esc(s) + '</button>';
        }).join('');

        // A file is bought once; quantity only means something for objects.
        byId('product-qty-section').hidden = state.format === 'digital';
        byId('product-price').textContent = money(f.price);
        byId('product-delivery').textContent = state.format === 'digital'
          ? 'Full-resolution file, emailed within 24 hours of payment.'
          : 'Made to order and shipped. Shipping and any tax are added at checkout.';
      }

      byId('product-add').addEventListener('click', function () {
        addToCart({ id: p.id, format: state.format, size: state.size, qty: state.qty });
        byId('product-added').hidden = false;
        byId('product-add-label').textContent = 'Add another';
      });

      render();
      byId('product-buy').hidden = false;
    }).catch(function (err) {
      byId('product-title').textContent = 'This product could not be loaded.';
      console.error(err);
    });
  }

  /* Notify-me list for coming-soon products. Reuses the contact endpoint
     (api/request-pressing.js, kind "pack"), so each signup is an email to the
     GoofiesEyes inbox naming the product. */
  function initNotify(p) {
    var form = byId('notify-form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = byId('notify-name').value.trim();
      var email = byId('notify-email').value.trim();
      var error = byId('notify-error');
      var button = byId('notify-submit');
      error.hidden = true;

      var problems = [];
      if (!name) problems.push('your first name');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.push('a valid email');
      if (problems.length) {
        error.textContent = 'Please add ' + problems.join(' and ') + '.';
        error.hidden = false;
        return;
      }

      button.disabled = true;
      button.textContent = 'Sending…';

      fetch('/api/request-pressing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'pack',
          name: name,
          email: email,
          website: form.elements.website.value,
          message: 'Notify me when "' + p.title + '" (' + p.id + ') is out.'
        })
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            if (!res.ok || !data.ok) throw new Error(data.error || 'Could not send');
          });
        })
        .then(function () {
          form.querySelectorAll('.gf-field, #notify-submit').forEach(function (el) { el.hidden = true; });
          byId('notify-done').hidden = false;
        })
        .catch(function (err) {
          button.disabled = false;
          button.textContent = 'Notify me';
          error.textContent = 'Something went wrong: ' + err.message + '. Please try again.';
          error.hidden = false;
          console.error(err);
        });
    });
  }

  /* ── cart page ───────────────────────────────────────────────────────── */

  function initCart() {
    var list = byId('cart-lines');

    loadCatalogue().then(function (cat) {
      function resolved() {
        // Drop anything that has left the catalogue or can no longer be bought
        // in that format/size, so the page never shows a line checkout would
        // reject.
        var kept = readCart().filter(function (l) {
          var p = cat.get(l.id);
          var f = p && p.status === 'live' && p.formats[l.format];
          if (!f || !(f.price > 0)) return false;
          if (f.sizes && f.sizes.length && f.sizes.indexOf(l.size) < 0) return false;
          return true;
        });
        if (kept.length !== readCart().length) writeCart(kept);
        return kept.map(function (l) {
          var p = cat.get(l.id);
          return { line: l, product: p, format: p.formats[l.format] };
        });
      }

      function render() {
        var rows = resolved();
        byId('cart-empty').hidden = rows.length > 0;
        byId('cart-full').hidden = rows.length === 0;
        if (!rows.length) return;

        var subtotal = 0;
        var anyPhysical = false;
        list.innerHTML = rows.map(function (r, i) {
          var qty = r.line.qty || 1;
          var lineTotal = r.format.price * qty;
          subtotal += lineTotal;
          if (r.line.format !== 'digital') anyPhysical = true;
          var meta = [r.format.label, r.line.size].filter(Boolean).join(' · ');
          return '' +
            '<li class="gf-cart-line">' +
              '<a class="gf-cart-img" href="product.html?id=' + esc(encodeURIComponent(r.product.id)) + '">' +
                '<img src="' + esc(r.product.image) + '" alt="' + esc(r.product.imageAlt) + '" loading="lazy">' +
              '</a>' +
              '<div class="gf-cart-info">' +
                '<h3>' + esc(r.product.title) + '</h3>' +
                '<p class="gf-tile-sub">' + esc([r.product.subtitle, meta].filter(Boolean).join(' · ')) + '</p>' +
                '<div class="gf-cart-controls">' +
                  (r.line.format === 'digital'
                    ? '<span class="gf-tile-sub">Qty 1</span>'
                    : '<label class="gf-cart-qty"><span class="gf-tile-sub">Qty</span>' +
                      '<input type="number" min="1" max="' + MAX_QTY + '" value="' + qty + '" data-i="' + i + '"></label>') +
                  '<button type="button" class="gf-cart-remove" data-remove="' + i + '">Remove</button>' +
                '</div>' +
              '</div>' +
              '<div class="gf-cart-price">' + money(lineTotal) + '</div>' +
            '</li>';
        }).join('');

        byId('cart-subtotal').textContent = money(subtotal);
        byId('cart-shipping').textContent = anyPhysical ? 'At checkout' : 'Digital · emailed';
      }

      list.addEventListener('click', function (e) {
        var b = e.target.closest('[data-remove]');
        if (!b) return;
        var lines = resolved().map(function (r) { return r.line; });
        lines.splice(Number(b.dataset.remove), 1);
        writeCart(lines);
        render();
      });

      list.addEventListener('change', function (e) {
        var input = e.target.closest('input[data-i]');
        if (!input) return;
        var lines = resolved().map(function (r) { return r.line; });
        var line = lines[Number(input.dataset.i)];
        if (line) line.qty = Math.max(1, Math.min(MAX_QTY, parseInt(input.value, 10) || 1));
        writeCart(lines);
        render();
      });

      byId('cart-checkout').addEventListener('click', function () {
        var button = byId('cart-checkout');
        var label = byId('cart-checkout-label');
        var error = byId('cart-error');
        var email = byId('cart-email').value.trim();
        error.hidden = true;

        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          error.textContent = 'That email does not look right. Fix it or leave it blank and add it on the next step.';
          error.hidden = false;
          return;
        }

        var items = resolved().map(function (r) {
          return { productId: r.line.id, type: r.line.format, size: r.line.size, quantity: r.line.qty || 1 };
        });
        if (!items.length) return;

        button.disabled = true;
        label.textContent = 'Redirecting…';

        fetch('/api/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: items, customerEmail: email || undefined })
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (!data.url) throw new Error(data.error || 'Unexpected error');
            window.location.href = data.url;
          })
          .catch(function (err) {
            button.disabled = false;
            label.textContent = 'Checkout';
            error.textContent = 'Something went wrong: ' + err.message + '. Please try again.';
            error.hidden = false;
            console.error(err);
          });
      });

      render();
    }).catch(function (err) {
      byId('cart-empty').hidden = false;
      byId('cart-empty').textContent = 'The cart could not be loaded. Please refresh.';
      console.error(err);
    });
  }

  /* ── boot ────────────────────────────────────────────────────────────── */

  window.gfStore = {
    load: loadCatalogue,
    add: addToCart,
    read: readCart,
    clear: function () { writeCart([]); }
  };

  function boot() {
    updateCount();
    var page = document.body.getAttribute('data-gf-store');
    if (page === 'storefront') initStorefront();
    else if (page === 'product') initProduct();
    else if (page === 'cart') initCart();
  }

  // Another tab changed the cart.
  window.addEventListener('storage', function (e) { if (e.key === CART_KEY) updateCount(); });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
