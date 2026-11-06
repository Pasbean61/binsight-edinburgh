"""
Layer 5b: does it work?  A rolling-horizon experiment with common random numbers.

For each seed, the same simulated deposits (and the same sensor noise) are fed to three policies:

  timetable   every stop every third day, on fixed geographic rounds (today's practice)
  reactive    every stop whose sensor reads ≥ 80 % at 05:00
  binsight    the forecast + decision rule + routing of this model

Every policy runs the timetable for the first 15 days, then itself for 14 days; the last 7
(26 Oct – 1 Nov) are scored. Trucks start at 06:00 and empty each stop in the hour the schedule
reaches it.

Also here: forecast accuracy against naive forecasts, the cost–overflow Pareto front over the
overflow cost c_o, sensitivity of tomorrow's plan, and the smallest fleet that can serve it.
"""
import math
import os
import time
from multiprocessing import Pool

import numpy as np

from . import config as C
from . import decide as DC
from . import forecast as FC
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


def run(seed, policy, c_o=C.COST_OVERFLOW, alpha=C.ALPHA, warm=WARM_DAYS, days=RUN_DAYS, sa=2.0,
        live=False, keep_forecasts=False):
    G = setup()
    st, rounds = G["st"], G["rounds"]
    temp, rain = G["weather"]
    n = len(st["cap"])
    X = SM.deposits(st, seed)
    B = SM.Bins(st, X, seed)
    fixed = {}
    log, fcs = [], []
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
            g = day % C.TIMETABLE_EVERY
            if g not in fixed:
                fixed[g] = route_fixed(G, rounds == g)
            I, sol, idx = fixed[g]
        elif pol == "reactive":
            y = B.Y[:, t_dec - 1]
            I, sol, idx = route_fixed(G, y >= 80, fleet=C.FLEET, sa=sa, seed=day)
        else:
            fc = FC.Forecaster(st["cap"], temp, rain).fit(B.Y, B.K, t_dec)
            y = B.Y[:, t_dec - 1]
            t1 = t_dec + 1 + C.HORIZON_H
            mu, sd, p = fc.predict(y, t_dec, t1)
            r = DC.plan(st, G["T"], G["D"], G["Cm"], y, mu, sd, p, fc.days_to_fill(),
                        c_o=c_o, alpha=alpha, sa_seconds=sa, seed=day, Tm_all=G["Tm"])
            I, sol, idx = r["I"], r["sol"], r["idx"]
            rec.update(mand=int(r["mand"].sum()), chosen=int(r["chosen"].sum()))
            if keep_forecasts and day >= EVAL0:
                fcs.append({"t0": t_dec, "t1": t1, "y": y.copy(), "mu": mu, "sd": sd, "p": p,
                            "prev": B.Y[:, t_dec - 25].copy()})
        rec.update(day_stats(I, sol))
        log.append(rec)
        for h, v in empties(I, sol, idx, day).items():
            plan_empties.setdefault(h, []).extend(v)
    end = (warm + days) * 24
    while t < end:
        B.hour(t, plan_empties.pop(t, ()))
        t += 1
    return {"seed": seed, "policy": policy, "c_o": c_o, "alpha": alpha, "log": log, "B": B, "fcs": fcs,
            "t_end": end}


def score(res, eval0=EVAL0, days=C.EVAL_DAYS):
    B, log = res["B"], res["log"]
    h0, h1 = eval0 * 24, (eval0 + days) * 24
    L = [r for r in log if eval0 <= r["day"] < eval0 + days]
    coll = [f for (t, i, f) in B.coll if h0 <= t < h1]
    km = sum(r["km"] for r in L)
    hours = sum(r["hours"] for r in L)
    ev = float(B.over_events[h0:h1].sum())
    return {"policy": res["policy"], "seed": res["seed"], "c_o": res["c_o"], "alpha": res["alpha"],
            "km_day": km / days, "truck_hours_day": hours / days,
            "trucks_mean": float(np.mean([r["trucks"] for r in L])), "trucks_max": int(max(r["trucks"] for r in L)),
            "collections_day": len(coll) / days,
            "overflow_events_day": ev / days, "overflow_bin_hours_day": float(B.over_h[h0:h1].sum()) / days,
            "fill_at_collection": float(np.mean(coll)) if coll else 0.0,
            "share_under_40": float(np.mean(np.array(coll) < 40)) if coll else 0.0,
            "dropped_day": sum(r["dropped"] for r in L) / days,
            "cost_day": (C.COST_KM * km + C.COST_HOUR * hours + C.COST_OVERFLOW * ev) / days,
            "route_cost_day": (C.COST_KM * km + C.COST_HOUR * hours) / days}


def forecast_metrics(res):
    """Compare the forecast at every decision with what the stop actually reached by t1.

    Only stops that no truck emptied in (t0, t1] count. Truth = true fill, capped at 100."""
    B = res["B"]
    rows = []
    for f in res["fcs"]:
        t0, t1 = f["t0"], f["t1"]
        if t1 >= res["t_end"]:          # beyond the simulated hours: no truth to score against
            continue
        untouched = ~B.K[:, t0 - 24:t1 + 1].any(1)
        truth = B.P[:, t1]
        m = untouched
        rate = np.clip(f["y"] - f["prev"], 0, None) * (t1 - t0 + 1) / 24
        rows.append(dict(truth=truth[m], mu=np.minimum(f["mu"][m], 100), sd=f["sd"][m], p=f["p"][m],
                         persist=f["y"][m], trend=np.minimum(f["y"][m] + rate[m], 100)))
    cat = {k: np.concatenate([r[k] for r in rows]) for k in rows[0]}
    tr = cat["truth"]
    over = (tr >= 99.999).astype(float)
    unc = tr < 99.999
    z = (tr[unc] - cat["mu"][unc]) / cat["sd"][unc]
    out = {"n": int(len(tr))}
    for k in ("mu", "persist", "trend"):
        e = cat[k] - tr
        out[k] = {"mae": float(np.abs(e).mean()), "rmse": float(np.sqrt((e ** 2).mean()))}
    clim = over.mean()
    out["brier"] = float(((cat["p"] - over) ** 2).mean())
    out["brier_climatology"] = float(((clim - over) ** 2).mean())
    out["coverage80"] = float((np.abs(z) <= 1.2816).mean())
    out["coverage95"] = float((np.abs(z) <= 1.96).mean())
    out["z_sd"] = float(z.std())
    bins = np.linspace(0, 1, 11)
    k = np.clip(np.digitize(cat["p"], bins) - 1, 0, 9)
    out["reliability"] = [{"p": float(cat["p"][k == b].mean()), "obs": float(over[k == b].mean()),
                           "n": int((k == b).sum())} for b in range(10) if (k == b).sum() >= 20]
    return out


# ── workers (separate processes) ──────────────────────────────────────────────
def _job(args):
    kind, seed, policy, c_o, alpha = args
    t = time.time()
    if kind == "main":
        res = run(seed, policy, keep_forecasts=(policy == "binsight"))
        out = {"score": score(res), "log": res["log"]}
        if policy == "binsight":
            out["forecast"] = forecast_metrics(res)
    else:
        res = run(seed, policy, c_o=c_o, alpha=alpha, warm=EVAL0 - 5, days=5 + C.EVAL_DAYS, sa=1.0)
        out = {"score": score(res)}
    print(f"  {kind} seed {seed} {policy} c_o={c_o} α={alpha}: {time.time() - t:.0f}s", flush=True)
    return out


def main_experiment(procs=10):
    jobs = [("main", s, p, C.COST_OVERFLOW, C.ALPHA) for s in C.SEEDS for p in ("timetable", "reactive", "binsight")]
    jobs += [("pareto", 1, "binsight", c, 1.0) for c in (10, 20, 40, 60, 100, 150, 250, 400)]
    with Pool(procs) as pool:
        out = pool.map(_job, jobs)
    main = out[:len(C.SEEDS) * 3]
    pareto = [o["score"] for o in out[len(main):]]
    return main, pareto


def fleet_lower_bound(I):
    """No plan can use fewer trucks: every stop is serviced and left by some arc, every trip tips."""
    Tm = I.T.copy()
    np.fill_diagonal(Tm, np.inf)
    leave = Tm[1:].min(1).sum() + Tm[0, 1:].min() * math.ceil(I.q.sum() / I.Q)
    trips = math.ceil(I.q.sum() / I.Q)
    return math.ceil((I.s.sum() + leave + trips * I.tip) / I.tmax)
