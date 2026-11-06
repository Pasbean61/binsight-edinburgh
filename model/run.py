"""
BinSight, end to end:   python -m model.run [--experiments] [--skip-static]

  1. real data: stops, wards, road graph and its distance/time matrices (cached)
  2. live run: 7 days on the timetable while the forecaster learns, then BinSight every day
     until the last reading (2 Nov 23:00)
  3. tomorrow's plan (3 Nov): forecast, decide, route, schedule, street geometry
  4. checks: exact optimum on 30 small real instances, a lower bound for the full plan,
     the smallest fleet, sensitivity of the plan
  5. experiments (cached; --experiments reruns them, about 10 minutes on 10 cores)
  6. write data/*.json for the website
"""
import datetime as dt
import json
import math
import os
import sys
import time
from multiprocessing import Pool

import numpy as np

from . import config as C
from . import decide as DC
from . import exact as EX
from . import experiment as E
from . import export as X
from . import forecast as FC
from . import network as N
from . import route as RT
from . import simulate as SM

LIVE_SEED = 1
PLAN_T = int((dt.datetime.combine(C.PLAN_DAY, dt.time()) - C.HISTORY_START).total_seconds() // 3600)   # 720


def conv(o):
    if isinstance(o, dict):
        return {k: conv(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [conv(v) for v in o]
    if isinstance(o, np.floating):
        return float(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.ndarray):
        return conv(o.tolist())
    return o


# ── 4a. heuristic vs exact on small real instances ───────────────────────────
def _validate(k):
    G = E.setup()
    st = G["st"]
    rng = np.random.default_rng(100 + k)
    w = k % len(st["wards"])
    cand = np.flatnonzero(st["ward"] == w)
    sel = np.sort(rng.choice(cand, 12, replace=False))
    q = st["cap"][sel] * rng.uniform(.5, 1, 12)
    Q = float(max(q.max(), .4 * q.sum()))
    I = RT.Instance(sel + 1, q, DC.svc_min(st["nb"][sel]), G["T"], G["D"], Q=Q, tmax=1e9)
    t = time.time()
    ex = EX.exact_cvrp(I.Cm, I.q, Q, 120)
    t_ex = time.time() - t
    t = time.time()
    nn = RT.total_cost(I, RT.nearest_neighbour(I))
    cw_r = RT.savings(I)
    cw = RT.total_cost(I, cw_r)
    ls = RT.total_cost(I, RT.local_search(I, cw_r))
    ours = RT.solve(I, fleet=99, sa_seconds=.5, seed=k)
    t_h = time.time() - t
    return {"ward": st["wards"][w]["name"], "n": 12, "trips": len(ex["routes"]), "opt": ex["cost"],
            "proven": bool(ex["optimal"]), "nn": nn, "cw": cw, "ls": ls, "ours": ours["cost"],
            "t_exact": t_ex, "t_ours": t_h}


def validation(procs=10, k=30):
    with Pool(procs) as pool:
        rows = pool.map(_validate, range(k))
    gap = lambda key: [100 * (r[key] / r["opt"] - 1) for r in rows]
    summ = {key: {"mean_gap": float(np.mean(gap(key))), "max_gap": float(np.max(gap(key))),
                  "optimal": int(sum(g < 1e-6 for g in gap(key)))} for key in ("nn", "cw", "ls", "ours")}
    return {"instances": rows, "summary": summ, "proven": int(sum(r["proven"] for r in rows)),
            "t_exact_mean": float(np.mean([r["t_exact"] for r in rows])),
            "t_ours_mean": float(np.mean([r["t_ours"] for r in rows]))}


# ── helpers for the plan ─────────────────────────────────────────────────────
def expected_overflow(p, served):
    return float(p[~served].sum())


def plan_summary(r, p):
    sol, I = r["sol"], r["I"]
    return {"chosen": int(r["chosen"].sum()), "mand": int(r["mand"].sum()), "served": int(r["served"].sum()),
            "dropped": len(sol["dropped"]), "trucks": len(sol["trucks"]), "trips": len(sol["routes"]),
            "km": sol["km"], "hours": sum(sol["used"]) / 60, "cost": sol["cost"],
            "exp_overflow": expected_overflow(p, r["served"])}


def truck_tables(st, r, G_road, nodes):
    """Trucks → trips with stops, loads, arrival minutes and street geometry."""
    I, sol, idx = r["I"], r["sol"], r["idx"]
    legs, order = set(), []
    for tr in sol["trucks"]:
        trips = sorted(tr, key=lambda k: -RT.trip_time(I, sol["routes"][k]))
        order.append(trips)
        for k in trips:
            path = [0] + [int(idx[v - 1]) + 1 for v in sol["routes"][k]] + [0]
            for a, b in zip(path, path[1:]):
                legs.add((int(nodes[a]), int(nodes[b])))
    print(f"  street paths for {len(legs):,} legs …", flush=True)
    P = G_road.paths(sorted(legs))
    trucks, per_stop = [], {}
    for ti, trips in enumerate(order):
        t = 0.0
        out, seq = [], 0
        for k in trips:
            rr = sol["routes"][k]
            path = [0] + [int(idx[v - 1]) + 1 for v in rr] + [0]
            pts, km, mins = [], 0.0, 0.0
            start = t
            cur = 0
            etas = []
            for j, (a, b) in enumerate(zip(path, path[1:])):
                g, k_, m_ = P[(int(nodes[a]), int(nodes[b]))]
                seg = [tuple(x) for x in g]
                pts += seg if not pts else seg[1:]
                km += k_
                mins += m_
            for v in rr:
                t += I.T[cur, v]
                etas.append(int(round(t)))
                seq += 1
                per_stop[int(idx[v - 1])] = (ti, seq, int(round(t)))
                t += I.s[v]
                cur = v
            t += I.T[cur, 0] + I.tip
            out.append({"stops": [int(idx[v - 1]) for v in rr], "eta": etas, "load": int(I.q[rr].sum()),
                        "line": X.enc_polyline(X.simplify(pts, 0.00002)), "road_km": X.r(km, 2),
                        "drive_min": X.r(mins, 1), "start": int(round(start)), "end": int(round(t))})
        trucks.append({"truck": f"EDI-RCV-{ti + 1:02d}", "plate": f"RCV-{ti + 1:02d}", "driver": f"Crew {ti + 1:02d}",
                       "km": X.r(sum(o["road_km"] for o in out), 2), "hours": X.r(t / 60, 2), "trips": out})
    return trucks, per_stop


def toy_instance(st, r, G_T, G_D):
    """12 consecutive real stops of one of tomorrow's trips, nearest the city centre, with road costs."""
    I, sol, idx = r["I"], r["sol"], r["idx"]
    best, pick = 1e9, None
    for rr in sol["routes"]:
        if len(rr) < 12:
            continue
        for s in range(0, len(rr) - 11, 4):
            g = idx[np.asarray(rr[s:s + 12]) - 1]
            d = float(st["d_centre"][g].mean())
            if d < best:
                best, pick = d, g
    rows = np.r_[0, pick + 1]
    Tm, Dm = G_T[np.ix_(rows, rows)].astype(float), G_D[np.ix_(rows, rows)].astype(float)
    Tm, Dm = (Tm + Tm.T) / 2, (Dm + Dm.T) / 2
    Cm = C.COST_KM * Dm + C.COST_HOUR * Tm / 60
    return {"stops": [{"i": int(i), "id": st["id"][i], "site": st["site"][i], "lat": X.r(st["lat"][i], 6),
                       "lon": X.r(st["lon"][i], 6)} for i in pick],
            "depot": C.DEPOT, "cost": np.round(Cm, 3).tolist(), "km": np.round(Dm, 3).tolist(),
            "min": np.round(Tm, 2).tolist()}


# ── main ─────────────────────────────────────────────────────────────────────
def main(argv=()):
    t_all = time.time()
    G = E.setup()
    st, T, D, Cm = G["st"], G["T"], G["D"], G["Cm"]
    temp, rain = G["weather"]
    n = len(st["cap"])
    print(f"1. {n:,} stops from {st['records']:,} general-waste records, {len(st['wards'])} wards")

    # experiments (cached)
    exp_path = os.path.join(C.CACHE, "experiments.json")
    if "--experiments" in argv or not os.path.exists(exp_path):
        print("5. experiments …", flush=True)
        main_runs, pareto = E.main_experiment()
        json.dump(conv({"main": main_runs, "pareto": pareto}), open(exp_path, "w"))
    EXP = json.load(open(exp_path))

    print("2. live run …", flush=True)
    t = time.time()
    live = E.run(LIVE_SEED, "binsight", warm=C.LEARN_DAYS, days=PLAN_T // 24 - C.LEARN_DAYS, sa=2.0)
    B = live["B"]
    print(f"   {time.time() - t:.0f}s")

    print("3. tomorrow's plan …", flush=True)
    fc = FC.Forecaster(st["cap"], temp, rain).fit(B.Y, B.K, PLAN_T)
    y = B.Y[:, PLAN_T - 1].astype(float)
    t0, t1 = PLAN_T, PLAN_T + C.SHIFT_START_H + C.HORIZON_H
    mu, sd, p = fc.predict(y, t0, t1)
    tau = fc.days_to_fill()
    args = (st, T, D, Cm, y, mu, sd, p, tau)
    plan = DC.plan(*args, sa_seconds=8.0, seed=0, verbose=True)
    base = plan_summary(plan, p)
    sol, I = plan["sol"], plan["I"]
    print(f"   {base}")

    print("4. checks …", flush=True)
    lb = EX.lower_bound(I.Cm, I.q, I.Q, sol["cost"])
    big = DC.plan(*args, fleet=99, sa_seconds=3.0, seed=0)
    fleet = {"needed": len(big["sol"]["trucks"]), "lower_bound": E.fleet_lower_bound(big["I"]),
             "chosen": int(big["chosen"].sum()), "used_in_plan": len(sol["trucks"]), "fleet": C.FLEET}
    sens = []
    for label, kw in [("Shift 7 h", {"tmax": 420}), ("Shift 9 h", {"tmax": 540}),
                      ("Service −25 %", {"svc_scale": .75}), ("Service +25 %", {"svc_scale": 1.25}),
                      ("Load 45 m³", {"Q": 45_000}), ("Load 75 m³", {"Q": 75_000}),
                      ("Fleet 20", {"fleet": 20}), ("Fleet 28", {"fleet": 28}),
                      ("α = 0.10", {"alpha": .10}), ("α = 0.30", {"alpha": .30}),
                      ("c_o = £30", {"c_o": 30}), ("c_o = £120", {"c_o": 120})]:
        rr = DC.plan(*args, sa_seconds=2.0, seed=0, **kw)
        sens.append({"variant": label, **plan_summary(rr, p)})
        print(f"   {label:<14} {sens[-1]['served']} served, {sens[-1]['trucks']} trucks, £{sens[-1]['cost']:,.0f}, "
              f"E[overflow] {sens[-1]['exp_overflow']:.1f}", flush=True)
    val = validation()
    print(f"   validation: {val['summary']}")

    print("6. export …", flush=True)
    road = N.RoadGraph()
    nodes = np.load(os.path.join(C.CACHE, "matrix.npz"))["nodes"]
    trucks, per_stop = truck_tables(st, plan, road, nodes)
    rng = np.random.default_rng(7)
    L = {"fill": y, "pred": np.minimum(mu, 130), "sd": sd, "prob": p, "tau": tau, "dcost": plan["delta"],
         "prio": plan["value"],
         "bat": np.round(np.clip(100 - rng.gamma(2.0, 4.5, n), 62, 100), 1),
         "sig": rng.integers(48, 97, n),
         "flag": plan["chosen"].astype(int), "mand": plan["mand"].astype(int),
         "since": [None if B.last[i] < 0 else int(PLAN_T - 1 - B.last[i]) for i in range(n)],
         "truck": [per_stop[i][0] if i in per_stop else -1 for i in range(n)],
         "ord": [per_stop[i][1] if i in per_stop else 0 for i in range(n)],
         "eta": [per_stop[i][2] if i in per_stop else None for i in range(n)]}
    X.stops_layer(st, L)
    X.history_layer(B.Y, PLAN_T)
    X.routes_layer(trucks)
    assets = X.network_layer() if "--skip-static" not in argv else None
    if "--skip-static" not in argv:
        X.basemap_layer(st)

    # ---- site.json
    area = X.area_of(st)
    served = plan["served"]
    names = [t_["truck"] for t_ in trucks]
    tr_of = np.array(L["truck"])
    wards = []
    for wi, w in enumerate(st["wards"]):
        m = st["ward"] == wi
        wards.append({"name": w["name"], "code": w["code"], "stops": int(m.sum()), "bins": int(st["nb"][m].sum()),
                      "cap_l": int(st["cap"][m].sum()), "fill": X.r(y[m].mean()), "pred": X.r(np.minimum(mu[m], 100).mean()),
                      "flagged": int(plan["chosen"][m].sum()), "served": int(served[m].sum()),
                      "risk": int((p[m] > C.ALPHA).sum()), "over90": int((y[m] >= 90).sum()),
                      "trucks": sorted({names[k] for k in tr_of[m] if k >= 0}),
                      "areas": {X.AREAS[k]: int(((area == k) & m).sum()) for k in range(3)}})
    km = sum(t_["km"] for t_ in trucks)
    hist_t0 = PLAN_T - 30 * 24
    agg = aggregate(EXP["main"])
    fm = forecast_summary(EXP["main"])
    # an example stop for the forecast fan chart: skipped or borderline, mid-range risk
    cand = np.flatnonzero((p > .25) & (p < .6) & (B.last >= 0) & (B.last < PLAN_T - 30))
    ex_i = int(cand[np.argmin(np.abs(p[cand] - .4))]) if len(cand) else int(np.argmax(p))
    hrs = np.arange(t0, t1 + 1)
    fan_mu, fan_sd = [], []
    for h in hrs:
        a, b_, _ = fc.predict(y, t0, h)
        fan_mu.append(X.r(a[ex_i], 2)); fan_sd.append(X.r(b_[ex_i], 2))
    samp = np.sort(np.random.default_rng(3).choice(n, 900, replace=False))
    b = fc.coef
    maths = {
        "params": {k: getattr(C, k) for k in ("BAG_L", "BAG_SHAPE", "DAILY_FILL_MEDIAN", "DAILY_FILL_SPREAD",
                                              "WEEKEND_CENTRE", "RAIN_EFFECT", "TEMP_EFFECT", "SENSOR_NOISE",
                                              "FLEET", "TRUCK_LOAD_L", "SHIFT_MIN", "TIP_MIN", "SERVICE_BASE_MIN",
                                              "SERVICE_PER_BIN_MIN", "COST_KM", "COST_HOUR", "COST_OVERFLOW",
                                              "ALPHA", "HORIZON_H", "SPEED")},
        "fill": {"hour_w": SM.HOUR_W.tolist(), "day_w": SM.DAY_W.tolist()},
        "forecast": {"hour": [1.0] + np.exp(b[1:24]).round(4).tolist(), "day": [1.0] + np.exp(b[24:30]).round(4).tolist(),
                     "rain": X.r(math.exp(b[30]), 4), "temp": X.r(math.exp(b[31]), 4), "phi": X.r(fc.phi, 2),
                     "beta": FC.BETA, "metrics": fm,
                     "example": {"i": ex_i, "id": st["id"][ex_i], "site": st["site"][ex_i], "cap": int(st["cap"][ex_i]),
                                 "past": np.round(B.Y[ex_i, PLAN_T - 72:PLAN_T], 1).tolist(),
                                 "mu": fan_mu, "sd": fan_sd, "p": X.r(p[ex_i], 3), "rate_l_day": X.r(fc.r[ex_i], 1),
                                 "e2": X.r(fc.e2[ex_i], 4)}},
        "decide": {"rounds": plan["rounds"], "mand": int(plan["mand"].sum()), "chosen": int(plan["chosen"].sum()),
                   "optional": int((plan["chosen"] & ~plan["mand"]).sum()),
                   "sample": {"p": np.round(p[samp], 4).tolist(), "ratio": np.round(plan["delta"][samp] / tau[samp], 3).tolist(),
                              "mand": plan["mand"][samp].astype(int).tolist(), "chosen": plan["chosen"][samp].astype(int).tolist()}},
        "route": {"cw": sol["cost_cw"], "ls": sol["cost_ls"], "sa": sol["cost_sa"], "final": sol["cost"],
                  "seconds": sol["seconds"], "trips": len(sol["routes"]), "trucks": len(sol["trucks"]),
                  "stops": I.n, "toy": toy_instance(st, plan, T, D), "validation": val},
        "check": {"lower_bound": lb, "gap_max": 1 - lb["bound"] / sol["cost"], "fleet": fleet,
                  "sensitivity": sens, "base": base, "pareto": EXP["pareto"]},
    }
    site = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "snapshot": (C.HISTORY_START + dt.timedelta(hours=PLAN_T - 1)).isoformat(),
        "plan_day": C.PLAN_DAY.isoformat(), "city": "Edinburgh", "authority": "City of Edinburgh Council",
        "depot": C.DEPOT, "areas": X.AREAS, "wards": wards,
        "fleet": {"trucks": C.FLEET, "capacity_l": C.TRUCK_LOAD_L, "shift_min": C.SHIFT_MIN,
                  "start_h": C.SHIFT_START_H, "tip_min": C.TIP_MIN, "service_base_min": C.SERVICE_BASE_MIN,
                  "service_per_bin_min": C.SERVICE_PER_BIN_MIN, "fuel_l_per_km": 0.65, "co2_kg_per_l": 2.68,
                  "cost_km": C.COST_KM, "cost_hour": C.COST_HOUR, "cost_overflow": C.COST_OVERFLOW},
        "plan": {"flagged": base["chosen"], "mand": base["mand"], "served": base["served"],
                 "dropped": base["dropped"], "trucks_used": base["trucks"], "trips": base["trips"],
                 "solver_km": X.r(sol["km"], 1), "road_km": X.r(km, 1), "hours": X.r(base["hours"], 1),
                 "cost": X.r(base["cost"], 0), "exp_overflow": X.r(base["exp_overflow"], 1),
                 "load_l": int(plan["q"][served].sum()), "co2_kg": X.r(km * 0.65 * 2.68, 1)},
        "totals": {"stops": n, "bins": int(st["nb"].sum()), "cap_l": int(st["cap"].sum()),
                   "assets": assets, "general_waste_records": int(st["records"]),
                   "mean_fill": X.r(y.mean()), "mean_pred": X.r(np.minimum(mu, 100).mean()),
                   "risk": int((p > C.ALPHA).sum()), "over90": int((y >= 90).sum()),
                   "low_battery": int((L["bat"] < 80).sum()), "road_km": X.r(road.road_km, 0),
                   "road_nodes": int(road.n), "road_edges": int(road.edges)},
        "model": {"name": "Compound-Poisson fill model with learned hourly shape and per-stop rates",
                  "metrics": fm},
        "experiments": {"aggregate": agg, "runs": [r_["score"] for r_ in EXP["main"]],
                        "daily": [dict(d, seed=r_["score"]["seed"], policy=r_["score"]["policy"])
                                  for r_ in EXP["main"] for d in r_["log"] if d["day"] >= E.EVAL0],
                        "eval_start": (C.HISTORY_START + dt.timedelta(days=E.EVAL0)).date().isoformat(),
                        "eval_days": C.EVAL_DAYS, "seeds": C.SEEDS, "pareto": EXP["pareto"]},
        "weather": {"start": C.HISTORY_START.isoformat(timespec="minutes"),
                    "temp": [X.r(v, 1) for v in temp[:PLAN_T + 24]], "rain": [X.r(v, 2) for v in rain[:PLAN_T + 24]],
                    "source": "Open-Meteo hourly weather for Edinburgh (55.95 N, 3.19 W)",
                    "history_end": (C.HISTORY_START + dt.timedelta(hours=PLAN_T)).date().isoformat()},
        "maths": maths,
    }
    X.dump("site.json", conv(site))
    print(f"done in {time.time() - t_all:.0f}s")


def aggregate(main_runs):
    out = []
    for pol in ("timetable", "reactive", "binsight"):
        rows = [r["score"] for r in main_runs if r["score"]["policy"] == pol]
        keys = [k for k, v in rows[0].items() if isinstance(v, (int, float)) and k not in ("seed", "c_o", "alpha")]
        rec = {"policy": pol}
        for k in keys:
            v = np.array([r_[k] for r_ in rows], float)
            rec[k] = float(v.mean())
            rec[k + "_sd"] = float(v.std(ddof=1)) if len(v) > 1 else 0.0
        out.append(rec)
    return out


def forecast_summary(main_runs):
    fs = [r["forecast"] for r in main_runs if "forecast" in r]
    avg = lambda f: float(np.mean([f(x) for x in fs]))
    return {"n": int(sum(x["n"] for x in fs)),
            "binsight": {"mae": avg(lambda x: x["mu"]["mae"]), "rmse": avg(lambda x: x["mu"]["rmse"])},
            "persistence": {"mae": avg(lambda x: x["persist"]["mae"]), "rmse": avg(lambda x: x["persist"]["rmse"])},
            "trend": {"mae": avg(lambda x: x["trend"]["mae"]), "rmse": avg(lambda x: x["trend"]["rmse"])},
            "brier": avg(lambda x: x["brier"]), "brier_climatology": avg(lambda x: x["brier_climatology"]),
            "coverage80": avg(lambda x: x["coverage80"]), "coverage95": avg(lambda x: x["coverage95"]),
            "z_sd": avg(lambda x: x["z_sd"]), "reliability": fs[0]["reliability"]}


if __name__ == "__main__":
    main(sys.argv[1:])
