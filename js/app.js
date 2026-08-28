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

  document.getElementById('bell-btn').addEventListener('click', () => {
    alert('No new notifications yet — this is where real-time alerts will appear once a backend is connected.');
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
  document.getElementById('sos-btn').addEventListener('click', async () => {
    const sosBtn = document.getElementById('sos-btn');
    sosBtn.disabled = true;

    let coords = { lat: null, lng: null };
    if ('geolocation' in navigator) {
      try {
        const pos = await new Promise((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { timeout: 6000 })
        );
        coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      } catch (_) { /* fall back to null coords */ }
    }

    const { incident } = await BayanihanAPI.reportIncident(coords);
    sosBtn.disabled = false;

    const list = document.getElementById('incident-list');
    const emptyRow = list.querySelector('.empty');
    if (emptyRow) emptyRow.remove();

    const li = document.createElement('li');
    li.innerHTML = `<span class="dot-status" style="background:#E5342E"></span> Reported ${new Date(incident.createdAt).toLocaleTimeString()} <em>sent</em>`;
    list.prepend(li);

    setTab('emergencies');
  });

  /* ------------------------------- OPENING -------------------------------- */
  // Auto-advance from the opening screen after a short beat, same as tapping.
  setTimeout(() => {
    const opening = document.querySelector('[data-screen="opening"]');
    if (opening.classList.contains('is-active')) showScreen('signup');
  }, 3500);
})();
