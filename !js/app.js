(() => {
  const screens = document.querySelectorAll('.screen');

  // Real maps (Leaflet). null if Leaflet failed to load, so the rest of the app still works.
  const BM = typeof BayanihanMaps !== 'undefined' ? BayanihanMaps : null;

  function showScreen(name) {
    screens.forEach((s) => s.classList.toggle('is-active', s.dataset.screen === name));
    if (name === 'signup' || name === 'login') {          // start each visit with a clean form
      document.querySelectorAll('.form-error').forEach((x) => { if (x.id === 'signup-error' || x.id === 'login-error') { x.hidden = true; x.textContent = ''; } });
    }
  }

  // Any element with data-goto="screenName" navigates on click.
  document.querySelectorAll('[data-goto]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      showScreen(el.dataset.goto);
    });
  });

  function setError(el, message) {
    if (!message) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = message;
  }

  function formatCoords(lat, lng) {
    const fmt = (v) => Math.abs(v).toFixed(4);
    return `${fmt(lat)}°${lat >= 0 ? 'N' : 'S'}  ${fmt(lng)}°${lng >= 0 ? 'E' : 'W'}`;
  }

  /* --------------------------- SIGN UP / LOGIN ---------------------------- */
  const signupForm = document.getElementById('signup-form');
  const signupError = document.getElementById('signup-error');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');

  // Show / hide password buttons
  document.querySelectorAll('.auth-form input[type="password"]').forEach((input) => {
    const wrap = input.closest('.input-wrap');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.textContent = 'Show';
    btn.setAttribute('aria-label', 'Show password');
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    wrap.appendChild(btn);
    input.classList.add('has-toggle');
  });

  function clearFieldErrors(form) { form.querySelectorAll('input').forEach((i) => i.removeAttribute('aria-invalid')); }
  // Show the message and put the cursor on the field that needs fixing.
  function failForm(form, errorEl, result) {
    setError(errorEl, result.error);
    clearFieldErrors(form);
    const input = result.field && form.querySelector(`[name="${result.field}"]`);
    if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
  }
  [signupForm, loginForm].forEach((f) => f.addEventListener('input', (e) => {
    e.target.removeAttribute('aria-invalid');
    setError(f === signupForm ? signupError : loginError, '');
  }));

  // One handler for both forms: never leaves the button stuck, whatever happens.
  function wireAuth(form, errorEl, call, busyText, onDone) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      setError(errorEl, '');
      clearFieldErrors(form);
      const submitBtn = form.querySelector('button[type="submit"]');
      const label = submitBtn.textContent;
      if (submitBtn.disabled) return;           // double tap / double Enter
      submitBtn.disabled = true;
      submitBtn.textContent = busyText;
      try {
        const result = await call(Object.fromEntries(new FormData(form).entries()));
        if (!result.success) { failForm(form, errorEl, result); return; }
        applyUserToUI(result.user);
        await onDone(result);
      } catch (err) {
        setError(errorEl, 'Something went wrong. Please try again.');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = label;
      }
    });
  }
  wireAuth(signupForm, signupError, (d) => BayanihanAPI.signUp(d), 'Creating account…', async () => { showScreen('location'); });
  wireAuth(loginForm, loginError, (d) => BayanihanAPI.logIn(d), 'Logging in…', async () => { await enterHome(); });

  document.getElementById('forgot-link').addEventListener('click', (e) => {
    e.preventDefault();
    setError(loginError, 'Password reset isn’t available yet. If you can’t log in, create a new account with a different email.');
  });

  function applyUserToUI(user) {
    document.getElementById('home-username').textContent = user.name;
    const accountName = document.getElementById('account-name');
    const accountEmail = document.getElementById('account-email');
    if (accountName) accountName.value = user.name;
    if (accountEmail) accountEmail.value = user.email;
  }

  // Social buttons are placeholders — wired for whenever real OAuth exists.
  document.querySelectorAll('.social').forEach((btn) => {
    btn.addEventListener('click', () => {
      alert(`Sign-in with ${btn.dataset.provider} isn't connected yet, backend + OAuth app doesnt exist.`);
    });
  });

  /* ------------------------------- LOCATION ------------------------------- */
  const allowLocationBtn = document.getElementById('allow-location');
  const coordsReadout = document.getElementById('coords-readout');
  const locationError = document.getElementById('location-error');

  // Use a position (GPS or chosen by hand) and move on to Home.
  async function useStartLocation(lat, lng, accuracy, manual) {
    coordsReadout.hidden = false;
    coordsReadout.textContent = formatCoords(lat, lng);
    await BayanihanAPI.saveLocation({ lat, lng });
    if (BM) {
      if (manual) BM.setManualPosition({ lat, lng });
      else { BM.setUserPosition({ lat, lng, accuracy }); BM.startTracking().catch(() => {}); }   // keep the blue dot live
    }
    const homeCoords = document.getElementById('home-coords');
    homeCoords.hidden = false;
    homeCoords.textContent = formatCoords(lat, lng);
    await enterHome();
  }

  function getPosition(opts) {
    return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, opts));
  }

  allowLocationBtn.addEventListener('click', async () => {
    setError(locationError, '');
    if (!('geolocation' in navigator)) {
      setError(locationError, 'This device or browser can’t share its location. Set it on the map instead.');
      return;
    }
    allowLocationBtn.disabled = true;
    allowLocationBtn.textContent = 'Locating…';
    try {
      let pos;
      try { pos = await getPosition({ enableHighAccuracy: true, timeout: 8000 }); }
      catch (err) {
        if (err && err.code === 1) throw err;                      // permission denied: don't retry
        pos = await getPosition({ enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });   // indoors: accept a rough fix
      }
      await useStartLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, false);
    } catch (err) {
      const denied = err && err.code === 1;
      setError(locationError, denied
        ? 'Location permission is blocked. Allow it in your browser settings, or set your location on the map.'
        : 'Couldn’t get a GPS fix. Move near a window and try again, or set your location on the map.');
    } finally {
      allowLocationBtn.disabled = false;
      allowLocationBtn.textContent = 'Allow';
    }
  });

  document.getElementById('skip-location').addEventListener('click', () => enterHome());
  document.getElementById('set-location-manual').addEventListener('click', () => {
    setError(locationError, '');
    openLocationSheet(setupLocTarget);
  });

  /* --------------------------------- HOME --------------------------------- */
  async function enterHome() {
    const user = BayanihanAPI.getCurrentUser();
    if (user) applyUserToUI(user);

    showScreen('home');
    setTab('home');
  }

  /* ------------------------------- TAB BAR --------------------------------- */
  const tabItems = document.querySelectorAll('.tab-item[data-tab-goto]');
  const tabPanels = document.querySelectorAll('.tab-panel');

  function setTab(name) {
    tabItems.forEach((t) => t.classList.toggle('is-active', t.dataset.tabGoto === name));
    tabPanels.forEach((p) => p.classList.toggle('is-active', p.dataset.tab === name));
  }

  tabItems.forEach((btn) => {
    btn.addEventListener('click', () => setTab(btn.dataset.tabGoto));
  });

  // Tab-bar shown on the Community Posts screen — it lives outside the
  // Home screen, so tapping it takes you back to Home on the right tab.
  document.querySelectorAll('.tab-item[data-community-tab-goto]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await enterHome();
      setTab(btn.dataset.communityTabGoto);
    });
  });

  /* ------------------------- EMERGENCIES FEED ------------------------------ */
  const TYPE_TITLES = {
    Flood: 'Flooded Area',
    Landslide: 'Landslide',
    Fire: 'Fire Emergency',
    Medical: 'Medical Emergency',
    Accident: 'Road Accident',
    Quake: 'Earthquake',
    Robbery: 'Robbery in Progress',
    Assault: 'Assault Reported',
    Other: 'Emergency Reported',
  };

  const TYPE_TIPS = {
    Landslide: [
      'Move away from the slope, the path of the slide and any rivers or creeks below it.',
      'Do not cross a road covered by soil, rocks or water. More ground may give way.',
      'Listen for rumbling, cracking trees or a sudden change in water color.',
      'Go to higher, flat, stable ground or the nearest evacuation center.',
    ],
    Flood: [
      'Move to higher ground and avoid walking or driving through floodwater.',
      'Stay away from downed power lines and submerged outlets.',
      'Keep emergency contacts and a flashlight within reach.',
      'Follow evacuation orders from local officials right away.',
    ],
    Medical: [
      'Stay calm and check yourself and others for injuries.',
      'Call Emergency Services — dial 911 for medical and police assistance.',
      'Do not move the injured person unless they are in immediate danger.',
      'Keep the area clear and wait for responders to arrive.',
    ],
    Fire: [
      'Get out immediately and stay low to avoid smoke.',
      'Do not use elevators — take the stairs.',
      'Call the fire department as soon as you are safe.',
      'Never go back inside for belongings.',
    ],
    default: [
      'Stay calm and check yourself and passengers for injuries.',
      'Move to safety if possible — pull to the side and turn on hazard lights.',
      'Call Emergency Services — dial 911 for medical and police assistance.',
      'Do not leave the scene until authorities arrive or it is safe to do so.',
    ],
  };

  function typeIconPath(type) {
    return `!assets/!buttons/${type || 'Other'}.png`;
  }

  // Seed data for "Reported by Others" — simulates reports from nearby
  // community members until a real backend/feed exists.
  const othersEmergencies = [
    {
      id: 'seed-1',
      type: 'Flood',
      title: 'Flooded Area',
      location: '6767, Buenavista-Lawaan Rd., Balangiga, Eastern Samar',
      lat: 11.1140, lng: 125.3830, minsAgo: 42,
      reporter: 'Resident, Balangiga', contact: '+63 917 555 0142',
      desc: 'A severe flooding incident has been reported in this area. Rising water levels have affected nearby homes and roads, posing risks to residents and travelers. Emergency services are urgently needed to assist with evacuation, provide medical aid, and ensure public safety.',
      images: ['!assets/!images/flood-rescue-1.png', '!assets/!images/flood-rescue-2.png'],
      // No sample audio file ships with this seed post yet — leave empty
      // so the player row stays hidden instead of showing a dead button.
      audios: [],
      mine: false,
    },
    {
      id: 'seed-2',
      type: 'Medical',
      title: 'Medical Emergency',
      location: 'Brgy. San Miguel, Basey City, Eastern Samar',
      lat: 11.2822, lng: 125.0689, minsAgo: 130,
      reporter: 'Resident, Basey', contact: '+63 917 555 0178',
      desc: 'A critical medical situation has been reported in this area. A resident is experiencing severe health complications and requires immediate assistance.',
      images: [],
      audios: [],
      mine: false,
    },
  ];

  const myEmergencies = [];

  // Community reports go onto the maps too (the Reports layer reads the same list).
  if (BM) {
    othersEmergencies.forEach((e) => {
      if (e.lat != null) BM.addIncident({ id: e.id, type: e.type, title: e.title, desc: e.desc, lat: e.lat, lng: e.lng, source: 'community', time: Date.now() - (e.minsAgo || 0) * 60000 });
    });
  }

  let currentSegment = 'mine';

  function renderEmergencyFeed() {
    const feed = document.getElementById('emergency-feed');
    const items = currentSegment === 'mine' ? myEmergencies : othersEmergencies;

    if (!items.length) {
      feed.innerHTML = `<p class="empty">${
        currentSegment === 'mine'
          ? 'No reports yet. Reports you send from the SOS button will show up here.'
          : 'No community reports nearby yet.'
      }</p>`;
      return;
    }

    feed.innerHTML = items
      .map(
        (item) => `
      <div class="emergency-card" role="button" tabindex="0" data-emergency-id="${item.id}">
        <div class="ec-top">
          <div class="loc-text">
            <img src="!assets/!buttons/Pin.png" class="loc-icon-img" alt="Location Pin">
            <span>${item.location}</span>
          </div>
          ${item.mine ? `<button class="ec-delete" type="button" data-delete-id="${item.id}" aria-label="Delete report">
            <svg viewBox="0 0 16 18" fill="none"><path d="M2 4h12M6 4V2.6A1.6 1.6 0 0 1 7.6 1h.8A1.6 1.6 0 0 1 10 2.6V4M12.6 4l-.6 11.4A1.6 1.6 0 0 1 10.4 17H5.6a1.6 1.6 0 0 1-1.6-1.6L3.4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>` : ''}
        </div>
        <span class="ec-icon-badge"><img src="${typeIconPath(item.type)}" alt=""></span>
        <p class="ec-title">${item.title}</p>
        ${statusChip(item.id)}
        <p class="ec-desc">${item.desc}</p>
      </div>`
      )
      .join('');

    feed.querySelectorAll('[data-delete-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.deleteId;
        const idx = myEmergencies.findIndex((i) => i.id === id);
        if (idx > -1) myEmergencies.splice(idx, 1);
        if (BM) BM.removeIncident(id);
        renderEmergencyFeed();
      });
    });

    feed.querySelectorAll('[data-emergency-id]').forEach((card) => {
      card.addEventListener('click', () => openEmergencyDetail(card.dataset.emergencyId));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openEmergencyDetail(card.dataset.emergencyId);
        }
      });
    });
  }

  renderEmergencyFeed();

  document.querySelectorAll('.segment-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.segment-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      currentSegment = btn.dataset.segment;
      renderEmergencyFeed();
    });
  });

  // --- Shared audio playback helper (used by the proof preview during a
  // report AND by the emergency detail screen once it's posted) ---
  const PLAY_ICON = '<svg viewBox="0 0 12 14" fill="currentColor"><path d="M1 1 11 7 1 13Z"/></svg>';
  const PAUSE_ICON = '<svg viewBox="0 0 12 14" fill="currentColor"><rect x="1" y="1" width="3.4" height="12"/><rect x="7.6" y="1" width="3.4" height="12"/></svg>';

  function formatAudioTime(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  // Only one clip should play at a time across the whole app.
  let currentlyPlayingAudio = null;

  // Wires a play/pause button to an <audio> element. Safe to call once per
  // (button, audio) pair — call again after changing audioEl.src to reset.
  function wireAudioButton(btn, audioEl, timeEl) {
    if (!btn || !audioEl) return;
    const setIcon = (playing) => { btn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON; };
    setIcon(false);

    audioEl.addEventListener('loadedmetadata', () => {
      if (timeEl && isFinite(audioEl.duration)) timeEl.textContent = formatAudioTime(audioEl.duration);
    });
    audioEl.addEventListener('timeupdate', () => {
      if (timeEl && !audioEl.paused) timeEl.textContent = formatAudioTime(audioEl.currentTime);
    });
    audioEl.addEventListener('play', () => {
      if (currentlyPlayingAudio && currentlyPlayingAudio !== audioEl) currentlyPlayingAudio.pause();
      currentlyPlayingAudio = audioEl;
      setIcon(true);
    });
    const resetIcon = () => {
      setIcon(false);
      if (timeEl && isFinite(audioEl.duration)) timeEl.textContent = formatAudioTime(audioEl.duration);
    };
    audioEl.addEventListener('pause', resetIcon);
    audioEl.addEventListener('ended', () => { audioEl.currentTime = 0; resetIcon(); });

    btn.onclick = () => {
      if (audioEl.paused) audioEl.play().catch(() => {});
      else audioEl.pause();
    };
  }

  // The detail screen's player is a single static element — wire it once,
  // then just swap its src whenever a different report is opened.
  const detailAudioBtn = document.getElementById('detail-audio-play-btn');
  const detailAudioEl = document.getElementById('detail-audio-el');
  const detailAudioTime = document.getElementById('detail-audio-time');
  wireAudioButton(detailAudioBtn, detailAudioEl, detailAudioTime);

  /* ------------------- HOTLINES, CONTACT NO. AND RESPONDER REPLIES ------------------- */
  // National hotlines. Please verify these (and add your local DRRMO / MDRRMO numbers) before release.
  const DEFAULT_HOTLINES = [
    { id: 'd911', name: 'Emergency (police, fire, medical)', number: '911', desc: 'National emergency hotline', types: ['all'] },
    { id: 'd117', name: 'Philippine National Police', number: '117', desc: 'Crime, robbery, assault', types: ['Robbery', 'Assault', 'Accident'] },
    { id: 'dbfp', name: 'Bureau of Fire Protection', number: '(02) 8426-0219', desc: 'Fires and rescue', types: ['Fire'] },
    { id: 'd143', name: 'Philippine Red Cross', number: '143', desc: 'Medical help, rescue, relief', types: ['Medical', 'Flood', 'Quake', 'Landslide', 'Accident'] },
    { id: 'dndr', name: 'NDRRMC Operations Center', number: '(02) 8911-1406', desc: 'Floods, landslides, earthquakes', types: ['Flood', 'Landslide', 'Quake'] },
    { id: 'ddoh', name: 'DOH Health Emergency', number: '1555', desc: 'Health concerns and advice', types: ['Medical'] },
  ];
  const LOCAL_KEY = 'bm.localHotline.v1';      // old single local hotline; migrated into the list below
  const HOTLINES_KEY = 'bm.hotlines.v2';
  // The list is editable: every hotline (built-in or added) can be edited or removed.
  let HOTLINES = (() => {
    const saved = lsGetEarly(HOTLINES_KEY);
    if (Array.isArray(saved)) return saved;
    const list = DEFAULT_HOTLINES.map((h) => ({ ...h }));
    const old = lsGetEarly(LOCAL_KEY);
    if (old && old.number) list.push({ id: 'h' + Date.now().toString(36), name: old.name || 'Local hotline', number: old.number, desc: 'Your local hotline', types: ['all'] });
    return list;
  })();
  function lsGetEarly(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  const saveHotlines = () => { try { localStorage.setItem(HOTLINES_KEY, JSON.stringify(HOTLINES)); } catch (e) { /* storage blocked */ } };
  const tel = (n) => 'tel:' + String(n).replace(/[^\d+]/g, '');
  const escH = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
  const callBtn = (n, label) => `<a class="rsp-call" href="${tel(n)}" aria-label="Call ${escH(n)}"><svg viewBox="0 0 20 20" fill="none"><path d="M5.2 2.8 3.4 4.6c-.6.6-.7 1.5-.3 2.2a15 15 0 0 0 6.1 6.1c.7.4 1.6.3 2.2-.3l1.8-1.8-2.9-1.9-1.3 1.3a10 10 0 0 1-3.5-3.5l1.3-1.3L5.2 2.8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>${escH(label || 'Call')}</a>`;
  const hotlinesFor = (type) => HOTLINES.filter((h) => h.types.includes('all') || h.types.includes(type));

  // Responder profile (this device) and replies posted to emergencies.
  let responder = lsGet('bm.responder.v1', { on: false, name: '', agency: '', contact: '' });
  let responses = lsGet('bm.responses.v1', {});
  const STATUS = {
    acknowledged: { label: 'Responder acknowledged', short: 'Acknowledged', cls: 'is-ack' },
    enroute: { label: 'Responder on the way', short: 'On the way', cls: 'is-enroute' },
    onscene: { label: 'Responder on scene', short: 'On scene', cls: 'is-onscene' },
    resolved: { label: 'Resolved', short: 'Resolved', cls: 'is-resolved' },
  };
  const latestResponse = (id) => { const l = responses[id]; return l && l.length ? l[l.length - 1] : null; };
  function statusChip(id) {
    const r = latestResponse(id);
    return r ? `<span class="rsp-chip ${STATUS[r.status].cls}">${STATUS[r.status].short} · ${escH(r.agency || r.name)}</span>` : '<span class="rsp-chip is-wait">Waiting for a responder</span>';
  }
  const ago = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };

  function renderResponse(item) {
    const box = document.getElementById('detail-response');
    const list = responses[item.id] || [];
    if (!list.length) {
      box.innerHTML = '<div class="rsp-status is-wait"><b>Waiting for a responder</b><span>No responder has replied yet. If it is urgent, call a hotline below.</span></div>';
      return;
    }
    const last = list[list.length - 1];
    const eta = last.status === 'enroute' && last.eta ? ` · ETA about ${last.eta} min` : '';
    box.innerHTML = `<div class="rsp-status ${STATUS[last.status].cls}"><b>${STATUS[last.status].label}${eta}</b>
        <span>${escH(last.name)}${last.agency ? ' · ' + escH(last.agency) : ''}</span>
        ${last.contact ? callBtn(last.contact, 'Call responder') : ''}</div>
      <ol class="rsp-timeline">${list.slice().reverse().map((r) => `<li><b>${STATUS[r.status].short}</b> <i>${ago(r.t)}</i>${r.note ? `<p>${escH(r.note)}</p>` : ''}<small>${escH(r.name)}${r.agency ? ', ' + escH(r.agency) : ''}</small></li>`).join('')}</ol>`;
  }

  function renderContact(item) {
    const box = document.getElementById('detail-contact');
    const rows = [];
    if (item.contact) rows.push(`<div class="rsp-row"><div><b>${item.mine ? 'Your contact no.' : 'Reporter contact no.'}</b><span>${escH(item.contact)}${item.reporter && !item.mine ? ' · ' + escH(item.reporter) : ''}</span></div>${item.mine ? '' : callBtn(item.contact)}</div>`);
    else rows.push('<div class="rsp-row"><div><b>Reporter contact no.</b><span>Not provided</span></div></div>');
    hotlinesFor(item.type).forEach((h) => rows.push(`<div class="rsp-row"><div><b>${escH(h.name)}</b><span>Hotline ${escH(h.number)}</span></div>${callBtn(h.number)}</div>`));
    box.innerHTML = rows.join('');
  }

  let respondTarget = null, respondStatus = 'acknowledged';
  function setRespondStatus(st) {
    respondStatus = st;
    document.querySelectorAll('#respond-steps .rsp-step').forEach((b) => b.classList.toggle('is-active', b.dataset.status === st));
    document.getElementById('respond-eta-box').hidden = st !== 'enroute';
  }
  function renderRespondButton() {
    const btn = document.getElementById('detail-respond-btn');
    btn.hidden = !(responder.on && responder.name && respondTarget);
    document.getElementById('respond-form').hidden = true;
  }
  function paintDetailExtras(item) {
    respondTarget = item;
    renderResponse(item);
    renderContact(item);
    renderRespondButton();
  }

  document.getElementById('detail-respond-btn').addEventListener('click', () => {
    const f = document.getElementById('respond-form');
    f.hidden = !f.hidden;
    if (!f.hidden) { setRespondStatus('acknowledged'); document.getElementById('respond-error').hidden = true; f.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  });
  document.querySelectorAll('#respond-steps .rsp-step').forEach((b) => b.addEventListener('click', () => setRespondStatus(b.dataset.status)));
  document.getElementById('respond-send').addEventListener('click', () => {
    const item = respondTarget;
    if (!item) return;
    const err = document.getElementById('respond-error');
    const eta = parseInt(document.getElementById('respond-eta').value, 10);
    if (respondStatus === 'enroute' && !(eta > 0)) { err.textContent = 'Enter your estimated arrival time in minutes.'; err.hidden = false; return; }
    err.hidden = true;
    const entry = { t: Date.now(), status: respondStatus, name: responder.name, agency: responder.agency, contact: responder.contact,
      eta: respondStatus === 'enroute' ? eta : null, note: document.getElementById('respond-note').value.trim() };
    (responses[item.id] = responses[item.id] || []).push(entry);
    lsSet('bm.responses.v1', responses);
    document.getElementById('respond-note').value = '';
    document.getElementById('respond-eta').value = '';
    // the reporter gets a notification
    if (item.mine) {
      notifications.unshift({ icon: '!assets/!images/first-aid.png', title: STATUS[entry.status].label, body: `${entry.name}${entry.agency ? ', ' + entry.agency : ''}${entry.eta ? ` · ETA about ${entry.eta} min` : ''}`, emergencyId: item.id });
      renderNotifications();
      if (bellDot) bellDot.style.display = 'block';
    }
    paintDetailExtras(item);
    renderEmergencyFeed();
  });

  // Responder mode (Settings)
  const respToggle = document.getElementById('settings-responder');
  const respFields = document.getElementById('responder-fields');
  function paintResponderSettings() {
    respToggle.checked = !!responder.on;
    respFields.hidden = !responder.on;
    document.getElementById('responder-name').value = responder.name || '';
    document.getElementById('responder-agency').value = responder.agency || '';
    document.getElementById('responder-contact').value = responder.contact || '';
  }
  respToggle.addEventListener('change', () => {
    responder.on = respToggle.checked;
    respFields.hidden = !responder.on;
    lsSet('bm.responder.v1', responder);
  });
  document.getElementById('responder-save').addEventListener('click', () => {
    const err = document.getElementById('responder-error');
    const name = document.getElementById('responder-name').value.trim();
    const contact = document.getElementById('responder-contact').value.trim();
    if (!name) { err.textContent = 'Enter your name.'; err.hidden = false; return; }
    if (!/^[+\d][\d\s()-]{5,}$/.test(contact)) { err.textContent = 'Enter a valid contact number.'; err.hidden = false; return; }
    err.hidden = true;
    responder = { on: true, name, agency: document.getElementById('responder-agency').value.trim(), contact };
    lsSet('bm.responder.v1', responder);
    const b = document.getElementById('responder-save'); b.textContent = 'Saved ✓'; setTimeout(() => { b.textContent = 'Save responder details'; }, 1400);
  });
  paintResponderSettings();

  // Hotlines screen
  let hotlinesFrom = 'home';
  document.querySelectorAll('[data-goto="hotlines"]').forEach((el) => el.addEventListener('click', () => {
    const a = document.querySelector('.screen.is-active'); hotlinesFrom = a ? a.dataset.screen : 'home';
    hotlineEdit = null; renderHotlines();
  }, true));
  document.getElementById('hotlines-back-btn').addEventListener('click', () => showScreen(hotlinesFrom === 'hotlines' ? 'home' : hotlinesFrom));
  let hotlineEdit = null;   // id of the hotline being edited, 'new' for the add form, or null
  const PHONE_RE = /^[+\d][\d\s()-]{2,}$/;
  function hotlineForm(h, err) {
    const isNew = !h;
    return `<div class="rsp-local rsp-hl-form">
        <p class="rsp-form-title">${isNew ? 'Add a hotline' : 'Edit hotline'}</p>
        <div class="input-card-box"><input type="text" id="hl-name" placeholder="Name (e.g. Balangiga MDRRMO)" value="${escH(h && h.name)}"></div>
        <div class="input-card-box"><input type="tel" id="hl-number" placeholder="Number" inputmode="tel" value="${escH(h && h.number)}"></div>
        <div class="input-card-box"><input type="text" id="hl-desc" placeholder="Note (optional)" value="${escH(h && h.desc)}"></div>
        <p class="form-error" ${err ? '' : 'hidden'}>${escH(err)}</p>
        <button type="button" class="btn-primary-red" data-hl="save">${isNew ? 'Add hotline' : 'Save changes'}</button>
        ${isNew && !HOTLINES.length ? '' : '<button type="button" class="rsp-link-btn" data-hl="cancel">Cancel</button>'}
      </div>`;
  }
  function renderHotlines(err) {
    const rows = HOTLINES.map((h) => {
      if (hotlineEdit === h.id) return hotlineForm(h, err);
      return `<div class="rsp-row"><div><b>${escH(h.name)}</b><span>${escH(h.number)}${h.desc ? ' · ' + escH(h.desc) : ''}</span>
          <span class="rsp-hl-actions"><button type="button" class="rsp-link-btn" data-hl="edit" data-id="${escH(h.id)}">Edit</button><button type="button" class="rsp-link-btn is-danger" data-hl="remove" data-id="${escH(h.id)}">Remove</button></span></div>${callBtn(h.number)}</div>`;
    }).join('');
    const empty = HOTLINES.length ? '' : '<p class="rsp-hint">No hotlines saved. Add one below or restore the defaults.</p>';
    const form = hotlineEdit === 'new' ? hotlineForm(null, err)
      : `<button type="button" class="btn-primary-red" data-hl="add">+ Add a hotline</button>`;
    document.getElementById('hotline-list').innerHTML = rows + empty + form +
      '<button type="button" class="rsp-link-btn" data-hl="reset">Restore default hotlines</button>';
    document.getElementById('hotline-note').textContent = 'Tap Call to dial. Numbers can change, so please confirm local ones with your LGU.';
  }
  document.getElementById('hotline-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hl]');
    if (!b) return;
    const act = b.dataset.hl, id = b.dataset.id;
    if (act === 'add') { hotlineEdit = 'new'; renderHotlines(); }
    else if (act === 'edit') { hotlineEdit = id; renderHotlines(); }
    else if (act === 'cancel') { hotlineEdit = null; renderHotlines(); }
    else if (act === 'remove') {
      const h = HOTLINES.find((x) => x.id === id);
      if (h && confirm('Remove "' + h.name + '" from your hotlines?')) { HOTLINES = HOTLINES.filter((x) => x.id !== id); saveHotlines(); hotlineEdit = null; renderHotlines(); }
    } else if (act === 'reset') {
      if (confirm('Restore the default hotlines? Your added and edited hotlines will be replaced.')) { HOTLINES = DEFAULT_HOTLINES.map((x) => ({ ...x })); saveHotlines(); hotlineEdit = null; renderHotlines(); }
    } else if (act === 'save') {
      const name = document.getElementById('hl-name').value.trim();
      const number = document.getElementById('hl-number').value.trim();
      const desc = document.getElementById('hl-desc').value.trim();
      const bad = (m) => { renderHotlines(m); document.getElementById('hl-name').value = name; document.getElementById('hl-number').value = number; document.getElementById('hl-desc').value = desc; };
      if (!name) return bad('Enter a name for this hotline.');
      if (!PHONE_RE.test(number)) return bad('Enter a valid phone number.');
      if (hotlineEdit === 'new') HOTLINES.push({ id: 'h' + Date.now().toString(36), name, number, desc, types: ['all'] });
      else HOTLINES = HOTLINES.map((x) => (x.id === hotlineEdit ? { ...x, name, number, desc } : x));
      saveHotlines(); hotlineEdit = null; renderHotlines();
    }
  });
  /* ------------------- RECOVERY: I'M SAFE CHECK-IN + DAMAGE REPORTS ------------------- */
  // Everything is kept on this phone and works with no signal. "Text it" opens the phone's
  // messaging app with the message filled in, so it can go out over plain SMS.
  const CHECKIN_KEY = 'bm.checkins.v1';
  const DAMAGE_KEY = 'bm.damage.v1';
  const RC_CONTACT_KEY = 'bm.rc.contact.v1';
  const RC_STATUS = {
    safe: { label: "I'm safe", text: 'I am SAFE', cls: 'is-safe' },
    help: { label: 'I need help', text: 'I NEED HELP', cls: 'is-help' },
    evac: { label: 'At an evacuation site', text: 'I am SAFE at an evacuation site', cls: 'is-evac' },
  };
  const DMG_TYPES = ['House', 'Road or bridge', 'Electricity', 'Water supply', 'Farm or crops', 'Boat or fishing gear', 'School or public building', 'Other'];
  const DMG_SEV = ['Minor', 'Major', 'Destroyed'];
  const DMG_NEEDS = ['Food', 'Drinking water', 'Shelter materials', 'Medical help', 'Cash or livelihood aid', 'Clearing debris'];
  const rc = {
    seg: 'safe',
    safe: { status: 'safe', lat: null, lng: null },
    dmg: { type: '', sev: '', needs: [], lat: null, lng: null },
    msg: '',
  };
  const rcName = () => (document.getElementById('home-username') || {}).textContent || 'A resident';
  const mapLink = (lat, lng) => (lat != null ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}` : '');
  const rcClock = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

  function sendText(message, number) {
    const num = String(number || '').replace(/[^\d+]/g, '');
    if (num) { window.location.href = 'sms:' + num + (isiOS ? '&' : '?') + 'body=' + encodeURIComponent(message); return; }
    if (navigator.share) { navigator.share({ text: message }).catch(() => {}); return; }
    window.location.href = 'sms:' + (isiOS ? '&' : '?') + 'body=' + encodeURIComponent(message);
  }
  const checkinText = (e) => [
    `${rcName()}: ${RC_STATUS[e.status].text}.`,
    e.where ? `Where: ${e.where}.` : '',
    e.people ? `People with me: ${e.people}.` : '',
    e.note ? e.note : '',
    mapLink(e.lat, e.lng),
    `Sent ${rcClock(e.time)} via Bayanihan Ready`,
  ].filter(Boolean).join(' ');
  const damageText = (r) => [
    `DAMAGE REPORT from ${rcName()}: ${r.type}, ${r.sev.toLowerCase()}.`,
    r.where ? `Where: ${r.where}.` : '',
    r.desc ? `Details: ${r.desc}.` : '',
    r.needs.length ? `Needs: ${r.needs.join(', ')}.` : '',
    r.contact ? `Contact: ${r.contact}.` : '',
    mapLink(r.lat, r.lng),
    `Sent ${rcClock(r.time)} via Bayanihan Ready`,
  ].filter(Boolean).join(' ');

  const chips = (list, sel, act, multi) => `<div class="rc-chips" data-multi="${multi ? 1 : 0}">${list.map((x) =>
    `<button type="button" class="rc-chip ${(multi ? sel.includes(x) : sel === x) ? 'is-on' : ''}" data-rc="${act}" data-v="${escH(x)}" aria-pressed="${multi ? sel.includes(x) : sel === x}">${escH(x)}</button>`).join('')}</div>`;

  function whereBlock(prefix, d) {
    return `<p class="rc-label">Where are you?</p>
      <div class="input-card-box"><input type="text" id="${prefix}-where" placeholder="Barangay, purok, landmark or evacuation site" value="${escH(d.where || '')}"></div>
      <button type="button" class="rc-link" data-rc="gps" data-p="${prefix}">${d.lat != null ? 'Location saved. Update it' : 'Use my GPS location'}</button>`;
  }
  const contactBlock = (id, label) => `<p class="rc-label">${label}</p>
      <div class="input-card-box"><input type="tel" id="${id}" inputmode="tel" placeholder="Mobile number" value="${escH(lsGet(RC_CONTACT_KEY, ''))}"></div>`;

  function renderSafe() {
    const list = lsGet(CHECKIN_KEY, []);
    const last = list[0];
    const d = rc.safe;
    let latest = '';
    if (last) {
      const st = RC_STATUS[last.status];
      latest = `<div class="rc-latest ${st.cls}"><b>${escH(st.label)}</b><span>${escH(ago(last.time))}${last.where ? ' \u00b7 ' + escH(last.where) : ''}</span></div>`;
    }
    const helpBox = (last && last.status === 'help') || d.status === 'help'
      ? `<div class="rc-alert"><b>If you are in danger, call now.</b>
          <div class="rsp-hotlines">${HOTLINES.filter((h) => h.types.includes('all')).slice(0, 2).map((h) => `<div class="rsp-row"><div><b>${escH(h.name)}</b><span>${escH(h.number)}</span></div>${callBtn(h.number)}</div>`).join('')}</div>
          <button type="button" class="btn-primary-red" data-goto="report-emergency">Send an SOS report</button></div>` : '';
    const hist = list.slice(0, 5).map((e) => `<div class="rc-item"><div><b>${escH(RC_STATUS[e.status].label)}</b><span>${escH(rcClock(e.time))}${e.where ? ' \u00b7 ' + escH(e.where) : ''}${e.people ? ' \u00b7 ' + e.people + ' people' : ''}</span></div>
        <span class="rc-item-actions"><button type="button" class="rc-link" data-rc="send-checkin" data-id="${escH(e.id)}">Text</button><button type="button" class="rc-link is-danger" data-rc="del-checkin" data-id="${escH(e.id)}">Delete</button></span></div>`).join('');
    document.getElementById('recovery-body').innerHTML = `
      ${latest}
      <p class="rc-lead">Let your family and barangay know how you are. It saves on this phone and can be sent by text, with no internet needed.</p>
      <p class="rc-label">How are you?</p>
      <div class="rc-chips">${Object.entries(RC_STATUS).map(([k, v]) => `<button type="button" class="rc-chip big ${v.cls} ${d.status === k ? 'is-on' : ''}" data-rc="status" data-v="${k}" aria-pressed="${d.status === k}">${escH(v.label)}</button>`).join('')}</div>
      <div id="rc-help-slot">${helpBox}</div>
      ${whereBlock('rcs', d)}
      <p class="rc-label">People with you (including you)</p>
      <div class="input-card-box"><input type="number" id="rcs-people" min="1" max="99" inputmode="numeric" value="${escH(d.people || 1)}"></div>
      <p class="rc-label">Note (optional)</p>
      <div class="input-card-box"><input type="text" id="rcs-note" placeholder="e.g. House flooded, staying with relatives" value="${escH(d.note || '')}"></div>
      ${contactBlock('rcs-contact', 'Text to (family or barangay number)')}
      <p class="form-error" id="rc-error" ${rc.msg ? '' : 'hidden'}>${escH(rc.msg)}</p>
      <button type="button" class="btn-primary-red" data-rc="save-safe">Save check-in</button>
      <button type="button" class="rc-secondary" data-rc="send-safe">Save and text it</button>
      ${hist ? `<p class="rc-label">Recent check-ins</p>${hist}` : ''}`;
  }

  function renderDamage() {
    const list = lsGet(DAMAGE_KEY, []);
    const d = rc.dmg;
    const items = list.map((r) => `<div class="rc-item"><div><b>${escH(r.type)} \u00b7 ${escH(r.sev)}</b><span>${escH(rcClock(r.time))}${r.where ? ' \u00b7 ' + escH(r.where) : ''}${r.needs.length ? '<br>Needs: ' + escH(r.needs.join(', ')) : ''}${r.desc ? '<br>' + escH(r.desc) : ''}</span></div>
        <span class="rc-item-actions"><button type="button" class="rc-link" data-rc="send-dmg" data-id="${escH(r.id)}">Text</button><button type="button" class="rc-link is-danger" data-rc="del-dmg" data-id="${escH(r.id)}">Delete</button></span></div>`).join('');
    document.getElementById('recovery-body').innerHTML = `
      <p class="rc-lead">Record damage to your home, farm, boat or community so help and relief can be planned. Reports stay on this phone until you text them to your barangay or MDRRMO.</p>
      <p class="rc-label">What was damaged?</p>
      ${chips(DMG_TYPES, d.type, 'dtype', false)}
      <p class="rc-label">How bad is it?</p>
      ${chips(DMG_SEV, d.sev, 'sev', false)}
      ${whereBlock('rcd', d)}
      <p class="rc-label">What happened? (optional)</p>
      <div class="input-card-box"><textarea id="rcd-desc" rows="3" placeholder="e.g. Roof blown off, floodwater reached 1 m inside">${escH(d.desc || '')}</textarea></div>
      <p class="rc-label">Help needed (tap all that apply)</p>
      ${chips(DMG_NEEDS, d.needs, 'need', true)}
      ${contactBlock('rcd-contact', 'Contact number')}
      <p class="form-error" id="rc-error" ${rc.msg ? '' : 'hidden'}>${escH(rc.msg)}</p>
      <button type="button" class="btn-primary-red" data-rc="save-dmg">Save damage report</button>
      <button type="button" class="rc-secondary" data-rc="send-dmg-new">Save and text to barangay</button>
      ${items ? `<p class="rc-label">Saved reports (${list.length})</p>${items}` : ''}`;
  }

  function renderRecovery() {
    document.querySelectorAll('#recovery-segment .segment-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.seg === rc.seg));
    (rc.seg === 'safe' ? renderSafe : renderDamage)();
  }

  // pull what is typed in the form into the draft so nothing is lost on a redraw
  function rcReadForm() {
    const v = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    if (rc.seg === 'safe') {
      Object.assign(rc.safe, { where: v('rcs-where'), people: Math.max(1, parseInt(v('rcs-people'), 10) || 1), note: v('rcs-note') });
    } else {
      Object.assign(rc.dmg, { where: v('rcd-where'), desc: v('rcd-desc') });
    }
    const c = v(rc.seg === 'safe' ? 'rcs-contact' : 'rcd-contact');
    if (c) lsSet(RC_CONTACT_KEY, c);
    return c;
  }

  function rcSaveSafe() {
    const contact = rcReadForm();
    const d = rc.safe;
    const entry = { id: 'c' + Date.now().toString(36), status: d.status, where: d.where, people: d.people, note: d.note, lat: d.lat, lng: d.lng, time: Date.now() };
    const list = lsGet(CHECKIN_KEY, []);
    list.unshift(entry);
    lsSet(CHECKIN_KEY, list.slice(0, 30));
    return { entry, contact };
  }
  function rcSaveDamage() {
    const contact = rcReadForm();
    const d = rc.dmg;
    if (!d.type) { rc.msg = 'Choose what was damaged.'; return null; }
    if (!d.sev) { rc.msg = 'Choose how bad the damage is.'; return null; }
    if (!d.where && d.lat == null) { rc.msg = 'Say where the damage is, or use your GPS location.'; return null; }
    rc.msg = '';
    const rep = { id: 'd' + Date.now().toString(36), type: d.type, sev: d.sev, where: d.where || '', desc: d.desc || '', needs: d.needs.slice(), contact, lat: d.lat, lng: d.lng, time: Date.now() };
    const list = lsGet(DAMAGE_KEY, []);
    list.unshift(rep);
    lsSet(DAMAGE_KEY, list.slice(0, 100));
    rc.dmg = { type: '', sev: '', needs: [], lat: null, lng: null };   // fresh form for the next report
    return { rep, contact };
  }

  document.getElementById('recovery-segment').addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg]');
    if (!b) return;
    rcReadForm();
    rc.seg = b.dataset.seg; rc.msg = '';
    renderRecovery();
  });

  document.getElementById('recovery-body').addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');          // buttons drawn after load (e.g. Send an SOS report)
    if (go) { e.preventDefault(); showScreen(go.dataset.goto); return; }
    const b = e.target.closest('[data-rc]');
    if (!b) return;
    const act = b.dataset.rc, v = b.dataset.v, id = b.dataset.id;
    if (act === 'status') {
      rcReadForm(); rc.safe.status = v; renderSafe();
    } else if (act === 'dtype' || act === 'sev') {
      rcReadForm(); rc.dmg[act === 'dtype' ? 'type' : 'sev'] = v; rc.msg = ''; renderDamage();
    } else if (act === 'need') {
      rcReadForm();
      const n = rc.dmg.needs; const k = n.indexOf(v);
      if (k >= 0) n.splice(k, 1); else n.push(v);
      renderDamage();
    } else if (act === 'gps') {
      rcReadForm();
      const target = b.dataset.p === 'rcs' ? rc.safe : rc.dmg;
      if (!navigator.geolocation) { rc.msg = 'This phone cannot share its location here. Type where you are instead.'; rc.seg === 'safe' ? renderSafe() : renderDamage(); return; }
      b.textContent = 'Finding your location\u2026';
      navigator.geolocation.getCurrentPosition((pos) => {
        target.lat = +pos.coords.latitude.toFixed(5); target.lng = +pos.coords.longitude.toFixed(5);
        if (!target.where) target.where = `GPS ${target.lat}, ${target.lng}`;
        rc.msg = ''; rc.seg === 'safe' ? renderSafe() : renderDamage();
      }, () => {
        rc.msg = 'Could not get your location. Allow location access or type where you are.';
        rc.seg === 'safe' ? renderSafe() : renderDamage();
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    } else if (act === 'save-safe' || act === 'send-safe') {
      const r = rcSaveSafe();
      rc.msg = '';
      renderSafe();
      if (act === 'send-safe') sendText(checkinText(r.entry), r.contact);
    } else if (act === 'save-dmg' || act === 'send-dmg-new') {
      const r = rcSaveDamage();
      renderDamage();
      if (r && act === 'send-dmg-new') sendText(damageText(r.rep), r.contact);
    } else if (act === 'send-checkin') {
      const en = lsGet(CHECKIN_KEY, []).find((x) => x.id === id);
      if (en) sendText(checkinText(en), lsGet(RC_CONTACT_KEY, ''));
    } else if (act === 'send-dmg') {
      const r = lsGet(DAMAGE_KEY, []).find((x) => x.id === id);
      if (r) sendText(damageText(r), r.contact || lsGet(RC_CONTACT_KEY, ''));
    } else if (act === 'del-checkin') {
      if (confirm('Delete this check-in?')) { lsSet(CHECKIN_KEY, lsGet(CHECKIN_KEY, []).filter((x) => x.id !== id)); renderSafe(); }
    } else if (act === 'del-dmg') {
      if (confirm('Delete this damage report?')) { lsSet(DAMAGE_KEY, lsGet(DAMAGE_KEY, []).filter((x) => x.id !== id)); renderDamage(); }
    }
  });
  document.querySelectorAll('[data-goto="recovery"]').forEach((el) => el.addEventListener('click', () => { rc.msg = ''; renderRecovery(); }));

  renderHotlines();

  function openEmergencyDetail(id) {
    const item = [...myEmergencies, ...othersEmergencies].find((i) => i.id === id);
    if (!item) return;

    document.getElementById('detail-title').textContent = item.title;
    document.getElementById('detail-icon-img').src = typeIconPath(item.type);
    document.getElementById('detail-loc-text').textContent = item.location;
    document.getElementById('detail-desc').textContent = item.desc;

    const mediaBlock = document.getElementById('detail-media-block');
    const gallery = document.getElementById('detail-gallery');
    const images = item.images || [];
    const videos = item.videos || [];
    if (images.length || videos.length) {
      mediaBlock.hidden = false;
      gallery.innerHTML =
        images.map((src) => `<div class="dg-item"><img src="${src}" alt=""></div>`).join('') +
        videos
          .map(
            (src) =>
              `<div class="dg-item dg-item-video"><video src="${src}" controls playsinline preload="metadata"></video></div>`
          )
          .join('');
    } else {
      mediaBlock.hidden = true;
      gallery.innerHTML = '';
    }

    const audios = item.audios || [];
    const audioRow = document.getElementById('detail-audio-row');
    audioRow.hidden = !audios.length;
    if (audios.length) {
      if (detailAudioEl) {
        detailAudioEl.pause();
        detailAudioEl.src = audios[0];
        detailAudioEl.currentTime = 0;
        if (detailAudioTime) detailAudioTime.textContent = '';
      }
    } else if (detailAudioEl) {
      detailAudioEl.pause();
      detailAudioEl.removeAttribute('src');
      detailAudioEl.load();
    }

    const tips = TYPE_TIPS[item.type] || TYPE_TIPS.default;
    document.getElementById('detail-tips-heading').textContent = item.mine
      ? 'What to do next:'
      : "If you're near this emergency:";
    document.getElementById('detail-tips-list').innerHTML = tips.map((t) => `<li>${t}</li>`).join('');

    const mapBtn = document.getElementById('detail-map-btn');
    if (mapBtn) {
      mapBtn.hidden = item.lat == null || item.lng == null;
      mapBtn.dataset.id = item.id;
    }

    paintDetailExtras(item);
    showScreen('emergency-detail');
  }

  const detailMapBtn = document.getElementById('detail-map-btn');
  if (detailMapBtn) {
    detailMapBtn.addEventListener('click', async () => {
      if (detailAudioEl) detailAudioEl.pause();
      await enterHome();
      setTab('maps');
      setTimeout(() => { if (mainMap) mainMap.focusReport(detailMapBtn.dataset.id); }, 150);
    });
  }

  document.getElementById('detail-back-btn').addEventListener('click', async () => {
    if (detailAudioEl) detailAudioEl.pause();
    await enterHome();
    setTab('emergencies');
  });

  /* -------------------------------- SOS / COMMUNITY MODE -------------------------------- */
  document.getElementById('btn-community-mode').addEventListener('click', () => {
    showScreen('community-posts');
  });
  document.getElementById('btn-exit-community').addEventListener('click', async () => {
    await enterHome();
    setTab('emergencies');
  });

  /* ------------------------------ COMMUNITY POSTS --------------------------------- */
  const posts = [
    {
      id: 'post-1',
      name: 'John Park',
      initials: 'JP',
      date: '08-06-26',
      image: '!assets/!images/free-ddr5-ram.png',
      title: '🚨 Free DDR5 RAM for those who need it',
      desc: 'If you or someone you know needs a ram during this time of stock congestion. Please visit Pamantasan ng Lungsod ng Maynila for the ram (1 kit per person only), August 14-15 2026, 8am-7pm only.\n\nFor more info slide to my dms.',
    },
    {
      id: 'post-2',
      name: 'John Park',
      initials: 'JP',
      date: '08-03-26',
      image: '!assets/!images/free-food-alert.png',
      title: '🍕 Free Food Alert!',
      desc: 'Free meals available for anyone in need at the barangay hall today. Come by while supplies last — no questions asked.',
    },
  ];

  function renderPostFeed() {
    const feed = document.getElementById('post-feed');
    if (!posts.length) {
      feed.innerHTML = `<p class="empty">No community posts yet. Be the first to share something!</p>`;
      return;
    }
    feed.innerHTML = posts
      .map(
        (p) => `
      <article class="post-card">
        <div class="post-card-top">
          <span class="post-avatar">${p.initials}</span>
          <div class="post-author">
            <p class="post-name">${p.name}</p>
            <p class="post-date">${p.date}</p>
          </div>
          <button class="post-menu-btn" type="button" aria-label="Post options">⋮</button>
        </div>
        ${p.image ? `<img class="post-image" src="${p.image}" alt="">` : ''}
        <p class="post-title">${p.title}</p>
        <p class="post-desc">${p.desc}</p>
      </article>`
      )
      .join('');
  }
  renderPostFeed();

  document.getElementById('btn-new-post').addEventListener('click', () => {
    showScreen('create-post');
  });

  /* --------------------------- CREATE COMMUNITY POST ------------------------------ */
  const postMediaInput = document.getElementById('post-media-input');
  const postMediaPreview = document.getElementById('post-media-preview');
  const postTitleInput = document.getElementById('post-title-input');
  const postDescInput = document.getElementById('post-desc-input');
  const postLocText = document.getElementById('post-loc-text');
  const postError = document.getElementById('post-error');
  let newPostMedia = []; // data URLs picked for the post being composed

  function renderPostMediaPreview() {
    postMediaPreview.innerHTML = newPostMedia
      .map(
        (src, i) => `<div class="pmp-item"><img src="${src}" alt=""><button type="button" class="btn-remove-proof" data-remove-media="${i}" aria-label="Remove">✕</button></div>`
      )
      .join('');
    postMediaPreview.querySelectorAll('[data-remove-media]').forEach((btn) => {
      btn.addEventListener('click', () => {
        newPostMedia.splice(Number(btn.dataset.removeMedia), 1);
        renderPostMediaPreview();
      });
    });
  }

  postMediaInput.addEventListener('change', () => {
    const files = Array.from(postMediaInput.files || []);
    let pending = files.length;
    if (!pending) return;
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        newPostMedia.push(reader.result);
        renderPostMediaPreview();
      };
      reader.readAsDataURL(file);
    });
    postMediaInput.value = '';
  });

  const postChangeLocationBtn = document.getElementById('btn-post-change-location');
  if (postChangeLocationBtn) {
    postChangeLocationBtn.addEventListener('click', () => openLocationSheet(postLocText));
  }

  function resetPostForm() {
    newPostMedia = [];
    renderPostMediaPreview();
    postTitleInput.value = '';
    postDescInput.value = '';
    setError(postError, '');
  }

  document.getElementById('btn-submit-post').addEventListener('click', () => {
    const title = postTitleInput.value.trim();
    const desc = postDescInput.value.trim();

    if (!title || !desc) {
      setError(postError, 'Please add a title and description.');
      return;
    }

    const user = BayanihanAPI.getCurrentUser();
    const name = (user && user.name) || 'You';
    const initials = name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();

    posts.unshift({
      id: `post-${Date.now()}`,
      name,
      initials,
      date: new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }).replace(/\//g, '-'),
      image: newPostMedia[0] || '',
      title,
      desc,
    });

    renderPostFeed();
    resetPostForm();
    showScreen('community-posts');
  });

  /* ---------------------------- NOTIFICATIONS ------------------------------ */
  const BELL_SVG = '<svg viewBox="0 0 22 24" fill="none"><path d="M4 18v-6a7 7 0 0 1 14 0v6l2 2H2l2-2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8.5 21a2.5 2.5 0 0 0 5 0" stroke="currentColor" stroke-width="1.6"/></svg>';

  const notifications = [
    {
      icon: '!assets/!buttons/Flood.png',
      title: 'Flooded Area',
      body: 'The incident involved the vehicle MH 41 AK 6543….',
    },
    {
      icon: 'bell',
      title: 'Check Out New Community post!',
      body: 'Free DRRM available for those who needs.',
    },
    {
      icon: '!assets/!images/first-aid.png',
      title: 'I Need Sleep',
      body: 'uhhh',
    },
  ];

  const notifList = document.getElementById('notif-list');
  const bellDot = document.querySelector('.bell-dot');

  function renderNotifications() {
    notifList.innerHTML = notifications
      .map(
        (n, i) => `
      <div class="notif-item"${n.emergencyId || n.map ? ` data-notif-index="${i}" role="button" tabindex="0" style="cursor:pointer;"` : ''}>
        <span class="notif-icon">${n.icon === 'bell' ? BELL_SVG : `<img src="${n.icon}" alt="">`}</span>
        <div class="notif-text">
          <h4>${n.title}</h4>
          <p>${n.body}</p>
        </div>
      </div>`
      )
      .join('');
  }
  renderNotifications();

  async function openNotification(n) {
    if (!n) return;
    if (n.emergencyId) { openEmergencyDetail(n.emergencyId); return; }
    if (n.map) {                         // live flood / landslide alert: show it on the map
      await enterHome();
      setTab('maps');
      setTimeout(() => {
        if (!mainMap) return;
        mainMap.setMode(n.map.mode);
        mainMap.focusPoint(n.map.lat, n.map.lng, 16);
      }, 150);
    }
  }

  // Tapping a notification that's tied to a reported emergency jumps
  // straight to that emergency's detail screen.
  notifList.addEventListener('click', (e) => {
    const el = e.target.closest('[data-notif-index]');
    if (!el) return;
    const n = notifications[Number(el.dataset.notifIndex)];
    openNotification(n);
  });
  notifList.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('[data-notif-index]');
    if (!el) return;
    e.preventDefault();
    const n = notifications[Number(el.dataset.notifIndex)];
    openNotification(n);
  });

  document.getElementById('bell-btn').addEventListener('click', () => {
    if (bellDot) bellDot.style.display = 'none';
    showScreen('notifications');
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await BayanihanAPI.logOut();
    signupForm.reset();
    loginForm.reset();
    setError(signupError, '');
    setError(loginError, '');
    showScreen('opening');
  });

  /* --------------------------------- SOS ----------------------------------- */
  // The SOS button just navigates to the Report Emergency screen (via its
  // data-goto="report-emergency" attribute, handled by the generic listener
  // above). Actually filing the report now happens from that screen's own
  // "Submit Report" button — see REPORT EMERGENCY section below.

  /* --------------------------- REPORT EMERGENCY ---------------------------- */

  // Emergency type grid — single select.
  document.querySelectorAll('.type-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.type-card').forEach((b) => b.classList.remove('is-selected'));
      btn.classList.add('is-selected');
    });
  });

  // --- Select Location bottom sheet ---
  // Shared by Report Emergency and Setup SOS. Whichever "Change" button (or preview map)
  // opens it decides which on-screen location gets updated. The map is real: drag it,
  // search a place and pick a result, or tap "Use my location". The center pin is
  // reverse-geocoded into the address fields.
  const locationSheetOverlay = document.getElementById('location-sheet-overlay');
  const reportLocText = document.getElementById('report-loc-text');
  const sosLocText = document.getElementById('sos-loc-text');
  const locHouseInput = document.getElementById('loc-house-input');
  const locStreetInput = document.getElementById('loc-street-input');
  const locCityInput = document.getElementById('loc-city-input');
  const locSearchInput = document.getElementById('location-search-input');
  const locSearchForm = document.getElementById('location-search-form');
  const locResults = document.getElementById('location-search-results');
  const pickerAddress = document.getElementById('picker-address');
  const pickerLabel = document.getElementById('picker-label');
  const confirmLocBtn = document.getElementById('confirm-location-btn');

  // Hidden target used when the person sets their location from the first-run location screen.
  const setupLocTarget = document.createElement('span');
  setupLocTarget.hidden = true;
  document.body.appendChild(setupLocTarget);
  let locationSheetTarget = reportLocText;
  let picker = null;        // created the first time the sheet opens
  let pickedCoords = null;
  let pickedFrom = null;    // what the pin was last set by, so we don't lose a search result's name
  let addrToken = 0;

  const addrText = (rev) => [rev.street, rev.city].filter(Boolean).join(', ') || rev.display || '';

  async function fillAddressFrom(coords, keepName) {
    pickedCoords = coords;
    const tok = ++addrToken;
    confirmLocBtn.disabled = true;
    pickerLabel.textContent = 'Finding address…';
    pickerAddress.textContent = 'Finding address…';
    const rev = await BayanihanAPI.reverseGeocode(coords);
    if (tok !== addrToken) return; // the map moved again; ignore this answer
    confirmLocBtn.disabled = false;
    pickerLabel.textContent = 'Selected location';
    if (!rev.success) { pickerAddress.textContent = 'No address found here. You can type one below.'; return; }
    locStreetInput.value = rev.street || (keepName || '');
    locCityInput.value = rev.city || '';
    pickerAddress.textContent = addrText(rev) || keepName || 'Pinned location';
  }

  function ensurePicker() {
    if (!picker && BM) {
      picker = BM.createMiniMap(document.getElementById('picker-mini-map'), { onSettle: (c) => fillAddressFrom(c) });
    }
    return picker;
  }

  function showResults(items, message) {
    locResults.innerHTML = '';
    if (!items && !message) { locResults.hidden = true; return; }
    if (message) { const li = document.createElement('li'); li.className = 'is-empty'; li.textContent = message; locResults.appendChild(li); }
    (items || []).forEach((p) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      const t = document.createElement('strong'); t.textContent = p.name;
      const sub = document.createElement('span'); sub.textContent = p.display.split(',').slice(1, 4).join(',').trim();
      b.append(t, sub);
      b.addEventListener('click', () => {
        showResults(null);
        locSearchInput.value = p.name;
        if (picker) {
          picker.setView([p.lat, p.lng], 17);
          picker.map.invalidateSize();
          fillAddressFrom({ lat: p.lat, lng: p.lng }, p.name);   // the map's own "settle" event fills it too
        }
      });
      li.appendChild(b);
      locResults.appendChild(li);
    });
    locResults.hidden = false;
  }

  function openLocationSheet(targetEl) {
    locationSheetTarget = targetEl || reportLocText;
    locationSheetOverlay.classList.add('is-open');
    locSearchInput.value = '';
    showResults(null);
    locHouseInput.value = '';
    const p = ensurePicker();
    if (!p) return;
    // Start at the spot this field was last set to, otherwise at the person's position.
    const lat = parseFloat(locationSheetTarget.dataset.lat);
    const lng = parseFloat(locationSheetTarget.dataset.lng);
    const u = BM.getUser();
    const start = !isNaN(lat) && !isNaN(lng) ? { lat, lng } : u ? { lat: u.lat, lng: u.lng } : null;
    // The sheet was hidden, so Leaflet has no size yet: measure, then center.
    requestAnimationFrame(() => {
      p.map.invalidateSize();
      if (start) { p.setView([start.lat, start.lng], 17); fillAddressFrom(start); }
      else pickerLabel.textContent = 'Drag the map or search a place';
    });
  }
  function closeLocationSheet() { locationSheetOverlay.classList.remove('is-open'); }

  // Put a place into one of the two screens (text + preview map).
  const locTargets = new Map();   // text element -> { mini, label }
  function setLocation(el, { lat, lng, text, manual }) {
    el.textContent = text;
    el.dataset.lat = lat; el.dataset.lng = lng;
    if (manual) el.dataset.manual = '1'; else delete el.dataset.manual;
    const t = locTargets.get(el);
    if (t) {
      if (t.mini) { t.mini.setView([lat, lng], 17); t.mini.map.invalidateSize(); }
      if (t.label) t.label.textContent = manual ? 'Selected location' : 'You are here';
    }
  }

  // "Use my location": real GPS, not a hand-set spot.
  async function useMyLocation(el, labelEl, btn) {
    const old = labelEl && labelEl.textContent;
    if (labelEl) labelEl.textContent = 'Finding you…';
    if (btn) btn.disabled = true;
    try {
      const g = await BM.currentGps();
      const rev = await BayanihanAPI.reverseGeocode(g);
      setLocation(el, { lat: g.lat, lng: g.lng, text: rev.success ? addrText(rev) : formatCoords(g.lat, g.lng), manual: false });
      if (labelEl) labelEl.textContent = 'You are here';
    } catch (err) {
      if (labelEl) labelEl.textContent = old || 'Location unavailable';
      alert(BM.geoErrorText(err) + '\nYou can still tap Change and pick a place on the map.');
    } finally { if (btn) btn.disabled = false; }
  }

  document.getElementById('btn-change-location').addEventListener('click', () => openLocationSheet(reportLocText));
  const sosChangeLocationBtn = document.getElementById('btn-sos-change-location');
  if (sosChangeLocationBtn) sosChangeLocationBtn.addEventListener('click', () => openLocationSheet(sosLocText));
  document.getElementById('location-sheet-back').addEventListener('click', closeLocationSheet);
  // tapping the preview maps opens the picker too
  [['report-mini-tap', reportLocText], ['sos-mini-tap', sosLocText]].forEach(([id, el]) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => openLocationSheet(el));
  });

  confirmLocBtn.addEventListener('click', () => {
    const parts = [locHouseInput.value.trim(), locStreetInput.value.trim(), locCityInput.value.trim()].filter(Boolean);
    const c = picker ? picker.center() : pickedCoords;
    if (c && locationSheetTarget) {
      setLocation(locationSheetTarget, { lat: c.lat, lng: c.lng, text: parts.join(', ') || pickerAddress.textContent || formatCoords(c.lat, c.lng), manual: true });
    }
    closeLocationSheet();
    if (c && locationSheetTarget === setupLocTarget) useStartLocation(c.lat, c.lng, 20, true);
  });

  // Search a Philippine place or address (button, Enter key, or after a short pause in typing).
  async function runLocationSearch() {
    const q = locSearchInput.value.trim();
    if (q.length < 2) { showResults(null); return; }
    showResults([], 'Searching…');
    const res = await BayanihanAPI.searchPlaces(q);
    if (locSearchInput.value.trim() !== q) return;
    if (!res.success) showResults([], res.error || 'Search is unavailable right now.');
    else if (!res.places.length) showResults([], 'No match in the Philippines. Try a street, barangay or landmark.');
    else showResults(res.places);
  }
  locSearchForm.addEventListener('submit', (e) => { e.preventDefault(); runLocationSearch(); });
  let searchTimer = null;
  locSearchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    if (locSearchInput.value.trim().length < 3) { showResults(null); return; }
    searchTimer = setTimeout(runLocationSearch, 800);
  });

  // "Use my location" inside the sheet: fly the map to the real GPS fix.
  document.getElementById('track-location-btn').addEventListener('click', async () => {
    if (!picker) return;
    pickerLabel.textContent = 'Finding you…';
    try { await picker.flyToUser(); }
    catch (err) { pickerLabel.textContent = 'Location blocked or unavailable'; pickerAddress.textContent = BM.geoErrorText(err); }
  });

  // Previews on the two screens
  const reportMini = BM ? BM.createMiniMap(document.getElementById('report-mini-map'), { interactive: false }) : null;
  const sosMini = BM ? BM.createMiniMap(document.getElementById('sos-mini-map'), { interactive: false }) : null;
  locTargets.set(reportLocText, { mini: reportMini, label: document.getElementById('report-mini-label') });
  locTargets.set(sosLocText, { mini: sosMini, label: document.getElementById('sos-mini-label') });
  const sosTrackBtn = document.getElementById('sos-track-location-btn');
  if (sosTrackBtn) sosTrackBtn.addEventListener('click', () => useMyLocation(sosLocText, document.getElementById('sos-mini-label'), sosTrackBtn));
  const reportTrackBtn = document.getElementById('report-track-location-btn');
  if (reportTrackBtn) reportTrackBtn.addEventListener('click', () => useMyLocation(reportLocText, document.getElementById('report-mini-label'), reportTrackBtn));
  // previews were hidden when created: re-measure when their screens open
  const remeasure = () => setTimeout(() => { [reportMini, sosMini].forEach((m) => m && m.map.invalidateSize()); }, 60);
  document.querySelectorAll('[data-goto="report-emergency"], [data-goto="setup-sos"]').forEach((b) => b.addEventListener('click', remeasure));

  // First GPS fix: show live coordinates and swap the placeholder address for the real one.
  if (BM) {
    const homeCoords = document.getElementById('home-coords');
    BM.onUser(async (u, first) => {
      homeCoords.hidden = false;
      homeCoords.textContent = formatCoords(u.lat, u.lng);
      if (!first) return;
      const rev = await BayanihanAPI.reverseGeocode(u);
      const text = rev.success ? addrText(rev) : formatCoords(u.lat, u.lng);
      [reportLocText, sosLocText].forEach((el) => {
        if (el && !el.dataset.manual) { el.textContent = text; el.dataset.lat = u.lat; el.dataset.lng = u.lng; }
      });
    });
  }

  // --- Attach proof: photo / video / audio ---
  const proofPreviewContainer = document.getElementById('proof-preview-container');
  const btnProofPhoto = document.getElementById('btn-proof-photo');
  const btnProofVideo = document.getElementById('btn-proof-video');
  const btnProofAudio = document.getElementById('btn-proof-audio');
  const btnProofGallery = document.getElementById('btn-proof-gallery');
  const proofFileInput = document.getElementById('proof-file-input');
  let proofItems = []; // { type: 'photo' | 'video' | 'audio', src? }

  function renderProofPreview() {
    proofPreviewContainer.innerHTML = proofItems
      .map((item, i) => {
        if (item.type === 'photo') {
          return `<div class="proof-preview-item"><img src="${item.src}" alt="Attached photo"><button type="button" class="btn-remove-proof" data-remove="${i}" aria-label="Remove photo">✕</button></div>`;
        }
        if (item.type === 'video') {
          return `<div class="proof-preview-item proof-preview-video"><video src="${item.src}" muted playsinline></video><span class="video-badge">▶ video</span><button type="button" class="btn-remove-proof" data-remove="${i}" aria-label="Remove video">✕</button></div>`;
        }
        // Recorded audio — real, playable clip (or a placeholder if
        // recording somehow produced no data).
        return `<div class="proof-audio-row">
          <button type="button" class="audio-play-btn" data-play-audio="${i}" aria-label="Play recording"${item.src ? '' : ' disabled'}>
            <svg viewBox="0 0 12 14" fill="currentColor"><path d="M1 1 11 7 1 13Z"/></svg>
          </button>
          <span>Recorded audio</span>
          <span class="audio-time" data-audio-time="${i}"></span>
          <button type="button" class="remove-link" data-remove="${i}">remove</button>
          ${item.src ? `<audio data-audio-el="${i}" src="${item.src}" preload="metadata" style="display:none"></audio>` : ''}
        </div>`;
      })
      .join('');

    proofPreviewContainer.querySelectorAll('[data-play-audio]').forEach((btn) => {
      const idx = btn.dataset.playAudio;
      const audioEl = proofPreviewContainer.querySelector(`[data-audio-el="${idx}"]`);
      const timeEl = proofPreviewContainer.querySelector(`[data-audio-time="${idx}"]`);
      wireAudioButton(btn, audioEl, timeEl);
    });

    proofPreviewContainer.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.remove);
        const removed = proofItems[idx];
        if (removed && removed.src && removed.src.startsWith('blob:') && removed === proofItems[idx]) {
          URL.revokeObjectURL(removed.src);
        }
        proofItems.splice(idx, 1);
        renderProofPreview();
      });
    });
  }

  // --- Live camera (real device camera for photo + video capture) ---
  const cameraFeed = document.getElementById('camera-feed');
  const cameraCanvas = document.getElementById('camera-canvas');
  const cameraCloseBtn = document.getElementById('camera-close');
  const shutterBtn = document.getElementById('shutter-btn');
  const cameraFlipBtn = document.getElementById('camera-flip-btn');
  const cameraModeEls = document.querySelectorAll('.camera-modes span');
  const cameraErrorEl = document.getElementById('camera-error');
  const recIndicator = document.getElementById('rec-indicator');
  const recTimerEl = document.getElementById('rec-timer');

  let cameraStream = null;
  let facingMode = 'environment';
  let currentCameraMode = 'photo'; // 'photo' | 'video'
  let mediaRecorder = null;
  let recordedChunks = [];
  let recTimerInterval = null;
  let recSeconds = 0;

  async function startCameraStream() {
    stopMediaTracks();
    setError(cameraErrorEl, '');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError(cameraErrorEl, 'Camera not supported on this browser. Use "upload from gallery" instead.');
      return;
    }
    const wantAudio = currentCameraMode === 'video';
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ audio: wantAudio, video: { facingMode } });
    } catch (err) {
      if (wantAudio) {
        try {
          cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode } });
        } catch (err2) {
          setError(cameraErrorEl, 'Camera access was blocked or unavailable. You can still upload from your gallery.');
          return;
        }
      } else {
        setError(cameraErrorEl, 'Camera access was blocked or unavailable. You can still upload from your gallery.');
        return;
      }
    }
    cameraFeed.srcObject = cameraStream;
    cameraFeed.classList.toggle('is-mirrored', facingMode === 'user');
  }

  function stopMediaTracks() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
    if (cameraFeed) cameraFeed.srcObject = null;
  }

  function setCameraMode(mode) {
    currentCameraMode = mode;
    cameraModeEls.forEach((el) => el.classList.toggle('is-active', el.dataset.mode === mode));
    startCameraStream();
  }

  cameraModeEls.forEach((el) => {
    if (!el.dataset.mode) return;
    el.addEventListener('click', () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') return; // don't switch mid-recording
      setCameraMode(el.dataset.mode);
    });
  });

  function openCamera(mode) {
    showScreen('camera');
    setCameraMode(mode);
  }
  btnProofPhoto.addEventListener('click', () => openCamera('photo'));
  btnProofVideo.addEventListener('click', () => openCamera('video'));

  function closeCameraScreen() {
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    stopMediaTracks();
    stopRecTimer();
    recIndicator.hidden = true;
    shutterBtn.classList.remove('is-recording');
    showScreen('report-emergency');
  }
  cameraCloseBtn.addEventListener('click', closeCameraScreen);

  if (cameraFlipBtn) {
    cameraFlipBtn.addEventListener('click', () => {
      facingMode = facingMode === 'environment' ? 'user' : 'environment';
      startCameraStream();
    });
  }

  function capturePhoto() {
    const flash = document.getElementById('capture-flash');
    flash.classList.add('is-visible');
    setTimeout(() => flash.classList.remove('is-visible'), 250);

    if (cameraStream && cameraFeed.videoWidth) {
      const w = cameraFeed.videoWidth;
      const h = cameraFeed.videoHeight;
      cameraCanvas.width = w;
      cameraCanvas.height = h;
      const ctx = cameraCanvas.getContext('2d');
      if (facingMode === 'user') {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(cameraFeed, 0, 0, w, h);
      const dataUrl = cameraCanvas.toDataURL('image/jpeg', 0.9);
      proofItems.push({ type: 'photo', src: dataUrl });
      renderProofPreview();
    }

    setTimeout(closeCameraScreen, 250);
  }

  function toggleVideoRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    if (!cameraStream) return;

    recordedChunks = [];
    try {
      mediaRecorder = new MediaRecorder(cameraStream, { mimeType: 'video/webm;codecs=vp8,opus' });
    } catch (e) {
      mediaRecorder = new MediaRecorder(cameraStream);
    }
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      proofItems.push({ type: 'video', src: url });
      renderProofPreview();
      stopRecTimer();
      recIndicator.hidden = true;
      shutterBtn.classList.remove('is-recording');
      closeCameraScreen();
    };
    mediaRecorder.start();
    shutterBtn.classList.add('is-recording');
    recIndicator.hidden = false;
    startRecTimer();
  }

  function startRecTimer() {
    recSeconds = 0;
    updateRecTimerText();
    recTimerInterval = setInterval(() => {
      recSeconds += 1;
      updateRecTimerText();
    }, 1000);
  }
  function stopRecTimer() {
    clearInterval(recTimerInterval);
    recTimerInterval = null;
  }
  function updateRecTimerText() {
    const m = String(Math.floor(recSeconds / 60)).padStart(2, '0');
    const s = String(recSeconds % 60).padStart(2, '0');
    if (recTimerEl) recTimerEl.textContent = `${m}:${s}`;
  }

  shutterBtn.addEventListener('click', () => {
    if (currentCameraMode === 'video') {
      toggleVideoRecording();
    } else {
      capturePhoto();
    }
  });

  // --- Upload photos/videos from the gallery (works standalone, and as a
  // fallback whenever camera access isn't available) ---
  if (btnProofGallery && proofFileInput) {
    btnProofGallery.addEventListener('click', () => proofFileInput.click());
    proofFileInput.addEventListener('change', () => {
      const files = Array.from(proofFileInput.files || []);
      files.forEach((file) => {
        const url = URL.createObjectURL(file);
        const type = file.type.startsWith('video') ? 'video' : 'photo';
        proofItems.push({ type, src: url });
      });
      renderProofPreview();
      proofFileInput.value = '';
    });
  }

  // --- Voice recording proof (real mic capture via MediaRecorder) ---
  let audioStream = null;
  let audioRecorder = null;
  let audioChunks = [];

  function setAudioButtonRecording(isRecording) {
    btnProofAudio.classList.toggle('is-recording', isRecording);
    const label = btnProofAudio.querySelector('span');
    label.innerHTML = isRecording ? 'Recording…<br>tap to stop' : 'Voice<br>Recording';
  }

  async function toggleAudioRecording() {
    if (audioRecorder && audioRecorder.state === 'recording') {
      audioRecorder.stop(); // onstop handles the rest
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Audio recording isn\u2019t supported on this browser.');
      return;
    }

    btnProofAudio.disabled = true;
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      alert('Microphone access was blocked or unavailable.');
      btnProofAudio.disabled = false;
      return;
    }

    audioChunks = [];
    try {
      audioRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm;codecs=opus' });
    } catch (e) {
      audioRecorder = new MediaRecorder(audioStream);
    }

    audioRecorder.ondataavailable = (e) => { if (e.data && e.data.size) audioChunks.push(e.data); };
    audioRecorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: audioRecorder.mimeType || 'audio/webm' });
      const url = URL.createObjectURL(blob);
      proofItems.push({ type: 'audio', src: url });
      renderProofPreview();

      if (audioStream) {
        audioStream.getTracks().forEach((t) => t.stop());
        audioStream = null;
      }
      setAudioButtonRecording(false);
      btnProofAudio.disabled = false;
    };

    audioRecorder.start();
    btnProofAudio.disabled = false;
    setAudioButtonRecording(true);
  }

  btnProofAudio.addEventListener('click', toggleAudioRecording);

  // --- Submit report + success modal ---
  const successOverlay = document.getElementById('success-overlay');

  document.getElementById('btn-submit-report').addEventListener('click', async () => {
    const submitBtn = document.getElementById('btn-submit-report');
    submitBtn.disabled = true;

    let coords = { lat: null, lng: null };
    const liveUser = BM && BM.getUser();
    const chosenLat = parseFloat(reportLocText.dataset.lat);
    const chosenLng = parseFloat(reportLocText.dataset.lng);
    if (reportLocText.dataset.manual === '1' && !isNaN(chosenLat) && !isNaN(chosenLng)) {
      coords = { lat: chosenLat, lng: chosenLng };   // location picked on the map
    } else if (liveUser) {
      coords = { lat: liveUser.lat, lng: liveUser.lng }; // live GPS
    } else if ('geolocation' in navigator) {
      try {
        const pos = await new Promise((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { timeout: 6000 })
        );
        coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      } catch (_) { /* fall back to null coords */ }
    }

    const notes = document.getElementById('report-notes').value.trim();
    const contactEl = document.getElementById('report-contact');
    const contact = (contactEl.value.trim() || (document.getElementById('account-mobile') || {}).value || '').trim();
    const reporter = ((document.getElementById('account-name') || {}).value || '').trim();
    const { incident } = await BayanihanAPI.reportIncident({ ...coords, notes });
    submitBtn.disabled = false;

    const selectedType = document.querySelector('.type-card.is-selected');
    const type = (selectedType && selectedType.dataset.type) || 'Other';
    const audios = proofItems.filter((p) => p.type === 'audio' && p.src).map((p) => p.src);
    if (BM) {
      BM.addIncident({ id: incident.id, type, title: TYPE_TITLES[type] || 'Emergency Reported', desc: notes,
        lat: incident.lat, lng: incident.lng, source: 'mine', time: Date.now() });
    }

    myEmergencies.unshift({
      id: incident.id,
      type,
      title: TYPE_TITLES[type] || 'Emergency Reported',
      location: reportLocText.textContent,
      desc: notes || 'No additional details were provided for this report.',
      lat: incident.lat, lng: incident.lng, contact, reporter,
      images: proofItems.filter((p) => p.type === 'photo').map((p) => p.src),
      videos: proofItems.filter((p) => p.type === 'video').map((p) => p.src),
      audios,
      hasAudio: audios.length > 0,
      mine: true,
    });
    renderEmergencyFeed();

    notifications.push({
      icon: '!assets/!images/first-aid.png',
      title: 'Report sent',
      body: 'Waiting for a responder to reply. You can call a hotline from the report.',
      emergencyId: incident.id,
    });
    renderNotifications();
    if (bellDot) bellDot.style.display = 'block';

    // Ownership of any recorded blob URLs (audio/video) transfers to the
    // report saved above — they need to stay alive so it's replayable from
    // the emergency detail screen, so we only clear the composer's list.
    proofItems = [];
    renderProofPreview();

    successOverlay.classList.add('is-open');
  });

  document.getElementById('success-close').addEventListener('click', async () => {
    successOverlay.classList.remove('is-open');
    await enterHome();
    setTab('emergencies');
  });

  document.getElementById('read-instructions-btn').addEventListener('click', async () => {
    successOverlay.classList.remove('is-open');
    await enterHome();
    setTab('guide');
  });

  /* ---------------------------- ACCOUNT DETAILS ---------------------------- */
  const accountVerifyBtn = document.getElementById('account-verify-email');
  if (accountVerifyBtn) {
    accountVerifyBtn.addEventListener('click', () => {
      alert('Verification isn\u2019t connected yet, hook this shi up once a backend + email provider exist.');
    });
  }

  const accountSaveBtn = document.getElementById('account-save-btn');
  if (accountSaveBtn) {
    accountSaveBtn.addEventListener('click', () => {
      const name = document.getElementById('account-name').value.trim();
      if (name) document.getElementById('home-username').textContent = name;
      showScreen('home');
      setTab('profile');
    });
  }

  /* ------------------------------- SETUP SOS ------------------------------- */
  const sosRange = document.getElementById('sos-range');
  const sosRangeBubble = document.getElementById('sos-range-bubble');

  function updateSosRangeUI() {
    if (!sosRange) return;
    const min = Number(sosRange.min) || 0;
    const max = Number(sosRange.max) || 100;
    const val = Number(sosRange.value);
    const pct = ((val - min) / (max - min)) * 100;

    sosRangeBubble.textContent = `${val} km`;
    sosRangeBubble.style.left = `${pct}%`;
    sosRange.style.background = `linear-gradient(to right, var(--red) 0 ${pct}%, var(--line) ${pct}% 100%)`;
  }

  if (sosRange) {
    sosRange.addEventListener('input', updateSosRangeUI);
    updateSosRangeUI();
  }

  const sosChangeContactBtn = document.getElementById('btn-sos-change-contact');
  if (sosChangeContactBtn) {
    sosChangeContactBtn.addEventListener('click', () => {
      alert('Contact picker isn\u2019t connected yet. continue this up once a backend + contacts permission exist.');
    });
  }

  const sosSaveBtn = document.getElementById('sos-save-btn');
  if (sosSaveBtn) {
    sosSaveBtn.addEventListener('click', () => {
      showScreen('home');
      setTab('profile');
    });
  }

  /* -------------------------------- SETTINGS -------------------------------- */
  document.querySelectorAll('[data-settings-alert]').forEach((btn) => {
    btn.addEventListener('click', () => {
      alert(`${btn.dataset.settingsAlert} isn\u2019t connected yet. hook this shi up once a backend exists now.`);
    });
  });

  /* ----------------------------------- MAPS ----------------------------------- */
  const mapFabBtn = document.getElementById('btn-map-fab');
  const mapFabContainer = document.getElementById('map-fab-container');
  const menuItems = document.querySelectorAll('.fab-menu-item');
  const baseOpts = document.querySelectorAll('.base-opt');
  const ovlOpts = document.querySelectorAll('.ovl-opt');
  const basePicker = document.getElementById('base-picker');
  const baseMenu = document.getElementById('base-picker-menu');
  const baseBtn = document.getElementById('btn-base-picker');
  let mainMap = null;

  if (BM) {
    // Faint live map behind the SOS button on Home.
    const homeBg = document.getElementById('home-bg-map');
    if (homeBg) BM.createBackdrop(homeBg);

    // Maps tab: street map by default; the menu switches layers.
    mainMap = BM.createFullMap(document.getElementById('live-map'), {
      mode: 'none',
      base: 'street',
      noteEl: document.getElementById('map-note'),
      searchForm: document.getElementById('map-search-form'),
      searchInput: document.getElementById('map-search-input'),
      searchResults: document.getElementById('map-search-results'),
      locateBtn: document.getElementById('btn-map-locate'),
      onModeChange: (mode) =>
        menuItems.forEach((mi) => mi.classList.toggle('is-selected', mi.dataset.layer === mode)),
      onOpenReport: (id) => openEmergencyDetail(id),
      onAlert: (a) => {
        notifications.unshift({ icon: a.icon, title: a.title, body: a.body, map: { mode: a.mode, lat: a.lat, lng: a.lng } });
        renderNotifications();
        if (bellDot) bellDot.style.display = 'block';
      },
      onOverlayChange: (ov) => ovlOpts.forEach((b) => {
        const on = b.dataset.ovl === ov;
        b.classList.toggle('is-selected', on);
        b.setAttribute('aria-checked', String(on));
      }),
      onBaseChange: (base) => baseOpts.forEach((b) => {
        const on = b.dataset.base === base;
        b.classList.toggle('is-selected', on);
        b.setAttribute('aria-checked', String(on));
      }),
    });

    // Guide > Offline Map: safe zones + responders, with tiles cached for no-signal use.
    BM.createFullMap(document.getElementById('offline-map'), {
      mode: 'evacuation',
      noteEl: document.getElementById('offline-note'),
      locateBtn: document.getElementById('btn-offline-locate'),
      saveBtn: document.getElementById('btn-offline-save'),
    });
  } else {
    const liveMap = document.getElementById('live-map');
    if (liveMap) liveMap.innerHTML = '<p style="padding:90px 24px;text-align:center;font-size:13px;color:#8A8D93">The map couldn\u2019t load. Check that !js/leaflet.js is present.</p>';
  }

  if (mapFabBtn && mapFabContainer) {
    mapFabBtn.addEventListener('click', () => {
      mapFabContainer.classList.toggle('is-active');
    });
  }

  // Risk layers: tap one to show it, tap it again to switch it off.
  menuItems.forEach((item) => {
    item.addEventListener('click', () => {
      if (!mainMap) return;
      const same = mainMap.getMode() === item.dataset.layer;
      mainMap.setMode(same ? 'none' : item.dataset.layer);
    });
  });

  // Base map style: independent of the risk layer.
  const closeBase = () => { if (baseMenu) { baseMenu.hidden = true; baseBtn.setAttribute('aria-expanded', 'false'); } };
  if (baseBtn && baseMenu) {
    baseBtn.addEventListener('click', () => {
      baseMenu.hidden = !baseMenu.hidden;
      baseBtn.setAttribute('aria-expanded', String(!baseMenu.hidden));
    });
    baseOpts.forEach((b) => b.addEventListener('click', () => {
      if (mainMap) mainMap.setBase(b.dataset.base);
      closeBase();
    }));
    // Demo storm: forces a severe forecast and a serious gauge + blocked road within 5 km, so the bell alert can be shown.
    const demoToggle = document.getElementById('demo-toggle');
    if (demoToggle) demoToggle.addEventListener('change', () => {
      if (!mainMap) return;
      mainMap.setDemo(demoToggle.checked);
      if (demoToggle.checked && !['flood', 'landslide', 'surge'].includes(mainMap.getMode())) mainMap.setMode('flood');   // alerts fire on the Flood / Landslide maps
      closeBase();
    });
    ovlOpts.forEach((b) => b.addEventListener('click', () => {
      if (mainMap) mainMap.setOverlay(b.dataset.ovl);
    }));
    document.addEventListener('click', (e) => { if (basePicker && !basePicker.contains(e.target)) closeBase(); });
  }

  // --- Scrollable Menu Wheel & Drag Support ---
  const fabMenu = document.getElementById('map-fab-menu');

  if (fabMenu) {
    fabMenu.addEventListener('wheel', (e) => {
      e.preventDefault();
      fabMenu.scrollLeft += e.deltaY;
    });

    let isDown = false;
    let startX;
    let scrollLeft;

    fabMenu.addEventListener('mousedown', (e) => {
      isDown = true;
      startX = e.pageX - fabMenu.offsetLeft;
      scrollLeft = fabMenu.scrollLeft;
    });

    fabMenu.addEventListener('mouseleave', () => { isDown = false; });
    fabMenu.addEventListener('mouseup', () => { isDown = false; });

    fabMenu.addEventListener('mousemove', (e) => {
      if (!isDown) return;
      e.preventDefault();
      const x = e.pageX - fabMenu.offsetLeft;
      const walk = (x - startX) * 2;
      fabMenu.scrollLeft = scrollLeft - walk;
    });
  }

  /* ------------------------------- OPENING -------------------------------- */
  // Auto-advance from the opening screen after a short beat, same as tapping.
  setTimeout(() => {
    const opening = document.querySelector('[data-screen="opening"]');
    if (opening.classList.contains('is-active')) showScreen('signup');
  }, 3500);
})();

// ==========================================
// GUIDEBOOK TAB ROUTING FUNCTIONS
// ==========================================

function openGuide(disasterType) {
  const mainList = document.getElementById('guidebook-list-view');
  if (mainList) {
    mainList.classList.add('hidden');
  }

  document.querySelectorAll('.guidebook-detail-view').forEach(view => {
    view.classList.add('hidden');
  });

  const targetView = document.getElementById(`guidebook-${disasterType}`);
  if (targetView) {
    targetView.classList.remove('hidden');
    
    // Scroll container to top
    const homeCard = document.querySelector('.home-card');
    if (homeCard) {
      homeCard.scrollTop = 0;
    }
  }
}

function showGuideList() {
  document.querySelectorAll('.guidebook-detail-view').forEach(view => {
    view.classList.add('hidden');
  });

  const mainList = document.getElementById('guidebook-list-view');
  if (mainList) {
    mainList.classList.remove('hidden');
  }
}