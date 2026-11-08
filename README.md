# BinSight Edinburgh

**Empty the bins that are full. Skip the ones that aren’t.**

<p align="center">
  <a href="https://pasbean61.github.io/binsight-edinburgh/"><img src="docs/preview.jpg" alt="BinSight Edinburgh website: homepage with the forecast map" width="100%"></a>
</p>

<p align="center">
  <a href="https://pasbean61.github.io/binsight-edinburgh/"><img src="https://img.shields.io/badge/%E2%96%B6%20Open%20the%20live%20website-pasbean61.github.io%2Fbinsight--edinburgh-0d6b55?style=for-the-badge" alt="Open the live website"></a>
</p>

<p align="center"><b><a href="https://pasbean61.github.io/binsight-edinburgh/">pasbean61.github.io/binsight-edinburgh</a></b> · click the picture or the button to open the site</p>

### Tomorrow’s shift, replayed

34 trucks leave Seafield at 06:00 and drive real Edinburgh streets to the 2,127 stops the plan serves. The last one is back just before 14:00, inside the 8-hour shift. [Watch it live on the site →](https://pasbean61.github.io/binsight-edinburgh/#console)

<p align="center">
  <a href="https://pasbean61.github.io/binsight-edinburgh/#console"><img src="docs/replay.gif" alt="Replay of tomorrow's collection shift on the Edinburgh street map" width="100%"></a>
</p>

### Zoom to street level

The map is a real street map of Edinburgh. Zoom in to see every building, street name and house number, with each truck’s route in its own colour (here: Haymarket, the West End and Dalry).

<p align="center">
  <a href="https://pasbean61.github.io/binsight-edinburgh/#console"><img src="docs/street.jpg" alt="Street-level view around Haymarket and the West End with truck routes and bin stops" width="100%"></a>
</p>

## About

BinSight forecasts how full each of Edinburgh’s general-waste communal bins will be tomorrow and plans the shortest truck routes that reach only the bins that need emptying. This repository holds the public website and the model behind it, written from scratch by the team: a stochastic fill model, a random-forest fill forecast, a fullest-first decision rule, a routing heuristic, and a before-and-after comparison with the council timetable. The maths is explained on the site and in [`model/README.md`](model/README.md).

A project by **EMS Group 6, University of Edinburgh**.

## The website

One page, in this order:

| Section | What you can do |
|---|---|
| **Problem** | Edinburgh’s communal-bin problem in sourced numbers, plus an interactive “timetable vs BinSight” fortnight |
| **How it works** | Sense → Predict → Optimise → Collect, with the real formulas and methods |
| **Live map** | A real street map of Edinburgh you can zoom from the whole city down to single buildings and house numbers, with all 4,532 real stops in their real wards, plus a replay of tomorrow’s shift: 34 trucks leave Seafield at 06:00, drive their routes on real streets and empty each flagged bin while trails, counters and the clock run. Follow any truck, hover and open wards, search streets, switch to overflow risk or the council’s full 17,713-asset register; driver view, alerts, sensor health and real weather below the map |
| **The maths** | Five interactive tabs: the calibrated fill simulator, the random-forest forecast, the fullest-first rule, the routing and the before-and-after check |
| **Results** | Three collection strategies (timetable, reactive, BinSight) over a 7-day × 2-seed replay, forecast accuracy, the overflow-cost trade-off and a 12-way sensitivity check |
| **Planner** | Change the threshold, fleet, shift and lift time; distance is estimated with the Beardwood–Halton–Hammersley law calibrated to the optimised plan |
| **Business** | Three-partner model, revenue models A–G, gain-share calculator, go-to-market, evidence and risks |
| **Sources** | What is real, simulated or assumed, and every reference |

## What is real

| Data | Status | Source |
|---|---|---|
| Bin locations, sizes, counts, street descriptions | Real | City of Edinburgh Council *Communal Bins* register (17,713 records, OGL v3.0) |
| Ward of every stop | Real | ONS Wards (December 2024) boundaries, point-in-polygon |
| Street map: buildings, street names, house numbers, stations, parks | Real | OpenStreetMap vector tiles from [OpenFreeMap](https://openfreemap.org), drawn with MapLibre GL (a light Overpass-based map is the offline fallback) |
| Road network, distances, times, route geometry | Real streets | OpenStreetMap via Overpass (ODbL), our Dijkstra shortest paths |
| Hourly temperature and rain (4 Oct – 2 Nov 2026), and the 7-day forecast issued on 2 Nov | Real | Open-Meteo |
| Problem, market and policy statistics | Real, cited | See the Sources section |
| Fill levels, collections, sensor battery and signal | **Simulated** | The council does not publish its sensor feed |
| Fleet and costs (the trucks the timetable needs on its busiest round × 60 m³, 8-hour shift, 2 min a stop + 1 min a bin, £1.45/km, £75/truck-hour, £60 per overflow) | Assumed | `model/config.py` |

## Repository layout

```
index.html                  the website (GitHub Pages), built from src/
src/                        page source: body.html, style.css, app.js, maths.js
data/                       site data written by the model
model/                      the BinSight model (Python: numpy, scipy, scikit-learn, pyproj)
  network.py                real stops, wards and the OpenStreetMap road graph
  simulate.py               fill simulator (council collection frequency, 30 L bags)
  calibrate.py              calibrates the simulator to the council complaint rate
  predict.py                random-forest fill forecast
  decide.py                 fullest-first decision rule
  route.py                  Clarke–Wright, local search, simulated annealing, shift packing
  experiment.py             before and after: timetable vs reactive vs BinSight
  export.py, run.py         site data and the entry point
scripts/build_page.py       src/ → index.html and site/binsight.html
docs/                       README images
```

## Rebuild everything

```bash
pip install numpy scipy pyproj
python scripts/fetch_cache.py       # once: downloads the road-network cache (131 MB) from the release road-cache-v1
python -m model.run --experiments   # about 25 minutes on 10 cores; omit the flag to reuse cached experiments
python scripts/build_page.py
```

The road network (`model/data/cache/osm_roads.json`) and its distance matrix (`matrix.npz`, 164 MB) are too big for git, so they are attached to the GitHub release [`road-cache-v1`](https://github.com/Pasbean61/binsight-edinburgh/releases/tag/road-cache-v1). `python scripts/fetch_cache.py` downloads them into `model/data/cache/`.

## Acknowledgement

The team’s first prototype built on the open-source [EcoBin](https://github.com/RishvinReddy/EcoBin-Smart-Waste-Management-System) project by Rishvin Reddy (MIT licence). We thank its author. None of its code is used now: the model in `model/` is our own.

## Licences and attribution

- Code: MIT (see `LICENSE`).
- Bin data: City of Edinburgh Council, *Communal Bins*, Open Government Licence v3.0. Contains OS data © Crown copyright and database right 2026.
- Ward boundaries: Office for National Statistics, Open Government Licence v3.0.
- Map data: © OpenStreetMap contributors, ODbL. Map tiles: OpenFreeMap. Rendering: MapLibre GL JS (BSD-3) with maplibre-gl-leaflet.
- Weather: Open-Meteo, CC BY 4.0.
