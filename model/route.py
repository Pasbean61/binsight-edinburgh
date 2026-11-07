"""
Layer 4b: tomorrow's routes. One optimisation model, solved by one algorithm (simulated annealing).

Model: a prize-collecting multi-trip capacitated vehicle-routing problem with a shift limit
--------------------------------------------------------------------------------------------
  N           stops chosen by decide.py;  0 = Seafield depot;  K = trucks (the fleet);  R = trips a truck may make
  d_ij, τ_ij  road km and driving minutes (Dijkstra on OpenStreetMap)
  θ           rain slowdown of driving, θ = 1 + κ · (share of shift hours with rain)        [weather]
  c_ij        = £1.45 · d_ij + £75 · θ τ_ij / 60
  q_i         litres in stop i when the truck arrives, with the weather/holiday factor     [weather, holiday]
  s_i         lifting minutes at stop i;   Q = 60,000 L a load;   H = 480 min a shift;   t_tip = 25 min
  π_i         £ prize for emptying stop i (decide.py: £60 × projected fill / 100; 10⁶ if it must be emptied)

  x_ijkr = 1 if truck k drives i → j on its trip r;   z_ikr = 1 if trip r of truck k empties i;   u_kr = 1 if used

  minimise   Σ_kr Σ_ij c_ij x_ijkr  +  Σ_i π_i (1 − Σ_kr z_ikr)                  driving cost + unserved prizes
  subject to
    (1) Σ_kr z_ikr ≤ 1                                   ∀ i ∈ N      each stop emptied at most once
    (2) Σ_j x_ijkr = Σ_j x_jikr = z_ikr                  ∀ i, k, r    arrive at a stop, leave it
    (3) Σ_j x_0jkr = u_kr                                ∀ k, r       a used trip leaves the depot once
    (4) Σ_i q_i z_ikr ≤ Q u_kr                           ∀ k, r       load       (weather and holidays via q_i)
    (5) Σ_r ( Σ_ij θ τ_ij x_ijkr + Σ_i s_i z_ikr + t_tip u_kr ) ≤ H    ∀ k    shift     (rain via θ)
    (6) no sub-tours (Σ_{i,j∈S} x_ijkr ≤ |S| − 1 for every S ⊆ N)
    x, z, u ∈ {0, 1}

With 1,000+ stops this cannot be solved exactly in minutes, so it is solved by simulated annealing.

Algorithm: simulated annealing
------------------------------
  State     every truck's trips (each a stop sequence), plus the pool of unserved stops.
            Every state satisfies (1)–(6): an infeasible move is never made.
  Start     fill truck after truck, trip after trip, with the nearest stop that still fits.
  Move      pick a stop v and one of its 20 nearest stops w, then one of
              relocate  v next to w (an unserved v is inserted)
              swap      v and w (between trips, or an unserved v replaces w)
              2-opt     reverse the path between v and w (same trip)
              2-opt*    cut both trips after v and after w and reconnect them (different trips)
              drop      v back to the pool
              new trip  v on a new trip of a truck with time left
            and, now and then, hand a whole trip to another truck or let two trucks trade trips
            (no cost change: it gathers spare shift time where a stop can use it).
  Accept    if Δ ≤ 0, or with probability exp(−Δ / T); T cools geometrically from T₀ to T₁ over the time budget.
  Return    the best state seen.
"""
import math
import random
import time

import numpy as np

from . import config as C

REQUIRED = 1e6          # prize of a stop that must be emptied (the timetable)
TEMP0, TEMP1 = 3.0, 0.002   # start and end temperature, as a share of the mean cost of one arc


class Instance:
    def __init__(self, idx, q, svc, T, D, prize=None, Q=C.TRUCK_LOAD_L, tmax=C.SHIFT_MIN, tip=C.TIP_MIN, slow=1.0):
        """idx: matrix rows of the stops (0 = depot). q litres, svc minutes, prize £ per stop.
        slow: θ, the rain slowdown of driving times."""
        self.idx = np.asarray(idx)
        n = len(idx)
        rows = np.r_[0, self.idx]
        T = T[np.ix_(rows, rows)].astype(float)
        D = D[np.ix_(rows, rows)].astype(float)
        self.T = slow * (T + T.T) / 2
        self.D = (D + D.T) / 2
        self.Cm = C.COST_KM * self.D + C.COST_HOUR * self.T / 60
        self.q = np.r_[0, q].astype(float)
        self.s = np.r_[0, svc].astype(float)
        self.prize = np.r_[0, np.full(n, REQUIRED) if prize is None else prize].astype(float)
        self.n, self.slow = n, slow
        self.Q, self.tmax, self.tip = Q, tmax, tip
        k = min(20, n - 1) if n > 1 else 0
        self.nn = np.argsort(self.Cm[1:, 1:], axis=1)[:, 1:k + 1] + 1 if n > 1 else np.zeros((n, 0), int)


# ── trip measures ─────────────────────────────────────────────────────────────
def trip_cost(I, r):
    if not r:
        return 0.0
    return I.Cm[0, r[0]] + I.Cm[r[-1], 0] + sum(I.Cm[a, b] for a, b in zip(r, r[1:]))


def trip_time(I, r):
    if not r:
        return 0.0
    return (I.T[0, r[0]] + I.T[r[-1], 0] + sum(I.T[a, b] for a, b in zip(r, r[1:]))
            + I.s[r].sum() + I.tip)


def trip_km(I, r):
    if not r:
        return 0.0
    return I.D[0, r[0]] + I.D[r[-1], 0] + sum(I.D[a, b] for a, b in zip(r, r[1:]))


# ── the state: trips, their trucks, loads and times ───────────────────────────
class State:
    def __init__(self, I, trips, truck_of, n_trucks):
        self.I = I
        self.R = [list(r) for r in trips]
        self.tk = list(truck_of)
        self.load = [I.q[r].sum() for r in self.R]
        self.tt = [trip_time(I, r) for r in self.R]
        self.ut = [0.0] * n_trucks
        for k, t in enumerate(self.tt):
            self.ut[self.tk[k]] += t
        self.wk = np.full(I.n + 1, -1)          # trip of each stop, −1 if unserved
        self.wp = np.full(I.n + 1, -1)          # position in that trip
        for k in range(len(self.R)):
            self._index(k)
        self.cost = sum(trip_cost(I, r) for r in self.R) + I.prize[1:][self.wk[1:] < 0].sum()

    def _index(self, k):
        for p, v in enumerate(self.R[k]):
            self.wk[v], self.wp[v] = k, p

    def nb(self, k, p):
        r = self.R[k]
        return (r[p - 1] if p > 0 else 0), (r[p + 1] if p + 1 < len(r) else 0)

    def _out(self, v):
        """Δcost, Δminutes of taking v out of its trip (a one-stop trip disappears with its tip)."""
        I, k, p = self.I, self.wk[v], self.wp[v]
        if len(self.R[k]) == 1:
            return -(I.Cm[0, v] + I.Cm[v, 0]), -self.tt[k]
        a, b = self.nb(k, p)
        return I.Cm[a, b] - I.Cm[a, v] - I.Cm[v, b], I.T[a, b] - I.T[a, v] - I.T[v, b] - I.s[v]

    def _in(self, v, a, b, empty):
        """Δcost, Δminutes of putting v between a and b (or alone on an empty trip)."""
        I = self.I
        if empty:
            return I.Cm[0, v] + I.Cm[v, 0], I.T[0, v] + I.T[v, 0] + I.s[v] + I.tip
        return I.Cm[a, v] + I.Cm[v, b] - I.Cm[a, b], I.T[a, v] + I.T[v, b] - I.T[a, b] + I.s[v]

    def _fits(self, changes):
        """changes: {truck: Δminutes}. Constraint (5) for every truck that gets longer."""
        return all(self.ut[b] + d <= self.I.tmax + 1e-9 for b, d in changes.items() if d > 0)

    def _remove(self, v, dt):
        k = self.wk[v]
        b = self.tk[k]
        self.R[k].pop(self.wp[v])
        self.load[k] -= self.I.q[v]
        self.tt[k] += dt
        self.ut[b] += dt
        if not self.R[k]:                        # numerical tidy-up of an emptied trip
            self.ut[b] -= self.tt[k]
            self.tt[k] = 0.0
        self.wk[v] = self.wp[v] = -1
        self._index(k)

    # ── moves: each returns (Δobjective, apply) or None if it breaks a constraint ──
    def relocate(self, v, k2, pos):
        """Put v before position pos of trip k2 (v served elsewhere, served in k2, or unserved)."""
        I = self.I
        k1, r2 = self.wk[v], self.R[k2]
        if k1 == k2:
            p1 = self.wp[v]
            if pos in (p1, p1 + 1):
                return None
            dc0, dt0 = self._out(v)
            pos2 = pos - 1 if pos > p1 else pos
            rest = r2[:p1] + r2[p1 + 1:]
            dc1, dt1 = self._in(v, rest[pos2 - 1] if pos2 > 0 else 0, rest[pos2] if pos2 < len(rest) else 0, False)
            b = self.tk[k1]
            if not self._fits({b: dt0 + dt1}):
                return None

            def go():
                r2.pop(p1)
                r2.insert(pos2, v)
                self.tt[k1] += dt0 + dt1
                self.ut[b] += dt0 + dt1
                self._index(k1)
            return dc0 + dc1, go
        if self.load[k2] + I.q[v] > I.Q:                                    # (4)
            return None
        dc1, dt1 = self._in(v, r2[pos - 1] if pos > 0 else 0, r2[pos] if pos < len(r2) else 0, not r2)
        b2 = self.tk[k2]
        if k1 >= 0:
            dc0, dt0 = self._out(v)
            b1 = self.tk[k1]
            ch = {b2: dt0 + dt1} if b1 == b2 else {b2: dt1}
        else:
            dc0, dt0 = -I.prize[v], 0.0                                     # an unserved stop comes in
            ch = {b2: dt1}
        if not self._fits(ch):
            return None

        def go():
            if self.wk[v] >= 0:
                self._remove(v, dt0)
            r2.insert(pos, v)
            self.load[k2] += I.q[v]
            self.tt[k2] += dt1
            self.ut[b2] += dt1
            self._index(k2)
        return dc0 + dc1, go

    def swap(self, u, v):
        """u served; v served on another trip, or unserved (then v takes u's place and u is unserved)."""
        I = self.I
        ku, pu, kv = self.wk[u], self.wp[u], self.wk[v]
        if ku < 0 or ku == kv or self.load[ku] - I.q[u] + I.q[v] > I.Q:
            return None
        a, b = self.nb(ku, pu)
        dcu = I.Cm[a, v] + I.Cm[v, b] - I.Cm[a, u] - I.Cm[u, b]
        dtu = I.T[a, v] + I.T[v, b] - I.T[a, u] - I.T[u, b] + I.s[v] - I.s[u]
        bu = self.tk[ku]
        if kv < 0:
            if not self._fits({bu: dtu}):
                return None

            def go():
                self.R[ku][pu] = v
                self.load[ku] += I.q[v] - I.q[u]
                self.tt[ku] += dtu
                self.ut[bu] += dtu
                self.wk[v], self.wp[v] = ku, pu
                self.wk[u] = self.wp[u] = -1
            return dcu - I.prize[v] + I.prize[u], go
        pv = self.wp[v]
        if self.load[kv] - I.q[v] + I.q[u] > I.Q:
            return None
        c, d = self.nb(kv, pv)
        dcv = I.Cm[c, u] + I.Cm[u, d] - I.Cm[c, v] - I.Cm[v, d]
        dtv = I.T[c, u] + I.T[u, d] - I.T[c, v] - I.T[v, d] + I.s[u] - I.s[v]
        bv = self.tk[kv]
        if not self._fits({bu: dtu + dtv} if bu == bv else {bu: dtu, bv: dtv}):
            return None

        def go():
            self.R[ku][pu], self.R[kv][pv] = v, u
            self.load[ku] += I.q[v] - I.q[u]
            self.load[kv] += I.q[u] - I.q[v]
            self.tt[ku] += dtu
            self.tt[kv] += dtv
            self.ut[bu] += dtu
            self.ut[bv] += dtv
            self.wk[v], self.wp[v], self.wk[u], self.wp[u] = ku, pu, kv, pv
        return dcu + dcv, go

    def two_opt(self, u, v):
        """Reverse the path from u to v inside their trip."""
        I, k = self.I, self.wk[u]
        if k < 0 or k != self.wk[v]:
            return None
        i, j = sorted((self.wp[u], self.wp[v]))
        r = self.R[k]
        a = r[i - 1] if i > 0 else 0
        b = r[j + 1] if j + 1 < len(r) else 0
        dc = I.Cm[a, r[j]] + I.Cm[r[i], b] - I.Cm[a, r[i]] - I.Cm[r[j], b]
        dt = I.T[a, r[j]] + I.T[r[i], b] - I.T[a, r[i]] - I.T[r[j], b]
        bk = self.tk[k]
        if not self._fits({bk: dt}):
            return None

        def go():
            r[i:j + 1] = r[i:j + 1][::-1]
            self.tt[k] += dt
            self.ut[bk] += dt
            self._index(k)
        return dc, go

    def two_opt_star(self, u, v, cross):
        """u and v on different trips: cut after u and after v and reconnect.
        cross=False: u → (what followed v), v → (what followed u)        (trade tails)
        cross=True:  u → v, then v's trip backwards; (what followed u) → (what followed v)"""
        I = self.I
        k1, k2 = self.wk[u], self.wk[v]
        if k1 < 0 or k2 < 0 or k1 == k2:
            return None
        r1, r2 = self.R[k1], self.R[k2]
        p1, p2 = self.wp[u], self.wp[v]
        n1 = r1[p1 + 1] if p1 + 1 < len(r1) else 0
        n2 = r2[p2 + 1] if p2 + 1 < len(r2) else 0
        if cross:
            dc = I.Cm[u, v] + I.Cm[n1, n2] - I.Cm[u, n1] - I.Cm[v, n2]
            A, B = r1[:p1 + 1] + r2[:p2 + 1][::-1], r1[p1 + 1:][::-1] + r2[p2 + 1:]
        else:
            dc = I.Cm[u, n2] + I.Cm[v, n1] - I.Cm[u, n1] - I.Cm[v, n2]
            A, B = r1[:p1 + 1] + r2[p2 + 1:], r2[:p2 + 1] + r1[p1 + 1:]
        lA, lB = I.q[A].sum(), I.q[B].sum()
        if lA > I.Q or lB > I.Q:                                             # (4)
            return None
        tA, tB = trip_time(I, A), trip_time(I, B)
        b1, b2 = self.tk[k1], self.tk[k2]
        d1, d2 = tA - self.tt[k1], tB - self.tt[k2]
        if not self._fits({b1: d1 + d2} if b1 == b2 else {b1: d1, b2: d2}):  # (5)
            return None

        def go():
            self.R[k1], self.R[k2] = A, B
            self.load[k1], self.load[k2] = lA, lB
            self.tt[k1], self.tt[k2] = tA, tB
            self.ut[b1] += d1
            self.ut[b2] += d2
            self._index(k1)
            self._index(k2)
        return dc, go

    def drop(self, v):
        if self.wk[v] < 0:
            return None
        dc, dt = self._out(v)
        return dc + self.I.prize[v], lambda: self._remove(v, dt)

    def new_trip(self, v, b):
        """v alone on a new trip of truck b."""
        return self.relocate(v, self._empty_trip(b), 0)

    def _empty_trip(self, b):
        for k, r in enumerate(self.R):
            if not r and self.tk[k] == b:
                return k
        self.R.append([])
        self.tk.append(b)
        self.load.append(0.0)
        self.tt.append(0.0)
        return len(self.R) - 1

    def move_trip(self, k, b):
        """Hand trip k to truck b: no cost change, frees time on its old truck."""
        b0 = self.tk[k]
        if b == b0 or not self.R[k] or self.ut[b] + self.tt[k] > self.I.tmax:
            return None

        def go():
            self.ut[b0] -= self.tt[k]
            self.ut[b] += self.tt[k]
            self.tk[k] = b
        return 0.0, go

    def swap_trips(self, k1, k2):
        """Trucks of trips k1 and k2 trade them: no cost change, gathers spare time on one truck."""
        b1, b2 = self.tk[k1], self.tk[k2]
        d = self.tt[k2] - self.tt[k1]
        if b1 == b2 or self.ut[b1] + d > self.I.tmax or self.ut[b2] - d > self.I.tmax:
            return None

        def go():
            self.ut[b1] += d
            self.ut[b2] -= d
            self.tk[k1], self.tk[k2] = b2, b1
        return 0.0, go

    def snapshot(self):
        return [list(r) for r in self.R], list(self.tk)


# ── start: fill truck after truck with the nearest stop that still fits ──────
def initial(I, fleet):
    """fleet=None opens trucks until every stop is served."""
    left = np.ones(I.n + 1, bool)
    left[0] = False
    back = I.T[:, 0]
    trips, truck_of = [], []
    b = 0
    while left.any() and (fleet is None or b < fleet):
        used, opened = 0.0, len(trips)
        while left.any():
            r, load, cur, t = [], 0.0, 0, I.tip
            while True:
                ok = left & (load + I.q <= I.Q) & (used + t + I.T[cur] + I.s + back <= I.tmax)
                if not ok.any():
                    break
                cand = np.flatnonzero(ok)
                j = int(cand[np.argmin(I.Cm[cur, cand])])
                t += I.T[cur, j] + I.s[j]
                load += I.q[j]
                r.append(j)
                left[j] = False
                cur = j
            if not r:
                break
            trips.append(r)
            truck_of.append(b)
            used += t + I.T[cur, 0]
        if len(trips) == opened:              # nothing fits even an empty truck
            if fleet is not None:
                break
            j = int(np.flatnonzero(left)[0])  # serve it alone anyway
            trips.append([j])
            truck_of.append(b)
            left[j] = False
        b += 1
    return trips, truck_of, max(b if fleet is None else fleet, 1)


# ── simulated annealing ──────────────────────────────────────────────────────
def solve(I, fleet=C.FLEET, seconds=10.0, seed=0, verbose=False):
    """Solve the model above. fleet=None: as many trucks as the start needs (sizes the timetable's fleet)."""
    t0 = time.time()
    rng = random.Random(seed)
    n = I.n
    trips, truck_of, n_trucks = initial(I, fleet)
    cost_start = sum(trip_cost(I, r) for r in trips)
    dropped_start = n - sum(len(r) for r in trips)
    S = State(I, trips, truck_of, n_trucks)
    arc = np.mean([trip_cost(I, r) / (len(r) + 1) for r in S.R]) if S.R else 1.0
    T0, T1 = TEMP0 * arc, TEMP1 * arc                      # start and end temperature, £
    cur = best = S.cost
    keep = S.snapshot()
    it = 0
    k_nn = I.nn.shape[1]
    while n >= 2 and k_nn:
        el = (time.time() - t0) / seconds
        if el >= 1:
            break
        temp = T0 * (T1 / T0) ** el
        for _ in range(500):
            it += 1
            v = rng.randint(1, n)
            w = int(I.nn[v - 1, rng.randrange(k_nn)])
            m = rng.random()
            if m < .02:
                k = rng.randrange(len(S.R))
                mv = (S.move_trip(k, rng.randrange(n_trucks)) if m < .01
                      else S.swap_trips(k, rng.randrange(len(S.R))))
            elif S.wk[v] < 0:                                   # v unserved: try to bring it in
                if S.wk[w] < 0:
                    mv = S.new_trip(v, rng.randrange(n_trucks)) if m < .1 else None
                elif m < .6:
                    mv = S.relocate(v, S.wk[w], S.wp[w] + rng.randint(0, 1))
                else:
                    mv = S.swap(w, v)
            elif S.wk[w] < 0:                                   # w unserved: v makes way for it
                mv = S.swap(v, w)
            elif m < .35:
                mv = S.relocate(v, S.wk[w], S.wp[w] + rng.randint(0, 1))
            elif m < .55:
                mv = S.swap(v, w)
            elif m < .95:
                mv = S.two_opt(v, w) if S.wk[v] == S.wk[w] else S.two_opt_star(v, w, m < .75)
            elif m < .97:
                mv = S.drop(v)
            else:
                mv = S.new_trip(v, rng.randrange(n_trucks))
            if mv is None:
                continue
            d, go = mv
            if d <= 0 or rng.random() < math.exp(-d / temp):
                go()
                cur += d
                if cur < best - 1e-6:
                    best = cur
                    if el > .5:                                 # copying is O(n): only once it matters
                        keep = S.snapshot()
    if cur <= best + 1e-6:
        keep = S.snapshot()
    R, tk = keep
    routes, owner = [], []
    for r, b in zip(R, tk):
        if r:
            routes.append(r)
            owner.append(b)
    trucks = [[k for k, b in enumerate(owner) if b == bb] for bb in sorted(set(owner))]
    used = [sum(trip_time(I, routes[k]) for k in tr) for tr in trucks]
    served = {v for r in routes for v in r}
    dropped = [v for v in range(1, n + 1) if v not in served]
    cost = sum(trip_cost(I, r) for r in routes)
    if verbose:
        print(f"    route {n} stops: start £{cost_start:,.0f} ({dropped_start} unserved) → annealed £{cost:,.0f} "
              f"({len(dropped)} unserved), {len(routes)} trips on {len(trucks)} trucks, {it:,} moves, "
              f"{time.time() - t0:.1f}s")
    return {"routes": routes, "trucks": trucks, "used": used, "dropped": dropped, "cost": cost,
            "cost_start": cost_start, "dropped_start": dropped_start,
            "km": sum(trip_km(I, r) for r in routes), "seconds": time.time() - t0, "iterations": it}


def schedule(I, sol, start_min=0.0):
    """Arrival minute after 06:00 at every stop (instance numbering), truck by truck."""
    arr = {}
    for tr in sol["trucks"]:
        t = start_min
        for k in sorted(tr, key=lambda k: -trip_time(I, sol["routes"][k])):
            cur = 0
            for v in sol["routes"][k]:
                t += I.T[cur, v]
                arr[v] = t
                t += I.s[v]
                cur = v
            t += I.T[cur, 0] + I.tip
    return arr
