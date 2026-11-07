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
- **Reports layer**: your reports, community reports and live flood / landslide updates in one list and on the map. Shares one store with the Emergencies tab (`BayanihanMaps.addIncident / removeIncident`), so sending or deleting a report updates the map, "Open report" jumps to the report, and "View on map" jumps back.
- **Live flood levels / landslide reports are SIMULATED** (no free live feed exists). Flood levels only appear on ground under 3 m; landslide reports only on slopes of 18° or more, scaled by the rain forecast. Swap `simFloodGauges` / `simSlides` in `!js/maps.js` for a real feed. Serious ones near you add an item to Notifications that opens the map.
- **Weather overlay** (layers button): Rain radar, Rain forecast (next 6 h), Wind, Clouds. Works on any map style and risk layer.
