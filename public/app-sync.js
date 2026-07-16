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
    box.innerHTML = '<div style="color:#fbbf24;font-weight:700;margin-bottom:6px">DIAGNOSTIC — /api/me (tap to close)</div>' +
      '<div>HTTP status: <b>' + status + '</b></div>' +
      '<div style="margin-top:6px">' + esc(String(txt).slice(0, 1200)) + '</div>';
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
      '<button id="acct-btn" title="' + esc(me.email) + '" style="width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:#2563eb;color:#fff;font-weight:600;cursor:pointer;font-family:inherit">' + esc(initials) + '</button>' +
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
    window.addEventListener('online', flushPending);
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushNow();
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
    return apiFetch('/api/records', { method: 'POST', body: { type: type, data: data } })
      .then(function (r) {
        if (r.ok) {
          var p = getPending(); delete p[lsKey]; setPending(p);
          if (Object.keys(getPending()).length === 0) setSyncStatus('All changes saved', '#059669');
        } else {
          setSyncStatus('Will retry when online', '#6b7280');
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

  // ---------- EWT capture (persist submitted Extra Work Tickets for admin review) ----------
  function installEwtCapture() {
    ['ewt-email-btn', 'ewt-preview-btn'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener('click', function () { setTimeout(captureEwt, 50); }, true);
    });
  }
  function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  function scrapeRows(containerId) {
    var c = document.getElementById(containerId);
    if (!c) return [];
    var rows = [];
    c.querySelectorAll('.row, tr, [data-row], div').forEach(function () {});
    // Collect input/textarea values grouped by their nearest row container.
    var inputs = c.querySelectorAll('input, textarea, select');
    var current = [];
    inputs.forEach(function (inp) {
      if (inp.value && inp.value.trim()) current.push(inp.value.trim());
    });
    return current;
  }
  function captureEwt() {
    try {
      var rec = {
        ts: new Date().toISOString(),
        ticketNo: val('ewt-ticket-no'), date: val('ewt-date'),
        customer: val('ewt-customer'), jobAddress: val('ewt-job-address'),
        city: val('ewt-city'), state: val('ewt-state'),
        po: val('ewt-po'), jobNum: val('ewt-job-num'), phase: val('ewt-phase'),
        description: val('ewt-description'), acceptedTitle: val('ewt-title'),
        labor: scrapeRows('ewt-labor-rows'),
        equipment: scrapeRows('ewt-equipment-rows'),
        materials: scrapeRows('ewt-materials-rows')
      };
      // Skip empty saves.
      if (!rec.ticketNo && !rec.customer && !rec.description) return;
      var arr;
      try { arr = JSON.parse(localStorage.getItem(EWT_KEY) || '[]'); } catch (e) { arr = []; }
      // De-dupe by ticketNo+date within the session (update in place).
      var idx = arr.findIndex(function (x) { return x.ticketNo === rec.ticketNo && x.date === rec.date; });
      if (idx >= 0) arr[idx] = rec; else arr.push(rec);
      if (arr.length > 300) arr = arr.slice(arr.length - 300);
      localStorage.setItem(EWT_KEY, JSON.stringify(arr)); // triggers sync via hook
    } catch (e) {}
  }

  // ---------- admin console ----------
  function enableAdmin() {
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
            '<div style="font-size:11px;color:var(--gray);margin-top:2px">Tickets ' + (c.trucking_tickets || 0) + ' · Load counts ' + (c.load_count || 0) + ' · EWT ' + (c.ewt_records || 0) + ' · Last active ' + esc(last) + '</div>' +
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
        section('Cost Per Yard' + updatedTag(rec.cpy_state), cpyHtml(rec.cpy_state && rec.cpy_state.data)) +
        section('Flat Work' + updatedTag(rec.flat_state), flatHtml(rec.flat_state && rec.flat_state.data)) +
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
  function ewtHtml(e) {
    if (!Array.isArray(e) || !e.length) return '<em style="color:var(--gray)">None</em>';
    return e.map(function (x) {
      return '<div style="padding:6px 0;border-bottom:1px solid var(--light-gray)">Ticket ' + esc(x.ticketNo || '—') + ' · ' + esc(x.date || '') +
        ' · ' + esc(x.customer || '') + '<br><span style="color:var(--gray)">' + esc((x.description || '').slice(0, 140)) + '</span></div>';
    }).join('');
  }
  function updatedTag(entry) {
    if (!entry || !entry.updatedAt) return '';
    try { return ' — as of ' + new Date(entry.updatedAt).toLocaleDateString(); } catch (e) { return ''; }
  }
  function none() { return '<em style="color:var(--gray)">None</em>'; }
  function equipList(items) {
    return items.map(function (it) {
      return '· ' + esc(it.name || '?') + '  ×' + esc(it.quantity != null ? it.quantity : 1) + '  ($' + esc(it.rate || 0) + '/hr)' +
        (it.producer && it.roundTime ? '  — round ' + esc(it.roundTime) + ' min' : '');
    }).join('<br>');
  }
  function cpyHtml(st) {
    // Synced state uses `job`; keep `items` as a fallback for older snapshots.
    var items = st && (st.job || st.items);
    if (!st || !Array.isArray(items) || !items.length) return none();
    var head = 'Hours/day ' + esc(st.hoursPerDay != null ? st.hoursPerDay : '—') +
      ' · Yd/load ' + esc(st.ydPerLoad != null ? st.ydPerLoad : '—') +
      ' · Yards to move ' + esc(st.yardsToMove || 0) +
      (st.procShifts ? ' · Processor shifts ' + esc(st.procShifts) + ' × ' + esc(st.procShiftHours != null ? st.procShiftHours : '—') + 'h' : '') + '<br>';
    return head + equipList(items);
  }
  function flatHtml(st) {
    // Synced state uses `flatJob`/`flat*` keys; keep old names as fallback.
    var items = st && (st.flatJob || st.items);
    if (!st || !Array.isArray(items) || !items.length) return none();
    var hours = st.flatHoursPerDay != null ? st.flatHoursPerDay : st.hoursPerDay;
    var head = 'Hours/day ' + esc(hours != null ? hours : '—') +
      ' · SqFt/day ' + esc(st.flatSqftPerDay || st.sqftPerDay || 0) +
      ' · Job size ' + esc(st.flatJobSqft || st.jobSqft || 0) + ' sqft<br>';
    return head + equipList(items);
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
