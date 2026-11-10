/* Evacuation site capacity and "is it full?" status.
   Each site can have: capacity (max people), occupants (people inside now) and closed.
     - full      occupants >= capacity, or the site is marked closed
     - filling   80% or more of capacity used
     - open      room left
     - unknown   no headcount yet (the site is still offered, with a note)
   Where the numbers come from, in order:
     1. Updates entered in the app (site details > "Update headcount"). Saved on this device only.
     2. BAYANIHAN_EVAC_CAPACITY below: hand-entered by the barangay / LGU and shipped with the app.
        Edit this list to publish a new headcount to everyone.
     3. Demo storm: made-up numbers for sites that have none, so the feature can be shown.
     4. The OpenStreetMap "capacity" tag: size only, no headcount.
   Route finding skips every site that is full or closed. */
window.BAYANIHAN_EVAC_CAPACITY = {
  // 'site id': { capacity: 300, occupants: 120, closed: false, updated: '2026-11-10T08:00:00+08:00' },
  'manual/balangiga-central-es':  { capacity: 400, occupants: 150, updated: '2026-11-10T08:00:00+08:00' },
  'manual/balangiga-mdrrm':       { capacity: 60,  occupants: 60,  updated: '2026-11-10T08:00:00+08:00' },
};

window.BayanihanCapacity = (function () {
  const KEY = 'bayanihan.evacCapacity.v1';
  let local = {};
  let demo = false;
  try { local = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { local = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(local)); } catch (e) { /* private mode: keep in memory */ } };
  const num = (v) => { const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) && n > 0 ? n : null; };
  const hash = (s) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };

  function raw(c) {
    const shipped = (window.BAYANIHAN_EVAC_CAPACITY || {})[c.id];
    const mine = local[c.id];
    const rec = mine || shipped || null;
    if (rec) return { capacity: num(rec.capacity) || num(c.capacity), occupants: rec.occupants == null ? null : Math.max(0, +rec.occupants), closed: !!rec.closed, updated: rec.updated || null, source: mine ? 'device' : 'barangay' };
    const cap = num(c.capacity);
    if (demo) {          // made-up headcounts so the demo shows full / filling / open sites
      const h = hash(c.id), size = cap || [150, 250, 400, 600][h % 4], r = h % 10;
      const pct = r < 3 ? 1 : r < 5 ? 0.86 : r < 8 ? 0.4 : 0.15;
      return { capacity: size, occupants: Math.round(size * pct), closed: false, updated: null, source: 'demo' };
    }
    return cap ? { capacity: cap, occupants: null, closed: false, updated: null, source: 'osm' } : null;
  }

  function status(c) {
    const r = raw(c);
    if (!r) return { state: 'unknown', capacity: null, occupants: null, left: null, pct: null, closed: false, source: null, updated: null };
    let state = 'unknown', left = null, pct = null;
    if (r.closed) state = 'closed';
    else if (r.capacity && r.occupants != null) {
      left = Math.max(0, r.capacity - r.occupants);
      pct = Math.min(100, Math.round((r.occupants / r.capacity) * 100));
      state = left === 0 ? 'full' : pct >= 80 ? 'filling' : 'open';
    }
    return { state, capacity: r.capacity, occupants: r.occupants, left, pct, closed: r.closed, source: r.source, updated: r.updated };
  }
  const isFull = (c) => { const s = status(c).state; return s === 'full' || s === 'closed'; };

  return {
    status, isFull,
    setDemo(v) { demo = !!v; },
    // clear = forget the device update (falls back to the shipped list)
    set(id, { capacity, occupants, closed }) {
      local[id] = { capacity: num(capacity), occupants: occupants === '' || occupants == null ? null : Math.max(0, parseInt(occupants, 10) || 0), closed: !!closed, updated: new Date().toISOString() };
      save();
    },
    clear(id) { delete local[id]; save(); },
    label(st) {
      return { full: 'Full', closed: 'Closed', filling: 'Almost full', open: 'Has space', unknown: 'Space unknown' }[st.state];
    },
    line(st) {
      if (st.state === 'closed') return 'Closed';
      if (st.state === 'unknown') return st.capacity ? `Capacity ${st.capacity}, headcount not reported` : 'Capacity not listed';
      return st.state === 'full' ? `Full: ${st.occupants} / ${st.capacity}` : `${st.left} spots left (${st.occupants} / ${st.capacity})`;
    },
  };
})();
