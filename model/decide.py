"""
Layer 4a: which stops get a truck tomorrow, and the inputs of the route model.

One rule:  sort the stops by projected fill ŷ_i at the next chance of a truck (predict.py), fullest
first, and take them while the fleet still has time.  A stop projected below FLOOR % is never taken,
so trucks are not sent to stops that can safely wait even on a quiet day.

The time a stop uses is its lifting time plus the drive from its nearest other candidate stop, and
each full load adds a trip to the depot to tip.  This estimate is rough on purpose: the route model
(route.py) has the final say, and if the routes do not fit it leaves out the stops of least prize.

Weather and holidays enter the route model's constraints here:
  demand()    q_i, the load constraint:    q_i = cap_i · min(1, (y_i + b_i · W_i) / 100)
              b_i = y_i / Σ w_h over the hours since stop i was last emptied   (its fill per unit of w)
              W_i = Σ w_h from the decision to the truck's visit,  w_h = simulate.factor()  (rain, temperature, holiday)
  slowdown()  θ, the shift constraint:     θ = 1 + κ · (share of the shift's hours with ≥ 0.5 mm of rain)
"""
import functools

import numpy as np

from . import config as C
from . import route as RT
from . import simulate as SM

PACKING = 0.95          # share of fleet time the routes can fill
MID_SHIFT_H = C.SHIFT_MIN / 60 / 2      # a truck reaches a typical stop half-way through the shift


@functools.lru_cache(maxsize=None)
def _calendar():
    _, rain = SM.weather()
    return SM.factor(), rain


def shift_start(t):
    """First 06:00 at or after hour t."""
    return t + (C.SHIFT_START_H - t) % 24


def slowdown(t_dec):
    """θ for the next shift after a decision at hour t_dec."""
    _, rain = _calendar()
    h0 = shift_start(t_dec)
    shift = rain[h0:h0 + C.SHIFT_MIN // 60]
    return 1 + C.RAIN_SLOWDOWN * float((shift >= .5).mean()) if len(shift) else 1.0


def demand(st, y, last, t_dec):
    """Litres in every stop when the truck arrives, with the weather and holiday factor w_h.

    y: readings (%) at t_dec − 1; last: hour each stop was last emptied (−1 if never)."""
    w, _ = _calendar()
    cw = np.r_[0, np.cumsum(w)]                                   # Σ w over hours [a, b) = cw[b] − cw[a]
    start = np.where(last >= 0, last + 1, 0)
    w_since = cw[t_dec] - cw[np.minimum(start, t_dec)]
    b = np.where(w_since > 1, y / np.maximum(w_since, 1e-9), np.nan)
    b = np.where(np.isnan(b), np.nanmedian(b), b)
    t1 = min(int(round(shift_start(t_dec) + MID_SHIFT_H)), len(w))
    W = cw[t1] - cw[t_dec]
    return st["cap"] * np.clip(y + b * W, 0, 100) / 100


def svc_min(nb):
    return C.SERVICE_BASE_MIN + C.SERVICE_PER_BIN_MIN * np.asarray(nb)


def drive_estimate(Tm, cand):
    """Minutes from each candidate stop's nearest other candidate (depot included)."""
    rows = np.r_[0, np.flatnonzero(cand) + 1]
    sub = Tm[np.ix_(rows, rows)].astype(float)
    np.fill_diagonal(sub, np.inf)
    out = np.zeros(len(cand))
    out[cand] = sub[1:].min(1)
    return out


def choose(proj, tmin, q, budget, floor=C.FLOOR, Q=C.TRUCK_LOAD_L, tip=C.TIP_MIN):
    """Fullest projected first, while the estimated minutes fit the budget; never below the floor."""
    cand = np.flatnonzero(proj >= floor)
    order = cand[np.argsort(-proj[cand], kind="stable")]
    used = np.cumsum(tmin[order]) + np.ceil(np.cumsum(q[order]) / Q) * tip
    chosen = np.zeros(len(proj), bool)
    chosen[order[used <= budget]] = True
    return chosen


def plan(st, T, D, y, proj, last, t_dec, floor=C.FLOOR, fleet=C.FLEET, seconds=10.0, seed=0, verbose=False,
         tmax=C.SHIFT_MIN, Q=C.TRUCK_LOAD_L, Tm_all=None):
    """Choose and route tomorrow's stops.

    y: latest readings (%); proj: projected fill at the next chance of a truck (%, predict.py);
    last: hour each stop was last emptied; t_dec: the decision hour (05:00)."""
    if Tm_all is None:
        Tm_all = ((T + T.T) / 2).astype(np.float32)
    theta = slowdown(t_dec)
    svc = svc_min(st["nb"])
    q = demand(st, y, last, t_dec)
    risky = proj >= floor
    tmin = theta * drive_estimate(Tm_all, risky) + svc
    chosen = choose(proj, tmin, q, fleet * tmax * PACKING, floor, Q, C.TIP_MIN)
    idx = np.flatnonzero(chosen)
    prize = C.COST_OVERFLOW * proj[idx] / 100
    I = RT.Instance(idx + 1, q[idx], svc[idx], T, D, prize=prize, Q=Q, tmax=tmax, slow=theta)
    sol = RT.solve(I, fleet=fleet, seconds=seconds, seed=seed, verbose=verbose)
    served = chosen.copy()
    if sol["dropped"]:
        served[idx[np.asarray(sol["dropped"], int) - 1]] = False
    return {"sol": sol, "I": I, "idx": idx, "chosen": chosen, "served": served, "risky": risky,
            "mand": proj >= 100, "tmin": tmin, "q": q, "proj": proj, "theta": theta}
