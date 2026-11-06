"""
Layer 4a: which stops get a truck tomorrow.

One rule:  sort the stops by projected fill ŷ_i at the next chance of a truck (predict.py), fullest
first, and take them while the fleet still has time.  A stop projected below FLOOR % is never taken,
so trucks are not sent to stops that can safely wait even on a quiet day.

The time a stop uses is its lifting time plus the drive from its nearest other candidate stop, and
each full load adds a trip to the depot to tip.  This estimate is rough on purpose: routing
(route.py) has the final say, and if the routes do not fit it drops the least risky stops first.
"""
import numpy as np

from . import config as C
from . import route as RT

PACKING = 0.95          # share of fleet time first-fit packing can fill
# hours from the 05:00 decision to the middle of the 06:00 shift, when a truck reaches a typical stop
VISIT_H = 1 + C.SHIFT_MIN / 60 / 2


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


def plan(st, T, D, y, proj, gain, floor=C.FLOOR, fleet=C.FLEET, sa_seconds=3.0, seed=0, verbose=False,
         tmax=C.SHIFT_MIN, Q=C.TRUCK_LOAD_L, svc_scale=1.0, Tm_all=None):
    """Choose and route tomorrow's stops.

    y: latest readings (%); proj: projected fill at the next chance of a truck (%);
    gain: predicted fill gain (% an hour). proj and gain come from predict.py."""
    if Tm_all is None:
        Tm_all = ((T + T.T) / 2).astype(np.float32)
    svc = svc_min(st["nb"]) * svc_scale
    q = st["cap"] * np.clip(y + gain * VISIT_H, 0, 100) / 100               # litres when the truck arrives
    risky = proj >= floor
    tmin = drive_estimate(Tm_all, risky) + svc
    chosen = choose(proj, tmin, q, fleet * tmax * PACKING, floor, Q, C.TIP_MIN)
    idx = np.flatnonzero(chosen)
    I = RT.Instance(idx + 1, q[idx], svc[idx], T, D, value=proj[idx], Q=Q, tmax=tmax)
    sol = RT.solve(I, fleet=fleet, sa_seconds=sa_seconds, seed=seed, verbose=verbose)
    served = chosen.copy()
    if sol["dropped"]:
        served[idx[np.asarray(sol["dropped"], int) - 1]] = False
    return {"sol": sol, "I": I, "idx": idx, "chosen": chosen, "served": served, "risky": risky,
            "tmin": tmin, "q": q, "proj": proj}
