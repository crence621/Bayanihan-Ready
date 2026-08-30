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

  if (signupForm) {
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
  }

  /* -------------------------------- LOGIN -------------------------------- */
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');

  if (loginForm) {
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
  }

  function applyUserToUI(user) {
    document.getElementById('home-username').textContent = user.name;
    document.getElementById('profile-name').textContent = user.name;
    document.getElementById('profile-email').textContent = user.email;
  }

  document.querySelectorAll('.social').forEach((btn) => {
    btn.addEventListener('click', () => {
      alert(`Sign-in with ${btn.dataset.provider} isn't connected yet.`);
    });
  });

  /* ------------------------------- LOCATION ------------------------------- */
  const allowLocationBtn = document.getElementById('allow-location');
  const coordsReadout = document.getElementById('coords-readout');
  const locationError = document.getElementById('location-error');

  if (allowLocationBtn) {
    allowLocationBtn.addEventListener('click', () => {
      if (!('geolocation' in navigator)) {
        setError(locationError, 'Location isn’t available on this device/browser.');
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
  }

  /* --------------------------------- HOME --------------------------------- */
  async function enterHome() {
    const user = BayanihanAPI.getCurrentUser();
    if (user) applyUserToUI(user);

    const { responders } = await BayanihanAPI.getNearbyResponders();
    const list = document.getElementById('responder-list');
    if (list) {
      list.innerHTML = responders
        .map((r) => `<li><span class="dot-status"></span> ${r.name} <em>${r.distanceKm} km</em></li>`)
        .join('');
    }

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

  const bellBtn = document.getElementById('bell-btn');
  if (bellBtn) {
    bellBtn.addEventListener('click', () => {
      alert('No new notifications yet.');
    });
  }

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await BayanihanAPI.logOut();
      if (signupForm) signupForm.reset();
      if (loginForm) loginForm.reset();
      setError(signupError, '');
      setError(loginError, '');
      showScreen('opening');
    });
  }

  /* -------------------------- REPORT EMERGENCY --------------------------- */
  // Type Card Selection
  const typeCards = document.querySelectorAll('.type-card');
  typeCards.forEach((card) => {
    card.addEventListener('click', () => {
      typeCards.forEach((c) => c.classList.remove('is-selected'));
      card.classList.add('is-selected');
    });
  });

  // Proof File Upload Handling
  const proofFileInput = document.getElementById('proof-file-input');
  const proofPreviewContainer = document.getElementById('proof-preview-container');

  ['btn-proof-photo', 'btn-proof-video', 'btn-proof-audio'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn && proofFileInput) {
      btn.addEventListener('click', () => proofFileInput.click());
    }
  });

  if (proofFileInput) {
    proofFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const item = document.createElement('div');
        item.className = 'proof-preview-item';

        if (file.type.startsWith('image/')) {
          item.innerHTML = `<img src="${event.target.result}" alt="Proof"><button class="btn-remove-proof">&times;</button>`;
        } else if (file.type.startsWith('video/')) {
          item.innerHTML = `<video src="${event.target.result}"></video><button class="btn-remove-proof">&times;</button>`;
        } else {
          item.innerHTML = `<div style="font-size:10px;padding:10px;">Audio Attached</div><button class="btn-remove-proof">&times;</button>`;
        }

        item.querySelector('.btn-remove-proof').addEventListener('click', () => item.remove());
        proofPreviewContainer.appendChild(item);
      };
      reader.readAsDataURL(file);
    });
  }

  // Location Change Action
  const btnChangeLoc = document.getElementById('btn-change-location');
  if (btnChangeLoc) {
    btnChangeLoc.addEventListener('click', () => {
      const newLoc = prompt('Enter your current location:', '6767, Buenavista-Lawaan Rd., Balangiga, Eastern Samar');
      if (newLoc) {
        document.getElementById('report-loc-text').textContent = newLoc;
      }
    });
  }

  // Submit Report
  const btnSubmitReport = document.getElementById('btn-submit-report');
  if (btnSubmitReport) {
    btnSubmitReport.addEventListener('click', async () => {
      const selectedTypeCard = document.querySelector('.type-card.is-selected');
      const emergencyType = selectedTypeCard ? selectedTypeCard.dataset.type : 'Emergency';
      const notes = document.getElementById('report-notes').value;

      btnSubmitReport.disabled = true;
      btnSubmitReport.textContent = 'Submitting...';

      const { incident } = await BayanihanAPI.reportIncident({ lat: null, lng: null }, { type: emergencyType, notes });

      btnSubmitReport.disabled = false;
      btnSubmitReport.textContent = 'Submit Report';

      const list = document.getElementById('incident-list');
      if (list) {
        const emptyRow = list.querySelector('.empty');
        if (emptyRow) emptyRow.remove();

        const li = document.createElement('li');
        li.innerHTML = `<span class="dot-status" style="background:#E5342E"></span> [${emergencyType}] Reported ${new Date(incident.createdAt).toLocaleTimeString()} <em>sent</em>`;
        list.prepend(li);
      }

      showScreen('home');
      setTab('emergencies');
    });
  }

  /* ------------------------------- OPENING -------------------------------- */
  setTimeout(() => {
    const opening = document.querySelector('[data-screen="opening"]');
    if (opening && opening.classList.contains('is-active')) showScreen('signup');
  }, 3500);

  
})();