/* EBCC Field Assistant — job map.
 *
 * Lives in the Active Jobs job page (Map tab) and is reached from Job Books
 * with the Map button. It draws whatever KMZ / KML file is in the job's Plans
 * folder: every folder in the file is a layer that can be switched on or off.
 * On top sits the geotech layer — borings an AI read out of the soils report
 * (/api/job-map) — tap one to see what the log recorded there.
 *
 * Leaflet and JSZip load from cdnjs the first time a map is opened, so the
 * rest of the app never pays for them.
 */
(function () {
  'use strict';
  var LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
  var LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
  var JSZIP_JS = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  var FILE_PREF_KEY = 'ebcc_jobmap_file_v1';     // { code: "folder/name" } — this device's pick per job
  var LAYER_PREF_KEY = 'ebcc_jobmap_layers_v1';  // { "code|file": { key: true|false } } — layer switches
  var MAX_FILE_BYTES = 40 * 1024 * 1024;

  var esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var escA = function (s) { return esc(s).replace(/"/g, '&quot;'); };
  var isAdmin = function () { return !!window.EBCC_IS_ADMIN; };
  var $ = function (id) { return document.getElementById(id); };
  var readPref = function (k) { try { var v = JSON.parse(localStorage.getItem(k) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } };
  var writePref = function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  var M = {
    code: null, built: false, map: null, libs: null,
    files: [], pdfs: [], filesFor: null, filesErr: false,
    sel: null,            // { folder, name, size, lastModified }
    parsed: null,         // { key, title, layers: [...], bounds }
    parseCache: {},       // file key -> parsed
    loadingFile: '', fileErr: '',
    state: null,          // server map doc (public shape)
    stateFor: null,
    base: 'sat', baseLayers: {},
    strength: 0.7,        // multiplier on polygon fill + image opacity
    showBorings: true,
    selBoring: null, placing: null, driving: false,
    pollTimer: null, objectUrls: [],
    me: null, watchId: null,
  };

  // ------------------------------------------------------------------ loading libraries
  function loadScript(src) {
    return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { rej(new Error('Could not load ' + src)); }; document.head.appendChild(s); });
  }
  function ensureLibs() {
    if (M.libs) return M.libs;
    var css = document.createElement('link'); css.rel = 'stylesheet'; css.href = LEAFLET_CSS; document.head.appendChild(css);
    M.libs = Promise.all([window.L ? null : loadScript(LEAFLET_JS), window.JSZip ? null : loadScript(JSZIP_JS)]).then(defineQuadOverlay)
      .catch(function (e) { M.libs = null; throw e; });
    return M.libs;
  }

  // An image pinned by three corners, so a takeoff's rotated cut/fill sheet
  // (gx:LatLonQuad, or a LatLonBox with rotation) lands where it belongs.
  var QuadOverlay = null;
  function defineQuadOverlay() {
    var L = window.L;
    if (QuadOverlay || !L) return;
    QuadOverlay = L.ImageOverlay.extend({
      initialize: function (url, quad, options) {
        this._quad = quad;
        L.ImageOverlay.prototype.initialize.call(this, url, L.latLngBounds([quad.tl, quad.tr, quad.bl, quad.br]), options);
      },
      onAdd: function (map) {
        L.ImageOverlay.prototype.onAdd.call(this, map);
        this._image.style.transformOrigin = '0 0';
        this.on('load', this._reset, this);
      },
      _reset: function () { var map = this._map; if (map) this._place(function (p) { return map.latLngToLayerPoint(p); }); },
      _animateZoom: function (e) { var map = this._map; this._place(function (p) { return map._latLngToNewLayerPoint(p, e.zoom, e.center); }); },
      _place: function (proj) {
        var img = this._image, w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return;
        var tl = proj(this._quad.tl), tr = proj(this._quad.tr), bl = proj(this._quad.bl);
        img.style.width = w + 'px'; img.style.height = h + 'px';
        img.style.transform = 'matrix(' + [(tr.x - tl.x) / w, (tr.y - tl.y) / w, (bl.x - tl.x) / h, (bl.y - tl.y) / h, tl.x, tl.y].join(',') + ')';
      },
    });
  }

  // ------------------------------------------------------------------ KML / KMZ
  function kids(el, name) { var out = []; for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) out.push(c); return out; }
  function kid(el, name) { for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) return c; return null; }
  function text(el, name) { var c = kid(el, name); return c ? String(c.textContent || '').trim() : ''; }
  function deep(el, name) { var l = el.getElementsByTagNameNS('*', name); return l && l.length ? l[0] : null; }
  // KML colours are aabbggrr.
  function kmlColor(v) {
    v = String(v || '').trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{8}$/.test(v)) return null;
    return { color: '#' + v.slice(6, 8) + v.slice(4, 6) + v.slice(2, 4), opacity: Math.round(parseInt(v.slice(0, 2), 16) / 255 * 100) / 100 };
  }
  function coords(str) {
    var out = [];
    String(str || '').trim().split(/\s+/).forEach(function (t) {
      var p = t.split(',');
      var lon = parseFloat(p[0]), lat = parseFloat(p[1]);
      if (isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) out.push([lat, lon]);
    });
    return out;
  }
  function readStyle(el) {
    var s = {};
    var ls = kid(el, 'LineStyle'), ps = kid(el, 'PolyStyle'), is = kid(el, 'IconStyle');
    if (ls) { var c = kmlColor(text(ls, 'color')); if (c) { s.color = c.color; s.opacity = c.opacity; } var w = parseFloat(text(ls, 'width')); if (isFinite(w)) s.weight = Math.max(1, Math.min(8, w)); }
    if (ps) { var f = kmlColor(text(ps, 'color')); if (f) { s.fillColor = f.color; s.fillOpacity = f.opacity; } if (text(ps, 'fill') === '0') s.fill = false; if (text(ps, 'outline') === '0') s.stroke = false; }
    if (is) { var ic = kmlColor(text(is, 'color')); if (ic) s.iconColor = ic.color; }
    return s;
  }
  function plainText(html) {
    var s = String(html || '');
    if (!s) return '';
    if (/[<&]/.test(s)) {
      // Takeoff programs write quantities as HTML tables: keep each table row on one line.
      try {
        var d = new DOMParser().parseFromString('<div>' + s.replace(/\s*[\r\n]+\s*/g, ' ').replace(/<\/?br\s*\/?>/gi, '\n').replace(/<\/(p|tr|li|table|h\d)>/gi, '\n').replace(/<\/t[dh]>/gi, ' ') + '</div>', 'text/html');
        s = d.body.textContent || '';
      } catch (e) {}
    }
    return s.replace(/ /g, ' ').split('\n').map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); })
      .filter(function (l) { return l && !/^created with /i.test(l); }).join('\n').slice(0, 1500);
  }
  function geometries(el, out) {
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      var n = c.localName;
      if (n === 'Point') { var p = coords(text(c, 'coordinates')); if (p.length) out.push({ type: 'point', at: p[0] }); }
      else if (n === 'LineString' || n === 'LinearRing') { var l = coords(text(c, 'coordinates')); if (l.length > 1) out.push({ type: 'line', pts: l }); }
      else if (n === 'Polygon') {
        var rings = [];
        var ob = kid(c, 'outerBoundaryIs'), lr = ob && kid(ob, 'LinearRing');
        var outer = lr ? coords(text(lr, 'coordinates')) : [];
        if (outer.length > 2) {
          rings.push(outer);
          kids(c, 'innerBoundaryIs').forEach(function (ib) { var r = kid(ib, 'LinearRing'); var pts = r ? coords(text(r, 'coordinates')) : []; if (pts.length > 2) rings.push(pts); });
          out.push({ type: 'poly', rings: rings });
        }
      } else if (n === 'MultiGeometry') geometries(c, out);
    }
    return out;
  }
  // -> { title, layers:[{ key, path, name, group, on, features, overlays, color, count }], bounds:[[s,w],[n,e]] }
  function parseKml(xmlText) {
    var doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('This file is not valid KML.');
    var root = doc.documentElement;
    if (!root || root.localName !== 'kml') { var k = deep(doc, 'kml'); if (k) root = k; }
    // shared styles
    var styles = {}, maps = {};
    var all = doc.getElementsByTagNameNS('*', 'Style');
    for (var i = 0; i < all.length; i++) { var id = all[i].getAttribute('id'); if (id) styles[id] = readStyle(all[i]); }
    var sm = doc.getElementsByTagNameNS('*', 'StyleMap');
    for (var j = 0; j < sm.length; j++) {
      var mid = sm[j].getAttribute('id'); if (!mid) continue;
      kids(sm[j], 'Pair').forEach(function (pr) { if (text(pr, 'key') === 'normal' || !maps[mid]) maps[mid] = text(pr, 'styleUrl'); });
    }
    function styleOf(el) {
      var s = {};
      var url = text(el, 'styleUrl');
      for (var hop = 0; url && hop < 3; hop++) {
        var sid = url.slice(url.lastIndexOf('#') + 1);
        if (styles[sid]) { s = Object.assign({}, styles[sid]); break; }
        url = maps[sid] || '';
      }
      var inline = kid(el, 'Style');
      if (inline) s = Object.assign(s, readStyle(inline));
      return s;
    }
    var layers = [], byKey = {};
    var b = { s: 90, w: 180, n: -90, e: -180 };
    function grow(lat, lon) { if (lat < b.s) b.s = lat; if (lat > b.n) b.n = lat; if (lon < b.w) b.w = lon; if (lon > b.e) b.e = lon; }
    function layerFor(path, on) {
      var p = path.length ? path : ['General'];
      var key = p.join(' / ');
      if (!byKey[key]) { byKey[key] = { key: key, path: p, name: p.length > 1 ? p.slice(1).join(' › ') : p[0], group: p.length > 1 ? p[0] : '', on: on, features: [], overlays: [], color: '', count: 0 }; layers.push(byKey[key]); }
      return byKey[key];
    }
    var title = '';
    var rootMarks = 0;
    (function count(el) { for (var c = el.firstElementChild; c; c = c.nextElementSibling) { if (c.localName === 'Document') count(c); else if (c.localName === 'Placemark') rootMarks++; } })(root);
    function walk(el, path, on, top) {
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
        var n = c.localName;
        if (n === 'Document' || n === 'Folder') {
          var nm = text(c, 'name') || (n === 'Folder' ? 'Folder' : '');
          var vis = on && text(c, 'visibility') !== '0';
          if (n === 'Document' && top) { title = title || nm; walk(c, path, vis, false); }
          else walk(c, nm ? path.concat(nm) : path, vis, false);
        } else if (n === 'Placemark') {
          var gs = geometries(c, []);
          if (!gs.length) continue;
          var pmName = text(c, 'name');
          // Loose items at the top of the file ("Design Lines", "Perimeter") each get a switch of their own.
          var ly = layerFor(!path.length && pmName && rootMarks <= 8 ? [pmName] : path, on);
          var st = styleOf(c);
          var ext = [];
          var ed = kid(c, 'ExtendedData');
          if (ed) {
            kids(ed, 'Data').forEach(function (d) { var v = text(d, 'value'); if (v) ext.push([text(d, 'displayName') || d.getAttribute('name') || '', v]); });
            var sds = ed.getElementsByTagNameNS('*', 'SimpleData');
            for (var q = 0; q < sds.length && ext.length < 24; q++) { var sv = String(sds[q].textContent || '').trim(); if (sv) ext.push([sds[q].getAttribute('name') || '', sv]); }
          }
          ly.features.push({ name: pmName, desc: plainText(text(c, 'description')), ext: ext.slice(0, 24), style: st, geoms: gs, hidden: text(c, 'visibility') === '0' });
          ly.count++;
          if (!ly.color) ly.color = st.fillColor || st.color || st.iconColor || '';
          gs.forEach(function (g) {
            if (g.type === 'point') grow(g.at[0], g.at[1]);
            else (g.type === 'line' ? [g.pts] : g.rings).forEach(function (r) { r.forEach(function (p) { grow(p[0], p[1]); }); });
          });
        } else if (n === 'GroundOverlay') {
          var icon = kid(c, 'Icon'), href = icon ? text(icon, 'href') : '';
          if (!href) continue;
          var quad = null;
          var q4 = deep(c, 'LatLonQuad'), box = kid(c, 'LatLonBox');
          if (q4) { var qp = coords(text(q4, 'coordinates')); if (qp.length === 4) quad = { bl: qp[0], br: qp[1], tr: qp[2], tl: qp[3] }; }
          else if (box) {
            var N = parseFloat(text(box, 'north')), S = parseFloat(text(box, 'south')), E = parseFloat(text(box, 'east')), W = parseFloat(text(box, 'west')), rot = parseFloat(text(box, 'rotation')) || 0;
            if ([N, S, E, W].every(isFinite)) {
              quad = { tl: [N, W], tr: [N, E], bl: [S, W], br: [S, E] };
              if (rot) {   // KML rotates counter-clockwise about the box centre
                var clat = (N + S) / 2, clon = (E + W) / 2, kx = Math.cos(clat * Math.PI / 180), a = rot * Math.PI / 180;
                Object.keys(quad).forEach(function (k2) {
                  var dx = (quad[k2][1] - clon) * kx, dy = quad[k2][0] - clat;
                  quad[k2] = [clat + dx * Math.sin(a) + dy * Math.cos(a), clon + (dx * Math.cos(a) - dy * Math.sin(a)) / kx];
                });
              }
            }
          }
          if (!quad) continue;
          var oc = kmlColor(text(c, 'color'));
          var lyr = layerFor(path, on);
          lyr.overlays.push({ name: text(c, 'name'), desc: plainText(text(c, 'description')), href: href, quad: quad, opacity: oc ? oc.opacity : 1, order: parseFloat(text(c, 'drawOrder')) || 0, hidden: text(c, 'visibility') === '0' });
          lyr.count++;
          Object.keys(quad).forEach(function (k3) { grow(quad[k3][0], quad[k3][1]); });
        }
      }
    }
    walk(root, [], true, true);
    layers = layers.filter(function (l) { return l.count > 0; });
    layers.forEach(function (l) {
      if (l.group || !layers.some(function (x) { return x.group === l.path[0]; })) return;
      l.group = l.path[0];
      var only = l.features.length + l.overlays.length === 1 ? (l.features[0] || l.overlays[0]).name : '';
      l.name = only || 'Everything else';
    });
    // keep each group's members together, in file order
    var order = {};
    layers.forEach(function (l, i) { var k = l.group || l.key; if (order[k] == null) order[k] = i; });
    layers = layers.map(function (l, i) { return { l: l, i: i }; }).sort(function (a, b2) { return (order[a.l.group || a.l.key] - order[b2.l.group || b2.l.key]) || (a.i - b2.i); }).map(function (x) { return x.l; });
    return { title: title, layers: layers, bounds: b.n >= b.s ? [[b.s, b.w], [b.n, b.e]] : null };
  }

  function fileKey(f) { return (f.folder || '') + '/' + f.name; }
  function fileUrl(code, f, extra) {
    return '/api/project-files?project=' + encodeURIComponent(code) + '&name=' + encodeURIComponent(f.name) + (f.folder ? '&folder=' + encodeURIComponent(f.folder) : '') + (extra || '');
  }
  // Fetch + unpack one KMZ/KML. Images inside a KMZ become object URLs.
  function loadMapFile(code, f) {
    var cacheKey = code + '|' + fileKey(f) + '|' + (f.lastModified || '') + '|' + (f.size || '');
    if (M.parseCache[cacheKey]) return Promise.resolve(M.parseCache[cacheKey]);
    if (f.size > MAX_FILE_BYTES) return Promise.reject(new Error('That file is ' + Math.round(f.size / 1048576) + ' MB — too large to draw here. Export a lighter KMZ (vectors without the big background images).'));
    return fetch(fileUrl(code, f)).then(function (r) { if (!r.ok) throw new Error('Could not download the file (' + r.status + ').'); return r.arrayBuffer(); }).then(function (buf) {
      var bytes = new Uint8Array(buf);
      var isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
      if (!isZip) return { xml: new TextDecoder('utf-8').decode(bytes), zip: null };
      return window.JSZip.loadAsync(buf).then(function (zip) {
        var names = Object.keys(zip.files).filter(function (n) { return !zip.files[n].dir && /\.kml$/i.test(n); });
        if (!names.length) throw new Error('No KML found inside that KMZ.');
        names.sort(function (a, b2) { return (a.split('/').length - b2.split('/').length) || (/^doc\.kml$/i.test(b2) ? 1 : 0) - (/^doc\.kml$/i.test(a) ? 1 : 0) || a.length - b2.length; });
        return zip.files[names[0]].async('string').then(function (xml) { return { xml: xml, zip: zip, base: names[0].indexOf('/') >= 0 ? names[0].slice(0, names[0].lastIndexOf('/') + 1) : '' }; });
      });
    }).then(function (src) {
      var parsed = parseKml(src.xml);
      parsed.key = cacheKey;
      // image lookup inside the KMZ, tolerant of case, slashes and URL-encoding
      var index = {};
      if (src.zip) Object.keys(src.zip.files).forEach(function (n) { index[n.toLowerCase()] = n; });
      var urls = {};
      parsed.resolve = function (href) {
        if (/^https?:\/\//i.test(href)) return Promise.resolve(href);
        if (!src.zip) return Promise.resolve(null);
        var h = String(href).replace(/\\/g, '/').replace(/^\.\//, '');
        var tries = [src.base + h, h];
        try { var d = decodeURIComponent(h); tries.push(src.base + d, d); } catch (e) {}
        var hit = null;
        tries.some(function (t) { hit = index[t.toLowerCase()] || null; return !!hit; });
        if (!hit) return Promise.resolve(null);
        if (!urls[hit]) {
          var ext = hit.toLowerCase().split('.').pop();
          var type = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
          urls[hit] = src.zip.files[hit].async('arraybuffer').then(function (ab) { var u = URL.createObjectURL(new Blob([ab], { type: type })); M.objectUrls.push(u); return u; });
        }
        return urls[hit];
      };
      M.parseCache[cacheKey] = parsed;
      return parsed;
    });
  }

  // ------------------------------------------------------------------ DOM
  var CSS = [
    '#ajm-stage{position:relative;height:min(68vh,620px);min-height:340px;border:1px solid var(--border);border-radius:14px;overflow:hidden;background:#dfe5ea;margin-top:8px}',
    '#ajm-stage.is-full{position:fixed;inset:0;height:auto;z-index:4000;border-radius:0;border:0;margin:0}',
    '#ajm-map{position:absolute;inset:0;z-index:1}',
    '#ajm-map .leaflet-container,#ajm-map{font-family:inherit}',
    // tool buttons with the layers panel stacked under them, however the buttons wrap
    '.ajm-top{position:absolute;top:10px;left:10px;right:10px;bottom:10px;z-index:20;display:flex;flex-direction:column;align-items:flex-start;gap:8px;pointer-events:none}',
    '.ajm-top>*{pointer-events:auto}',
    '.ajm-tools{display:flex;gap:6px;flex-wrap:wrap;flex:none}',
    '.ajm-tool{font:inherit;font-size:12.5px;font-weight:650;padding:7px 11px;border-radius:99px;border:1px solid rgba(0,0,0,.14);background:#fff;color:#23272e;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.18)}',
    '.ajm-tool.on{background:#23272e;color:#fff;border-color:#23272e}',
    '#ajm-layers{flex:0 1 auto;min-height:0;width:min(310px,100%);overflow:auto;background:var(--card);color:var(--dark);border:1px solid var(--border);border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.25);padding:10px 12px;font-size:13px;display:none}',
    '#ajm-layers.open{display:block}',
    '.ajm-lh{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--gray);margin:10px 0 4px}',
    '.ajm-lh:first-child{margin-top:0}',
    '.ajm-row{display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;min-height:30px}',
    '.ajm-row input{width:17px;height:17px;flex:none;accent-color:var(--orange)}',
    '.ajm-row .nm{flex:1;min-width:0;overflow-wrap:anywhere;line-height:1.25}',
    '.ajm-row .ct{font-size:11px;color:var(--gray);flex:none}',
    '.ajm-sw{width:12px;height:12px;border-radius:3px;flex:none;border:1px solid rgba(0,0,0,.25)}',
    '.ajm-grp>.ajm-row{font-weight:650}',
    '.ajm-grp .ajm-kids{margin-left:14px;border-left:2px solid var(--border);padding-left:8px;display:none}',
    '.ajm-grp.open .ajm-kids{display:block}',
    '.ajm-caret{border:0;background:none;color:var(--gray);font-size:13px;cursor:pointer;padding:4px 6px;margin:-4px -4px -4px 0;flex:none}',
    '.ajm-grp.open .ajm-caret{transform:rotate(90deg)}',
    '.ajm-links{display:flex;gap:12px;font-size:12px;margin:4px 0 2px}',
    '.ajm-links button{border:0;background:none;color:var(--orange);font:inherit;font-weight:650;cursor:pointer;padding:2px 0}',
    '#ajm-banner{position:absolute;left:50%;transform:translateX(-50%);bottom:14px;z-index:22;background:#23272e;color:#fff;font-size:13px;font-weight:650;padding:9px 14px;border-radius:99px;box-shadow:0 4px 16px rgba(0,0,0,.35);display:none;max-width:calc(100% - 24px);text-align:center}',
    '#ajm-banner button{margin-left:10px;border:0;background:rgba(255,255,255,.18);color:#fff;font:inherit;font-weight:700;border-radius:99px;padding:3px 10px;cursor:pointer}',
    '#ajm-sheet{position:absolute;left:0;right:0;bottom:0;z-index:23;max-height:62%;overflow:auto;background:var(--card);color:var(--dark);border-top:1px solid var(--border);border-radius:16px 16px 0 0;box-shadow:0 -8px 28px rgba(0,0,0,.28);padding:12px 14px 16px;display:none}',
    '#ajm-sheet.open{display:block}',
    '.ajm-sh-top{display:flex;align-items:flex-start;gap:10px}',
    '.ajm-sh-top h4{margin:0;font-size:17px;letter-spacing:-.01em}',
    '.ajm-x{margin-left:auto;border:0;background:var(--soft);color:var(--dark);border-radius:50%;width:30px;height:30px;font-size:17px;line-height:1;cursor:pointer;flex:none}',
    '.ajm-meta{font-size:12.5px;color:var(--gray);margin:2px 0 8px}',
    '.ajm-kv{font-size:13.5px;margin:4px 0;line-height:1.4}',
    '.ajm-kv b{font-weight:650}',
    '.ajm-tbl{width:100%;border-collapse:collapse;font-size:12.5px;margin:6px 0 10px}',
    '.ajm-tbl th{text-align:left;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--gray);font-weight:700;padding:4px 8px 4px 0;border-bottom:1px solid var(--border);white-space:nowrap}',
    '.ajm-tbl td{padding:5px 8px 5px 0;border-bottom:1px solid var(--border);vertical-align:top;line-height:1.35}',
    '.ajm-tbl td.d{white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:650}',
    '.ajm-scroll{overflow-x:auto}',
    '.ajm-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}',
    '.ajm-fine{font-size:11px;color:var(--gray);margin-top:8px;line-height:1.4}',
    '.ajm-bor{display:flex;align-items:center;gap:4px;white-space:nowrap;transform:translate(-9px,-9px);cursor:pointer}',
    '.ajm-bor i{width:18px;height:18px;border-radius:50%;background:#b45309;border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.6);flex:none;display:block;box-sizing:border-box}',
    '.ajm-bor span{font-size:11.5px;font-weight:750;color:#fff;background:rgba(20,24,30,.82);border-radius:6px;padding:1px 5px;line-height:1.35}',
    '.ajm-bor.is-pit i{border-radius:4px}',
    '.ajm-bor.is-manual i{background:#0e7490}',
    '.ajm-bor.is-sel i{background:#dc2626;transform:scale(1.25)}',
    '.ajm-bor.is-sel span{background:#dc2626}',
    '.ajm-me{width:16px;height:16px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 2px rgba(37,99,235,.35),0 1px 4px rgba(0,0,0,.5);transform:translate(-8px,-8px)}',
    '.leaflet-tooltip.ajm-pt{font-size:11px;font-weight:700;color:#fff;background:rgba(20,24,30,.78);border:0;border-radius:5px;padding:1px 5px;box-shadow:none}',
    '.leaflet-tooltip.ajm-pt::before{display:none}',
    '.ajm-chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 2px}',
    '.ajm-chip{font:inherit;font-size:12.5px;font-weight:650;padding:5px 10px;border-radius:99px;border:1px solid var(--border);background:var(--card);color:var(--dark);cursor:pointer}',
    '.ajm-chip.off{border-style:dashed;color:var(--gray)}',
    '.ajm-chip.on{background:var(--orange);border-color:var(--orange);color:#fff}',
    '.ajm-filebar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px}',
    '.ajm-filebar select{flex:1;min-width:180px;max-width:100%;font:inherit;font-size:14px;padding:9px 10px;border:1px solid var(--border);border-radius:10px;background:var(--card);color:var(--dark)}',
    '.ajm-note{font-size:12.5px;color:var(--gray);line-height:1.45;margin:6px 0}',
    '.ajm-warn{font-size:12.5px;color:#b45309;line-height:1.45;margin:6px 0}',
    '.ajm-err{font-size:12.5px;color:var(--red,#dc2626);font-weight:600;line-height:1.45;margin:6px 0}',
    '.ajm-pop{font-size:12.5px;line-height:1.4;max-width:240px;overflow-wrap:anywhere}',
    '.ajm-pop b{font-size:13px}',
    '.ajm-pop .l{color:#6b7280;font-size:11px}',
    '.ajm-pop pre{white-space:pre-wrap;font:inherit;margin:4px 0 0}',
    'body.ajm-noscroll{overflow:hidden}',
  ].join('\n');

  function build() {
    if (M.built) return;
    var pane = $('aj-pane-map');
    if (!pane) return;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    pane.innerHTML =
      '<div class="ewt-section">' +
        '<div class="aj-tasks-sum"><h3 style="margin:0">Job map</h3><span class="aj-tjs" id="ajm-sum"></span></div>' +
        '<div class="ewt-hint">Drawn from the KMZ / KML files in this job’s Plans folder in Job Books. Use Layers to switch parts of the file on and off, and tap a boring to see what the soils report recorded there.</div>' +
        '<div class="ajm-filebar" id="ajm-filebar"></div>' +
        '<div id="ajm-msg"></div>' +
        '<div id="ajm-stage">' +
          '<div id="ajm-map"></div>' +
          '<div class="ajm-top"><div class="ajm-tools">' +
            '<button type="button" class="ajm-tool" id="ajm-t-layers">Layers</button>' +
            '<button type="button" class="ajm-tool" id="ajm-t-me">My location</button>' +
            '<button type="button" class="ajm-tool" id="ajm-t-fit">Whole site</button>' +
            '<button type="button" class="ajm-tool" id="ajm-t-full">Full screen</button>' +
          '</div>' +
          '<div id="ajm-layers"></div></div>' +
          '<div id="ajm-banner"></div>' +
          '<div id="ajm-sheet"></div>' +
        '</div>' +
      '</div>' +
      '<div class="ewt-section" id="ajm-geo"></div>';
    M.built = true;

    $('ajm-t-layers').addEventListener('click', function () { var p = $('ajm-layers'); p.classList.toggle('open'); this.classList.toggle('on', p.classList.contains('open')); });
    $('ajm-t-fit').addEventListener('click', function () { fit(true); });
    $('ajm-t-full').addEventListener('click', function () { setFull(!$('ajm-stage').classList.contains('is-full')); });
    $('ajm-t-me').addEventListener('click', toggleLocate);
    $('ajm-filebar').addEventListener('change', function (e) {
      if (e.target.id !== 'ajm-file') return;
      var f = M.files.find(function (x) { return fileKey(x) === e.target.value; });
      if (!f) return;
      var pref = readPref(FILE_PREF_KEY); pref[M.code] = fileKey(f); writePref(FILE_PREF_KEY, pref);
      selectFile(f);
    });
    $('ajm-filebar').addEventListener('click', function (e) {
      if (e.target.id === 'ajm-default') setDefaultFile();
      if (e.target.id === 'ajm-open-plans') openPlans();
    });
    $('ajm-msg').addEventListener('click', function (e) { if (e.target.id === 'ajm-open-plans') openPlans(); });
    $('ajm-layers').addEventListener('change', onLayerChange);
    $('ajm-layers').addEventListener('input', function (e) { if (e.target.id === 'ajm-strength') { M.strength = Number(e.target.value) / 100; applyStrength(); } });
    $('ajm-layers').addEventListener('click', onLayerClick);
    $('ajm-sheet').addEventListener('click', onSheetClick);
    $('ajm-banner').addEventListener('click', function (e) { if (e.target.tagName === 'BUTTON') stopPlacing(); });
    $('ajm-geo').addEventListener('click', onGeoClick);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { if (M.placing) stopPlacing(); else if ($('ajm-stage') && $('ajm-stage').classList.contains('is-full')) setFull(false); } });
  }
  function openPlans() {
    if (typeof window.jbOpenProject !== 'function') return;
    window.jbOpenProject(M.code, 'Plans');
    var t = document.querySelector('.tab[data-tab="jobbooks"]'); if (t) t.click();
  }
  function setFull(on) {
    $('ajm-stage').classList.toggle('is-full', on);
    $('ajm-t-full').textContent = on ? 'Exit full screen' : 'Full screen';
    $('ajm-t-full').classList.toggle('on', on);
    document.body.classList.toggle('ajm-noscroll', on);
    if (M.map) setTimeout(function () { M.map.invalidateSize(); }, 60);
  }

  // ------------------------------------------------------------------ map
  function initMap() {
    if (M.map) return;
    var L = window.L;
    M.map = L.map('ajm-map', { zoomControl: false, preferCanvas: true, maxZoom: 21, zoomSnap: 0.5, attributionControl: true });
    L.control.zoom({ position: 'bottomright' }).addTo(M.map);
    M.map.attributionControl.setPrefix(false);
    M.baseLayers.sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' });
    M.baseLayers.street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap contributors' });
    M.baseLayers[M.base].addTo(M.map);
    M.map.createPane('ajmImages').style.zIndex = 350;      // sheets under the linework
    M.renderer = L.canvas({ padding: 0.4, tolerance: 7 });
    M.kmlGroup = L.layerGroup().addTo(M.map);
    M.boringGroup = L.layerGroup().addTo(M.map);
    M.meGroup = L.layerGroup().addTo(M.map);
    M.map.setView([32.9, -97.0], 10);
    M.map.on('click', function (e) { if (M.placing) placeAt(e.latlng); });
    M.map.on('locationfound', onLocated);
    M.map.on('locationerror', function (e) { stopLocate(); msg('ajm-msg', 'Could not get your location' + (e && e.message ? ' — ' + esc(e.message) : '') + '.', 'warn'); });
  }
  function setBase(which) {
    if (!M.map || which === M.base) return;
    M.map.removeLayer(M.baseLayers[M.base]); M.base = which; M.baseLayers[which].addTo(M.map); M.baseLayers[which].bringToBack();
    renderLayerPanel();
  }
  function layerPrefs() { return readPref(LAYER_PREF_KEY)[M.code + '|' + (M.sel ? fileKey(M.sel) : '')] || {}; }
  function setLayerPref(key, on) {
    var all = readPref(LAYER_PREF_KEY), k = M.code + '|' + (M.sel ? fileKey(M.sel) : '');
    all[k] = all[k] || {}; all[k][key] = !!on;
    var keys = Object.keys(all); if (keys.length > 60) delete all[keys[0]];
    writePref(LAYER_PREF_KEY, all);
  }
  function featureStyle(st, poly) {
    var o = { renderer: M.renderer, color: st.color || '#ffd400', weight: st.weight || 2, opacity: st.opacity == null ? 1 : Math.max(0.35, st.opacity) };
    if (st.stroke === false) o.stroke = false;
    if (poly) {
      o.fill = st.fill !== false;
      o.fillColor = st.fillColor || o.color;
      o._fill = st.fillOpacity == null ? 0.3 : st.fillOpacity;
      o.fillOpacity = o._fill * M.strength;
    }
    return o;
  }
  function popupHtml(f, layer) {
    var h = '<div class="ajm-pop"><b>' + esc(f.name || layer.name) + '</b><div class="l">' + esc(layer.key) + '</div>';
    if (f.ext && f.ext.length) h += '<pre>' + f.ext.map(function (p) { return esc((p[0] ? p[0] + ': ' : '') + p[1]); }).join('\n') + '</pre>';
    if (f.desc) h += '<pre>' + esc(f.desc) + '</pre>';
    return h + '</div>';
  }
  // Build the Leaflet objects for one KML layer the first time it is shown.
  function materialize(layer) {
    var L = window.L;
    if (layer.group_) return layer.group_;
    var g = L.layerGroup();
    layer.fills_ = []; layer.images_ = [];
    var showLabels = layer.features.filter(function (f) { return f.geoms.some(function (x) { return x.type === 'point'; }); }).length <= 60;
    layer.features.forEach(function (f) {
      if (f.hidden) return;
      var html = popupHtml(f, layer);
      f.geoms.forEach(function (gm) {
        var obj;
        if (gm.type === 'line') obj = L.polyline(gm.pts, featureStyle(f.style, false));
        else if (gm.type === 'poly') { obj = L.polygon(gm.rings, featureStyle(f.style, true)); layer.fills_.push(obj); }
        else {
          obj = L.circleMarker(gm.at, { renderer: M.renderer, radius: 6, color: '#fff', weight: 2, fillColor: f.style.iconColor || f.style.color || '#f59e0b', fillOpacity: 1 });
          if (f.name && showLabels) obj.bindTooltip(f.name, { permanent: true, direction: 'right', offset: [8, 0], className: 'ajm-pt' });
        }
        obj.bindPopup(html, { maxWidth: 260 });
        g.addLayer(obj);
      });
    });
    layer.overlays.slice().sort(function (a, b) { return a.order - b.order; }).forEach(function (o) {
      if (o.hidden) return;
      M.parsed.resolve(o.href).then(function (url) {
        if (!url || !layer.group_) return;
        var img = new QuadOverlay(url, o.quad, { pane: 'ajmImages', opacity: o.opacity * M.strength, interactive: !!o.desc });
        if (o.desc) img.bindPopup(popupHtml({ name: o.name, desc: o.desc }, layer), { maxWidth: 280 });
        img._base = o.opacity;
        layer.images_.push(img);
        g.addLayer(img);
      });
    });
    layer.group_ = g;
    return g;
  }
  function showLayer(layer, on) {
    layer.on = on;
    if (!M.map) return;
    if (on) M.kmlGroup.addLayer(materialize(layer));
    else if (layer.group_) M.kmlGroup.removeLayer(layer.group_);
  }
  function applyStrength() {
    if (!M.parsed) return;
    M.parsed.layers.forEach(function (l) {
      (l.fills_ || []).forEach(function (p) { p.setStyle({ fillOpacity: (p.options._fill == null ? 0.3 : p.options._fill) * M.strength }); });
      (l.images_ || []).forEach(function (im) { im.setOpacity((im._base == null ? 1 : im._base) * M.strength); });
    });
  }
  function drawParsed() {
    if (!M.map) return;
    M.kmlGroup.clearLayers();
    if (!M.parsed) return;
    var prefs = layerPrefs();
    M.parsed.layers.forEach(function (l) {
      l.group_ = null; l.fills_ = []; l.images_ = [];
      var on = Object.prototype.hasOwnProperty.call(prefs, l.key) ? !!prefs[l.key] : l.on;
      showLayer(l, on);
    });
  }
  // Miles from the drawn site, when a boring's coordinates put it well outside it (a typo in the report, or a misread).
  function offSite(b) {
    if (b.lat == null || !M.parsed || !M.parsed.bounds || !window.L) return 0;
    var bb = window.L.latLngBounds(M.parsed.bounds);
    if (bb.pad(1.5).contains([b.lat, b.lon])) return 0;
    return bb.getCenter().distanceTo([b.lat, b.lon]) / 1609.34;
  }
  function boringsPlaced() { var g = M.state && M.state.geotech; return g && g.status === 'done' ? g.borings.filter(function (b) { return b.lat != null && b.lon != null; }) : []; }
  function fit(animate) {
    if (!M.map) return;
    var L = window.L, bounds = null;
    if (M.parsed && M.parsed.bounds) bounds = L.latLngBounds(M.parsed.bounds);
    var site = bounds ? L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast()).pad(1.5) : null;
    boringsPlaced().forEach(function (b) {
      if (site && !site.contains([b.lat, b.lon])) return;
      bounds = bounds ? bounds.extend([b.lat, b.lon]) : L.latLngBounds([b.lat, b.lon], [b.lat, b.lon]);
    });
    if (bounds && bounds.isValid()) M.map.fitBounds(bounds.pad(0.08), { animate: !!animate, maxZoom: 19 });
  }

  // ------------------------------------------------------------------ layers panel
  function renderLayerPanel() {
    var box = $('ajm-layers'); if (!box) return;
    var openGroups = {}, scrollAt = box.scrollTop;   // a long layer list must not jump back to the top on every tick
    box.querySelectorAll('.ajm-grp.open').forEach(function (g) { openGroups[g.getAttribute('data-grp')] = 1; });
    var h = '<div class="ajm-lh">Base map</div>' +
      '<div class="seg" style="margin:0 0 4px"><button type="button" data-ajm-base="sat" class="' + (M.base === 'sat' ? 'on' : '') + '">Satellite</button><button type="button" data-ajm-base="street" class="' + (M.base === 'street' ? 'on' : '') + '">Street</button></div>';
    var g = M.state && M.state.geotech;
    if (g && g.status === 'done' && g.borings.length) {
      h += '<div class="ajm-lh">Geotech</div><label class="ajm-row"><input type="checkbox" id="ajm-l-borings"' + (M.showBorings ? ' checked' : '') + '><span class="ajm-sw" style="background:#b45309;border-radius:50%"></span><span class="nm">Borings</span><span class="ct">' + boringsPlaced().length + ' of ' + g.borings.length + '</span></label>';
    }
    if (M.parsed && M.parsed.layers.length) {
      h += '<div class="ajm-lh">' + esc(M.sel ? M.sel.name : 'Site file') + '</div>' +
        '<div class="ajm-links"><button type="button" data-ajm-all="1">All on</button><button type="button" data-ajm-all="0">All off</button></div>';
      var row = function (l) {
        return '<label class="ajm-row"><input type="checkbox" data-ajm-layer="' + escA(l.key) + '"' + (l.on ? ' checked' : '') + '>' +
          '<span class="ajm-sw" style="background:' + escA(l.color || (l.overlays.length ? '#9ca3af' : '#ffd400')) + '"></span><span class="nm">' + esc(l.name) + '</span><span class="ct">' + l.count + '</span></label>';
      };
      var seen = {};
      M.parsed.layers.forEach(function (l) {
        if (!l.group) { h += row(l); return; }
        if (seen[l.group]) return; seen[l.group] = 1;
        var members = M.parsed.layers.filter(function (x) { return x.group === l.group; });
        var onN = members.filter(function (x) { return x.on; }).length;
        h += '<div class="ajm-grp' + (openGroups[l.group] ? ' open' : '') + '" data-grp="' + escA(l.group) + '">' +
          '<div class="ajm-row"><input type="checkbox" data-ajm-group="' + escA(l.group) + '"' + (onN ? ' checked' : '') + (onN && onN < members.length ? ' data-some="1"' : '') + '>' +
          '<span class="nm" data-ajm-caret="1">' + esc(l.group) + '</span><span class="ct">' + onN + '/' + members.length + '</span><button type="button" class="ajm-caret" data-ajm-caret="1" aria-label="Show layers">&#9656;</button></div>' +
          '<div class="ajm-kids">' + members.map(row).join('') + '</div></div>';
      });
      h += '<div class="ajm-lh">Fill &amp; image strength</div><input type="range" id="ajm-strength" min="10" max="100" step="5" value="' + Math.round(M.strength * 100) + '" style="width:100%">';
    }
    box.innerHTML = h;
    box.scrollTop = scrollAt;
    box.querySelectorAll('[data-some]').forEach(function (c) { c.indeterminate = true; });
  }
  function onLayerChange(e) {
    var t = e.target;
    if (t.id === 'ajm-l-borings') { M.showBorings = t.checked; drawBorings(); return; }
    if (!M.parsed) return;
    var key = t.getAttribute('data-ajm-layer'), grp = t.getAttribute('data-ajm-group');
    if (key) { var l = M.parsed.layers.find(function (x) { return x.key === key; }); if (l) { showLayer(l, t.checked); setLayerPref(l.key, t.checked); } }
    else if (grp) M.parsed.layers.filter(function (x) { return x.group === grp; }).forEach(function (x) { showLayer(x, t.checked); setLayerPref(x.key, t.checked); });
    else return;
    renderLayerPanel();
  }
  function onLayerClick(e) {
    var base = e.target.closest('[data-ajm-base]'); if (base) { setBase(base.getAttribute('data-ajm-base')); return; }
    var all = e.target.closest('[data-ajm-all]');
    if (all && M.parsed) { var on = all.getAttribute('data-ajm-all') === '1'; M.parsed.layers.forEach(function (l) { showLayer(l, on); setLayerPref(l.key, on); }); renderLayerPanel(); return; }
    var caret = e.target.closest('[data-ajm-caret]');
    if (caret) { e.preventDefault(); caret.closest('.ajm-grp').classList.toggle('open'); }
  }

  // ------------------------------------------------------------------ files
  function msg(id, html, kind) { var el = $(id); if (el) el.innerHTML = html ? '<div class="ajm-' + (kind || 'note') + '">' + html + '</div>' : ''; }
  function loadFiles(code, force) {
    if (!force && M.filesFor === code) return Promise.resolve();
    return fetch('/api/project-files?project=' + encodeURIComponent(code)).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (M.code !== code) return;
      var files = j && Array.isArray(j.files) ? j.files : [];
      M.filesErr = !j; M.filesFor = code;
      M.files = files.filter(function (f) { return f.folder === 'Plans' && /\.(kmz|kml)$/i.test(f.name); })
        .sort(function (a, b) { return String(b.lastModified || '').localeCompare(String(a.lastModified || '')); });
      M.pdfs = files.filter(function (f) { return /\.pdf$/i.test(f.name); })
        .sort(function (a, b) { return (b.folder === 'Geotech') - (a.folder === 'Geotech') || /geo|soil|boring/i.test(b.name) - /geo|soil|boring/i.test(a.name) || String(a.name).localeCompare(String(b.name)); });
    }).catch(function () { if (M.code === code) { M.filesErr = true; M.filesFor = code; M.files = []; M.pdfs = []; } });
  }
  function pickFile() {
    if (!M.files.length) return null;
    var pref = readPref(FILE_PREF_KEY)[M.code];
    var byKey = function (k) { return M.files.find(function (f) { return fileKey(f) === k; }); };
    var d = M.state && M.state.defaultFile;
    return (pref && byKey(pref)) || (d && byKey((d.folder || '') + '/' + d.name)) || M.files[0];
  }
  function renderFileBar() {
    var bar = $('ajm-filebar'); if (!bar) return;
    if (!M.files.length) { bar.innerHTML = ''; return; }
    var d = M.state && M.state.defaultFile, dKey = d ? (d.folder || '') + '/' + d.name : '';
    var cur = M.sel ? fileKey(M.sel) : '';
    var h = M.files.length > 1
      ? '<select id="ajm-file" aria-label="Map file">' + M.files.map(function (f) { var k = fileKey(f); return '<option value="' + escA(k) + '"' + (k === cur ? ' selected' : '') + '>' + esc(f.name) + (k === dKey ? '  (job default)' : '') + '</option>'; }).join('') + '</select>'
      : '<span class="ajm-note" style="margin:0">' + esc(M.files[0].name) + '</span>';
    if (isAdmin() && M.files.length > 1 && cur && cur !== dKey) h += '<button type="button" class="btn aj-mini" id="ajm-default" title="Everyone opens this file first">Make this the job default</button>';
    bar.innerHTML = h;
    var sum = $('ajm-sum'); if (sum) sum.textContent = M.files.length + ' map file' + (M.files.length === 1 ? '' : 's') + ' in Plans';
  }
  function selectFile(f) {
    M.sel = f; M.parsed = null; M.fileErr = '';
    renderFileBar();
    if (!f) { drawParsed(); renderLayerPanel(); return; }
    var code = M.code, key = fileKey(f);
    M.loadingFile = key;
    msg('ajm-msg', 'Loading ' + esc(f.name) + '…');
    ensureLibs().then(function () { return loadMapFile(code, f); }).then(function (parsed) {
      if (M.code !== code || M.loadingFile !== key) return;
      M.loadingFile = ''; M.parsed = parsed;
      initMap(); drawParsed(); renderLayerPanel(); fit(false);
      var n = parsed.layers.length;
      msg('ajm-msg', n ? '' : 'That file has nothing this map can draw (no lines, areas, points or image sheets).', 'warn');
    }).catch(function (e) {
      if (M.code !== code || M.loadingFile !== key) return;
      M.loadingFile = ''; M.fileErr = e && e.message ? e.message : 'Could not open the file.';
      msg('ajm-msg', esc(M.fileErr), 'err');
      renderLayerPanel();
    });
  }
  function setDefaultFile() {
    if (!M.sel) return;
    post({ mode: 'setDefault', folder: M.sel.folder || '', name: M.sel.name }).then(function (j) { if (j && j.ok) { M.state = j.map; renderFileBar(); } else msg('ajm-msg', esc((j && j.error) || 'Could not save the default.'), 'err'); });
  }

  // ------------------------------------------------------------------ server state
  function post(body) {
    body.code = M.code;
    return fetch('/api/job-map', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { error: 'Server error ' + r.status }; }); })
      .catch(function () { return { error: navigator.onLine ? 'Could not reach the server.' : 'You are offline.' }; });
  }
  function loadState(code) {
    return fetch('/api/job-map?code=' + encodeURIComponent(code)).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (M.code !== code) return;
      M.state = (j && j.map) || { geotech: null, defaultFile: null };
      M.stateFor = code;
    }).catch(function () { if (M.code === code && !M.state) M.state = { geotech: null, defaultFile: null }; });
  }
  function visible() { return window.ajTab === 'map' || (function () { var p = $('aj-pane-map'); return p && p.style.display !== 'none' && p.offsetParent !== null; })(); }
  function schedulePoll() {
    clearTimeout(M.pollTimer);
    var g = M.state && M.state.geotech;
    if (!g || g.status !== 'reading') return;
    var code = M.code;
    M.pollTimer = setTimeout(function () {
      if (M.code !== code) return;
      if (!visible() || document.hidden) { schedulePoll(); return; }
      loadState(code).then(function () { if (M.code === code) { renderGeo(); drawBorings(); renderLayerPanel(); schedulePoll(); } });
    }, 15000);
  }

  // ------------------------------------------------------------------ geotech section
  function ago(ts) {
    var m = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 60000));
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
  }
  function pdfPicker(label) {
    if (!M.pdfs.length) return '<div class="ajm-note">There are no PDFs in this job book yet. Add the soils report to Job Books › Geotech first.</div>';
    return '<div class="ajm-filebar"><select id="ajm-pdf" aria-label="Geotech report">' + M.pdfs.map(function (f) { return '<option value="' + escA(fileKey(f)) + '">' + esc((f.folder ? f.folder + ' › ' : '') + f.name) + '</option>'; }).join('') + '</select>' +
      '<button type="button" class="btn btn-primary aj-mini" data-ajm-geo="start">' + label + '</button></div>';
  }
  function renderGeo() {
    var box = $('ajm-geo'); if (!box) return;
    var g = M.state && M.state.geotech, admin = isAdmin();
    var h = '<div class="aj-tasks-sum"><h3 style="margin:0">Geotech borings</h3><span class="aj-tjs" id="ajm-geo-sum"></span></div>';
    if (!g) {
      h += admin
        ? '<div class="ewt-hint">Pick the soils report and the AI reads every boring log in it. Borings that have coordinates in the report go straight onto the map; the rest you place with a tap.</div>' + pdfPicker('Read this report') +
          '<div class="ajm-fine">A long report takes a few minutes and runs in the background — you can leave this page. Each read uses the company’s AI account (roughly $1–$3 for a large report).</div>'
        : '<div class="ajm-note">No geotech report has been read for this job yet. An admin can add one here.</div>';
    } else if (g.status === 'preparing') {
      h += '<div class="ajm-note">Getting <b>' + esc(g.file.name) + '</b> ready' + (g.pageCount ? ' — ' + g.pageCount + ' pages, part ' + Math.min(g.parts, g.prepared + 1) + ' of ' + g.parts : '') + '…</div>';
      if (g.error) h += '<div class="ajm-warn">' + esc(g.error) + ' — trying again.</div>';
      if (admin && !M.driving) h += '<div class="ajm-acts"><button type="button" class="btn btn-primary aj-mini" data-ajm-geo="resume">Continue</button><button type="button" class="btn aj-mini" data-ajm-geo="clear">Cancel</button></div>';
    } else if (g.status === 'reading') {
      h += '<div class="ajm-note">The AI is reading <b>' + esc(g.file.name) + '</b>' + (g.pageCount ? ' (' + g.pageCount + ' pages)' : '') + ' — started ' + ago(g.startedAt) + (g.startedBy ? ' by ' + esc(g.startedBy.name) : '') + '. This usually takes a few minutes and can take longer for a big report. It keeps going if you leave; the borings appear here when it is done.</div>';
      if (admin) h += '<div class="ajm-acts"><button type="button" class="btn aj-mini" data-ajm-geo="clear">Cancel</button></div>';
    } else if (g.status === 'failed') {
      h += '<div class="ajm-err">Could not read ' + esc(g.file ? g.file.name : 'the report') + ': ' + esc(g.error || 'unknown error') + '</div>';
      if (admin) h += pdfPicker('Try again');
    } else {
      var placed = boringsPlaced().length, total = g.borings.length;
      var r = g.report || {};
      h += '<div class="ajm-note"><b>' + esc(g.file.name) + '</b>' + [r.firm, r.reportDate].filter(Boolean).map(function (x) { return ' · ' + esc(x); }).join('') +
        ' — ' + (total ? total + ' boring' + (total === 1 ? '' : 's') + ' read, ' + placed + ' on the map' + (total > placed ? ', ' + (total - placed) + ' not placed yet' : '') : 'no boring logs were found in it') + '.</div>';
      if (total) {
        h += '<div class="ajm-chips">' + g.borings.map(function (b) {
          var on = M.selBoring === b.id, off = b.lat == null || offSite(b) > 0;
          return '<button type="button" class="ajm-chip' + (on ? ' on' : '') + (off ? ' off' : '') + '" data-ajm-boring="' + escA(b.id) + '"' + (off ? ' title="Not on the map yet"' : '') + '>' + esc(b.id) + (b.totalDepthFt != null ? ' · ' + b.totalDepthFt + '′' : '') + '</button>';
        }).join('') + '</div>';
        if (total > placed) h += '<div class="ajm-note">Dashed borings have no coordinates in the report. ' + (admin ? 'Tap one, then “Place on map”, and tap where it was drilled' + (g.planPages && g.planPages.length ? ' — the boring location plan is on report page ' + g.planPages[0] : '') + '.' : 'An admin can place them on the map.') + '</div>';
      }
      if (g.warnings && g.warnings.length) h += '<details class="ajm-warn"><summary>' + g.warnings.length + ' part' + (g.warnings.length === 1 ? '' : 's') + ' of the report could not be read</summary>' + g.warnings.map(function (w) { return '<div>' + esc(w) + '</div>'; }).join('') + '</details>';
      h += '<div class="ajm-fine">Read from the report by AI on ' + esc(new Date(g.finishedAt || g.startedAt).toLocaleDateString()) + '. Check the boring log itself before relying on a number — every boring links to its page.</div>';
      if (admin) h += '<div class="ajm-acts"><button type="button" class="btn aj-mini" data-ajm-geo="replace">Read a different report</button></div><div id="ajm-replace"></div>';
    }
    box.innerHTML = h;
  }
  function onGeoClick(e) {
    var chip = e.target.closest('[data-ajm-boring]');
    if (chip) { selectBoring(chip.getAttribute('data-ajm-boring'), true); return; }
    var b = e.target.closest('[data-ajm-geo]'); if (!b) return;
    var act = b.getAttribute('data-ajm-geo');
    if (act === 'start') {
      var sel = $('ajm-pdf'); if (!sel) return;
      var f = M.pdfs.find(function (x) { return fileKey(x) === sel.value; }); if (!f) return;
      var g = M.state && M.state.geotech;
      var go = function () {
        b.disabled = true;
        post({ mode: 'geoStart', folder: f.folder || '', name: f.name }).then(function (j) {
          if (!j || !j.ok) { b.disabled = false; alert((j && j.error) || 'Could not start reading the report.'); return; }
          M.state = j.map; M.selBoring = null; closeSheet(); renderGeo(); drawBorings(); drive();
        });
      };
      if (g && g.status === 'done') { post({ mode: 'geoClear' }).then(function (j) { if (j && j.ok) { M.state = j.map; go(); } else alert((j && j.error) || 'Could not replace the report.'); }); }
      else go();
    } else if (act === 'resume') { drive(); renderGeo(); }
    else if (act === 'clear') {
      if (!confirm('Cancel reading this report?')) return;
      M.driving = false;
      post({ mode: 'geoClear' }).then(function (j) { if (j && j.ok) { M.state = j.map; closeSheet(); renderGeo(); drawBorings(); renderLayerPanel(); schedulePoll(); } });
    } else if (act === 'replace') {
      var slot = $('ajm-replace');
      if (slot) slot.innerHTML = '<div class="ajm-warn">Reading a different report replaces these borings. Borings you placed by hand keep their spot if the new report uses the same numbers.</div>' + pdfPicker('Read this report instead');
    }
  }
  // The admin's browser walks the preparation forward one slice at a time.
  function drive() {
    if (M.driving) return;
    M.driving = true;
    var code = M.code, n = 0;
    var step = function () {
      if (M.code !== code || !M.driving) { M.driving = false; return; }
      post({ mode: 'geoStep' }).then(function (j) {
        if (M.code !== code) { M.driving = false; return; }
        if (j && j.ok) M.state = j.map;
        var g = M.state && M.state.geotech;
        var again = j && j.ok && g && g.status === 'preparing' && ++n < 80;
        if (!again) M.driving = false;
        renderGeo();
        if (again) setTimeout(step, 400); else { schedulePoll(); if (!j || !j.ok) msg('ajm-msg', esc((j && j.error) || 'Could not prepare the report.'), 'err'); }
      });
    };
    step();
  }

  // ------------------------------------------------------------------ borings on the map
  function drawBorings() {
    if (!M.map) return;
    var L = window.L;
    M.boringGroup.clearLayers();
    if (!M.showBorings) return;
    boringsPlaced().forEach(function (b) {
      var cls = 'ajm-bor' + (b.kind === 'test pit' ? ' is-pit' : '') + (b.placed === 'manual' ? ' is-manual' : '') + (M.selBoring === b.id ? ' is-sel' : '');
      var mk = L.marker([b.lat, b.lon], { icon: L.divIcon({ className: '', html: '<div class="' + cls + '"><i></i><span>' + esc(b.id) + '</span></div>', iconSize: [0, 0] }), keyboard: false, zIndexOffset: M.selBoring === b.id ? 1000 : 0 });
      mk.on('click', function (ev) { if (ev.originalEvent) ev.originalEvent.stopPropagation(); if (!M.placing) selectBoring(b.id, false); });
      M.boringGroup.addLayer(mk);
    });
  }
  function boring(id) { var g = M.state && M.state.geotech; return g && g.borings ? g.borings.find(function (b) { return b.id === id; }) : null; }
  function selectBoring(id, pan) {
    var b = boring(id); if (!b) return;
    M.selBoring = id;
    drawBorings(); renderGeo(); renderSheet(b);
    if (!M.map || b.lat == null) return;
    if (pan) { M.map.setView([b.lat, b.lon], Math.max(M.map.getZoom(), 18), { animate: false }); var st = $('ajm-stage'); if (st && !st.classList.contains('is-full')) st.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    // Keep the boring in view above the details sheet, not underneath it.
    var sheetH = $('ajm-sheet').offsetHeight, stageH = $('ajm-stage').clientHeight;
    var y = M.map.latLngToContainerPoint([b.lat, b.lon]).y;
    var target = Math.max(60, (stageH - sheetH) / 2);
    if (y > stageH - sheetH - 30 || pan) M.map.panBy([0, y - target], { animate: !pan });
  }
  function closeSheet() { var s = $('ajm-sheet'); if (s) { s.classList.remove('open'); s.innerHTML = ''; } }
  var ft = function (v) { return v == null ? '?' : (Math.round(v * 10) / 10) + '′'; };
  function renderSheet(b) {
    var s = $('ajm-sheet'); if (!s) return;
    var g = M.state.geotech, admin = isAdmin();
    var kind = b.kind === 'boring' ? 'Boring' : b.kind.charAt(0).toUpperCase() + b.kind.slice(1);
    var meta = [kind, b.totalDepthFt != null ? b.totalDepthFt + ' ft deep' : '', b.dateDrilled ? 'drilled ' + b.dateDrilled : '', b.surfaceElevation ? 'surface el. ' + b.surfaceElevation : ''].filter(Boolean).join(' · ');
    var where = b.placed === 'manual' ? 'Placed on the map by ' + (b.placedBy || 'an admin') + (b.reportLat != null ? ' (the report’s own coordinates differ)' : '')
      : b.placed === 'report' ? 'From the coordinates printed in the report (' + b.lat.toFixed(6) + ', ' + b.lon.toFixed(6) + ')'
      : 'Not on the map yet — the report gives no coordinates for it' + (b.northing || b.easting ? ' (N ' + (b.northing || '?') + ', E ' + (b.easting || '?') + ')' : '');
    var h = '<div class="ajm-sh-top"><div><h4>' + esc(b.id) + '</h4><div class="ajm-meta">' + esc(meta) + '</div></div><button type="button" class="ajm-x" data-ajm-sheet="close" aria-label="Close">&times;</button></div>';
    h += '<div class="ajm-kv"><b>Groundwater:</b> ' + esc(b.groundwater || 'not recorded on the log') + '</div>';
    h += '<div class="ajm-kv"><b>Location:</b> ' + esc(where) + (b.locationNote ? ' — ' + esc(b.locationNote) : '') + '</div>';
    var far = offSite(b);
    if (far) h += '<div class="ajm-warn">This spot is about ' + (far < 10 ? far.toFixed(1) : Math.round(far)) + ' miles from the site drawn on the map, so the coordinates are probably wrong.' + (admin ? ' Use “Move on map” to put it where it belongs.' : '') + '</div>';
    if (b.strata.length) {
      h += '<div class="ajm-scroll"><table class="ajm-tbl"><thead><tr><th>Depth</th><th>Material</th><th>USCS</th></tr></thead><tbody>' + b.strata.map(function (x) {
        return '<tr><td class="d">' + ft(x.topFt) + ' – ' + ft(x.bottomFt) + '</td><td>' + esc(x.description) + '</td><td>' + esc(x.uscs) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    } else h += '<div class="ajm-note">No soil layers were read from this log.</div>';
    if (b.samples.length) {
      var cols = [['type', 'Sample'], ['blows', 'Blows / N'], ['moisturePct', 'Moist. %'], ['liquidLimit', 'LL'], ['plasticityIndex', 'PI'], ['passing200Pct', '−200 %'], ['dryDensityPcf', 'Dry pcf'], ['pocketPenTsf', 'PP tsf'], ['other', 'Other']]
        .filter(function (c) { return b.samples.some(function (x) { return x[c[0]]; }); });
      h += '<div class="ajm-scroll"><table class="ajm-tbl"><thead><tr><th>Depth</th>' + cols.map(function (c) { return '<th>' + c[1] + '</th>'; }).join('') + '</tr></thead><tbody>' + b.samples.map(function (x) {
        return '<tr><td class="d">' + ft(x.depthFt) + '</td>' + cols.map(function (c) { return '<td>' + esc(x[c[0]]) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
    }
    if (b.notes) h += '<div class="ajm-kv"><b>Notes:</b> ' + esc(b.notes) + '</div>';
    h += '<div class="ajm-acts"><button type="button" class="btn btn-primary aj-mini" data-ajm-sheet="log">Open the log — report page ' + b.page + '</button>';
    if (admin) {
      h += '<button type="button" class="btn aj-mini" data-ajm-sheet="place">' + (b.lat == null ? 'Place on map' : 'Move on map') + '</button>';
      if (b.placed === 'manual') h += '<button type="button" class="btn aj-mini" data-ajm-sheet="unplace">' + (b.reportLat != null ? 'Back to the report’s spot' : 'Take off the map') + '</button>';
    }
    h += '</div><div class="ajm-fine">Read from ' + esc(g.file.name) + ' by AI. Check the log before relying on a number.</div>';
    s.innerHTML = h; s.classList.add('open'); s.scrollTop = 0;
  }
  function onSheetClick(e) {
    var t = e.target.closest('[data-ajm-sheet]'); if (!t) return;
    var act = t.getAttribute('data-ajm-sheet'), b = boring(M.selBoring);
    if (act === 'close') { M.selBoring = null; closeSheet(); drawBorings(); renderGeo(); return; }
    if (!b) return;
    if (act === 'log') {
      var g = M.state.geotech;
      // Open the tab inside the tap (iOS blocks it otherwise), then point it at the page.
      var win = window.open('about:blank', '_blank');
      fetch(fileUrl(M.code, g.file, '&sas=1')).then(function (r) { return r.ok ? r.json() : null; }).then(function (res) {
        if (!res || !res.url) throw 0;
        var url = res.url + '#page=' + b.page;
        if (win) win.location = url; else window.open(url, '_blank');
      }).catch(function () { if (win) { try { win.close(); } catch (er) {} } alert('Could not open the report.'); });
    } else if (act === 'place') { startPlacing(b.id); }
    else if (act === 'unplace') {
      post({ mode: 'unplaceBoring', id: b.id }).then(function (j) { if (j && j.ok) { M.state = j.map; var nb = boring(b.id); drawBorings(); renderGeo(); renderLayerPanel(); if (nb) renderSheet(nb); } else alert((j && j.error) || 'Could not save.'); });
    }
  }
  function startPlacing(id) {
    M.placing = id; closeSheet();
    $('ajm-layers').classList.remove('open'); $('ajm-t-layers').classList.remove('on');
    var bn = $('ajm-banner'); bn.innerHTML = 'Tap the map where ' + esc(id) + ' was drilled <button type="button">Cancel</button>'; bn.style.display = 'block';
    $('ajm-map').style.cursor = 'crosshair';
  }
  function stopPlacing() { M.placing = null; var bn = $('ajm-banner'); if (bn) bn.style.display = 'none'; var mp = $('ajm-map'); if (mp) mp.style.cursor = ''; }
  function placeAt(latlng) {
    var id = M.placing; stopPlacing();
    post({ mode: 'placeBoring', id: id, lat: latlng.lat, lon: latlng.lng }).then(function (j) {
      if (j && j.ok) { M.state = j.map; M.selBoring = id; drawBorings(); renderGeo(); renderLayerPanel(); var b = boring(id); if (b) renderSheet(b); }
      else alert((j && j.error) || 'Could not save the location.');
    });
  }

  // ------------------------------------------------------------------ my location
  function toggleLocate() { if (M.watchId) stopLocate(); else { M.watchId = 1; M.firstFix = true; $('ajm-t-me').classList.add('on'); M.map && M.map.locate({ watch: true, enableHighAccuracy: true, maximumAge: 5000 }); } }
  function stopLocate() { M.watchId = null; var b = $('ajm-t-me'); if (b) b.classList.remove('on'); if (M.map) { M.map.stopLocate(); M.meGroup.clearLayers(); } }
  function onLocated(e) {
    var L = window.L;
    M.meGroup.clearLayers();
    M.meGroup.addLayer(L.circle(e.latlng, { radius: e.accuracy, color: '#2563eb', weight: 1, fillOpacity: 0.12, interactive: false }));
    M.meGroup.addLayer(L.marker(e.latlng, { icon: L.divIcon({ className: '', html: '<div class="ajm-me"></div>', iconSize: [0, 0] }), interactive: false, keyboard: false }));
    if (!M.firstFix) return;
    M.firstFix = false;
    var site = M.parsed && M.parsed.bounds ? L.latLngBounds(M.parsed.bounds) : null;
    if (!site || site.pad(1).contains(e.latlng)) M.map.setView(e.latlng, Math.max(M.map.getZoom(), 18));
    else { var mi = site.getCenter().distanceTo(e.latlng) / 1609.34; msg('ajm-msg', 'You are about ' + (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' miles from this site, so the map stayed on the job.', 'note'); }
  }

  // ------------------------------------------------------------------ entry point
  function reset(code) {
    M.code = code; M.sel = null; M.parsed = null; M.state = null; M.stateFor = null; M.filesFor = null; M.files = []; M.pdfs = [];
    M.selBoring = null; M.driving = false; M.fileErr = ''; M.loadingFile = '';
    clearTimeout(M.pollTimer); stopPlacing(); closeSheet();
    M.objectUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} }); M.objectUrls = []; M.parseCache = {};
    if (M.map) { M.kmlGroup.clearLayers(); M.boringGroup.clearLayers(); }
    msg('ajm-msg', ''); var fb = $('ajm-filebar'); if (fb) fb.innerHTML = ''; var sm = $('ajm-sum'); if (sm) sm.textContent = '';
  }
  // Called by the job page whenever the Map tab is showing.
  window.ajmRender = function (code) {
    build();
    if (!M.built || !code) return;
    // Coming back to a map that is already up: just re-measure it. Anything else
    // (first visit, or it had nothing to show last time) loads fresh.
    if (M.code === code && (M.loading || $('ajm-stage').style.display !== 'none')) {
      if (M.map) setTimeout(function () { M.map.invalidateSize(); }, 30);
      schedulePoll();
      return;
    }
    reset(code);
    M.loading = true;
    renderGeo(); renderLayerPanel();
    $('ajm-stage').style.display = 'none';
    msg('ajm-msg', 'Loading the map…');
    Promise.all([loadFiles(code), loadState(code), ensureLibs().catch(function () { return 'nolib'; })]).then(function (res) {
      if (M.code !== code) return;
      M.loading = false;
      renderGeo();
      if (res[2] === 'nolib') { msg('ajm-msg', 'The map needs an internet connection the first time it opens. Check your signal and try again.', 'err'); return; }
      var hasBorings = boringsPlaced().length > 0;
      if (!M.files.length && !hasBorings) {
        msg('ajm-msg', M.filesErr ? 'Could not load this job’s files — try again.' : 'There is no KMZ or KML file in this job’s Plans folder yet. Drop one into Job Books › Plans and the map shows up here. <button type="button" class="btn aj-mini" id="ajm-open-plans" style="margin-left:6px">Open the Plans folder</button>', M.filesErr ? 'err' : 'note');
        return;
      }
      $('ajm-stage').style.display = '';
      initMap();
      setTimeout(function () { M.map.invalidateSize(); if (!M.files.length) fit(false); }, 30);
      msg('ajm-msg', M.files.length ? '' : 'No KMZ or KML in Plans yet — showing the borings on the satellite view. <button type="button" class="btn aj-mini" id="ajm-open-plans" style="margin-left:6px">Open the Plans folder</button>');
      drawBorings(); renderLayerPanel(); renderFileBar();
      var f = pickFile();
      if (f) selectFile(f);
      var g = M.state && M.state.geotech;
      if (g && g.status === 'reading') schedulePoll();
    });
  };
  // For tests / debugging in the console.
  window.ajmState = M;
  window.ajmParseKml = parseKml;
})();
