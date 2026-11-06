# BinSight model: results

Numbers from `python -m model.run --experiments` (build of 6 Nov 2026), for the report and slides. Method details are in [`README.md`](README.md). Every figure here is also in `data/site.json`.

**The setting:** 4,532 general-waste communal bin stops in 17 wards. There are 24 trucks with 60 m³ loads and 8-hour shifts, tipping at Seafield. Costs are £1.45/km, £75 per truck-hour and £60 per overflow.

## 1 · Main experiment: three policies on the same city

All three policies see the same deposits and sensor noise (common random numbers). Each had 15 days of timetable warm-up and 14 days of its own; the scores cover the last 7 days (26 Oct – 1 Nov 2026), averaged over 2 seeds. The ± is the spread between seeds.

| Per day | Timetable (every 3rd day) | Reactive (≥ 80 % at 05:00) | **BinSight** |
|---|---:|---:|---:|
| Overflow events | 149 | 391 | **28 ± 12** |
| Bin-hours spent overflowing | 1,982 | 3,797 | **154** |
| Collections | 1,467 | 994 | 1,326 |
| Fill when emptied | 62 % | 95 % | 72 % |
| Emptied under 40 % full | 18 % | 0 % | 4 % |
| Road km | 816 | 694 | 1,340 |
| Truck-hours | 161 | 115 | 184 |
| Trucks used (mean) | 21.3 | 15.5 | 24.0 |
| Route cost (km + all crew-hours) | £13,225 | £9,658 | £15,760 |
| **Total cost incl. £60/overflow** | £22,169 | £33,122 | **£17,431** |

**Headline numbers:**
- BinSight cuts overflow events by **81 %** against the timetable and by 93 % against the reactive rule.
- Its total daily cost is **21 % lower** than the timetable (£4,738 a day, about £1.7 m a year at these assumed prices).

**Trade-off:**
- BinSight drives 64 % more km and uses every truck.
- It spends about £2,500 a day more on routes to avoid about £7,300 a day of overflow cost.
- The reactive rule is cheapest to run but waits too long, so it overflows most.

## 2 · Forecast accuracy

These scores use 13,972 forecasts over the 7 test days and 2 seeds, for stops no truck emptied in between, against the true simulated fill.

| | MAE (fill %) | RMSE |
|---|---:|---:|
| **BinSight forecast** | **6.3** | **8.1** |
| Last-day trend | 9.0 | 11.5 |
| Persistence (no change) | 21.5 | 23.1 |

- The 80 % interval holds the truth 81.9 % of the time and the 95 % interval 95.6 %. The standardised error has s.d. 0.98, so the uncertainty is well sized.
- Brier score 0.0006 against 0.0009 for climatology, a 34 % skill.
- **In the tail the risks are overstated.** Forecasts between 10 % and 20 % averaged 13.6 % risk, and 2.5 % overflowed (79 cases). That is conservative: it leads to collecting slightly early, not late.
- **The parameters are recovered from data.** The fitted rain effect is ×0.857 (simulator truth ×0.861). The temperature effect is ×1.010 per °C (truth 1.010). Dispersion φ is 49 L (truth 52.5 L).

## 3 · Tomorrow's plan (Tue 3 Nov 2026)

| | |
|---|---:|
| Stops flagged by the rule (p > α or v > λt) | 1,832 |
| of which mandatory (p > 0.20) | 1,527 |
| Served within 24 trucks × 8 h | 1,171 |
| Trips / trucks | 92 / 24 |
| Road km | 1,513 |
| Truck-hours | 183 |
| Driving cost (the routing objective: £1.45/km + £75 per hour at the wheel) | £6,761 |
| Full day incl. lifting and tipping time | £15,941 |
| CO₂ (diesel, 1.74 kg/km) | 2.6 t |

- **The capacity price is λ = 0.60 per minute.** Round 0 used insertion estimates and gave 1,895 flagged stops at λ = 0.36. Round 1 used the exact insertion and removal costs from the routes and gave 1,832 at λ = 0.60.
- **Routing improved each stage.** Clarke–Wright gave £7,645, local search £7,594 and simulated annealing £7,582.
- **The plan's sum of risks for unserved stops is 200.** It counts the chance of overflowing before 14:00 *the day after*. It is not tomorrow's expected count, and the tail overstatement in section 2 inflates it. The simulator measured about 28 overflow events a day.

## 4 · Is the routing good? Exact checks

On 30 real 12-stop instances, HiGHS proved the optimum of 29, taking 11.2 s on average; our heuristic takes 0.5 s.

| Method | Mean gap to optimum | Worst gap | Optimal |
|---|---:|---:|---:|
| Nearest neighbour | 7.29 % | 26.5 % | 0 / 30 |
| Clarke–Wright savings | 1.62 % | 24.7 % | 12 / 30 |
| Savings + local search | 1.32 % | 24.7 % | 17 / 30 |
| **Full heuristic (+ annealing)** | **0.05 %** | **1.0 %** | **26 / 30** |

**Bound on the full plan.**
- The radial bound 2Σq·c₀ᵢ/Q is £5,239. The Held–Karp 1-tree bound is £1,869.
- So tomorrow's £6,761 driving cost is proven to be at most **22.5 %** above the true optimum.
- This bound is loose. The exact tests suggest the real gap is far smaller.

**Fleet.**
- With unlimited trucks, all 2,008 stops flagged would need 36 trucks.
- No plan could manage them with fewer than 26 (lift time + shortest exit from each stop + tipping, over 480 min).
- With 24 trucks, the capacity price λ chooses which flagged stops wait.

## 5 · Trade-off over the overflow cost c_o

This uses the cost rule alone (α off), seed 1, with a 5-day burn-in and 7 scored days.

| c_o | £10 | £20 | £40 | £60 | £100 | £150 | £250 | £400 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Route £/day | 12,584 | 14,825 | 15,476 | 15,661 | 15,972 | 15,956 | 16,010 | 15,935 |
| Overflows/day | 82.3 | 28.9 | **25.3** | 34.4 | 84.9 | 75.3 | 71.6 | 68.4 |

**Overflows are lowest near c_o = £40, then rise.** The rule looks only one day ahead. At a high c_o, every small risk today is worth a detour, so the fleet's hours go on stops that could have waited, and tomorrow's urgent ones are pushed out. This is why BinSight uses a moderate c_o together with the hard rule p > α. A multi-day look-ahead is the natural extension.

## 6 · Sensitivity of tomorrow's plan

| Change | Stops served | Trucks | Driving £ | Σ risk unserved |
|---|---:|---:|---:|---:|
| **Base** | **1,171** | **24** | **6,761** | **200** |
| Shift 7 h | 1,046 | 24 | 5,905 | 272 |
| Shift 9 h | 1,415 | 24 | 7,207 | 97 |
| Service −25 % | 1,359 | 24 | 7,387 | 118 |
| Service +25 % | 1,104 | 24 | 5,962 | 238 |
| Load 45 m³ | 959 | 23 | 7,517 | 321 |
| Load 75 m³ | 1,320 | 24 | 6,084 | 134 |
| Fleet 20 | 1,013 | 20 | 5,720 | 289 |
| Fleet 28 | 1,442 | 28 | 7,351 | 86 |
| α = 0.10 | 1,171 | 24 | 6,659 | 198 |
| α = 0.30 | 1,171 | 24 | 6,799 | 196 |
| c_o = £30 | 1,190 | 24 | 6,661 | 189 |
| c_o = £120 | 1,171 | 24 | 6,741 | 200 |

- **The plan is limited by truck time, not by the rule's settings.** Shift length, lift time, load size and fleet move the outcome a lot; α and c_o barely do.
- **Four more trucks would halve the risk left unserved.**

## What to say in the report

- **Real:** stop locations and capacities (CEC register), wards (ONS), the street network (OSM), and the weather (Open-Meteo).
- **Simulated:** fill. The forecast is scored on the same simulator, so real accuracy would be lower.
- **Assumed:** prices, fleet and shift.
- **Simplified:**
  - one-way streets are ignored;
  - tipping is at Seafield, not Millerhill;
  - tomorrow's weather is known.
- **Original:** all code and experiments are our own. The methods are standard (compound Poisson, EWMA, Lagrangian relaxation, Clarke–Wright, 2-opt/Or-opt, simulated annealing, MTZ MILP, Held–Karp bound) and are cited as such.
