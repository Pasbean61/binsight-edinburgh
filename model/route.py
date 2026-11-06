"""
Layer 4b: our routing heuristic for the multi-trip capacitated VRP with an 8-hour shift.

Model (solved approximately here, exactly for small cases in exact.py):
    nodes 0 (depot) and the chosen stops 1..n, symmetric road cost c_ij = £/km · km_ij + £/h · h_ij
    each trip leaves the depot, visits stops, returns and tips:   load ≤ Q
    each truck does trips back to back:                        Σ (drive + service + tip) ≤ 480 min
    minimise  Σ c_ij over all trips

Algorithm, in four stages:
  1. Clarke–Wright savings  s_ij = c_0i + c_0j − c_ij, merging route ends in order of saving
     while load and trip time stay feasible.
  2. Local search to a local optimum: 2-opt and Or-opt inside trips; relocate a stop and swap two
     stops between trips, over each stop's 20 nearest neighbours.
  3. Simulated annealing over relocate and swap moves (accept a worse move with probability
     exp(−Δ/T), T cooled geometrically), then local search again.
  4. Pack trips into trucks: first-fit decreasing on trip time into 480-minute shifts. If that needs
     more trucks than the fleet, drop the stops of least value (never a mandatory one first).
"""
import math
import random
import time

import numpy as np

from . import config as C


class Instance:
    def __init__(self, idx, q, svc, T, D, mand=None, value=None, Q=C.TRUCK_LOAD_L, tmax=C.SHIFT_MIN, tip=C.TIP_MIN):
        """idx: matrix rows of the stops (0 = depot). q litres, svc minutes per stop."""
        self.idx = np.asarray(idx)
        n = len(idx)
        rows = np.r_[0, self.idx]
        self.T = T[np.ix_(rows, rows)].astype(float)
        self.D = D[np.ix_(rows, rows)].astype(float)
        self.T = (self.T + self.T.T) / 2
        self.D = (self.D + self.D.T) / 2
        self.Cm = C.COST_KM * self.D + C.COST_HOUR * self.T / 60
        self.q = np.r_[0, q].astype(float)
        self.s = np.r_[0, svc].astype(float)
        self.n = n
        self.Q, self.tmax, self.tip = Q, tmax, tip
        self.mand = np.r_[False, mand if mand is not None else np.zeros(n, bool)]
        self.value = np.r_[0, value if value is not None else np.ones(n)]
        k = min(20, n - 1) if n > 1 else 0
        self.nn = np.argsort(self.Cm[1:, 1:], axis=1)[:, 1:k + 1] + 1 if n > 1 else np.zeros((0, 0), int)


# ── helpers ───────────────────────────────────────────────────────────────────
def trip_cost(I, r):
    if not r:
        return 0.0
    c = I.Cm[0, r[0]] + I.Cm[r[-1], 0]
    for a, b in zip(r, r[1:]):
        c += I.Cm[a, b]
    return c


def trip_time(I, r):
    if not r:
        return 0.0
    t = I.T[0, r[0]] + I.T[r[-1], 0] + I.tip
    for a, b in zip(r, r[1:]):
        t += I.T[a, b]
    return t + I.s[r].sum()


def trip_km(I, r):
    if not r:
        return 0.0
    return I.D[0, r[0]] + I.D[r[-1], 0] + sum(I.D[a, b] for a, b in zip(r, r[1:]))


def total_cost(I, routes):
    return sum(trip_cost(I, r) for r in routes)


# ── 1. Clarke–Wright savings ──────────────────────────────────────────────────
def savings(I):
    n = I.n
    routes = {i: [i] for i in range(1, n + 1)}
    of = list(range(n + 1))
    load = {i: I.q[i] for i in routes}
    tim = {i: trip_time(I, [i]) for i in routes}
    pairs = set()
    for i in range(1, n + 1):
        for j in I.nn[i - 1]:
            pairs.add((min(i, j), max(i, j)))
    pairs = np.array(sorted(pairs)) if pairs else np.zeros((0, 2), int)
    if len(pairs):
        s = I.Cm[0, pairs[:, 0]] + I.Cm[0, pairs[:, 1]] - I.Cm[pairs[:, 0], pairs[:, 1]]
        order = np.argsort(-s)
    else:
        order, s = [], []
    for k in order:
        if s[k] <= 0:
            break
        i, j = pairs[k]
        ri, rj = of[i], of[j]
        if ri == rj:
            continue
        A, B = routes[ri], routes[rj]
        if A[0] != i and A[-1] != i or B[0] != j and B[-1] != j:
            continue
        if load[ri] + load[rj] > I.Q:
            continue
        t_new = tim[ri] + tim[rj] - I.tip - I.T[i, 0] - I.T[0, j] + I.T[i, j]
        if t_new > I.tmax:
            continue
        if A[-1] != i:
            A = A[::-1]
        if B[0] != j:
            B = B[::-1]
        routes[ri] = A + B
        load[ri] += load[rj]
        tim[ri] = t_new
        for v in B:
            of[v] = ri
        del routes[rj], load[rj], tim[rj]
    return [r for r in routes.values()]


def nearest_neighbour(I):
    """Baseline for comparison: always drive to the nearest unvisited stop that still fits."""
    left = set(range(1, I.n + 1))
    routes = []
    while left:
        r, load, cur, t = [], 0.0, 0, I.tip
        while True:
            cand = [j for j in left if load + I.q[j] <= I.Q and t + I.T[cur, j] + I.s[j] + I.T[j, 0] <= I.tmax]
            if not cand:
                break
            j = min(cand, key=lambda j: I.Cm[cur, j])
            t += I.T[cur, j] + I.s[j]
            load += I.q[j]
            r.append(j)
            left.discard(j)
            cur = j
        if not r:                      # a stop that cannot fit alone: serve it on its own anyway
            j = left.pop()
            r = [j]
        routes.append(r)
    return routes


# ── 2. local search ───────────────────────────────────────────────────────────
def two_opt(I, r):
    if len(r) < 3:
        return r, False
    path = [0] + r + [0]
    M = I.Cm
    any_ = False
    improved = True
    while improved:
        improved = False
        for a in range(0, len(path) - 3):
            for b in range(a + 2, len(path) - 1):
                d = M[path[a], path[b]] + M[path[a + 1], path[b + 1]] - M[path[a], path[a + 1]] - M[path[b], path[b + 1]]
                if d < -1e-9:
                    path[a + 1:b + 1] = path[a + 1:b + 1][::-1]
                    improved = any_ = True
    return path[1:-1], any_


def or_opt(I, r):
    any_ = False
    improved = True
    while improved and len(r) > 3:
        improved = False
        base = trip_cost(I, r)
        for L in (1, 2, 3):
            for i in range(len(r) - L + 1):
                seg, rest = r[i:i + L], r[:i] + r[i + L:]
                for j in range(len(rest) + 1):
                    if j == i:
                        continue
                    for sg in (seg, seg[::-1]):
                        cand = rest[:j] + sg + rest[j:]
                        if trip_cost(I, cand) < base - 1e-9:
                            r, base, improved, any_ = cand, trip_cost(I, cand), True, True
                            break
                    if improved:
                        break
                if improved:
                    break
            if improved:
                break
    return r, any_


class State:
    """Trips with positions, loads and times for O(1) move evaluation."""

    def __init__(self, I, routes):
        self.I = I
        self.R = [list(r) for r in routes if r]
        self.refresh()

    def refresh(self):
        I = self.I
        self.where = {}
        for k, r in enumerate(self.R):
            for p, v in enumerate(r):
                self.where[v] = (k, p)
        self.load = [I.q[r].sum() for r in self.R]
        self.time = [trip_time(I, r) for r in self.R]

    def nb(self, r, p):
        prev = r[p - 1] if p > 0 else 0
        nxt = r[p + 1] if p + 1 < len(r) else 0
        return prev, nxt

    def relocate_delta(self, v, k2, pos):
        """Move v to trip k2 before position pos. Returns (Δcost, Δt_from, Δt_to) or None."""
        I, M, T = self.I, self.I.Cm, self.I.T
        k1, p1 = self.where[v]
        r1, r2 = self.R[k1], self.R[k2]
        if k1 == k2:
            return None
        if self.load[k2] + I.q[v] > I.Q:
            return None
        a, b = self.nb(r1, p1)
        rem_c = M[a, v] + M[v, b] - M[a, b]
        rem_t = T[a, v] + T[v, b] - T[a, b] + I.s[v]
        c = r2[pos - 1] if pos > 0 else 0
        d = r2[pos] if pos < len(r2) else 0
        add_c = M[c, v] + M[v, d] - M[c, d]
        add_t = T[c, v] + T[v, d] - T[c, d] + I.s[v]
        if self.time[k2] + add_t > I.tmax:
            return None
        return add_c - rem_c, -rem_t, add_t

    def relocate(self, v, k2, pos, dt1, dt2):
        k1, p1 = self.where[v]
        self.R[k1].pop(p1)
        self.R[k2].insert(pos, v)
        self.load[k1] -= self.I.q[v]
        self.load[k2] += self.I.q[v]
        self.time[k1] += dt1
        self.time[k2] += dt2
        for p, u in enumerate(self.R[k1]):
            self.where[u] = (k1, p)
        for p, u in enumerate(self.R[k2]):
            self.where[u] = (k2, p)
        if not self.R[k1]:
            self.time[k1] = 0

    def swap_delta(self, u, v):
        I, M, T = self.I, self.I.Cm, self.I.T
        ku, pu = self.where[u]
        kv, pv = self.where[v]
        if ku == kv:
            return None
        lu = self.load[ku] - I.q[u] + I.q[v]
        lv = self.load[kv] - I.q[v] + I.q[u]
        if lu > I.Q or lv > I.Q:
            return None
        a, b = self.nb(self.R[ku], pu)
        c, d = self.nb(self.R[kv], pv)
        dcu = M[a, v] + M[v, b] - M[a, u] - M[u, b]
        dcv = M[c, u] + M[u, d] - M[c, v] - M[v, d]
        dtu = T[a, v] + T[v, b] - T[a, u] - T[u, b] + I.s[v] - I.s[u]
        dtv = T[c, u] + T[u, d] - T[c, v] - T[v, d] + I.s[u] - I.s[v]
        if self.time[ku] + dtu > I.tmax or self.time[kv] + dtv > I.tmax:
            return None
        return dcu + dcv, dtu, dtv

    def swap(self, u, v, dtu, dtv):
        ku, pu = self.where[u]
        kv, pv = self.where[v]
        self.R[ku][pu], self.R[kv][pv] = v, u
        self.where[v], self.where[u] = (ku, pu), (kv, pv)
        self.load[ku] += self.I.q[v] - self.I.q[u]
        self.load[kv] += self.I.q[u] - self.I.q[v]
        self.time[ku] += dtu
        self.time[kv] += dtv

    def moves(self, v):
        """Candidate moves for stop v over its nearest neighbours."""
        for w in self.I.nn[v - 1]:
            if w not in self.where:
                continue
            k2, p2 = self.where[w]
            for pos in (p2, p2 + 1):
                yield ("rel", v, k2, pos)
            yield ("swp", v, w)

    def delta(self, mv):
        return self.relocate_delta(*mv[1:]) if mv[0] == "rel" else self.swap_delta(*mv[1:])

    def apply(self, mv, d):
        if mv[0] == "rel":
            self.relocate(mv[1], mv[2], mv[3], d[1], d[2])
        else:
            self.swap(mv[1], mv[2], d[1], d[2])

    def compact(self):
        self.R = [r for r in self.R if r]
        self.refresh()


def intra(I, routes):
    out = []
    for r in routes:
        r, _ = two_opt(I, r)
        if len(r) <= 40:
            r, _ = or_opt(I, r)
        out.append(r)
    return out


def local_search(I, routes, passes=6):
    S = State(I, intra(I, routes))
    for _ in range(passes):
        gain = 0.0
        order = list(S.where)
        random.Random(len(order)).shuffle(order)
        for v in order:
            best, bm, bd = -1e-9, None, None
            for mv in S.moves(v):
                d = S.delta(mv)
                if d is not None and d[0] < best:
                    best, bm, bd = d[0], mv, d
            if bm:
                S.apply(bm, bd)
                gain += best
        S.compact()
        S.R = intra(I, S.R)
        S.refresh()
        if gain > -1e-6:
            break
    return S.R


# ── 3. simulated annealing ────────────────────────────────────────────────────
def anneal(I, routes, seconds=6.0, seed=0):
    rng = random.Random(seed)
    S = State(I, routes)
    stops = list(S.where)
    if len(stops) < 3:
        return routes
    arcs = np.mean([trip_cost(I, r) / (len(r) + 1) for r in S.R])
    T0, T1 = 0.08 * arcs, 0.002 * arcs
    cur = total_cost(I, S.R)
    best_cost, best = cur, [list(r) for r in S.R]
    t_start = time.time()
    it = 0
    while True:
        el = (time.time() - t_start) / seconds
        if el >= 1:
            break
        temp = T0 * (T1 / T0) ** el
        for _ in range(200):
            it += 1
            v = rng.choice(stops)
            mvs = list(S.moves(v))
            if not mvs:
                continue
            mv = rng.choice(mvs)
            d = S.delta(mv)
            if d is None:
                continue
            if d[0] < 0 or rng.random() < math.exp(-d[0] / temp):
                S.apply(mv, d)
                cur += d[0]
                if cur < best_cost - 1e-9:
                    best_cost, best = cur, [list(r) for r in S.R]
    return [r for r in best if r]


# ── 4. trucks ─────────────────────────────────────────────────────────────────
def pack(I, routes, fleet=None):
    """First-fit decreasing of trips into shifts. Returns trucks as lists of trip indices."""
    times = [trip_time(I, r) for r in routes]
    order = sorted(range(len(routes)), key=lambda k: -times[k])
    trucks, used = [], []
    for k in order:
        for b in range(len(trucks)):
            if used[b] + times[k] <= I.tmax + 1e-9:
                trucks[b].append(k)
                used[b] += times[k]
                break
        else:
            trucks.append([k])
            used.append(times[k])
    # longest trip first within a truck keeps the morning loads big
    return trucks, used


def solve(I, fleet=C.FLEET, sa_seconds=6.0, seed=0, verbose=False):
    t0 = time.time()
    routes = savings(I)
    c_cw = total_cost(I, routes)
    routes = local_search(I, routes)
    c_ls = total_cost(I, routes)
    if sa_seconds > 0:
        routes = anneal(I, routes, sa_seconds, seed)
        routes = local_search(I, routes)
    c_sa = total_cost(I, routes)
    trucks, used = pack(I, routes)
    dropped = []
    # too few trucks: drop the least valuable optional stops until the trips fit
    while len(trucks) > fleet:
        S = State(I, routes)
        cand = [v for v in S.where if not I.mand[v]] or list(S.where)
        # least value per minute saved first (the knapsack ratio rule)
        def saved(v):
            k, p = S.where[v]
            a, b = S.nb(S.R[k], p)
            return I.T[a, v] + I.T[v, b] - I.T[a, b] + I.s[v]
        cand.sort(key=lambda v: I.value[v] / max(saved(v), .1))
        excess = sum(sorted(used)[:len(trucks) - fleet])
        removed_t = 0.0
        for v in cand:
            if removed_t >= excess:
                break
            k, p = S.where[v]
            a, b = S.nb(S.R[k], p)
            removed_t += I.T[a, v] + I.T[v, b] - I.T[a, b] + I.s[v]
            S.R[k].pop(p)
            S.refresh()
            dropped.append(v)
        routes = local_search(I, [r for r in S.R if r], passes=2)
        trucks, used = pack(I, routes)
    if verbose:
        print(f"    route {I.n} stops: CW {c_cw:,.0f} → LS {c_ls:,.0f} → SA {c_sa:,.0f}  "
              f"{len(routes)} trips, {len(trucks)} trucks, dropped {len(dropped)}  {time.time() - t0:.1f}s")
    return {"routes": routes, "trucks": trucks, "used": used, "dropped": dropped,
            "cost": total_cost(I, routes), "cost_cw": c_cw, "cost_ls": c_ls, "cost_sa": c_sa,
            "km": sum(trip_km(I, r) for r in routes), "seconds": time.time() - t0}


def schedule(I, sol, start_min=0.0):
    """Arrival minute after 06:00 at every stop (instance numbering), truck by truck."""
    arr = {}
    for tr in sol["trucks"]:
        t = start_min
        for k in sorted(tr, key=lambda k: -trip_time(I, sol["routes"][k])):
            r = sol["routes"][k]
            cur = 0
            for v in r:
                t += I.T[cur, v]
                arr[v] = t
                t += I.s[v]
                cur = v
            t += I.T[cur, 0] + I.tip
    return arr
