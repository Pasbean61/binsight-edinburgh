"""
Layer 3: probabilistic forecast of every stop, learned only from sensor readings.

1. City-wide shape.  Mean hourly fill increments across all stops follow
        log g_t = β0 + h(hour) + d(weekday) + β_rain · 1[rain ≥ 0.5 mm] + β_temp · (T − 10)
   fitted by least squares, so m_t = exp(h + d + β·weather) is the expected share of a day's
   waste that arrives in hour t (normalised to mean 1/24).
2. Each stop's rate.  Every day gives an observation of litres per "average day",
        o_id = Σ_valid ΔL_it / Σ_valid m_t,
   and the rate is updated by exponential smoothing,  r_i ← (1 − β) r_i + β o_id,  β = 0.3,
   with the smoothed squared relative error  e_i² ← (1 − β) e_i² + β ((o_id − r_i)/r_i)².
   Hours with a collection or a reading at 100 % (censored) are left out.
3. Forecast from now (t0) to t1, in litres added:  μ_L = r_i · Σ_{t0..t1} m_t.
   Its variance has three parts, each with a reason:
        compound Poisson     Var = φ · μ_L            (φ = E[V²]/E[V], estimated from the data)
        rate uncertainty     Var = β/(2 − β) · e_i² · μ_L²   (variance of an EWMA estimate)
        sensor noise         Var = σ_s²
   so the fill forecast is  μ_i = y_i + 100 μ_L / cap_i  and  σ_i² = (100/cap_i)² (φ μ_L + β/(2−β) e_i² μ_L²) + σ_s².
4. Overflow risk before the next chance of a truck:   p_i = 1 − Φ((100 − μ_i) / σ_i).
   (Fill only rises between collections, so reaching 100 % by t1 is the same as overflowing before t1.)
"""
import math

import numpy as np
from scipy.special import ndtr

from . import config as C
from .simulate import clock

BETA = 0.3


class Forecaster:
    def __init__(self, cap, temp, rain):
        self.cap = cap
        self.temp, self.rain = temp, rain
        self.hour, self.wd, _ = clock(len(temp))
        self.coef = None

    # ── 1. city-wide hour, weekday and weather pattern ────────────────────────
    def _valid_increments(self, Y, K, t_end):
        y = Y[:, :t_end]
        d = np.diff(y, axis=1)
        ok = ~K[:, 1:t_end] & (y[:, 1:] < 99) & (y[:, :-1] < 99) & ~np.isnan(d)
        return d, ok

    def fit(self, Y, K, t_end):
        d, ok = self._valid_increments(Y, K, t_end)
        g = np.where(ok, d, 0).sum(0) / np.maximum(ok.sum(0), 1)      # mean % per hour, hours 1..t_end-1
        t = np.arange(1, t_end)
        keep = g > 1e-3
        Xd = [np.ones(len(t))]
        Xd += [(self.hour[t] == h).astype(float) for h in range(1, 24)]
        Xd += [(self.wd[t] == k).astype(float) for k in range(1, 7)]
        Xd += [(self.rain[t] >= .5).astype(float), self.temp[t] - 10]
        X = np.column_stack(Xd)
        b, *_ = np.linalg.lstsq(X[keep], np.log(g[keep]), rcond=None)
        self.coef = b
        self.beta_rain, self.beta_temp = b[-2], b[-1]
        # rates and their errors, one day at a time
        n = Y.shape[0]
        m = self.shape(np.arange(t_end))
        r = np.full(n, np.nan)
        e2 = np.full(n, .25)
        L = d * (self.cap[:, None] / 100)
        for day0 in range(0, t_end - 24, 24):
            sl = slice(day0, day0 + 24)
            okd = ok[:, sl]
            cnt = okd.sum(1)
            mm = (okd * m[1:][sl][None, :]).sum(1)
            obs = np.where(okd, L[:, sl], 0).sum(1) / np.maximum(mm, 1e-9)
            good = (cnt >= 10) & (mm > 0)
            obs = np.maximum(obs, 0)
            first = good & np.isnan(r)
            r[first] = obs[first]
            upd = good & ~first
            rel = (obs[upd] - r[upd]) / np.maximum(r[upd], 1)
            e2[upd] = (1 - BETA) * e2[upd] + BETA * rel ** 2
            r[upd] = (1 - BETA) * r[upd] + BETA * obs[upd]
        r[np.isnan(r)] = np.nanmedian(r)
        self.r, self.e2 = r, e2
        # dispersion φ: variance of hourly litres beyond sensor noise, over the mean
        mu = r[:, None] * m[1:][None, :]
        noise = 2 * (C.SENSOR_NOISE * self.cap[:, None] / 100) ** 2
        resid = np.where(ok, (L - mu) ** 2 - noise, 0)
        self.phi = float(max(5.0, resid.sum() / np.where(ok, mu, 0).sum()))
        return self

    def shape(self, t):
        """m_t: expected share of a day's waste in hour t (mean 1/24 over a typical week)."""
        b = self.coef
        h, w = self.hour[t], self.wd[t]
        lg = np.where(h > 0, b[np.clip(h, 1, 23)], 0) + np.where(w > 0, b[23 + np.clip(w, 1, 6)], 0)
        lg = lg + b[-2] * (self.rain[t] >= .5) + b[-1] * (self.temp[t] - 10)
        base = np.exp(np.r_[0, b[1:24]])[:, None] * np.exp(np.r_[0, b[24:30]])[None, :]
        return np.exp(lg) / (base.mean() * 24)

    # ── 3-4. forecast and overflow probability ────────────────────────────────
    def predict(self, y_now, t0, t1):
        """Fill % forecast at the end of hour t1 given readings y_now at the end of hour t0 − 1."""
        M = self.shape(np.arange(t0, t1 + 1)).sum()
        muL = self.r * M
        mu = y_now + 100 * muL / self.cap
        var = (100 / self.cap) ** 2 * (self.phi * muL + BETA / (2 - BETA) * self.e2 * muL ** 2) + C.SENSOR_NOISE ** 2
        sd = np.sqrt(var)
        p = 1 - ndtr((100 - mu) / sd)
        p = np.where(y_now >= 99, 1.0, p)
        return mu, sd, p

    def days_to_fill(self):
        return np.clip(self.cap / np.maximum(self.r, 1), 1, 30)
