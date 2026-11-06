"""
Layer 5: before and after.  A rolling-horizon experiment with common random numbers.

For each seed, the same simulated deposits (and the same sensor noise) are fed to three policies:

  timetable   every stop every second day, on fixed geographic rounds (today's practice)

All three use the same fleet: the trucks the timetable needs on its busiest day (setup()).
  reactive    every stop whose sensor reads ≥ 80 % at 05:00 (sensors, no forecast)
  binsight    the random-forest fill forecast + fullest-first choice + routing of this model

Every policy runs the timetable for the first 15 days, then itself for 14 days; the last 7
(26 Oct – 1 Nov) are scored. Trucks start at 06:00 and empty each stop in the hour the schedule
reaches it.
"""
import os
import time
from multiprocessing import Pool

import numpy as np

from . import config as C
from . import decide as DC
from . import predict as PR
from . import network as N
from . import route as RT
from . import simulate as SM

WARM_DAYS = 15
RUN_DAYS = 14
EVAL0 = WARM_DAYS + RUN_DAYS - C.EVAL_DAYS          # day 22 = 26 Oct
_G = {}


def setup():
    if _G:
        return _G
    st = N.stops()
    z = np.load(os.path.join(C.CACHE, "matrix.npz"))
    T, D = z["T"], z["D"]
    Ts, Ds = (T + T.T) / 2, (D + D.T) / 2
    _G.update(st=st, T=T, D=D, Cm=(C.COST_KM * Ds + C.COST_HOUR * Ts / 60).astype(np.float32), Tm=Ts.astype(np.float32),
              rounds=timetable_rounds(st), weather=SM.weather())
    # the council's timetable: one fixed route per round, no fleet limit; its busiest day sets the fleet
    _G["fixed"] = {g: route_fixed(_G, _G["rounds"] == g) for g in range(C.TIMETABLE_EVERY)}
    _G["fleet"] = max(len(sol["trucks"]) for _, sol, _ in _G["fixed"].values())
    C.FLEET = _G["fleet"]
    return _G


def timetable_rounds(st, k=C.TIMETABLE_EVERY):
    """Split the wards into k geographic rounds with about the same number of stops."""
    counts = np.bincount(st["ward"], minlength=len(st["wards"]))
    cen = np.array([[st["lon"][st["ward"] == w].mean() if counts[w] else 0,
                     st["lat"][st["ward"] == w].mean() if counts[w] else 0] for w in range(len(counts))])
    ang = np.arctan2(cen[:, 1] - C.DEPOT["latitude"], (cen[:, 0] - C.DEPOT["longitude"]) * .56)
    order = np.argsort(ang)
    grp = np.zeros(len(counts), int)
    cum = np.cumsum(counts[order])
    for pos, w in enumerate(order):
        grp[w] = min(k - 1, int(k * (cum[pos] - counts[w] / 2) / cum[-1]))
    return grp[st["ward"]]


def route_fixed(G, mask, fleet=99, sa=1.0, seed=0):
    st = G["st"]
    idx = np.flatnonzero(mask)
    I = RT.Instance(idx + 1, st["cap"][idx] * .6, DC.svc_min(st["nb"][idx]), G["T"], G["D"])
    return I, RT.solve(I, fleet=fleet, sa_seconds=sa, seed=seed), idx


def empties(I, sol, idx, day):
    """{hour: [stops]} from the schedule (trucks leave the depot at 06:00)."""
    arr = RT.schedule(I, sol)
    out = {}
    for v, m in arr.items():
        h = day * 24 + C.SHIFT_START_H + min(int(m // 60), 23 - C.SHIFT_START_H)
        out.setdefault(h, []).append(int(idx[v - 1]))
    return out


def day_stats(I, sol):
    return {"km": sol["km"], "hours": sum(sol["used"]) / 60, "trucks": len(sol["trucks"]),
            "stops": I.n - len(sol["dropped"]), "dropped": len(sol["dropped"]), "cost": sol["cost"]}


def run(seed, policy, warm=WARM_DAYS, days=RUN_DAYS, sa=2.0):
    G = setup()
    st, rounds = G["st"], G["rounds"]
    temp, rain = G["weather"]
    n = len(st["cap"])
    X = SM.deposits(st, seed)
    B = SM.Bins(st, X, seed)
    log = []
    plan_empties = {}
    t = 0
    for day in range(warm + days):
        pol = "timetable" if day < warm else policy
        t_dec = day * 24 + C.SHIFT_START_H - 1                    # decide at 05:00 with readings so far
        while t < t_dec:
            B.hour(t, plan_empties.pop(t, ()))
            t += 1
        rec = {"day": day, "policy": pol}
        if pol == "timetable":
            I, sol, idx = G["fixed"][day % C.TIMETABLE_EVERY]
        elif pol == "reactive":
            y = B.Y[:, t_dec - 1]
            I, sol, idx = route_fixed(G, y >= C.REACTIVE_AT, fleet=G["fleet"], sa=sa, seed=day)
        else:
            y = B.Y[:, t_dec - 1].astype(float)
            t1 = t_dec + 1 + C.HORIZON_H
            rf = PR.FillForest(st, temp, rain, seed=seed).fit(B.Y, B.K, t_dec)
            proj = rf.predict(B.Y, B.K, t_dec, t1)
            r = DC.plan(st, G["T"], G["D"], y, proj, rf.gain, fleet=G["fleet"], sa_seconds=sa, seed=day, Tm_all=G["Tm"])
            I, sol, idx = r["I"], r["sol"], r["idx"]
            rec.update(risky=int(r["risky"].sum()), chosen=int(r["chosen"].sum()))
        rec.update(day_stats(I, sol))
        log.append(rec)
        for h, v in empties(I, sol, idx, day).items():
            plan_empties.setdefault(h, []).extend(v)
    end = (warm + days) * 24
    while t < end:
        B.hour(t, plan_empties.pop(t, ()))
        t += 1
    return {"seed": seed, "policy": policy, "log": log, "B": B,
            "t_end": end}


def score(res, eval0=EVAL0, days=C.EVAL_DAYS):
    B, log = res["B"], res["log"]
    h0, h1 = eval0 * 24, (eval0 + days) * 24
    L = [r for r in log if eval0 <= r["day"] < eval0 + days]
    coll = [f for (t, i, f) in B.coll if h0 <= t < h1]
    km = sum(r["km"] for r in L)
    hours = sum(r["hours"] for r in L)
    ev = float(B.over_events[h0:h1].sum())
    return {"policy": res["policy"], "seed": res["seed"],
            "km_day": km / days, "truck_hours_day": hours / days,
            "trucks_mean": float(np.mean([r["trucks"] for r in L])), "trucks_max": int(max(r["trucks"] for r in L)),
            "collections_day": len(coll) / days,
            "overflow_events_day": ev / days, "overflow_bin_hours_day": float(B.over_h[h0:h1].sum()) / days,
            "fill_at_collection": float(np.mean(coll)) if coll else 0.0,
            "share_under_40": float(np.mean(np.array(coll) < 40)) if coll else 0.0,
            "dropped_day": sum(r["dropped"] for r in L) / days,
            "cost_day": (C.COST_KM * km + C.COST_HOUR * hours + C.COST_OVERFLOW * ev) / days,
            "route_cost_day": (C.COST_KM * km + C.COST_HOUR * hours) / days}


# ── workers (separate processes) ──────────────────────────────────────────────
def _job(args):
    seed, policy = args
    t = time.time()
    res = run(seed, policy)
    print(f"  seed {seed} {policy}: {time.time() - t:.0f}s", flush=True)
    return {"score": score(res), "log": res["log"]}


def main_experiment(procs=10):
    """The three policies on the same city, for every seed: the before-and-after table."""
    jobs = [(s, p) for s in C.SEEDS for p in ("timetable", "reactive", "binsight")]
    with Pool(procs) as pool:
        return pool.map(_job, jobs)
