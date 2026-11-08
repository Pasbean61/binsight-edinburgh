"""
Calibrate U (config.FILL_AT_COLLECTION): average fill when the council's timetable truck comes.

Run the council's timetable (every stop every COLLECT_EVERY_DAYS days, in fixed geographic rounds)
on the simulator for a grid of U, and pick the U at which overflows are TARGET_OVERFLOW of
collections. No routing is needed: each stop is emptied at a fixed hour of the shift (06:00–13:00),
the same every round, as a fixed route would.

    python3 -m model.calibrate
"""
import numpy as np

from . import config as C
from . import network as N
from . import simulate as SM
from .experiment import EVAL0, RUN_DAYS, WARM_DAYS, timetable_rounds

GRID = (0.30, 0.35, 0.40, 0.45, 0.50)


def overflow_share(st, rounds, U, seed):
    X = SM.deposits(st, seed, U=U)
    B = SM.Bins(st, X, seed)
    visit = np.random.default_rng(7).integers(C.SHIFT_START_H, C.SHIFT_START_H + 8, len(st["cap"]))
    days = WARM_DAYS + RUN_DAYS
    pend = {}
    for day in range(days):
        g = np.flatnonzero(rounds == day % C.TIMETABLE_EVERY)
        for h in np.unique(visit[g]):
            pend.setdefault(day * 24 + h, []).extend(g[visit[g] == h].tolist())
    for t in range(days * 24):
        B.hour(t, pend.pop(t, ()))
    h0, h1 = EVAL0 * 24, (EVAL0 + C.EVAL_DAYS) * 24
    fills = [f for (t, _, f) in B.coll if h0 <= t < h1]
    return B.over_events[h0:h1].sum() / len(fills), float(np.mean(fills))


def main():
    st = N.stops()
    rounds = timetable_rounds(st)
    rows = []
    for U in GRID:
        out = np.array([overflow_share(st, rounds, U, s) for s in C.SEEDS]).mean(0)
        rows.append((U, out[0], out[1]))
        print(f"  U = {U:.2f}: overflows are {100 * out[0]:5.2f} % of collections, "
              f"mean fill when emptied {out[1]:4.1f} %", flush=True)
    u, s, _ = np.array(rows).T
    best = float(np.interp(C.TARGET_OVERFLOW, s, u))     # share rises with U
    print(f"U for {100 * C.TARGET_OVERFLOW:.1f} % overflow: {best:.3f}  (config.FILL_AT_COLLECTION = {C.FILL_AT_COLLECTION})")
    return best, rows


if __name__ == "__main__":
    main()
