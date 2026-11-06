"""
Layer 5a: how good is the heuristic?

  exact_cvrp()   solves small instances to proven optimality: a two-index MILP with
                 Miller–Tucker–Zemlin load variables, solved by HiGHS (scipy.optimize.milp)

      min  Σ_{i≠j} c_ij x_ij
      s.t. Σ_j x_ij = 1,  Σ_j x_ji = 1                 every stop entered and left once
           Σ_j x_0j = Σ_j x_j0 ≥ ⌈Σ q / Q⌉             trips start and end at the depot
           u_j ≥ u_i + q_j − Q (1 − x_ij)              load grows along a trip (no subtours)
           q_i ≤ u_i ≤ Q,   x_ij ∈ {0, 1}

  lower_bound()  a bound for the full city:  max(Held–Karp 1-tree bound on the TSP through
                 depot and stops, improved by subgradient optimisation;  radial bound 2 Σ q_i c_0i / Q).
                 Any feasible plan costs at least this much, so (plan − bound) / plan bounds the gap.
"""
import math

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import lil_matrix
from scipy.sparse.csgraph import minimum_spanning_tree


def exact_cvrp(Cm, q, Q, time_limit=60):
    n = len(q) - 1                      # nodes 0..n, q[0] = 0
    arcs = [(i, j) for i in range(n + 1) for j in range(n + 1) if i != j]
    na = len(arcs)
    nv = na + n                         # x arcs, then u_1..u_n
    c = np.r_[[Cm[i, j] for i, j in arcs], np.zeros(n)]
    rows, lo, hi = [], [], []
    A = lil_matrix((2 * n + 2 + n * (n - 1), nv))
    r = 0
    for v in range(1, n + 1):          # out-degree and in-degree
        for k, (i, j) in enumerate(arcs):
            if i == v:
                A[r, k] = 1
            if j == v:
                A[r + 1, k] = 1
        lo += [1, 1]; hi += [1, 1]; r += 2
    for k, (i, j) in enumerate(arcs):  # depot balance and minimum trips
        if i == 0:
            A[r, k] = 1; A[r + 1, k] = 1
        if j == 0:
            A[r, k] = -1
    lo += [0, math.ceil(q.sum() / Q)]; hi += [0, n]; r += 2
    for k, (i, j) in enumerate(arcs):  # MTZ
        if i >= 1 and j >= 1:
            A[r, na + j - 1] = 1; A[r, na + i - 1] = -1; A[r, k] = -Q
            lo.append(q[j] - Q); hi.append(np.inf); r += 1
    A = A[:r]
    integrality = np.r_[np.ones(na), np.zeros(n)]
    bounds = Bounds(np.r_[np.zeros(na), q[1:]], np.r_[np.ones(na), np.full(n, Q)])
    res = milp(c, constraints=LinearConstraint(A.tocsr(), lo, hi), integrality=integrality,
               bounds=bounds, options={"time_limit": time_limit, "disp": False})
    if res.x is None:
        return None
    x = res.x[:na] > .5
    succ = {}
    for k, (i, j) in enumerate(arcs):
        if x[k]:
            succ.setdefault(i, []).append(j)
    routes = []
    for start in succ.get(0, []):
        r_, v = [], start
        while v != 0:
            r_.append(v)
            v = succ[v][0]
        routes.append(r_)
    return {"cost": float(res.fun), "routes": routes, "optimal": res.status == 0,
            "gap": float(getattr(res, "mip_gap", 0) or 0)}


def one_tree(Cm, pi):
    """Cost of the minimum 1-tree with node penalties pi, and node degrees."""
    n = len(Cm)
    W = Cm + pi[:, None] + pi[None, :]
    sub = W[1:, 1:].copy()
    np.fill_diagonal(sub, 0)
    sub[sub == 0] = 1e-9
    np.fill_diagonal(sub, 0)
    mst = minimum_spanning_tree(sub).tocoo()
    deg = np.zeros(n)
    np.add.at(deg, mst.row + 1, 1)
    np.add.at(deg, mst.col + 1, 1)
    two = np.argsort(W[0, 1:])[:2] + 1
    deg[0] = 2
    deg[two] += 1
    val = mst.data.sum() + W[0, two].sum() - 2 * pi.sum()
    return val, deg


def held_karp_bound(Cm, ub, iters=120):
    """ub: any tour or plan cost (an upper bound), used for the Polyak step size."""
    n = len(Cm)
    pi = np.zeros(n)
    best = -np.inf
    lam = 2.0
    for k in range(iters):
        val, deg = one_tree(Cm, pi)
        best = max(best, val)
        g = deg - 2
        if not g.any():
            break
        step = lam * (ub - val) / (g @ g)
        pi += step * g
        if k % 15 == 14:
            lam *= 0.5
    return float(best)


def lower_bound(Cm, q, Q, ub):
    radial = 2 * float((q[1:] * Cm[0, 1:]).sum()) / Q
    hk = held_karp_bound(Cm, ub)
    return {"held_karp": hk, "radial": radial, "bound": max(hk, radial)}
