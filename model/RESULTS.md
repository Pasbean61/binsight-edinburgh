# BinSight model: results

These numbers come from `python -m model.run --experiments` (the random-forest model, build of 8 Nov 2026). They are for the report and the slides. Method details are in [`README.md`](README.md). Every figure here is in `data/site.json` or follows from it by arithmetic.

**The setting:**
- 4,532 general-waste communal bin stops (10,657 containers) in 17 wards.
- 34 trucks. That is what the council's every-second-day timetable needs on its busiest day, and all three policies get the same fleet.
- Each truck carries 60 m³ loads on an 8-hour shift from 06:00 and tips at Seafield.
- Costs are £1.45/km, £75 per truck-hour and £60 per overflow.

## 1 · Main experiment: three policies on the same city

All three policies see the same deposits, weather and sensor noise (common random numbers). Each policy had 15 days of timetable warm-up and then 14 days of its own. The scores cover the last 7 days (26 Oct – 1 Nov 2026), averaged over 2 seeds. The ± is the standard deviation between the two seeds.

| Per day | Timetable (every 2nd day) | Reactive (≥ 80 % at 05:00) | **BinSight** |
|---|---:|---:|---:|
| Overflow events | 20.0 ± 0.8 | 341.9 ± 13.6 | **3.6 ± 1.4** |
| Bin-hours spent overflowing | 145.5 | 3,138.6 | **10.1** |
| Collections | 2,285.7 | 1,022.0 | 1,572.4 |
| Fill when emptied | 43.4 % | 93.8 % | 63.9 % |
| Emptied under 40 % full | 48.8 % | 0 % | 3.4 % |
| Road km | 1,200.8 | 695.6 | 1,022.2 |
| Truck-hours | 245.5 | 117.6 | 180.2 |
| Trucks used (mean / max) | 33.0 / 34.5 | 23.8 / 26.5 | 32.1 / 33.0 |
| Route cost (km + all truck-hours) | £20,153 | £9,831 | £15,000 |
| Overflow cost (£60 each) | £1,200 | £20,516 | £214 |
| **Total cost** | £21,353 | £30,347 | **£15,214** |

**Headline numbers:**
- **Overflows:** BinSight cuts overflow events by **82 %** against the timetable (3.6 vs 20.0 a day) and by 99 % against the reactive rule.
- **Cost:** its total daily cost is **29 % lower** than the timetable's. That is £6,139 a day, or about £2.2 m a year at these assumed prices.
- **Routes alone:** it is also 26 % cheaper to run than the timetable, before any overflow cost. It makes 31 % fewer collections, drives 15 % fewer km and uses 27 % fewer truck-hours.

**Why it wins on both counts:**
- **The timetable wastes trips.** It empties every stop every second day, so almost half its collections (48.8 %) find the bin under 40 % full.
- **BinSight skips stops that can wait.** It empties a stop only when it is projected to pass 80 % before the next chance of a truck, so bins are 64 % full on average when emptied.
- **The reactive rule waits too long.** It is the cheapest to run, but it reacts only once a bin already reads 80 %, so it overflows the most.

**Calibration check.**
- The simulator was calibrated (`calibrate.py`) so that the timetable overflows on 1.0 % of collections. That target is the council's reported complaint rate of 1–1.5 %, taken at its low end.
- In the main experiment the routed timetable overflows on 0.9 % of collections (20.0 of 2,285.7) and empties bins at 43 % full. Calibration predicted about 44 %.

## 2 · The forecast

One random-forest regression (100 trees, scikit-learn defaults) predicts each stop's fill gain per hour over the next day. The projected fill at the next chance of a truck (14:00 tomorrow) is the latest reading plus the predicted gain × hours.

On the plan day it was trained on 78,890 stop-mornings with no truck visit in the next 24 hours.

| Input | Importance |
|---|---:|
| rate (% a day since last emptied) | 0.448 |
| fill (latest reading) | 0.128 |
| d24 (change over the last 24 h) | 0.126 |
| cap (capacity, litres) | 0.101 |
| temp (mean °C to the next truck) | 0.065 |
| hours_since (since last emptied) | 0.047 |
| weekday | 0.040 |
| rain_h (rainy hours to the next truck) | 0.031 |
| holiday (share of holiday hours) | 0.014 |

- **The fill rate carries the forecast.** Rate, fill and the last day's change together account for 70 % of the importance.
- **Weather and holidays add a little.** Temperature, rain and holidays add about 11 %, consistent with their small assumed effects in the simulator.
- **Accuracy is not scored yet.** This version of the model does not compute a separate forecast-accuracy test (MAE against persistence, or interval coverage). The evidence that the forecast works is the end-to-end result in section 1. If the report needs an accuracy table, it has to be added to `experiment.py` first.

## 3 · Tomorrow's plan (Tue 3 Nov 2026)

| | |
|---|---:|
| Stops projected to pass 80 % by 14:00 tomorrow | 2,127 |
| of which projected past 100 % | 817 |
| Chosen (fullest first, while the fleet has time) | 2,127 |
| Served by the routes | 2,127 (none dropped) |
| Trucks / trips | 34 / 70 |
| Road km (solver / street geometry) | 1,289 / 1,313 |
| Truck-hours (driving, lifting and tipping) | 242.4 |
| Driving cost (the routing objective: £1.45/km + £75 per hour at the wheel) | £6,103 |
| Full day (km + all truck-hours) | £20,049 |
| Load emptied | 3,959 m³ |
| CO₂ (0.65 L/km diesel × 2.68 kg/L, street km) | 2.3 t |

- **Every stop at risk gets a truck.** All 2,127 stops projected past 80 % are served, so no stop is left to pass 100 % before the next chance.
- **Tomorrow is a heavy day.** It needs 2,127 collections, against the experiment's average of 1,572, so it uses the whole fleet: 7.1 of 8 hours per truck and about 57 of 60 m³ per trip.
- **Rain slows the trucks slightly.** With the forecast rain during the shift, driving times are scaled by θ = 1.0125.

## 4 · Routing: simulated annealing

Tomorrow's 2,127 stops form one prize-collecting, multi-trip, capacitated vehicle-routing problem with a shift limit (the model is in `route.py`). It is solved by simulated annealing in 30 seconds (6.24 million moves).

| Stage | Driving cost |
|---|---:|
| Start: nearest stop that still fits, truck after truck | £7,862 |
| **After annealing** | **£6,103** |

- **Annealing saves 22 %.** It cuts the starting solution's driving cost by 22.4 %, and every state it visits satisfies the load, shift and one-visit constraints.
- **The result is not proven optimal.** The method README compares annealing alone with the earlier four-stage heuristic on five instances of 1,300–2,400 stops: annealing matched or beat it on route cost every time. That check used an approximate distance matrix and should be rerun on the OpenStreetMap matrix.

## What to say in the report

- **Real:**
  - stop locations and capacities (CEC register);
  - wards (ONS);
  - the street network (OpenStreetMap);
  - the weather (Open-Meteo);
  - the every-second-day collection frequency;
  - holidays;
  - the reported complaint rate.
- **Calibrated:** the average fill when the timetable truck comes (0.415). It is set so that the timetable's overflow rate matches the complaint rate.
- **Simulated:** fill. The forecast is trained and tested on the same simulator, so real accuracy would be lower.
- **Assumed:**
  - costs, truck load and shift;
  - the size of the weather and holiday effects.

  The fleet of 34 is derived from the simulated timetable, not from a council figure.
- **Simplified:**
  - one-way streets are ignored;
  - trucks tip at Seafield, not Millerhill;
  - tomorrow's weather is known.
- **Original:** all code and experiments are our own. The methods are standard and are cited as such: Poisson deposits, random-forest regression, a greedy fullest-first rule, and simulated annealing for vehicle routing.
