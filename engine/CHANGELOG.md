# Changelog

## 2026-10-30 — City of Edinburgh adaptation

Forked from EcoBin (RishvinReddy/EcoBin-Smart-Waste-Management-System@a782a9c).

### Data
- Real bin network: 4,533 general-waste communal-bin stops built from City of Edinburgh
  Council's *Communal Bins* open data (British National Grid to WGS84, co-located assets
  merged, capacity = bins x size, 1 record with impossible coordinates dropped).
- Stop IDs `EDI-<asset number>` (council IDs contain `/`, which broke API paths);
  the original asset ID is kept in `bins.source_asset_id`.
- Synthetic 30-day hourly history, vectorised; Edinburgh climate and Scottish bank holidays.
- All city constants moved to `config/city.py` (`GET /api/config` serves them).

### Forecasting
- Time-based train/test split as a fraction of the history (was a fixed 300 days).
- Faster rolling features (same values). Prediction code shared by pipeline and API.

### Routing
- Vectorised distance matrix; trucks can make several trips per shift;
  unserved bins reported instead of an empty solution.
- Fleet: 24 trucks x 60,000 L x up to 3 trips, from Seafield Depot.
- Vectorised experiment engine shared by the strategy comparison and sensitivity study.

### App
- Esri ArcGIS basemaps (Light Gray default) as on the council's ArcGIS Hub site.
- Canvas-rendered bin markers for 4,500+ stops; bins table capped at 300 rows.
- OSRM street snapping one request at a time, only when the route plan changes.
- Live simulator writes one batched update per tick instead of one HTTP call per bin.
- Edinburgh depot, labels and defaults across dashboard, fleet, driver and maintenance views.

### Fixes
- Removed the upstream author's hard-coded EmailJS keys (frontend and backend).
- Restored the full MIT licence text (upstream file had only the copyright line).
- Docker: Postgres insert batch under the bind-parameter limit; frontend proxy reaches the
  backend container; startup no longer reruns experiments.
