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
    // Posted spreads (explicit snapshots for admin review)
    'ebcc_cpy_posts_v1': 'cpy_posts',
    'ebcc_flat_posts_v1': 'flat_posts',
    // Calculator tabs — synced so the admin can review them per user
    'ebcc_cpy_state_v1': 'cpy_state',
    'ebcc_flat_state_v1': 'flat_state',
    'ebcc_lime_state_v1': 'lime_state',
    'ebcc_flexbase_state_v1': 'flexbase_state'
  };
  var EWT_KEY = 'ebcc_ewt_records_v1';
  var PENDING_KEY = 'ebcc_sync_pending';
  var HYDRATED_FLAG = 'ebcc_hydrated_once';

  var ME = null;
  var pushTimers = {};

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

  function renderAccountMenu(me) {
    var el = document.getElementById('account-menu');
    if (!el) return;
    var initials = (me.name || me.email || '?').trim().slice(0, 1).toUpperCase();
    el.innerHTML =
      '<button id="acct-btn" title="' + esc(me.email) + '" style="width:34px;height:34px;border-radius:50%;border:none;background:#23272e;color:#fff;font-weight:600;cursor:pointer;font-family:inherit">' + esc(initials) + '</button>' +
      '<div id="acct-pop" style="display:none;position:absolute;right:12px;margin-top:6px;background:#fff;color:#1f2937;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 8px 24px rgba(16,24,40,.16);padding:10px;min-width:200px;z-index:50">' +
        '<div style="font-weight:600;font-size:14px">' + esc(me.name || '') + '</div>' +
        '<div style="font-size:12px;color:#6b7280;margin-bottom:8px">' + esc(me.email) + (me.isAdmin ? ' · Admin' : '') + '</div>' +
        '<div id="sync-status" style="font-size:11px;color:#059669;margin-bottom:8px">All changes saved</div>' +
        '<a href="/.auth/logout?post_logout_redirect_uri=/login.html" style="display:block;text-align:center;background:#f3f4f6;color:#1f2937;text-decoration:none;padding:8px;border-radius:8px;font-size:13px;font-weight:600">Sign out</a>' +
      '</div>';
    var btn = document.getElementById('acct-btn');
    var pop = document.getElementById('acct-pop');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      pop.style.display = pop.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', function () { if (pop) pop.style.display = 'none'; });
  }

  function setSyncStatus(text, color) {
    var el = document.getElementById('sync-status');
    if (el) { el.textContent = text; el.style.color = color || '#059669'; }
  }

  // ---------- hydrate local from server (first device / cross-device) ----------
  function hydrateFromServer() {
    return apiFetch('/api/records').then(function (r) { return r.ok ? r.json() : null; }).then(function (res) {
      if (!res || !res.records) return;
      var changed = false;
      Object.keys(SYNC_MAP).forEach(function (lsKey) {
        var type = SYNC_MAP[lsKey];
        var server = res.records[type];
        if (!server || server.data == null) return;
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
    var origSet = localStorage.setItem.bind(localStorage);
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
      // phone killed while the app was backgrounded.
      if (document.visibilityState === 'visible') flushPending();
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
  var EWT_PDF_KEEP = 5;   // newest N tickets keep their full PDF (stays well under Cosmos' 2MB doc cap)
  var EWT_MAX = 100;
  var EWT_PDF_SINGLE_MAX = 400 * 1024;  // any single PDF bigger than this gets dropped (broken-era monsters)
  var EWT_PDF_BUDGET = 1200 * 1024;     // total PDF bytes kept across the whole bundle

  // Size-aware retention: keep newest PDFs while they fit the byte budget; the
  // record's data fields always survive even when its PDF is dropped.
  function trimEwtArray(data) {
    if (!Array.isArray(data)) return data;
    if (data.length > EWT_MAX) data = data.slice(data.length - EWT_MAX);
    var budget = EWT_PDF_BUDGET, kept = 0;
    for (var i = data.length - 1; i >= 0; i--) {
      var rec = data[i];
      if (!rec || !rec.pdf) continue;
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
      uploadEwtPdf(rec);
    } catch (err) {}
  });

  function uploadEwtPdf(rec) {
    if (!rec || !rec.pdf || rec.pdfBlob) return;
    apiFetch('/api/ewt-pdf', { method: 'POST', body: { ticketNo: rec.ticketNo, date: rec.date, pdf: rec.pdf } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (res) {
        if (!res || !res.ok || !res.path) return; // blob not configured / failed — inline copy stays
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
            '<div style="font-size:11px;color:var(--gray);margin-top:2px">Tickets ' + (c.trucking_tickets || 0) + ' · Load counts ' + (c.load_count || 0) + ' · EWT ' + (c.ewt_records || 0) + ' · Spreads ' + ((c.cpy_posts || 0) + (c.flat_posts || 0)) + ' · Last active ' + esc(last) + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;align-items:center">' +
            '<select data-role-for="' + esc(u.id) + '" style="font-family:inherit;padding:6px;border:1px solid var(--border);border-radius:8px">' + sel + '</select>' +
            '<button data-view-for="' + esc(u.id) + '" data-name="' + esc(u.name || u.email) + '" style="font-family:inherit;padding:6px 10px;border:1px solid var(--border);background:#fff;border-radius:8px;cursor:pointer">View</button>' +
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
      var html = '<div style="margin-top:12px;padding:14px;border:1px solid var(--border);border-radius:12px;background:#fff">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
          '<strong style="font-size:15px">' + esc(name) + '</strong>' +
          '<button id="admin-detail-close" style="border:none;background:#f3f4f6;border-radius:8px;padding:6px 10px;cursor:pointer;font-family:inherit">Close</button>' +
        '</div>' +
        section('Truck Tickets (' + (Array.isArray(tickets) ? tickets.length : 0) + ')', ticketsHtml(tickets)) +
        section('Load Count', loadCountHtml(loadCount)) +
        section('Extra Work Tickets (' + (Array.isArray(ewt) ? ewt.length : 0) + ')', ewtHtml(ewt)) +
        (function () {
          var posts = (rec.cpy_posts && rec.cpy_posts.data) || [];
          return section('Posted Spreads — Cost Per Yard (' + posts.length + ')' + updatedTag(rec.cpy_posts), spreadsHtml(posts));
        })() +
        (function () {
          var posts = (rec.flat_posts && rec.flat_posts.data) || [];
          return section('Posted Spreads — Flat Work (' + posts.length + ')' + updatedTag(rec.flat_posts), flatPostsHtml(posts));
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

  function section(title, inner) {
    return '<details style="margin-top:8px" open><summary style="cursor:pointer;font-weight:600;font-size:13px;color:var(--dark)">' + esc(title) + '</summary><div style="font-size:12px;color:var(--dark);margin-top:6px;overflow-x:auto">' + inner + '</div></details>';
  }
  function ticketsHtml(t) {
    if (!Array.isArray(t) || !t.length) return '<em style="color:var(--gray)">None</em>';
    return t.map(function (x) {
      return '<div style="padding:6px 0;border-bottom:1px solid var(--light-gray)">#' + esc(x.pitTicketNo || x.truckNum || '—') +
        ' · ' + esc(x.commodity || x.commodityType || '') + ' · ' + esc(x.date || '') +
        ' · ' + esc(x.tons || '') + 't / ' + esc(x.yards || '') + 'cy · ' + esc(x.truckingCo || '') + '</div>';
    }).join('');
  }
  function loadCountHtml(lc) {
    if (!lc || !lc.trucks) return '<em style="color:var(--gray)">None</em>';
    var head = 'Source ' + esc(lc.source || '—') + ' · ' + esc(lc.date || '') + ' · Job ' + esc(lc.jobNum || '—') + '<br>';
    var trucks = (lc.trucks || []).map(function (tr) {
      var loads = (tr.loads || []).length;
      return '· Truck ' + esc(tr.truckNo || tr.truckTypeId || '—') + ' — ' + loads + ' loads (' + esc(tr.name || '') + ')';
    }).join('<br>');
    return head + trucks;
  }
  var ADMIN_EWT_CACHE = [];
  var ADMIN_EWT_OWNER = '';
  function ewtHtml(e) {
    ADMIN_EWT_CACHE = Array.isArray(e) ? e : [];
    if (!ADMIN_EWT_CACHE.length) return '<em style="color:var(--gray)">None</em>';
    return ADMIN_EWT_CACHE.map(function (x, i) {
      return '<div style="padding:6px 0;border-bottom:1px solid var(--light-gray)">Ticket ' + esc(x.ticketNo || '—') + ' · ' + esc(x.date || '') +
        ' · ' + esc(x.customer || '') + (x.signed ? ' · signed' + (x.printName ? ' (' + esc(x.printName) + ')' : '') : (x.printName ? ' · ' + esc(x.printName) : '')) +
        ((x.pdf || x.pdfBlob) ? ' <button type="button" data-ewt-pdf="' + i + '" style="margin-left:6px;padding:2px 10px;border-radius:99px;border:none;background:#f4f5f7;color:#23272e;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer">Open PDF</button>' : '') +
        '<br><span style="color:var(--gray)">' + esc((x.description || '').slice(0, 140)) + '</span></div>';
    }).join('');
  }
  function openPdfBytes(bytes) {
    var blob = new Blob([bytes], { type: 'application/pdf' });
    window.open(URL.createObjectURL(blob), '_blank');
  }
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
      return '<th style="text-align:' + (h.num ? 'right' : 'left') + ';padding:3px 8px;font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:#8b919b;background:#fafbfc;border:1px solid #eef0f3;font-weight:600;white-space:nowrap">' + esc(h.label) + '</th>';
    }).join('');
    var body = rows.map(function (r) {
      return '<tr>' + r.map(function (v, i) {
        return '<td style="text-align:' + (headers[i].num ? 'right' : 'left') + ';padding:3px 8px;font-size:11px;border:1px solid #eef0f3;white-space:nowrap;font-variant-numeric:tabular-nums">' + v + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return '<div style="overflow-x:auto;margin:3px 0 6px"><table style="border-collapse:collapse;min-width:100%">' +
      '<tr>' + th + '</tr>' + body + '</table></div>';
  }
  function postCaption(s, extra) {
    var when = s.ts ? new Date(s.ts).toLocaleString([], { month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' }) : '';
    var proj = s.projectCode ? ' · <b style="color:var(--dark)">' + esc(s.projectCode) + '</b> ' + esc(s.projectName || '') : '';
    return '<div style="font-size:10.5px;color:var(--gray);margin-top:8px"><b style="color:var(--dark)">' + esc(when) + '</b> · ' + esc(s.state || '') + proj + extra + '</div>';
  }

  function spreadsHtml(arr) {
    if (!Array.isArray(arr) || !arr.length) return none();
    return arr.slice().reverse().map(function (s) {
      var cap = postCaption(s, ' · ' + esc(s.hoursPerDay != null ? s.hoursPerDay : '—') + ' hrs/day · yd/load ' + esc(s.ydPerLoad != null ? s.ydPerLoad : '—'));
      var stats = tbl(
        [{label:'Producers',num:1},{label:'Dirt cy',num:1},{label:'Rock cy',num:1},{label:'Cy/day',num:1},{label:'$/day',num:1},{label:'CPY',num:1},{label:'To move',num:1},{label:'Days',num:1}],
        [[fmtNum(s.producerQty), fmtNum(s.dirtYards), fmtNum(s.rockYards), fmtNum(s.totalYards), '$' + fmtNum(s.totalCost), '$' + esc(s.costPerYard != null ? s.costPerYard : '—'),
          s.yardsToMove ? fmtNum(s.yardsToMove) : '—', s.daysToComplete ? esc(s.daysToComplete) : '—']]);
      var machines = tbl(
        [{label:'Machine'},{label:'Qty',num:1},{label:'Rnd min',num:1},{label:'Cy/day',num:1}],
        (s.producers || []).map(function (p) {
          return [esc(p.name), esc(p.qty), p.roundTime ? esc(p.roundTime) : '—', fmtNum(p.yardsPerDay)];
        }));
      return cap + stats + machines;
    }).join('');
  }

  function flatPostsHtml(arr) {
    if (!Array.isArray(arr) || !arr.length) return none();
    return arr.slice().reverse().map(function (s) {
      var cap = postCaption(s, ' · ' + esc(s.hoursPerDay != null ? s.hoursPerDay : '—') + ' hrs/day');
      var stats = tbl(
        [{label:'Equip',num:1},{label:'SqFt/day',num:1},{label:'Job SqFt',num:1},{label:'$/day',num:1},{label:'$/SqFt',num:1},{label:'Days',num:1}],
        [[fmtNum(s.equipQty), fmtNum(s.sqftPerDay), fmtNum(s.jobSqft), '$' + fmtNum(s.totalCost),
          s.costPerSqFt ? '$' + esc(s.costPerSqFt) : '—', s.daysToComplete ? esc(s.daysToComplete) : '—']]);
      var items = tbl(
        [{label:'Equipment'},{label:'Qty',num:1},{label:'$/day',num:1}],
        (s.items || []).map(function (p) { return [esc(p.name), esc(p.qty), '$' + fmtNum(p.costPerDay)]; }));
      return cap + stats + items;
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
