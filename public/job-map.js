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
  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var PLAN_Z = 22;   // zoom level whose pixel grid the plan's fit is worked out in

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
    queue: null,          // borings still to place, when walking through them one after another
    planLayers: {}, showPlans: {}, planStrength: 0.65,   // saved plan pages on the map: id -> { layer, key } / id -> ticked
    align: null,          // the boring location plan while it is being pinned to the map
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
      setQuad: function (quad) { this._quad = quad; this._bounds = L.latLngBounds([quad.tl, quad.tr, quad.bl, quad.br]); this._reset(); return this; },
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
    '.ajm-bor.is-auto i{background:#7c3aed}',
    '.bn-op{display:flex;align-items:center;gap:8px;justify-content:center;margin-top:8px;font-size:12px;font-weight:600}',
    '.bn-op input{width:150px;accent-color:#f59e0b}',
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
    '#ajm-map.ajm-picking,#ajm-map.ajm-picking .leaflet-interactive,#ajm-map.ajm-picking .leaflet-grab{cursor:crosshair !important}',
    '#ajm-banner{border-radius:16px;line-height:1.35;width:max-content}',
    '#ajm-banner .bn-acts{display:flex;gap:8px;justify-content:center;margin-top:7px;flex-wrap:wrap}',
    '#ajm-banner .bn-acts button{margin:0}',
    '#ajm-banner button.go{background:#f59e0b;color:#1f2937}',
    '.ajm-pin{width:22px;height:22px;border-radius:50%;border:2.5px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.7);color:#fff;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;transform:translate(-11px,-11px)}',
    '.ajm-pin.real{background:#16a34a}',
    '.ajm-pin.plan{background:#ea580c}',
    '.ajm-planbox{border-top:1px solid var(--border);margin-top:12px;padding-top:10px}',
    '.ajm-plan{border:1px solid var(--border);border-radius:12px;padding:9px 12px 10px;margin-top:8px}',
    '.ajm-plan.on{border-color:#f59e0b}',
    '.ajm-plan-t{display:flex;gap:4px 10px;align-items:baseline;flex-wrap:wrap;font-size:14px}',
    '.ajm-plan-t span{font-size:12.5px;opacity:.7}',
    '.ajm-plan .ajm-acts{margin-top:7px}',
    '.ajm-planbox input[type=number]{width:84px;font:inherit;font-size:14px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--card);color:var(--dark)}',
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
    $('ajm-layers').addEventListener('input', function (e) {
      if (e.target.id === 'ajm-strength') { M.strength = Number(e.target.value) / 100; applyStrength(); }
      if (e.target.id === 'ajm-plan-strength') setPlanStrength(Number(e.target.value) / 100);
    });
    $('ajm-layers').addEventListener('click', onLayerClick);
    $('ajm-sheet').addEventListener('click', onSheetClick);
    $('ajm-banner').addEventListener('click', onBannerClick);
    // "Plan" slider in the banner: how strongly the drawing shows while picking points or tapping borings
    $('ajm-banner').addEventListener('input', function (e) {
      if (!e.target.hasAttribute('data-ajm-bn-op')) return;
      var v = Number(e.target.value) / 100;
      if (M.align) { M.align.userOpacity = v; M.align.layer.setOpacity(v); }
      else setPlanStrength(v);
    });
    $('ajm-geo').addEventListener('click', onGeoClick);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { if (M.align || M.alignLoading) alignCancel(); else if (M.placing) { M.queue = null; stopPlacing(); } else if ($('ajm-stage') && $('ajm-stage').classList.contains('is-full')) setFull(false); } });
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
    M.map.createPane('ajmPlan').style.zIndex = 380;        // the boring location plan, over the sheets
    M.map.getPane('ajmPlan').style.pointerEvents = 'none';
    M.renderer = L.canvas({ padding: 0.4, tolerance: 7 });
    M.kmlGroup = L.layerGroup().addTo(M.map);
    M.boringGroup = L.layerGroup().addTo(M.map);
    M.meGroup = L.layerGroup().addTo(M.map);
    M.map.setView([32.9, -97.0], 10);
    M.alignMarks = L.layerGroup().addTo(M.map);
    M.map.on('click', function (e) { if (M.align) alignTap(e.latlng); else if (M.placing) placeAt(e.latlng); });
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
  // A tap on a drawn line or area normally opens its details. While a point is
  // being picked (tying the plan in, placing a boring) the tap belongs to the
  // map instead — otherwise a design line under your finger swallows it and
  // the corner you were aiming at can never be chosen.
  function featureTap(obj, html, maxWidth) {
    obj.on('click', function (e) {
      if (M.align || M.placing) return;   // left alone, Leaflet hands the tap on to the map
      window.L.DomEvent.stop(e);
      window.L.popup({ maxWidth: maxWidth }).setLatLng(e.latlng).setContent(html).openOn(M.map);
    });
  }
  function picking(on) { var mp = $('ajm-map'); if (mp) mp.classList.toggle('ajm-picking', !!on); if (on && M.map) M.map.closePopup(); }
  // The spot on the visible linework nearest a tap: a corner (any vertex) within
  // a fingertip, else the closest point along a line. null when nothing is near.
  // -> { latlng, corner }
  function snapToLinework(latlng) {
    if (!M.parsed || !M.map) return null;
    var map = M.map, L = window.L, zoom = map.getZoom(), px = function (q) { return map.project(q, zoom); }, p0 = px(latlng);
    var CORNER = 16, LINE = 11;
    var edge = map.unproject(L.point(p0.x + CORNER, p0.y + CORNER), zoom);
    var dLat = Math.abs(edge.lat - latlng.lat) * 1.2, dLon = Math.abs(edge.lng - latlng.lng) * 1.2;
    var lat = latlng.lat, lon = latlng.lng;
    var best = null, bestD = CORNER, bestSeg = null, bestSegD = LINE;
    var near = function (q) { return Math.abs(q[0] - lat) <= dLat && Math.abs(q[1] - lon) <= dLon; };
    var eachRing = function (pts, closed) {
      var n = pts.length;
      for (var i = 0; i < n; i++) {
        var a = pts[i];
        if (near(a)) { var pa = px(a), d = Math.hypot(pa.x - p0.x, pa.y - p0.y); if (d < bestD) { bestD = d; best = a; } }
        var b = i + 1 < n ? pts[i + 1] : (closed ? pts[0] : null);
        if (!b) continue;
        // skip segments whose box is nowhere near the tap
        if (Math.min(a[0], b[0]) - dLat > lat || Math.max(a[0], b[0]) + dLat < lat || Math.min(a[1], b[1]) - dLon > lon || Math.max(a[1], b[1]) + dLon < lon) continue;
        var A = px(a), B = px(b);
        var vx = B.x - A.x, vy = B.y - A.y, len2 = vx * vx + vy * vy;
        var t = len2 ? Math.max(0, Math.min(1, ((p0.x - A.x) * vx + (p0.y - A.y) * vy) / len2)) : 0;
        var qx = A.x + t * vx, qy = A.y + t * vy, ds = Math.hypot(qx - p0.x, qy - p0.y);
        if (ds < bestSegD) { bestSegD = ds; bestSeg = L.point(qx, qy); }
      }
    };
    M.parsed.layers.forEach(function (l) {
      if (!l.on) return;
      l.features.forEach(function (ft) {
        if (ft.hidden) return;
        ft.geoms.forEach(function (g) {
          if (g.type === 'line') eachRing(g.pts, false);
          else if (g.type === 'poly') g.rings.forEach(function (r) { eachRing(r, true); });
          else if (near(g.at)) { var pp = px(g.at), dp = Math.hypot(pp.x - p0.x, pp.y - p0.y); if (dp < bestD) { bestD = dp; best = g.at; } }
        });
      });
    });
    if (best) return { latlng: L.latLng(best[0], best[1]), corner: true };
    if (bestSeg) return { latlng: map.unproject(bestSeg, zoom), corner: false };
    return null;
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
        featureTap(obj, html, 260);
        g.addLayer(obj);
      });
    });
    layer.overlays.slice().sort(function (a, b) { return a.order - b.order; }).forEach(function (o) {
      if (o.hidden) return;
      M.parsed.resolve(o.href).then(function (url) {
        if (!url || !layer.group_) return;
        var img = new QuadOverlay(url, o.quad, { pane: 'ajmImages', opacity: o.opacity * M.strength, interactive: !!o.desc });
        if (o.desc) featureTap(img, popupHtml({ name: o.name, desc: o.desc }, layer), 280);
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
    var pl = plans();
    if ((g && g.status === 'done' && g.borings.length) || pl.length) h += '<div class="ajm-lh">Geotech</div>';
    if (g && g.status === 'done' && g.borings.length) {
      h += '<label class="ajm-row"><input type="checkbox" id="ajm-l-borings"' + (M.showBorings ? ' checked' : '') + '><span class="ajm-sw" style="background:#b45309;border-radius:50%"></span><span class="nm">Borings</span><span class="ct">' + boringsPlaced().length + ' of ' + g.borings.length + '</span></label>';
    }
    // every saved boring location plan page is its own layer
    pl.forEach(function (p) {
      h += '<label class="ajm-row"><input type="checkbox" data-ajm-plan="' + escA(planId(p)) + '"' + (planOn(p) ? ' checked' : '') + '><span class="ajm-sw" style="background:#fff"></span><span class="nm">Boring plan</span><span class="ct">page ' + p.page + '</span></label>';
    });
    if (anyPlanOn()) h += '<input type="range" id="ajm-plan-strength" min="15" max="100" step="5" value="' + Math.round(M.planStrength * 100) + '" style="width:100%" aria-label="Plan strength">';
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
    var planKey = t.getAttribute('data-ajm-plan');
    if (planKey) { M.showPlans[planKey] = t.checked; drawPlan(); renderLayerPanel(); renderGeo(); return; }
    if (t.id === 'ajm-plan-strength') return;
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
      loadState(code).then(function () { if (M.code === code) { renderGeo(); drawBorings(); drawPlan(); renderLayerPanel(); schedulePoll(); } });
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
        if (total > placed) h += '<div class="ajm-note">Dashed borings have no coordinates in the report. ' + (admin ? 'Put the report’s boring location plan on the map below and they are placed from it.' : 'An admin can place them from the report’s boring location plan.') + '</div>';
      }
      if (g.warnings && g.warnings.length) h += '<details class="ajm-warn"><summary>' + g.warnings.length + ' part' + (g.warnings.length === 1 ? '' : 's') + ' of the report could not be read</summary>' + g.warnings.map(function (w) { return '<div>' + esc(w) + '</div>'; }).join('') + '</details>';
      h += '<div class="ajm-fine">Read from the report by AI on ' + esc(new Date(g.finishedAt || g.startedAt).toLocaleDateString()) + '. Check the boring log itself before relying on a number — every boring links to its page.</div>';
      var autoN = g.borings.filter(function (b) { return b.placed === 'auto'; }).length;
      if (autoN) h += '<div class="ajm-note">' + autoN + ' boring' + (autoN === 1 ? ' was' : 's were') + ' found on the boring location plan automatically (purple). Check each against the drawing' + (admin ? ' — tap one and use “Move on map” if it is off.' : '.') + '</div>';
      if (total) h += planBlockHtml(g, admin, total - placed);
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
          M.state = j.map; M.selBoring = null; closeSheet(); renderGeo(); drawBorings(); drawPlan(); renderLayerPanel(); drive();
        });
      };
      if (g && g.status === 'done') { post({ mode: 'geoClear' }).then(function (j) { if (j && j.ok) { M.state = j.map; go(); } else alert((j && j.error) || 'Could not replace the report.'); }); }
      else go();
    } else if (act === 'plan' || act === 'plan-page') {
      var inp = $('ajm-plan-page'), pg = Math.round(Number(act === 'plan-page' ? b.getAttribute('data-page') : (inp ? inp.value : 0)));
      if (!(pg >= 1)) { alert('Type the report page that shows the boring location plan.'); if (inp) inp.focus(); return; }
      // A page that is already saved is pulled up as it was tied in — nothing to line up again.
      var saved = planByPage(pg);
      if (saved) { showPlan(planId(saved), true, true); return; }
      alignStart(pg, false);
    } else if (act && act.indexOf('plan-') === 0) {
      var pl = planById(b.getAttribute('data-plan')); if (!pl) return;
      var pid = planId(pl);
      if (act === 'plan-show') showPlan(pid, !planOn(pl), true);
      else if (act === 'plan-again') alignStart(pl.page, true);
      else if (act === 'plan-queue') { M.autoNote = ''; startQueue(pid); }
      else if (act === 'plan-auto') runAuto(pid);
      else if (act === 'plan-remove') {
        if (!confirm('Remove the saved plan for report page ' + pl.page + '? Its tie-in is deleted. Borings already placed stay where they are, and your other saved pages are not touched.')) return;
        post({ mode: 'clearPlan', id: pid }).then(function (j) { if (j && j.ok) { M.state = j.map; delete M.showPlans[pid]; drawPlan(); renderGeo(); renderLayerPanel(); } else alert((j && j.error) || 'Could not remove the plan.'); });
      }
    } else if (act === 'resume') { drive(); renderGeo(); }
    else if (act === 'clear') {
      if (!confirm('Cancel reading this report?')) return;
      M.driving = false;
      post({ mode: 'geoClear' }).then(function (j) { if (j && j.ok) { M.state = j.map; closeSheet(); renderGeo(); drawBorings(); drawPlan(); renderLayerPanel(); schedulePoll(); } });
    } else if (act === 'replace') {
      var slot = $('ajm-replace');
      if (slot) slot.innerHTML = '<div class="ajm-warn">Reading a different report replaces these borings. Borings you placed by hand keep their spot if the new report uses the same numbers.</div>' + pdfPicker('Read this report instead');
    }
  }
  // The admin's browser walks the preparation forward one slice at a time.
  function drive() {
    if (M.driving) return;
    M.driving = true;
    var code = M.code, n = 0, misses = 0;
    msg('ajm-msg', '');
    var step = function () {
      if (M.code !== code || !M.driving) { M.driving = false; return; }
      post({ mode: 'geoStep' }).then(function (j) {
        if (M.code !== code) { M.driving = false; return; }
        var ok = !!(j && j.ok);
        if (ok) { M.state = j.map; misses = 0; }
        var g = M.state && M.state.geotech;
        // One failed call is often a blip (a cold server, a dropped connection): try twice more before stopping.
        var retry = !ok && ++misses <= 2;
        var again = (retry || (ok && g && g.status === 'preparing')) && ++n < 80;
        if (!again) M.driving = false;
        renderGeo(); drawPlan(); renderLayerPanel();
        if (again) setTimeout(step, retry ? 2500 : 400);
        else { schedulePoll(); if (!ok) msg('ajm-msg', esc((j && j.error) || 'Could not prepare the report.') + ' Tap Continue to try again.', 'err'); }
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
      var cls = 'ajm-bor' + (b.kind === 'test pit' ? ' is-pit' : '') + (b.placed === 'manual' ? ' is-manual' : b.placed === 'auto' ? ' is-auto' : '') + (M.selBoring === b.id ? ' is-sel' : '');
      var mk = L.marker([b.lat, b.lon], { icon: L.divIcon({ className: '', html: '<div class="' + cls + '"><i></i><span>' + esc(b.id) + '</span></div>', iconSize: [0, 0] }), keyboard: false, zIndexOffset: M.selBoring === b.id ? 1000 : 0 });
      mk.on('click', function (ev) { if (ev.originalEvent) ev.originalEvent.stopPropagation(); if (M.align) { alignTap(ev.latlng); return; } if (!M.placing) selectBoring(b.id, false); });
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
    var where = b.placed === 'auto' ? 'Found on the boring location plan automatically — check it against the drawing'
      : b.placed === 'manual' ? 'Placed on the map by ' + (b.placedBy || 'an admin') + (b.reportLat != null ? ' (the report’s own coordinates differ)' : '')
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
      if (navigator.geolocation) h += '<button type="button" class="btn aj-mini" data-ajm-sheet="gps" title="Stand on the boring and use your phone’s GPS">I’m standing on it</button>';
      if (b.placed === 'manual' || b.placed === 'auto') h += '<button type="button" class="btn aj-mini" data-ajm-sheet="unplace">' + (b.reportLat != null ? 'Back to the report’s spot' : 'Take off the map') + '</button>';
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
    } else if (act === 'place') { M.queue = null; startPlacing(b.id); }
    else if (act === 'gps') {
      t.disabled = true; t.textContent = 'Getting your location…';
      navigator.geolocation.getCurrentPosition(function (pos) {
        t.disabled = false; t.textContent = 'I’m standing on it';
        var ft = Math.round(pos.coords.accuracy * 3.281);
        if (!confirm('Place ' + b.id + ' where you are standing?\n\nYour phone says this fix is good to about ' + ft + ' feet.' + (ft > 15 ? ' Wait a moment under open sky and try again for a tighter one.' : ''))) return;
        savePlacement(b.id, pos.coords.latitude, pos.coords.longitude, true);
      }, function (err) {
        t.disabled = false; t.textContent = 'I’m standing on it';
        alert('Could not get your location' + (err && err.message ? ' — ' + err.message : '') + '.');
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    }
    else if (act === 'unplace') {
      post({ mode: 'unplaceBoring', id: b.id }).then(function (j) { if (j && j.ok) { M.state = j.map; var nb = boring(b.id); drawBorings(); renderGeo(); renderLayerPanel(); if (nb) renderSheet(nb); } else alert((j && j.error) || 'Could not save.'); });
    }
  }
  function banner(html) { var bn = $('ajm-banner'); if (!bn) return; bn.innerHTML = html || ''; bn.style.display = html ? 'block' : 'none'; }
  function bnSlider(v) { return '<label class="bn-op">Plan <input type="range" data-ajm-bn-op="1" min="5" max="100" step="5" value="' + Math.round(v * 100) + '" aria-label="How strongly the plan shows"></label>'; }
  function bnBtn(act, label, go) { return '<button type="button" data-ajm-bn="' + act + '"' + (go ? ' class="go"' : '') + '>' + label + '</button>'; }
  function startPlacing(id) {
    M.placing = id; closeSheet();
    $('ajm-layers').classList.remove('open'); $('ajm-t-layers').classList.remove('on');
    var q = M.queue;
    banner((M.autoNote ? '<div style="font-weight:500;margin-bottom:5px">' + esc(M.autoNote) + '</div>' : '') +
      'Tap ' + (anyPlanOn() ? 'the ' + esc(id) + ' mark on the plan' : 'the map where ' + esc(id) + ' was drilled') + (q ? ' (' + q.length + ' left)' : '') +
      (anyPlanOn() ? bnSlider(M.planStrength) : '') + '<div class="bn-acts">' + (q ? bnBtn('skip', 'Skip this one') + bnBtn('stop', 'Stop') : bnBtn('stop', 'Cancel')) + '</div>');
    picking(true);
  }
  function stopPlacing() { M.placing = null; if (!M.align) { banner(''); picking(false); } }
  // Walk through every boring that is not on the map yet, one tap each.
  function startQueue(pid) {
    var g = M.state && M.state.geotech;
    M.queue = g && g.borings ? g.borings.filter(function (b) { return b.lat == null; }).map(function (b) { return b.id; }) : [];
    M.selBoring = null; closeSheet();
    var qp = planById(pid);
    if (qp && !planOn(qp)) showPlan(planId(qp), true, false);
    var st = $('ajm-stage'); if (st && !st.classList.contains('is-full')) st.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    nextInQueue();
  }
  function nextInQueue() {
    if (!M.queue || !M.queue.length) { M.queue = null; M.autoNote = ''; stopPlacing(); drawBorings(); renderGeo(); return; }
    startPlacing(M.queue[0]);
  }
  function onBannerClick(e) {
    var b = e.target.closest('[data-ajm-bn]'); if (!b) return;
    var act = b.getAttribute('data-ajm-bn');
    if (act === 'skip') { if (M.queue) M.queue.shift(); nextInQueue(); }
    else if (act === 'stop') { M.queue = null; M.autoNote = ''; stopPlacing(); }
    else if (act === 'ok') banner('');
    else if (act === 'queue') { M.autoNote = ''; startQueue(M.queuePlan); }
    else if (act === 'align-cancel') alignCancel();
    else if (act === 'align-restart') alignRestart();
    else if (act === 'align-save') alignSave();
  }
  function savePlacement(id, lat, lon, openSheet) {
    return post({ mode: 'placeBoring', id: id, lat: lat, lon: lon }).then(function (j) {
      if (!j || !j.ok) { alert((j && j.error) || 'Could not save the location.'); return false; }
      M.state = j.map;
      if (openSheet) { M.selBoring = id; var b = boring(id); if (b) renderSheet(b); }
      drawBorings(); drawPlan(); renderGeo(); renderLayerPanel();
      return true;
    });
  }
  function placeAt(latlng) {
    var id = M.placing, queued = !!M.queue;
    stopPlacing();
    savePlacement(id, latlng.lat, latlng.lng, !queued).then(function (ok) {
      if (!queued || !M.queue) return;
      if (ok) M.queue = M.queue.filter(function (x) { return x !== id; });
      nextInQueue();
    });
  }

  // ------------------------------------------------------------------ boring location plan
  // Most reports give no coordinates, only a drawing that shows where each
  // boring was drilled. That page is turned into an image, laid on the map and
  // pinned down by two points the admin can find on both (a building corner, a
  // road intersection). Two points fix position, scale and rotation. After
  // that every boring is one tap on its mark.
  //
  // The fit is P = z·p + t on complex numbers: p a pixel on the plan image, P a
  // pixel on the map's zoom-22 grid (Web Mercator keeps shapes, so one scale
  // and one rotation are enough).
  function cdiv(a, b) { var d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; }
  function planFit(pts) {
    var A = M.map.project([pts[0].lat, pts[0].lon], PLAN_Z), B = M.map.project([pts[1].lat, pts[1].lon], PLAN_Z);
    var z = cdiv([B.x - A.x, B.y - A.y], [pts[1].x - pts[0].x, pts[1].y - pts[0].y]);
    return { z: z, t: [A.x - (z[0] * pts[0].x - z[1] * pts[0].y), A.y - (z[1] * pts[0].x + z[0] * pts[0].y)] };
  }
  function planToLL(T, x, y) { return M.map.unproject(window.L.point(T.z[0] * x - T.z[1] * y + T.t[0], T.z[1] * x + T.z[0] * y + T.t[1]), PLAN_Z); }
  function planFromLL(T, latlng) { var P = M.map.project(latlng, PLAN_Z); var p = cdiv([P.x - T.t[0], P.y - T.t[1]], T.z); return { x: p[0], y: p[1] }; }
  function planQuad(T, w, h) { var c = function (x, y) { var ll = planToLL(T, x, y); return [ll.lat, ll.lng]; }; return { tl: c(0, 0), tr: c(w, 0), bl: c(0, h), br: c(w, h) }; }
  // Every saved plan page (one per report page), each its own layer on the map.
  function plans() { var s = M.state; return s && Array.isArray(s.plans) ? s.plans : []; }
  function planId(p) { return p.id || ('p' + p.page); }
  function planById(id) { return plans().filter(function (p) { return planId(p) === id; })[0] || null; }
  function planByPage(page) { return plans().filter(function (p) { return Number(p.page) === Number(page); })[0] || null; }
  // Off until it is ticked under Layers, pulled up from the saved list, or used to place borings.
  function planOn(p) { return !!(p && M.showPlans[planId(p)]); }
  function anyPlanOn() { return plans().some(planOn); }
  function setPlanStrength(v) { M.planStrength = v; Object.keys(M.planLayers).forEach(function (id) { M.planLayers[id].layer.setOpacity(v); }); }
  // Switch one saved page on or off; `go` also brings the map to it.
  function showPlan(id, on, go) {
    M.showPlans[id] = !!on;
    drawPlan(); renderLayerPanel(); renderGeo();
    var cur = M.planLayers[id];
    if (!on || !go || !cur) return;
    M.map.fitBounds(cur.layer.getBounds().pad(0.05));
    var st = $('ajm-stage'); if (st && !st.classList.contains('is-full')) st.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  // Only the copies that are meant to be there may sit in the plan pane. Anything
  // else is a leftover (a tie-in that was started twice, a plan since removed)
  // and would otherwise stay on the map with no switch to turn it off.
  function sweepPlan() {
    if (!M.map) return;
    var keep = Object.keys(M.planLayers).map(function (id) { return M.planLayers[id].layer; }), stray = [];
    M.map.eachLayer(function (l) { if (l.options && l.options.pane === 'ajmPlan' && keep.indexOf(l) < 0 && !(M.align && l === M.align.layer)) stray.push(l); });
    stray.forEach(function (l) { M.map.removeLayer(l); });
  }
  // Brings the map in line with the saved pages and which of them are ticked.
  // Safe to call on every state change: a page already showing is left alone.
  function drawPlan() {
    if (!M.map) return;
    var want = {};
    if (!M.align) plans().forEach(function (p) { if (planOn(p)) want[planId(p)] = { p: p, key: [M.code, p.folder, p.name, p.w, p.h, JSON.stringify(p.pts)].join('|') }; });
    Object.keys(M.planLayers).forEach(function (id) {
      var cur = M.planLayers[id];
      if (!want[id] || want[id].key !== cur.key) { M.map.removeLayer(cur.layer); delete M.planLayers[id]; }
    });
    sweepPlan();
    Object.keys(want).forEach(function (id) {
      if (M.planLayers[id]) return;
      var p = want[id].p;
      M.planLayers[id] = { key: want[id].key, layer: new QuadOverlay(fileUrl(M.code, p), planQuad(planFit(p.pts), p.w, p.h), { pane: 'ajmPlan', opacity: M.planStrength, interactive: false }).addTo(M.map) };
    });
  }
  function planBlockHtml(g, admin, unplaced) {
    var pl = plans();
    if (!admin) return pl.length ? '<div class="ajm-note">' + (pl.length === 1 ? 'The report’s boring location plan (page ' + pl[0].page + ') can' : pl.length + ' boring location plan pages from the report (pages ' + pl.map(function (p) { return p.page; }).join(', ') + ') can each') + ' be switched on under Layers.</div>' : '';
    var found = (g.planPages || []).filter(function (n) { return !planByPage(n); });
    var h = '<div class="ajm-planbox"><div class="ajm-lh" style="margin-top:0">Boring location plans</div>';
    if (pl.length) {
      h += '<div class="ajm-note">Every page you save is kept here with its tie-in and is its own layer on the map. Pull one up with Show — there is nothing to line up again.</div>';
      pl.forEach(function (p) {
        var id = escA(planId(p)), on = planOn(p), when = p.at ? new Date(p.at).toLocaleDateString() : '';
        var bt = function (act, label, primary) { return '<button type="button" class="btn ' + (primary ? 'btn-primary ' : '') + 'aj-mini" data-ajm-geo="' + act + '" data-plan="' + id + '">' + label + '</button>'; };
        h += '<div class="ajm-plan' + (on ? ' on' : '') + '"><div class="ajm-plan-t"><b>Report page ' + p.page + '</b><span>' + [on ? 'showing on the map' : 'saved', p.by ? 'lined up by ' + esc(p.by) : '', when].filter(Boolean).join(' · ') + '</span></div><div class="ajm-acts">' +
          bt('plan-show', on ? 'Hide' : 'Show on map', !on) +
          (unplaced ? bt('plan-auto', 'Find borings on this page') + bt('plan-queue', 'Place by hand') : '') +
          bt('plan-again', 'Line it up again') + bt('plan-remove', 'Remove') + '</div></div>';
      });
    } else {
      h += '<div class="ajm-note">Reports rarely print coordinates — they show the borings on a drawing. Put that page on the map, pin it down with two points you can find on both, and save it. If the borings are spread over several pages, save each page — they are all kept. How close this gets depends on the drawing: most reports call their boring locations approximate.</div>';
    }
    h += '<div class="ajm-filebar"><label class="ajm-note" style="margin:0" for="ajm-plan-page">' + (pl.length ? 'Add another report page' : 'Report page with the plan') + '</label>' +
      '<input type="number" id="ajm-plan-page" min="1" max="' + (g.pageCount || 9999) + '" inputmode="numeric" value="' + (found[0] || '') + '">' +
      '<button type="button" class="btn ' + (pl.length ? '' : 'btn-primary ') + 'aj-mini" data-ajm-geo="plan">Put this page on the map</button></div>';
    if (found.length) h += '<div class="ajm-fine">The AI spotted a boring location plan on ' + (found.length === 1 ? 'page' : 'pages') + ' that ' + (found.length === 1 ? 'is' : 'are') + ' not saved yet:</div><div class="ajm-acts">' +
      found.slice(0, 12).map(function (n) { return '<button type="button" class="btn aj-mini" data-ajm-geo="plan-page" data-page="' + n + '">Page ' + n + '</button>'; }).join('') + '</div>';
    else if (!pl.length) h += '<div class="ajm-fine">The AI did not spot the plan page — open the report, find the drawing that shows the borings, and type its page number.</div>';
    return h + '</div>';
  }
  function ensurePdfJs() {
    if (window.pdfjsLib) return Promise.resolve();
    return loadScript(PDFJS).then(function () { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; });
  }
  // One report page -> a JPEG the map can show ({ dataUrl, w, h }).
  function renderPlanPage(page) {
    return fetch('/api/job-map?code=' + encodeURIComponent(M.code) + '&planPage=' + page).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || 'Could not load that page (' + r.status + ').'); });
      return r.arrayBuffer();
    }).then(function (buf) { return ensurePdfJs().then(function () { return window.pdfjsLib.getDocument({ data: buf }).promise; }); })
      .then(function (pdf) { return pdf.getPage(1); })
      .then(function (pg) {
        var one = pg.getViewport({ scale: 1 });
        var vp = pg.getViewport({ scale: Math.min(4, 2600 / Math.max(one.width, one.height)) });
        var cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        var ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
        return pg.render({ canvasContext: ctx, viewport: vp }).promise
          .then(function () { return pg.getTextContent().catch(function () { return { items: [] }; }); })
          .then(function (tc) { return { dataUrl: cv.toDataURL('image/jpeg', 0.85), w: cv.width, h: cv.height, labels: planLabels(tc, vp) }; });
      });
  }
  function normId(v) {
    var t = String(v || '').toUpperCase().trim();
    var m = t.match(/^([A-Z]{1,6})[\s._-]*0*(\d{1,4})([A-Z]?)$/);
    return m ? m[1] + '-' + m[2] + m[3] : t;
  }
  // A plan drawn in CAD keeps its lettering as real text. Where a boring number
  // is written is a sure pointer to where its symbol is — no guessing needed.
  // -> [{ id, x, y }] in image pixels, only for borings on this job.
  function planLabels(tc, vp) {
    var g = M.state && M.state.geotech, want = {};
    (g && g.borings ? g.borings : []).forEach(function (b) { want[b.id] = 1; });
    var out = [], per = {};
    (tc.items || []).forEach(function (it) {
      var str = String(it.str || '');
      if (!str.trim() || !it.transform) return;
      var m = window.pdfjsLib.Util.transform(vp.transform, it.transform);
      var len = Math.hypot(m[0], m[1]) || 1, ux = m[0] / len, uy = m[1] / len, wpx = (it.width || 0) * vp.scale;
      var re = /(^|[^A-Za-z0-9])([A-Za-z]{1,6}[\s._-]{0,2}\d{1,4}[A-Za-z]?)(?![A-Za-z0-9])/g, hit;
      while ((hit = re.exec(str))) {
        var id = normId(hit[2]);
        if (!want[id]) continue;
        var frac = (hit.index + hit[1].length + hit[2].length / 2) / str.length;
        per[id] = (per[id] || 0) + 1;
        if (per[id] > 3) continue;
        out.push({ id: id, x: Math.round(m[4] + ux * wpx * frac + m[2] * 0.35), y: Math.round(m[5] + uy * wpx * frac + m[3] * 0.35) });
      }
    });
    return out;
  }
  function loadImage(url) {
    return new Promise(function (res, rej) { var im = new Image(); im.onload = function () { res(im); }; im.onerror = function () { rej(new Error('could not load the plan image')); }; im.src = url; });
  }
  // A close-up of the plan around (cx, cy): 520 px of the drawing blown up to 832.
  function planCrop(im, cx, cy) {
    var size = Math.min(520, im.naturalWidth, im.naturalHeight), out = 832;
    var x0 = Math.round(Math.max(0, Math.min(im.naturalWidth - size, cx - size / 2))), y0 = Math.round(Math.max(0, Math.min(im.naturalHeight - size, cy - size / 2)));
    var cv = document.createElement('canvas'); cv.width = out; cv.height = out;
    cv.getContext('2d').drawImage(im, x0, y0, size, size, 0, 0, out, out);
    return { data: cv.toDataURL('image/jpeg', 0.9).split(',')[1], w: out, h: out, ox: x0, oy: y0, k: size / out };
  }
  // Run fn over items, n at a time; resolves when all are done (fn handles its own errors).
  function inLanes(items, n, fn) {
    var at = 0;
    var lane = function () { return at < items.length ? Promise.resolve(fn(items[at++])).then(lane) : Promise.resolve(); };
    var all = []; for (var i = 0; i < n; i++) all.push(lane());
    return Promise.all(all);
  }
  // The pictures the AI is shown to find borings roughly: the whole plan shrunk
  // for a handful of borings, or a grid of overlapping full-size parts for many.
  // -> [{ data, w, h, x0, y0, sc, part }]  (x0,y0 = where the picture starts on the plan, sc = its shrink factor)
  function planViews(im, count) {
    var W = im.naturalWidth, H = im.naturalHeight, out = [];
    var shot = function (x0, y0, w, h, sc, part) {
      var cv = document.createElement('canvas'); cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
      var ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(im, x0, y0, w, h, 0, 0, cv.width, cv.height);
      out.push({ data: cv.toDataURL('image/jpeg', 0.85).split(',')[1], w: cv.width, h: cv.height, x0: x0, y0: y0, sc: sc, part: part });
    };
    var g = count <= 40 ? 1 : count <= 100 ? 2 : 3;
    if (g === 1) { shot(0, 0, W, H, Math.min(1, 1400 / Math.max(W, H)), false); return out; }
    var tw = Math.min(W, Math.ceil(W / g * 1.18)), th = Math.min(H, Math.ceil(H / g * 1.18));   // 18% wider than a plain grid cell, so neighbours overlap
    var sc = Math.min(1, 1600 / Math.max(tw, th));
    for (var r = 0; r < g; r++) for (var c = 0; c < g; c++) shot(Math.round(c * (W - tw) / (g - 1)), Math.round(r * (H - th) / (g - 1)), tw, th, sc, true);
    return out;
  }
  // Find the borings on the pinned plan and place the ones it is sure of.
  // -> { placed: [ids], left: [ids], error }
  function autoPlace(plan, ids, progress) {
    var code = M.code;
    if (!plan || !ids.length) return Promise.resolve({ placed: [], left: ids, error: '' });
    var T = planFit(plan.pts), error = '';
    var call = function (body) { return post(Object.assign({ mode: 'planLocate' }, body)).then(function (j) { if (!j || !j.ok) throw new Error((j && j.error) || 'no answer'); return j.results || []; }); };
    return loadImage(fileUrl(code, plan)).then(function (im) {
      // 1. where each number is written, from the PDF's own text
      var cands = {};
      (plan.labels || []).forEach(function (l) { if (ids.indexOf(l.id) >= 0) (cands[l.id] = cands[l.id] || []).push({ x: l.x, y: l.y }); });
      // 2. anything not lettered as text (a scanned drawing): ask for a rough spot.
      //    A few borings: one look at the whole plan. Many: the plan goes in
      //    overlapping parts at full size (numbers stay readable, and no answer
      //    has to list more borings than fit in one reply), every boring asked
      //    about in every part — none is ever left out of the search.
      var missing = ids.filter(function (id) { return !cands[id]; });
      var coarse = Promise.resolve();
      if (missing.length) {
        var views = planViews(im, missing.length), jobs = [], seen = 0;
        views.forEach(function (v) { for (var i = 0; i < missing.length; i += v.part ? 250 : 40) jobs.push({ v: v, ids: missing.slice(i, i + (v.part ? 250 : 40)) }); });
        var found = {};
        var say = function () { if (progress) progress(jobs.length === 1 ? 'Looking over the whole plan…' : 'Looking over the plan… part ' + Math.min(seen + 1, jobs.length) + ' of ' + jobs.length); };
        say();
        coarse = inLanes(jobs, 2, function (job) {
          var v = job.v;
          return call({ stage: 'coarse', part: v.part, ids: job.ids, image: { data: v.data, w: v.w, h: v.h } }).then(function (res) {
            res.forEach(function (r) {
              var id = normId(r.id);
              if (!r.found || job.ids.indexOf(id) < 0 || !(r.x >= 0 && r.y >= 0 && r.x <= v.w && r.y <= v.h)) return;
              var x = v.x0 + r.x / v.sc, y = v.y0 + r.y / v.sc, list = found[id] = found[id] || [];
              // two overlapping parts both see the same symbol: one close-up is enough
              if (!list.some(function (c) { return Math.hypot(c.x - x, c.y - y) < 130; }) && list.length < 3) list.push({ x: x, y: y });
            });
          }).catch(function (e) { error = e.message; }).then(function () { seen++; say(); });
        }).then(function () { Object.keys(found).forEach(function (id) { cands[id] = found[id]; }); });
      }
      return coarse.then(function () {
        // 3. a close-up of every candidate: the centre of the symbol itself
        var tasks = [];
        ids.forEach(function (id) { (cands[id] || []).forEach(function (c) { tasks.push({ id: id, crop: planCrop(im, c.x, c.y) }); }); });
        var groups = []; for (var i = 0; i < tasks.length; i += 6) groups.push(tasks.slice(i, i + 6));
        var done = 0;
        var runGroup = function (grp) {
          return call({ stage: 'refine', crops: grp.map(function (t) { return { id: t.id, data: t.crop.data, w: t.crop.w, h: t.crop.h, ox: t.crop.ox, oy: t.crop.oy, k: t.crop.k }; }) }).then(function (res) {
            res.forEach(function (r) { var t = grp[r.n - 1]; if (t && !t.hit) t.hit = r; });
          }).catch(function (e) { error = e.message; }).then(function () { done += grp.length; if (progress) progress('Finding the borings on the plan… ' + Math.min(done, tasks.length) + ' of ' + tasks.length); });
        };
        if (progress && tasks.length) progress('Finding the borings on the plan… 0 of ' + tasks.length);
        return inLanes(groups, 3, runGroup).then(function () { return tasks; });
      });
    }).then(function (tasks) {
      if (M.code !== code) return { placed: [], left: [], error: '' };
      // 4. keep only answers it is sure of, and that land on the site
      var L = window.L, site = M.parsed && M.parsed.bounds ? L.latLngBounds(M.parsed.bounds).pad(1) : null, items = [];
      ids.forEach(function (id) {
        var hits = tasks.filter(function (t) { var h = t.hit; return t.id === id && h && h.found && h.confidence !== 'low' && h.x >= 0 && h.y >= 0 && h.x <= t.crop.w && h.y <= t.crop.h; })
          .map(function (t) { return { x: t.crop.ox + t.hit.x * t.crop.k, y: t.crop.oy + t.hit.y * t.crop.k, c: t.hit.confidence === 'high' ? 2 : 1 }; });
        if (!hits.length) return;
        hits.sort(function (a, b) { return b.c - a.c; });
        // the number drawn in two places that disagree: do not pick one
        if (hits.some(function (h) { return Math.hypot(h.x - hits[0].x, h.y - hits[0].y) > 30; })) return;
        var ll = planToLL(T, hits[0].x, hits[0].y);
        if (site && !site.contains(ll)) return;
        items.push({ id: id, lat: ll.lat, lon: ll.lng });
      });
      if (!items.length) return { placed: [], left: ids, error: error };
      // saved 150 at a time (the server takes 200 a call), so a big job is never cut short
      var placed = [], batches = [];
      for (var bi = 0; bi < items.length; bi += 150) batches.push(items.slice(bi, bi + 150));
      return inLanes(batches, 1, function (batch) {
        return post({ mode: 'placeBorings', auto: true, items: batch }).then(function (j) {
          if (!j || !j.ok) { error = (j && j.error) || 'could not save'; return; }
          M.state = j.map;
          batch.forEach(function (i) { placed.push(i.id); });
        });
      }).then(function () {
        return { placed: placed, left: ids.filter(function (id) { return placed.indexOf(id) < 0; }), error: error };
      });
    }).catch(function (e) { return { placed: [], left: ids, error: (e && e.message) || 'something went wrong' }; });
  }
  // Automatic first; whatever it could not find goes to the tap-by-hand walk-through.
  function runAuto(pid) {
    var g = M.state && M.state.geotech, plan = planById(pid);
    if (M.autoBusy || M.align || !plan || !g || !g.borings) return;
    var ids = g.borings.filter(function (b) { return b.lat == null; }).map(function (b) { return b.id; });
    if (!ids.length) return;
    M.autoBusy = true; M.queue = null; M.autoNote = ''; stopPlacing(); closeSheet(); M.selBoring = null;
    if (!planOn(plan)) showPlan(pid, true, false);
    var st = $('ajm-stage'); if (st && !st.classList.contains('is-full')) st.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    var code = M.code, pageName = 'page ' + plan.page;
    banner('Finding the borings on ' + pageName + '…');
    autoPlace(plan, ids, function (text) { if (M.code === code && M.autoBusy) banner(esc(text)); }).then(function (res) {
      M.autoBusy = false;
      if (M.code !== code) return;
      drawBorings(); renderGeo(); renderLayerPanel();
      var n = res.placed.length, left = res.left.length;
      if (!left) {
        banner(n + ' boring' + (n === 1 ? '' : 's') + ' placed from ' + pageName + '. Check them against the drawing.<div class="bn-acts">' + bnBtn('ok', 'OK', true) + '</div>');
        return;
      }
      // The automation itself failed (no answer from the AI): straight to tapping them in.
      if (!n && res.error) {
        M.autoNote = 'Could not find the borings automatically (' + res.error + ') — tap them in.';
        startQueue(pid);
        return;
      }
      // Some are still off the map. On a report with several plan pages they are usually on another page, so ask rather than walk through all of them here.
      M.queuePlan = pid;
      banner((n ? n + ' boring' + (n === 1 ? '' : 's') + ' placed from ' + pageName + '.' : 'None of the borings still missing were found on ' + pageName + '.') +
        ' ' + left + ' ' + (left === 1 ? 'is' : 'are') + ' not on the map yet' + (left <= 8 ? ' (' + esc(res.left.join(', ')) + ')' : '') +
        ' — if ' + (left === 1 ? 'it is' : 'they are') + ' on another page of the report, save that page too.' +
        '<div class="bn-acts">' + bnBtn('queue', 'Tap ' + (left === 1 ? 'it' : 'them') + ' in on this page', true) + bnBtn('ok', 'Done') + '</div>');
    });
  }
  // Where the plan sits before it is pinned: centred on the site, about as wide as the site.
  function planGuess(w, h) {
    var L = window.L;
    var bb = M.parsed && M.parsed.bounds ? L.latLngBounds(M.parsed.bounds) : M.map.getBounds();
    var nw = M.map.project(bb.getNorthWest(), PLAN_Z), se = M.map.project(bb.getSouthEast(), PLAN_Z);
    var sc = Math.min((se.x - nw.x) / w, (se.y - nw.y) / h) * 1.1;
    if (!(sc > 0)) sc = 1;
    var cx = (nw.x + se.x) / 2, cy = (nw.y + se.y) / 2;
    return { z: [sc, 0], t: [cx - sc * w / 2, cy - sc * h / 2] };
  }
  function alignStart(page, reuse) {
    if (M.align || M.alignLoading || !M.map) return;
    var p = planByPage(page);
    M.queue = null; stopPlacing(); closeSheet(); M.selBoring = null;
    $('ajm-layers').classList.remove('open'); $('ajm-t-layers').classList.remove('on');
    var st = $('ajm-stage'); if (st && !st.classList.contains('is-full')) st.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    var begin = function (img, isNew) {
      M.align = { page: page, url: img.dataUrl || img.url, dataUrl: img.dataUrl || '', w: img.w, h: img.h, labels: img.labels || [], isNew: isNew, pts: [], step: 1, pick: null, T: planGuess(img.w, img.h) };
      drawPlan();   // hides the saved copy while this one is being moved
      M.align.layer = new QuadOverlay(M.align.url, planQuad(M.align.T, img.w, img.h), { pane: 'ajmPlan', opacity: 0.75, interactive: false }).addTo(M.map);
      M.map.fitBounds(M.align.layer.getBounds().pad(0.05), { animate: false });
      picking(true);
      alignPrompt();
    };
    if (reuse && p) { begin({ url: fileUrl(M.code, p), w: p.w, h: p.h, labels: p.labels || [] }, false); return; }
    var code = M.code, ticket = M.alignLoading = {};
    banner('Getting report page ' + page + '…<div class="bn-acts">' + bnBtn('align-cancel', 'Cancel') + '</div>');
    renderPlanPage(page).then(function (img) {
      if (M.alignLoading !== ticket) return;   // cancelled, or the job changed, while the page was loading
      M.alignLoading = null;
      if (M.code !== code || M.align) return;
      begin(img, true);
    }).catch(function (e) {
      if (M.alignLoading !== ticket) return;
      M.alignLoading = null; banner(''); alert(e && e.message ? e.message : 'Could not load that page.');
    });
  }
  function alignPrompt() {
    var a = M.align; if (!a) return;
    var text = a.step === 1 ? '<b>Step 1 of 4.</b> Tap a spot on the PLAN that you can also find on the map — a building corner, a road intersection, a property corner.'
      : a.step === 2 ? '<b>Step 2 of 4.</b> Now tap where that same spot really is on the map. Tap right on a design line or corner and it snaps to it.'
      : a.step === 3 ? '<b>Step 3 of 4.</b> Tap a second spot on the PLAN, as far from the first as you can.'
      : a.step === 4 ? '<b>Step 4 of 4.</b> Tap where that second spot really is — on a design line or corner if you can.'
      : 'Does the plan sit right? Roads, buildings and property lines should line up with the map.';
    // Faint while you look for the real spot underneath, strong while you pick on the drawing — until you set it yourself.
    var op = a.userOpacity != null ? a.userOpacity : (a.step === 2 || a.step === 4 ? 0.3 : a.step === 5 ? 0.6 : 0.75);
    a.layer.setOpacity(op);
    banner((a.snapNote ? '<div style="font-weight:500;margin-bottom:5px">' + esc(a.snapNote) + '</div>' : '') + text + bnSlider(op) + '<div class="bn-acts">' + (a.step === 5 ? bnBtn('align-save', 'Save', true) : '') + (a.step > 1 ? bnBtn('align-restart', 'Start over') : '') + bnBtn('align-cancel', 'Cancel') + '</div>');
    // pins: green = where it really is, orange = the spot picked on the plan (rides with the plan)
    var L = window.L; M.alignMarks.clearLayers();
    var pin = function (ll, n, cls) { M.alignMarks.addLayer(L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="ajm-pin ' + cls + '">' + n + '</div>', iconSize: [0, 0] }), interactive: false, keyboard: false })); };
    a.pts.forEach(function (p, i) { pin([p.lat, p.lon], i + 1, 'real'); });
    if (a.pick) pin(planToLL(a.T, a.pick.x, a.pick.y), a.pts.length + 1, 'plan');
  }
  function alignTap(latlng) {
    var a = M.align; if (!a || a.step > 4) return;
    if (a.step === 1 || a.step === 3) {
      var p = planFromLL(a.T, latlng);
      if (p.x < 0 || p.y < 0 || p.x > a.w || p.y > a.h) { banner('That tap was off the plan — tap a spot on the drawing itself.<div class="bn-acts">' + bnBtn('align-cancel', 'Cancel') + '</div>'); setTimeout(alignPrompt, 1800); return; }
      if (a.step === 3 && Math.hypot(p.x - a.pts[0].x, p.y - a.pts[0].y) < Math.max(a.w, a.h) * 0.08) { banner('Too close to the first spot — pick one well away from it for a good fit.<div class="bn-acts">' + bnBtn('align-cancel', 'Cancel') + '</div>'); setTimeout(alignPrompt, 2000); return; }
      a.pick = p; a.step++; a.snapNote = '';
    } else {
      var snap = snapToLinework(latlng);
      if (snap) latlng = snap.latlng;
      a.snapNote = snap ? (snap.corner ? 'Snapped to a corner of the linework.' : 'Snapped onto the line.') : '';
      var pt = { x: a.pick.x, y: a.pick.y, lat: latlng.lat, lon: latlng.lng };
      a.pts.push(pt); a.pick = null;
      if (a.pts.length === 1) {   // slide the plan so the first spot lands where it belongs
        var A = M.map.project(latlng, PLAN_Z), z = a.T.z;
        a.T = { z: z, t: [A.x - (z[0] * pt.x - z[1] * pt.y), A.y - (z[1] * pt.x + z[0] * pt.y)] };
      } else a.T = planFit(a.pts);   // two spots: position, scale and rotation
      a.layer.setQuad(planQuad(a.T, a.w, a.h));
      a.step++;
      if (a.step === 5) M.map.fitBounds(a.layer.getBounds().pad(0.05));
    }
    alignPrompt();
  }
  function alignEnd() {
    var a = M.align; if (!a) return;
    if (a.layer) M.map.removeLayer(a.layer);
    M.alignMarks.clearLayers(); M.align = null; banner(''); picking(false);
    drawPlan();
  }
  function alignCancel() { if (M.alignLoading) { M.alignLoading = null; if (!M.align) banner(''); } alignEnd(); }
  function alignRestart() { var a = M.align; if (!a) return; a.pts = []; a.pick = null; a.snapNote = ''; a.step = 1; a.T = planGuess(a.w, a.h); a.layer.setQuad(planQuad(a.T, a.w, a.h)); M.map.fitBounds(a.layer.getBounds().pad(0.05), { animate: false }); alignPrompt(); }
  function alignSave() {
    var a = M.align; if (!a || a.step !== 5 || a.saving) return;
    a.saving = true;
    var old = planByPage(a.page);
    var name = a.isNew || !old ? 'Boring location plan - page ' + a.page + '.jpg' : old.name, folder = a.isNew || !old ? 'Geotech' : (old.folder || '');
    banner('Saving…');
    // The image goes in the job book (Geotech) so everyone's map can load it.
    var up = a.isNew ? fetch('/api/project-files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: M.code, name: name, folder: folder, contentType: 'image/jpeg', data: a.dataUrl }) })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || 'Could not save the plan image (' + r.status + ').'); return (j && j.name) || name; }); })
      : Promise.resolve(name);
    up.then(function (saved) { return post({ mode: 'setPlan', folder: folder, name: saved, page: a.page, w: a.w, h: a.h, pts: a.pts, labels: a.labels }); }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || 'Could not save the alignment.');
      M.state = j.map;
      var savedPlan = planByPage(a.page);
      if (!savedPlan) throw new Error('The plan was not saved — try Save again.');   // never report a save that is not in the record
      var sid = planId(savedPlan);
      M.showPlans[sid] = true;
      alignEnd(); renderGeo(); renderLayerPanel();
      var g = M.state.geotech;
      if (g && g.borings && g.borings.some(function (b) { return b.lat == null; })) runAuto(sid);
      else banner('Report page ' + a.page + ' is saved. It is its own layer under Layers, and stays in the saved list below the map.<div class="bn-acts">' + bnBtn('ok', 'OK', true) + '</div>');
    }).catch(function (e) { a.saving = false; alignPrompt(); alert(e && e.message ? e.message : 'Could not save.'); });
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
    clearTimeout(M.pollTimer); M.alignLoading = null; if (M.align) alignEnd(); M.queue = null; M.autoNote = ''; M.autoBusy = false; M.showPlans = {}; M.queuePlan = null; stopPlacing(); closeSheet();
    if (M.map) Object.keys(M.planLayers).forEach(function (id) { M.map.removeLayer(M.planLayers[id].layer); });
    M.planLayers = {}; sweepPlan();
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
      drawBorings(); drawPlan(); renderLayerPanel(); renderFileBar();
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
