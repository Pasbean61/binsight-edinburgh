"""Tomorrow's first plan, before simulated annealing, for the maths page (step 4: before and after).

    python3 scripts/export_first_plan.py

The route model starts from a quick plan (route.initial: fill truck after truck with the nearest stop
that still fits) and simulated annealing improves it; model/run.py keeps only the improved routes.
This script rebuilds tomorrow's routing instance from the published data (data/stops.json, data/site.json)
and the road cache (python3 scripts/fetch_cache.py), runs the same route.initial, checks that both plans
cost exactly what data/site.json says, and writes two files.

data/first_plan.json, the whole city:

  routes   the first plan's trucks → trips: load (L) and street line (simplified to about 20 m,
           enough for the city-wide map)
  compare  both plans side by side: trips, trips less than half full, mean load (%), km (and km to and
           from the depot), driving hours, driving cost, bins left out and their prize, total cost

data/route_example.json, the worked example on the website (maths, step 4): tomorrow's 65 bins in one
window of west Edinburgh, planned from scratch by the same two steps with two trucks: route.initial (the
quick plan) and route.solve (simulated annealing, 4 s, seed 0). For each plan: the trips with their bins,
load and street line, the km and the driving cost. Annealing has a time budget, so another machine may
find a slightly different plan.

Run it after python3 -m model.run.
"""
import datetime as dt
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from model import config as C, decide as DC, export as X, network as N, route as RT  # noqa: E402
from model.run import truck_tables  # noqa: E402


def decode(s):
    """Inverse of export.enc_polyline."""
    pts, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        for k in range(2):
            sh = res = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                res |= (b & 31) << sh
                sh += 5
                if b < 32:
                    break
            d = ~(res >> 1) if res & 1 else res >> 1
            if k == 0:
                lat += d
            else:
                lon += d
        pts.append((lat / 1e5, lon / 1e5))
    return pts


EXAMPLE = (55.918, 55.934, -3.300, -3.272)   # lat and lon bounds of the worked example's window (about 1.8 km square)


def example(st, S, site, q, svc, T, D, nodes, theta, road, fleet=2):
    """The worked example: one window's bins, planned from scratch by route.initial and by route.solve."""
    lat, lon = np.array(S["lat"]), np.array(S["lon"])
    chosen = np.flatnonzero(np.array(S["flag"], bool))
    la0, la1, lo0, lo1 = EXAMPLE
    m = chosen[(lat[chosen] >= la0) & (lat[chosen] < la1) & (lon[chosen] >= lo0) & (lon[chosen] < lo1)]
    I = RT.Instance(m + 1, q[m], svc[m], T, D, prize=C.COST_OVERFLOW * np.array(S["pred"], float)[m] / 100, slow=theta)
    plans = [RT.initial(I, fleet)[0], RT.solve(I, fleet=fleet, seconds=4.0, seed=0)["routes"]]
    path = lambda r: [0] + [int(m[v - 1]) + 1 for v in r] + [0]
    legs = {(int(nodes[a]), int(nodes[b])) for P in plans for r in P for a, b in zip(path(r), path(r)[1:])}
    G = road.paths(sorted(legs))

    def trip(r):
        pts = []
        for a, b in zip(path(r), path(r)[1:]):
            seg = [tuple(x) for x in G[(int(nodes[a]), int(nodes[b]))][0]]
            pts += seg if not pts else seg[1:]
        return {"bins": [[X.r(lat[m[v - 1]], 5), X.r(lon[m[v - 1]], 5)] for v in r], "load": X.r(I.q[r].sum() / I.Q, 3),
                "line": X.enc_polyline(X.simplify(pts, 0.00003))}
    wards = np.array(S["ward"])[m]
    out = {"area": site["wards"][int(np.bincount(wards).argmax())]["name"], "bins": len(m),
           "depot_km": X.r(np.mean(I.D[0, 1:]), 1),
           "plans": [{"trips": [trip(r) for r in P], "km": X.r(sum(RT.trip_km(I, r) for r in P), 1),
                      "cost": X.r(sum(RT.trip_cost(I, r) for r in P), 2)} for P in plans]}
    X.dump("route_example.json", out)
    return out


def load(name):
    return json.load(open(os.path.join(ROOT, "data", name)))


def measures(I, trips):
    """The objective of a plan, term by term (instance numbering, 1..n)."""
    served = {v for r in trips for v in r}
    out = [v for v in range(1, I.n + 1) if v not in served]
    drive = sum(I.T[0, r[0]] + I.T[r[-1], 0] + sum(I.T[a, b] for a, b in zip(r, r[1:])) for r in trips if r)
    cost = sum(RT.trip_cost(I, r) for r in trips)
    prize = float(I.prize[out].sum()) if out else 0.0
    load = [I.q[r].sum() / I.Q for r in trips if r]
    return {"trips": len(load), "half_empty": sum(1 for f in load if f < .5), "load": X.r(100 * np.mean(load), 1),
            "km": X.r(sum(RT.trip_km(I, r) for r in trips), 1),
            "depot_km": X.r(sum(I.D[0, r[0]] + I.D[r[-1], 0] for r in trips if r), 1),
            "drive_h": X.r(drive / 60, 1), "cost": X.r(cost, 2), "left_out": len(out), "prize": X.r(prize, 2),
            "total": X.r(cost + prize, 2)}


def main():
    S, site, R = load("stops.json"), load("site.json"), load("routes.json")
    st = N.stops()
    if list(st["id"]) != S["id"]:
        sys.exit("the stops in data/stops.json are not the model's stops: run python3 -m model.run first")
    z = np.load(os.path.join(C.CACHE, "matrix.npz"))
    T, D, nodes = z["T"], z["D"], z["nodes"]
    plan_t = int((dt.datetime.combine(C.PLAN_DAY, dt.time()) - C.HISTORY_START).total_seconds() // 3600)

    # tomorrow's instance, exactly as decide.plan builds it
    y = np.array(S["fill"], float)
    last = np.array([-1 if s is None else plan_t - 1 - s for s in S["since"]])
    q = DC.demand(st, y, last, plan_t)
    svc = DC.svc_min(st["nb"])
    idx = np.flatnonzero(np.array(S["flag"], bool))
    prize = C.COST_OVERFLOW * np.array(S["pred"], float)[idx] / 100
    I = RT.Instance(idx + 1, q[idx], svc[idx], T, D, prize=prize, slow=DC.slowdown(plan_t))

    # the first plan, and the improved plan as published
    fleet = site["fleet"]["trucks"]
    first, owner, _ = RT.initial(I, fleet)
    pos = {int(i): k + 1 for k, i in enumerate(idx)}
    final = [[pos[s] for s in tr["stops"]] for r in R["routes"] for tr in r["trips"]]
    M = {"first": measures(I, first), "final": measures(I, final)}
    for k, key in (("first", "start"), ("final", "final")):
        stored = site["maths"]["route"][key]
        if abs(sum(RT.trip_cost(I, r) for r in (first if k == "first" else final)) - stored) > 1e-6:
            sys.exit(f"the rebuilt {k} plan costs differently from data/site.json ({stored:.2f}): rebuild the data first")

    sol = {"routes": first, "trucks": [[k for k, b in enumerate(owner) if b == bb] for bb in sorted(set(owner))]}
    road = N.RoadGraph()
    trucks, _ = truck_tables(st, {"I": I, "sol": sol, "idx": idx}, road, nodes)
    routes = [{"trips": [{"load": t["load"], "line": X.enc_polyline(X.simplify(decode(t["line"]), 0.0002))}
                         for t in tr["trips"]]} for tr in trucks]
    X.dump("first_plan.json", {"routes": routes, "compare": M})
    print(f"first plan: {M['first']}\nafter annealing: {M['final']}")
    E = example(st, S, site, q, svc, T, D, nodes, DC.slowdown(plan_t), road)
    print(f"example, {E['area']}, {E['bins']} bins: " + " → ".join(
        f"{len(p['trips'])} trips {[t['load'] for t in p['trips']]}, {p['km']} km, £{p['cost']:.0f}" for p in E["plans"]))


if __name__ == "__main__":
    main()
