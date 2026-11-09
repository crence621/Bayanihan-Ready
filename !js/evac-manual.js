/* Hand-entered evacuation sites. Kept apart from evac-backup.js so that re-running
   tools/build-evac-backup.js never erases them. Add or fix entries here by hand.
   kind: school | hall | gym | health | assembly | shelter
   Coordinates: right-click the spot in Google Maps and copy the two numbers (lat, lng). */
window.BAYANIHAN_EVAC_MANUAL = [
  { id: 'manual/balangiga-mdrrm', name: 'Balangiga MDRRM Office', kind: 'hall', label: 'MDRRM Office', official: true,
    address: 'Balangiga, Eastern Samar', lat: 11.109049, lng: 125.386462,
    note: 'Municipal disaster office. Coordination point; a DOH ambulance is parked here.' },
  { id: 'manual/balangiga-central-es', name: 'Balangiga Central Elementary School', kind: 'school', label: 'Public school', official: false,
    address: 'Balangiga, Eastern Samar', lat: 11.109582, lng: 125.388010 },
  { id: 'manual/balangiga-school-west', name: 'School (name to confirm)', kind: 'school', label: 'Public school', official: false,
    address: 'Balangiga, Eastern Samar', lat: 11.109726, lng: 125.381300 },
  { id: 'manual/balangiga-school-sanlorenzo', name: 'School on San Lorenzo St (name to confirm)', kind: 'school', label: 'Public school', official: false,
    address: 'San Lorenzo St, Balangiga, Eastern Samar', lat: 11.118594, lng: 125.388624 },
  { id: 'manual/balangiga-southern-samar-national', name: 'Southern Samar National\u2026 (full name to confirm)', kind: 'school', label: 'Public school', official: false,
    address: 'Balangiga, Eastern Samar', lat: 11.119508, lng: 125.389906 },
];
