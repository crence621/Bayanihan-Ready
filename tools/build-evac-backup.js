#!/usr/bin/env node
/* Builds !js/evac-backup.js: a built-in list of evacuation sites the app falls back on when the
   live search fails (no signal, busy servers) or finds nothing.

   Usage:
     node tools/build-evac-backup.js                 # all areas listed below
     node tools/build-evac-backup.js "Guiuan"        # only areas whose name contains the text
     node tools/build-evac-backup.js --bbox 14.60,121.07,14.70,121.13 --name "My barangay"
     node tools/build-evac-backup.js "Guiuan" --merge   # keep the sites already in the file and add these

   It uses the same search and rules as the app (official centers, public schools, barangay
   halls, health centers, gyms from OpenStreetMap), so the list matches what the map shows.
   Run it with internet access, then ship the generated file. Re-run now and then to refresh. */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

// Samar island scope. [name, south, west, north, east]. Each box is about 11 km across (about 0.1 degree),
// centered on the town. Add more towns here, or use --bbox for one-off areas.
const AREAS = [
  ['Balangiga, Eastern Samar', 11.398, 125.334, 11.498, 125.434],
  ['Borongan City, Eastern Samar', 11.557, 125.382, 11.657, 125.482],
  ['Guiuan, Eastern Samar', 10.983, 125.672, 11.083, 125.772],
  ['Oras, Eastern Samar', 12.100, 125.383, 12.200, 125.483],
  ['Dolores, Eastern Samar', 11.990, 125.430, 12.090, 125.530],
  ['Basey, Samar', 11.230, 125.020, 11.330, 125.120],
  ['Marabut, Samar', 11.070, 125.170, 11.170, 125.270],
  ['Catbalogan City, Samar', 11.725, 124.836, 11.825, 124.936],
  ['Calbayog City, Samar', 12.017, 124.547, 12.117, 124.647],
];

(async () => {
  const merge = process.argv.includes('--merge');
  const args = process.argv.slice(2).filter((a) => a !== '--merge' && a !== '--no-split');
  let areas = AREAS;
  const bi = args.indexOf('--bbox');
  if (bi >= 0) {
    const [s, w, n, e] = args[bi + 1].split(',').map(Number);
    const ni = args.indexOf('--name');
    areas = [[ni >= 0 ? args[ni + 1] : 'Custom area', s, w, n, e]];
  } else if (args.length) {
    areas = AREAS.filter((a) => a[0].toLowerCase().includes(args.join(' ').toLowerCase()));
    if (!areas.length) { console.error('No area matches that text.'); process.exit(1); }
  }

  if (typeof fetch !== 'function') {
    console.error(`This needs Node 18 or newer (you have ${process.version}). Install the LTS version from nodejs.org and try again.`);
    process.exit(1);
  }
  // Wrap fetch: send a proper User-Agent (some Overpass servers refuse unnamed clients) and
  // print WHY a server failed, so "failed (skipped)" is no longer a mystery.
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const host = new URL(url).host;
    try {
      const res = await realFetch(url, { ...opts, headers: { 'User-Agent': 'BayanihanReadyBackupBuilder/1.0', Accept: 'application/json', ...(opts.headers || {}) } });
      if (!res.ok) console.log(`\n    ${host}: HTTP ${res.status}${res.status === 429 ? ' (too many requests, server is busy)' : res.status === 504 ? ' (server timed out)' : ''}`);
      else res.clone().json().then((d) => { if (d && d.remark) console.log(`\n    ${host}: ${d.remark}`); }).catch(() => {});
      return res;
    } catch (e) {
      const why = (e.cause && (e.cause.code || e.cause.message)) || e.message;
      console.log(`\n    ${host}: ${why}`);
      throw e;
    }
  };

  // Load the app's API in Node (it is a plain browser script).
  global.window = global;
  // Patient settings for slow connections: long timeouts, one server at a time, lighter queries.
  global.BAYANIHAN_OVERPASS_TIMEOUT_MS = 90000;
  global.BAYANIHAN_HEDGE_MS = 45000;
  global.BAYANIHAN_LIGHT_QUERY = true;
  const store = {};
  global.localStorage = { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } };
  const code = fs.readFileSync(path.join(root, '!js/api.js'), 'utf8');
  const API = new Function(code + '\nreturn BayanihanAPI;')();

  // Small searches succeed where big ones time out: split every area into 4 quarters.
  if (!process.argv.includes('--no-split')) {
    areas = areas.flatMap(([name, s, w, n, e]) => {
      const mLat = (s + n) / 2; const mLng = (w + e) / 2;
      return [['NW', mLat, w, n, mLng], ['NE', mLat, mLng, n, e], ['SW', s, w, mLat, mLng], ['SE', s, mLng, mLat, e]]
        .map(([q, s2, w2, n2, e2]) => [`${name} [${q}]`, s2, w2, n2, e2]);
    });
  }
  const seen = new Map();
  // --merge: start from the sites already saved in the backup file (newer downloads replace same-id sites).
  const file = path.join(root, '!js/evac-backup.js');
  if (merge && fs.existsSync(file)) {
    try {
      const sandbox = { window: {} };
      new Function('window', fs.readFileSync(file, 'utf8'))(sandbox.window);
      const old = (sandbox.window.BAYANIHAN_EVAC_BACKUP || {}).sites || [];
      old.forEach((c) => seen.set(c.id, c));
      console.log(`Keeping ${old.length} sites already in the backup file.`);
    } catch (e) { console.log('Could not read the existing backup file; continuing without it.'); }
  }
  for (const [name, south, west, north, east] of areas) {
    process.stdout.write(`${name} ... `);
    let res;
    for (let attempt = 1; attempt <= 3; attempt++) {
      res = await API.getEvacuationCenters({ south, west, north, east }, { fresh: true });
      if (res.success && !res.partial && res.centers.length) break;
      console.log(`    retrying in ${5 * attempt} s (attempt ${attempt} of 3)`); await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
    if (!res.success) { console.log('failed (skipped)'); continue; }
    res.centers.forEach((c) => { if (!seen.has(c.id)) seen.set(c.id, c); });
    console.log(res.centers.length + ' sites' + (res.partial ? ' (partial)' : ''));
    await new Promise((r) => setTimeout(r, 1500));     // be kind to the public servers
  }

  // Compact: keep a point, drop outlines and empty fields.
  const sites = [...seen.values()].map((c) => {
    const o = {};
    Object.entries(c).forEach(([k, v]) => {
      if (k === 'outline' || k === 'distKm' || k === 'risk') return;
      if (v == null || v === '' || (typeof v === 'object' && !Array.isArray(v) && !Object.values(v).some((x) => x != null))) return;
      o[k] = k === 'lat' || k === 'lng' ? +v.toFixed(5) : v;
    });
    return o;
  }).sort((a, b) => a.name.localeCompare(b.name));

  if (!sites.length) { console.error('\nNo sites were downloaded, so the file was not changed. Check your internet connection and try again.'); process.exit(1); }
  const out = { generated: new Date().toISOString(), source: 'OpenStreetMap contributors (ODbL)', sites };
  fs.writeFileSync(file, '/* Generated by tools/build-evac-backup.js. Do not edit by hand. */\nwindow.BAYANIHAN_EVAC_BACKUP = ' + JSON.stringify(out) + ';\n');
  console.log(`\nWrote ${sites.length} sites (${Math.round(fs.statSync(file).size / 1024)} KB) to:\n${file}\nIt is one long line of data, so it may look odd in an editor. That is normal.`);
})();
