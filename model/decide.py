"""
Layer 4a: which stops get a truck tomorrow.

Skipping stop i until the next chance of a truck risks an overflow with probability p_i (forecast.py),
at cost c_o. Collecting it costs the driving and lifting it adds to the routes, Δ_i (£). But a stop
emptied today does not need emptying later: in a renewal cycle of τ_i days (empty to full), emptying it
k_i days before it would otherwise have to go wastes k_i / τ_i of a cycle, so the cost of going early is
Δ_i k_i / τ_i, where

    k_i = 1 + max(0, (100 − μ_i) / g_i)      days early   (g_i = 100 / τ_i, % a day; μ_i the forecast
                                                           fill at the next chance if skipped)

The net value of collecting i tomorrow is   v_i = p_i c_o − Δ_i k_i / τ_i.

The fleet has T = trucks × shift minutes. With t_i the minutes stop i adds (lifting + extra driving),
tomorrow is a knapsack:   max Σ v_i x_i   s.t.  Σ t_i x_i ≤ T,  x_i = 1 whenever p_i > α.
Its Lagrangian relaxation with a price λ ≥ 0 per truck-minute gives the rule

    collect i  ⇔  p_i > α                    (service standard: a chance constraint)
               or v_i > λ t_i                (net value beats the time it uses)

with λ = 0 when the fleet has room, and otherwise the smallest λ (found by bisection) whose choice
fits. If even the stops above α do not fit, the riskiest per minute are kept.

Δ_i and t_i depend on the other stops chosen, so we
  1. estimate them by the cheapest insertion between nearby mandatory stops,
  2. choose and route (route.py),
  3. replace the estimates by the exact insertion cost into the routed trips (stops left out) and the
     exact removal saving (stops in), correct the time estimate by what routing really used, and
     choose and route again.
"""
import math

import numpy as np

from . import config as C
from . import route as RT

PACKING = 0.95          # share of fleet time first-fit packing can fill


def svc_min(nb):
    return C.SERVICE_BASE_MIN + C.SERVICE_PER_BIN_MIN * np.asarray(nb)


def insertion_estimate(Mx, chosen, k=6):
    """Cheapest insertion (in the units of Mx) of every stop between two of its k nearest chosen nodes.

    Mx: (n+1)×(n+1) symmetric matrix over depot (0) and stops 1..n. chosen: boolean mask over stops."""
    n = Mx.shape[0] - 1
    anchors = np.r_[0, np.flatnonzero(chosen) + 1]
    sub = Mx[1:, :][:, anchors]
    k = min(k, len(anchors))
    near = np.argsort(sub, axis=1)[:, :k]
    if k == 1:
        return 2 * sub[:, 0].astype(float)
    best = np.full(n, np.inf)
    rows = np.arange(n)
    for a in range(k):
        for b in range(a + 1, k):
            ja, jb = anchors[near[:, a]], anchors[near[:, b]]
            best = np.minimum(best, sub[rows, near[:, a]] + sub[rows, near[:, b]] - Mx[ja, jb])
    return np.maximum(best, 0)


def exact_insertion(I, routes, cand_rows, Mx):
    """Cheapest insertion of stops (matrix rows, 1-based) into the routed trips, in the units of Mx."""
    paths = [np.r_[0, I.idx[np.asarray(r) - 1], 0] for r in routes if r]
    if not paths:
        return 2 * Mx[0, cand_rows].astype(float)
    a = np.concatenate([p[:-1] for p in paths])
    b = np.concatenate([p[1:] for p in paths])
    out = np.empty(len(cand_rows))
    for s in range(0, len(cand_rows), 256):
        c = cand_rows[s:s + 256]
        out[s:s + 256] = (Mx[c][:, a] + Mx[c][:, b] - Mx[a, b][None, :]).min(1)
    return np.maximum(out, 0)


def exact_removal(I, routes):
    """(cost saving £, driving minutes saved) from removing each routed stop, by instance number."""
    sav = {}
    for r in routes:
        path = [0] + list(r) + [0]
        for p in range(1, len(path) - 1):
            a, v, b = path[p - 1], path[p], path[p + 1]
            sav[v] = (I.Cm[a, v] + I.Cm[v, b] - I.Cm[a, b], I.T[a, v] + I.T[v, b] - I.T[a, b])
    return sav


def choose(mand, value, tmin, q, budget, Q=C.TRUCK_LOAD_L, tip=C.TIP_MIN, cal=1.0):
    """Lagrangian choice: mandatory stops, plus those with value > λ · minutes, fitting the budget."""
    est = lambda m: cal * (tmin[m].sum() + math.ceil(q[m].sum() / Q) * tip)
    if est(mand) > budget:                      # not even the urgent stops fit: keep the riskiest per minute
        idx = np.flatnonzero(mand)
        order = idx[np.argsort(-value[idx] / np.maximum(tmin[idx], .1))]
        cum = cal * (np.cumsum(tmin[order]) + np.ceil(np.cumsum(q[order]) / Q) * tip)
        keep = np.zeros_like(mand)
        keep[order[cum <= budget]] = True
        return keep, float("inf")
    pick = lambda lam: mand | (value > lam * tmin)
    if est(pick(0.0)) <= budget:
        return pick(0.0), 0.0
    lo, hi = 0.0, float(np.max(value / np.maximum(tmin, .1))) + 1
    for _ in range(40):
        mid = (lo + hi) / 2
        if est(pick(mid)) > budget:
            lo = mid
        else:
            hi = mid
    return pick(hi), hi


def plan(st, T, D, Cm_all, y, mu, sd, p, tau, c_o=C.COST_OVERFLOW, alpha=C.ALPHA,
         fleet=C.FLEET, sa_seconds=3.0, seed=0, rounds=1, verbose=False,
         tmax=C.SHIFT_MIN, Q=C.TRUCK_LOAD_L, svc_scale=1.0, Tm_all=None):
    """Choose and route tomorrow's stops. Returns the routed solution plus the decision record."""
    n = len(y)
    svc = svc_min(st["nb"]) * svc_scale
    q = st["cap"] * np.clip(mu, 0, 100) / 100
    if Tm_all is None:
        Tm_all = ((T + T.T) / 2).astype(np.float32)
    mand = p > alpha
    benefit = p * c_o
    g = 100 / tau
    k_early = 1 + np.maximum(0, (100 - mu) / g)
    delta = insertion_estimate(Cm_all, mand) + svc * C.COST_HOUR / 60
    tmin = insertion_estimate(Tm_all, mand) + svc
    budget = fleet * tmax * PACKING
    cal = 1.0
    hist = []
    for it in range(rounds + 1):
        value = benefit - delta * k_early / tau
        chosen, lam = choose(mand, value, tmin, q, budget, Q, C.TIP_MIN, cal)
        idx = np.flatnonzero(chosen)
        val_i = np.where(mand[idx], 1e6 * p[idx], value[idx])
        I = RT.Instance(idx + 1, q[idx], svc[idx], T, D, mand=mand[idx], Q=Q, tmax=tmax, value=val_i)
        I.tvalue = val_i
        last = it == rounds
        sol = RT.solve(I, fleet=fleet, sa_seconds=sa_seconds if last else min(1.0, sa_seconds), seed=seed, verbose=verbose)
        used = sum(sol["used"])
        est = tmin[idx].sum() + math.ceil(q[idx].sum() / Q) * C.TIP_MIN
        hist.append({"round": it, "chosen": int(chosen.sum()), "mand": int(mand.sum()), "lambda": lam,
                     "cost": sol["cost"], "minutes": used, "estimate": cal * est, "dropped": len(sol["dropped"])})
        if last:
            break
        cal = max(.5, min(2.0, used / max(est, 1)))
        # exact marginal costs and minutes given these routes
        out_rows = np.flatnonzero(~chosen) + 1
        if len(out_rows):
            delta[out_rows - 1] = exact_insertion(I, sol["routes"], out_rows, Cm_all) + svc[out_rows - 1] * C.COST_HOUR / 60
            tmin[out_rows - 1] = exact_insertion(I, sol["routes"], out_rows, Tm_all) + svc[out_rows - 1]
        for v, (dc, dt) in exact_removal(I, sol["routes"]).items():
            delta[idx[v - 1]] = dc + I.s[v] * C.COST_HOUR / 60
            tmin[idx[v - 1]] = dt + I.s[v]
    served = np.zeros(n, bool)
    served[idx] = True
    if sol["dropped"]:
        served[idx[np.asarray(sol["dropped"], int) - 1]] = False
    value = benefit - delta * k_early / tau
    return {"sol": sol, "I": I, "idx": idx, "chosen": chosen, "served": served, "mand": mand,
            "delta": delta, "tmin": tmin, "k_early": k_early, "benefit": benefit, "value": value,
            "lambda": lam, "q": q, "rounds": hist}
