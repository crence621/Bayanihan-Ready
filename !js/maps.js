/* ====================================================================
   Bayanihan Ready — real maps (Leaflet + OpenStreetMap)

   Replaces the placeholder map images. Everything map-related lives here;
   data (responders, evacuation sites, routes, search...) comes from
   api.js so a real backend can be swapped in later.

   Public pieces:
     BayanihanMaps.createFullMap(el, opts)   Maps tab + Offline Map (layers, search, GPS)
     BayanihanMaps.createMiniMap(el, opts)   Select-Location sheet + Setup SOS
     BayanihanMaps.createBackdrop(el)        faint live map behind the SOS button
     BayanihanMaps.startTracking()           live GPS (one shared watcher)
     BayanihanMaps.onUser(cb)                subscribe to GPS fixes
     BayanihanMaps.addIncident(incident)     drop a reported emergency on the maps
   ==================================================================== */
const BayanihanMaps = (() => {
  'use strict';

  if (typeof L === 'undefined') {
    console.error('Leaflet did not load, so maps are disabled. Check !js/leaflet.js.');
    return null;
  }

  const API = BayanihanAPI;

  const PH_CENTER = [14.5995, 120.9842];                     // Manila
  const PH_BOUNDS = L.latLngBounds([3.0, 114.0], [23.0, 129.0]); // keeps the map on the Philippines
  const ORANGE_PIN_URL = '!assets/!images/orangemappin.png';

  /* Official hazard layers (PAGASA / Project NOAH / MGB) can be plugged in here
     as WMS endpoints. Left empty because there is no public key-free feed that
     is safe to hard-code. Example:
       landslide: { url: 'https://your-wms-host/wms', layers: 'landslide_susceptibility' } */
  const HAZARD_WMS = { landslide: null, flood: null };

  /* ------------------------------ helpers ------------------------------ */
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const debounce = (fn, ms) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  // Maps inside hidden tabs/sheets have 0 size until shown; keep Leaflet in sync.
  function watchSize(el, map) {
    if ('ResizeObserver' in window) new ResizeObserver(() => map.invalidateSize()).observe(el);
  }

  const toBox = (b) => ({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });

  function geoErrorText(err) {
    if (!window.isSecureContext) return 'GPS only works on https:// or localhost. Open the app from a local server.';
    if (err && err.code === 1) return 'Location permission is blocked. Allow it in your browser\u2019s site settings.';
    if (err && err.code === 2) return 'Can\u2019t work out your position right now. Try going outdoors.';
    if (err && err.code === 3) return 'Finding your location timed out. Try again.';
    return 'Location isn\u2019t available on this device.';
  }

  /* --------------------- tile layer with offline cache -------------------
     Street tiles you view are stored in the browser's Cache Storage, so the
     map you've already looked at still draws with no signal. */
  const TILE_CACHE = 'bayanihan-map-tiles-v1';

  /* ---- Tile provider config ------------------------------------------
     Street tiles come from MapTiler Cloud. Its terms allow caching tiles the
     person has actually viewed (browser cache, single user) but prohibit bulk /
     batch tile downloads unless agreed in writing, so ALLOW_OFFLINE_SAVE stays
     false (the "save area" prefetch is disabled). MapTiler attribution must stay
     visible on the map.                                                       */
  const MAPTILER_KEY = 'fEQNHPVDzxGn7CwVF8ik'; // restrict this key to your site's origin in the MapTiler dashboard
  const TILE_URL = 'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=' + MAPTILER_KEY;
  const TILE_ATTR = '&copy; <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  const ALLOW_OFFLINE_SAVE = false;
  const REFERRER_POLICY = 'strict-origin-when-cross-origin';
  const IS_FILE_ORIGIN = location.protocol === 'file:';
  if (IS_FILE_ORIGIN) {
    console.warn('[maps] Opened from file:// - map tile servers and geolocation need http(s) or localhost. Run a local server (e.g. npx serve).');
  }
  const hasCache = 'caches' in window;

  async function fetchTile(url) {
    const res = await fetch(url, { mode: 'cors', referrerPolicy: REFERRER_POLICY });
    if (!res.ok) {
      const e = new Error('tile ' + res.status);
      e.status = res.status; // HTTP error (403, 429...) - not a network problem
      throw e;
    }
    if (hasCache) {
      caches.open(TILE_CACHE).then((c) => c.put(url, res.clone())).catch(() => {});
    }
    return res;
  }

  async function tileBlobUrl(url) {
    try {
      return URL.createObjectURL(await (await fetchTile(url)).blob());
    } catch (netErr) {
      if (hasCache) {
        const c = await caches.open(TILE_CACHE);
        const hit = await c.match(url);
        if (hit) return URL.createObjectURL(await hit.blob());
      }
      throw netErr;
    }
  }

  const CachedTileLayer = L.TileLayer.extend({
    createTile(coords, done) {
      const img = document.createElement('img');
      img.referrerPolicy = REFERRER_POLICY;
      img.alt = '';
      img.setAttribute('role', 'presentation');
      const url = this.getTileUrl(coords);
      tileBlobUrl(url)
        .then((src) => {
          img.onload = () => { URL.revokeObjectURL(src); done(null, img); };
          img.onerror = () => { URL.revokeObjectURL(src); done(new Error('tile decode'), img); };
          img.src = src;
        })
        .catch((err) => {
          // The server answered with an error (403, 429...): leave the tile
          // blank instead of drawing the provider's error image.
          if (err && err.status) { done(err, img); return; }
          // Network/CORS failure only: let the <img> try the network directly.
          img.onload = () => done(null, img);
          img.onerror = () => done(new Error('tile load'), img);
          img.src = url;
        });
      return img;
    },

    // Pre-fetch what's on screen (plus one zoom level deeper) for offline use.
    async cacheView(map, extraZooms = 1, cap = 120) {
      if (!ALLOW_OFFLINE_SAVE) return 0;
      const urls = [];
      const b = map.getBounds();
      const z0 = Math.round(map.getZoom());
      for (let z = z0; z <= Math.min(z0 + extraZooms, this.options.maxZoom); z++) {
        const nw = map.project(b.getNorthWest(), z).divideBy(256).floor();
        const se = map.project(b.getSouthEast(), z).divideBy(256).floor();
        for (let x = nw.x; x <= se.x; x++) {
          for (let y = nw.y; y <= se.y; y++) {
            urls.push(L.Util.template(this._url, { x, y, z, s: '', r: '' }));
          }
        }
      }
      const todo = urls.slice(0, cap);
      let saved = 0;
      for (let i = 0; i < todo.length; i += 2) {
        const results = await Promise.allSettled(todo.slice(i, i + 2).map(fetchTile));
        saved += results.filter((r) => r.status === 'fulfilled').length;
        if (results.some((r) => r.status === 'rejected' && r.reason && r.reason.status)) break; // blocked / rate-limited: stop
      }
      return saved;
    },
  });

  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const ESRI_ATTR = 'Imagery &copy; Esri, Maxar, Earthstar Geographics';

  const streetLayer = () => new CachedTileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR });

  /* ---------------------------- marker icons ---------------------------- */
  const GLYPH = {
    hospital: '<path d="M6 1h2v5h5v2H8v5H6V8H1V6h5z"/>',
    fire: '<path d="M7 1c.5 2.5 3.5 3.8 3.5 7a3.5 3.5 0 0 1-7 0c0-1.5.8-2.4 1.5-3 .1 1 .6 1.5 1 1.6C6.2 5.3 6.4 3 7 1z"/>',
    police: '<path d="M7 1l5 1.8v4c0 2.8-2 4.6-5 6-3-1.4-5-3.2-5-6v-4z"/>',
    evac: '<path d="M7 1.5 1.5 6.5h1.7V12h3V8.5h1.6V12h3V6.5h1.7z"/>',
    incident: '<path d="M6 2h2v6H6zM6 9.5h2v2H6z"/>',
  };

  const pinIcon = (kind) =>
    L.divIcon({
      className: 'bm-pin-wrap',
      html: `<span class="bm-pin bm-${kind}"><svg viewBox="0 0 14 14" width="14" height="14" fill="#fff" aria-hidden="true">${GLYPH[kind]}</svg></span>`,
      iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14],
    });

  const ICONS = {
    hospital: pinIcon('hospital'),
    fire: pinIcon('fire'),
    police: pinIcon('police'),
    evac: pinIcon('evac'),
    incident: pinIcon('incident'),
    me: L.divIcon({ className: 'bm-me-wrap', html: '<span class="bm-me"></span>', iconSize: [20, 20], iconAnchor: [10, 10] }),
    meSet: L.divIcon({ className: 'bm-me-wrap', html: '<span class="bm-me is-set"></span>', iconSize: [20, 20], iconAnchor: [10, 10] }),
    dropped: L.icon({ iconUrl: ORANGE_PIN_URL, iconSize: [32, 32], iconAnchor: [16, 31], popupAnchor: [0, -28] }),
  };
  const responderIcon = (kind) =>
    kind === 'fire_station' ? ICONS.fire : kind === 'police' ? ICONS.police : ICONS.hospital;

  /* ------------------------ shared GPS (one watcher) ------------------------ */
  let user = null;           // { lat, lng, accuracy }
  let watchId = null;
  let firstFix = null;
  let lastSaved = null;
  let manual = false;        // location was set by hand: GPS fixes no longer move the dot
  let lastGps = null;        // newest real GPS fix, kept so "Use GPS" can switch back at once
  const subs = new Set();

  function pushUser(u) {
    u.manual = manual;
    user = u;
    if (!lastSaved || API.distanceKm(lastSaved, u) > 0.05) {
      lastSaved = { lat: u.lat, lng: u.lng };
      API.saveLocation({ lat: u.lat, lng: u.lng });
    }
    subs.forEach((s) => {
      const first = !s.seen;
      s.seen = true;
      s.cb(user, first);
    });
  }

  function onUser(cb) {
    const s = { cb, seen: false };
    subs.add(s);
    if (user) { s.seen = true; cb(user, true); }
    return () => subs.delete(s);
  }

  function setUserPosition({ lat, lng, accuracy }) {
    pushUser({ lat, lng, accuracy: accuracy || 30 });
  }

  // Person chose where they are (indoors, bad GPS, planning for someone else).
  function setManualPosition({ lat, lng }) {
    manual = true;
    pushUser({ lat, lng, accuracy: 20 });
  }
  // One real GPS reading, even while a hand-set location is active (used by the location pickers).
  function currentGps() {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) { reject(new Error('unsupported')); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => { lastGps = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }; resolve({ ...lastGps }); },
        reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
    });
  }
  // Back to automatic GPS.
  async function useGps() {
    const prev = user;
    manual = false;
    if (lastGps) { pushUser({ ...lastGps }); return user; }
    user = null;
    try { return await (watchId != null ? firstFix : beginWatch()); }
    catch (err) { manual = true; user = prev; throw err; }
  }

  // Resolves with the first fix; keeps watching afterwards.
  function startTracking() {
    if (!('geolocation' in navigator)) return Promise.reject(new Error('unsupported'));
    if (user) {
      if (watchId == null) beginWatch();
      return Promise.resolve(user);
    }
    if (watchId != null) return firstFix;
    return beginWatch();
  }

  function beginWatch() {
    firstFix = new Promise((resolve, reject) => {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const had = !!user;
          lastGps = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
          if (manual) { if (!had) resolve(user); return; }   // keep the hand-set location
          pushUser({ ...lastGps });
          if (!had) resolve(user);
        },
        (err) => {
          if (!user) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
            reject(err);
          } // after a first fix, transient errors are ignored
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
      );
    });
    return firstFix;
  }

  /* --------------------------- reports & emergencies store ---------------------------
     One shared list that every map reads. The Emergencies tab adds to it when a
     report is sent (or loaded) and removes from it when a report is deleted, so the
     maps and the feed always agree.
       { id, type, title, desc, lat, lng, source: 'mine' | 'community', time } */
  const incidents = [];
  const incidentSubs = new Set();

  function addIncident(inc) {
    if (!inc || inc.lat == null || inc.lng == null || isNaN(inc.lat) || isNaN(inc.lng)) return;
    inc = { type: 'Other', source: 'mine', time: Date.now(), ...inc };
    inc.id = inc.id || 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (incidents.some((i) => i.id === inc.id)) return;
    incidents.push(inc);
    incidentSubs.forEach((fn) => fn(inc, 'add'));
  }

  function removeIncident(id) {
    const i = incidents.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [inc] = incidents.splice(i, 1);
    incidentSubs.forEach((fn) => fn(inc, 'remove'));
  }

  const REPORT_COLORS = {
    Flood: '#1E63C8', Landslide: '#F08A24', Fire: '#E5342E', Medical: '#D6336C', Accident: '#D97706',
    Quake: '#7C4A21', Robbery: '#6D28D9', Assault: '#6D28D9', Other: '#6B7280',
  };
  const REPORT_TYPES = Object.keys(REPORT_COLORS);
  const ago = (t) => {
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
  };
  const typeOf = (t) => (REPORT_TYPES.includes(t) ? t : 'Other');

  function reportIcon(inc) {
    const t = typeOf(inc.type);
    return L.divIcon({
      className: 'bm-pin-wrap',
      html: `<div class="bm-rep ${inc.source === 'mine' ? 'is-mine' : ''}" style="--c:${REPORT_COLORS[t]}"><img src="!assets/!buttons/${t}.png" alt="">${inc.source === 'mine' ? '<b class="bm-rep-me">YOU</b>' : ''}</div>`,
      iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -19],
    });
  }

  /* --------------------------- simulated live feeds ---------------------------
     There is no free, key-less live feed for flood gauges or landslide reports in the
     Philippines, so these are DERIVED from the risk maps and the rain forecast:
       - flood levels only exist on ground under 3 m, depth = rising water level - ground height
       - landslide reports only appear on slopes of 18 degrees or more, more of them as the
         rain trigger goes up
     Same positions every time for the same area (hash based). Replace simFloodGauges /
     simSlides with calls to a real gauge / report service when one exists. */
  const alertState = new Set();   // alerts already raised, shared by every map
  const hash = (a, b, s = 0) => { const x = Math.sin(a * 12.9898 + b * 78.233 + s * 37.719) * 43758.5453; return x - Math.floor(x); };

  function gridPoints(bounds, maxN) {
    const south = bounds.getSouth(), north = bounds.getNorth(), west = bounds.getWest(), east = bounds.getEast();
    const span = Math.max(north - south, east - west);
    let step = 0.0015;
    while (span / step > maxN) step *= 2;
    const pts = [];
    for (let la = Math.floor(south / step) * step; la < north; la += step) {
      for (let ln = Math.floor(west / step) * step; ln < east; ln += step) pts.push({ lat: la + step / 2, lng: ln + step / 2 });
    }
    return { pts, step };
  }

  // Water level (m above sea level) that the forecast rain would push onto low ground.
  function floodWaterLevel(w) {
    if (!w) return 0;
    const R = w.past24 * 0.5 + w.next24 + w.maxRate * 3;
    return Math.max(0, Math.min(2.5, (R - 20) / 60));
  }

  const FLOOD_LABELS = ['No flooding', 'Ankle-deep', 'Knee-deep', 'Waist-deep', 'Chest-deep'];
  function floodClass(cm) {
    const i = cm <= 0 ? 0 : cm < 30 ? 1 : cm < 60 ? 2 : cm < 100 ? 3 : 4;
    return { label: FLOOD_LABELS[i], lv: Math.min(3, i) };
  }

  async function simFloodGauges(bounds, level) {
    const { pts, step } = gridPoints(bounds, 22);
    const t = await Promise.all(pts.map(terrainAt));
    const cands = pts.map((p, i) => ({ ...p, elev: t[i] ? t[i].elev : null }))
      .filter((p) => p.elev != null && p.elev > 0.3 && p.elev < 3)          // low ground only
      .map((p) => ({ ...p, rank: hash(p.lat, p.lng) }))
      .sort((a, b) => b.rank - a.rank);
    const out = [];
    for (const c of cands) {
      if (out.length >= 10) break;
      if (out.some((g) => Math.abs(g.lat - c.lat) < step * 2 && Math.abs(g.lng - c.lng) < step * 2)) continue;
      const depth = c.elev < level ? Math.round((level - c.elev) * 100 * (0.75 + 0.5 * hash(c.lat, c.lng, 2))) : 0;
      const cls = floodClass(depth);
      out.push({
        id: 'fg-' + Math.round(c.lat * 1e4) + '-' + Math.round(c.lng * 1e4),
        kind: 'gauge', type: 'Flood', title: 'Flood gauge: ' + cls.label.toLowerCase(),
        lat: c.lat, lng: c.lng, elev: c.elev, depth, label: cls.label, lv: cls.lv,
        trend: depth ? (hash(c.lat, c.lng, 3) < 0.55 ? 'Rising' : 'Steady') : 'Normal',
        time: Date.now(), source: 'simulated',
      });
    }
    return out;
  }

  const SLIDE_KINDS = [
    { title: 'Cracks / soil creep', sev: 1, note: 'Cracks and slow ground movement seen on the slope.' },
    { title: 'Minor landslide', sev: 2, note: 'Soil and rocks slid down the slope. Keep clear of the area.' },
    { title: 'Road blocked by landslide', sev: 3, note: 'Debris is blocking the road. Use another route.' },
  ];
  /* ---- DEMO STORM ----
     Forces a severe forecast (flood + landslide levels) and puts one serious flood gauge and
     one blocked road about 1 km from the person, so the levels and the 5 km bell alert can be
     shown without real bad weather. Everything it makes is labelled DEMO. */
  let demoRun = 0;   // bumps each time the demo is switched on, so its alerts fire again
  function demoOutlook(w) {
    const b = w && w.success ? w : { success: true, tempC: 27, feelsC: 32, humidity: 92, rainNowMm: 8, windKmh: 38, gustKmh: 62, days: [] };
    const hourly = Array.from({ length: 24 }, (_, k) => ({ mm: Math.max(0, Math.round((28 - Math.abs(k - 5) * 3.2) * 10) / 10), p: k < 14 ? 95 : 70 }));
    const days = (b.days && b.days.length ? b.days : [0, 1, 2, 3].map((k) => ({ date: new Date(Date.now() + k * 864e5).toISOString().slice(0, 10), hi: 29, lo: 24, prob: 90 })))
      .map((d, k) => ({ ...d, summary: 'Thunderstorm', rainMm: [96, 74, 38, 15][k] || 10, prob: [98, 92, 80, 60][k] || 60 }));
    return { ...b, success: true, demo: true, summary: 'Thunderstorm', rainNowMm: Math.max(b.rainNowMm || 0, 8),
      past24: 62, past72: 180, next6: 48, next24: 130, maxRate: 28, maxProb: 98, rateLabel: 'Intense', soil: 0.5,
      hourly, days, flood: { level: 3, label: 'Severe' }, landslide: { level: 3, label: 'Severe' } };
  }
  function demoTyphoon(d) {
    return { ...(d && d.success ? d : {}), success: true, demo: true, level: 3, maxWind: 112, maxGust: 148, peakInH: 9, minPressure: 972 };
  }
  function demoItems(at, wantFlood, wantSlide) {
    const km = 1 / 111;   // about 1 km in degrees of latitude
    const out = { gauges: [], slides: [] };
    if (wantFlood) out.gauges.push({
      id: 'demo-fg-' + demoRun, kind: 'gauge', type: 'Flood', title: 'Flood gauge: waist-deep', demo: true,
      lat: at.lat + 0.8 * km, lng: at.lng + 0.5 * km, elev: 1.1, depth: 85, label: 'Waist-deep', lv: 3,
      trend: 'Rising', time: Date.now(), source: 'simulated' });
    if (wantSlide) out.slides.push({
      id: 'demo-ls-' + demoRun, kind: 'slide', type: 'Landslide', title: 'Road blocked by landslide', demo: true,
      desc: 'Debris is blocking the road. Use another route.', sev: 3,
      lat: at.lat - 0.6 * km, lng: at.lng + 0.9 * km, slope: 24, elev: 38, time: Date.now() - 12 * 60000, source: 'simulated' });
    return out;
  }

  async function simSlides(bounds, trigger) {
    if (trigger < 1) return [];
    const { pts } = gridPoints(bounds, 22);
    const t = await Promise.all(pts.map(terrainAt));
    const want = [0, 2, 4, 7][trigger];
    const allowed = trigger === 1 ? 1 : trigger === 2 ? 2 : 3;
    return pts.map((p, i) => ({ ...p, t: t[i] }))
      .filter((p) => p.t && p.t.elev > 0.3 && p.t.slope >= 18)                 // steep ground only
      .map((p) => ({ ...p, rank: p.t.slope + hash(p.lat, p.lng) * 12 }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, want)
      .map((p) => {
        const k = SLIDE_KINDS[Math.floor(hash(p.lat, p.lng, 4) * allowed)];
        return {
          id: 'ls-' + Math.round(p.lat * 1e4) + '-' + Math.round(p.lng * 1e4),
          kind: 'slide', type: 'Landslide', title: k.title, desc: k.note, sev: k.sev,
          lat: p.lat, lng: p.lng, slope: p.t.slope, elev: p.t.elev,
          time: Date.now() - (5 + Math.floor(hash(p.lat, p.lng, 5) * 50)) * 60000, source: 'simulated',
        };
      });
  }

  /* ====================================================================
     TERRAIN ENGINE
     Free elevation tiles (Mapzen "Terrarium" on AWS, no key) are decoded in
     a canvas. From the elevation grid we derive:
       - slope (degrees)  -> Landslide layer
       - height above sea -> Flood "low ground" layer
       - elevation + slope at any point (pins, evacuation sites, routes)
     ==================================================================== */
  const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const DEM_MAX_ZOOM = 15;
  const demCache = new Map();

  function loadDem(z, x, y) {
    const key = z + '/' + x + '/' + y;
    if (demCache.has(key)) {
      const v = demCache.get(key);
      demCache.delete(key); demCache.set(key, v);   // refresh LRU order
      return v;
    }
    const p = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 256;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, 256, 256).data;
          const e = new Float32Array(65536);
          for (let i = 0, j = 0; i < 65536; i++, j += 4) e[i] = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
          resolve(e);
        } catch (err) { reject(err); }
      };
      img.onerror = () => reject(new Error('elevation tile'));
      img.src = L.Util.template(DEM_URL, { z, x, y });
    });
    p.catch(() => demCache.delete(key));
    demCache.set(key, p);
    if (demCache.size > 70) demCache.delete(demCache.keys().next().value);
    return p;
  }

  const metersPerPixel = (lat, z) => 156543.03392 * Math.cos((lat * Math.PI) / 180) / Math.pow(2, z);

  // Horn slope (degrees) at pixel (px,py); sea (<=0.3 m) neighbours count as the centre cell.
  function slopeDeg(e, px, py, mpp, s) {
    const at = (x, y) => {
      x = x < 0 ? 0 : x > 255 ? 255 : x; y = y < 0 ? 0 : y > 255 ? 255 : y;
      const v = e[y * 256 + x];
      return v <= 0.3 ? e[py * 256 + px] : v;
    };
    const a = at(px - s, py - s), b = at(px, py - s), c = at(px + s, py - s);
    const d = at(px - s, py),                        f = at(px + s, py);
    const g = at(px - s, py + s), h = at(px, py + s), i = at(px + s, py + s);
    const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * s * mpp);
    const dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * s * mpp);
    return (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
  }

  // Colour tables: [upper bound, r, g, b, alpha 0-255]
  const SLOPE_CLASSES = [
    [5,   0, 0, 0, 0],
    [12,  250, 204, 21, 118],
    [20,  249, 115, 22, 150],
    [30,  220, 38, 38, 165],
    [999, 127, 29, 29, 190],
  ];
  const LOW_CLASSES = [
    [3,   8, 48, 107, 165],
    [6,   33, 113, 181, 145],
    [10,  66, 146, 198, 120],
    [20,  158, 202, 225, 95],
    [99999, 0, 0, 0, 0],
  ];
  const pick = (table, v) => { for (const row of table) if (v < row[0]) return row; return table[table.length - 1]; };

  const TerrainLayer = L.GridLayer.extend({
    initialize(kind, opts) {
      this.kind = kind;
      this.waterLevel = 0;
      L.GridLayer.prototype.initialize.call(this, L.extend({
        minZoom: 9, minNativeZoom: 9, maxNativeZoom: DEM_MAX_ZOOM, maxZoom: 19, tileSize: 256,
      }, opts));
    },
    createTile(coords, done) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      loadDem(coords.z, coords.x, coords.y).then((e) => {
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(256, 256);
        const px = img.data;
        const lat = L.CRS.EPSG3857.pointToLatLng(L.point((coords.x + 0.5) * 256, (coords.y + 0.5) * 256), coords.z).lat;
        const mpp = metersPerPixel(lat, coords.z);
        const stride = coords.z >= 14 ? 2 : 1;
        for (let y = 0; y < 256; y++) {
          for (let x = 0; x < 256; x++) {
            const el = e[y * 256 + x];
            if (el <= 0.3) continue;                      // sea
            if (this.kind === 'surge') {                  // storm surge scenario: all ground lower than the chosen height
              const d = this.waterLevel - el;
              if (d <= 0) continue;
              const o = (y * 256 + x) * 4;
              if (d > 3)        { px[o] = 10;  px[o + 1] = 30;  px[o + 2] = 120; px[o + 3] = 215; }
              else if (d > 1.5) { px[o] = 30;  px[o + 1] = 90;  px[o + 2] = 220; px[o + 3] = 195; }
              else if (d > 0.5) { px[o] = 40;  px[o + 1] = 160; px[o + 2] = 240; px[o + 3] = 175; }
              else              { px[o] = 120; px[o + 1] = 215; px[o + 2] = 250; px[o + 3] = 160; }
              continue;
            }
            if (this.kind === 'live') {                   // simulated floodwater, ground under 3 m only
              const d = this.waterLevel - el;
              if (d <= 0) continue;
              const o = (y * 256 + x) * 4;
              px[o] = 0; px[o + 1] = 214; px[o + 2] = 255; px[o + 3] = d > 1 ? 205 : 150;
              continue;
            }
            const row = this.kind === 'slope' ? pick(SLOPE_CLASSES, slopeDeg(e, x, y, mpp, stride)) : pick(LOW_CLASSES, el);
            if (!row[4]) continue;
            const o = (y * 256 + x) * 4;
            px[o] = row[1]; px[o + 1] = row[2]; px[o + 2] = row[3]; px[o + 3] = row[4];
          }
        }
        ctx.putImageData(img, 0, 0);
        done(null, canvas);
      }).catch((err) => done(err, canvas));
      return canvas;
    },
  });

  // Elevation (m) and slope (degrees) at a point, or null when the tile can't load.
  async function terrainAt(ll) {
    const z = 14;
    const p = L.CRS.EPSG3857.latLngToPoint(L.latLng(ll.lat, ll.lng), z);
    const tx = Math.floor(p.x / 256), ty = Math.floor(p.y / 256);
    try {
      const e = await loadDem(z, tx, ty);
      const px = Math.min(255, Math.max(0, Math.floor(p.x - tx * 256)));
      const py = Math.min(255, Math.max(0, Math.floor(p.y - ty * 256)));
      const elev = e[py * 256 + px];
      return { elev: Math.round(elev * 10) / 10, slope: Math.round(slopeDeg(e, px, py, metersPerPixel(ll.lat, z), 1)) };
    } catch (err) { return null; }
  }

  /* Plain-language reading of a point's terrain. levels: 0 fine ... 3 serious */
  function terrainRisk(t) {
    if (!t) return { flood: 0, slide: 0, text: '', known: false };
    const flood = t.elev <= 3 ? 3 : t.elev <= 6 ? 2 : t.elev <= 10 ? 1 : 0;
    const slide = t.slope >= 30 ? 3 : t.slope >= 20 ? 2 : t.slope >= 12 ? 1 : 0;
    const bits = [];
    if (flood >= 2) bits.push(`Low ground (${t.elev} m), may flood`);
    else if (flood === 1) bits.push(`Fairly low (${t.elev} m)`);
    else bits.push(`Higher ground (${t.elev} m)`);
    if (slide >= 2) bits.push(`steep slope (${t.slope}°), landslide risk`);
    else if (slide === 1) bits.push(`sloping (${t.slope}°)`);
    return { flood, slide, text: bits.join(', '), known: true, elev: t.elev, slope: t.slope };
  }

  /* ---------------------------- popups ---------------------------- */
  const KIND_GLYPH = {
    assembly: GLYPH.evac,
    school: '<path d="M7 2 1 5l6 3 5-2.5V10h1.2V5L7 2zM3.5 8v2.2c0 .9 1.6 1.8 3.5 1.8s3.5-.9 3.5-1.8V8L7 9.5 3.5 8z"/>',
    shelter: '<path fill-rule="evenodd" d="M7 1.5 1 11.5h12L7 1.5zm0 3.2 3 5.3H4l3-5.3z"/>',
    hall: '<path d="M2 12V4l5-2.5L12 4v8H8.5V8h-3v4H2z"/>',
    gym: '<path d="M1 6h1.5V4H4v6H2.5V8H1zM13 6h-1.5V4H10v6h1.5V8H13zM4 6.2h6v1.6H4z"/>',
    health: '<path d="M5 1.5h4V5h3.5v4H9v3.5H5V9H1.5V5H5z"/>',
  };
  const KIND_NAME = { assembly: 'Evacuation centers', shelter: 'Shelter', hall: 'Barangay halls', school: 'Public schools', gym: 'Gyms', health: 'Health centers' };

  // Plain-language notes per site type, shown in the details panel.
  const KIND_INFO = {
    assembly: { about: 'An official evacuation center or assembly point. Local government (LGU / barangay) opens these in an emergency and usually keeps a list of who is inside.', expect: 'Registration at the entrance, relief goods and a place to stay. Space and supplies depend on how many families arrive.' },
    school: { about: 'A public school. Schools are the most common evacuation centers in the Philippines because classrooms and covered courts can shelter many families.', expect: 'Families are usually placed by classroom. Toilets are normally available. Ask the barangay or the school head before you go, because some buildings are only opened on an official order.' },
    hall: { about: 'A barangay hall or community center. This is the local government\u2019s base: the best place to register, ask for help and get official updates.', expect: 'Mostly a coordination point. It may have limited room to stay, so staff can direct you to a nearby center.' },
    health: { about: 'A public health center (RHU / barangay health station). It can give first aid and basic care and refer serious cases.', expect: 'Go here for medical needs, medicine or injuries, not for long stays. Space for sleeping is limited.' },
    gym: { about: 'A gym or covered court. It has a large open floor that can hold many families, and it is often used when classrooms are full.', expect: 'Open floor with little privacy. Bring your own mat and blanket. Check that the roof is sound and the area is not flooded.' },
    shelter: { about: 'A mapped shelter. Confirm who runs it and whether it is open to the public.', expect: 'Basic cover only. Ask the barangay what is available.' },
  };
  const BRING = ['Valid ID and important papers in a waterproof bag', 'Drinking water and ready-to-eat food for at least 3 days', 'Medicines and a first-aid kit', 'Phone, power bank and a flashlight', 'Blanket or mat, spare clothes, face mask', 'Cash in small bills', 'Baby, elderly and pet needs'];
  const yn = (v) => {
    if (v == null || v === '') return null;
    const t = String(v).toLowerCase();
    return t === 'yes' || t === 'true' ? 'Yes' : t === 'no' ? 'No' : t === 'limited' ? 'Limited' : String(v);
  };

  const walkMin = (km) => Math.max(1, Math.round((km / 4.5) * 60));
  const fmtKm = (km) => (km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(1) + ' km');

  function placePopup({ name, label, phone, lat, lng, id }, extra = '') {
    const d = user ? API.distanceKm(user, { lat, lng }) : null;
    const sub = [label, d != null ? d.toFixed(1) + ' km away' : null].filter(Boolean).join(' · ');
    const tel = phone ? phone.replace(/[^+\d]/g, '') : '';
    return `<div class="bm-pop">
      <div class="bm-pop-title">${esc(name)}</div>
      <div class="bm-pop-sub">${esc(sub)}</div>
      ${extra}
      ${tel ? `<a class="bm-pop-phone" href="tel:${esc(tel)}">${esc(phone)}</a>` : ''}
      <button type="button" class="bm-route-btn" data-lat="${lat}" data-lng="${lng}" data-name="${esc(name)}" data-id="${esc(id || '')}">Get route</button>
    </div>`;
  }

  const riskHtml = (r, pending) => {
    if (pending) return '<div class="bm-pop-risk r-wait">Checking elevation…</div>';
    if (!r || !r.known) return '';
    const lv = Math.max(r.flood, r.slide);
    return `<div class="bm-pop-risk r${lv}">${esc(r.text)}</div>`;
  };

  function sitePopup(c) {
    const lines = [];
    if (c.capacity) lines.push(`Capacity: ${esc(c.capacity)}`);
    if (c.hours) lines.push(`Hours: ${esc(c.hours)}`);
    if (c.address) lines.push(esc(c.address));
    const extra = riskHtml(c.risk, !c.risk) +
      (lines.length ? `<div class="bm-pop-meta">${lines.join('<br>')}</div>` : '') +
      '<div class="bm-pop-meta bm-pop-warn">Mapped from OpenStreetMap. Confirm with your barangay / LGU.</div>' +
      `<button type="button" class="bm-detail-btn" data-id="${esc(c.id)}">Full details</button>`;
    return placePopup(c, extra);
  }

  /* ---------------------------- marker icons (evacuation) ---------------------------- */
  function evacIcon(c, opts = {}) {
    const r = c.risk || {};
    const warn = Math.max(r.flood || 0, r.slide || 0) >= 2;
    const cls = ['bm-evac-pin', 'k-' + c.kind, opts.nearest ? 'is-nearest' : '', opts.selected ? 'is-selected' : '', warn ? 'has-warn' : ''].join(' ');
    const short = c.name.length > 24 ? c.name.slice(0, 23) + '…' : c.name;
    return L.divIcon({
      className: 'bm-pin-wrap',
      html: `<div class="${cls}"><span class="bm-evac-badge"><svg viewBox="0 0 14 14" width="19" height="19" fill="#fff" aria-hidden="true">${KIND_GLYPH[c.kind] || KIND_GLYPH.assembly}</svg></span>` +
        (warn ? '<i class="bm-warn" aria-hidden="true">!</i>' : '') +
        (opts.nearest ? '<b class="bm-near-tag">NEAREST</b>' : '') +
        `<span class="bm-evac-label">${esc(short)}</span></div>`,
      iconSize: [44, 54], iconAnchor: [22, 49], popupAnchor: [0, -48],
    });
  }

  /* ====================================================================
     FULL MAP  (Maps tab, Offline Map)
     o: { mode, noteEl, searchForm, searchInput, searchResults,
          locateBtn, saveBtn, onModeChange(mode) }
     ==================================================================== */
  // Two independent choices: the BASE map (street / satellite / topography)
  // and the RISK layer drawn on top of it (flood, landslide, weather, evacuation, route).
  const BASE_ALIAS = { street: 'street', satellite: 'satellite', topography: 'topo', topo: 'topo' };
  const MODES = {
    none:       {},
    landslide:  { extra: ['slope', 'hazardLandslide', 'liveSlide'] },
    weather:    { extra: ['radar'] },
    reports:    { extra: [] },   // only the reports themselves; no flood meters or simulated pins
    evacuation: { extra: ['evacArea', 'evac', 'responders'], minZoom: 13, zoomTo: 15 },
    flood:      { extra: ['lowground', 'floodlive', 'water', 'hazardFlood', 'liveFlood'] },
    surge:      { extra: ['surge'] },   // storm surge scenario + typhoon wind signal
    route:      { extra: ['route'], minZoom: 13, zoomTo: 15 },   // sites are loaded for the route but only drawn on the Evacuation layer
  };

  const OVERLAYS = {
    radar:  'Rain radar',
    clouds: 'Clouds (satellite)',
    rain:   'Rain forecast, next 6 h',
    wind:   'Wind',
    temp:   'Temperature',
    pressure: 'Air pressure (low = storm)',
    humidity: 'Humidity',
    typhoon: 'Typhoon tracker (DEMO)',
  };
  const GRID_OVL = ['rain', 'wind', 'temp', 'pressure', 'humidity'];   // overlays drawn from the Open-Meteo grid
  const LV = ['Low', 'Moderate', 'High', 'Severe'];

  /* ---- Typhoon wind signal (PAGASA TCWS) ---- */
  const TCWS_KEY = 'bm.tcws.v1';
  const TCWS_COL = ['#16A34A', '#2D7FD6', '#CA8A04', '#EA580C', '#DC2626', '#A21CAF'];
  const TCWS_ACTION = [
    'No wind signal is forecast right now. Stay updated on PAGASA bulletins.',
    'Get ready: secure loose objects, charge phones and check your go bag.',
    'Stay indoors if you can. Families on the coast or low ground should be ready to move.',
    'If you live on the coast, near a river or on low ground, move to an evacuation site. Follow your barangay.',
    'Move to a safe evacuation site now if you are advised to. Do not stay in coastal or low-lying homes.',
    'Move to a safe evacuation site now if you are advised to. Do not stay in coastal or low-lying homes.',
  ];
  // The signal you typed in from the PAGASA bulletin. Expires after 18 h so an old one is never trusted.
  function manualSignal() {
    try {
      const v = JSON.parse(localStorage.getItem(TCWS_KEY));
      if (v && v.level > 0 && Date.now() - v.time < 18 * 3600 * 1000) return v;
    } catch (e) { /* storage blocked */ }
    return null;
  }
  function setManualSignal(n) {
    try {
      if (n > 0) localStorage.setItem(TCWS_KEY, JSON.stringify({ level: n, time: Date.now() }));
      else localStorage.removeItem(TCWS_KEY);
    } catch (e) { /* storage blocked */ }
  }
  const agoText = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
  const tcwsPill = (n) => (n > 0
    ? `<span class="bm-badge" style="background:${TCWS_COL[n]};color:#fff">Signal No. ${n}</span>`
    : '<span class="bm-badge lv0">No signal</span>');
  const badge = (lv, text) => `<span class="bm-badge lv${lv}">${esc(text || LV[lv])}</span>`;
  const dayName = (iso, i) => (i === 0 ? 'Today' : new Date(iso + 'T12:00:00').toLocaleDateString([], { weekday: 'short' }));

  function createFullMap(el, o = {}) {
    const map = L.map(el, {
      zoomControl: false, attributionControl: false,
      maxBounds: PH_BOUNDS, maxBoundsViscosity: 1, minZoom: 5, maxZoom: 19,
    }).setView(PH_CENTER, 12);

    L.control.attribution({
      position: 'bottomleft',
      prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>',
    }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
    watchSize(el, map);

    /* base layers */
    const street = streetLayer();
    const bases = {
      street,
      satellite: L.layerGroup([
        L.tileLayer(ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 18, maxZoom: 19, attribution: ESRI_ATTR }),
        // roads + place names on top of the photo, so satellite still reads like a map
        L.tileLayer(ESRI + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 17, maxZoom: 19 }),
        L.tileLayer(ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 17, maxZoom: 19 }),
      ]),
      topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        subdomains: 'abc', maxNativeZoom: 17, maxZoom: 19,
        attribution: 'Map data &copy; OpenStreetMap contributors, SRTM | Style &copy; <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a>',
      }),
    };

    /* overlay layers */
    const groups = {
      responders: L.layerGroup(), evacArea: L.layerGroup(), evac: L.layerGroup(),
      water: L.layerGroup(), route: L.layerGroup(),
      liveFlood: L.layerGroup(), liveSlide: L.layerGroup(), wxgrid: L.layerGroup(), tytrack: L.layerGroup(),
    };
    const extras = {
      hillshade: L.tileLayer(ESRI + 'Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', {
        maxNativeZoom: 16, maxZoom: 19, opacity: 0.4, zIndex: 5, attribution: 'Hillshade &copy; Esri',
      }),
      slope: new TerrainLayer('slope', { zIndex: 6, attribution: 'Elevation: Mapzen / AWS Terrain Tiles' }),
      lowground: new TerrainLayer('flood', { zIndex: 6, attribution: 'Elevation: Mapzen / AWS Terrain Tiles' }),
      floodlive: new TerrainLayer('live', { zIndex: 7, minZoom: 11, attribution: 'Elevation: Mapzen / AWS Terrain Tiles' }),
      surge: new TerrainLayer('surge', { zIndex: 7, attribution: 'Elevation: Mapzen / AWS Terrain Tiles' }),
      clouds: null,
      hazardLandslide: HAZARD_WMS.landslide
        ? L.tileLayer.wms(HAZARD_WMS.landslide.url, { layers: HAZARD_WMS.landslide.layers, format: 'image/png', transparent: true, opacity: 0.6, zIndex: 6 })
        : null,
      hazardFlood: HAZARD_WMS.flood
        ? L.tileLayer.wms(HAZARD_WMS.flood.url, { layers: HAZARD_WMS.flood.layers, format: 'image/png', transparent: true, opacity: 0.6, zIndex: 6 })
        : null,
      radar: null, // created once RainViewer answers
      ...groups,
    };
    const keep = {
      pin: L.layerGroup().addTo(map),
      incidents: L.layerGroup().addTo(map),
      me: L.layerGroup().addTo(map),
    };

    /* state */
    let mode = 'none';
    let baseName = 'street';
    let touched = false;            // person has panned/searched; don't yank the view to GPS
    let runId = 0;
    let evacItems = [];             // every site in view, with distance + terrain risk
    let evacFilter = 'all';
    let selectedId = null;
    const evacMarkers = new Map();
    let route = null;               // { dest, profile, routes, sel, hazard, from, fromGuess, auto }
    let routeProfile = 'foot';
    let pendingDest = null;
    let routeFromPt = null;         // point A chosen by hand (null = my location)
    let detailId = null;            // evacuation site shown in the details panel
    let pick = null;                // place picker: { purpose: 'me' | 'A' | 'B', ll, name, marker }
    const loaded = { evac: null, water: null };
    let lastResp = null;
    let meMarker = null;
    let meAccuracy = null;
    let outlook = null;             // { at:{lat,lng}, weather, river }
    let outlookBusy = false;
    let typhoon = null;             // { at, time, data }: wind forecast and estimated PAGASA signal
    let typhoonBusy = false;
    let surgeH = 2;                 // storm surge scenario height in metres
    let surgeHere = null;           // { elev }: ground height at your location
    let radar = { frames: [], idx: 0, timer: null, playing: false };
    let demo = false;               // Demo storm: forced severe forecast + a gauge and blocked road near you
    let ovl = 'none';               // weather overlay on top of any layer: radar / clouds / rain / wind
    let wx = { key: '', data: null };
    let wxRun = 0;
    let live = { gauges: [], slides: [], sig: '' };   // simulated live flood levels + landslide reports
    let repFilter = 'all';
    const floodShow = { risk: true, live: true };   // Flood layer: risk map, live flooding, or both
    const itemMarkers = new Map();
    let terrainWarned = false;
    let sheetCollapsed = false;
    const POPUP_OPTS = { maxWidth: 230, autoPan: false };   // we pan ourselves so popups clear the search bar and panel
    let revealPending = false;     // after a mode switch, slide the map so the panel doesn't hide your spot

    map.on('dragstart', () => { touched = true; });

    /* ---- note chip ---- */
    function info(text, kind = '') {
      const n = o.noteEl;
      if (!n) return;
      if (!text) { n.hidden = true; n.textContent = ''; return; }
      n.hidden = false;
      n.textContent = text;
      n.classList.remove('is-busy', 'is-warn', 'is-error');
      if (kind) n.classList.add('is-' + kind);
    }

    /* ---- bottom sheet ---- */
    const host = o.panelHost || el.parentElement;
    const demoPill = document.createElement('div');
    demoPill.className = 'bm-demo-pill';
    demoPill.textContent = 'DEMO STORM';
    demoPill.hidden = true;
    host.appendChild(demoPill);
    const sheet = document.createElement('section');
    sheet.className = 'bm-sheet';
    sheet.hidden = true;
    sheet.setAttribute('aria-live', 'polite');
    host.appendChild(sheet);
    L.DomEvent.disableClickPropagation(sheet);
    L.DomEvent.disableScrollPropagation(sheet);

    /* ---- "Last updated" bar + hourly refresh ----
       Map data (evacuation sites, forecast, rivers) is saved in the browser by the API layer.
       While there is signal it is refreshed every hour; with no signal the saved copy keeps
       drawing and this bar says how old it is. */
    const REFRESH_MS = o.refreshMs || 60 * 60 * 1000;
    const FRESH_KEY = 'bm.freshAt';
    let freshAt = null;
    try { freshAt = +localStorage.getItem(FRESH_KEY) || null; } catch (e) { /* storage blocked */ }
    let dataStale = false;
    let updating = false;
    let lastTry = 0;
    const statusEl = document.createElement('button');
    statusEl.type = 'button';
    statusEl.className = 'bm-status';
    statusEl.title = 'Tap to update now';
    host.appendChild(statusEl);
    const online = () => navigator.onLine !== false;
    function ago(t) {
      const m = Math.max(0, Math.round((Date.now() - t) / 60000));
      if (m < 1) return 'just now';
      if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
      const h = Math.round(m / 60);
      if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
      const d = Math.round(h / 24);
      return d + (d === 1 ? ' day ago' : ' days ago');
    }
    function paintStatus() {
      let text; let cls;
      if (updating) { text = 'Updating map data…'; cls = 'is-busy'; }
      else if (!online() || dataStale) {
        text = freshAt ? `Offline. Saved ${ago(freshAt)}` : 'Offline. No saved data yet';
        cls = 'is-stale';
      } else if (freshAt) { text = `Last updated: ${ago(freshAt)}`; cls = Date.now() - freshAt > 2 * REFRESH_MS ? 'is-old' : 'is-ok'; }
      else { text = 'Waiting for the first update…'; cls = 'is-busy'; }
      statusEl.className = 'bm-status ' + cls;
      statusEl.innerHTML = `<i></i><span>${text}</span>${online() && !updating ? '<em>Update</em>' : ''}`;
    }
    // called with the result of each network-backed load
    function trackData(res) {
      if (!res) return;
      if (res.success && !res.stale) {
        freshAt = res.updatedAt || Date.now();
        dataStale = false;
        try { localStorage.setItem(FRESH_KEY, String(freshAt)); } catch (e) { /* ignore */ }
      } else {
        dataStale = true;
        if (res.success && res.stale && res.updatedAt) freshAt = res.updatedAt;   // age of the saved copy being shown
      }
      paintStatus();
    }
    async function refreshData(manual) {
      if (updating) return;
      lastTry = Date.now();
      if (!online()) {
        paintStatus();
        if (manual) { info('No signal. Showing the last saved map data.', 'warn'); setTimeout(() => info(''), 4000); }
        return;
      }
      updating = true;
      paintStatus();
      try {
        loaded.evac = null;
        evacFresh = true;
        outlook = null;
        const jobs = [run(true), loadOutlook()];
        const c = map.getCenter();
        const loadsEvac = mode === 'evacuation' || mode === 'route';
        if (!loadsEvac && map.getSize().x && map.getZoom() >= 12) jobs.push(API.getEvacuationCenters(toBox(map.getBounds().pad(0.15)), { fresh: true }).then(trackData));
        await Promise.allSettled(jobs);
      } finally { updating = false; paintStatus(); }
    }
    statusEl.addEventListener('click', () => refreshData(true));
    window.addEventListener('online', () => refreshData(false));
    window.addEventListener('offline', paintStatus);
    // every 30 s: keep "x min ago" honest and refresh when an hour has passed
    const statusTimer = setInterval(() => {
      if (!host.isConnected) { clearInterval(statusTimer); return; }
      paintStatus();
      if (online() && !document.hidden && Date.now() - lastTry >= REFRESH_MS) refreshData(false);
    }, o.tickMs || 30000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && online() && Date.now() - lastTry >= REFRESH_MS) refreshData(false);
    });
    paintStatus();
    setTimeout(() => { if (online() && (!freshAt || Date.now() - freshAt >= REFRESH_MS) && !updating) refreshData(false); }, 1200);


    function setSheet(headHtml, bodyHtml) {
      if (pick || detailId) return;           // the place picker / site details own the map while open
      const prevScroll = sheet.querySelector('.bm-scroll');
      const keepLeft = prevScroll ? prevScroll.scrollLeft : 0;
      sheet.hidden = false;
      sheet.classList.toggle('is-collapsed', sheetCollapsed);
      sheet.innerHTML =
        `<button type="button" class="bm-sheet-head" data-act="toggle" aria-expanded="${!sheetCollapsed}">
           <span class="bm-grab" aria-hidden="true"></span>${headHtml}
         </button>
         <div class="bm-sheet-main">${bodyHtml}</div>`;
      const sc = sheet.querySelector('.bm-scroll');
      if (sc && keepLeft) sc.scrollLeft = keepLeft;
      syncFab();
    }
    // The + / x menu sits just above the panel and rides up as the panel grows.
    const syncFab = () => host.style.setProperty('--bm-sheet-h', sheet.hidden ? '0px' : sheet.offsetHeight + 'px');
    if (window.ResizeObserver) new ResizeObserver(syncFab).observe(sheet);
    const hideSheet = () => { sheet.hidden = true; syncFab(); };
    // top edge (px from the map's top) of everything the panel and the menu cover
    const coverTop = () => (sheet.hidden ? map.getSize().y : sheet.offsetTop - (host.querySelector('.map-fab-container') ? 68 : 0));

    // The panel covers the bottom of the map. Aim at the middle of what's still visible
    // so the place you're looking at never hides behind it.
    const sheetPad = () => (sheet.hidden ? 0 : Math.max(0, map.getSize().y - coverTop()));
    map.on('popupclose', () => {
      if (!autoCollapsed) return;
      autoCollapsed = false;
      sheetCollapsed = false;
      sheet.classList.remove('is-collapsed');
      const h = sheet.querySelector('.bm-sheet-head');
      if (h) h.setAttribute('aria-expanded', 'true');
    });
    function revealPoint(ll) {
      if (sheet.hidden || !map.getSize().x) return;
      const pt = map.latLngToContainerPoint(ll);
      if (pt.y > coverTop() - 28) map.panTo(aim(ll), { animate: true });
    }
    // A popup needs room, so on a small screen the panel folds down to its title while one is open.
    let autoCollapsed = false;
    map.on('popupopen', (e) => {
      if (!sheet.hidden && !sheetCollapsed) {
        autoCollapsed = true;
        sheetCollapsed = true;
        sheet.classList.add('is-collapsed');
        const h = sheet.querySelector('.bm-sheet-head');
        if (h) h.setAttribute('aria-expanded', 'false');
      }
      requestAnimationFrame(() => {
        const pe = e.popup.getElement();
        if (!pe) return;
        const r = pe.getBoundingClientRect();
        const c = el.getBoundingClientRect();
        const top = c.top + 66;
        const bottom = c.top + coverTop() - 10;
        const icon = e.popup._source && e.popup._source._icon;
        const lowest = Math.max(r.bottom, icon ? icon.getBoundingClientRect().bottom : 0);   // keep the pin itself in view too
        const dy = r.top < top ? r.top - top : lowest > bottom ? lowest - bottom : 0;
        if (dy) map.panBy([0, dy], { animate: true });
      });
    });
    function aim(ll, z) {
      const pad = sheetPad();
      ll = L.latLng(ll);
      if (!pad) return ll;
      z = z == null ? map.getZoom() : z;
      return map.unproject(map.project(ll, z).add([0, pad / 2]), z);
    }

    /* ---- mode switching ---- */
    function applyLayers() {
      const def = MODES[mode] || MODES.none;
      const base = bases[baseName];
      Object.values(bases).forEach((b) => { if (b !== base && map.hasLayer(b)) map.removeLayer(b); });
      if (!map.hasLayer(base)) base.addTo(map);

      const want = new Set(def.extra || []);
      if (ovl === 'radar') want.add('radar');
      if (ovl === 'clouds') want.add('clouds');
      if (GRID_OVL.includes(ovl)) want.add('wxgrid');
      if (ovl === 'typhoon') want.add('tytrack');
      if (!(extras.floodlive.waterLevel > 0)) want.delete('floodlive');
      if (mode === 'flood') {
        if (!floodShow.risk) ['lowground', 'water', 'hazardFlood'].forEach((k) => want.delete(k));
        if (!floodShow.live) ['floodlive', 'liveFlood'].forEach((k) => want.delete(k));
      }
      // relief shading helps on topography, and on the plain map under the landslide slopes
      if (baseName === 'topo' || (mode === 'landslide' && baseName === 'street')) want.add('hillshade');
      Object.entries(extras).forEach(([key, layer]) => {
        if (!layer) return;
        if (want.has(key)) { if (!map.hasLayer(layer)) layer.addTo(map); }
        else if (map.hasLayer(layer)) map.removeLayer(layer);
      });
      extras.hillshade.setOpacity(baseName === 'topo' ? 0.3 : 0.4);
      extras.surge.waterLevel = surgeH;      // the storm surge height is read when its tiles are drawn
    }

    function setBase(name) {
      baseName = BASE_ALIAS[name] || 'street';
      applyLayers();
      if (o.onBaseChange) o.onBaseChange(baseName);
      if (mode === 'none') renderSheet();
    }

    // name: a risk layer ('flood' ...), 'none' to clear it, or a base name (kept for older callers)
    let evacJump = true;      // on opening the evacuation layer, move to the saved sites if none are in view
    function setMode(name) {
      if (BASE_ALIAS[name]) { setBase(name); return; }
      const def = MODES[name] || MODES.none;
      mode = MODES[name] ? name : 'none';
      if (mode === 'evacuation' || mode === 'route') { evacJump = true; evacBarClosed = false; }
      applyLayers();
      drawReports();
      updateChip();

      if (mode !== 'route') { groups.route.clearLayers(); pendingDest = null; route = null; routeFromPt = null; }
      if (mode !== 'weather') stopRadar();
      terrainWarned = false;

      info('');
      map.closePopup();
      autoCollapsed = false;
      sheetCollapsed = false;
      renderSheet();

      if (def.minZoom && !pendingDest && map.getZoom() < def.minZoom) {
        const target = user && !touched ? L.latLng(user.lat, user.lng) : map.getCenter();
        const z = def.zoomTo || def.minZoom;
        map.setView(aim(target, z), z, { animate: false });
      }
      el.classList.toggle('bm-labels', map.getZoom() >= 14);

      if (o.onModeChange) o.onModeChange(mode);
      revealPending = true;
      run(true);
    }

    /* ---- terrain tile problems ---- */
    ['slope', 'lowground', 'surge'].forEach((k) => extras[k].on('tileerror', () => {
      if (terrainWarned || !map.hasLayer(extras[k])) return;
      terrainWarned = true;
      info('Elevation data couldn’t load. Check your connection and try again.', 'error');
    }));

    /* ================= EVACUATION ================= */
    const refPoint = () => user || API.getSavedLocation() || (() => { const c = map.getCenter(); return { lat: c.lat, lng: c.lng }; })();
    const refIsUser = () => !!(user || API.getSavedLocation());

    function siteDistance(c) { return API.distanceKm(refPoint(), c); }

    function filteredSites() {
      const f = evacFilter;
      const list = evacItems.filter((c) => f === 'all' || (f === 'assembly' ? (c.kind === 'assembly' || c.kind === 'shelter') : c.kind === f));
      return list.sort((a, b) => a.distKm - b.distKm);
    }

    function nearestId() {
      const best = evacItems.slice().sort((a, b) => a.distKm - b.distKm)[0];
      return best ? best.id : null;
    }

    function drawEvac() {
      groups.evac.clearLayers();
      groups.evacArea.clearLayers();
      evacMarkers.clear();
      const near = nearestId();
      const refUser = refIsUser();
      const zoom = map.getZoom();
      // far out, keep the map readable: nearest 45 only
      const list = filteredSites().slice(0, zoom >= 15 ? 150 : 45);

      list.forEach((c) => {
        const isSel = c.id === selectedId;
        const isNear = refUser && c.id === near;
        const style = { color: '#15803D', weight: isSel ? 4 : 3, fillColor: '#22C55E', fillOpacity: isSel ? 0.45 : 0.32, interactive: false };
        if (c.outline) L.polygon(c.outline, style).addTo(groups.evacArea);
        else L.circle([c.lat, c.lng], { ...style, radius: 90, dashArray: '6 5' }).addTo(groups.evacArea);

        const m = L.marker([c.lat, c.lng], {
          icon: evacIcon(c, { nearest: isNear, selected: isSel }),
          title: c.name, zIndexOffset: isSel ? 900 : isNear ? 700 : 0,
        }).bindPopup(() => sitePopup(c), POPUP_OPTS).addTo(groups.evac);
        m.on('click', () => { selectedId = c.id; renderSheet(); });
        evacMarkers.set(c.id, m);
      });

      // dashed guide from you to the nearest site
      if (refUser && near && mode === 'evacuation') {
        const c = evacItems.find((x) => x.id === near);
        const from = refPoint();
        if (c) L.polyline([[from.lat, from.lng], [c.lat, c.lng]], { color: '#15803D', weight: 3, dashArray: '2 8', lineCap: 'round', interactive: false, opacity: 0.9 }).addTo(groups.evacArea);
      }
    }

    function annotateDistances() {
      evacItems.forEach((c) => { c.distKm = siteDistance(c); });
    }

    async function annotateTerrain(stale) {
      const todo = evacItems.filter((c) => !c.risk);
      await Promise.all(todo.map(async (c) => { c.risk = terrainRisk(await terrainAt(c)); c.terrainKnown = true; }));
      if (stale()) return;
      drawEvac();
      renderSheet();
    }

    function focusSite(id, { openPopup = true } = {}) {
      const c = evacItems.find((x) => x.id === id);
      if (!c) return;
      selectedId = id;
      touched = true;
      drawEvac();
      const z = Math.max(map.getZoom(), 16);
      map.flyTo(aim([c.lat, c.lng], z), z, { duration: 0.6 });
      if (openPopup) map.once('moveend', () => { const m = evacMarkers.get(id); if (m) m.openPopup(); });
      renderSheet();
    }

    function fitAllSites() {
      const list = filteredSites();
      const pts = list.map((c) => [c.lat, c.lng]);
      const from = refIsUser() ? refPoint() : null;
      if (from) pts.push([from.lat, from.lng]);
      if (!pts.length) return;
      touched = true;
      map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 16, paddingTopLeft: [0, 56], paddingBottomRight: [0, sheetPad() + 28] });
    }

    function riskLine(c) {
      if (!c.risk) return '<p class="bm-risk r-wait">Checking elevation…</p>';
      if (!c.risk.known) return '';
      const lv = Math.max(c.risk.flood, c.risk.slide);
      return `<p class="bm-risk r${lv}">${esc(c.risk.text)}</p>`;
    }

    function evacSheet() {
      if (map.getZoom() < 12) {
        setSheet('<span class="bm-title">Evacuation sites</span>', '<p class="bm-empty">Zoom in to see evacuation sites around you.</p>');
        return;
      }
      const all = evacItems;
      const list = filteredSites();
      const near = refIsUser() ? nearestId() : null;
      const count = (k) => all.filter((c) => (k === 'all' ? true : k === 'assembly' ? (c.kind === 'assembly' || c.kind === 'shelter') : c.kind === k)).length;
      const chips = [['all', 'All'], ['assembly', 'Official centers'], ['school', 'Public schools'], ['hall', 'Barangay halls'], ['health', 'Health centers'], ['gym', 'Gyms']]
        .filter(([k]) => k === 'all' || count(k))
        .map(([k, t]) => `<button type="button" class="bm-chip ${evacFilter === k ? 'is-on' : ''}" data-act="filter" data-k="${k}">${t} <em>${count(k)}</em></button>`)
        .join('');
      const cards = list.slice(0, 60).map((c) => `
        <article class="bm-card ${c.id === selectedId ? 'is-sel' : ''}" data-act="site" data-id="${esc(c.id)}" tabindex="0" role="button" aria-label="${esc(c.name)}">
          <div class="bm-card-top"><span class="bm-kind k-${c.kind}">${esc(c.label)}</span>${c.id === near ? '<span class="bm-tag">Nearest</span>' : ''}</div>
          <h4>${esc(c.name)}</h4>
          <p class="bm-card-meta">${fmtKm(c.distKm)} · ~${walkMin(c.distKm)} min walk${refIsUser() ? '' : ' from map center'}</p>
          ${riskLine(c)}
          <div class="bm-card-btns"><button type="button" class="bm-card-go" data-act="route" data-id="${esc(c.id)}">Route here</button><button type="button" class="bm-card-go bm-card-alt" data-act="detail" data-id="${esc(c.id)}">Details</button></div>
        </article>`).join('');
      const head = `<span class="bm-title"><i class="bm-dot evac"></i>Evacuation sites <b>${all.length}</b></span>
        <span class="bm-sub">${refIsUser() ? 'Nearest first' : 'Tap ◎ to sort by your location'} \u00b7 green areas are safe zones</span>`;
      const body = all.length
        ? `<div class="bm-chips">${chips}<button type="button" class="bm-chip bm-chip-fit" data-act="fitall">Show all</button><button type="button" class="bm-chip bm-chip-fit" data-act="redoevac">Redo search</button></div>
           <div class="bm-scroll">${cards || '<p class="bm-empty">None of this type here.</p>'}</div>`
        : `<p class="bm-empty">${evacState.kind === 'busy' ? 'Searching\u2026' : 'No evacuation sites are mapped in this view yet. Pan, zoom out, or search again.'}</p>
           <div class="bm-empty-btns">${evacState.kind === 'busy' ? '<button type="button" class="bm-btn" data-act="cancelevac">Cancel</button>' : '<button type="button" class="bm-btn bm-btn-green" data-act="redoevac">Search this area again</button>' + (API.nearestBackupSite && API.nearestBackupSite(map.getCenter().lat, map.getCenter().lng) ? ' <button type="button" class="bm-btn" data-act="gobackup">Show saved sites</button>' : '')}</div>`;
      setSheet(head, body);
      const selCard = sheet.querySelector('.bm-card.is-sel');
      if (selCard) selCard.scrollIntoView({ block: 'nearest', inline: 'center' });
    }

    /* ---- evacuation search: progress, cancel and redo ---- */
    let evacCtl = null;       // AbortController of the search in flight
    let evacSeq = 0;          // newer searches replace older ones
    let evacFresh = false;    // next search must skip the saved copy (redo / hourly refresh)
    let evacState = { kind: 'idle', msg: '' };
    const evacBar = document.createElement('div');
    evacBar.className = 'bm-evacbar';
    evacBar.hidden = true;
    evacBar.setAttribute('role', 'status');
    host.appendChild(evacBar);
    L.DomEvent.disableClickPropagation(evacBar);

    let evacBarClosed = false;   // person tapped X on the status bar; stays closed until the next search
    function paintEvacBar() {
      // the finder is on when Evacuation (or Route) is picked in the bar; background loading stays silent
      const relevant = mode === 'evacuation' || mode === 'route';
      const k = evacState.kind;
      if (!relevant || k === 'idle' || pick || detailId || (evacBarClosed && k !== 'busy')) { evacBar.hidden = true; return; }
      const label = k === 'busy' ? 'Cancel' : k === 'failed' ? 'Try again' : k === 'empty' && API.getBackupInfo && API.getBackupInfo() ? 'Search online' : 'Search again';
      evacBar.hidden = false;
      evacBar.className = 'bm-evacbar is-' + k;
      // when nothing is saved for this view but saved sites exist elsewhere, offer to jump there
      const c0 = map.getCenter();
      const near = k !== 'busy' && API.nearestBackupSite ? API.nearestBackupSite(c0.lat, c0.lng) : null;
      const go = near && near.km > 1.5 && (k === 'failed' || k === 'empty') ? `<button type="button" data-eb="goto">Show saved sites (${near.km < 10 ? near.km.toFixed(1) : Math.round(near.km)} km away)</button>` : '';
      evacBar.innerHTML = `<i></i><span>${esc(evacState.msg)}</span><button type="button" data-eb="${k === 'busy' ? 'cancel' : 'redo'}">${label}</button>${go}${k === 'busy' ? '' : '<button type="button" class="bm-evacbar-x" data-eb="close" aria-label="Close">\u2715</button>'}`;
    }
    function setEvacState(kind, msg = '') {
      if (kind === 'busy' || kind !== evacState.kind) evacBarClosed = false;   // a new search or a new result reopens the bar
      evacState = { kind, msg };
      paintEvacBar();
    }
    function gotoSaved() {
      const c0 = map.getCenter();
      const n = API.nearestBackupSite && API.nearestBackupSite(c0.lat, c0.lng);
      if (n) map.setView([n.lat, n.lng], 14);
    }
    function cancelEvac() { if (evacCtl) evacCtl.abort(); }
    function redoEvac() {
      evacFresh = true;
      loaded.evac = null;
      loadEvac(true, () => false, !(mode === 'evacuation' || mode === 'route'));
    }
    evacBar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-eb]');
      if (!b) return;
      if (b.dataset.eb === 'close') { evacBarClosed = true; paintEvacBar(); }
      else if (b.dataset.eb === 'cancel') cancelEvac();
      else if (b.dataset.eb === 'goto') gotoSaved();
      else redoEvac();
    });

    // quiet: loading them in the background under another layer, so no panel changes
    async function loadEvac(force, stale, quiet) {
      if (map.getZoom() < 12) { setEvacState('idle'); info('Zoom in to see evacuation sites.', 'warn'); if (!quiet) renderSheet(); return; }
      const view = map.getBounds();
      if (!force && loaded.evac && loaded.evac.contains(view)) { annotateDistances(); if (!quiet) renderSheet(); else if (!groups.evac.getLayers().length) drawEvac(); return; }
      if (evacCtl) evacCtl.abort();                      // a newer search replaces the older one
      const ctl = new AbortController();
      evacCtl = ctl;
      const seq = ++evacSeq;
      const fresh = evacFresh; evacFresh = false;
      setEvacState('busy', 'Finding evacuation sites…');
      let area = view.pad(0.15);
      // Keep the search area modest (about 11 km across): huge areas time out on the public servers.
      const MAXSPAN = 0.1;
      const ctr = area.getCenter();
      if (area.getNorth() - area.getSouth() > MAXSPAN || area.getEast() - area.getWest() > MAXSPAN) {
        area = L.latLngBounds([ctr.lat - MAXSPAN / 2, ctr.lng - MAXSPAN / 2], [ctr.lat + MAXSPAN / 2, ctr.lng + MAXSPAN / 2]);
      }
      const apply = (centers) => {
        const oldRisk = new Map(evacItems.map((c) => [c.id, c.risk]));
        evacItems = centers.map((c) => ({ ...c, risk: oldRisk.get(c.id) || null }));
        annotateDistances();
        drawEvac();
        if (!quiet) renderSheet();
        annotateTerrain(stale);
      };
      const res = await API.getEvacuationCenters(toBox(area), {
        signal: ctl.signal,
        online: fresh,
        onPartial: (centers) => { if (seq === evacSeq && !ctl.signal.aborted && !stale() && centers.length) { apply(centers); setEvacState('busy', 'Finding more sites…'); } },
      });
      if (seq !== evacSeq) return;                       // replaced by a newer search
      evacCtl = null;
      if (res.cancelled) { setEvacState('cancelled', 'Search cancelled.'); if (!quiet) renderSheet(); return; }
      if (stale()) { setEvacState('idle'); return; }
      trackData(res);
      if (!res.success) {
        loaded.evac = null;
        if (res.offline) { evacItems = []; drawEvac(); }   // do not leave another area's sites on the map
        setEvacState('failed', res.offline ? 'No signal and no saved sites in this view.' : 'Could not load evacuation sites. Check your signal.');
        if (!quiet) renderSheet();
        return;
      }
      if (res.backupOutside && !quiet && evacJump) {    // first look at this layer: go to the saved sites
        evacJump = false;
        const n0 = map.getCenter(), n = API.nearestBackupSite && API.nearestBackupSite(n0.lat, n0.lng);
        if (n) { map.setView([n.lat, n.lng], 14); return; }
      }
      evacJump = false;
      loaded.evac = res.centers.length ? area : null;   // an empty result is retried on the next move
      apply(res.centers);
      if (!res.centers.length) setEvacState('empty', res.backupOutside ? 'No saved evacuation sites in this view.' : 'No mapped evacuation sites in this area.');
      else if (res.backup && !res.primary) setEvacState('partial', 'Live search unavailable. Showing the built-in site list.');
      else if (res.partial) setEvacState('partial', 'Some results may be missing.');
      else setEvacState('idle');
    }

    async function loadResponders(force, stale) {
      const c = map.getCenter();
      if (!force && lastResp && API.distanceKm(lastResp, { lat: c.lat, lng: c.lng }) < 1.5) return;
      const res = await API.getNearbyResponders({ lat: c.lat, lng: c.lng, radiusKm: 4 });
      if (stale() || !res.success) return;
      lastResp = { lat: c.lat, lng: c.lng };
      groups.responders.clearLayers();
      res.responders.forEach((r) =>
        L.marker([r.lat, r.lng], { icon: responderIcon(r.kind), title: r.name }).bindPopup(placePopup(r), POPUP_OPTS).addTo(groups.responders));
    }

    /* ================= FLOOD ================= */
    async function loadWater(force, stale) {
      if (map.getZoom() < 13) return;
      const view = map.getBounds();
      if (!force && loaded.water && loaded.water.contains(view)) return;
      const area = view.pad(0.15);
      const res = await API.getWaterways(toBox(area));
      if (stale()) return;
      if (!res.success) { info(res.error, 'error'); return; }
      loaded.water = area;
      groups.water.clearLayers();
      res.ways.forEach((w) => {
        L.polyline(w.points, { color: '#2F80ED', weight: 16, opacity: 0.18, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(groups.water);
        const line = L.polyline(w.points, { color: '#1E63C8', weight: 3, opacity: 0.9 }).addTo(groups.water);
        if (w.name) line.bindTooltip(w.name, { sticky: true });
      });
    }

    /* ================= WEATHER / OUTLOOK ================= */
    function outlookPoint() {
      if (mode === 'weather' && user) return { lat: user.lat, lng: user.lng };
      const c = map.getCenter();
      return { lat: c.lat, lng: c.lng };
    }

    async function loadOutlook() {
      if (mode === 'weather') ensureRadar().then((ok) => { if (ok && mode === 'weather') renderSheet(); });
      const pt = outlookPoint();
      const fresh = outlook && API.distanceKm(outlook.at, pt) < 6 && Date.now() - outlook.time < 10 * 60 * 1000;
      if (fresh || outlookBusy) return;
      outlookBusy = true;
      info('Checking the forecast\u2026', 'busy');
      try {
        let [w, riv] = await Promise.all([API.getWeatherOutlook(pt), API.getRiverOutlook(pt)]);
        trackData(w);
        if (demo) { w = demoOutlook(w); riv = { success: false }; }
        if (!w.success) { info(w.error, 'error'); return; }
        info('');
        outlook = { at: pt, time: Date.now(), weather: w, river: riv.success ? riv : null };
      } finally { outlookBusy = false; }
      renderSheet();
      // the map may have moved while we waited
      if (API.distanceKm(outlook.at, outlookPoint()) >= 6) run(false);
    }

    async function ensureRadar() {
      if (radar.frames.length && extras.radar) return true;
      const r = await API.getRadarTiles();
      if (!r.success) return false;
      radar.frames = r.frames || [{ time: r.time, url: r.urlTemplate }];
      radar.idx = radar.frames.length - 1;
      radar.cloudTime = r.cloudTime;
      const credit = 'Radar &copy; <a href="https://www.rainviewer.com" target="_blank" rel="noopener">RainViewer</a>';
      extras.radar = L.tileLayer(radar.frames[radar.idx].url, { opacity: 0.62, zIndex: 7, maxNativeZoom: 7, maxZoom: 19, attribution: credit });
      if (r.cloudUrl) extras.clouds = L.tileLayer(r.cloudUrl, { opacity: 0.6, zIndex: 7, maxNativeZoom: 7, maxZoom: 19, attribution: credit });
      applyLayers();
      return true;
    }

    function showRadarFrame(i) {
      if (!extras.radar || !radar.frames.length) return;
      radar.idx = (i + radar.frames.length) % radar.frames.length;
      extras.radar.setUrl(radar.frames[radar.idx].url);
      const t = sheet.querySelector('.bm-radar-time');
      if (t) t.textContent = radarLabel();
    }
    function radarLabel() {
      const f = radar.frames[radar.idx];
      if (!f) return 'Radar unavailable';
      const mins = Math.round((Date.now() / 1000 - f.time) / 60);
      return `${new Date(f.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${mins <= 1 ? 'now' : mins + ' min ago'}`;
    }
    function stopRadar() {
      clearInterval(radar.timer);
      radar.timer = null;
      radar.playing = false;
    }
    function toggleRadar() {
      if (radar.playing) { stopRadar(); renderSheet(); return; }
      if (!radar.frames.length) return;
      radar.playing = true;
      radar.timer = setInterval(() => showRadarFrame(radar.idx + 1), 650);
      renderSheet();
    }

    function weatherSheet() {
      const w = outlook && outlook.weather;
      const where = user ? 'Where you are' : 'Map center';
      if (!w) {
        setSheet('<span class="bm-title">Weather</span>', '<p class="bm-empty">Loading the forecast…</p>');
        return;
      }
      const maxMm = Math.max(2, ...w.hourly.map((h) => h.mm));
      const bars = w.hourly.map((h, i) =>
        `<i style="height:${Math.max(2, Math.round((h.mm / maxMm) * 34))}px" class="${h.mm >= 7.5 ? 'hv' : h.mm >= 2.5 ? 'md' : ''}" title="+${i}h: ${h.mm} mm, ${h.p}% chance"></i>`).join('');
      const days = w.days.map((d, i) => `
        <li><b>${dayName(d.date, i)}</b><span>${d.hi}°/${d.lo}°</span><em>${d.rainMm} mm</em></li>`).join('');
      const head = `<span class="bm-title"><i class="bm-dot weather"></i>${where}: <b>${w.tempC}°C</b> · ${esc(w.summary)}</span>
        <span class="bm-sub">Feels ${w.feelsC}° · humidity ${w.humidity}%</span>`;
      const body = `
        <div class="bm-stats">
          <div><small>Rain, next 24 h</small><b>${w.next24} mm</b>${badge(w.flood.level, w.rateLabel === 'None' ? 'Dry spell' : w.rateLabel + ' rain')}</div>
          <div><small>Wind / gusts</small><b>${w.windKmh} km/h</b><span>gusts ${w.gustKmh}</span></div>
          <div><small>Chance of rain</small><b>${w.maxProb}%</b><span>next 24 h</span></div>
        </div>
        <div class="bm-radar">
          <button type="button" class="bm-btn bm-btn-green" data-act="radar">${radar.playing ? 'Pause' : 'Play'} rain radar</button>
          <span class="bm-radar-time">${radar.frames.length ? radarLabel() : 'Radar unavailable'}</span>
        </div>
        <div class="bm-ramp"><span>Light</span><i></i><span>Heavy</span></div>
        <div class="bm-hours" aria-label="Rain for the next 24 hours">${bars}</div>
        <div class="bm-hours-axis"><span>Now</span><span>+12 h</span><span>+24 h</span></div>
        <ul class="bm-days">${days}</ul>
        <p class="bm-foot">Forecast by Open-Meteo. For official warnings see <a href="https://www.pagasa.dost.gov.ph" target="_blank" rel="noopener">PAGASA</a>.</p>`;
      setSheet(head, body);
    }

    function hazardActions() {
      return `<div class="bm-actions">
        <button type="button" class="bm-btn bm-btn-green" data-act="goto" data-m="evacuation">Evacuation sites</button>
        <button type="button" class="bm-btn" data-act="goto" data-m="route">Route to safety</button>
      </div>`;
    }

    function floodSheet() {
      const w = outlook && outlook.weather;
      const riv = outlook && outlook.river;
      const lv = w ? Math.max(w.flood.level, riv ? riv.level : 0) : 0;
      const { risk, live: liveOn } = floodShow;
      const bits = [];
      if (w) {
        if (liveOn) bits.push(esc(liveFloodSummary()));
        bits.push(`${w.next24} mm rain expected`);
        if (riv) bits.push(`rivers ${riv.ratio}× normal`);
      }
      const head = `<span class="bm-title"><i class="bm-dot flood"></i>Flood ${w ? badge(lv) : ''}</span>
        <span class="bm-sub">${w ? bits.join(' · ') : 'Checking the forecast…'}</span>`;
      const toggles = `<div class="bm-chips bm-toggles" role="group" aria-label="Flood layers">
        <button type="button" class="bm-chip bm-tog ${risk ? 'is-on' : ''}" data-act="floodopt" data-k="risk" aria-pressed="${risk}"><i></i>Flood risk map</button>
        <button type="button" class="bm-chip bm-tog ${liveOn ? 'is-on' : ''}" data-act="floodopt" data-k="live" aria-pressed="${liveOn}"><i></i>Live flooding</button></div>`;
      const legend = [];
      if (risk) {
        legend.push(`<div class="bm-legend-title">Flood risk: ground height above sea level</div>
        <ul class="bm-steps">
          <li><i style="background:rgba(8,48,107,.75)"></i>Under 3 m</li>
          <li><i style="background:rgba(33,113,181,.7)"></i>3–6 m</li>
          <li><i style="background:rgba(66,146,198,.6)"></i>6–10 m</li>
          <li><i style="background:rgba(158,202,225,.55)"></i>10–20 m</li>
          <li><i class="bm-line-blue"></i>Waterway</li>
        </ul>`);
      }
      if (liveOn) {
        legend.push(`<div class="bm-legend-title">Live flooding (ground under 3 m)</div>
        <ul class="bm-steps">
          <li><i style="background:rgb(0,214,255)"></i>Flooded now</li>
          <li><i class="bm-lg-gauge">cm</i>Live gauge</li>
        </ul>
        <p class="bm-explain">${map.getZoom() < 12 ? 'Zoom in to see live gauges. ' : ''}${extras.floodlive.waterLevel > 0 ? 'Water is expected to collect on the lowest ground.' : 'No flooding is expected at the moment.'}</p>`);
      }
      if (!risk && !liveOn) legend.push('<p class="bm-explain">Turn on the flood risk map, live flooding, or both.</p>');
      const body = `${toggles}${legend.join('')}
        ${hazardActions()}
        <p class="bm-foot">Live levels are simulated from terrain height and the forecast, not real gauge readings, and not an official flood map. See <a href="https://noah.up.edu.ph" target="_blank" rel="noopener">Project NOAH</a> and <a href="https://hazardhunter.georisk.gov.ph" target="_blank" rel="noopener">HazardHunterPH</a>.</p>`;
      setSheet(head, body);
    }

    async function loadTyphoon() {
      const c = map.getCenter();
      const pt = user ? { lat: user.lat, lng: user.lng } : { lat: c.lat, lng: c.lng };
      const fresh = typhoon && API.distanceKm(typhoon.at, pt) < 6 && Date.now() - typhoon.time < 10 * 60 * 1000;
      if (fresh || typhoonBusy) return;
      typhoonBusy = true;
      info('Checking the wind forecast\u2026', 'busy');
      try {
        let d = await API.getTyphoonOutlook(pt);
        trackData(d);
        if (demo) d = demoTyphoon(d);
        if (!d.success) { info(d.error, 'error'); return; }
        info('');
        typhoon = { at: pt, time: Date.now(), data: d };
      } finally { typhoonBusy = false; }
    }

    async function loadSurgeHere() {
      if (!user) { surgeHere = null; return; }
      const t = await terrainAt(L.latLng(user.lat, user.lng));
      surgeHere = t ? { elev: t.elev } : null;
    }

    function setSurgeHeight(h) {
      if (!(h > 0)) return;
      surgeH = h;
      extras.surge.waterLevel = h;
      if (map.hasLayer(extras.surge)) extras.surge.redraw();
      renderSheet();
    }

    function surgeSheet() {
      const man = manualSignal();
      const ty = typhoon && typhoon.data;
      const level = man ? man.level : ty ? ty.level : null;
      const sub = man ? `Official signal you entered \u00b7 ${esc(agoText(man.time))}`
        : ty ? (ty.stale ? `Offline: saved forecast from ${esc(agoText(ty.updatedAt))}` : ty.level > 0 ? `Estimated from forecast winds up to ${ty.maxWind} km/h` : 'No signal-level winds forecast in 48 h')
        : 'Checking the wind forecast\u2026';
      const head = `<span class="bm-title"><i class="bm-dot flood"></i>Storm surge &amp; typhoon ${level == null ? '' : tcwsPill(level)}</span>
        <span class="bm-sub">${sub}</span>`;

      const tc = API.TCWS;
      const row = [0, 1, 2, 3, 4, 5].map((k) => {
        const on = (man ? man.level : 0) === k;
        return `<button type="button" class="bm-chip bm-tog ${on ? 'is-on' : ''}" data-act="tcws" data-k="${k}" aria-pressed="${on}">${k === 0 ? 'None' : 'No. ' + k}</button>`;
      }).join('');
      let est = '<p class="bm-explain">Checking the wind forecast\u2026</p>';
      if (ty) {
        const info1 = tc.find((x) => x.level === ty.level);
        est = ty.level > 0
          ? `<p class="bm-explain"><b>Forecast estimate:</b> ${tcwsPill(ty.level)} ${esc(info1.name)} (${esc(info1.range)}). ${esc(info1.threat)}.
              Winds up to ${ty.maxWind} km/h, gusts ${ty.maxGust} km/h, strongest ${ty.peakInH < 1 ? 'now' : 'in about ' + ty.peakInH + ' h'}${ty.minPressure ? ` \u00b7 lowest pressure ${ty.minPressure} hPa` : ''}.${ty.demo ? ' <b>DEMO values.</b>' : ''}</p>`
          : `<p class="bm-explain"><b>Forecast estimate:</b> no wind signal expected in the next 48 h (strongest wind ${ty.maxWind} km/h).</p>`;
      }
      const staleNote = ty && ty.stale ? `<p class="bm-explain bm-advice"><b>No signal.</b> This forecast was saved ${esc(agoText(ty.updatedAt))} and may be out of date. Check PAGASA or your barangay for the latest signal.</p>` : '';
      const advice = level == null ? '' : `<p class="bm-explain bm-advice">${esc(TCWS_ACTION[level])}</p>`;
      const signal = `<div class="bm-legend-title">Typhoon wind signal</div>
        <p class="bm-explain">Official signal from PAGASA (tap the one announced for your area):</p>
        <div class="bm-chips bm-toggles" role="group" aria-label="Official PAGASA signal">${row}</div>
        ${est}${staleNote}${advice}`;

      const heights = [1, 2, 3, 4, 5].map((h) =>
        `<button type="button" class="bm-chip bm-tog ${surgeH === h ? 'is-on' : ''}" data-act="surgeh" data-h="${h}" aria-pressed="${surgeH === h}">${h} m</button>`).join('');
      let here = '<p class="bm-explain">Turn on location to check your own spot.</p>';
      if (surgeHere) {
        const e = surgeHere.elev, d = Math.round((surgeH - e) * 10) / 10;
        here = e < surgeH
          ? `<p class="bm-explain bm-advice"><b>Your location is about ${e} m above sea level.</b> At a ${surgeH} m surge it would be under about ${d} m of water. Move to higher ground early.</p>`
          : `<p class="bm-explain"><b>Your location is about ${e} m above sea level</b>, higher than a ${surgeH} m surge. Waves, tides and rivers can still flood nearby low ground.</p>`;
      }
      const surge = `<div class="bm-legend-title">Storm surge scenario: sea rise above normal tide</div>
        <div class="bm-chips bm-toggles" role="group" aria-label="Storm surge height">${heights}</div>
        <ul class="bm-steps">
          <li><i style="background:rgba(120,215,250,.7)"></i>Under 0.5 m deep</li>
          <li><i style="background:rgba(40,160,240,.75)"></i>0.5\u20131.5 m</li>
          <li><i style="background:rgba(30,90,220,.8)"></i>1.5\u20133 m</li>
          <li><i style="background:rgba(10,30,120,.85)"></i>Over 3 m</li>
        </ul>
        <p class="bm-explain">Shaded ground is lower than ${surgeH} m. Use the height in the PAGASA storm surge warning for your coast. For scale, Typhoon Haiyan (Yolanda, 2013) pushed surges of several metres onto Leyte Gulf coasts.${map.getZoom() < 9 ? ' <b>Zoom in to see the shading.</b>' : ''}</p>
        ${here}`;

      const body = `${signal}${surge}${hazardActions()}
        <p class="bm-foot">Surge shading uses ground height only. It ignores waves, tides, rivers and sea walls, and low spots far from the sea may stay dry. Signal estimates come from a weather model that often under-reads typhoons, so they are not official. Follow <a href="https://www.pagasa.dost.gov.ph" target="_blank" rel="noopener">PAGASA</a> and your local DRRMO.</p>`;
      setSheet(head, body);
    }

    function landslideSheet() {
      const w = outlook && outlook.weather;
      const head = `<span class="bm-title"><i class="bm-dot slide"></i>Landslide risk ${w ? badge(w.landslide.level, w.landslide.label + ' rain trigger') : ''}</span>
        <span class="bm-sub">${w ? `${live.slides.length ? live.slides.length + ' live reports' : 'No live reports'} \u00b7 ${w.past72} mm in 3 days \u00b7 ${w.next24} mm ahead` : 'Checking the forecast\u2026'}</span>`;
      const body = `
        <div class="bm-legend-title">Slope steepness</div>
        <ul class="bm-steps">
          <li><i style="background:rgba(250,204,21,.75)"></i>5–12°</li>
          <li><i style="background:rgba(249,115,22,.8)"></i>12–20°</li>
          <li><i style="background:rgba(220,38,38,.85)"></i>20–30°</li>
          <li><i style="background:rgba(127,29,29,.95)"></i>Over 30\u00b0</li>
          <li><i class="bm-lg-slide"></i>Live report</li>
        </ul>
        <p class="bm-explain">${w && w.landslide.level >= 2
          ? 'Heavy rain on wet slopes can trigger landslides. If you live on or below a red slope, be ready to move.'
          : 'Red and dark red slopes are the ones to watch when it rains hard. Flat ground is not shaded.'}</p>
        ${hazardActions()}
        <p class="bm-foot">Live reports are simulated from steep slopes and the rain trigger, not real reports. Not an official MGB map. See <a href="https://hazardhunter.georisk.gov.ph" target="_blank" rel="noopener">HazardHunterPH</a>.</p>`;
      setSheet(head, body);
    }

    function topoSheet() {
      setSheet('<span class="bm-title"><i class="bm-dot topo"></i>Topography</span><span class="bm-sub">Contour lines and shaded relief</span>',
        `<p class="bm-explain">Tap anywhere to see its elevation and slope. Tightly packed contour lines mean steep ground.</p>
         ${hazardActions()}`);
    }

    /* ================= ROUTE ================= */
    function routeSheet() {
      const ab = abBlock();
      const profBtns = `<div class="bm-seg" role="group" aria-label="Travel mode">
          <button type="button" data-act="profile" data-p="foot" class="${routeProfile === 'foot' ? 'is-on' : ''}">Walk</button>
          <button type="button" data-act="profile" data-p="driving" class="${routeProfile === 'driving' ? 'is-on' : ''}">Drive</button></div>`;
      if (!route || !route.routes) {
        setSheet('<span class="bm-title"><i class="bm-dot route"></i>Route to safety</span>',
          `${ab}${profBtns}<p class="bm-empty">${route && route.error ? esc(route.error) : 'Finding the best way to a nearby evacuation site…'}</p>`);
        return;
      }
      const r = route.routes[route.sel];
      const alts = route.routes.length > 1 ? `<div class="bm-chips">${route.routes.map((x, i) =>
        `<button type="button" class="bm-chip ${i === route.sel ? 'is-on' : ''}" data-act="alt" data-i="${i}">Route ${i + 1} <em>${x.durationMin} min</em></button>`).join('')}</div>` : '';
      const hz = route.hazard ? `<p class="bm-risk r${route.hazard.lv}">${esc(route.hazard.text)}</p>` : '';
      const steps = r.steps && r.steps.length
        ? `<details class="bm-steps-list"><summary>Directions (${r.steps.length} steps)</summary><ol>${r.steps.map((s) =>
          `<li>${esc(s.text)}${s.distM ? `<em>${s.distM >= 1000 ? (s.distM / 1000).toFixed(1) + ' km' : s.distM + ' m'}</em>` : ''}</li>`).join('')}</ol></details>` : '';
      const head = `<span class="bm-title"><i class="bm-dot route"></i>${esc(route.dest.name)}</span>
        <span class="bm-sub"><b>${r.durationMin} min</b> · ${r.distanceKm} km ${route.profile === 'foot' ? 'on foot' : 'by road'}</span>`;
      const body = `${ab}${profBtns}${alts}
        ${route.auto ? `<p class="bm-explain">${esc(route.auto)}</p>` : ''}
        ${route.fromGuess ? '<p class="bm-risk r1">Location is off, so this starts from the map center. Tap ◎ to start from where you are.</p>' : ''}
        ${hz}${steps}
        <div class="bm-actions"><button type="button" class="bm-btn" data-act="goto" data-m="evacuation">Other sites</button>
        <button type="button" class="bm-btn bm-btn-green" data-act="recenter">Show route</button></div>
        <p class="bm-foot">Routes follow mapped roads. Floodwater, closures and damage are not shown, so follow local officials’ instructions.</p>`;
      setSheet(head, body);
    }

    async function routeHazard(points) {
      const n = Math.min(32, points.length);
      const pts = [];
      for (let i = 0; i < n; i++) { const p = points[Math.round((i * (points.length - 1)) / Math.max(1, n - 1))]; pts.push({ lat: p[0], lng: p[1] }); }
      const t = (await Promise.all(pts.map(terrainAt))).filter(Boolean);
      if (t.length < 5) return null;
      const low = t.filter((x) => x.elev <= 5).length / t.length;
      const steep = t.filter((x) => x.slope >= 20).length / t.length;
      if (low > 0.3) return { lv: 2, text: `About ${Math.round(low * 100)}% of this route is low ground (under 5 m). It may flood in heavy rain, so avoid it once water rises.` };
      if (low > 0.05) return { lv: 1, text: `Part of the route (~${Math.round(low * 100)}%) crosses low ground that can flood.` };
      if (steep > 0.15) return { lv: 1, text: 'Part of the route runs over steep ground. Watch for landslides in heavy rain.' };
      return { lv: 0, text: 'The route stays on higher ground (above 5 m).' };
    }

    function drawRoute() {
      groups.route.clearLayers();
      if (!route || !route.routes) return;
      route.routes.forEach((r, i) => {
        if (i === route.sel) return;
        const casing = L.polyline(r.points, { color: '#fff', weight: 9, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }).addTo(groups.route);
        const line = L.polyline(r.points, { color: '#8A8D93', weight: 5, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(groups.route);
        [casing, line].forEach((l) => l.on('click', () => selectAlt(i)));
      });
      const r = route.routes[route.sel];
      L.polyline(r.points, { color: '#fff', weight: 11, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(groups.route);
      L.polyline(r.points, { color: '#E5342E', weight: 6, lineCap: 'round', lineJoin: 'round' }).addTo(groups.route);
      if (routeFromPt) L.marker([route.from.lat, route.from.lng], { icon: abIcon('A'), zIndexOffset: 700, title: 'Start (A)' }).addTo(groups.route);
      else L.circleMarker([route.from.lat, route.from.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2F80ED', fillOpacity: 1 }).bindTooltip(route.fromGuess ? 'Start (map center)' : 'You', { direction: 'top' }).addTo(groups.route);
      const c = route.dest;
      if (c.custom) { L.marker([c.lat, c.lng], { icon: abIcon('B'), zIndexOffset: 800, title: c.name }).addTo(groups.route); return; }
      const full = evacItems.find((x) => x.id === c.id) || c;
      L.marker([c.lat, c.lng], { icon: evacIcon({ kind: full.kind || 'assembly', name: c.name, risk: full.risk }, { selected: true }), title: c.name, zIndexOffset: 800 })
        .bindPopup(() => sitePopup({ ...full, ...c }), POPUP_OPTS).addTo(groups.route);
    }

    function selectAlt(i) {
      if (!route || !route.routes || !route.routes[i]) return;
      route.sel = i;
      route.hazard = null;
      drawRoute();
      renderSheet();
      routeHazard(route.routes[i].points).then((h) => { if (route && route.sel === i) { route.hazard = h; renderSheet(); } });
    }

    function pickSafeSite(from) {
      const sorted = evacItems.map((c) => ({ c, d: API.distanceKm(from, c) })).sort((a, b) => a.d - b.d);
      const first = sorted[0] && sorted[0].c;
      const pool = sorted.slice(0, 6).map((x) => x.c);
      const safer = pool.find((c) => c.risk && c.risk.known && c.risk.flood <= 1 && c.risk.slide <= 1);
      const dest = safer || first;
      const auto = dest && first && dest.id !== first.id ? 'The closest site is on low or steep ground, so this goes to a safer one nearby.' : '';
      return { dest, auto };
    }

    async function loadRoute(dest, stale) {
      let from = routeFromPt || user || API.getSavedLocation();
      let fromGuess = false;
      if (!from) {
        info('Finding your location…', 'busy');
        try { from = await startTracking(); } catch (e) { from = null; }
        if (stale && stale()) return;
        info('');
      }
      if (!from) {
        const c = map.getCenter();
        from = { lat: c.lat, lng: c.lng };
        fromGuess = true;
      }
      let auto = '';
      if (!dest) {
        if (!evacItems.length) { route = { error: 'No evacuation sites found nearby yet. Pan around and try again.' }; renderSheet(); return; }
        ({ dest, auto } = pickSafeSite(from));
      }
      pendingDest = null;
      route = { dest, from, fromGuess, auto, profile: routeProfile, routes: null, sel: 0, hazard: null };
      renderSheet();
      info('Finding the best road…', 'busy');
      let res = await API.getRoute({ from, to: dest, profile: routeProfile });
      if (!res.success && routeProfile === 'foot') res = await API.getRoute({ from, to: dest, profile: 'driving' });
      if (stale && stale()) return;
      if (!res.success) { info(''); route = { error: res.error }; renderSheet(); return; }
      info('');
      route.routes = res.routes;
      route.profile = res.profile;
      pendingDest = null;
      drawRoute();
      renderSheet();
      map.fitBounds(L.latLngBounds(res.routes[0].points).pad(0.15), { paddingTopLeft: [0, 56], paddingBottomRight: [0, sheetPad() + 28] });
      routeHazard(res.routes[0].points).then((h) => { if (route && route.routes === res.routes) { route.hazard = h; renderSheet(); } });
    }

    function feedItems() {
      const ref = refPoint();
      const items = incidents.map((i) => ({ ...i, kind: 'report' }));
      if (mode !== 'reports') {   // the Reports list matches the map: reports only
        live.gauges.filter((g) => g.depth > 0).forEach((g) => items.push({ ...g, desc: `${g.depth} cm of water on ground ${g.elev} m (${g.trend.toLowerCase()})`, title: 'Flood gauge: ' + g.label }));
        live.slides.forEach((r) => items.push({ ...r }));
      }
      items.forEach((i) => { i.distKm = API.distanceKm(ref, i); });
      return items.sort((a, b) => a.distKm - b.distKm);
    }

    function reportsSheet() {
      const all = feedItems();
      const test = {
        all: () => true, mine: (i) => i.source === 'mine', Flood: (i) => i.type === 'Flood', Landslide: (i) => i.type === 'Landslide',
        other: (i) => i.type !== 'Flood' && i.type !== 'Landslide',
      };
      const n = (k) => all.filter(test[k]).length;
      const list = all.filter(test[repFilter] || test.all);
      const chips = [['all', 'All'], ['mine', 'My reports'], ['Flood', 'Flood'], ['Landslide', 'Landslide'], ['other', 'Other']]
        .map(([k, t]) => `<button type="button" class="bm-chip ${repFilter === k ? 'is-on' : ''}" data-act="repfilter" data-k="${k}">${t} <em>${n(k)}</em></button>`).join('');
      const srcTag = { mine: 'You', community: 'Community', simulated: 'Simulated' };
      const cards = list.slice(0, 50).map((i) => {
        const c = REPORT_COLORS[typeOf(i.type)];
        return `<article class="bm-card" data-act="item" data-id="${esc(i.id)}" tabindex="0" role="button" aria-label="${esc(i.title || i.type)}">
          <div class="bm-card-top"><span class="bm-kind" style="background:${c}22;color:${c}">${esc(typeOf(i.type))}</span><span class="bm-tag bm-tag-${i.source}">${srcTag[i.source] || ''}</span></div>
          <h4>${esc(i.title || i.type)}</h4>
          <p class="bm-card-meta">${fmtKm(i.distKm)} away \u00b7 ${ago(i.time)}</p>
          ${i.desc ? `<p class="bm-card-desc">${esc(i.desc)}</p>` : ''}
          ${i.kind === 'report' && o.onOpenReport ? `<button type="button" class="bm-card-go" data-act="openreport" data-id="${esc(i.id)}">Open report</button>` : ''}
        </article>`;
      }).join('');
      const head = `<span class="bm-title"><i class="bm-dot rep"></i>Reports &amp; emergencies <b>${all.length}</b></span>
        <span class="bm-sub">Yours and the community's reports</span>`;
      setSheet(head, `<div class="bm-chips">${chips}</div>
        <div class="bm-scroll">${cards || '<p class="bm-empty">Nothing reported in this view. Pan around or zoom out.</p>'}</div>
        `);
    }

    function focusItem(id) {
      const m = itemMarkers.get(id);
      if (!m) return;
      touched = true;
      const z = Math.max(map.getZoom(), 16);
      map.flyTo(aim(m.getLatLng(), z), z, { duration: 0.6 });
      map.once('moveend', () => m.openPopup());
    }

    function renderSheet() {
      paintEvacBar();
      if (mode === 'reports') { reportsSheet(); return; }
      if (mode === 'evacuation') evacSheet();
      else if (mode === 'route') routeSheet();
      else if (mode === 'weather') weatherSheet();
      else if (mode === 'flood') floodSheet();
      else if (mode === 'surge') surgeSheet();
      else if (mode === 'landslide') landslideSheet();
      else if (mode === 'none' && baseName === 'topo') topoSheet();
      else hideSheet();
    }

    async function run(force) {
      if (!map.getSize().x) return;          // hidden tab: nothing to load yet
      const id = ++runId;
      const stale = () => id !== runId;
      if (mode === 'evacuation') {
        await Promise.all([loadEvac(force, stale), loadResponders(force, stale)]);
      } else if (mode === 'route') {
        if (route && route.routes && !pendingDest && !force) return;
        if (!pendingDest) await loadEvac(force, stale);
        if (!stale() && (force || pendingDest || !route)) await loadRoute(pendingDest, stale);
      } else if (mode === 'flood') {
        await Promise.all([loadWater(force, stale), loadLive(stale)]);
      } else if (mode === 'landslide') {
        await loadLive(stale);
      } else if (mode === 'surge') {
        extras.surge.waterLevel = surgeH;
        await Promise.all([loadTyphoon(), loadSurgeHere()]);
        if (!stale()) renderSheet();
      } else if (mode === 'reports') {
        // Reports shows only reports: drop any flood meters / simulated pins left from another layer
        if (live.gauges.length || live.slides.length) { live = { gauges: [], slides: [], sig: '' }; drawLive(); }
        renderSheet();
      } else if (mode === 'weather') {
        await loadOutlook();
      }
      if (GRID_OVL.includes(ovl)) loadWxGrid(false);
      if (!stale() && revealPending && mode !== 'route') {
        revealPending = false;
        revealPoint(mode === 'evacuation' ? refPoint() : user ? L.latLng(user.lat, user.lng) : map.getCenter());
      }
    }

    const refresh = debounce(() => run(false), 450);
    map.on('moveend', refresh);
    map.on('resize', refresh);
    let wasClose = map.getZoom() >= 14;
    map.on('zoomend', () => {
      const close = map.getZoom() >= 14;
      el.classList.toggle('bm-labels', close);
      if (close !== wasClose && (mode === 'evacuation' || mode === 'route')) drawEvac();
      wasClose = close;
    });

    /* ---- sheet buttons ---- */
    sheet.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (!t || !sheet.contains(t)) return;
      const act = t.dataset.act;
      if (act === 'toggle') { sheetCollapsed = !sheetCollapsed; sheet.classList.toggle('is-collapsed', sheetCollapsed); t.setAttribute('aria-expanded', String(!sheetCollapsed)); }
      else if (act === 'filter') { evacFilter = t.dataset.k; drawEvac(); renderSheet(); }
      else if (act === 'fitall') fitAllSites();
      else if (act === 'surgeh') setSurgeHeight(+t.dataset.h);
      else if (act === 'tcws') { setManualSignal(+t.dataset.k); renderSheet(); }
      else if (act === 'floodopt') { floodShow[t.dataset.k] = !floodShow[t.dataset.k]; applyLayers(); renderSheet(); }
      else if (act === 'repfilter') { repFilter = t.dataset.k; renderSheet(); }
      else if (act === 'item') focusItem(t.dataset.id);
      else if (act === 'openreport') { e.stopPropagation(); if (o.onOpenReport) o.onOpenReport(t.dataset.id); }
      else if (act === 'site') focusSite(t.dataset.id);
      else if (act === 'route') {
        e.stopPropagation();
        const c = evacItems.find((x) => x.id === t.dataset.id);
        if (c) routeTo(c);
      }
      else if (act === 'goto') setMode(t.dataset.m);
      else if (act === 'pick') openPicker(t.dataset.p);
      else if (act === 'detail') openSiteDetail(t.dataset.id);
      else if (act === 'redoevac') redoEvac();
      else if (act === 'gobackup') gotoSaved();
      else if (act === 'cancelevac') cancelEvac();
      else if (act === 'swap') swapAB();
      else if (act === 'autob') { routeTo(null); }
      else if (act === 'profile') { routeProfile = t.dataset.p; if (route && route.dest) routeTo(route.dest, true); else { renderSheet(); } }
      else if (act === 'alt') selectAlt(+t.dataset.i);
      else if (act === 'radar') toggleRadar();
      else if (act === 'recenter' && route && route.routes) map.fitBounds(L.latLngBounds(route.routes[route.sel].points).pad(0.15), { paddingTopLeft: [0, 56], paddingBottomRight: [0, sheetPad() + 28] });
    });
    sheet.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.bm-card')) { e.preventDefault(); if (e.target.dataset.act === 'item') focusItem(e.target.dataset.id); else focusSite(e.target.dataset.id); }
    });

    /* ---- directions from any popup or card ---- */
    function routeTo(dest, keepMode) {
      pendingDest = dest;
      route = null;
      if (mode !== 'route') setMode('route');
      else run(true);
    }

    // Capture phase: Leaflet popups swallow bubbling clicks, and popup content is
    // swapped after address lookups, so a per-popup listener would be lost.
    el.addEventListener('click', (e) => {
      const dbtn = e.target.closest && e.target.closest('.bm-detail-btn');
      if (dbtn) { e.preventDefault(); map.closePopup(); openSiteDetail(dbtn.dataset.id); return; }
      const btn = e.target.closest && e.target.closest('.bm-route-btn');
      if (!btn) return;
      e.preventDefault();
      map.closePopup();
      if (btn.classList.contains('bm-report-btn')) { if (o.onOpenReport) o.onOpenReport(btn.dataset.id); return; }
      routeTo({ lat: +btn.dataset.lat, lng: +btn.dataset.lng, name: btn.dataset.name, id: btn.dataset.id || undefined });
    }, true);

    /* ---- evacuation site details panel ---- */
    const detailEl = document.createElement('section');
    detailEl.className = 'bm-detail';
    detailEl.hidden = true;
    detailEl.setAttribute('aria-label', 'Evacuation site details');
    host.appendChild(detailEl);
    L.DomEvent.disableClickPropagation(detailEl);
    L.DomEvent.disableScrollPropagation(detailEl);

    function openSiteDetail(id) {
      const c = evacItems.find((x) => x.id === id) || (route && route.dest && route.dest.id === id ? route.dest : null);
      if (!c) return;
      map.closePopup();
      detailId = id;
      selectedId = id;
      host.classList.add('is-picking');
      hideSheet();
      const info = KIND_INFO[c.kind] || KIND_INFO.shelter;
      const r = c.risk && c.risk.known ? c.risk : null;
      const lv = r ? Math.max(r.flood, r.slide) : 0;
      const status = c.official
        ? '<span class="bm-badge ok">Designated evacuation center</span>'
        : '<span class="bm-badge warn">Possible shelter. Not confirmed as an evacuation center</span>';
      const km = c.distKm != null ? c.distKm : null;
      const f = c.facilities || {};
      const fac = [
        ['Toilets', yn(f.toilets)], ['Drinking water', yn(f.water)], ['Backup power', yn(f.power)],
        ['Internet', yn(f.internet)], ['Showers', yn(f.shower)], ['Wheelchair access', yn(c.wheelchair)],
        ['Medical care', f.medical ? 'Yes' : null],
      ].map(([k, v]) => `<li class="${v === 'Yes' ? 'is-yes' : v === 'No' ? 'is-no' : v ? '' : 'is-unk'}"><span>${k}</span><b>${esc(v || 'Not listed')}</b></li>`).join('');
      const tel = c.phone ? c.phone.replace(/[^+\d]/g, '') : '';
      const contact = [
        c.address ? `<li><span>Address</span><b>${esc(c.address)}</b></li>` : '',
        c.hours ? `<li><span>Hours</span><b>${esc(c.hours)}</b></li>` : '',
        c.operator ? `<li><span>Run by</span><b>${esc(c.operator)}</b></li>` : '',
        c.access ? `<li><span>Access</span><b>${esc(c.access)}</b></li>` : '',
        c.levels ? `<li><span>Floors</span><b>${esc(c.levels)}</b></li>` : '',
        c.phone ? `<li><span>Phone</span><b><a href="tel:${esc(tel)}">${esc(c.phone)}</a></b></li>` : '',
        c.website ? `<li><span>Website</span><b><a href="${esc(c.website)}" target="_blank" rel="noopener noreferrer">${esc(c.website.replace(/^https?:\/\//, '').slice(0, 40))}</a></b></li>` : '',
      ].join('');
      detailEl.innerHTML = `
        <div class="bm-detail-head">
          <button type="button" class="bm-detail-back" data-dt="back" aria-label="Back to the map">←</button>
          <div><span class="bm-kind k-${c.kind}">${esc(c.label)}</span><h3>${esc(c.name)}</h3></div>
        </div>
        <div class="bm-detail-body">
          ${status}
          <div class="bm-stats">
            <div><b>${km != null ? fmtKm(km) : '--'}</b><span>${refIsUser() ? 'from you' : 'from map center'}</span></div>
            <div><b>${km != null ? '~' + walkMin(km) + ' min' : '--'}</b><span>on foot</span></div>
            <div><b>${c.capacity ? esc(c.capacity) : 'Not listed'}</b><span>capacity</span></div>
          </div>
          <h4>Is it safe from floods and slides?</h4>
          ${r ? `<div class="bm-pop-risk r${lv}">${esc(r.text)}</div>
            <p class="bm-d-note">${r.flood >= 2 ? 'Floodwater can reach this ground. Go here early, or choose a higher site nearby.' : r.slide >= 2 ? 'The slope here is steep. Avoid it during heavy rain and pick a flatter site.' : 'The ground around this site is higher and fairly flat, which is a good sign. Always follow your LGU’s advice.'}</p>`
            : '<p class="bm-d-note">Checking ground height…</p>'}
          <h4>About this place</h4>
          <p class="bm-d-note">${esc(info.about)}</p>
          <p class="bm-d-note"><b>What to expect:</b> ${esc(info.expect)}</p>
          ${c.note ? `<p class="bm-d-note"><b>Mapped note:</b> ${esc(c.note)}</p>` : ''}
          <h4>Facilities</h4>
          <ul class="bm-d-list bm-d-fac">${fac}</ul>
          ${contact ? `<h4>Contact and access</h4><ul class="bm-d-list">${contact}</ul>` : ''}
          <h4>What to bring</h4>
          <ul class="bm-d-bring">${BRING.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
          <p class="bm-d-src">${c.fromBackup ? 'From the built-in site list saved with the app, so it may be out of date. ' : ''}Source: OpenStreetMap volunteers. Details marked "Not listed" are unknown, not unavailable. Distance is a straight line. Call your barangay or LGU to confirm the site is open before you travel.</p>
        </div>
        <div class="bm-detail-actions">
          ${tel ? `<a class="bm-btn" href="tel:${esc(tel)}">Call</a>` : ''}
          <button type="button" class="bm-btn bm-btn-green" data-dt="route" data-id="${esc(c.id)}">Route here</button>
        </div>`;
      detailEl.hidden = false;
      detailEl.querySelector('.bm-detail-body').scrollTop = 0;
    }
    function closeDetail() {
      if (!detailId) return;
      detailId = null;
      detailEl.hidden = true;
      host.classList.remove('is-picking');
      renderSheet();
    }
    detailEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dt]');
      if (!b) return;
      if (b.dataset.dt === 'back') { const id = detailId; closeDetail(); if (id) focusSite(id); }
      else if (b.dataset.dt === 'route') { const id = b.dataset.id; closeDetail(); const c = evacItems.find((x) => x.id === id); if (c) routeTo({ lat: c.lat, lng: c.lng, name: c.name, id: c.id }); }
    });

    /* ---- place picker: edit my location, or choose point A / B of a route ---- */
    const abIcon = (letter) => L.divIcon({ className: 'bm-pin-wrap', html: `<span class="bm-ab-pin ${letter === 'A' ? 'a' : 'b'}">${letter}</span>`, iconSize: [30, 38], iconAnchor: [15, 36] });
    const pickLayer = L.layerGroup().addTo(map);
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'map-round-btn map-editloc-btn';
    editBtn.setAttribute('aria-label', 'Edit my location');
    editBtn.title = 'Edit my location';
    editBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 18s5.5-5.1 5.5-9.2A5.5 5.5 0 0 0 4.5 8.8C4.5 12.9 10 18 10 18Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 8.6l1.4 1.4 2.6-2.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    host.appendChild(editBtn);
    editBtn.addEventListener('click', () => openPicker('me'));

    const pickEl = document.createElement('section');
    pickEl.className = 'bm-pick';
    pickEl.hidden = true;
    pickEl.setAttribute('aria-label', 'Choose a place');
    host.appendChild(pickEl);
    L.DomEvent.disableClickPropagation(pickEl);
    L.DomEvent.disableScrollPropagation(pickEl);
    const PICK_TITLE = { me: 'Set my location', A: 'Start point (A)', B: 'Destination (B)' };

    function openPicker(purpose) {
      if (pick) closePicker();
      let start;
      if (purpose === 'me') start = refPoint();
      else if (purpose === 'A') start = routeFromPt || (route && route.from) || refPoint();
      else start = (route && route.dest) || map.getCenter();
      map.closePopup();
      keep.pin.clearLayers();
      pick = { purpose, ll: null, name: '' };
      host.classList.add('is-picking');
      hideSheet();
      const gpsBtn = purpose !== 'B' ? `<button type="button" class="bm-btn" data-pk="gps">Use GPS</button>` : '';
      const autoBtn = purpose === 'B' ? `<button type="button" class="bm-btn" data-pk="auto">Safest nearby site</button>` : '';
      pickEl.innerHTML = `<div class="bm-pick-head"><b>${PICK_TITLE[purpose]}</b><button type="button" class="bm-pick-x" data-pk="cancel" aria-label="Cancel">×</button></div>
        <form class="bm-pick-search" autocomplete="off"><input type="search" placeholder="Search a place or address" aria-label="Search a place"><button type="submit" class="bm-btn">Search</button></form>
        <ul class="bm-pick-results" hidden></ul>
        <p class="bm-pick-hint"><span class="bm-pick-addr">Tap the map or drag the pin.</span></p>
        <div class="bm-pick-actions">${gpsBtn}${autoBtn}<button type="button" class="bm-btn bm-btn-green" data-pk="ok">Set here</button></div>`;
      pickEl.hidden = false;
      setPick(L.latLng(start.lat, start.lng), '', true);
      map.setView(aim(pick.ll, Math.max(map.getZoom(), 15)), Math.max(map.getZoom(), 15), { animate: false });
    }

    let pickTok = 0;
    function setPick(ll, name, quiet) {
      if (!pick) return;
      pick.ll = L.latLng(ll.lat, ll.lng);
      pick.name = name || '';
      if (!pick.marker) {
        pick.marker = L.marker(pick.ll, { icon: pick.purpose === 'me' ? ICONS.dropped : abIcon(pick.purpose), draggable: true, zIndexOffset: 2000 }).addTo(pickLayer);
        pick.marker.on('dragend', () => setPick(pick.marker.getLatLng()));
      } else pick.marker.setLatLng(pick.ll);
      const addr = pickEl.querySelector('.bm-pick-addr');
      if (name) { addr.textContent = name; return; }
      addr.textContent = quiet ? 'Tap the map or drag the pin.' : 'Looking up address…';
      if (quiet) return;
      const tok = ++pickTok;
      API.reverseGeocode({ lat: ll.lat, lng: ll.lng }).then((rev) => {
        if (!pick || tok !== pickTok) return;
        pick.name = rev.success ? rev.display.split(',').slice(0, 3).join(',') : '';
        addr.textContent = pick.name || 'Pin placed. Drag it to fine-tune.';
      });
    }

    function closePicker() {
      if (!pick) return;
      pick = null;
      pickLayer.clearLayers();
      pickEl.hidden = true;
      host.classList.remove('is-picking');
      renderSheet();
    }

    function confirmPick() {
      if (!pick || !pick.ll) return;
      const { purpose, ll } = pick;
      const name = pick.name ? pick.name.split(',')[0] : (purpose === 'B' ? 'Chosen destination' : 'Chosen point');
      closePicker();
      touched = true;
      if (purpose === 'me') {
        setManualPosition({ lat: ll.lat, lng: ll.lng });
        map.setView(aim(ll, Math.max(map.getZoom(), 16)), Math.max(map.getZoom(), 16), { animate: false });
        info('Your location is set by hand. Tap the pin button and choose Use GPS to go back to automatic.', 'warn');
        setTimeout(() => info(''), 5000);
        if (mode === 'weather') loadOutlook(); else if (mode === 'route' && route && route.dest && !routeFromPt) routeTo(route.dest, true); else run(false);
      } else if (purpose === 'A') {
        routeFromPt = { lat: ll.lat, lng: ll.lng, name };
        if (mode === 'route') routeTo(route && route.dest && !route.dest.auto ? route.dest : null, true); else { pendingDest = null; setMode('route'); }
      } else {
        routeTo({ lat: ll.lat, lng: ll.lng, name, custom: true });
      }
    }

    pickEl.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-pk]');
      if (!b) return;
      const k = b.dataset.pk;
      if (k === 'cancel') closePicker();
      else if (k === 'ok') confirmPick();
      else if (k === 'auto') { closePicker(); routeTo(null); }
      else if (k === 'gps') {
        const purpose = pick && pick.purpose;
        if (purpose === 'A') { routeFromPt = null; closePicker(); routeTo(route && route.dest && !route.dest.auto ? route.dest : null, true); return; }
        closePicker();
        info('Finding your location…', 'busy');
        try { const u = await useGps(); touched = true; map.setView(aim([u.lat, u.lng], 16), 16, { animate: false }); info(''); if (mode === 'weather') loadOutlook(); else run(false); }
        catch (err) { info(geoErrorText(err), 'error'); }
      }
    });
    pickEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = pickEl.querySelector('input');
      const list = pickEl.querySelector('.bm-pick-results');
      const q = input.value.trim();
      if (q.length < 2) return;
      list.hidden = false; list.innerHTML = '<li class="is-empty">Searching…</li>';
      const res = await API.searchPlaces(q);
      if (!pick) return;
      list.innerHTML = '';
      if (!res.success || !res.places.length) { list.innerHTML = `<li class="is-empty">${esc(res.success ? 'No places found in the Philippines for that search.' : res.error)}</li>`; return; }
      res.places.forEach((p) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = `<strong>${esc(p.name)}</strong><span>${esc(p.display.split(',').slice(1, 4).join(',').trim())}</span>`;
        b.addEventListener('click', () => { list.hidden = true; input.value = p.name; setPick({ lat: p.lat, lng: p.lng }, p.display.split(',').slice(0, 3).join(',')); map.setView(aim([p.lat, p.lng], 16), 16, { animate: false }); });
        li.appendChild(b); list.appendChild(li);
      });
    });

    // A (from) and B (to) summary at the top of the route panel
    function abBlock() {
      const manualMe = user && user.manual;
      const fromName = routeFromPt ? routeFromPt.name : (manualMe ? 'My location (set by hand)' : refIsUser() ? 'My location' : 'Map center');
      const toName = route && route.dest && !route.dest.auto ? route.dest.name : 'Safest nearby site';
      return `<div class="bm-ab">
        <div class="bm-ab-row"><i class="bm-ab-dot a">A</i><span class="bm-ab-txt"><small>From</small>${esc(fromName)}</span><button type="button" class="bm-ab-edit" data-act="pick" data-p="A">Change</button></div>
        <button type="button" class="bm-ab-swap" data-act="swap" aria-label="Swap start and destination" ${route && route.dest ? '' : 'disabled'}>⇅</button>
        <div class="bm-ab-row"><i class="bm-ab-dot b">B</i><span class="bm-ab-txt"><small>To</small>${esc(toName)}</span><button type="button" class="bm-ab-edit" data-act="pick" data-p="B">Change</button></div>
      </div>`;
    }
    function swapAB() {
      if (!route || !route.dest || !route.from) return;
      const a = { lat: route.dest.lat, lng: route.dest.lng, name: route.dest.name };
      const b = { lat: route.from.lat, lng: route.from.lng, name: routeFromPt ? routeFromPt.name : 'My location', custom: true };
      routeFromPt = a;
      routeTo(b, true);
    }

    /* ---- GPS dot ---- */
    onUser((u, first) => {
      const ll = [u.lat, u.lng];
      if (!meMarker) {
        meAccuracy = L.circle(ll, { radius: u.accuracy || 30, color: '#2F80ED', weight: 1, fillColor: '#2F80ED', fillOpacity: 0.12, interactive: false }).addTo(keep.me);
        meMarker = L.marker(ll, { icon: ICONS.me, interactive: false, zIndexOffset: 1000, keyboard: false }).addTo(keep.me);
      } else {
        meMarker.setLatLng(ll);
        meAccuracy.setLatLng(ll).setRadius(u.accuracy || 30);
      }
      meMarker.setIcon(u.manual ? ICONS.meSet : ICONS.me);
      editBtn.classList.toggle('is-set', !!u.manual);
      editBtn.title = u.manual ? 'Your location is set by hand. Tap to change it.' : 'Edit my location';
      if (first && !touched) map.setView(aim(ll, 15), 15, { animate: false });
      if (first && (mode === 'evacuation' || mode === 'route') && evacItems.length) { annotateDistances(); drawEvac(); renderSheet(); }
    });

    async function locate() {
      info('Finding your location…', 'busy');
      try {
        const u = await startTracking();
        touched = true;
        const z = Math.max(map.getZoom(), 16);
        map.flyTo(aim([u.lat, u.lng], z), z);
        info('');
        if (mode === 'evacuation' || mode === 'route') { annotateDistances(); drawEvac(); renderSheet(); }
        if (mode === 'weather') loadOutlook();
      } catch (err) {
        info(geoErrorText(err), 'error');
      }
    }
    if (o.locateBtn) o.locateBtn.addEventListener('click', locate);

    /* ================= REPORTS & EMERGENCIES ================= */
    // Your own reports always show. The Reports layer shows everything; Flood and
    // Landslide add the matching reports from the Emergencies tab.
    function reportVisible(inc) {
      if (inc.source === 'mine' || mode === 'reports') return true;
      if (mode === 'flood' || mode === 'surge') return inc.type === 'Flood';
      if (mode === 'landslide') return inc.type === 'Landslide';
      return false;
    }

    function reportPopup(inc) {
      const t = typeOf(inc.type);
      const text = inc.desc ? (inc.desc.length > 150 ? inc.desc.slice(0, 149) + '…' : inc.desc) : '';
      return `<div class="bm-pop">
        <div class="bm-pop-title">${esc(inc.title || t)}</div>
        <div class="bm-pop-sub">${esc(t)} · ${inc.source === 'mine' ? 'Your report' : 'Community report'} · ${ago(inc.time)}</div>
        ${text ? `<div class="bm-pop-meta">${esc(text)}</div>` : ''}
        ${o.onOpenReport ? `<button type="button" class="bm-route-btn bm-report-btn" data-id="${esc(inc.id)}">Open report</button>` : ''}
      </div>`;
    }

    function drawReports() {
      keep.incidents.clearLayers();
      incidents.forEach((inc) => itemMarkers.delete(inc.id));
      incidents.filter(reportVisible).forEach((inc) => {
        const m = L.marker([inc.lat, inc.lng], { icon: reportIcon(inc), title: inc.title, zIndexOffset: inc.source === 'mine' ? 600 : 300 })
          .bindPopup(() => reportPopup(inc), POPUP_OPTS).addTo(keep.incidents);
        itemMarkers.set(inc.id, m);
      });
    }
    incidentSubs.add(() => { drawReports(); if (mode === 'reports') renderSheet(); });

    /* ================= LIVE FLOOD LEVELS + LANDSLIDE REPORTS (simulated) ================= */
    const gaugeIcon = (g) => L.divIcon({
      className: 'bm-pin-wrap',
      html: `<div class="bm-gauge lv${g.lv}"><b>${g.depth}</b><small>cm</small></div>`,
      iconSize: [46, 34], iconAnchor: [23, 17], popupAnchor: [0, -18],
    });
    const slideIcon = (r) => L.divIcon({
      className: 'bm-pin-wrap',
      html: `<div class="bm-slide s${r.sev}"><svg viewBox="0 0 14 14" width="16" height="16" fill="#fff" aria-hidden="true"><path d="M7 1.5 13 12H1L7 1.5zM6.3 5.5h1.4v3.2H6.3zM6.3 9.5h1.4v1.3H6.3z" fill-rule="evenodd"/></svg></div>`,
      iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -17],
    });
    const DEMO_NOTE = '<div class="bm-pop-meta bm-pop-warn">DEMO: made up to show how alerts work. Not a real report.</div>';
    const SIM_NOTE = '<div class="bm-pop-meta bm-pop-warn">Simulated from the risk map and rain forecast until a live feed is connected.</div>';

    function gaugePopup(g) {
      const msg = g.lv >= 2 ? 'Avoid this area. Move to higher ground if the water keeps rising.'
        : g.lv === 1 ? 'Passable with care. Watch for rising water.' : 'No floodwater here right now.';
      return `<div class="bm-pop"><div class="bm-pop-title">Flood gauge: ${esc(g.label)}</div>
        <div class="bm-pop-sub">${g.depth} cm of water · ground ${g.elev} m · ${esc(g.trend)}</div>
        <div class="bm-pop-risk r${g.lv}">${msg}</div>
        <div class="bm-pop-meta">Updated ${ago(g.time)}</div>${g.demo ? DEMO_NOTE : SIM_NOTE}</div>`;
    }
    function slidePopup(r) {
      return `<div class="bm-pop"><div class="bm-pop-title">${esc(r.title)}</div>
        <div class="bm-pop-sub">Landslide report · ${ago(r.time)}</div>
        <div class="bm-pop-risk r${r.sev}">${esc(r.desc)}</div>
        <div class="bm-pop-meta">Slope ${r.slope}° · ground ${r.elev} m</div>${r.demo ? DEMO_NOTE : SIM_NOTE}</div>`;
    }

    function drawLive() {
      groups.liveFlood.clearLayers();
      groups.liveSlide.clearLayers();
      live.gauges.forEach((g) => itemMarkers.set(g.id, L.marker([g.lat, g.lng], { icon: gaugeIcon(g), title: g.title, zIndexOffset: 200 + g.depth })
        .bindPopup(() => gaugePopup(g), POPUP_OPTS).addTo(groups.liveFlood)));
      live.slides.forEach((r) => itemMarkers.set(r.id, L.marker([r.lat, r.lng], { icon: slideIcon(r), title: r.title, zIndexOffset: 250 + r.sev })
        .bindPopup(() => slidePopup(r), POPUP_OPTS).addTo(groups.liveSlide)));
    }

    // Raise an alert in the app's notifications (once per event) when something serious
    // shows up within 5 km of where the person actually is.
    const firedAlerts = alertState;
    function maybeAlert() {
      if (!o.onAlert || !user) return;
      const me = { lat: user.lat, lng: user.lng };
      const near = (x) => API.distanceKm(me, x) <= 5;
      const g = live.gauges.filter((x) => x.lv >= 2 && near(x)).sort((a, b) => b.depth - a.depth)[0];
      if (g && !firedAlerts.has('f' + g.id + g.lv)) {
        firedAlerts.add('f' + g.id + g.lv);
        o.onAlert({ icon: '!assets/!buttons/Flood.png', mode: 'flood', lat: g.lat, lng: g.lng,
          title: `${g.demo ? 'DEMO ' : ''}Flood alert: ${g.label.toLowerCase()} water nearby`,
          body: `${g.depth} cm of water about ${fmtKm(API.distanceKm(me, g))} away (${g.demo ? 'demo' : 'simulated'}). Avoid the area and move to higher ground.` });
      }
      const r = live.slides.filter((x) => x.sev >= 3 && near(x))[0];
      if (r && !firedAlerts.has('s' + r.id)) {
        firedAlerts.add('s' + r.id);
        o.onAlert({ icon: '!assets/!buttons/Landslide.png', mode: 'landslide', lat: r.lat, lng: r.lng,
          title: (r.demo ? 'DEMO ' : '') + 'Landslide report: road blocked',
          body: `A slide is blocking a road about ${fmtKm(API.distanceKm(me, r))} away (${r.demo ? 'demo' : 'simulated'}). Choose another route.` });
      }
    }

    async function loadLive(stale) {
      await loadOutlook();
      if (stale && stale()) return;
      const w = outlook && outlook.weather;
      const wantFlood = mode === 'flood';
      const wantSlide = mode === 'landslide';
      if (!w || map.getZoom() < 12 || !(wantFlood || wantSlide)) {
        if (live.gauges.length || live.slides.length) { live = { gauges: [], slides: [], sig: '' }; drawLive(); }
        renderSheet();
        return;
      }
      const view = map.getBounds().pad(0.1);
      const level = floodWaterLevel(w);
      if (extras.floodlive.waterLevel !== level) {
        extras.floodlive.waterLevel = level;
        applyLayers();
        if (map.hasLayer(extras.floodlive)) extras.floodlive.redraw();
      }
      const [gauges, slides] = await Promise.all([
        wantFlood ? simFloodGauges(view, level) : [],
        wantSlide ? simSlides(view, w.landslide.level) : [],
      ]);
      if (stale && stale()) return;
      if (demo) {
        const at = user ? { lat: user.lat, lng: user.lng } : map.getCenter();
        const d = demoItems(at, wantFlood, wantSlide);
        gauges.unshift(...d.gauges);
        slides.unshift(...d.slides);
      }
      const sig = gauges.map((g) => g.id + g.depth).join() + '|' + slides.map((r) => r.id).join();
      if (sig !== live.sig) { live = { gauges, slides, sig }; drawLive(); }
      maybeAlert();
      renderSheet();
    }

    function liveFloodSummary() {
      if (!live.gauges.length) return 'No low-lying gauge spots in view';
      const top = live.gauges.slice().sort((a, b) => b.depth - a.depth)[0];
      return top.depth > 0 ? `Live: up to ${top.depth} cm (${top.label.toLowerCase()})` : 'Live: no flooding at gauges';
    }

    /* ================= WEATHER OVERLAY (any layer) ================= */
    const RAIN_STEPS = [[0.2, '#BDE8FF'], [1, '#5DB8FF'], [3, '#2ECC71'], [6, '#F4D03F'], [12, '#F39C12'], [25, '#E5342E'], [1e9, '#A4006B']];
    const rainColor = (mm) => { for (const [lim, c] of RAIN_STEPS) if (mm < lim) return c; return '#A4006B'; };
    const stepColor = (steps, v) => { for (const [lim, c] of steps) if (v < lim) return c; return steps[steps.length - 1][1]; };
    const tempColor = (t) => stepColor([[22, '#5DB8FF'], [25, '#2ECC71'], [28, '#F4D03F'], [31, '#F39C12'], [34, '#E5342E'], [1e9, '#A4006B']], t);
    const pressureColor = (p) => stepColor([[996, '#A4006B'], [1002, '#E5342E'], [1007, '#F39C12'], [1011, '#F4D03F'], [1015, '#2ECC71'], [1e9, '#5DB8FF']], p);
    const humidColor = (h) => stepColor([[60, '#F4D03F'], [72, '#BDE8FF'], [82, '#5DB8FF'], [90, '#2D7FD6'], [1e9, '#1F4E99']], h);
    const windColor = (k) => (k < 15 ? '#2ECC71' : k < 30 ? '#F4D03F' : k < 50 ? '#F39C12' : '#E5342E');

    const chip = document.createElement('div');
    chip.className = 'bm-ovl-chip';
    chip.hidden = true;
    host.appendChild(chip);
    chip.addEventListener('click', (e) => { if (e.target.closest('[data-off]')) setOverlay('none'); });

    function updateChip() {
      if (ovl === 'none' || ovl === 'typhoon') { chip.hidden = true; return; }   // the typhoon tracker has its own card
      const ramps = {
        radar: ['Light', 'Heavy', 'linear-gradient(90deg,#9BE3FF,#2FA0FF,#2ECC40,#FFE14D,#FF9F1C,#E5342E,#A4006B)'],
        rain: ['None', 'Heavy', 'linear-gradient(90deg,#BDE8FF,#5DB8FF,#2ECC71,#F4D03F,#F39C12,#E5342E,#A4006B)'],
        clouds: ['Clear', 'Thick', 'linear-gradient(90deg,rgba(255,255,255,.2),#fff,#9aa3ad)'],
        wind: ['Calm', 'Strong', 'linear-gradient(90deg,#2ECC71,#F4D03F,#F39C12,#E5342E)'],
        temp: ['Cool', 'Hot', 'linear-gradient(90deg,#5DB8FF,#2ECC71,#F4D03F,#F39C12,#E5342E,#A4006B)'],
        pressure: ['Low', 'High', 'linear-gradient(90deg,#A4006B,#E5342E,#F39C12,#F4D03F,#2ECC71,#5DB8FF)'],
        humidity: ['Dry', 'Humid', 'linear-gradient(90deg,#F4D03F,#BDE8FF,#5DB8FF,#2D7FD6,#1F4E99)'],
        typhoon: ['Weak', 'Super typhoon', 'linear-gradient(90deg,#5DB8FF,#2ECC71,#F4D03F,#F39C12,#E5342E,#A21CAF)'],
      }[ovl];
      let t = '';
      if (ovl === 'radar' && radar.frames.length) t = ' · ' + radarLabel();
      chip.hidden = false;
      chip.innerHTML = `<b>${esc(OVERLAYS[ovl])}${esc(t)}</b>
        <span class="bm-ovl-ramp"><em>${ramps[0]}</em><i style="background:${ramps[2]}"></i><em>${ramps[1]}</em></span>
        <button type="button" data-off aria-label="Hide weather overlay">×</button>`;
    }

    function drawWx() {
      groups.wxgrid.clearLayers();
      const d = wx.data;
      if (!d || !GRID_OVL.includes(ovl)) return;
      d.cells.forEach((c) => {
        if (ovl === 'rain') {
          if (c.rain6 < 0.2) return;
          L.rectangle([[c.lat - d.dLat / 2, c.lng - d.dLng / 2], [c.lat + d.dLat / 2, c.lng + d.dLng / 2]],
            { stroke: false, fillColor: rainColor(c.rain6), fillOpacity: 0.5, interactive: false }).addTo(groups.wxgrid);
          L.marker([c.lat, c.lng], { interactive: false, icon: L.divIcon({ className: 'bm-pin-wrap', iconSize: [0, 0],
            html: `<span class="bm-wx-label">${c.rain6 < 10 ? c.rain6.toFixed(1) : Math.round(c.rain6)} mm</span>` }) }).addTo(groups.wxgrid);
        } else if (ovl === 'wind') {
          const col = windColor(c.windKmh);
          L.marker([c.lat, c.lng], { interactive: false, icon: L.divIcon({ className: 'bm-pin-wrap', iconSize: [40, 40], iconAnchor: [20, 20],
            html: `<div class="bm-wind"><svg viewBox="0 0 20 20" width="26" height="26" style="transform:rotate(${(c.windDir + 180) % 360}deg)"><path d="M10 1 16 17l-6-4-6 4z" fill="${col}" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg><span>${c.windKmh}</span></div>` }) }).addTo(groups.wxgrid);
        } else {
          const v = ovl === 'temp' ? c.tempC : ovl === 'pressure' ? c.pressure : c.humidity;
          if (v == null || isNaN(v)) return;
          const col = ovl === 'temp' ? tempColor(v) : ovl === 'pressure' ? pressureColor(v) : humidColor(v);
          const txt = ovl === 'temp' ? Math.round(v) + '°C' : ovl === 'pressure' ? v + ' hPa' : v + '%';
          L.rectangle([[c.lat - d.dLat / 2, c.lng - d.dLng / 2], [c.lat + d.dLat / 2, c.lng + d.dLng / 2]],
            { stroke: false, fillColor: col, fillOpacity: 0.5, interactive: false }).addTo(groups.wxgrid);
          L.marker([c.lat, c.lng], { interactive: false, icon: L.divIcon({ className: 'bm-pin-wrap', iconSize: [0, 0],
            html: `<span class="bm-wx-label">${txt}</span>` }) }).addTo(groups.wxgrid);
        }
      });
    }

    async function loadWxGrid(force) {
      if (!GRID_OVL.includes(ovl)) return;
      if (map.getZoom() < 7) { groups.wxgrid.clearLayers(); info('Zoom in a little to see the weather overlay.', 'warn'); return; }
      const v = map.getBounds();
      const key = [v.getSouth(), v.getWest(), v.getNorth(), v.getEast()].map((x) => x.toFixed(2)).join();
      if (!force && wx.key === key && wx.data) { drawWx(); return; }
      const my = ++wxRun;
      info('Loading weather overlay…', 'busy');
      const res = await API.getWeatherGrid({ south: v.getSouth(), west: v.getWest(), north: v.getNorth(), east: v.getEast() });
      if (my !== wxRun) return;
      info('');
      if (!res.success) { info(res.error, 'error'); return; }
      wx = { key, data: res };
      drawWx();
    }

    function setOverlay(name) {
      ovl = OVERLAYS[name] ? name : 'none';
      wxRun++;
      if (!GRID_OVL.includes(ovl)) groups.wxgrid.clearLayers();
      if (ovl !== 'typhoon') hideTyphoon(); else showTyphoon();
      applyLayers();
      updateChip();
      if (o.onOverlayChange) o.onOverlayChange(ovl);
      if (ovl === 'radar' || ovl === 'clouds') {
        ensureRadar().then((ok) => {
          if (!ok || (ovl === 'clouds' && !extras.clouds)) info('That weather overlay is unavailable right now.', 'error');
          applyLayers();
          updateChip();
        });
      }
      loadWxGrid(true);
    }

    /* ================= TYPHOON TRACKER (DEMO) =================
       A made-up typhoon, built around the person's location (or the map centre), so the
       tracker can be shown without a real storm. It draws the past track, the forecast track
       with its cone of uncertainty, wind rings (gale / storm / typhoon force) and the eye,
       and a time slider + play button moves the storm along its path. Everything is labelled
       DEMO. Swap buildDemoTyphoon() for a real PAGASA / JTWC feed to track a real storm. */
    const TY_FROM = -4, TY_TO = 8, TY_STEP_H = 6;               // 6-hour steps: 24 h ago .. 48 h ahead
    const TY_WIND = [70, 90, 115, 145, 175, 195, 180, 150, 115, 90, 75, 60, 50];   // km/h, index = step - TY_FROM
    const TY_CATS = [
      [62, 'Tropical depression', '#5DB8FF'], [89, 'Tropical storm', '#2ECC71'], [118, 'Severe tropical storm', '#F4D03F'],
      [185, 'Typhoon', '#E5342E'], [1e9, 'Super typhoon', '#A21CAF'],
    ];
    const tyCat = (w) => TY_CATS.find((c) => w < c[0]);
    const toRad = (d) => (d * Math.PI) / 180;
    function destPoint(p, bearing, km) {
      const R = 6371, b = toRad(bearing), d = km / R, la1 = toRad(p.lat), lo1 = toRad(p.lng);
      const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
      const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
      return { lat: (la2 * 180) / Math.PI, lng: (((lo2 * 180) / Math.PI + 540) % 360) - 180 };
    }
    function bearingTo(a, b) {
      const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
      const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
      return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    }
    // The eye passes right over `at` 12 h from now, moving west-north-west at about 22 km/h.
    function buildDemoTyphoon(at) {
      const brg = (k) => 285 + (k - TY_FROM) * 2;
      const pts = {};
      pts[2] = { lat: at.lat, lng: at.lng };
      for (let k = 2; k < TY_TO; k++) pts[k + 1] = destPoint(pts[k], brg(k), k >= 2 ? 120 : 132);
      for (let k = 2; k > TY_FROM; k--) pts[k - 1] = destPoint(pts[k], brg(k - 1) + 180, 132);
      const steps = [];
      for (let k = TY_FROM; k <= TY_TO; k++) {
        const w = TY_WIND[k - TY_FROM];
        steps.push({ k, ...pts[k], wind: w, gust: Math.round(w * 1.3), hPa: Math.round(1004 - (w - 50) * 0.75),
          coneKm: k < 0 ? 0 : 50 + k * 28, time: Date.now() + k * TY_STEP_H * 3600e3 });
      }
      steps.forEach((s, i) => { const nx = steps[i + 1] || null, pv = steps[i - 1] || null; s.heading = Math.round(nx ? bearingTo(s, nx) : bearingTo(pv, s)); });
      return steps;
    }
    const compass = (b) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(b / 22.5) % 16];
    const tyClock = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric' });
    const tyRings = (w) => { const g = 60 + w * 1.3; return { gale: g, storm: g * 0.55, ty: w >= 118 ? g * 0.28 : 0 }; };

    const ty = { steps: null, k: 0, timer: null, now: L.layerGroup(), fitted: false };
    groups.tytrack.addLayer(ty.now);
    const tyCard = document.createElement('section');
    tyCard.className = 'bm-ty-card';
    tyCard.hidden = true;
    tyCard.setAttribute('aria-label', 'Typhoon tracker (demo)');
    host.appendChild(tyCard);
    L.DomEvent.disableClickPropagation(tyCard);
    L.DomEvent.disableScrollPropagation(tyCard);

    function tyEyeIcon(col) {
      return L.divIcon({ className: 'bm-pin-wrap', iconSize: [54, 54], iconAnchor: [27, 27],
        html: `<div class="bm-ty-eye"><svg viewBox="0 0 54 54" width="54" height="54" aria-hidden="true">
          <g class="bm-ty-spin"><path d="M27 27c0-12 8-20 20-20-8 3-9 9-6 14 3 5 1 11-6 12z" fill="${col}" opacity=".85"/>
          <path d="M27 27c0 12-8 20-20 20 8-3 9-9 6-14-3-5-1-11 6-12z" fill="${col}" opacity=".85"/></g>
          <circle cx="27" cy="27" r="5.5" fill="#fff" stroke="${col}" stroke-width="2"/></svg></div>` });
    }

    function drawTyNow() {
      ty.now.clearLayers();
      const s = ty.steps[ty.k - TY_FROM], cat = tyCat(s.wind), at = { lat: s.lat, lng: s.lng }, r = tyRings(s.wind);
      L.circle(at, { radius: r.gale * 1000, stroke: true, weight: 1.5, color: '#CA8A04', dashArray: '4 4', fillColor: '#F4D03F', fillOpacity: 0.14, interactive: false }).addTo(ty.now);
      L.circle(at, { radius: r.storm * 1000, stroke: true, weight: 1.5, color: '#EA580C', fillColor: '#F39C12', fillOpacity: 0.2, interactive: false }).addTo(ty.now);
      if (r.ty) L.circle(at, { radius: r.ty * 1000, stroke: true, weight: 1.5, color: '#DC2626', fillColor: '#E5342E', fillOpacity: 0.3, interactive: false }).addTo(ty.now);
      L.marker(at, { icon: tyEyeIcon(cat[2]), interactive: false, zIndexOffset: 900 }).addTo(ty.now);
      renderTyCard();
    }

    function drawTyStatic() {
      const g = groups.tytrack;
      g.clearLayers();
      g.addLayer(ty.now);
      const st = ty.steps, fc = st.filter((s) => s.k >= 0);
      // cone of uncertainty: left and right edges of the forecast track
      const left = [], right = [];
      fc.forEach((s, i) => {
        const nx = fc[i + 1] || null, b = nx ? bearingTo(s, nx) : bearingTo(fc[i - 1], s);
        const r = Math.max(s.coneKm, 30);
        const a = destPoint(s, b - 90, r), c = destPoint(s, b + 90, r);
        left.push([a.lat, a.lng]); right.push([c.lat, c.lng]);
      });
      L.polygon(left.concat(right.reverse()), { stroke: true, weight: 1, color: '#DC2626', dashArray: '3 5', fillColor: '#DC2626', fillOpacity: 0.1, interactive: false }).addTo(g);
      const ll = (s) => [s.lat, s.lng];
      L.polyline(st.filter((s) => s.k <= 0).map(ll), { color: '#17181A', weight: 3.5, opacity: 0.85, interactive: false }).addTo(g);
      L.polyline(fc.map(ll), { color: '#17181A', weight: 3, opacity: 0.85, dashArray: '8 7', interactive: false }).addTo(g);
      st.forEach((s) => {
        L.circleMarker(ll(s), { radius: s.k === 0 ? 6 : 4.5, weight: 1.5, color: '#fff', fillColor: tyCat(s.wind)[2], fillOpacity: 1, interactive: false }).addTo(g);
        if (s.k % 2 === 0 && s.k !== 0) {
          L.marker(ll(s), { interactive: false, icon: L.divIcon({ className: 'bm-pin-wrap', iconSize: [0, 0],
            html: `<span class="bm-wx-label bm-ty-lbl">${tyClock(s.time)}</span>` }) }).addTo(g);
        }
      });
    }

    function tyYou(s) {
      if (!user) return null;
      const d = API.distanceKm(user, s), r = tyRings(s.wind);
      const lv = d < r.ty ? (s.wind >= 185 ? 5 : 4) : d < r.storm ? 3 : d < r.gale ? 2 : d < r.gale * 1.5 ? 1 : 0;
      return { d, lv };
    }

    function renderTyCard() {
      if (!ty.steps) return;
      const s = ty.steps[ty.k - TY_FROM], cat = tyCat(s.wind), you = tyYou(s);
      const label = ty.k === 0 ? 'Now' : (ty.k > 0 ? '+' : '−') + Math.abs(ty.k * TY_STEP_H) + ' h';
      let near = '';
      if (user) {
        const best = ty.steps.filter((x) => x.k >= 0).map((x) => ({ x, d: API.distanceKm(user, x) })).sort((a, b) => a.d - b.d)[0];
        near = `<div><small>Closest to you</small><b>${tyClock(best.x.time)}</b><span>${fmtKm(best.d)} away</span></div>`;
      }
      tyCard.innerHTML = `
        <div class="bm-ty-head"><span class="bm-ty-title"><i class="bm-ty-dot" style="background:${cat[2]}"></i>Typhoon <b>&ldquo;Demo&rdquo;</b></span>
          <span class="bm-badge bm-ty-demo">DEMO</span>
          <button type="button" data-off aria-label="Hide typhoon tracker">×</button></div>
        <div class="bm-ty-stats">
          <div><small>${label} · ${esc(tyClock(s.time))}</small><b style="color:${cat[2] === '#F4D03F' ? '#8a6d00' : cat[2]}">${cat[1]}</b><span>Winds ${s.wind} km/h, gusts ${s.gust}</span></div>
          <div><small>Pressure</small><b>${s.hPa} hPa</b><span>Moving ${compass(s.heading)} · 22 km/h</span></div>
          ${you ? `<div><small>Your area</small><b>${you.d < 1 ? '<1' : Math.round(you.d)} km</b><span>${tcwsPill(you.lv)} (rough)</span></div>` : `<div><small>Your area</small><b>—</b><span>Turn on location</span></div>`}
          ${near}
        </div>
        <div class="bm-ty-ctl">
          <button type="button" class="bm-btn bm-btn-green" data-ty="play">${ty.timer ? 'Pause' : 'Play'}</button>
          <input type="range" min="${TY_FROM}" max="${TY_TO}" step="1" value="${ty.k}" aria-label="Storm time" data-ty="slide">
        </div>
        <div class="bm-ty-key"><i style="background:#F4D03F"></i>Gale 63+ <i style="background:#F39C12"></i>Storm 89+ <i style="background:#E5342E"></i>Typhoon 118+ <i class="cone"></i>Possible path</div>
        <p class="bm-ty-note">Made-up storm for practice, not a real forecast. Real tracks: PAGASA bulletins.</p>`;
    }

    function setTyStep(k) { ty.k = Math.max(TY_FROM, Math.min(TY_TO, k)); drawTyNow(); }
    function stopTyPlay() { clearInterval(ty.timer); ty.timer = null; }
    function playTy() {
      if (ty.timer) { stopTyPlay(); renderTyCard(); return; }
      if (ty.k >= TY_TO) ty.k = TY_FROM - 1;
      ty.timer = setInterval(() => {
        if (ty.k >= TY_TO) { stopTyPlay(); renderTyCard(); return; }
        setTyStep(ty.k + 1);
      }, 1000);
      setTyStep(ty.k + 1);
    }
    tyCard.addEventListener('click', (e) => {
      if (e.target.closest('[data-off]')) { setOverlay('none'); return; }
      if (e.target.closest('[data-ty="play"]')) playTy();
    });
    tyCard.addEventListener('input', (e) => {
      if (e.target.matches('[data-ty="slide"]')) { stopTyPlay(); setTyStep(parseInt(e.target.value, 10)); }
    });

    function showTyphoon() {
      const at = user ? { lat: user.lat, lng: user.lng } : map.getCenter();
      ty.steps = buildDemoTyphoon(at);
      ty.k = 0;
      stopTyPlay();
      drawTyStatic();
      drawTyNow();
      tyCard.hidden = false;
      sheetCollapsed = true;                       // fold the layer panel down to its title so the track stays visible
      sheet.classList.add('is-collapsed');
      const hd = sheet.querySelector('.bm-sheet-head');
      if (hd) hd.setAttribute('aria-expanded', 'false');
      const b = L.latLngBounds(ty.steps.map((s) => [s.lat, s.lng]));
      const fit = () => map.fitBounds(b.pad(0.25), { paddingTopLeft: [10, 130], paddingBottomRight: [64, tyCard.offsetHeight + (sheet.hidden ? 0 : sheet.offsetHeight) + 50], animate: false, maxZoom: 9 });
      fit();
      requestAnimationFrame(fit);
    }
    function hideTyphoon() {
      stopTyPlay();
      tyCard.hidden = true;
      groups.tytrack.clearLayers();
      groups.tytrack.addLayer(ty.now);
      ty.now.clearLayers();
    }

    /* ---- dropped pin / search ---- */
    async function dropPin(ll, display) {
      keep.pin.clearLayers();
      const name = display ? display.split(',')[0] : 'Dropped pin';
      const base = { name, lat: ll.lat, lng: ll.lng };
      let terrainHtml = riskHtml(null, true);
      let label = display || 'Looking up address…';
      let title = name;
      const marker = L.marker(ll, { icon: ICONS.dropped, title: name }).addTo(keep.pin);
      const refreshPop = () => marker.setPopupContent(placePopup({ ...base, name: title, label }, terrainHtml));
      marker.bindPopup(placePopup({ ...base, label }, terrainHtml), POPUP_OPTS).openPopup();
      terrainAt(ll).then((t) => {
        if (!keep.pin.hasLayer(marker)) return;
        const r = terrainRisk(t);
        terrainHtml = r.known ? riskHtml(r) + `<div class="bm-pop-meta">Elevation ${t.elev} m · slope ${t.slope}°</div>` : '';
        refreshPop();
      });
      if (!display) {
        const rev = await API.reverseGeocode({ lat: ll.lat, lng: ll.lng });
        if (rev.success && keep.pin.hasLayer(marker)) {
          label = rev.display.split(',').slice(0, 3).join(',');
          title = rev.display.split(',')[0] || name;
          refreshPop();
        }
      }
    }
    map.on('click', (e) => { hideResults(); if (pick) { setPick(e.latlng); return; } dropPin(e.latlng); });

    function goToPlace(p) {
      touched = true;
      if (p.bounds) map.fitBounds(p.bounds, { maxZoom: 17 });
      else map.setView(aim([p.lat, p.lng], 16), 16);
      dropPin({ lat: p.lat, lng: p.lng }, p.display);
    }

    const resultsEl = o.searchResults;
    function hideResults() { if (resultsEl) { resultsEl.hidden = true; resultsEl.innerHTML = ''; } }
    function showResults(items, message) {
      if (!resultsEl) return;
      resultsEl.innerHTML = '';
      if (message) {
        const li = document.createElement('li');
        li.className = 'is-empty';
        li.textContent = message;
        resultsEl.appendChild(li);
      }
      (items || []).forEach((p) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        const t = document.createElement('strong');
        t.textContent = p.name;
        const s = document.createElement('span');
        s.textContent = p.display.split(',').slice(1, 4).join(',').trim();
        b.append(t, s);
        b.addEventListener('click', () => {
          if (o.searchInput) o.searchInput.value = p.name;
          hideResults();
          goToPlace(p);
        });
        li.appendChild(b);
        resultsEl.appendChild(li);
      });
      resultsEl.hidden = false;
    }

    if (o.searchForm && o.searchInput) {
      o.searchForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const q = o.searchInput.value.trim();
        if (q.length < 2) return;
        showResults([], 'Searching…');
        const res = await API.searchPlaces(q);
        if (!res.success) showResults([], res.error);
        else if (!res.places.length) showResults([], 'No places found in the Philippines for that search.');
        else showResults(res.places);
      });
    }

    /* ---- save visible area for offline use ---- */
    if (o.saveBtn) {
      o.saveBtn.addEventListener('click', async () => {
        if (!hasCache) { info('This browser can’t store maps offline.', 'error'); return; }
        if (!ALLOW_OFFLINE_SAVE) { info('Offline map saving is turned off until a tile provider that allows it is configured.', 'error'); return; }
        o.saveBtn.disabled = true;
        info('Saving this area for offline use…', 'busy');
        const n = await street.cacheView(map);
        o.saveBtn.disabled = false;
        info(n ? `Saved ${n} map tiles. This area will still draw without signal.` : 'Couldn’t save map tiles. Check your connection.', n ? '' : 'error');
      });
    }

    if (o.base) setBase(o.base);
    setMode(o.mode || 'none');

    return {
      map,
      setMode,
      locate,
      setBase,
      setOverlay,
      focusPoint(lat, lng, z = 16) { touched = true; map.setView(aim([lat, lng], z), z, { animate: false }); },
      // switch to the Reports layer and open one report's pin
      focusReport(id) {
        const inc = incidents.find((i) => i.id === id);
        if (!inc) return;
        setMode('reports');
        touched = true;
        map.setView(aim([inc.lat, inc.lng], 16), 16, { animate: false });
        setTimeout(() => { const m = itemMarkers.get(id); if (m) m.openPopup(); }, 350);
      },
      // Demo storm on/off: re-reads the forecast, redraws the levels and raises the alerts
      setDemo(v) {
        v = !!v;
        if (v === demo) return;
        demo = v;
        if (demo) demoRun++;
        demoPill.hidden = !demo;
        outlook = null;
        typhoon = null;
        live = { gauges: [], slides: [], sig: '' };
        drawLive();
        if (demo && !user) info('Demo storm on. Turn on location so the alert can find you.', 'warn');
        applyLayers();
        run(true);
      },
      isDemo: () => demo,
      getOverlay: () => ovl,
      getMode: () => mode,
      getBase: () => baseName,
      invalidate: () => map.invalidateSize(),
    };
  }

  /* ====================================================================
     MINI MAP  (Select Location sheet, Setup SOS)
     o: { interactive, zoom, onSettle({lat,lng}) }
     A fixed pin sits over the map center (CSS); the person moves the map.
     ==================================================================== */
  function createMiniMap(el, o = {}) {
    const interactive = o.interactive !== false;
    const zoom = o.zoom || 16;
    const map = L.map(el, {
      zoomControl: false, attributionControl: false,
      maxBounds: PH_BOUNDS, maxBoundsViscosity: 1, minZoom: 5, maxZoom: 19,
      dragging: interactive, touchZoom: interactive, scrollWheelZoom: interactive,
      doubleClickZoom: interactive, boxZoom: false, keyboard: false,
    }).setView(PH_CENTER, zoom);

    L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);
    streetLayer().addTo(map);
    watchSize(el, map);

    let touched = false;
    map.on('dragstart', () => { touched = true; });
    onUser((u, first) => { if (first && !touched) map.setView([u.lat, u.lng], zoom, { animate: false }); });

    if (o.onSettle) {
      map.on('moveend', debounce(() => { const c = map.getCenter(); o.onSettle({ lat: c.lat, lng: c.lng }); }, 700));
    }

    return {
      map,
      center: () => { const c = map.getCenter(); return { lat: c.lat, lng: c.lng }; },
      setView(ll, z) { touched = true; map.setView(ll, z || zoom); },
      async flyToUser() {
        const u = await currentGps();
        touched = true;
        map.flyTo([u.lat, u.lng], Math.max(map.getZoom(), zoom));
        return u;
      },
    };
  }

  /* ====================================================================
     BACKDROP  (faint live map behind the SOS button)
     ==================================================================== */
  function createBackdrop(el) {
    const map = L.map(el, {
      zoomControl: false, attributionControl: false,
      dragging: false, touchZoom: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false,
    }).setView(PH_CENTER, 14);
    L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);
    streetLayer().addTo(map);
    watchSize(el, map);
    onUser((u) => map.setView([u.lat, u.lng], 15, { animate: false }));
    return { map };
  }

  return {
    createFullMap, createMiniMap, createBackdrop,
    startTracking, onUser, setUserPosition, setManualPosition, useGps, currentGps, addIncident, removeIncident,
    geoErrorText, getUser: () => user,
  };
})();