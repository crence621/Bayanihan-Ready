(() => {
  const screens = document.querySelectorAll('.screen');

  function showScreen(name) {
    screens.forEach((s) => s.classList.toggle('is-active', s.dataset.screen === name));
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

  /* ------------------------------- SIGN UP ------------------------------- */
  const signupForm = document.getElementById('signup-form');
  const signupError = document.getElementById('signup-error');

  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError(signupError, '');
    const submitBtn = signupForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    const data = Object.fromEntries(new FormData(signupForm).entries());
    const result = await BayanihanAPI.signUp(data);

    submitBtn.disabled = false;

    if (!result.success) {
      setError(signupError, result.error);
      return;
    }

    applyUserToUI(result.user);
    showScreen('location');
  });

  /* -------------------------------- LOGIN -------------------------------- */
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError(loginError, '');
    const submitBtn = loginForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    const data = Object.fromEntries(new FormData(loginForm).entries());
    const result = await BayanihanAPI.logIn(data);

    submitBtn.disabled = false;

    if (!result.success) {
      setError(loginError, result.error);
      return;
    }

    applyUserToUI(result.user);
    await enterHome();
  });

  function applyUserToUI(user) {
    document.getElementById('home-username').textContent = user.name;
    document.getElementById('profile-name').textContent = user.name;
    document.getElementById('profile-email').textContent = user.email;
  }

  // Social buttons are placeholders — wired for whenever real OAuth exists.
  document.querySelectorAll('.social').forEach((btn) => {
    btn.addEventListener('click', () => {
      alert(`Sign-in with ${btn.dataset.provider} isn't connected yet — hook this up once a backend + OAuth app exist.`);
    });
  });

  /* ------------------------------- LOCATION ------------------------------- */
  const allowLocationBtn = document.getElementById('allow-location');
  const coordsReadout = document.getElementById('coords-readout');
  const locationError = document.getElementById('location-error');

  allowLocationBtn.addEventListener('click', () => {
    if (!('geolocation' in navigator)) {
      setError(locationError, 'Location isn\u2019t available on this device/browser.');
      return;
    }

    allowLocationBtn.disabled = true;
    allowLocationBtn.textContent = 'Locating…';

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        coordsReadout.hidden = false;
        coordsReadout.textContent = formatCoords(latitude, longitude);
        await BayanihanAPI.saveLocation({ lat: latitude, lng: longitude });

        const homeCoords = document.getElementById('home-coords');
        homeCoords.hidden = false;
        homeCoords.textContent = formatCoords(latitude, longitude);

        allowLocationBtn.disabled = false;
        allowLocationBtn.textContent = 'Allow';
        await enterHome();
      },
      () => {
        allowLocationBtn.disabled = false;
        allowLocationBtn.textContent = 'Allow';
        setError(locationError, 'Permission denied — you can still continue and enable this later.');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });

  /* --------------------------------- HOME --------------------------------- */
  async function enterHome() {
    const user = BayanihanAPI.getCurrentUser();
    if (user) applyUserToUI(user);

    const { responders } = await BayanihanAPI.getNearbyResponders();
    const list = document.getElementById('responder-list');
    list.innerHTML = responders
      .map((r) => `<li><span class="dot-status"></span> ${r.name} <em>${r.distanceKm} km</em></li>`)
      .join('');

    showScreen('home');
    setTab('home');
  }

  /* ------------------------------- TAB BAR --------------------------------- */
  const tabItems = document.querySelectorAll('.tab-item');
  const tabPanels = document.querySelectorAll('.tab-panel');

  function setTab(name) {
    tabItems.forEach((t) => t.classList.toggle('is-active', t.dataset.tabGoto === name));
    tabPanels.forEach((p) => p.classList.toggle('is-active', p.dataset.tab === name));
  }

  tabItems.forEach((btn) => {
    btn.addEventListener('click', () => setTab(btn.dataset.tabGoto));
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
        (n) => `
      <div class="notif-item">
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
  const locationSheetOverlay = document.getElementById('location-sheet-overlay');
  const reportLocText = document.getElementById('report-loc-text');
  const locHouseInput = document.getElementById('loc-house-input');
  const locStreetInput = document.getElementById('loc-street-input');
  const locCityInput = document.getElementById('loc-city-input');

  function openLocationSheet() { locationSheetOverlay.classList.add('is-open'); }
  function closeLocationSheet() { locationSheetOverlay.classList.remove('is-open'); }

  document.getElementById('btn-change-location').addEventListener('click', openLocationSheet);
  document.getElementById('location-sheet-back').addEventListener('click', closeLocationSheet);

  document.getElementById('confirm-location-btn').addEventListener('click', () => {
    const parts = [locHouseInput.value.trim(), locStreetInput.value.trim(), locCityInput.value.trim()].filter(Boolean);
    if (parts.length) reportLocText.textContent = parts.join(', ');
    closeLocationSheet();
  });

  document.getElementById('track-location-btn').addEventListener('click', () => {
    if (!('geolocation' in navigator)) return;
    // Cosmetic in this prototype — a real build would re-center the map
    // and reverse-geocode the coordinates into the address fields.
    navigator.geolocation.getCurrentPosition(() => {}, () => {});
  });

  // --- Attach proof: photo / video / audio ---
  const proofPreviewContainer = document.getElementById('proof-preview-container');
  const btnProofPhoto = document.getElementById('btn-proof-photo');
  const btnProofVideo = document.getElementById('btn-proof-video');
  const btnProofAudio = document.getElementById('btn-proof-audio');
  let proofItems = []; // { type: 'photo' | 'audio', src? }

  function renderProofPreview() {
    proofPreviewContainer.innerHTML = proofItems
      .map((item, i) => {
        if (item.type === 'photo') {
          return `<div class="proof-preview-item"><img src="${item.src}" alt="Attached photo"><button type="button" class="btn-remove-proof" data-remove="${i}" aria-label="Remove photo">✕</button></div>`;
        }
        return `<div class="proof-audio-row"><span class="audio-dot"></span><span>Recorded audio</span><button type="button" class="remove-link" data-remove="${i}">remove</button></div>`;
      })
      .join('');

    proofPreviewContainer.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        proofItems.splice(Number(btn.dataset.remove), 1);
        renderProofPreview();
      });
    });
  }

  function openCamera() { showScreen('camera'); }
  btnProofPhoto.addEventListener('click', openCamera);
  btnProofVideo.addEventListener('click', openCamera);

  document.getElementById('camera-close').addEventListener('click', () => showScreen('report-emergency'));

  document.getElementById('shutter-btn').addEventListener('click', () => {
    const flash = document.getElementById('capture-flash');
    flash.classList.add('is-visible');
    setTimeout(() => {
      flash.classList.remove('is-visible');
      proofItems.push({ type: 'photo', src: '!assets/!images/image_20.png' });
      renderProofPreview();
      showScreen('report-emergency');
    }, 550);
  });

  btnProofAudio.addEventListener('click', () => {
    if (btnProofAudio.disabled) return;
    const label = btnProofAudio.querySelector('span');
    const original = label.innerHTML;
    btnProofAudio.disabled = true;
    label.textContent = 'Recording…';
    setTimeout(() => {
      label.innerHTML = original;
      btnProofAudio.disabled = false;
      proofItems.push({ type: 'audio' });
      renderProofPreview();
    }, 1200);
  });

  // --- Submit report + success modal ---
  const successOverlay = document.getElementById('success-overlay');

  document.getElementById('btn-submit-report').addEventListener('click', async () => {
    const submitBtn = document.getElementById('btn-submit-report');
    submitBtn.disabled = true;

    let coords = { lat: null, lng: null };
    if ('geolocation' in navigator) {
      try {
        const pos = await new Promise((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { timeout: 6000 })
        );
        coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      } catch (_) { /* fall back to null coords */ }
    }

    const notes = document.getElementById('report-notes').value.trim();
    const { incident } = await BayanihanAPI.reportIncident({ ...coords, notes });
    submitBtn.disabled = false;

    const list = document.getElementById('incident-list');
    const emptyRow = list.querySelector('.empty');
    if (emptyRow) emptyRow.remove();

    const li = document.createElement('li');
    li.innerHTML = `<span class="dot-status" style="background:#E5342E"></span> Reported ${new Date(incident.createdAt).toLocaleTimeString()} <em>sent</em>`;
    list.prepend(li);

    notifications.push({
      icon: '!assets/!images/first-aid.png',
      title: 'Help is on Route',
      body: 'Please Stay Safe',
    });
    renderNotifications();
    if (bellDot) bellDot.style.display = 'block';

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

  /* ------------------------------- OPENING -------------------------------- */
  // Auto-advance from the opening screen after a short beat, same as tapping.
  setTimeout(() => {
    const opening = document.querySelector('[data-screen="opening"]');
    if (opening.classList.contains('is-active')) showScreen('signup');
  }, 3500);
})();