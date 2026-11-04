"""
Shared, vectorised experiment engine for experiment_runner.py and sensitivity_analysis.py.

Same protocol as EcoBin's runner: replay test-period days drawn at random, let each strategy
choose bins at 00:00 from its own fill state, route them with the CVRP solver, reset collected
bins to 2-10 %, then add that day's hourly waste and count overflow (>= 80 %) events and
bin-hours. EcoBin looped over bins in Python and filtered a DataFrame per bin per day, which
does not scale past ~100 bins; here every step works on numpy arrays.
"""
import json
import os
import pickle
from dataclasses import dataclass, field
from typing import Callable, Dict

import numpy as np
import pandas as pd

from config import city
from database.db import SessionLocal
from database.models import Bin, Truck
from ml.forecasting.models import get_historical_dataframe, train_test_split_time
from ml.preprocessing.features import build_features
from optimization.vrp_solver.solver import simulate_fixed_schedule, solve_cvrp

CONFIGS = {
    "smoke": {"days": 2, "seeds": 1},
    "development": {"days": 7, "seeds": 2},
    "validation": {"days": 30, "seeds": 5},
    "publication": {"days": 90, "seeds": 10},
}
MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "ml", "models")
EXP_DIR = os.path.join(os.path.dirname(__file__), "..", "experiments", "results")
FIXED = "FIXED_ROTATION"   # marker selector for the fixed 3-day schedule


@dataclass
class Scenario:
    bins: pd.DataFrame                    # sorted by bin_id
    fleet: list
    depot: dict
    rmse: float
    dates: list
    start_fill: Dict = field(default_factory=dict)   # date -> (n,) fill at 00:00
    pred: Dict = field(default_factory=dict)         # date -> (n,) XGBoost 24h forecast
    waste: Dict = field(default_factory=dict)        # date -> (n, 24) litres per hour

    @property
    def cap(self):
        return self.bins["capacity"].to_numpy(dtype=float)


def overflow_prob(pred: np.ndarray, rmse: float, threshold: float = 80.0) -> np.ndarray:
    from scipy.stats import norm
    return 1.0 - norm.cdf(threshold, loc=pred, scale=rmse)


def load_scenario() -> Scenario:
    with open(os.path.join(MODEL_DIR, "xgb_model.pkl"), "rb") as f:
        model = pickle.load(f)
    with open(os.path.join(MODEL_DIR, "model_metadata.json")) as f:
        meta = json.load(f)

    db = SessionLocal()
    bins = pd.DataFrame([{"bin_id": b.bin_id, "latitude": b.latitude, "longitude": b.longitude,
                          "capacity": b.capacity, "area_type": b.area_type} for b in db.query(Bin).all()])
    fleet = [{"truck_id": t.truck_id, "capacity": t.capacity, "driver": t.driver} for t in db.query(Truck).all()]
    db.close()
    bins = bins.sort_values("bin_id").reset_index(drop=True)
    order = pd.Index(bins["bin_id"])

    feats = build_features(get_historical_dataframe(), is_training=False)
    feats = pd.concat([feats, pd.get_dummies(feats["area_type"], prefix="area")], axis=1)
    for c in meta["features"]:
        if c not in feats:
            feats[c] = 0
    test = feats[feats["timestamp"] >= train_test_split_time(feats["timestamp"])].copy()
    test["date"] = test["timestamp"].dt.date

    sc = Scenario(bins=bins, fleet=fleet, depot={"latitude": city.DEPOT["latitude"],
                  "longitude": city.DEPOT["longitude"]}, rmse=float(meta["rmse"]), dates=[])
    starts = test[test["timestamp"].dt.hour == 0].copy()
    starts["pred"] = np.clip(model.predict(starts[meta["features"]]), 0.0, 100.0)
    for d, day in test.groupby("date"):
        s = starts[starts["date"] == d].set_index("bin_id").reindex(order)
        if s["fill_percentage"].isna().any() or day["timestamp"].dt.hour.nunique() < 24:
            continue                                   # incomplete day
        w = day.pivot_table(index="bin_id", columns=day["timestamp"].dt.hour,
                            values="waste_generated", aggfunc="sum").reindex(order).fillna(0.0)
        sc.dates.append(d)
        sc.start_fill[d] = s["fill_percentage"].to_numpy(dtype=float)
        sc.pred[d] = s["pred"].to_numpy(dtype=float)
        sc.waste[d] = w.to_numpy(dtype=float)
    if not sc.dates:
        raise RuntimeError("No complete test days available - generate more history.")
    print(f"Scenario: {len(bins):,} bins, {len(fleet)} trucks, {len(sc.dates)} test days")
    return sc


def simulate(sc: Scenario, strategies: Dict[str, Callable], env: str, label: str = "Strategy",
             time_limit_s: int = None, log=print) -> pd.DataFrame:
    """strategies: name -> FIXED, or f(fill, adjusted_pred, prob, area_priority) -> bool mask."""
    cfg = CONFIGS[env]
    time_limit_s = time_limit_s or city.EXPERIMENT_SOLVER_TIME_LIMIT_S
    n, cap = len(sc.bins), sc.cap
    ids = sc.bins["bin_id"].to_numpy()
    lat, lon = sc.bins["latitude"].to_numpy(), sc.bins["longitude"].to_numpy()
    area_prio = sc.bins["area_type"].map(city.AREA_PRIORITY).fillna(0.5).to_numpy()
    rows = []
    for seed in range(cfg["seeds"]):
        rng = np.random.default_rng(seed)
        sampled = [sc.dates[i] for i in rng.integers(0, len(sc.dates), cfg["days"])]
        state = {s: sc.start_fill[sc.dates[0]].copy() for s in strategies}
        for day_idx, d in enumerate(sampled):
            for name, selector in strategies.items():
                fill = state[name]
                if selector == FIXED:
                    all_bins = [{"bin_id": ids[i], "latitude": lat[i], "longitude": lon[i],
                                 "capacity": cap[i], "current_fill_liters": cap[i] * min(fill[i], 100) / 100}
                                for i in range(n)]
                    metrics = simulate_fixed_schedule(sc.depot, all_bins, sc.fleet, day_idx, time_limit_s)
                else:
                    adjusted = np.clip(sc.pred[d] + (fill - sc.start_fill[d]), 0.0, 100.0)
                    mask = selector(fill, adjusted, overflow_prob(adjusted, sc.rmse), area_prio)
                    sel = np.flatnonzero(mask)
                    metrics = solve_cvrp(sc.depot, [{
                        "bin_id": ids[i], "latitude": lat[i], "longitude": lon[i],
                        "capacity": cap[i], "current_fill_liters": cap[i] * min(fill[i], 100) / 100}
                        for i in sel], sc.fleet, time_limit_s=time_limit_s)

                collected = {node["bin_id"] for r in metrics["routes"].values()
                             for node in r["path"] if node["bin_id"] != "DEPOT"}
                cmask = np.isin(ids, list(collected))
                fill_at = fill[cmask]
                fill[cmask] = rng.uniform(2.0, 10.0, int(cmask.sum()))
                traj = fill[:, None] + np.cumsum(sc.waste[d] / cap[:, None] * 100, axis=1)
                over = traj >= 80.0
                prev = np.c_[fill >= 80.0, over[:, :-1]]
                state[name] = traj[:, -1]
                rows.append({
                    "Seed": seed, "Day": day_idx, label: name,
                    "Distance_km": metrics["total_distance_km"],
                    "Fuel_Liters": metrics["total_fuel_liters"],
                    "CO2_kg": metrics["total_co2_kg"],
                    "Utilization_pct": metrics["truck_utilization_pct"],
                    "Trips_Used": metrics.get("trips_used", 0),
                    "Bins_Collected": int(cmask.sum()),
                    "Unserved_Bins": len(metrics.get("unserved_bins", [])),
                    "Unnecessary_Collections": int((fill_at < 40.0).sum()),
                    "Mean_Fill_at_Collection": float(fill_at.mean()) if len(fill_at) else 0.0,
                    "Overflow_Events": int((over & ~prev).sum()),
                    "Overflow_Bin_Hours": int(over.sum()),
                    "Total_Bin_Hours": n * 24,
                })
                r = rows[-1]
                log(f"  seed {seed} day {day_idx} {name:24s} bins={r['Bins_Collected']:5d} "
                    f"km={r['Distance_km']:8.1f} overflow_events={r['Overflow_Events']}")
    return pd.DataFrame(rows)


def aggregate(df: pd.DataFrame, label: str) -> pd.DataFrame:
    agg = df.groupby(label).agg({
        "Distance_km": ["mean", "std"], "Overflow_Events": ["mean", "std"],
        "Overflow_Bin_Hours": ["mean", "std"], "Utilization_pct": ["mean", "std"],
        "Unnecessary_Collections": ["mean"], "Mean_Fill_at_Collection": ["mean"],
        "Fuel_Liters": ["mean"], "CO2_kg": ["mean"], "Bins_Collected": ["mean"],
        "Trips_Used": ["mean"], "Unserved_Bins": ["mean"],
    })
    agg.columns = ["_".join(c) for c in agg.columns]
    return agg
