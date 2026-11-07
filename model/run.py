"""
BinSight, end to end:   python -m model.run [--experiments] [--skip-static]

  1. real data: stops, wards, road graph and its distance/time matrices (cached)
  2. live run: 7 days on the timetable while the forecaster learns, then BinSight every day
     until the last reading (2 Nov 23:00)
  3. tomorrow's plan (3 Nov): random-forest fill forecast, fullest-first choice, route, schedule, street geometry
  4. before and after: timetable vs reactive vs BinSight on the same city
     (cached; --experiments reruns it)
  5. write data/*.json for the website
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
from . import experiment as E
from . import export as X
from . import predict as PR
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


# ── helpers for the plan ─────────────────────────────────────────────────────
def plan_summary(r, proj):
    sol, I = r["sol"], r["I"]
    return {"chosen": int(r["chosen"].sum()), "mand": int(r["mand"].sum()), "served": int(r["served"].sum()),
            "dropped": len(sol["dropped"]), "trucks": len(sol["trucks"]), "trips": len(sol["routes"]),
            "km": sol["km"], "hours": sum(sol["used"]) / 60, "cost": sol["cost"],
            "left_over100": int(((proj >= 100) & ~r["served"]).sum())}


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
        print("4. before and after …", flush=True)
        json.dump(conv({"main": E.main_experiment()}), open(exp_path, "w"))
    EXP = json.load(open(exp_path))

    print("2. live run …", flush=True)
    t = time.time()
    live = E.run(LIVE_SEED, "binsight", warm=C.LEARN_DAYS, days=PLAN_T // 24 - C.LEARN_DAYS)
    B = live["B"]
    print(f"   {time.time() - t:.0f}s")

    print("3. tomorrow's plan …", flush=True)
    rf = PR.FillForest(st, temp, rain, seed=LIVE_SEED).fit(B.Y, B.K, PLAN_T)
    y = B.Y[:, PLAN_T - 1].astype(float)
    t0, t1 = PLAN_T, PLAN_T + C.SHIFT_START_H + C.HORIZON_H
    proj = rf.predict(B.Y, B.K, t0, t1)
    gain = rf.gain
    plan = DC.plan(st, T, D, y, proj, B.last, PLAN_T, fleet=G["fleet"], seconds=30.0, seed=0,
                   verbose=True, Tm_all=G["Tm"])
    base = plan_summary(plan, proj)
    sol, I = plan["sol"], plan["I"]
    print(f"   {base}")

    print("5. export …", flush=True)
    road = N.RoadGraph()
    nodes = np.load(os.path.join(C.CACHE, "matrix.npz"))["nodes"]
    trucks, per_stop = truck_tables(st, plan, road, nodes)
    rng = np.random.default_rng(7)
    L = {"fill": y, "pred": np.minimum(proj, 130), "gain": gain * 24, "tmin": plan["tmin"],
         "bat": np.round(np.clip(100 - rng.gamma(2.0, 4.5, n), 62, 100), 1),
         "sig": rng.integers(48, 97, n),
         "flag": plan["chosen"].astype(int), "risky": plan["risky"].astype(int),
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
                      "cap_l": int(st["cap"][m].sum()), "fill": X.r(y[m].mean()), "pred": X.r(np.minimum(proj[m], 100).mean()),
                      "flagged": int(plan["chosen"][m].sum()), "served": int(served[m].sum()),
                      "risk": int((proj[m] >= C.FLOOR).sum()), "over90": int((y[m] >= 90).sum()),
                      "trucks": sorted({names[k] for k in tr_of[m] if k >= 0}),
                      "areas": {X.AREAS[k]: int(((area == k) & m).sum()) for k in range(3)}})
    km = sum(t_["km"] for t_ in trucks)
    hist_t0 = PLAN_T - 30 * 24
    agg = aggregate(EXP["main"])
    # an example stop near the floor that has been emptied before: its last 3 days and its projection
    cand = np.flatnonzero((proj > C.FLOOR - 10) & (proj < C.FLOOR + 20) & (B.last >= 0) & (B.last < PLAN_T - 30))
    ex_i = int(cand[np.argmin(np.abs(proj[cand] - C.FLOOR))]) if len(cand) else int(np.argmax(proj))
    samp = np.sort(np.random.default_rng(3).choice(n, 900, replace=False))
    maths = {
        "params": {k: getattr(C, k) for k in ("BAG_L", "COLLECT_EVERY_DAYS", "FILL_AT_COLLECTION",
                                              "TARGET_OVERFLOW", "DAILY_FILL_SPREAD", "SENSOR_NOISE", "REACTIVE_AT",
                                              "FLEET", "TRUCK_LOAD_L", "SHIFT_MIN", "TIP_MIN", "SERVICE_BASE_MIN",
                                              "SERVICE_PER_BIN_MIN", "COST_KM", "COST_HOUR", "COST_OVERFLOW",
                                              "FLOOR", "HORIZON_H", "SPEED", "RAIN_EFFECT", "TEMP_EFFECT",
                                              "HOLIDAY_EFFECT", "RAIN_SLOWDOWN")},
        "fill": {"hour_w": SM.HOUR_W.tolist(), "public_holidays": C.PUBLIC_HOLIDAYS, "school_holidays": C.SCHOOL_HOLIDAYS},
        "forecast": {"model": "random forest regression", "trees": rf.rf.n_estimators, "features": PR.FEATURES,
                     "importance": rf.importance(), "n_train": rf.n_train,
                     "example": {"i": ex_i, "id": st["id"][ex_i], "site": st["site"][ex_i], "cap": int(st["cap"][ex_i]),
                                 "past": np.round(B.Y[ex_i, PLAN_T - 72:PLAN_T], 1).tolist(),
                                 "proj": X.r(proj[ex_i], 1), "gain_day": X.r(24 * gain[ex_i], 1),
                                 "hours": int(t1 - t0 + 1)}},
        "decide": {"floor": C.FLOOR, "risky": int(plan["risky"].sum()), "chosen": int(plan["chosen"].sum()),
                   "served": int(plan["served"].sum()),
                   "sample": {"proj": np.round(proj[samp], 1).tolist(), "chosen": plan["chosen"][samp].astype(int).tolist(),
                              "served": plan["served"][samp].astype(int).tolist()}},
        "route": {"start": sol["cost_start"], "final": sol["cost"], "theta": plan["theta"],
                  "iterations": sol["iterations"],
                  "seconds": sol["seconds"], "trips": len(sol["routes"]), "trucks": len(sol["trucks"]),
                  "stops": I.n, "toy": toy_instance(st, plan, T, D)},
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
                 "cost": X.r(base["cost"], 0), "left_over100": base["left_over100"],
                 "load_l": int(plan["q"][served].sum()), "co2_kg": X.r(km * 0.65 * 2.68, 1)},
        "totals": {"stops": n, "bins": int(st["nb"].sum()), "cap_l": int(st["cap"].sum()),
                   "assets": assets, "general_waste_records": int(st["records"]),
                   "mean_fill": X.r(y.mean()), "mean_pred": X.r(np.minimum(proj, 100).mean()),
                   "risk": int((proj >= C.FLOOR).sum()), "over90": int((y >= 90).sum()),
                   "low_battery": int((L["bat"] < 80).sum()), "road_km": X.r(road.road_km, 0),
                   "road_nodes": int(road.n), "road_edges": int(road.edges)},
        "model": {"name": "Random-forest fill forecast (100 trees, 9 inputs from sensors, clock, weather and holidays)"},
        "experiments": {"aggregate": agg, "runs": [r_["score"] for r_ in EXP["main"]],
                        "daily": [dict(d, seed=r_["score"]["seed"], policy=r_["score"]["policy"])
                                  for r_ in EXP["main"] for d in r_["log"] if d["day"] >= E.EVAL0],
                        "eval_start": (C.HISTORY_START + dt.timedelta(days=E.EVAL0)).date().isoformat(),
                        "eval_days": C.EVAL_DAYS, "seeds": C.SEEDS},
        "weather": {"start": C.HISTORY_START.isoformat(timespec="minutes"),
                    "temp": [X.r(v, 1) for v in temp[:PLAN_T + 24]], "rain": [X.r(v, 2) for v in rain[:PLAN_T + 24]],
                    "source": "Open-Meteo hourly weather for Edinburgh (55.95 N, 3.19 W)",
                    "history_end": (C.HISTORY_START + dt.timedelta(hours=PLAN_T)).date().isoformat(),
                    "forecast": forecast_block()},
        "maths": maths,
    }
    X.dump("site.json", conv(site))
    print(f"done in {time.time() - t_all:.0f}s")


def forecast_block():
    """The week-ahead forecast issued on the snapshot day (scripts/fetch_forecast.py); shown only."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("fetch_forecast", os.path.join(os.path.dirname(C.RAW), "..", "..", "scripts", "fetch_forecast.py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m.block()


def aggregate(main_runs):
    out = []
    for pol in ("timetable", "reactive", "binsight"):
        rows = [r["score"] for r in main_runs if r["score"]["policy"] == pol]
        keys = [k for k, v in rows[0].items() if isinstance(v, (int, float)) and k != "seed"]
        rec = {"policy": pol}
        for k in keys:
            v = np.array([r_[k] for r_ in rows], float)
            rec[k] = float(v.mean())
            rec[k + "_sd"] = float(v.std(ddof=1)) if len(v) > 1 else 0.0
        out.append(rec)
    return out


if __name__ == "__main__":
    main(sys.argv[1:])
