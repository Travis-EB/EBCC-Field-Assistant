/* EBCC Field Assistant — auth gate + record sync + admin console.
 * Loaded (deferred) after the main app script. Adds a backend without changing
 * any existing calculator/ticket logic. Records mirror the app's localStorage
 * keys up to Azure; calculators stay local.
 */
(function () {
  'use strict';

  // localStorage key  ->  server record type
  var SYNC_MAP = {
    'ebcc_trucking_tickets_v1': 'trucking_tickets',
    'ebcc_load_count_v1': 'load_count',
    'ebcc_ewt_records_v1': 'ewt_records',
    'ebcc_ewt_drafts_v1': 'ewt_drafts',
    // Posted spreads (explicit snapshots for admin review)
    'ebcc_cpy_posts_v1': 'cpy_posts',
    'ebcc_flat_posts_v1': 'flat_posts',
    'ebcc_lime_posts_v1': 'lime_posts',
    'ebcc_flexbase_posts_v1': 'flexbase_posts',
    // Calculator tabs — synced so the admin can review them per user
    'ebcc_cpy_state_v1': 'cpy_state',
    'ebcc_flat_state_v1': 'flat_state',
    'ebcc_lime_state_v1': 'lime_state',
    'ebcc_flexbase_state_v1': 'flexbase_state'
  };
  var EWT_KEY = 'ebcc_ewt_records_v1';
  var DRAFTS_KEY = 'ebcc_ewt_drafts_v1';
  var PENDING_KEY = 'ebcc_sync_pending';
  var HYDRATED_FLAG = 'ebcc_hydrated_once';

  var ME = null;
  var pushTimers = {};
  // The native localStorage.setItem, captured before installSyncHooks wraps it.
  // (Kept in a closure var — properties assigned onto localStorage itself get
  // stringified, which would turn this function into useless text.)
  var origSetItem = localStorage.setItem.bind(localStorage);

  // ---------- small helpers ----------
  function apiFetch(url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(url, opts);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function getPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '{}'); } catch (e) { return {}; }
  }
  function setPending(p) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch (e) {}
  }

  // ---------- auth gate ----------
  function boot() {
    var debug = /[?&]debug=1/.test(window.location.search);
    var status = 0;
    // Read the user's full name from the login ticket claims (/.auth/me) and pass it
    // along so the server can store a friendly display name instead of the email.
    fetch('/.auth/me').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
    .then(function (auth) {
      var name = '';
      try {
        var claims = (auth && auth.clientPrincipal && auth.clientPrincipal.claims) || [];
        for (var i = 0; i < claims.length; i++) {
          var t = claims[i].typ;
          if (t === 'name' || t === 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name') {
            name = claims[i].val || '';
            break;
          }
        }
      } catch (e) {}
      return apiFetch('/api/me' + (name ? '?name=' + encodeURIComponent(name.slice(0, 80)) : ''));
    }).then(function (r) {
      status = r.status;
      return r.text();
    }).then(function (txt) {
      var me = null;
      try { me = JSON.parse(txt); } catch (e) {}
      if (debug) showDebug(status, txt);
      if (status === 401 || (me && me.authenticated === false)) {
        if (!debug) window.location.replace('/login.html');
        return;
      }
      if (!me) {
        // Non-JSON response means the auth layer redirected us (expired session).
        // Don't run half-featured — send the user back through sign-in.
        if (!debug) window.location.replace('/login.html');
        return;
      }
      if (me.disabled) { showDisabled(me); return; }
      ME = me;
      renderAccountMenu(me);
      if (me.isAdmin) enableAdmin();
      hydrateFromServer().then(function () {
        installSyncHooks();
        flushPending();
      });
    }).catch(function (e) {
      // Offline: let the app run on local data. Sync will retry when back online.
      if (debug) showDebug(status, 'fetch failed: ' + (e && e.message));
      installSyncHooks();
    });
  }

  function showDebug(status, txt) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:10px;right:10px;bottom:10px;z-index:99999;background:#111827;color:#e5e7eb;border-radius:12px;padding:14px;font:12px/1.5 monospace;box-shadow:0 8px 30px rgba(0,0,0,.4);word-break:break-all;max-height:45vh;overflow:auto';
    function localCount(key) {
      try { var v = JSON.parse(localStorage.getItem(key) || 'null'); return Array.isArray(v) ? v.length : (v ? 1 : 0); }
      catch (e) { return '?'; }
    }
    var syncLine = 'pending: ' + JSON.stringify(getPending()) +
      ' | local — spreads: ' + localCount('ebcc_cpy_posts_v1') +
      ', flat posts: ' + localCount('ebcc_flat_posts_v1') +
      ', ewt: ' + localCount('ebcc_ewt_records_v1') +
      ' | status: ' + ((document.getElementById('sync-status') || {}).textContent || '(menu closed)');
    box.innerHTML = '<div style="color:#fbbf24;font-weight:700;margin-bottom:6px">DIAGNOSTIC — /api/me (tap to close)</div>' +
      '<div>HTTP status: <b>' + status + '</b></div>' +
      '<div style="margin-top:6px">' + esc(String(txt).slice(0, 1200)) + '</div>' +
      '<div style="margin-top:6px;color:#93c5fd">SYNC — ' + esc(syncLine) + '</div>';
    box.addEventListener('click', function () { box.remove(); });
    document.body.appendChild(box);
  }

  function showDisabled(me) {
    var o = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#1851a2;color:#fff;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font-family:Inter,system-ui,sans-serif';
    o.innerHTML = '<div style="max-width:340px"><img src="/icons/icon-192.png" style="width:72px;height:72px;border-radius:16px;background:#fff;padding:6px"><h1 style="font-size:20px;margin:16px 0 8px">Access paused</h1>' +
      '<p style="font-size:14px;color:rgba(255,255,255,.8);line-height:1.5">Your account (' + esc(me.email) + ') is currently disabled. Contact your administrator to restore access.</p>' +
      '<a href="/.auth/logout?post_logout_redirect_uri=/login.html" style="display:inline-block;margin-top:20px;background:#fff;color:#1f2937;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:600">Sign out</a></div>';
    document.body.appendChild(o);
  }

  function applyTheme(mode) {
    if (mode === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('ebcc_theme', mode); } catch (e) {}
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', mode === 'dark' ? '#14181e' : '#ffffff');
  }

  function renderAccountMenu(me) {
    var el = document.getElementById('account-menu');
    if (!el) return;
    var initials = (me.name || me.email || '?').trim().slice(0, 1).toUpperCase();
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    el.innerHTML =
      '<button id="acct-btn" title="' + esc(me.email) + '" style="width:34px;height:34px;border-radius:50%;border:none;background:#23272e;color:#fff;font-weight:600;cursor:pointer;font-family:inherit">' + esc(initials) + '</button>' +
      '<div id="acct-pop" style="display:none;position:absolute;right:12px;margin-top:6px;background:var(--card,#fff);color:var(--ink,#1f2937);border:1px solid var(--border,#e5e7eb);border-radius:12px;box-shadow:0 8px 24px rgba(16,24,40,.16);padding:10px;min-width:200px;z-index:50">' +
        '<div style="font-weight:600;font-size:14px">' + esc(me.name || '') + '</div>' +
        '<div style="font-size:12px;color:var(--gray,#6b7280);margin-bottom:8px">' + esc(me.email) + (me.isAdmin ? ' · Admin' : '') + '</div>' +
        '<div id="sync-status" style="font-size:11px;color:#059669;margin-bottom:8px">All changes saved</div>' +
        '<label style="display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;font-weight:600;margin:0 0 10px;cursor:pointer">Dark mode' +
          '<input type="checkbox" id="theme-toggle"' + (isDark ? ' checked' : '') + ' style="width:18px;height:18px;accent-color:var(--orange,#2563eb);cursor:pointer">' +
        '</label>' +
        '<a href="/.auth/logout?post_logout_redirect_uri=/login.html" style="display:block;text-align:center;background:var(--soft,#f3f4f6);color:var(--ink,#1f2937);text-decoration:none;padding:8px;border-radius:8px;font-size:13px;font-weight:600">Sign out</a>' +
      '</div>';
    var btn = document.getElementById('acct-btn');
    var pop = document.getElementById('acct-pop');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      pop.style.display = pop.style.display === 'none' ? 'block' : 'none';
    });
    pop.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { if (pop) pop.style.display = 'none'; });
    var tt = document.getElementById('theme-toggle');
    if (tt) tt.addEventListener('change', function () { applyTheme(tt.checked ? 'dark' : 'light'); });
  }

  function setSyncStatus(text, color) {
    var el = document.getElementById('sync-status');
    if (el) { el.textContent = text; el.style.color = color || '#059669'; }
  }

  // ---------- EWT drafts: two-way merge across devices ----------
  // Same rules as the server: merge by draft id, newest savedAt wins, a
  // tombstone (deleted anywhere) always beats a live copy.
  function mergeDrafts(a, b) {
    var byId = {}, order = [];
    function consider(d) {
      if (!d || !d.id) return;
      var cur = byId[d.id];
      if (!cur) { byId[d.id] = d; order.push(d.id); return; }
      if (d.tombstone && !cur.tombstone) { byId[d.id] = d; return; }
      if (cur.tombstone && !d.tombstone) return;
      if (String(d.savedAt || d.deletedAt || '') > String(cur.savedAt || cur.deletedAt || '')) byId[d.id] = d;
    }
    (Array.isArray(a) ? a : []).forEach(consider);
    (Array.isArray(b) ? b : []).forEach(consider);
    var out = order.map(function (id) { return byId[id]; });
    out.sort(function (x, y) { return String(x.savedAt || x.deletedAt || '').localeCompare(String(y.savedAt || y.deletedAt || '')); });
    return out;
  }
  function readDraftsLocal() {
    try { var v = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  // Adopt a merged list locally (without re-triggering a push) and tell the
  // page so the Drafts list re-renders in place.
  function adoptDrafts(merged) {
    var before = localStorage.getItem(DRAFTS_KEY) || '[]';
    var after = JSON.stringify(merged);
    if (after === before) return false;
    // Use the ORIGINAL setItem so this write doesn't queue another push.
    origSetItem(DRAFTS_KEY, after);
    try { window.dispatchEvent(new CustomEvent('ebcc-drafts-updated')); } catch (e) {}
    return true;
  }
  var pullingDrafts = false;
  function pullDrafts() {
    if (!ME || pullingDrafts) return Promise.resolve();
    pullingDrafts = true;
    return apiFetch('/api/records').then(function (r) { return r.ok ? r.json() : null; }).then(function (res) {
      var server = res && res.records && res.records.ewt_drafts;
      var serverArr = server && Array.isArray(server.data) ? server.data : [];
      var local = readDraftsLocal();
      var merged = mergeDrafts(serverArr, local);
      adoptDrafts(merged);
      // If this device knew something the server didn't, push the merged view.
      if (JSON.stringify(merged) !== JSON.stringify(serverArr)) queuePush(DRAFTS_KEY);
    }).catch(function () {}).then(function () { pullingDrafts = false; });
  }
  window.addEventListener('ebcc-drafts-pull', function () { pullDrafts(); });

  // ---------- hydrate local from server (first device / cross-device) ----------
  function hydrateFromServer() {
    return apiFetch('/api/records').then(function (r) { return r.ok ? r.json() : null; }).then(function (res) {
      if (!res || !res.records) return;
      var changed = false;
      Object.keys(SYNC_MAP).forEach(function (lsKey) {
        var type = SYNC_MAP[lsKey];
        var server = res.records[type];
        if (!server || server.data == null) return;
        // Drafts always merge (both directions) — a foreman writes them on a
        // laptop and needs them on the phone even after the phone has its own.
        if (lsKey === DRAFTS_KEY) { adoptDrafts(mergeDrafts(server.data, readDraftsLocal())); return; }
        var local = localStorage.getItem(lsKey);
        var localEmpty = !local || local === '[]' || local === '{}' || local === 'null';
        // Only hydrate when local is empty — never clobber unsynced local edits.
        if (localEmpty) {
          localStorage.setItem(lsKey, JSON.stringify(server.data));
          changed = true;
        }
      });
      if (changed && !sessionStorage.getItem(HYDRATED_FLAG)) {
        sessionStorage.setItem(HYDRATED_FLAG, '1');
        window.location.reload();
      }
    }).catch(function () {});
  }

  // ---------- push local -> server ----------
  function installSyncHooks() {
    var origSet = origSetItem;
    localStorage.setItem = function (key, value) {
      origSet(key, value);
      if (SYNC_MAP[key]) queuePush(key);
    };
    installEwtCapture();
    installSimpleCalcPersistence();
    // Reconcile EVERY synced type at boot: anything written before this hook was
    // installed (fast user, slow network) has no pending flag and would otherwise
    // sit on the device forever. One small push per type guarantees consistency.
    Object.keys(SYNC_MAP).forEach(function (k) {
      if (localStorage.getItem(k)) queuePush(k);
    });
    offloadPendingEwtPdfs();
    window.addEventListener('online', flushPending);
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushNow();
      // Coming BACK from the share sheet / mail app: retry anything the
      // phone killed while the app was backgrounded — including PDF offloads —
      // and pick up drafts written on another device in the meantime.
      if (document.visibilityState === 'visible') { flushPending(); offloadPendingEwtPdfs(); pullDrafts(); }
    });
  }

  // Lime & Flex Base inputs aren't persisted by the core app — save/restore them
  // here so they survive reloads and sync for admin review.
  function installSimpleCalcPersistence() {
    var CALCS = [
      { key: 'ebcc_lime_state_v1', ids: ['lime-rate', 'lime-area'] },
      { key: 'ebcc_flexbase_state_v1', ids: ['fb-area', 'fb-depth', 'fb-truck-tons'] }
    ];
    CALCS.forEach(function (cfg) {
      // Restore first (before attaching listeners), then let the app recalculate.
      var st = null;
      try { st = JSON.parse(localStorage.getItem(cfg.key) || 'null'); } catch (e) {}
      if (st) {
        cfg.ids.forEach(function (id) {
          var el = document.getElementById(id);
          // Saved values win over built-in defaults (e.g. fb-truck-tons defaults to 22).
          if (el && st[id] != null && st[id] !== '' && el.value !== st[id]) {
            el.value = st[id];
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });
      }
      cfg.ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', function () {
          var out = {};
          cfg.ids.forEach(function (i2) {
            var e2 = document.getElementById(i2);
            out[i2] = e2 ? e2.value : '';
          });
          localStorage.setItem(cfg.key, JSON.stringify(out)); // synced via the hook above
        });
      });
    });
  }

  function queuePush(lsKey) {
    var p = getPending(); p[lsKey] = 1; setPending(p);
    setSyncStatus('Saving…', '#d97706');
    clearTimeout(pushTimers[lsKey]);
    pushTimers[lsKey] = setTimeout(function () { pushKey(lsKey); }, 1200);
  }

  function pushKey(lsKey) {
    if (!ME) return; // not signed in / offline
    var type = SYNC_MAP[lsKey];
    var raw = localStorage.getItem(lsKey);
    var data;
    try { data = raw ? JSON.parse(raw) : null; } catch (e) { return; }
    // Enforce EWT retention caps at push time too — bundles saved under older,
    // looser caps can exceed the database's 2MB doc limit and fail every sync.
    if (lsKey === EWT_KEY && Array.isArray(data)) {
      data = trimEwtArray(data);
      var trimmed = JSON.stringify(data);
      if (trimmed !== raw) { try { localStorage.setItem(lsKey, trimmed); } catch (e) {} }
    }
    return apiFetch('/api/records', { method: 'POST', body: { type: type, data: data } })
      .then(function (r) {
        if (r.ok) {
          var p = getPending(); delete p[lsKey]; setPending(p);
          if (Object.keys(getPending()).length === 0) setSyncStatus('All changes saved', '#059669');
          // Drafts: the server replies with the merged list (ours + other
          // devices'); adopt it so a push doubles as a pull.
          if (lsKey === DRAFTS_KEY) {
            r.json().then(function (j) {
              if (j && Array.isArray(j.data)) adoptDrafts(mergeDrafts(j.data, readDraftsLocal()));
            }).catch(function () {});
          }
        } else {
          // Surface the server's actual complaint so failures are diagnosable.
          r.text().then(function (t) {
            var msg = 'Sync error ' + r.status + ' (' + type + ')';
            try { var j = JSON.parse(t); if (j && j.error) msg += ': ' + j.error; } catch (e2) {}
            try { console.warn('[sync] ' + msg, t.slice(0, 300)); } catch (e3) {}
            setSyncStatus(msg, '#dc2626');
          }).catch(function () { setSyncStatus('Sync error ' + r.status + ' (' + type + ')', '#dc2626'); });
        }
      })
      .catch(function () { setSyncStatus('Offline — saved locally', '#6b7280'); });
  }

  function flushPending() {
    var p = getPending();
    Object.keys(p).forEach(function (lsKey) { if (SYNC_MAP[lsKey]) pushKey(lsKey); });
  }
  function flushNow() {
    Object.keys(pushTimers).forEach(function (k) { clearTimeout(pushTimers[k]); });
    flushPending();
  }

  // ---------- EWT capture (store finalized Extra Work Tickets + their PDFs) ----------
  var EWT_PDF_KEEP = 10;  // newest N un-offloaded tickets keep their full PDF (stays under Cosmos' 2MB doc cap)
  var EWT_MAX = 100;
  var EWT_PDF_SINGLE_MAX = 600 * 1024;  // any single PDF bigger than this gets dropped (broken-era monsters)
  var EWT_PDF_BUDGET = 1500 * 1024;     // total PDF bytes kept across the whole bundle

  // Size-aware retention. A record whose PDF is parked in Blob Storage
  // (pdfBlob) never needs the inline copy; a record still WAITING for its
  // blob upload keeps the inline copy so a retry can still park it — only
  // blanked as a last resort when the bundle wouldn't fit the 2MB doc cap.
  // The server merges pushes by (ticketNo, date), so a trimmed push can no
  // longer destroy a PDF the server already has.
  function trimEwtArray(data) {
    if (!Array.isArray(data)) return data;
    if (data.length > EWT_MAX) data = data.slice(data.length - EWT_MAX);
    var budget = EWT_PDF_BUDGET, kept = 0;
    for (var i = data.length - 1; i >= 0; i--) {
      var rec = data[i];
      if (!rec || !rec.pdf) continue;
      if (rec.pdfBlob) { rec.pdf = ''; continue; }  // safely parked — inline copy redundant
      var len = rec.pdf.length;
      if (kept >= EWT_PDF_KEEP || len > EWT_PDF_SINGLE_MAX || len > budget) {
        rec.pdf = '';
      } else {
        budget -= len; kept++;
      }
    }
    return data;
  }

  function installEwtCapture() {
    installEwtAutoNumber();
  }

  // Posted Cost Per Yard spreads: the app dispatches 'ebcc-spread-posted' with a
  // computed snapshot (producers, dirt/rock yards, CPY, days). Stored + synced
  // immediately so the admin sees it the moment Post spread is pressed.
  var SPREADS_KEY = 'ebcc_cpy_posts_v1';
  var FLAT_POSTS_KEY = 'ebcc_flat_posts_v1';
  function storePost(key, snap) {
    var arr;
    try { arr = JSON.parse(localStorage.getItem(key) || '[]'); } catch (err) { arr = []; }
    arr.push(snap);
    if (arr.length > 20) arr = arr.slice(arr.length - 20);
    localStorage.setItem(key, JSON.stringify(arr));
    // Mark pending explicitly — the setItem hook may not be installed yet if the
    // user posted within seconds of opening the app. Pending survives restarts.
    try { var p = getPending(); p[key] = 1; setPending(p); } catch (err) {}
    try { flushNow(); } catch (err) {}
  }
  window.addEventListener('ebcc-spread-posted', function (e) {
    try { if (e.detail && e.detail.producers) storePost(SPREADS_KEY, e.detail); } catch (err) {}
  });
  window.addEventListener('ebcc-flat-posted', function (e) {
    try { if (e.detail && e.detail.items) storePost(FLAT_POSTS_KEY, e.detail); } catch (err) {}
  });
  // Posted Lime Trucks / Flex Base calcs (the 'Post calc' buttons)
  var LIME_POSTS_KEY = 'ebcc_lime_posts_v1';
  var FB_POSTS_KEY = 'ebcc_flexbase_posts_v1';
  window.addEventListener('ebcc-lime-posted', function (e) {
    try { if (e.detail && e.detail.rate) storePost(LIME_POSTS_KEY, e.detail); } catch (err) {}
  });
  window.addEventListener('ebcc-flexbase-posted', function (e) {
    try { if (e.detail && e.detail.depthIn) storePost(FB_POSTS_KEY, e.detail); } catch (err) {}
  });

  // The app dispatches 'ebcc-ewt-finalized' (with the collected ticket + PDF data URI)
  // whenever a ticket is previewed or emailed. Attached at load — never misses one.
  window.addEventListener('ebcc-ewt-finalized', function (e) {
    try {
      var d = e.detail || {};
      var t = d.ticket || {};
      var rec = {
        ts: new Date().toISOString(),
        ticketNo: t.ticketNo || '', date: t.date || '',
        customer: t.customer || '', jobAddress: t.jobAddress || '',
        city: t.city || '', state: t.state || '',
        po: t.po || '', jobNum: t.jobNum || '', phase: t.phase || '',
        description: t.description || '', printName: t.printName || '', title: t.title || '',
        labor: t.labor || [], equipment: t.equipment || [], materials: t.materials || [],
        signed: !!t.acceptedBy,   // the signature image itself is inside the PDF
        pdf: d.pdf || ''
      };
      if (!rec.ticketNo && !rec.customer && !rec.description) return; // empty form
      var arr;
      try { arr = JSON.parse(localStorage.getItem(EWT_KEY) || '[]'); } catch (err) { arr = []; }
      var idx = arr.findIndex(function (x) { return x.ticketNo === rec.ticketNo && x.date === rec.date; });
      if (idx >= 0) arr[idx] = rec; else arr.push(rec);
      arr = trimEwtArray(arr);
      localStorage.setItem(EWT_KEY, JSON.stringify(arr));
      // Mark pending explicitly (hook may not be installed yet), then push NOW —
      // the share sheet is about to background the app, and a debounced upload
      // would be killed by the phone. Boot + foreground flushes retry the rest.
      try { var pp = getPending(); pp[EWT_KEY] = 1; setPending(pp); } catch (err) {}
      try { flushNow(); } catch (err) {}
      // Park the PDF in Blob Storage; the record then carries a tiny reference
      // instead of the file, so PDFs are kept forever with no size budgets.
      // Sweep ALL waiting tickets, not just this one — earlier uploads the
      // phone killed get retried on the very next finalize.
      offloadPendingEwtPdfs();
    } catch (err) {}
  });

  function uploadEwtPdf(rec) {
    if (!rec || !rec.pdf || rec.pdfBlob) return;
    apiFetch('/api/ewt-pdf', { method: 'POST', body: { ticketNo: rec.ticketNo, date: rec.date, pdf: rec.pdf } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (res) {
        if (!res || !res.ok || !res.path) {
          try { console.warn('[sync] EWT PDF offload failed for ' + rec.ticketNo + (res && res.reason ? ' (' + res.reason + ')' : '')); } catch (e) {}
          return; // blob not configured / failed — inline copy stays for the next retry
        }
        var arr;
        try { arr = JSON.parse(localStorage.getItem(EWT_KEY) || '[]'); } catch (e) { arr = []; }
        var idx = arr.findIndex(function (x) { return x && x.ticketNo === rec.ticketNo && x.date === rec.date; });
        if (idx >= 0) {
          arr[idx].pdfBlob = res.path;
          arr[idx].pdf = '';
          localStorage.setItem(EWT_KEY, JSON.stringify(arr));
          try { flushNow(); } catch (e) {}
        }
      })
      .catch(function () {}); // offline — boot retry will pick it up
  }

  // Boot retry: any ticket still carrying an inline PDF gets offloaded to Blob.
  function offloadPendingEwtPdfs() {
    var arr;
    try { arr = JSON.parse(localStorage.getItem(EWT_KEY) || '[]'); } catch (e) { return; }
    if (!Array.isArray(arr)) return;
    arr.forEach(function (rec) { if (rec && rec.pdf && !rec.pdfBlob) uploadEwtPdf(rec); });
  }

  // Auto-generate the EWT ticket number (company-wide sequence from the server,
  // starting at 21100). Reserved the moment someone starts filling a new ticket,
  // so numbers are only consumed for real tickets. Field stays manually editable.
  function installEwtAutoNumber() {
    var tab = document.getElementById('tab-ewt');
    var field = document.getElementById('ewt-ticket-no');
    if (!tab || !field) return;
    if (!field.value.trim()) field.placeholder = 'auto';
    var fetching = false;
    tab.addEventListener('input', function (e) {
      if (fetching) return;
      if (e.target === field) return;      // typing a manual number — leave it alone
      if (field.value.trim()) return;      // this ticket is already numbered
      fetching = true;
      apiFetch('/api/ticket-number', { method: 'POST' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (res) {
          if (res && res.number && !field.value.trim()) {
            field.value = res.number;
          }
        })
        .catch(function () {}) // offline — leave blank for manual entry
        .then(function () { fetching = false; });
    });
  }
  // ---------- admin console ----------
  function enableAdmin() {
    window.EBCC_IS_ADMIN = true; // page features (e.g. Job Books delete) key off this
    document.querySelectorAll('.admin-only').forEach(function (el) { el.style.display = ''; });
    var tabBtn = document.querySelector('.tab[data-tab="admin"]');
    if (tabBtn) tabBtn.addEventListener('click', loadAdmin);
  }

  function loadAdmin() {
    var panel = document.getElementById('adm-panel');
    apiFetch('/api/users').then(function (r) { return r.ok ? r.json() : { users: [] }; }).then(function (res) {
      var users = res.users || [];
      var today = new Date().toISOString().slice(0, 10);
      var totalRecords = 0, activeToday = 0;
      users.forEach(function (u) {
        var c = u.counts || {}; totalRecords += (c.trucking_tickets || 0) + (c.load_count || 0) + (c.ewt_records || 0);
        if ((u.lastActiveAt || '').slice(0, 10) === today) activeToday++;
      });
      document.getElementById('adm-user-count').textContent = users.length;
      document.getElementById('adm-record-count').textContent = totalRecords;
      document.getElementById('adm-active-count').textContent = activeToday;

      var rows = users.map(function (u) {
        var c = u.counts || {};
        var last = u.lastActiveAt ? new Date(u.lastActiveAt).toLocaleString() : '—';
        var sel = ['admin', 'user', 'disabled'].map(function (r) {
          return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + r + '</option>';
        }).join('');
        return '<div class="admin-row" style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">' +
          '<div style="min-width:0">' +
            '<div style="font-weight:600;font-size:14px">' + esc(u.name || u.email) + '</div>' +
            '<div style="font-size:12px;color:var(--gray)">' + esc(u.email) + '</div>' +
            '<div style="font-size:11px;color:var(--gray);margin-top:2px">Tickets ' + (c.trucking_tickets || 0) + ' · Load counts sent ' + (c.load_count_sends || 0) + ' · EWT ' + (c.ewt_records || 0) + ' · Spreads ' + ((c.cpy_posts || 0) + (c.flat_posts || 0)) + ' · Calcs ' + ((c.lime_posts || 0) + (c.flexbase_posts || 0)) + ' · Last active ' + esc(last) + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;align-items:center">' +
            '<select data-role-for="' + esc(u.id) + '" style="font-family:inherit;padding:6px;border:1px solid var(--border);border-radius:8px">' + sel + '</select>' +
            '<button data-view-for="' + esc(u.id) + '" data-name="' + esc(u.name || u.email) + '" style="font-family:inherit;padding:6px 10px;border:1px solid var(--border);background:var(--card,#fff);color:var(--ink,#1f2937);border-radius:8px;cursor:pointer">View</button>' +
          '</div>' +
        '</div>';
      }).join('');
      panel.innerHTML = rows || '<p style="color:var(--gray);font-size:13px">No users yet.</p>';

      panel.querySelectorAll('select[data-role-for]').forEach(function (s) {
        s.addEventListener('change', function () {
          var uid = s.getAttribute('data-role-for');
          apiFetch('/api/users', { method: 'PATCH', body: { userId: uid, role: s.value } })
            .then(function (r) { return r.json(); })
            .then(function (out) { if (out.error) { alert(out.error); loadAdmin(); } });
        });
      });
      panel.querySelectorAll('button[data-view-for]').forEach(function (b) {
        b.addEventListener('click', function () {
          viewUserRecords(b.getAttribute('data-view-for'), b.getAttribute('data-name'));
        });
      });
    });
  }

  function viewUserRecords(userId, name) {
    ADMIN_EWT_OWNER = userId;
    var box = document.getElementById('adm-user-detail');
    box.style.display = '';
    box.innerHTML = '<p style="color:var(--gray);font-size:13px;padding:8px 0">Loading ' + esc(name) + '’s records…</p>';
    apiFetch('/api/records?userId=' + encodeURIComponent(userId)).then(function (r) { return r.ok ? r.json() : null; }).then(function (res) {
      if (!res) { box.innerHTML = '<p style="color:var(--red)">Could not load records.</p>'; return; }
      var rec = res.records || {};
      var tickets = (rec.trucking_tickets && rec.trucking_tickets.data) || [];
      var loadCount = (rec.load_count && rec.load_count.data) || null;
      var ewt = (rec.ewt_records && rec.ewt_records.data) || [];
      var html = '<div style="margin-top:12px;padding:14px;border:1px solid var(--border);border-radius:12px;background:var(--card,#fff)">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
          '<strong style="font-size:15px">' + esc(name) + '</strong>' +
          '<button id="admin-detail-close" style="border:none;background:var(--soft,#f3f4f6);color:var(--ink,#1f2937);border-radius:8px;padding:6px 10px;cursor:pointer;font-family:inherit">Close</button>' +
        '</div>' +
        section('Truck Tickets (' + (Array.isArray(tickets) ? tickets.length : 0) + ')', ticketsHtml(tickets)) +
        section('Load Count — current day' + updatedTag(rec.load_count), loadCountHtml(loadCount)) +
        (function () {
          var sends = (rec.load_count_sends && rec.load_count_sends.data) || [];
          return section('Load Count — sent days (' + sends.length + ')', loadCountSendsHtml(sends));
        })() +
        section('Extra Work Tickets (' + (Array.isArray(ewt) ? ewt.length : 0) + ')', ewtHtml(ewt)) +
        (function () {
          var posts = (rec.cpy_posts && rec.cpy_posts.data) || [];
          return section('Posted Spreads — Cost Per Yard (' + posts.length + ')' + updatedTag(rec.cpy_posts), spreadsHtml(posts));
        })() +
        (function () {
          var posts = (rec.flat_posts && rec.flat_posts.data) || [];
          return section('Posted Spreads — Flat Work (' + posts.length + ')' + updatedTag(rec.flat_posts), flatPostsHtml(posts));
        })() +
        (function () {
          var posts = (rec.lime_posts && rec.lime_posts.data) || [];
          return section('Posted Calcs — Lime Trucks (' + posts.length + ')' + updatedTag(rec.lime_posts), limePostsHtml(posts));
        })() +
        (function () {
          var posts = (rec.flexbase_posts && rec.flexbase_posts.data) || [];
          return section('Posted Calcs — Flex Base (' + posts.length + ')' + updatedTag(rec.flexbase_posts), fbPostsHtml(posts));
        })() +
        section('Cost Per Yard — current setup' + updatedTag(rec.cpy_state), cpyHtml(rec.cpy_state && rec.cpy_state.data)) +
        section('Flat Work — current setup' + updatedTag(rec.flat_state), flatHtml(rec.flat_state && rec.flat_state.data)) +
        section('Lime Trucks' + updatedTag(rec.lime_state), limeHtml(rec.lime_state && rec.lime_state.data)) +
        section('Flex Base' + updatedTag(rec.flexbase_state), fbHtml(rec.flexbase_state && rec.flexbase_state.data)) +
      '</div>';
      box.innerHTML = html;
      var cl = document.getElementById('admin-detail-close');
      if (cl) cl.addEventListener('click', function () { box.style.display = 'none'; box.innerHTML = ''; });
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  // Drill-down level 1: collapsed by default — the admin opens only what
  // they need (user > section > date > spread).
  function section(title, inner) {
    return '<details style="margin-top:6px;border-bottom:1px solid var(--hairline);padding-bottom:6px"><summary style="cursor:pointer;font-weight:600;font-size:13px;color:var(--dark);padding:4px 0">' + esc(title) + '</summary><div style="font-size:12px;color:var(--dark);margin-top:6px;overflow-x:auto">' + inner + '</div></details>';
  }
  function ticketsHtml(t) {
    if (!Array.isArray(t) || !t.length) return '<em style="color:var(--gray)">None</em>';
    return t.map(function (x) {
      return '<div style="padding:6px 0;border-bottom:1px solid var(--light-gray)">#' + esc(x.pitTicketNo || x.truckNum || '—') +
        ' · ' + esc(x.commodity || x.commodityType || '') + ' · ' + esc(x.date || '') +
        ' · ' + esc(x.tons || '') + 't / ' + esc(x.yards || '') + 'cy · ' + esc(x.truckingCo || '') + '</div>';
    }).join('');
  }
  // ---- Load Count: the live day (synced state) and the archived, sent days ----
  function lcTypes() { try { return Array.isArray(TRUCK_COUNT_TYPES) ? TRUCK_COUNT_TYPES : []; } catch (e) { return []; } }
  function lcTypeOf(id) { var t = lcTypes().filter(function (x) { return x.id === id; })[0]; return t || { label: id || 'Truck', cy: 0 }; }
  function lcCountLine(n, l, c) { return n + ' truck' + (n === 1 ? '' : 's') + ' · ' + l + ' load' + (l === 1 ? '' : 's') + ' · ' + c + ' cy'; }
  function lcStatBlock(n, l, c) {
    return '<div class="summary" style="margin-bottom:8px">' + statCell('Trucks', n) + statCell('Loads', l) + statCell('Yards', c + ' cy', 'cost-per-yard') + '</div>';
  }
  function loadCountHtml(lc) {
    // The synced record is the app's live state: { meta:{...}, trucks:[...] }.
    if (!lc || !Array.isArray(lc.trucks) || !lc.trucks.length) return none();
    var m = lc.meta || lc;
    var loads = 0, cy = 0;
    var rows = lc.trucks.map(function (tr) {
      var done = (tr.loads || []).filter(function (L) { return L && L.in && L.out; }).length;
      var open = (tr.loads || []).filter(function (L) { return L && L.in && !L.out; }).length;
      var ti = lcTypeOf(tr.truckTypeId), tcy = done * (ti.cy || 0);
      loads += done; cy += tcy;
      return machineRow(esc(ti.label) + (tr.truckNo ? ' · #' + esc(tr.truckNo) : ''), esc(tr.name || '') + (open ? (tr.name ? ' · ' : '') + open + ' still on-site' : ''),
        done + ' load' + (done === 1 ? '' : 's'), tcy + ' cy');
    }).join('');
    var head = '<div style="font-size:10.5px;color:var(--gray);margin:0 0 6px">' + esc(m.date || 'no date') +
      ' · Source ' + esc(m.source || '—') + ' · Job ' + esc(m.jobNum || '—') + (m.deliveredTo ? ' · to ' + esc(m.deliveredTo) : '') + '</div>';
    return head + lcStatBlock(lc.trucks.length, loads, cy) + rows;
  }
  var ADMIN_LC_CACHE = [];
  function loadCountSendsHtml(arr) {
    ADMIN_LC_CACHE = Array.isArray(arr) ? arr : [];
    if (!ADMIN_LC_CACHE.length) return none();
    return ADMIN_LC_CACHE.map(function (x, i) { return { x: x, i: i }; }).reverse().map(function (it) {
      var x = it.x;
      var when = x.ts ? new Date(x.ts).toLocaleString([], { month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' }) : '';
      var meta = '<div style="font-size:10.5px;color:var(--gray);margin:0 0 6px">' + esc(when) +
        (x.emailedTo && x.emailedTo.length ? (x.sent ? ' · emailed to ' : ' · email failed, shared from device · ') + esc(x.emailedTo.join(', ')) : ' · shared from device (no recipients checked)') +
        (x.source ? ' · Source ' + esc(x.source) : '') + (x.jobNum ? ' · Job ' + esc(x.jobNum) : '') + (x.deliveredTo ? ' · to ' + esc(x.deliveredTo) : '') + '</div>';
      var pdf = x.pdfBlob
        ? '<button type="button" data-lc-pdf="' + it.i + '" style="padding:4px 12px;border-radius:99px;border:none;background:var(--soft,#f4f5f7);color:var(--ink,#23272e);font-family:inherit;font-size:11px;font-weight:600;cursor:pointer;margin-bottom:8px">Open PDF</button>'
        : '<div style="font-size:11px;color:var(--gray);margin-bottom:8px">PDF not archived (storage was unavailable when this was sent)</div>';
      var types = (x.byType || []).map(function (b) { return machineRow(esc(b.label), b.trucks + ' truck' + (b.trucks === 1 ? '' : 's'), b.loads + ' load' + (b.loads === 1 ? '' : 's'), b.cy + ' cy'); }).join('');
      return postDetails((x.date || when) + ' · ' + lcCountLine(x.trucks || 0, x.loads || 0, x.cy || 0), meta + lcStatBlock(x.trucks || 0, x.loads || 0, x.cy || 0) + pdf + types);
    }).join('');
  }
  // Open an archived Load Count PDF (admin drill-down) — same private store as EWT PDFs
  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-lc-pdf]') : null;
    if (!b) return;
    var rec = ADMIN_LC_CACHE[+b.getAttribute('data-lc-pdf')];
    if (!rec || !rec.pdfBlob) return;
    var name = String(rec.pdfBlob).split('/').slice(1).join('/');
    apiFetch('/api/ewt-pdf?user=' + encodeURIComponent(ADMIN_EWT_OWNER) + '&name=' + encodeURIComponent(name))
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then(function (buf) { openPdfBytes(buf); })
      .catch(function () { alert('Could not load this PDF.'); });
  });
  var ADMIN_EWT_CACHE = [];
  var ADMIN_EWT_OWNER = '';
  function ewtHtml(e) {
    ADMIN_EWT_CACHE = Array.isArray(e) ? e : [];
    if (!ADMIN_EWT_CACHE.length) return '<em style="color:var(--gray)">None</em>';
    return ADMIN_EWT_CACHE.map(function (x, i) {
      return '<div style="padding:6px 0;border-bottom:1px solid var(--light-gray)">Ticket ' + esc(x.ticketNo || '—') + ' · ' + esc(x.date || '') +
        ' · ' + esc(x.customer || '') + (x.signed ? ' · signed' + (x.printName ? ' (' + esc(x.printName) + ')' : '') : (x.printName ? ' · ' + esc(x.printName) : '')) +
        ((x.pdf || x.pdfBlob)
          ? ' <button type="button" data-ewt-pdf="' + i + '" style="margin-left:6px;padding:2px 10px;border-radius:99px;border:none;background:var(--soft,#f4f5f7);color:var(--ink,#23272e);font-family:inherit;font-size:11px;font-weight:600;cursor:pointer">Open PDF</button>'
          : ' <button type="button" data-ewt-rebuild="' + i + '" title="The original PDF was lost before it reached storage — rebuild it from the ticket data (signature not included)" style="margin-left:6px;padding:2px 10px;border-radius:99px;border:1px dashed var(--border,#e9ebee);background:transparent;color:var(--gray,#8b919b);font-family:inherit;font-size:11px;font-weight:600;cursor:pointer">Rebuild PDF</button>') +
        '<br><span style="color:var(--gray)">' + esc((x.description || '').slice(0, 140)) + '</span></div>';
    }).join('');
  }
  function openPdfBytes(bytes) {
    var blob = new Blob([bytes], { type: 'application/pdf' });
    window.open(URL.createObjectURL(blob), '_blank');
  }
  // Rebuild a lost PDF from the ticket's stored data (admin drill-down).
  // The paper-form renderer lives on the page (ewtBuildPDF); the signature
  // image only ever existed inside the original PDF, so rebuilds are unsigned
  // — every other field, table, and total comes back.
  document.addEventListener('click', function (ev) {
    var rb = ev.target && ev.target.closest ? ev.target.closest('[data-ewt-rebuild]') : null;
    if (!rb) return;
    var rec = ADMIN_EWT_CACHE[+rb.getAttribute('data-ewt-rebuild')];
    if (!rec) return;
    if (typeof window.ewtBuildPDF !== 'function' || typeof window.jspdf === 'undefined') {
      alert('PDF builder not loaded — reload the app and try again.');
      return;
    }
    try {
      var doc = window.ewtBuildPDF({
        ticketNo: rec.ticketNo || '', date: rec.date || '',
        customer: rec.customer || '', jobAddress: rec.jobAddress || '',
        city: rec.city || '', state: rec.state || '',
        po: rec.po || '', jobNum: rec.jobNum || '', phase: rec.phase || '',
        labor: rec.labor || [], equipment: rec.equipment || [], materials: rec.materials || [],
        description: rec.description || '',
        acceptedBy: '', printName: rec.printName || '', title: rec.title || '',
      });
      openPdfBytes(doc.output('arraybuffer'));
    } catch (e) {
      try { console.warn('rebuild pdf', e); } catch (e2) {}
      alert('Could not rebuild this PDF.');
    }
  });

  // Open a stored EWT PDF in a new tab (admin drill-down)
  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-ewt-pdf]') : null;
    if (!b) return;
    var rec = ADMIN_EWT_CACHE[+b.getAttribute('data-ewt-pdf')];
    if (!rec) return;
    if (rec.pdfBlob) {
      // Blob-backed: stream it through the authenticated API
      var name = String(rec.pdfBlob).split('/').slice(1).join('/');
      apiFetch('/api/ewt-pdf?user=' + encodeURIComponent(ADMIN_EWT_OWNER) + '&name=' + encodeURIComponent(name))
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then(function (buf) { openPdfBytes(buf); })
        .catch(function () { alert('Could not load this PDF.'); });
      return;
    }
    if (!rec.pdf) return;
    try {
      var base64 = rec.pdf.slice(rec.pdf.indexOf(',') + 1);
      var bin = atob(base64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      openPdfBytes(bytes);
    } catch (e) { alert('Could not open this PDF.'); }
  });
  // ---- Tight spreadsheet-style tables for the admin drill-down ----
  function fmtNum(n) { var v = +n; return isFinite(v) ? v.toLocaleString() : '0'; }
  function tbl(headers, rows) {
    var th = headers.map(function (h) {
      return '<th style="text-align:' + (h.num ? 'right' : 'left') + ';padding:3px 8px;font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--gray,#8b919b);background:var(--soft,#fafbfc);border:1px solid var(--tbl-border,#eef0f3);font-weight:600;white-space:nowrap">' + esc(h.label) + '</th>';
    }).join('');
    var body = rows.map(function (r) {
      return '<tr>' + r.map(function (v, i) {
        return '<td style="text-align:' + (headers[i].num ? 'right' : 'left') + ';padding:3px 8px;font-size:11px;border:1px solid var(--tbl-border,#eef0f3);white-space:nowrap;font-variant-numeric:tabular-nums">' + v + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return '<div style="overflow-x:auto;margin:3px 0 6px"><table style="border-collapse:collapse;min-width:100%">' +
      '<tr>' + th + '</tr>' + body + '</table></div>';
  }
  // ---- Posted spreads, rendered in the calculator tabs' own visual
  // language (.summary stats, .job-projection, .equipment-card rows) so
  // they read the same as the CPY tab and follow light/dark automatically.
  function postLabel(s) {
    var when = s.ts ? new Date(s.ts).toLocaleString([], { month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' }) : '—';
    return when + ' · ' + (s.state || '—') + (s.projectCode ? ' · ' + s.projectCode + (s.projectName ? ' ' + s.projectName : '') : '');
  }
  function statCell(label, value, cls, sub) {
    return '<div class="stat' + (cls ? ' ' + cls : '') + '"><div class="label">' + label + '</div>' +
      '<div class="value" style="font-size:20px">' + value + '</div>' +
      (sub ? '<div class="label" style="margin-top:2px;text-transform:none;letter-spacing:0">' + sub + '</div>' : '') + '</div>';
  }
  function projCell(label, value, cls) {
    return '<div class="stat' + (cls ? ' ' + cls : '') + '"><div class="label">' + label + '</div><div class="value" style="font-size:19px">' + value + '</div></div>';
  }
  function jobTotal(s) {
    var days = parseFloat(s.daysToComplete);
    if (!isFinite(days) || !s.totalCost) return null;
    return '$' + fmtNum(Math.round(s.totalCost * days));
  }
  function machineRow(name, meta, right, rightSub) {
    return '<div class="equipment-card" style="grid-template-columns:1fr auto;margin-bottom:6px;padding:8px 12px">' +
      '<div style="min-width:0"><div class="name">' + name + '</div><div class="rate">' + meta + '</div></div>' +
      '<div style="text-align:right"><div class="cost">' + right + '</div>' + (rightSub ? '<div class="yards">' + rightSub + '</div>' : '') + '</div>' +
    '</div>';
  }
  // Drill-down level 2: one collapsed row per post, labelled by date.
  function postDetails(label, inner) {
    return '<details style="margin:4px 0 4px 10px"><summary style="cursor:pointer;font-size:12.5px;font-weight:600;color:var(--dark);padding:3px 0">' + esc(label) + '</summary><div style="margin-top:6px">' + inner + '</div></details>';
  }

  function spreadsHtml(arr) {
    if (!Array.isArray(arr) || !arr.length) return none();
    return arr.slice().reverse().map(function (s) {
      var meta = '<div style="font-size:10.5px;color:var(--gray);margin:0 0 6px">' +
        esc(s.hoursPerDay != null ? s.hoursPerDay : '—') + ' hrs/day · yd/load ' + esc(s.ydPerLoad != null ? s.ydPerLoad : '—') +
        ' · ' + esc(s.producerQty || 0) + ' producer' + (s.producerQty === 1 ? '' : 's') + '</div>';
      var stats = '<div class="summary" style="margin-bottom:8px">' +
        statCell('Total Daily Cost', '$' + fmtNum(s.totalCost)) +
        statCell('Total Yards', fmtNum(s.totalYards), '', 'dirt ' + fmtNum(s.dirtYards) + ' · rock ' + fmtNum(s.rockYards)) +
        statCell('Cost Per Yard', s.costPerYard != null ? '$' + esc(s.costPerYard) : '—', 'cost-per-yard') +
      '</div>';
      var total = jobTotal(s);
      var proj = s.yardsToMove ? '<div class="job-projection show" style="margin-bottom:8px">' +
        projCell('Yards to move', fmtNum(s.yardsToMove)) +
        projCell('Workdays', s.daysToComplete ? esc(s.daysToComplete) : '—') +
        projCell('Total job cost', total || '—', 'total-cost') +
      '</div>' : '';
      var machines = (s.producers || []).map(function (p) {
        return machineRow(esc(p.name),
          'Qty ' + esc(p.qty) + (p.roundTime ? ' · round ' + esc(p.roundTime) + ' min' : ''),
          fmtNum(p.yardsPerDay) + ' cy/day');
      }).join('');
      return postDetails(postLabel(s), meta + stats + proj + machines);
    }).join('');
  }

  function flatPostsHtml(arr) {
    if (!Array.isArray(arr) || !arr.length) return none();
    return arr.slice().reverse().map(function (s) {
      var meta = '<div style="font-size:10.5px;color:var(--gray);margin:0 0 6px">' +
        esc(s.hoursPerDay != null ? s.hoursPerDay : '—') + ' hrs/day · ' + esc(s.equipQty || 0) + ' piece' + (s.equipQty === 1 ? '' : 's') + ' of equipment</div>';
      var stats = '<div class="summary" style="margin-bottom:8px">' +
        statCell('Total Daily Cost', '$' + fmtNum(s.totalCost)) +
        statCell('Sq Ft Per Day', fmtNum(s.sqftPerDay)) +
        statCell('Cost Per Sq Ft', s.costPerSqFt ? '$' + esc(s.costPerSqFt) : '—', 'cost-per-yard') +
      '</div>';
      var total = jobTotal(s);
      var proj = s.jobSqft ? '<div class="job-projection show" style="margin-bottom:8px">' +
        projCell('Sq Ft to cover', fmtNum(s.jobSqft)) +
        projCell('Workdays', s.daysToComplete ? esc(s.daysToComplete) : '—') +
        projCell('Total job cost', total || '—', 'total-cost') +
      '</div>' : '';
      var items = (s.items || []).map(function (p) {
        return machineRow(esc(p.name), 'Qty ' + esc(p.qty), '$' + fmtNum(p.costPerDay) + '/day');
      }).join('');
      return postDetails(postLabel(s), meta + stats + proj + items);
    }).join('');
  }
  // Posted Lime Trucks calcs — headline is the order (trucks), with the spec math beneath
  function limePostsHtml(arr) {
    if (!Array.isArray(arr) || !arr.length) return none();
    return arr.slice().reverse().map(function (s) {
      var meta = '<div style="font-size:10.5px;color:var(--gray);margin:0 0 6px">Spec ' + esc(s.rate) + ' lb/sy · ' + fmtNum(s.areaSqft) + ' sq ft (' + fmtNum(s.sqyd) + ' sy)</div>';
      var stats = '<div class="summary" style="margin-bottom:8px">' +
        statCell('Trucks to order', fmtNum(s.trucksToOrder), 'cost-per-yard', '10-ton · ' + esc(s.exactTrucks) + ' exact') +
        statCell('Total lime', fmtNum(s.totalTons) + ' tons', '', fmtNum(s.totalLbs) + ' lb') +
        statCell('Spec coverage', esc(s.pctOfSpec) + '%', '', esc(s.effectiveRate) + ' lb/sy delivered') +
      '</div>';
      return postDetails(postLabel(s) + ' · ' + fmtNum(s.trucksToOrder) + ' truck' + (s.trucksToOrder === 1 ? '' : 's'), meta + stats);
    }).join('');
  }
  // Posted Flex Base calcs — headline is the truck loads to order
  function fbPostsHtml(arr) {
    if (!Array.isArray(arr) || !arr.length) return none();
    return arr.slice().reverse().map(function (s) {
      var meta = '<div style="font-size:10.5px;color:var(--gray);margin:0 0 6px">' + fmtNum(s.areaSqft) + ' sq ft × ' + esc(s.depthIn) + '" section · ' + esc(s.truckTons) + '-ton trucks · 1.8 t/cy</div>';
      var stats = '<div class="summary" style="margin-bottom:8px">' +
        statCell('Truck loads', fmtNum(s.trucksNeeded), 'cost-per-yard', esc(s.exactTrucks) + ' exact · last ' + esc(s.lastTruckTons) + ' t') +
        statCell('Total tonnage', fmtNum(s.totalTons) + ' tons') +
        statCell('Compacted volume', fmtNum(s.cubicYards) + ' cy') +
      '</div>';
      return postDetails(postLabel(s) + ' · ' + fmtNum(s.trucksNeeded) + ' load' + (s.trucksNeeded === 1 ? '' : 's'), meta + stats);
    }).join('');
  }
  function updatedTag(entry) {
    if (!entry || !entry.updatedAt) return '';
    try { return ' — as of ' + new Date(entry.updatedAt).toLocaleDateString(); } catch (e) { return ''; }
  }
  function none() { return '<em style="color:var(--gray)">None</em>'; }
  function equipTable(items) {
    return tbl(
      [{label:'Equipment'},{label:'Qty',num:1},{label:'Rate',num:1},{label:'Rnd min',num:1}],
      items.map(function (it) {
        return [esc(it.name || '?'), esc(it.quantity != null ? it.quantity : 1), '$' + esc(it.rate || 0),
          (it.producer && it.roundTime) ? esc(it.roundTime) : '—'];
      }));
  }
  function cpyHtml(st) {
    // Synced state uses `job`; keep `items` as a fallback for older snapshots.
    var items = st && (st.job || st.items);
    if (!st || !Array.isArray(items) || !items.length) return none();
    var head = '<div style="font-size:10.5px;color:var(--gray);margin-top:4px">' +
      esc(st.hoursPerDay != null ? st.hoursPerDay : '—') + ' hrs/day · yd/load ' + esc(st.ydPerLoad != null ? st.ydPerLoad : '—') +
      ' · to move ' + esc(st.yardsToMove || 0) +
      (st.procShifts ? ' · shifts ' + esc(st.procShifts) + '×' + esc(st.procShiftHours != null ? st.procShiftHours : '—') + 'h' : '') + '</div>';
    return head + equipTable(items);
  }
  function flatHtml(st) {
    // Synced state uses `flatJob`/`flat*` keys; keep old names as fallback.
    var items = st && (st.flatJob || st.items);
    if (!st || !Array.isArray(items) || !items.length) return none();
    var hours = st.flatHoursPerDay != null ? st.flatHoursPerDay : st.hoursPerDay;
    var head = '<div style="font-size:10.5px;color:var(--gray);margin-top:4px">' +
      esc(hours != null ? hours : '—') + ' hrs/day · sqft/day ' + esc(st.flatSqftPerDay || st.sqftPerDay || 0) +
      ' · job ' + esc(st.flatJobSqft || st.jobSqft || 0) + ' sqft</div>';
    return head + equipTable(items);
  }
  function limeHtml(st) {
    if (!st || (!st['lime-rate'] && !st['lime-area'])) return none();
    return 'Spec rate ' + esc(st['lime-rate'] || '—') + ' lb/sy · Area ' + esc(st['lime-area'] || '—') + ' sqft';
  }
  function fbHtml(st) {
    if (!st || (!st['fb-area'] && !st['fb-depth'])) return none();
    return 'Area ' + esc(st['fb-area'] || '—') + ' sqft · Depth ' + esc(st['fb-depth'] || '—') + '" · Truck ' + esc(st['fb-truck-tons'] || '—') + ' tons';
  }

  // ---------- go ----------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
