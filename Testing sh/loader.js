/* ============================================================================
   loader.js — assembles the app shell from the categorized partials on disk.

   index.html only contains an empty <div id="phone-root">. Everything else
   lives in its own folder (matching the project's file structure) and gets
   fetched + injected here before app.js wires up event handlers.

   Folder → content map:
     !opening      → opening screen
     !others       → sign up / login / location screens (pre-home flow)
     !home         → home screen shell + Home tab + tab bar
     !emergencies  → Emergencies tab content
     !maps         → Maps tab content
     !guide        → Guide tab content
     !profile      → Profile tab content
     !report       → Report Emergency screen
   ============================================================================ */

(async () => {
  const root = document.getElementById('phone-root');

  async function inject(url, target) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    target.insertAdjacentHTML('beforeend', await res.text());
  }

  // Top-level screens, in the order they should appear in the DOM.
  await inject('!opening/opening.html', root);
  await inject('!others/signup.html', root);
  await inject('!others/login.html', root);
  await inject('!others/location.html', root);
  await inject('!home/home.html', root);
  await inject('!report/report.html', root);

  // Home's secondary tabs are placeholders inside !home/home.html —
  // fill them from their own category folders.
  await inject('!emergencies/emergencies-tab.html', document.querySelector('[data-tab-slot="emergencies"]'));
  await inject('!maps/maps-tab.html', document.querySelector('[data-tab-slot="maps"]'));
  await inject('!guide/guide-tab.html', document.querySelector('[data-tab-slot="guide"]'));
  await inject('!profile/profile-tab.html', document.querySelector('[data-tab-slot="profile"]'));

  // All screens/tabs now exist in the DOM — safe to wire up event handlers.
  window.initApp();
})();
