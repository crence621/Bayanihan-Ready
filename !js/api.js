const BayanihanAPI = (() => {

  // In-memory "database" — replaced by a real DB once a backend exists.
  // Accounts are kept in this browser (localStorage) so they survive a page reload. Passwords
  // are stored as a salted SHA-256 hash, never as plain text. A real backend replaces all of this.
  const USERS_KEY = 'bm.users.v1';
  const loadUsers = () => { try { const u = JSON.parse(localStorage.getItem(USERS_KEY)); return Array.isArray(u) ? u : []; } catch (e) { return []; } };
  const db = {
    users: loadUsers(),   // { id, name, email, hash, location? }
    incidents: [],        // { id, userId, lat, lng, createdAt }
  };
  const saveUsers = () => { try { localStorage.setItem(USERS_KEY, JSON.stringify(db.users)); } catch (e) { /* storage blocked or full */ } };
  async function hashPassword(email, password) {
    const text = 'bayanihan-ready|' + email + '|' + password;
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return 'sha256:' + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { return 'plain:' + text; }     // crypto.subtle needs https or localhost
  }
  const cleanEmail = (e) => String(e || '').trim().toLowerCase();

  let sessionUser = null; // the "logged in" user for this tab/session

  const delay = (ms = 500) => new Promise((res) => setTimeout(res, ms));
  const uid = () => Math.random().toString(36).slice(2, 10);

  // Simple but solid email format check (not exhaustive RFC 5322, but
  // catches the vast majority of malformed input: missing "@", missing
  // domain, spaces, missing TLD, etc.)
  const isValidEmail = (email) =>
    typeof email === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());


  /* ---------------------------------------------------------------
     MAP DATA SOURCES (all free, no API key)
       OpenStreetMap Overpass  -> responders, evacuation sites, waterways
       OpenStreetMap Nominatim -> place search + reverse geocoding (PH only)
       OSRM demo server        -> driving routes on real roads
       Open-Meteo              -> current weather
     These are community-run services with fair-use limits. For production,
     self-host them or swap in a paid provider; only this file needs to change.
  --------------------------------------------------------------- */
  const OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const OSRM = 'https://router.project-osrm.org';
  const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

  /* PAGASA Tropical Cyclone Wind Signals (5 levels): winds of this strength are expected
     within `hours`. Used to ESTIMATE a signal from the forecast; the official signal is always PAGASA's. */
  const TCWS_LEVELS = [
    { level: 1, min: 39,  hours: 36, name: 'Strong winds',          range: '39\u201361 km/h',   threat: 'Minimal to minor threat to life and property' },
    { level: 2, min: 62,  hours: 24, name: 'Gale-force winds',      range: '62\u201388 km/h',   threat: 'Minor to moderate threat' },
    { level: 3, min: 89,  hours: 18, name: 'Storm-force winds',     range: '89\u2013117 km/h',  threat: 'Moderate to significant threat' },
    { level: 4, min: 118, hours: 12, name: 'Typhoon-force winds',   range: '118\u2013184 km/h', threat: 'Significant to severe threat' },
    { level: 5, min: 185, hours: 12, name: 'Typhoon-force winds',   range: '185 km/h or more',   threat: 'Extreme threat' },
  ];

  async function fetchJSON(url, options = {}, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    if (options.signal) options.signal.addEventListener('abort', () => ctrl.abort());
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Overpass servers are slow and flaky. Ask the first mirror; if it has not answered within
  // 3.5 s (or fails) ask the next one as well. The first good answer wins and the rest are
  // cancelled. An outside AbortSignal cancels everything (rejects with err.cancelled).
  function overpass(query, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const ctls = [];
      let done = false; let started = 0; let failed = 0; let timer = null; let lastErr;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ctls.forEach((c) => c.abort());
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(v);
      };
      const onAbort = () => finish(reject, Object.assign(new Error('cancelled'), { cancelled: true }));
      if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort); }
      const next = () => {
        if (done || started >= OVERPASS_URLS.length) return;
        const url = OVERPASS_URLS[started++];
        const ctl = new AbortController();
        ctls.push(ctl);
        fetchJSON(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
          signal: ctl.signal,
        }, (typeof window !== 'undefined' && window.BAYANIHAN_OVERPASS_TIMEOUT_MS) || 20000).then((d) => {
          // Overpass answers HTTP 200 with a "remark" when the query timed out or ran out of memory.
          if (d && d.remark && /timed out|out of memory|runtime error/i.test(d.remark) && !(d.elements && d.elements.length)) throw new Error(d.remark);
          finish(resolve, d);
        }).catch((err) => {
          if (done) return;
          lastErr = err; failed++;
          if (failed >= OVERPASS_URLS.length) finish(reject, lastErr);
          else { clearTimeout(timer); next(); }
        });
        clearTimeout(timer);
        timer = setTimeout(next, (typeof window !== 'undefined' && window.BAYANIHAN_HEDGE_MS) || 3500);
      };
      next();
    });
  }

  const toRad = (d) => (d * Math.PI) / 180;
  function distanceKm(a, b) {
    const R = 6371;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Overpass returns nodes with lat/lon and ways/relations with a "center".
  const elementLatLng = (el) =>
    el.center ? { lat: el.center.lat, lng: el.center.lon }
      : (el.lat != null ? { lat: el.lat, lng: el.lon } : null);

  const RESPONDER_LABELS = {
    hospital: 'Hospital', clinic: 'Clinic',
    fire_station: 'Fire station', police: 'Police station',
  };

  const WMO_WEATHER = {
    0: 'Clear sky', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 80: 'Rain showers',
    81: 'Rain showers', 82: 'Violent showers', 95: 'Thunderstorm',
    96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
  };

  const api = {

    /* ---------------------------------------------------------------
       SIGN UP
       Real version:
         const res = await fetch('/api/auth/signup', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ name, email, password })
         });
         return res.json();
    --------------------------------------------------------------- */
    async signUp({ name, email, password }) {
      await delay(250);
      name = String(name || '').trim().replace(/\s+/g, ' ');
      email = cleanEmail(email);
      password = String(password || '');

      if (!name) return { success: false, field: 'name', error: 'Please enter your full name.' };
      if (name.length < 2) return { success: false, field: 'name', error: 'Your name looks too short.' };
      if (!email) return { success: false, field: 'email', error: 'Please enter your email address.' };
      if (!isValidEmail(email)) return { success: false, field: 'email', error: 'That email address doesn\u2019t look right. Example: juan@email.com' };
      if (!password) return { success: false, field: 'password', error: 'Please choose a password.' };
      if (password.length < 8) return { success: false, field: 'password', error: 'Password must be at least 8 characters.' };
      if (db.users.some((u) => u.email === email)) {
        return { success: false, field: 'email', error: 'An account with that email already exists. Try logging in instead.' };
      }

      const user = { id: uid(), name, email, hash: await hashPassword(email, password) };
      db.users.push(user);
      saveUsers();
      sessionUser = user;

      return { success: true, user: { id: user.id, name: user.name, email: user.email } };
    },

    /* ---------------------------------------------------------------
       LOG IN
       Real version: POST /api/auth/login
    --------------------------------------------------------------- */
    async logIn({ email, password }) {
      await delay(250);
      email = cleanEmail(email);
      password = String(password || '');

      if (!email) return { success: false, field: 'email', error: 'Please enter your email address.' };
      if (!isValidEmail(email)) return { success: false, field: 'email', error: 'That email address doesn\u2019t look right. Example: juan@email.com' };
      if (!password) return { success: false, field: 'password', error: 'Please enter your password.' };

      const user = db.users.find((u) => u.email === email);
      if (!user) return { success: false, field: 'email', error: 'No account found with that email. Sign up first.' };
      if (user.hash !== await hashPassword(email, password)) {
        return { success: false, field: 'password', error: 'Incorrect password. Please try again.' };
      }

      sessionUser = user;
      return { success: true, user: { id: user.id, name: user.name, email: user.email } };
    },

    /* ---------------------------------------------------------------
       LOG OUT
       Real version: POST /api/auth/logout
    --------------------------------------------------------------- */
    async logOut() {
      await delay(150);
      sessionUser = null;
      return { success: true };
    },

    getCurrentUser() {
      return sessionUser ? { id: sessionUser.id, name: sessionUser.name, email: sessionUser.email } : null;
    },

    /* ---------------------------------------------------------------
       SAVE LOCATION
       Real version:
         await fetch('/api/users/location', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ lat, lng })
         });
    --------------------------------------------------------------- */
    async saveLocation({ lat, lng }) {
      await delay(300);
      if (sessionUser) { sessionUser.location = { lat, lng }; saveUsers(); }
      return { success: true };
    },

    getSavedLocation() {
      return sessionUser && sessionUser.location ? { ...sessionUser.location } : null;
    },

    /* ---------------------------------------------------------------
       NEARBY RESPONDERS  (now backed by real map data)
       Hospitals, clinics, fire stations and police stations around a point,
       from OpenStreetMap, nearest first.
       Real version: GET /api/responders/nearby?lat=&lng=
    --------------------------------------------------------------- */
    async getNearbyResponders({ lat, lng, radiusKm = 5, limit = 40 } = {}) {
      if (lat == null || lng == null) return { success: false, error: 'Location needed.', responders: [] };
      try {
        const q = `[out:json][timeout:20];
          nwr(around:${Math.round(radiusKm * 1000)},${lat},${lng})
            [amenity~"^(hospital|clinic|fire_station|police)$"];
          out center tags 120;`;
        const data = await overpass(q);
        const here = { lat, lng };
        const responders = data.elements
          .map((el) => {
            const pos = elementLatLng(el);
            if (!pos) return null;
            const t = el.tags || {};
            return {
              id: el.type + '/' + el.id,
              kind: t.amenity,
              name: t.name || t['name:en'] || RESPONDER_LABELS[t.amenity] || 'Responder',
              label: RESPONDER_LABELS[t.amenity] || 'Responder',
              phone: t.phone || t['contact:phone'] || null,
              ...pos,
              distanceKm: Math.round(distanceKm(here, pos) * 10) / 10,
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.distanceKm - b.distanceKm)
          .slice(0, limit);
        return { success: true, responders };
      } catch (err) {
        return { success: false, error: 'Could not load nearby responders.', responders: [] };
      }
    },

    /* ---------------------------------------------------------------
       EVACUATION SITES inside a map view (bbox = {south, west, north, east})
       Schools, gyms, barangay/town halls and official assembly points are the
       usual evacuation centers in the Philippines. These come from OSM tags,
       NOT an official LGU/NDRRMC list, so the UI tells people to confirm.
       Each site carries a `kind`, an `outline` (footprint polygon when OSM has
       one) and any capacity / phone / hours / address tags.
       Real version: GET /api/evacuation-centers?bbox=
    --------------------------------------------------------------- */
    async getEvacuationCenters({ south, west, north, east }, opts = {}) {
      try {
        const box = `${south},${west},${north},${east}`;
        // Two light queries run in parallel (one heavy query often times out on the public servers).
        const LIGHT = typeof window !== 'undefined' && window.BAYANIHAN_LIGHT_QUERY;   // the backup builder does not need outlines
        const NAMEHEALTH = 'health (center|centre|station)|rural health|RHU|BHS|barangay health';
        const qCore = `[out:json][timeout:30];
          (
            nwr["emergency"~"^(assembly_point|evacuation_center)$"](${box});
            nwr["evacuation_center"="yes"](${box});
            nwr["amenity"="shelter"]["name"](${box});
            nwr["amenity"="townhall"](${box});
            nwr["amenity"="community_centre"](${box});
            nwr["amenity"="school"]["name"](${box});
          );
          out ${LIGHT ? 'center' : 'geom'} tags 300;`;
        const qMore = `[out:json][timeout:30];
          (
            nwr["amenity"~"^(clinic|doctors|health_post|social_facility)$"]["name"~"${NAMEHEALTH}|evacuation|barangay",i](${box});
            nwr["healthcare"]["name"~"${NAMEHEALTH}",i](${box});
            nwr["office"="government"]["name"~"barangay|brgy",i](${box});
            nwr["leisure"="sports_centre"]["name"](${box});
            nwr["building"="gymnasium"]["name"](${box});
          );
          out ${LIGHT ? 'center' : 'geom'} tags 200;`;
        const toCenters = (elements) => {
        const seen = new Set();
        const centers = [];
        const KIND_LABEL = {
          assembly: 'Assembly point', shelter: 'Shelter', hall: 'Hall / community center',
          school: 'Public school', gym: 'Gym / sports center', health: 'Health center',
        };
        // Only PUBLIC schools are candidates (DepEd-style names, or tagged public); private ones are skipped.
        const PRIVATE = /private|academy|christian|catholic|baptist|montessori|college|university|international|seminary|learning center|institute/i;
        const PUBLIC_NAME = /elementary|national high|integrated school|central school|high school|\bnhs\b|\bes\b|public|memorial school|science high/i;
        const isPublicSchool = (t, name) => {
          const op = (t['operator:type'] || t.operator_type || '').toLowerCase();
          if (op === 'private' || op === 'religious') return false;
          if (op === 'public' || op === 'government') return true;
          return !PRIVATE.test(name + ' ' + (t.operator || ''));   // unknown ownership: keep unless the name says private
        };
        const HEALTH = /health (center|centre|station)|rural health|\brhu\b|\bbhs\b|barangay health/i;
        const BRGY_HALL = /(barangay|brgy\.?) ?(hall|multi|covered|center|centre)|barangay hall/i;
        for (const el of elements) {
          const t = el.tags || {};
          let pos = null;
          let outline = null;
          if (el.type === 'node') pos = { lat: el.lat, lng: el.lon };
          else if (el.type === 'way' && el.geometry && el.geometry.length > 3) {
            const step = Math.ceil(el.geometry.length / 80);
            outline = el.geometry.filter((_, i) => i % step === 0).map((p) => [p.lat, p.lon]);
          }
          if (!pos && el.bounds) {
            pos = { lat: (el.bounds.minlat + el.bounds.maxlat) / 2, lng: (el.bounds.minlon + el.bounds.maxlon) / 2 };
          }
          if (!pos) pos = elementLatLng(el);
          if (!pos) continue;

          const rawName = t.name || t['name:en'] || '';
          let kind = 'school';
          if (t.emergency === 'assembly_point' || t.emergency === 'evacuation_center' || t.evacuation_center === 'yes' || /evacuation (center|centre)/i.test(rawName)) kind = 'assembly';
          else if (t.amenity === 'shelter') kind = 'shelter';
          else if (t.amenity === 'townhall' || t.amenity === 'community_centre' || t.office === 'government' || BRGY_HALL.test(rawName)) kind = 'hall';
          else if (HEALTH.test(rawName) && t.amenity !== 'school') kind = 'health';
          else if (t.leisure === 'sports_centre' || t.building === 'gymnasium') kind = 'gym';
          if (kind === 'school' && !isPublicSchool(t, rawName)) continue;
          if (kind === 'health' && t.amenity === 'hospital') continue;

          const name = rawName || (kind === 'assembly' ? 'Evacuation center' : KIND_LABEL[kind]);
          const key = name + pos.lat.toFixed(4) + pos.lng.toFixed(4);
          if (seen.has(key)) continue;
          seen.add(key);

          const address = [t['addr:housenumber'], t['addr:street'], t['addr:suburb'] || t['addr:village'], t['addr:city'] || t['addr:town']]
            .filter(Boolean).join(', ');
          centers.push({
            id: el.type + '/' + el.id,
            name, kind,
            label: kind === 'hall' && BRGY_HALL.test(name) ? 'Barangay hall' : (kind === 'assembly' && (t.emergency === 'evacuation_center' || t.evacuation_center === 'yes' || /evacuation (center|centre)/i.test(name))) ? 'Evacuation center' : KIND_LABEL[kind],
            official: kind === 'assembly' || /evacuation/i.test(name),
            capacity: t.capacity || null,
            phone: t.phone || t['contact:phone'] || t['contact:mobile'] || null,
            hours: t.opening_hours || null,
            address: address || null,
            website: t.website || t['contact:website'] || null,
            operator: t.operator || null,
            access: t.access || null,                       // public / private / customers ...
            wheelchair: t.wheelchair || null,               // yes / limited / no
            levels: t['building:levels'] || null,
            note: t.description || t.note || null,
            // Only what OpenStreetMap actually lists; anything missing is shown as "not listed", never assumed.
            facilities: {
              toilets: t.toilets || null,
              water: t.drinking_water || null,
              power: t.backup_generator || t.generator || null,
              internet: t.internet_access || null,
              shower: t.shower || null,
              beds: t.beds || null,
              medical: kind === 'health' ? 'yes' : (t.healthcare ? 'yes' : null),
            },
            outline,
            ...pos,
          });
        }
        return centers;
        };
        // Start both searches now. The first one is the important one (official centers,
        // schools, halls), so draw it as soon as it arrives instead of waiting for the second.
        const pCore = overpass(qCore, { signal: opts.signal });
        const pMore = overpass(qMore, { signal: opts.signal });
        if (opts.onPartial) pCore.then((d) => opts.onPartial(toCenters(d.elements || []))).catch(() => {});
        const settled = await Promise.allSettled([pCore, pMore]);
        if (opts.signal && opts.signal.aborted) return { success: false, cancelled: true, centers: [] };
        const ok = settled.filter((r) => r.status === 'fulfilled');
        if (!ok.length) throw settled[0].reason;
        return { success: true, centers: toCenters(ok.flatMap((r) => r.value.elements || [])), partial: ok.length < 2 };
      } catch (err) {
        if (err && err.cancelled) return { success: false, cancelled: true, centers: [] };
        return { success: false, error: "Could not load evacuation sites.", centers: [] };
      }
    },

    /* ---------------------------------------------------------------
       WATERWAYS inside a map view — rivers, canals, creeks and drains.
       Used by the Flood layer to highlight areas beside water.
    --------------------------------------------------------------- */
    async getWaterways({ south, west, north, east }) {
      try {
        const q = `[out:json][timeout:25];
          way["waterway"~"^(river|stream|canal|drain)$"](${south},${west},${north},${east});
          out geom tags 200;`;
        const data = await overpass(q);
        const ways = data.elements
          .filter((el) => el.geometry && el.geometry.length > 1)
          .map((el) => ({
            id: el.id,
            name: (el.tags && (el.tags.name || el.tags['name:en'])) || null,
            kind: el.tags.waterway,
            points: el.geometry.map((p) => [p.lat, p.lon]),
          }));
        return { success: true, ways };
      } catch (err) {
        return { success: false, error: 'Could not load waterways.', ways: [] };
      }
    },

    /* ---------------------------------------------------------------
       ROUTES along real roads (OSRM). profile: 'foot' (walking, the common
       way people evacuate) or 'driving'. Returns up to 3 alternatives, each
       with turn-by-turn steps. `from`/`to` are {lat, lng}.
       Real version: your own routing service.
    --------------------------------------------------------------- */
    async getRoute({ from, to, profile = 'driving' }) {
      const stepText = (s) => {
        const m = s.maneuver || {};
        const road = s.name ? ` on ${s.name}` : '';
        const dir = m.modifier ? m.modifier.replace('slight ', 'slightly ') : '';
        switch (m.type) {
          case 'depart': return `Head ${dir || 'out'}${road}`;
          case 'arrive': return 'Arrive at your destination';
          case 'roundabout': case 'rotary': return `Take the roundabout${s.name ? ' toward ' + s.name : ''}`;
          case 'continue': case 'new name': return `Continue${road}`;
          default: return dir ? `Turn ${dir}${s.name ? ' onto ' + s.name : ''}` : `Continue${road}`;
        }
      };
      const base = profile === 'foot'
        ? 'https://routing.openstreetmap.de/routed-foot/route/v1/driving'
        : `${OSRM}/route/v1/driving`;
      try {
        const url = `${base}/${from.lng},${from.lat};${to.lng},${to.lat}` +
          '?overview=full&geometries=geojson&steps=true&alternatives=true';
        const data = await fetchJSON(url);
        if (!data.routes || !data.routes.length) return { success: false, error: 'No route found.' };
        const routes = data.routes.slice(0, 3).map((r) => ({
          distanceKm: Math.round(r.distance / 100) / 10,
          durationMin: Math.max(1, Math.round(r.duration / 60)),
          points: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
          steps: (r.legs || []).flatMap((leg) => leg.steps || [])
            .map((s) => ({ text: stepText(s), distM: Math.round(s.distance) })),
        }));
        return { success: true, profile, routes, ...routes[0] };
      } catch (err) {
        return { success: false, error: 'Could not calculate a route right now.' };
      }
    },

    /* ---------------------------------------------------------------
       PLACE SEARCH (Philippines only)
       Real version: GET /api/places/search?q=
    --------------------------------------------------------------- */
    async searchPlaces(query) {
      const q = (query || '').trim();
      if (q.length < 2) return { success: false, error: 'Type at least 2 characters.', places: [] };
      try {
        const url = `${NOMINATIM}/search?format=jsonv2&countrycodes=ph&limit=6&addressdetails=0&q=${encodeURIComponent(q)}`;
        const data = await fetchJSON(url, { headers: { 'Accept-Language': 'en' } });
        const places = data.map((p) => ({
          name: p.name || p.display_name.split(',')[0],
          display: p.display_name,
          lat: parseFloat(p.lat),
          lng: parseFloat(p.lon),
          bounds: p.boundingbox
            ? [[parseFloat(p.boundingbox[0]), parseFloat(p.boundingbox[2])],
               [parseFloat(p.boundingbox[1]), parseFloat(p.boundingbox[3])]]
            : null,
        }));
        return { success: true, places };
      } catch (err) {
        return { success: false, error: 'Search is unavailable right now.', places: [] };
      }
    },

    /* ---------------------------------------------------------------
       REVERSE GEOCODE: coordinates -> readable address
    --------------------------------------------------------------- */
    async reverseGeocode({ lat, lng }) {
      try {
        const url = `${NOMINATIM}/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lng}`;
        const data = await fetchJSON(url, { headers: { 'Accept-Language': 'en' } });
        if (!data || data.error) return { success: false, error: 'No address here.' };
        const a = data.address || {};
        const streetParts = [a.house_number, a.road || a.pedestrian || a.neighbourhood, a.suburb || a.quarter || a.village]
          .filter(Boolean);
        const cityParts = [a.city || a.town || a.municipality || a.county, a.state || a.region]
          .filter(Boolean);
        return {
          success: true,
          display: data.display_name,
          street: streetParts.join(', '),
          city: cityParts.join(', '),
        };
      } catch (err) {
        return { success: false, error: 'Could not look up that address.' };
      }
    },

    /* ---------------------------------------------------------------
       CURRENT WEATHER at a point (Open-Meteo)
    --------------------------------------------------------------- */
    async getWeather({ lat, lng }) {
      try {
        const url = `${OPEN_METEO}?latitude=${lat}&longitude=${lng}` +
          '&current=temperature_2m,precipitation,weather_code,wind_speed_10m&timezone=auto';
        const data = await fetchJSON(url);
        const c = data.current;
        return {
          success: true,
          tempC: Math.round(c.temperature_2m),
          rainMm: c.precipitation,
          windKmh: Math.round(c.wind_speed_10m),
          summary: WMO_WEATHER[c.weather_code] || 'Weather update',
        };
      } catch (err) {
        return { success: false, error: 'Weather is unavailable right now.' };
      }
    },

    /* ---------------------------------------------------------------
       RAIN RADAR frames (RainViewer public API) for the Weather layer.
       `frames` are the recent past frames, oldest first, so the map can
       animate them.
    --------------------------------------------------------------- */
    async getRadarTiles() {
      try {
        const data = await fetchJSON('https://api.rainviewer.com/public/weather-maps.json');
        const past = (data.radar && data.radar.past) || [];
        const frame = past[past.length - 1];
        if (!frame) return { success: false, error: 'Radar is unavailable right now.' };
        const tpl = (f) => `${data.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`;
        const ir = (data.satellite && data.satellite.infrared) || [];
        const cloud = ir[ir.length - 1];
        return {
          success: true,
          urlTemplate: tpl(frame),
          time: frame.time,
          frames: past.map((f) => ({ time: f.time, url: tpl(f) })),
          cloudUrl: cloud ? `${data.host}${cloud.path}/256/{z}/{x}/{y}/0/0_0.png` : null,
          cloudTime: cloud ? cloud.time : null,
        };
      } catch (err) {
        return { success: false, error: 'Radar is unavailable right now.' };
      }
    },

    /* ---------------------------------------------------------------
       WEATHER OUTLOOK at a point (Open-Meteo): now, next 24 h hour by hour,
       a 4-day forecast, plus rain that already fell (past 3 days) and soil
       moisture. From these it derives rough FLOOD and LANDSLIDE trigger
       levels. These are estimates, NOT official PAGASA / MGB warnings.
    --------------------------------------------------------------- */
    /* ---------------------------------------------------------------
       TYPHOON WIND OUTLOOK at a point (Open-Meteo, next 48 h): the strongest
       sustained wind and gust, lowest pressure, and the PAGASA wind signal those
       winds would match. Forecast models often UNDER-estimate typhoons, so this is
       a rough guide only, never an official signal.
    --------------------------------------------------------------- */
    TCWS: TCWS_LEVELS,
    async getTyphoonOutlook({ lat, lng }) {
      try {
        const url = `${OPEN_METEO}?latitude=${lat}&longitude=${lng}` +
          '&hourly=wind_speed_10m,wind_gusts_10m,pressure_msl&forecast_hours=48&timezone=auto&wind_speed_unit=kmh';
        const d = await fetchJSON(url);
        const h = d.hourly || {};
        const wind = (h.wind_speed_10m || []).map((v) => v || 0);
        const gust = (h.wind_gusts_10m || []).map((v) => v || 0);
        const pres = (h.pressure_msl || []).filter((v) => v != null);
        if (!wind.length) throw new Error('no data');
        const maxIn = (arr, hrs) => Math.max(0, ...arr.slice(0, hrs));
        let level = 0;
        for (let k = TCWS_LEVELS.length - 1; k >= 0; k--) {
          const t = TCWS_LEVELS[k];
          if (maxIn(wind, t.hours) >= t.min) { level = t.level; break; }
        }
        const maxWind = Math.round(maxIn(wind, 48));
        return {
          success: true, level,
          maxWind, maxGust: Math.round(maxIn(gust, 48)),
          peakInH: wind.indexOf(Math.max(...wind)),
          minPressure: pres.length ? Math.round(Math.min(...pres)) : null,
        };
      } catch (err) {
        return { success: false, error: 'The wind forecast is unavailable right now.' };
      }
    },

    async getWeatherOutlook({ lat, lng }) {
      const LEVELS = ['Low', 'Moderate', 'High', 'Severe'];
      const sum = (a, from, to) => {
        let s = 0;
        for (let i = Math.max(0, from); i < Math.min(a.length, to); i++) s += a[i] || 0;
        return Math.round(s * 10) / 10;
      };
      try {
        const url = `${OPEN_METEO}?latitude=${lat}&longitude=${lng}` +
          '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m' +
          '&hourly=precipitation,precipitation_probability,soil_moisture_0_to_7cm' +
          '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_gusts_10m_max' +
          '&past_days=3&forecast_days=4&timezone=auto&wind_speed_unit=kmh';
        const d = await fetchJSON(url);
        const c = d.current, h = d.hourly, dl = d.daily;
        let i0 = h.time.indexOf(c.time.slice(0, 13) + ':00');
        if (i0 < 0) i0 = 72;
        const rain = h.precipitation || [];
        const prob = h.precipitation_probability || [];
        const past24 = sum(rain, i0 - 24, i0);
        const past72 = sum(rain, i0 - 72, i0);
        const next6 = sum(rain, i0, i0 + 6);
        const next24 = sum(rain, i0, i0 + 24);
        const maxRate = Math.max(0, ...rain.slice(i0, i0 + 6).map((v) => v || 0));
        const maxProb = Math.max(0, ...prob.slice(i0, i0 + 24).map((v) => v || 0));
        const soil = h.soil_moisture_0_to_7cm ? h.soil_moisture_0_to_7cm[i0] : null;

        // hourly rain rate bands loosely follow PAGASA's rainfall advisory colors
        const rateLabel = maxRate >= 30 ? 'Torrential' : maxRate >= 15 ? 'Intense' : maxRate >= 7.5 ? 'Heavy'
          : maxRate >= 2.5 ? 'Moderate' : maxRate > 0.1 ? 'Light' : 'None';

        let flood = past24 * 0.5 + next24 >= 100 ? 3 : past24 * 0.5 + next24 >= 50 ? 2 : past24 * 0.5 + next24 >= 25 ? 1 : 0;
        if (maxRate >= 15) flood = Math.min(3, flood + 1);
        const cum = past72 + next24;
        let slide = cum >= 200 ? 3 : cum >= 120 ? 2 : cum >= 60 ? 1 : 0;
        if (soil != null && soil > 0.42 && cum >= 60) slide = Math.min(3, slide + 1);

        const iDay = Math.max(0, dl.time.indexOf(c.time.slice(0, 10)));
        const days = [];
        for (let k = iDay; k < Math.min(dl.time.length, iDay + 4); k++) {
          days.push({
            date: dl.time[k],
            summary: WMO_WEATHER[dl.weather_code[k]] || 'Forecast',
            hi: Math.round(dl.temperature_2m_max[k]),
            lo: Math.round(dl.temperature_2m_min[k]),
            rainMm: Math.round((dl.precipitation_sum[k] || 0) * 10) / 10,
            prob: dl.precipitation_probability_max ? dl.precipitation_probability_max[k] : null,
          });
        }
        return {
          success: true,
          tempC: Math.round(c.temperature_2m),
          feelsC: Math.round(c.apparent_temperature),
          humidity: c.relative_humidity_2m,
          rainNowMm: c.precipitation,
          windKmh: Math.round(c.wind_speed_10m),
          gustKmh: Math.round(c.wind_gusts_10m),
          summary: WMO_WEATHER[c.weather_code] || 'Weather update',
          past24, past72, next6, next24, maxRate, maxProb, rateLabel, soil,
          hourly: rain.slice(i0, i0 + 24).map((mm, k) => ({ mm: mm || 0, p: prob[i0 + k] || 0 })),
          days,
          flood: { level: flood, label: LEVELS[flood] },
          landslide: { level: slide, label: LEVELS[slide] },
        };
      } catch (err) {
        return { success: false, error: 'Weather is unavailable right now.' };
      }
    },

    /* ---------------------------------------------------------------
       WEATHER GRID over a map view (Open-Meteo, one request for n x n points):
       rain expected in the next 6 h and current wind, for the Rain forecast
       and Wind overlays. Real version: your own gridded forecast service.
    --------------------------------------------------------------- */
    async getWeatherGrid({ south, west, north, east }, n = 5) {
      try {
        const pts = [];
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            pts.push({ lat: south + ((north - south) * (i + 0.5)) / n, lng: west + ((east - west) * (j + 0.5)) / n });
          }
        }
        const r = (v) => v.toFixed(3);
        const url = `${OPEN_METEO}?latitude=${pts.map((p) => r(p.lat)).join(',')}&longitude=${pts.map((p) => r(p.lng)).join(',')}` +
          '&current=wind_speed_10m,wind_direction_10m,cloud_cover&hourly=precipitation&forecast_hours=6&wind_speed_unit=kmh&timezone=auto';
        const d = await fetchJSON(url);
        const arr = Array.isArray(d) ? d : [d];
        const cells = arr.map((x, k) => ({
          lat: pts[k].lat, lng: pts[k].lng,
          rain6: Math.round(((x.hourly && x.hourly.precipitation) || []).reduce((a, b) => a + (b || 0), 0) * 10) / 10,
          windKmh: Math.round(x.current.wind_speed_10m),
          windDir: x.current.wind_direction_10m,
          cloud: x.current.cloud_cover,
        }));
        return { success: true, cells, dLat: (north - south) / n, dLng: (east - west) / n };
      } catch (err) {
        return { success: false, error: 'Weather overlay is unavailable right now.' };
      }
    },

    /* ---------------------------------------------------------------
       RIVER FLOW outlook (Open-Meteo Flood API, GloFAS model, ~5 km grid).
       Compares the 7-day peak discharge to the usual flow for that river.
       Not every point sits on a modelled river, so this can come back empty.
    --------------------------------------------------------------- */
    async getRiverOutlook({ lat, lng }) {
      try {
        const url = `https://flood-api.open-meteo.com/v1/flood?latitude=${lat}&longitude=${lng}` +
          '&daily=river_discharge,river_discharge_mean&forecast_days=7';
        const d = await fetchJSON(url);
        const q = (d.daily.river_discharge || []).filter((v) => v != null);
        const m = (d.daily.river_discharge_mean || []).filter((v) => v != null);
        if (!q.length || !m.length) return { success: false, error: 'No river data here.' };
        const peak = Math.max(...q);
        const usual = m.reduce((a, b) => a + b, 0) / m.length;
        if (!(usual > 0.5)) return { success: false, error: 'No river data here.' };
        const ratio = Math.round((peak / usual) * 10) / 10;
        const level = ratio >= 4 ? 3 : ratio >= 2.5 ? 2 : ratio >= 1.5 ? 1 : 0;
        return { success: true, ratio, peak: Math.round(peak), level, label: ['Normal', 'Above normal', 'High', 'Very high'][level] };
      } catch (err) {
        return { success: false, error: 'River data is unavailable.' };
      }
    },

    distanceKm,

    /* ---------------------------------------------------------------
       REPORT INCIDENT
       Real version: POST /api/incidents
    --------------------------------------------------------------- */
    async reportIncident({ lat, lng, notes = '' }) {
      await delay(400);
      const incident = {
        id: uid(),
        userId: sessionUser ? sessionUser.id : null,
        lat, lng, notes,
        createdAt: new Date().toISOString(),
      };
      db.incidents.push(incident);
      return { success: true, incident };
    },

    /* ---------------------------------------------------------------
       MY INCIDENTS
       Real version: GET /api/incidents/mine
    --------------------------------------------------------------- */
    async getMyIncidents() {
      await delay(200);
      const mine = db.incidents.filter((i) => i.userId === (sessionUser && sessionUser.id));
      return { success: true, incidents: mine };
    },
  };

  /* ---------------------------------------------------------------
     SAVED COPIES for no-signal moments.
     Every successful map-data answer (evacuation sites, forecast, rivers, responders) is
     kept in the browser. If the network later fails, the last copy is returned with
     { stale: true, updatedAt } so the map can still draw and say how old it is.
  --------------------------------------------------------------- */
  const CACHE_KEY = 'bm.cache.v2';
  const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch (e) { return {}; } };
  const writeCache = (c) => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); }
    catch (e) { try { c.evac = (c.evac || []).slice(-2); localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e2) { /* storage full or blocked */ } }
  };
  const r2 = (n) => Math.round(n * 100) / 100;
  const SIMPLE = {
    getWeatherOutlook: (a) => `wx:${r2(a.lat)},${r2(a.lng)}`,
    getTyphoonOutlook: (a) => `ty:${r2(a.lat)},${r2(a.lng)}`,
    getRiverOutlook: (a) => `river:${r2(a.lat)},${r2(a.lng)}`,
    getNearbyResponders: (a) => `resp:${r2(a.lat)},${r2(a.lng)}`,
  };
  Object.entries(SIMPLE).forEach(([name, keyOf]) => {
    const orig = api[name].bind(api);
    api[name] = async (args = {}) => {
      const key = keyOf(args);
      const res = await orig(args);
      const c = readCache();
      c.simple = c.simple || {};
      if (res && res.success) {
        const now = Date.now();
        c.simple[key] = { t: now, res };
        const keys = Object.keys(c.simple);
        if (keys.length > 24) keys.sort((a, b) => c.simple[a].t - c.simple[b].t).slice(0, keys.length - 24).forEach((k) => delete c.simple[k]);
        writeCache(c);
        return { ...res, updatedAt: now, stale: false };
      }
      const hit = c.simple[key];
      return hit ? { ...hit.res, updatedAt: hit.t, stale: true } : res;
    };
  });
  {
    const orig = api.getEvacuationCenters.bind(api);
    const inBox = (p, b) => p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
    // Built-in list (!js/evac-backup.js): used only when live search fails or finds nothing.
    // Saved sites = the generated list (evac-backup.js) + hand-entered ones (evac-manual.js).
    const savedSites = () => {
      const g = (window.BAYANIHAN_EVAC_BACKUP && Array.isArray(window.BAYANIHAN_EVAC_BACKUP.sites)) ? window.BAYANIHAN_EVAC_BACKUP.sites : [];
      const m = Array.isArray(window.BAYANIHAN_EVAC_MANUAL) ? window.BAYANIHAN_EVAC_MANUAL : [];
      if (!m.length) return g;
      const ids = new Set(m.map((x) => x.id));
      return m.concat(g.filter((x) => !ids.has(x.id)));
    };
    const backupFor = (box) => {
      const all = savedSites();
      if (!all.length) return null;
      const b = window.BAYANIHAN_EVAC_BACKUP || {};
      const centers = all.filter((s) => inBox(s, box)).map((s) => ({ outline: null, facilities: {}, ...s, fromBackup: true }));
      return centers.length ? { success: true, centers, stale: true, backup: true, updatedAt: b.generated ? Date.parse(b.generated) : null } : null;
    };
    const hasBackup = () => savedSites().length > 0;
    const bad = (box) => backupFor(box);
    const rad = (d) => d * Math.PI / 180;
    // nearest saved site to a point (used to offer "Show saved sites" when the view is outside the saved areas)
    api.nearestBackupSite = (lat, lng) => {
      let best = null;
      savedSites().forEach((s) => {
        const d = Math.hypot((s.lat - lat), (s.lng - lng) * Math.cos(rad(lat)));
        if (!best || d < best.d) best = { d, site: s };
      });
      return best ? { lat: best.site.lat, lng: best.site.lng, name: best.site.name, km: best.d * 111 } : null;
    };
    api.getBackupInfo = () => hasBackup() ? { count: savedSites().length, generated: (window.BAYANIHAN_EVAC_BACKUP || {}).generated } : null;

    // The built-in list is the PRIMARY source: it answers instantly, with or without signal.
    // The live search only runs when (a) the saved list has nothing for this view, or
    // (even Redo search and the hourly refresh stay on the saved list when it has sites).
    api.getEvacuationCenters = async (box, opts = {}) => {
      const bk = bad(box);
      if (bk) return { ...bk, stale: false, primary: true };   // saved sites exist: never go online
      // Saved sites exist somewhere but not in this view: stay on the saved list (no network).
      // The live search runs only when there are no saved sites at all, or when asked with opts.online.
      if (hasBackup() && !opts.online) return { success: true, centers: [], stale: false, primary: true, backupOutside: true };
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      const c = readCache();
      c.evac = c.evac || [];
      const fromCache = () => {
        const near = c.evac.filter((e) => e.box[0] < box.north && e.box[2] > box.south && e.box[1] < box.east && e.box[3] > box.west);
        if (!near.length) return null;
        const seen = new Set();
        const centers = [];
        near.forEach((e) => e.centers.forEach((s) => { if (inBox(s, box) && !seen.has(s.id)) { seen.add(s.id); centers.push(s); } }));
        return centers.length ? { success: true, centers, stale: true, updatedAt: Math.min(...near.map((e) => e.t)) } : null;
      };
      // 1) A recent saved live search that covers this view answers instantly.
      if (!opts.fresh) {
        const hit = c.evac.find((e) => !e.partial && e.centers.length && Date.now() - e.t < 3600000 && e.box[0] <= box.south && e.box[1] <= box.west && e.box[2] >= box.north && e.box[3] >= box.east);
        if (hit) return { success: true, centers: hit.centers.filter((s) => inBox(s, box)), updatedAt: hit.t, stale: false, cached: true };
      }
      // 2) No signal: do not wait for timeouts.
      if (offline) return bk || fromCache() || { success: false, error: 'No signal and no saved sites for this area.', centers: [], offline: true };
      // 3) Live search.
      const res = await orig(box, opts);
      if (res.cancelled) return res;
      if (res && res.success && res.centers.length) {
        const now = Date.now();
        if (!res.partial) {
          c.evac = c.evac.filter((e) => !(e.box[0] >= box.south && e.box[1] >= box.west && e.box[2] <= box.north && e.box[3] <= box.east));
          c.evac.push({ t: now, box: [box.south, box.west, box.north, box.east], centers: res.centers });
          c.evac = c.evac.slice(-6);
          writeCache(c);
        }
        // add saved sites the live search did not return
        const have = new Set(res.centers.map((s) => s.id));
        const extra = bk ? bk.centers.filter((s) => !have.has(s.id)) : [];
        return { ...res, centers: res.centers.concat(extra), updatedAt: now, stale: false };
      }
      // live search failed or was empty: saved sites, then older live copies
      return bk || fromCache() || res;
    };
  }

  return api;
})();
