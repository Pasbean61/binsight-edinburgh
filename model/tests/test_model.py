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


def test_annealing_finds_the_brute_force_optimum_of_a_small_tour():
    Dm, Tm = _tiny()
    n = len(Dm) - 1
    I = RT.Instance(np.arange(1, n + 1), np.ones(n), np.zeros(n), Tm, Dm, Q=1e9, tmax=1e9)
    brute = min(RT.trip_cost(I, list(p)) for p in itertools.permutations(range(1, n + 1)))
    assert abs(RT.solve(I, fleet=1, seconds=.5)["cost"] - brute) < 1e-6


def _check(I, sol, fleet):
    served = [v for r in sol["routes"] for v in r]
    assert len(served) == len(set(served))                                       # (1) at most once
    assert sorted(served + sol["dropped"]) == list(range(1, I.n + 1))
    assert all(I.q[r].sum() <= I.Q + 1e-6 for r in sol["routes"])                # (4) load
    assert all(sum(RT.trip_time(I, sol["routes"][k]) for k in tr) <= I.tmax + 1e-6 for tr in sol["trucks"])  # (5)
    assert len(sol["trucks"]) <= fleet


def test_annealing_respects_load_shift_and_fleet():
    rng = np.random.default_rng(3)
    n = 120
    Dm, Tm = _tiny(n, seed=3)
    I = RT.Instance(np.arange(1, n + 1), rng.uniform(500, 2500, n), np.full(n, 3.0), Tm, Dm,
                    prize=np.full(n, 60.0), Q=12_000, tmax=240)
    sol = RT.solve(I, fleet=3, seconds=1.0)
    _check(I, sol, 3)
    # all prizes are equal, so the objective is cost + 60 × unserved; annealing never ends worse than its start
    assert sol["cost"] + 60 * len(sol["dropped"]) <= sol["cost_start"] + 60 * sol["dropped_start"] + 1e-6


def test_rain_slows_the_trucks_and_fewer_stops_fit():
    rng = np.random.default_rng(4)
    n = 150
    Dm, Tm = _tiny(n, seed=4)
    q, svc, prize = rng.uniform(500, 2500, n), np.full(n, 3.0), np.full(n, 60.0)
    dry = RT.Instance(np.arange(1, n + 1), q, svc, Tm, Dm, prize=prize, Q=20_000, tmax=200)
    wet = RT.Instance(np.arange(1, n + 1), q, svc, Tm, Dm, prize=prize, Q=20_000, tmax=200, slow=1.3)
    a, b = RT.solve(dry, fleet=2, seconds=1.0), RT.solve(wet, fleet=2, seconds=1.0)
    _check(wet, b, 2)
    assert len(b["dropped"]) >= len(a["dropped"])


def test_required_stops_are_all_served_without_a_fleet_limit():
    rng = np.random.default_rng(5)
    n = 80
    Dm, Tm = _tiny(n, seed=5)
    I = RT.Instance(np.arange(1, n + 1), rng.uniform(500, 2500, n), np.full(n, 3.0), Tm, Dm, Q=15_000, tmax=240)
    sol = RT.solve(I, fleet=None, seconds=.5)
    assert not sol["dropped"]
    _check(I, sol, 99)


def test_weather_and_holiday_factor_has_mean_one_and_the_right_signs():
    w = SM.factor()
    temp, rain = SM.weather()
    hol = SM.holidays()
    assert abs(w.mean() - 1) < 1e-9
    base = (1 + C.TEMP_EFFECT * (temp - 10))
    ratio = w / base
    assert ratio[(rain >= .5) & ~hol].max() < ratio[(rain < .5) & ~hol].min()        # rain lowers deposits
    if hol.any():
        assert ratio[(rain < .5) & hol].min() > ratio[(rain < .5) & ~hol].max()     # holidays raise them


def test_demand_grows_with_the_factor_and_never_passes_capacity():
    st = {"cap": np.array([1000.0, 1000.0, 2000.0])}
    y = np.array([20.0, 60.0, 99.0])
    last = np.array([100, 100, 100])
    q = DC.demand(st, y, last, 125)
    assert np.all(q >= st["cap"] * y / 100 - 1e-9) and np.all(q <= st["cap"])


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
