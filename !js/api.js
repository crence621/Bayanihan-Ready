const BayanihanAPI = (() => {

  // In-memory "database" — replaced by a real DB once a backend exists.
  const db = {
    users: [],       // { id, name, email, password }
    incidents: [],   // { id, userId, lat, lng, createdAt }
  };

  let sessionUser = null; // the "logged in" user for this tab/session

  const delay = (ms = 500) => new Promise((res) => setTimeout(res, ms));
  const uid = () => Math.random().toString(36).slice(2, 10);

  return {

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
      await delay();

      if (!name || !email || !password) {
        return { success: false, error: 'Please fill in every field.' };
      }
      if (password.length < 8) {
        return { success: false, error: 'Password must be at least 8 characters.' };
      }
      if (db.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
        return { success: false, error: 'An account with that email already exists.' };
      }

      const user = { id: uid(), name, email, password };
      db.users.push(user);
      sessionUser = user;

      return { success: true, user: { id: user.id, name: user.name, email: user.email } };
    },

    /* ---------------------------------------------------------------
       LOG IN
       Real version: POST /api/auth/login
    --------------------------------------------------------------- */
    async logIn({ email, password }) {
      await delay();

      const user = db.users.find(
        (u) => u.email.toLowerCase() === email.toLowerCase() && u.password === password
      );

      if (!user) {
        return { success: false, error: 'Incorrect email or password.' };
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
      if (sessionUser) sessionUser.location = { lat, lng };
      return { success: true };
    },

    /* ---------------------------------------------------------------
       NEARBY RESPONDERS
       Real version: GET /api/responders/nearby?lat=&lng=
       For now, returns fixed sample data regardless of coordinates.
    --------------------------------------------------------------- */
    async getNearbyResponders({ lat, lng } = {}) {
      await delay(300);
      return {
        success: true,
        responders: [
          { name: 'Barangay Health Station', distanceKm: 0.4 },
          { name: 'Volunteer Fire Brigade', distanceKm: 0.9 },
          { name: 'Rescue Team — Bayanihan 12', distanceKm: 1.2 },
        ],
      };
    },

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
})();