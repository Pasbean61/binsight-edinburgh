# BinSight Edinburgh

**Empty the bins that are full. Skip the ones that aren’t.**

BinSight forecasts how full each of Edinburgh’s general-waste communal bins will be tomorrow and plans the shortest truck routes that reach only the bins that need emptying. This repository holds the public website and the full forecasting and routing engine behind it.

A project by **EMS Group 6, University of Edinburgh**.

## The website

One page, in this order:

| Section | What you can do |
|---|---|
| **Problem** | Edinburgh’s communal-bin problem in sourced numbers, plus an interactive “timetable vs BinSight” fortnight |
| **How it works** | Sense → Predict → Optimise → Collect, with the real formulas and methods |
| **Live map** | All 4,533 real stops in their real wards: tomorrow’s forecast, overflow risk, the council’s full 17,713-asset register, 18 truck routes on real streets, search by street, stop and ward panels, driver view, alerts, sensor health and real weather |
| **Results** | Four collection strategies over a 7-day × 2-seed replay, forecast accuracy, ablation and weight sensitivity, and a shift-time reality check |
| **Planner** | Change the threshold, fleet, shift and lift time; distance is estimated with the Beardwood–Halton–Hammersley law calibrated to the optimised plan |
| **Business** | Three-partner model, revenue models A–G, gain-share calculator, go-to-market, evidence and risks |
| **Sources** | What is real, simulated or assumed, and every reference |
| **AI twin** | A chat rail that answers from the site’s data, ranks wards and streets, runs what-if scenarios and moves the map |

### The AI twin

The twin has two engines:

1. **Built-in engine** (always on, including GitHub Pages): intent rules over the live data (streets, stop IDs, wards, trucks, rankings, counts, what-if plans, gain-share, weather, model accuracy) plus a ranked knowledge base of 45 entries written from the business plan and the engine.
2. **Claude** (when the page is opened as a Claude artifact): the same data and knowledge base go to Claude, which can call page tools (`search_stops`, `rank_streets`, `truck_route`, `what_if`, `gain_share`, `show_on_map`) and streams its answer.

Open the browser console and run `__twinTest("your question")` to test the built-in engine.

## What is real

| Data | Status | Source |
|---|---|---|
| Bin locations, sizes, counts, street descriptions | Real | City of Edinburgh Council *Communal Bins* register (17,713 records, OGL v3.0) |
| Ward of every stop | Real | ONS Wards (December 2024) boundaries, point-in-polygon |
| Streets, rivers, parks | Real | OpenStreetMap via Overpass |
| Route geometry | Real streets | OSRM over OpenStreetMap |
| Hourly temperature and rain (4 Oct – 3 Nov 2026) | Real | Open-Meteo |
| Scottish bank holidays | Real | gov.scot |
| Problem, market and policy statistics | Real, cited | See the Sources section |
| Fill levels, collections, sensor battery and signal | **Simulated** | The council does not publish its sensor feed |
| Fleet (24 trucks × 60,000 L, 3 trips, 10 min/stop, 30 km/h) | Assumed | Modelling choices |

## Repository layout

```
index.html                  the website (built)
site/binsight.html          the same page without the document skeleton, for a Claude artifact
src/                        page source: style.css, body.html, app.js, twin.js
data/                       site data exported from the engine
scripts/build_site_data.py  engine database → data/*.json (OSRM street routes are cached)
scripts/build_page.py       src/ → index.html and site/binsight.html
engine/                     the forecasting and routing engine (Python)
```

## Rebuild everything

Requirements: Python 3.9+, `curl`.

```bash
cd engine
pip install -r requirements.txt
python run_pipeline.py --force-data --retrain --experiments development   # about 25 minutes
cd ..
python scripts/build_site_data.py
python scripts/build_page.py
python -m http.server 8000      # open http://localhost:8000
```

### Changes to the engine for this site

The engine is adapted from the team’s [BinSight](https://github.com/mizj1213wcz/binsight) repository, itself an adaptation of [EcoBin](https://github.com/RishvinReddy/EcoBin-Smart-Waste-Management-System) by Rishvin Reddy (MIT). For this site:

- **Real wards** replace the k-means “zones”: every stop is placed in its ONS ward (`engine/ml/data_generator/edinburgh_stops.py`).
- **Real weather** replaces the synthetic weather: the simulation reads hourly Open-Meteo data for Edinburgh (`engine/ml/data_generator/generator.py`, `engine/data/raw/weather_edinburgh_hourly.csv`).
- **Fixed history window** ending 3 November 2026 (`HISTORY_END` in `engine/config/city.py`), so the snapshot is reproducible.
- Experiments run at the `development` size (7 days × 2 seeds) instead of the 2-day smoke run.
- The React frontend is replaced by this website; the FastAPI backend, driver and maintenance portals, QR identity and the ESP32 sketch are unchanged in `engine/`.

## Licences and attribution

- Code: MIT (see `LICENSE` and `engine/LICENSE`).
- Bin data: City of Edinburgh Council, *Communal Bins*, Open Government Licence v3.0. Contains OS data © Crown copyright and database right 2026.
- Ward boundaries: Office for National Statistics, Open Government Licence v3.0.
- Map data: © OpenStreetMap contributors, ODbL.
- Weather: Open-Meteo, CC BY 4.0.
