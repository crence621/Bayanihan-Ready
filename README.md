# Bayanihan-Ready
Ensci1

## Map layers (Maps tab)
- **Flood**: low-ground shading from elevation tiles (under 3 m / 3-6 / 6-10 / 10-20 m), rivers and canals, 24 h rain and river-flow outlook.
- **Landslide**: slope-steepness shading (5° to over 30°) plus a rain-trigger level from 3-day rainfall and soil moisture.
- **Weather**: current conditions, 24 h rain bars, 4-day outlook, animated rain radar.
- **Topography**: contours + hillshade; tap anywhere for elevation and slope.
- **Evacuation**: sites with safe-zone areas, labels, nearest highlight, flood/steep warnings, filterable card list.
- **Route**: walk/drive, up to 3 alternatives, directions, low-ground warning on the route.

Flood/landslide/risk levels are estimates from open data, not official warnings (PAGASA, Project NOAH, MGB). Elevation tiles: AWS Terrain Tiles. Weather: Open-Meteo. Radar: RainViewer.

## Live layers, weather overlay, reports (Maps tab)
- **Reports layer**: your reports and community reports only, in one list and on the map (no flood meters or simulated pins; those stay on the Flood and Landslide layers). Shares one store with the Emergencies tab (`BayanihanMaps.addIncident / removeIncident`), so sending or deleting a report updates the map, "Open report" jumps to the report, and "View on map" jumps back.
- **Live flood levels / landslide reports are SIMULATED** (no free live feed exists). Flood levels only appear on ground under 3 m; landslide reports only on slopes of 18° or more, scaled by the rain forecast. Swap `simFloodGauges` / `simSlides` in `!js/maps.js` for a real feed. Serious ones near you add an item to Notifications that opens the map.
- **Weather overlay** (layers button): Rain radar, Rain forecast (next 6 h), Wind, Clouds, Temperature, Air pressure (low = storm) and Humidity. Works on any map style and risk layer. The last three are coloured cells with values from the Open-Meteo grid (`API.getWeatherGrid`).
- **Typhoon tracker (DEMO)**: a made-up typhoon built around your location (or the map centre): past track, forecast track with cone of uncertainty, gale / storm / typhoon-force wind rings, an animated eye, and a time slider + Play button (24 h ago to 48 h ahead, 6 h steps). The card shows category, winds, pressure, heading, distance and a rough signal for your area. Turning on **Demo storm** also switches the tracker on. To track a real storm, replace `buildDemoTyphoon()` in `!js/maps.js` with a PAGASA / JTWC feed.

## Evacuation site candidates
Loaded from OpenStreetMap for the visible area: official evacuation centers / assembly points, public schools (private schools are skipped), barangay halls, public health centers (RHU / BHS) and gyms. Filter chips in the Evacuation panel select each type.

## Route A to B and editing your location
- Route panel: **From (A)** and **To (B)** rows, each with a Change button. Pick a point by tapping the map, dragging the pin or searching a place. Swap A and B with the arrows. B can also be reset to the safest nearby evacuation site.
- Every full map has an **Edit my location** button under the map-style button. Set your position by hand (blue/amber dot turns amber) or tap **Use GPS** to go back to automatic.

## Fresh data and no-signal use
- A bar under the search box shows **Last updated: x ago**. Tap it to update now.
- While online, evacuation sites, the forecast and river data refresh automatically every hour (and when signal returns).
- Each answer is saved in the browser. With no signal the saved copy keeps drawing and the bar turns amber ("Offline. Saved 2 hours ago").
- Evacuation sites have a **Details** panel: type, safety of the ground, facilities (only what OpenStreetMap lists, otherwise "Not listed"), contact, what to bring.

## Faster evacuation search, cancel and redo
- Two Overpass mirrors are raced (the second starts after 3.5 s or on failure) and the first good answer wins. Official centers, schools and halls draw as soon as they arrive.
- A search covering the view that is under an hour old is answered instantly from the saved copy.
- The bar under the search box shows progress with **Cancel**; after a cancel, failure or empty result it offers **Search again / Try again**. The Evacuation panel also has **Redo search**.

## Accounts
Accounts are stored in this browser (passwords salted and hashed with SHA-256), so they survive a reload. Replace with a real backend before launch.

## Built-in backup list of evacuation sites
`!js/evac-backup.js` holds a saved list of sites. The app uses it only when the live search fails, or comes back empty, and no saved copy exists. Build or refresh it (needs internet) with:

    node tools/build-evac-backup.js                 # all areas in the script
    node tools/build-evac-backup.js "Guiuan"        # one town
    node tools/build-evac-backup.js --bbox 14.60,121.07,14.70,121.13 --name "My barangay"

The script is set up for Samar (Balangiga, Borongan, Guiuan, Oras, Dolores, Basey, Marabut, Catbalogan, Calbayog). Add more towns to the `AREAS` list at the top. Sites from the backup are marked as possibly out of date.

## Storm Surge and typhoon signal (Maps tab, Storm Surge layer)
- **Typhoon wind signal**: shows PAGASA's 5-level wind signal. You can tap the official signal announced for your area (kept 18 h, then it expires), and the app also **estimates** a signal from the next 48 h of Open-Meteo wind forecasts using PAGASA's wind speeds and lead times. Model winds often under-read typhoons, so the estimate is a rough guide only. With no signal the last saved forecast is shown and marked as old.
- **Storm surge scenario**: pick 1 to 5 m and all ground lower than that height is shaded by depth (from the same elevation tiles as the Flood layer), with a line saying whether your own location would be under water. It uses ground height only: no waves, tides, rivers or sea walls, and low spots far from the sea may stay dry. Use the height from the PAGASA storm surge warning for your coast.
- The Demo storm toggle also forces a Signal No. 3 estimate.

## Recovery (Home > "After the storm?")
- **I'm Safe**: check in as safe / need help / at an evacuation site, with where you are (typed or GPS), how many people are with you and a note. "Need help" shows call buttons and a link to send an SOS report. Past check-ins are listed.
- **Damage Report**: what was damaged (house, road, power, water, farm, boat, school), how bad, where, details and help needed (food, water, shelter materials, medical, cash/livelihood, debris clearing).
- Everything is saved on the phone (`bm.checkins.v1`, `bm.damage.v1`) and works offline. **Text it** opens the phone's messaging app with the message filled in (plain SMS, no internet), to a saved family / barangay number. Reports are not yet sent to a server, so responders only see what is texted to them.
