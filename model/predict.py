"""
Layer 3: one random forest that predicts how full every stop will be.

Every morning it predicts, for every stop, how many percentage points it will gain per hour over the
next day. From that, the projected fill at the next chance of a truck (14:00 tomorrow) is

    ŷ_i = y_i + ĝ_i · hours

which can pass 100 %: a stop projected at 130 % is expected to overflow well before then. The
decision layer (decide.py) empties the stops with the highest ŷ_i that the fleet can reach.

Features (only what a real system would have: sensor readings, the clock and the weather forecast)
  fill         latest reading, %
  rate         % a day since the stop was last emptied (over the last 24 h if it never was)
  d24          change over the last 24 h, % (= rate when a truck came in between)
  hours_since  hours since the stop was last emptied (capped at 240)
  cap          capacity, litres
  weekday      day of the week of the decision
  rain_h       hours with ≥ 0.5 mm of rain before the next chance of a truck
  temp         mean temperature over the same hours, °C
  holiday      share of the same hours on a council public or school holiday

Target: the reading 24 hours later minus the reading now, divided by 24, on mornings when no truck
emptied the stop in between. Training rows are every past morning whose next day is already known.

Why regression and not a classifier of "will it overflow?": with a fleet that cannot reach every
stop at risk, the order among the stops at risk decides who waits. A classifier gives hundreds of
them the same p ≈ 1; the projected fill still tells a stop that fills in two hours from one that
fills in thirty. (On the simulator, ranking by a classifier's p overflowed about 50 % more.)
"""
import numpy as np
from sklearn.ensemble import RandomForestRegressor

from . import config as C
from .simulate import clock, holidays

FEATURES = ["fill", "rate", "d24", "hours_since", "cap", "weekday", "rain_h", "temp", "holiday"]


def last_collection(K):
    """L[i, t] = last hour ≤ t in which stop i was emptied, −1 if never."""
    H = K.shape[1]
    return np.maximum.accumulate(np.where(K, np.arange(H)[None, :], -1), axis=1)


class FillForest:
    def __init__(self, st, temp, rain, horizon=C.HORIZON_H, trees=100, seed=0):
        self.cap = st["cap"]
        self.temp, self.rain = temp, rain
        self.hol = holidays(len(temp)).astype(float)
        _, self.wd, _ = clock(len(temp))
        self.horizon = horizon
        self.rf = RandomForestRegressor(n_estimators=trees, n_jobs=1, random_state=seed)   # library defaults

    # ── features at a decision hour t (readings up to t − 1) ─────────────────
    def features(self, Y, Lc, t):
        y = Y[:, t - 1].astype(float)
        last = Lc[:, t - 1]
        hs = np.where(last >= 0, t - 1 - last, 240).clip(0, 240).astype(float)
        d24 = y - Y[:, t - 25] if t >= 25 else np.full(len(y), np.nan)
        d24 = np.where(last > t - 25, np.nan, d24)                     # a truck came inside the 24 h
        rate = np.where((last >= 0) & (hs >= 3), y / np.maximum(hs, 1) * 24, np.clip(d24, 0, None))
        rate = np.where(np.isnan(rate), np.nanmedian(rate), rate)
        d24 = np.where(np.isnan(d24), rate, d24)
        t1 = min(t + 1 + self.horizon, len(self.temp) - 1)
        rain_h = float((self.rain[t:t1 + 1] >= .5).sum())
        temp = float(self.temp[t:t1 + 1].mean())
        hol = float(self.hol[t:t1 + 1].mean())
        n = len(y)
        return np.column_stack([y, rate, d24, hs, self.cap, np.full(n, self.wd[t]), np.full(n, rain_h),
                                np.full(n, temp), np.full(n, hol)])

    def fit(self, Y, K, t_now, first_day=1):
        """Train on every past morning (05:00) whose next 24 hours are already observed."""
        Lc = last_collection(K)
        Xs, ys = [], []
        day = first_day
        while True:
            t = day * 24 + C.SHIFT_START_H - 1
            if t + 24 > t_now:
                break
            X = self.features(Y, Lc, t)
            keep = ~K[:, t:t + 24].any(1)
            Xs.append(X[keep])
            ys.append((Y[keep, t + 23] - Y[keep, t - 1]) / 24)
            day += 1
        X, g = np.vstack(Xs), np.concatenate(ys)
        self.rf.fit(X, g)
        self.n_train = len(g)
        return self

    def predict(self, Y, K, t, t1=None):
        """Projected fill (%) at the end of hour t1 for every stop, from readings up to t − 1."""
        t1 = t + 1 + self.horizon if t1 is None else t1
        X = self.features(Y, last_collection(K[:, :t]), t)
        self.gain = np.clip(self.rf.predict(X), 0, None)               # % an hour
        self.fill = X[:, 0]
        return X[:, 0] + self.gain * (t1 - t + 1)

    def importance(self):
        return dict(zip(FEATURES, np.round(self.rf.feature_importances_, 4).tolist()))
