"""Small checks of the maths:  python -m pytest model/tests"""
import itertools

import numpy as np

from model import decide as DC
from model import exact as EX
from model import route as RT


def test_gamma_sum_matches_compound_poisson_moments():
    rng = np.random.default_rng(0)
    lam, k, mean = 3.0, 2.0, 35.0
    N = rng.poisson(lam, 200_000)
    X = np.zeros(len(N))
    m = N > 0
    X[m] = rng.gamma(N[m] * k, mean / k)
    assert abs(X.mean() / (lam * mean) - 1) < .01
    assert abs(X.var() / (lam * mean ** 2 * (1 + 1 / k)) - 1) < .03


def _tiny(n=7, seed=1):
    rng = np.random.default_rng(seed)
    xy = rng.uniform(0, 10, (n + 1, 2))
    Dm = np.hypot(*(xy[:, None] - xy[None]).transpose(2, 0, 1)).astype(np.float32)
    return Dm, Dm * 3


def test_exact_cvrp_matches_brute_force_tsp():
    Dm, Tm = _tiny()
    n = len(Dm) - 1
    I = RT.Instance(np.arange(1, n + 1), np.ones(n), np.zeros(n), Tm, Dm, Q=1e9, tmax=1e9)
    brute = min(RT.trip_cost(I, list(p)) for p in itertools.permutations(range(1, n + 1)))
    ex = EX.exact_cvrp(I.Cm, I.q, float(n), 30)          # Q = total load: one trip is feasible
    assert abs(ex["cost"] - brute) < 1e-6 * brute
    assert RT.solve(I, fleet=99, sa_seconds=.3)["cost"] >= brute - 1e-6
    assert EX.lower_bound(I.Cm, I.q, float(n), brute)["bound"] <= brute + 1e-6


def test_lagrangian_choice_fits_budget_and_keeps_urgent():
    rng = np.random.default_rng(2)
    n = 500
    mand = rng.random(n) < .1
    value, tmin, q = rng.normal(5, 5, n), rng.uniform(3, 10, n), rng.uniform(500, 3000, n)
    budget = .4 * (tmin.sum() + np.ceil(q.sum() / 60_000) * 25)
    chosen, lam = DC.choose(mand, value, tmin, q, budget)
    assert (chosen[mand]).all() and lam > 0
    assert tmin[chosen].sum() + np.ceil(q[chosen].sum() / 60_000) * 25 <= budget
