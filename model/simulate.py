"""
Layer 2: how communal bins fill (the council does not publish sensor data, so this is simulated).

Each stop i receives household deposits as a compound Poisson process. In hour t

    N_it ~ Poisson(λ_it),     V ~ Gamma(k, θ) per deposit,     X_it = V_1 + … + V_N   (litres)
    λ_it = (D_i / v̄) · a(hour, weekday) · w_t · c_it / 24

  D_i   litres a day at stop i:  D_i = cap_i · ρ_i,  ρ_i ~ LogNormal(log 0.27, 0.35)
  a     hour-of-week profile, mean 1 (morning and evening peaks, busier weekends)
  w_t   real Edinburgh weather:  exp(−0.15 · 1[rain ≥ 0.5 mm]) · (1 + 0.01 (T − 10 °C))
  c_it  1.25 on Friday–Sunday in the City Centre ward (visitors and short lets), else 1

A sum of N gamma(k, θ) volumes is gamma(N·k, θ), which makes the simulation one vectorised draw.
Fill in litres F_it grows by X_it; at or above capacity the bin overflows. A truck empties it.
Sensors report min(100, 100·F/cap) + N(0, 1.5²) percentage points.
"""
import csv
import datetime as dt

import numpy as np

from . import config as C

HOUR_W = np.array([.25, .15, .1, .1, .12, .3, .7, 1.5, 1.7, 1.3, 1.05, 1.0,
                   1.05, 1.0, .95, .95, 1.1, 1.5, 1.8, 1.7, 1.4, 1.05, .7, .45])
DAY_W = np.array([1.05, .95, .95, .95, 1.0, 1.1, 1.15])        # Monday … Sunday


def clock(hours=C.HOURS):
    ts = [C.HISTORY_START + dt.timedelta(hours=h) for h in range(hours)]
    return np.array([t.hour for t in ts]), np.array([t.weekday() for t in ts]), ts


def weather(hours=C.HOURS):
    rows = {r["time_local"]: r for r in csv.DictReader(open(C.WEATHER_CSV))}
    _, _, ts = clock(hours)
    temp = np.array([float(rows[t.strftime("%Y-%m-%dT%H:%M")]["temperature_c"]) for t in ts])
    rain = np.array([float(rows[t.strftime("%Y-%m-%dT%H:%M")]["precipitation_mm"]) for t in ts])
    return temp, rain


def profile():
    a = np.outer(DAY_W, HOUR_W).ravel()        # index = weekday * 24 + hour
    return a / a.mean()


def true_rates(st, seed):
    rng = np.random.default_rng(1000 + seed)
    rho = np.clip(C.DAILY_FILL_MEDIAN * np.exp(C.DAILY_FILL_SPREAD * rng.standard_normal(len(st["cap"]))), .07, .9)
    return st["cap"] * rho


def deposits(st, seed, hours=C.HOURS):
    """Litres deposited at every stop in every hour: array (stops, hours)."""
    rng = np.random.default_rng(seed)
    hour, wd, _ = clock(hours)
    temp, rain = weather(hours)
    a = profile()[wd * 24 + hour]
    w = np.exp(C.RAIN_EFFECT * (rain >= .5)) * (1 + C.TEMP_EFFECT * (temp - 10))
    centre = np.array([w_["name"] == "City Centre" for w_ in st["wards"]])[st["ward"]]
    c = np.where(centre[:, None] & (wd[None, :] >= 4), C.WEEKEND_CENTRE, 1.0)
    D = true_rates(st, seed)
    lam = (D / C.BAG_L)[:, None] * (a * w)[None, :] * c / 24
    N = rng.poisson(lam)
    X = np.zeros(N.shape, np.float32)
    m = N > 0
    X[m] = rng.gamma(N[m] * C.BAG_SHAPE, C.BAG_L / C.BAG_SHAPE)
    return X


class Bins:
    """True state of every stop; advances one hour at a time."""

    def __init__(self, st, X, seed, F0=None):
        self.cap = st["cap"]
        self.X = X
        self.rng = np.random.default_rng(50_000 + seed)
        n, H = X.shape
        self.F = np.zeros(n) if F0 is None else F0.copy()
        self.Y = np.full((n, H), np.nan, np.float32)      # sensor readings, %
        self.K = np.zeros((n, H), bool)                   # collected in this hour
        self.over_h = np.zeros(H)                         # stops at or over capacity, per hour
        self.over_events = np.zeros(H)                    # stops that reached capacity in this hour
        self.P = np.zeros((n, H), np.float32)             # true fill %, capped at 100, end of hour
        self.coll = []                                    # (hour, stop, true fill % when emptied)
        self.last = np.full(n, -1)

    def hour(self, t, empty=()):
        before = self.F >= self.cap
        self.F += self.X[:, t]
        now = self.F >= self.cap
        self.over_events[t] = (now & ~before).sum()
        self.over_h[t] = now.sum()
        e = np.asarray(empty, int)
        if len(e):
            for i, f in zip(e, np.minimum(100, 100 * self.F[e] / self.cap[e])):
                self.coll.append((t, int(i), float(f)))
            self.F[e] = 0
            self.K[e, t] = True
            self.last[e] = t
        self.P[:, t] = np.minimum(100, 100 * self.F / self.cap)
        y = self.P[:, t] + C.SENSOR_NOISE * self.rng.standard_normal(len(self.F))
        self.Y[:, t] = np.clip(np.round(y, 1), 0, 100)
