# BinSight model: methods

The model behind the website, written from scratch by EMS Group 6. Five layers, each a piece of mathematics we can state, test and explain. Run `python -m model.run` from the repository root; every number on the site comes from it. Results for the current build are in [`RESULTS.md`](RESULTS.md).

**What is real:** the 4,533 general-waste communal bin stops (City of Edinburgh Council register, OGL), wards (ONS), the drivable street network (OpenStreetMap, ODbL) and hourly weather (Open-Meteo).
**What is simulated:** fill levels, because the council does not publish sensor data.
**What is assumed:** fleet, shift and costs, all in `config.py`.

## 1 · Model: a compound Poisson fill process (`simulate.py`)

In hour *t*, stop *i* receives *N* bags, *N* ~ Poisson(λᵢₜ), each of volume *V* ~ Gamma(*k* = 2, mean *v̄* = 35 L):

  Xᵢₜ = V₁ + … + V_N,  λᵢₜ = (Dᵢ / v̄) · a(hour, weekday) · wₜ · cᵢₜ / 24

- Dᵢ = capᵢ · ρᵢ is litres a day, with ρᵢ ~ LogNormal(log 0.20, 0.35).
- a is an hour-of-week profile with mean 1.
- wₜ = exp(−0.15 · 1[rain ≥ 0.5 mm]) · (1 + 0.01(T − 10)) uses real weather.
- cᵢₜ = 1.25 on Friday–Sunday in the City Centre ward.

A sum of *n* Gamma(*k*, θ) variables is Gamma(*nk*, θ), so each hour is one exact draw. By the law of total variance, E[X] = λv̄ and Var[X] = λE[V²] = λv̄²(1 + 1/k). The dispersion φ = Var/E is therefore v̄(1 + 1/k) = 52.5 L.

Sensors report min(100, 100F/cap) + N(0, 1.5²), rounded and clipped to [0, 100].

## 2 · Predict: a probabilistic forecast (`forecast.py`)

1. **City-wide shape.** Least squares on log mean hourly increments:
   log gₜ = β₀ + h(hour) + d(weekday) + β_rain 1[rain] + β_temp (T − 10)
   This gives mₜ, the expected share of a day's waste in hour *t*.
2. **Each stop's rate.** Each day gives an observation *o* (litres per average day), and the rate is smoothed: rᵢ ← (1 − β) rᵢ + β o, with β = 0.3. Smoothed squared relative errors eᵢ² are tracked alongside. Hours with a collection or a censored reading (≥ 99 %) are excluded.
3. **Forecast** to the next chance of a truck, with μ_L = rᵢ Σₜ mₜ:
   μᵢ = yᵢ + 100 μ_L / capᵢ,  σᵢ² = (100/capᵢ)² (φ μ_L + β/(2 − β) eᵢ² μ_L²) + σₛ²
   The three variance terms are Poisson arrivals, EWMA estimation error and sensor noise. φ is estimated from the data.
4. **Overflow risk:** pᵢ = 1 − Φ((100 − μᵢ)/σᵢ). This is valid because fill only rises between collections.

## 3 · Decide: a chance-constrained, capacity-priced rule (`decide.py`)

Value of collecting stop *i* tomorrow, on a renewal argument (emptying *k* days early wastes *k*/τ of a cycle):

  vᵢ = pᵢ c_o − Δᵢ kᵢ / τᵢ,  kᵢ = 1 + max(0, (100 − μᵢ) / gᵢ),  gᵢ = 100/τᵢ

- c_o = £60 per overflow.
- Δᵢ = the cost of inserting the stop into the routes (£1.45/km + £75/truck-hour).
- τᵢ = days from empty to full.

Tomorrow is a knapsack, max Σ vᵢxᵢ subject to Σ tᵢxᵢ ≤ T (fleet minutes) and xᵢ = 1 when pᵢ > α. Its Lagrangian relaxation gives:

  **collect i ⇔ pᵢ > α or vᵢ > λ tᵢ**,  α = 0.20

λ = 0 if the fleet has room; otherwise λ is found by bisection. Δᵢ and tᵢ start as cheapest-insertion estimates between nearby mandatory stops. After the first routing they are replaced by the exact insertion and removal values, the time estimate is recalibrated against what routing actually used, and the rule is applied again.

## 4 · Route: a multi-trip CVRP with a shift limit (`route.py`, `network.py`)

**Costs.** The street graph comes from OpenStreetMap (largest connected component, speeds by road class, undirected). Dijkstra gives every distance and time, and c_ij = 1.45·km + 75·h.

**Problem.** Minimise Σ c_ij x_ij such that:
- each chosen stop is visited once;
- each trip's load is ≤ 60 m³, then the truck tips (25 min);
- each truck's drive + lift + tip is ≤ 480 min;
- there are 24 trucks;
- MTZ load variables prevent subtours.

**Heuristic.**
1. Clarke–Wright savings s_ij = c₀ᵢ + c₀ⱼ − c_ij over 20-nearest-neighbour pairs.
2. Local search: 2-opt and Or-opt inside trips; relocate and swap between trips.
3. Simulated annealing: accept a worse move with probability e^(−Δ/T), with geometric cooling, then local search again.
4. First-fit decreasing packing into shifts. If the fleet is short, drop the stops with the least value per minute saved.

## 5 · Check: validation (`exact.py`, `experiment.py`)

- **Exact optima.** A two-index CVRP MILP with MTZ constraints, solved by HiGHS (scipy) on 30 real 12-stop instances. Each heuristic stage is compared with the proven optimum.
- **Lower bound for the full plan.** max(Held–Karp 1-tree bound with subgradient optimisation, radial bound 2 Σ qᵢ c₀ᵢ / Q). This gives a proven worst-case gap.
- **Fleet lower bound.** ⌈(Σ lift + Σᵢ min_j T_ij + ⌈Σq/Q⌉ (tip + min T₀ⱼ)) / 480⌉.
- **Experiment.** Rolling horizon with common random numbers: the same deposits and sensor noise are fed to the timetable (every third day, geographic rounds), reactive (≥ 80 % at 05:00) and BinSight policies. Each policy has 15 days of timetable warm-up and 14 days of its own; the last 7 (26 Oct – 1 Nov) are scored, for 2 seeds.
- **Forecast scoring.** MAE and RMSE against persistence and last-day trend, Brier score against climatology, interval coverage and a reliability diagram, on stops untouched until the target hour.
- **Trade-off and robustness.** A Pareto front over c_o (cost rule alone) and the sensitivity of tomorrow's plan to shift, service time, load, fleet, α and c_o.

## Limitations

- Fill is simulated, and the forecast is tested on the same simulator, so its accuracy is optimistic.
- One-way streets and turn restrictions are ignored.
- Tomorrow's weather is assumed known.
- Trucks tip at Seafield; real residual waste goes to Millerhill.
- Cost parameters are assumptions.
- The full-plan lower bound is loose.

## Data not in git

`data/cache/` holds:
- `osm_roads.json`: Overpass query for `highway` ~ motorway…service inside the bounding box in `config.py`, excluding private access, parking aisles and driveways;
- `osm_basemap.json`: major roads, rivers and parks for the light fallback map;
- `matrix.npz`: built from the road graph on first run.

## Acknowledgement

The first prototype built on [EcoBin](https://github.com/RishvinReddy/EcoBin-Smart-Waste-Management-System) (MIT) by Rishvin Reddy, which we thank. None of its code is used here.
