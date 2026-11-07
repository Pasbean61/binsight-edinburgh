"""
Layer 1: how communal bins fill (the council does not publish sensor data, so this is simulated).

How fast each stop fills comes from how the council runs the service:
communal general-waste bins are emptied every K = 2 days (City of Edinburgh Council), so a stop's
capacity is sized for about K days of its households' waste. If a stop is on average a share U full
when the truck comes, it fills a share

    ρ_i = U / K · e^{σ Z_i},   Z_i ~ N(0, 1)

of its capacity a day. σ spreads the stops (some serve more flats than others). U is calibrated
(calibrate.py): on the council's every-K-days timetable, overflows match the reported complaint rate.

Households drop one kitchen-bin bag (30 L) at a time. In hour t stop i receives

    N_it ~ Poisson(λ_it),   X_it = 30 L · N_it,   λ_it = (D_i / 30 L) · a(hour) · w_t / 24,   D_i = cap_i · ρ_i

where a is an hour-of-day profile with mean 1 (quiet at night, morning and evening peaks) and w_t the
weather and holiday factor (factor(), mean 1 over the month):

    w_t ∝ exp(β_rain · 1[rain ≥ 0.5 mm]) · (1 + β_temp · (T − 10 °C)) · (1 + β_hol · 1[holiday])

The weather and the holidays are real; the sizes β are assumptions (config.py). The same factor
enters the route model's load constraint (decide.demand).

Fill in litres F_it grows by X_it; at or above capacity the bin overflows. A truck empties it.
Sensors report min(100, 100·F/cap) + N(0, σ_s²) percentage points.
"""
import csv
import datetime as dt

import numpy as np

from . import config as C

HOUR_W = np.array([.25, .15, .1, .1, .12, .3, .7, 1.5, 1.7, 1.3, 1.05, 1.0,
                   1.05, 1.0, .95, .95, 1.1, 1.5, 1.8, 1.7, 1.4, 1.05, .7, .45])


def clock(hours=C.HOURS):
    ts = [C.HISTORY_START + dt.timedelta(hours=h) for h in range(hours)]
    return np.array([t.hour for t in ts]), np.array([t.weekday() for t in ts]), ts


def weather(hours=C.HOURS):
    rows = {r["time_local"]: r for r in csv.DictReader(open(C.WEATHER_CSV))}
    _, _, ts = clock(hours)
    temp = np.array([float(rows[t.strftime("%Y-%m-%dT%H:%M")]["temperature_c"]) for t in ts])
    rain = np.array([float(rows[t.strftime("%Y-%m-%dT%H:%M")]["precipitation_mm"]) for t in ts])
    return temp, rain


def holidays(hours=C.HOURS):
    """True for every hour on a council public holiday or school holiday (a forecast input)."""
    days = set(dt.date.fromisoformat(d) for d in C.PUBLIC_HOLIDAYS)
    for a, b in C.SCHOOL_HOLIDAYS:
        d, end = dt.date.fromisoformat(a), dt.date.fromisoformat(b)
        while d <= end:
            days.add(d)
            d += dt.timedelta(days=1)
    _, _, ts = clock(hours)
    return np.array([t.date() in days for t in ts])


def profile():
    return HOUR_W / HOUR_W.mean()


def factor(hours=C.HOURS):
    """w_t, the weather and holiday multiplier of hourly deposits, rescaled to mean 1.

    w_t = exp(β_rain · 1[rain ≥ 0.5 mm]) · (1 + β_temp · (T − 10 °C)) · (1 + β_hol · 1[holiday])"""
    temp, rain = weather(hours)
    w = (np.exp(C.RAIN_EFFECT * (rain >= .5)) * (1 + C.TEMP_EFFECT * (temp - 10))
         * (1 + C.HOLIDAY_EFFECT * holidays(hours)))
    return w / w.mean()


def true_rates(st, seed, U=None):
    """Litres a day at every stop: cap · U/K · lognormal spread."""
    U = C.FILL_AT_COLLECTION if U is None else U
    rng = np.random.default_rng(1000 + seed)
    rho = U / C.COLLECT_EVERY_DAYS * np.exp(C.DAILY_FILL_SPREAD * rng.standard_normal(len(st["cap"])))
    return st["cap"] * np.clip(rho, .03, 1.0)


def deposits(st, seed, hours=C.HOURS, U=None):
    """Litres deposited at every stop in every hour: array (stops, hours)."""
    rng = np.random.default_rng(seed)
    hour, _, _ = clock(hours)
    a = profile()[hour] * factor(hours)
    lam = (true_rates(st, seed, U) / C.BAG_L)[:, None] * a[None, :] / 24
    return (C.BAG_L * rng.poisson(lam)).astype(np.float32)


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
