# BinSight model: methods

The model behind the website, written from scratch by EMS Group 6. One line:

**simulate the bins (with weather and holidays) → a random forest projects each stop's fill → empty the fullest first until the trucks are full → route them with one optimisation model solved by simulated annealing → compare with today's timetable.**

Run `python3 -m model.run` from the repository root; every number on the site comes from it. `python3 -m model.calibrate` re-derives the one calibrated parameter.

**What is real:** the 4,532 general-waste communal bin stops (City of Edinburgh Council register, OGL), wards (ONS), the drivable street network (OpenStreetMap, ODbL), hourly weather (Open-Meteo), the council's collection frequency, public and school holidays, and the reported complaint rate.
**What is simulated:** fill levels, because the council does not publish sensor data.
**What is assumed:** fleet, shift and costs, two structural assumptions about how bins fill, and the size of the weather and holiday effects, all in `config.py`. Every value there is labelled REAL, CALIBRATED or ASSUMPTION.

## 1 · Simulate: how communal bins fill (`simulate.py`, `calibrate.py`)

How fast a stop fills is derived from how the council runs the service, not guessed:

- **Collection frequency (real).** The council empties communal general-waste bins every K = 2 days, so a stop's capacity is sized for about two days of its households' waste.
- **Fill speed.** If a stop is on average a share U full when the truck comes, it fills ρᵢ = U / K · e^(σZᵢ) of its capacity a day. σ = 0.35 spreads the stops, because some serve more flats than others (structural assumption: the register does not say how many flats each stop serves).
- **Calibration (real target).** Of about 100,000 communal-bin collections a month, 1–1.5 % draw a complaint (council Transport and Environment Committee report, December 2017); we use the lower end, 1 %. `calibrate.py` runs the council's every-two-days timetable for a grid of U and picks the U at which overflows are 1 % of collections: **U = 0.415**. At that value bins are on average 44 % full when the timetable truck empties them. The complaint rate is a lower bound on overflows, so this is conservative.
- **Deposits.** Households drop one 30 L kitchen-bin bag at a time (real: a small/medium kitchen pedal bin is 30 L). In hour t, Nᵢₜ ~ Poisson(λᵢₜ) bags arrive, with λᵢₜ = (Dᵢ / 30 L) · a(hour) · wₜ / 24 and Dᵢ = capᵢ · ρᵢ. The hour-of-day profile a (quiet at night, morning and evening peaks, mean 1) is the second structural assumption.
- **Sensors.** Readings are the true fill plus N(0, 1²) percentage points (real: ultrasonic bin sensors are accurate to about ±10 mm, about 1 % of a 1 m deep container).

**Weather and holidays.** The hourly weather (Open-Meteo) and the council's public and school holidays are real. Their effect on deposits is one factor per hour,

  wₜ ∝ exp(−0.15 · 1[rain ≥ 0.5 mm]) · (1 + 0.01 · (Tₜ − 10 °C)) · (1 + 0.10 · 1[holiday]),

rescaled to mean 1 over the month so the calibrated U still holds: 14 % fewer bags in a wet hour, 1 % more per °C above 10 °C, 10 % more on a holiday. The weather and the holidays are real; **the three effect sizes are assumptions** (`RAIN_EFFECT`, `TEMP_EFFECT`, `HOLIDAY_EFFECT` in `config.py`), because we found no published figure. The forecast sees rain, temperature and holidays as inputs and learns their effect from the data; the route model puts the same factor in its constraints (section 4).

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

## 4 · Route: one model, solved by simulated annealing (`route.py`, `decide.py`, `network.py`)

The stops chosen in section 3 are routed as one **prize-collecting multi-trip vehicle-routing problem with a shift limit**: K trucks leave the Seafield depot (0), and truck k makes trips r = 1, 2, …, tipping at the depot between them.

- **Network (real).** Dijkstra on the OpenStreetMap street graph (largest connected component, undirected, speeds by road class) gives every distance dᵢⱼ (km) and driving time τᵢⱼ (min).
- **Cost of a drive.** cᵢⱼ = 1.45 · dᵢⱼ + 75 · θτᵢⱼ / 60 (£): £1.45 per km for fuel and wear, £75 per truck-hour for crew and vehicle. θ ≥ 1 is the rain slowdown (below).
- **Prize.** πᵢ = 60 · ŷᵢ / 100 (£) is paid if stop i is left out: its share of a £60 overflow, so the fuller the stop, the dearer it is to skip.
- **Operations (assumed).** One load Q = 60,000 L; one shift H = 480 min; tipping t_tip = 25 min; emptying stop i takes sᵢ = 2 + 1 · binsᵢ min.

**Variables.** xᵢⱼₖᵣ = 1 if truck k drives i → j on trip r; zᵢₖᵣ = 1 if that trip empties stop i; uₖᵣ = 1 if the trip is made.

  minimise   Σₖᵣ Σᵢⱼ cᵢⱼ xᵢⱼₖᵣ + Σᵢ πᵢ (1 − Σₖᵣ zᵢₖᵣ)   (driving cost + prizes of the stops left out)

subject to

1. Σₖᵣ zᵢₖᵣ ≤ 1: each stop is emptied at most once;
2. Σⱼ xᵢⱼₖᵣ = Σⱼ xⱼᵢₖᵣ = zᵢₖᵣ: a truck that arrives at a stop leaves it;
3. Σⱼ x₀ⱼₖᵣ = uₖᵣ: every trip made starts at the depot;
4. **Load:** Σᵢ qᵢ zᵢₖᵣ ≤ Q uₖᵣ: a trip carries at most one load, then tips;
5. **Shift:** Σᵣ (Σᵢⱼ θτᵢⱼ xᵢⱼₖᵣ + Σᵢ sᵢ zᵢₖᵣ + t_tip uₖᵣ) ≤ H: a truck's driving, emptying and tipping fit one shift;
6. no sub-tours; x, z, u ∈ {0, 1}.

Serving stop i costs the drive to reach it; skipping it costs πᵢ. A stop is therefore left out only when the fleet cannot fit it, and then the least full go first. The timetable and the reactive rule must empty every stop they pick, so for them πᵢ = 10⁶ and qᵢ = 0.6 · capᵢ.

**Weather and holidays** enter (4) and (5) through the same hourly factor wₕ as the simulator (section 1):

- **Load.** qᵢ = capᵢ · min(1, (yᵢ + bᵢW) / 100), with yᵢ the latest reading, bᵢ = yᵢ / Σ wₕ over the hours since stop i was last emptied (its fill per unit of factor), and W = Σ wₕ from the decision to mid-shift. Rain lowers qᵢ; warmth or a holiday raises it.
- **Shift.** θ = 1 + 0.10 · (share of the shift's hours with ≥ 0.5 mm of rain). Rain lengthens every drive, so fewer stops fit and each costs more. The 10 % is an assumption (`RAIN_SLOWDOWN`).

**Algorithm: simulated annealing.** The model is NP-hard and a day has over a thousand stops, so it is solved approximately, by this one method. Every plan it visits satisfies (1)–(6).

1. **Start.** Fill truck after truck, trip after trip, with the nearest stop that still fits (4) and (5); the rest wait in a pool.
2. **Move.** Pick a stop v and one of its 20 nearest stops w, and try one change: *relocate* v next to w, *swap* v and w, *2-opt* (reverse the path from v to w in a trip), *2-opt\** (exchange the tails of two trips after v and w), *drop* v to the pool, or put v on a *new trip*. A pooled stop comes back by relocate or swap. Now and then a whole trip moves to another truck, or two trucks trade trips, to gather spare shift time.
3. **Accept** a change Δ in the objective if Δ ≤ 0, otherwise with probability e^(−Δ/T). The temperature cools geometrically over the time budget t_max:

   T(t) = T₀ · (T₁ / T₀)^(t / t_max),   T₀ = 3c̄,   T₁ = 0.002c̄,

   where c̄ is the mean arc cost of the starting plan, and t_max = 30 s for tomorrow's plan, 15 s a day in the experiment.
4. **Return** the best plan seen.

**Fleet.** Each timetable round g is routed with the trucks its start needs, then with one fewer at a time until a stop is left out; K(g) is the last count that still empties every stop. The fleet for all three policies is K = max K(g) over the rounds, i.e. what the busiest round needs.

**Check against the previous four-stage heuristic** (savings, local search, annealing, packing), on real stop locations with straight-line distance × 1.35 at 22 km/h, 24 trucks, equal run time:

| Instance | Previous: £ route + £60 per stop left out | Annealing only |
|---|---:|---:|
| 1,500 stops (a) | £7,773 | £7,181 |
| 1,500 stops (b) | £6,796 | £6,456 |
| 1,300 stops | £4,696 | £4,616 |
| Timetable round of 2,404 stops (route £, trucks) | £6,611, 35 | £6,479, 35 |
| Timetable round of 2,128 stops (route £, trucks) | £5,028, 30 | £4,830, 31 |

Annealing alone matched or beat the four stages on route cost every time, at one truck more on the smaller round. These checks used an approximate distance matrix; rerun them on the OpenStreetMap matrix.

## 5 · Before and after (`experiment.py`)

Three policies on the same simulated city, with the same deposits, weather and sensor noise (common random numbers). The reactive rule and BinSight are routed each day with that day's rain slowdown θ; the timetable's rounds are fixed:

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
- The size of the weather and holiday effects (on deposits and on driving) is assumed; the route model uses the same factor as the simulator, as if it were known exactly.
- The complaint rate used for calibration is a lower bound on overflows, and dates from a press report.
- One-way streets and turn restrictions are ignored; tomorrow's weather is assumed known.
- Simulated annealing gives a good plan, not a proven optimum.
- Trucks tip at Seafield; real residual waste goes to Millerhill.
- Shift, truck load and cost parameters are assumptions; the fleet is derived from the simulated timetable.

## Data not in git

`data/cache/` is too big for git (188 MB). Download it with `python3 scripts/fetch_cache.py`, which fetches the zip attached to the GitHub release [`road-cache-v1`](https://github.com/Pasbean61/binsight-edinburgh/releases/tag/road-cache-v1). It holds `osm_roads.json` (Overpass query for `highway` ~ motorway…service inside the bounding box in `config.py`, excluding private access, parking aisles and driveways), `osm_basemap.json` (major roads, rivers and parks for the light fallback map) and `matrix.npz` (shortest-path driving distance and time between every stop and the depot: `network.RoadGraph.matrices`, Dijkstra on the street graph).

## Acknowledgement

The first prototype built on [EcoBin](https://github.com/RishvinReddy/EcoBin-Smart-Waste-Management-System) (MIT) by Rishvin Reddy, which we thank. None of its code is used here.
