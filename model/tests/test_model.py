"""Small checks of the maths:  python -m pytest model/tests"""
import itertools

import numpy as np

from model import decide as DC
from model import config as C
from model import simulate as SM
from model import route as RT


def test_deposits_match_the_daily_rate():
    """Bags of 30 L at Poisson times: over the month each stop receives its daily rate on average."""
    rng = np.random.default_rng(0)
    st = {"cap": rng.choice([660.0, 1280.0, 2560.0], 300)}
    X = SM.deposits(st, seed=1)
    days = X.shape[1] / 24
    D = SM.true_rates(st, seed=1)
    assert abs(X.sum() / days / D.sum() - 1) < .02
    assert np.all(np.mod(X, C.BAG_L) == 0)


def _tiny(n=7, seed=1):
    rng = np.random.default_rng(seed)
    xy = rng.uniform(0, 10, (n + 1, 2))
    Dm = np.hypot(*(xy[:, None] - xy[None]).transpose(2, 0, 1)).astype(np.float32)
    return Dm, Dm * 3


def test_routing_is_no_worse_than_brute_force_tsp_bound():
    Dm, Tm = _tiny()
    n = len(Dm) - 1
    I = RT.Instance(np.arange(1, n + 1), np.ones(n), np.zeros(n), Tm, Dm, Q=1e9, tmax=1e9)
    brute = min(RT.trip_cost(I, list(p)) for p in itertools.permutations(range(1, n + 1)))
    assert RT.solve(I, fleet=99, sa_seconds=.3)["cost"] >= brute - 1e-6


def test_choice_fits_budget_takes_fullest_first_and_respects_floor():
    rng = np.random.default_rng(2)
    n = 500
    proj = rng.uniform(40, 160, n)
    tmin, q = rng.uniform(3, 10, n), rng.uniform(500, 3000, n)
    budget = .4 * (tmin.sum() + np.ceil(q.sum() / 60_000) * 25)
    chosen = DC.choose(proj, tmin, q, budget, floor=90)
    assert tmin[chosen].sum() + np.ceil(q[chosen].sum() / 60_000) * 25 <= budget
    assert (proj[chosen] >= 90).all()
    assert proj[chosen].min() >= proj[~chosen & (proj >= 90)].max()      # nobody fuller was left out
