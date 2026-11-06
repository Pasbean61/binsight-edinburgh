# BinSight model: methods

The model behind the website, written from scratch by EMS Group 6. One line:

**simulate the bins → a random forest projects each stop's fill → empty the fullest first until the trucks are full → route them → compare with today's timetable.**

Run `python -m model.run` from the repository root; every number on the site comes from it. `python -m model.calibrate` re-derives the one calibrated parameter.

**What is real:** the 4,533 general-waste communal bin stops (City of Edinburgh Council register, OGL), wards (ONS), the drivable street network (OpenStreetMap, ODbL), hourly weather (Open-Meteo), the council's collection frequency, public and school holidays, and the reported complaint rate.
**What is simulated:** fill levels, because the council does not publish sensor data.
**What is assumed:** fleet, shift and costs, plus two structural assumptions about how bins fill, all in `config.py`. Every value there is labelled REAL, CALIBRATED or ASSUMPTION.

## 1 · Simulate: how communal bins fill (`simulate.py`, `calibrate.py`)

How fast a stop fills is derived from how the council runs the service, not guessed:

- **Collection frequency (real).** The council empties communal general-waste bins every K = 2 days, so a stop's capacity is sized for about two days of its households' waste.
- **Fill speed.** If a stop is on average a share U full when the truck comes, it fills ρᵢ = U / K · e^(σZᵢ) of its capacity a day. σ = 0.35 spreads the stops, because some serve more flats than others (structural assumption: the register does not say how many flats each stop serves).
- **Calibration (real target).** Of about 100,000 communal-bin collections a month, 1–1.5 % draw a complaint (council Transport and Environment Committee report, December 2017); we use the lower end, 1 %. `calibrate.py` runs the council's every-two-days timetable for a grid of U and picks the U at which overflows are 1 % of collections: **U = 0.415**. At that value bins are on average 44 % full when the timetable truck empties them. The complaint rate is a lower bound on overflows, so this is conservative.
- **Deposits.** Households drop one 30 L kitchen-bin bag at a time (real: a small/medium kitchen pedal bin is 30 L). In hour t, Nᵢₜ ~ Poisson(λᵢₜ) bags arrive, with λᵢₜ = (Dᵢ / 30 L) · a(hour) / 24 and Dᵢ = capᵢ · ρᵢ. The hour-of-day profile a (quiet at night, morning and evening peaks, mean 1) is the second structural assumption.
- **Sensors.** Readings are the true fill plus N(0, 1²) percentage points (real: ultrasonic bin sensors are accurate to about ±10 mm, about 1 % of a 1 m deep container).

**Weather and holidays** are real inputs (Open-Meteo; City of Edinburgh Council public and school holidays), but the simulator gives them **no effect**: we found no reliable evidence of how much they change hourly deposits. They are inputs to the forecast, which can learn their effect from real data.

## 2 · Predict: a random-forest fill forecast (`predict.py`)

Every morning at 05:00 one random forest (scikit-learn defaults, 100 trees) predicts, for every stop, how many percentage points it will gain per hour over the next day. The projected fill at the next chance of a truck (14:00 tomorrow) is

  ŷᵢ = yᵢ + ĝᵢ · hours

and may pass 100 %: a stop projected at 130 % is expected to overflow well before then.

**Inputs** (only what a real system has): latest reading; fill rate since last emptied; change over the last 24 h; hours since last emptied; capacity; weekday; hours of rain and mean temperature before the next chance of a truck; share of those hours on a holiday.

**Target:** the reading 24 h later minus the reading now, over 24, on every past morning when no truck came in between. The forest is retrained every morning on all the days seen so far.

**Why regression, not a classifier of "will it overflow?".** The fleet cannot reach every stop at risk, so the order among them decides who waits. A classifier gave about 1,550 stops p ≥ 0.99 and only 35 distinct values among the top 1,250, so the order at the top was arbitrary. The projected fill still separates a stop that fills in two hours from one that fills in thirty.

## 3 · Decide: fullest first until the fleet is full (`decide.py`)

  **Sort the stops by ŷᵢ, fullest first, and take them while the fleet has time. Never take a stop with ŷᵢ < 80 %.**

80 % is the threshold smart-bin systems commonly use to flag a bin for collection. A stop's time is its lifting time plus the drive from its nearest other candidate; each full load adds a 25-minute tip. The estimate is rough on purpose: routing has the final say, and if the trips do not fit the fleet it drops the least full stops first.

## 4 · Route: a multi-trip CVRP with a shift limit (`route.py`, `network.py`)

**Costs.** The street graph comes from OpenStreetMap (largest connected component, speeds by road class, undirected). Dijkstra gives every distance and time, and c_ij = 1.45·km + 75·h.

**Problem.** Minimise Σ c_ij x_ij such that each chosen stop is visited once; each trip's load is ≤ 60 m³, then the truck tips (25 min); each truck's drive + lift + tip is ≤ 480 min; the fleet is the one the council timetable needs (section 5).

**Heuristic.** Clarke–Wright savings over 20-nearest-neighbour pairs; local search (2-opt and Or-opt inside trips, relocate and swap between trips); simulated annealing; first-fit decreasing packing into shifts, dropping the stops of least value per minute saved if the fleet is short.

## 5 · Before and after (`experiment.py`)

Three policies on the same simulated city, with the same deposits and sensor noise (common random numbers):

| Policy | Empties | Stands for |
|---|---|---|
| Timetable | every stop every second day, in fixed geographic rounds | today's practice |
| Reactive | every stop reading ≥ 80 % at 05:00 | sensors, no forecast |
| BinSight | forecast → fullest first → routes | this model |

**Same fleet for all three.** No public figure says how many of Edinburgh's roughly 100 refuse trucks serve communal general waste, so the fleet is derived from the council's own practice: the timetable is routed without a fleet limit, and the number of trucks it needs on its busiest day becomes the fleet for every policy. BinSight is therefore compared with today's practice at equal resources.

Each policy has 15 days of timetable warm-up and 14 days of its own; the last 7 (26 Oct – 1 Nov) are scored, for 2 seeds. The comparison is relative: the absolute numbers depend on the simulated city.

## Limitations

- Fill is simulated; the forecast is trained and tested on the same simulator.
- Two structural assumptions (spread of fill speed across stops, hour-of-day profile) have no direct source.
- Weather and holidays have no effect in the simulator; their effect on real deposits is unknown.
- The complaint rate used for calibration is a lower bound on overflows, and dates from a press report.
- One-way streets and turn restrictions are ignored; tomorrow's weather is assumed known.
- Trucks tip at Seafield; real residual waste goes to Millerhill.
- Shift, truck load and cost parameters are assumptions; the fleet is derived from the simulated timetable.

## Data not in git

`data/cache/` holds `osm_roads.json` (Overpass query for `highway` ~ motorway…service inside the bounding box in `config.py`, excluding private access, parking aisles and driveways), `osm_basemap.json` (major roads, rivers and parks for the light fallback map) and `matrix.npz` (built from the road graph on first run).

## Acknowledgement

The first prototype built on [EcoBin](https://github.com/RishvinReddy/EcoBin-Smart-Waste-Management-System) (MIT) by Rishvin Reddy, which we thank. None of its code is used here.
