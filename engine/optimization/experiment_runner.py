"""
Strategy comparison (EcoBin's experiment runner) on the Edinburgh network.

Strategies, as in EcoBin:
  Fixed        every bin every third day (rotation on bin_id)
  Reactive     bins whose current fill >= 80 %
  Predictive   bins forecast (XGBoost, 24 h ahead) to reach >= 80 %
  Full EcoBin  forecast >= 80 %, or priority >= 75 where
               priority = 0.6 x forecast + 0.2 x 100 x P(fill >= 80 %) + 0.2 x 100 x area weight

Usage: python -m optimization.experiment_runner [smoke|development|validation|publication]
"""
import datetime
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from config import city  # noqa: E402
from optimization.simulation import CONFIGS, EXP_DIR, FIXED, aggregate, load_scenario, simulate  # noqa: E402

STRATEGIES = {
    "Fixed": FIXED,
    "Reactive": lambda fill, pred, prob, area: fill >= 80.0,
    "Predictive": lambda fill, pred, prob, area: pred >= 80.0,
    "Full EcoBin": lambda fill, pred, prob, area: (pred >= 80.0) | (
        pred * 0.6 + prob * 100 * 0.2 + area * 100 * 0.2 >= 75.0),
}


def run_experiments(env="development"):
    cfg = CONFIGS[env]
    print(f"Starting {env} experiments: {cfg['days']} days x {cfg['seeds']} seeds...")
    sc = load_scenario()
    df = simulate(sc, STRATEGIES, env, label="Strategy")
    os.makedirs(EXP_DIR, exist_ok=True)
    df.to_csv(os.path.join(EXP_DIR, "daily_results.csv"), index=False)
    agg = aggregate(df, "Strategy")
    agg.to_csv(os.path.join(EXP_DIR, "aggregate_results.csv"))
    try:
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        sha = "unknown"
    with open(os.path.join(EXP_DIR, "manifest.json"), "w") as f:
        json.dump({"timestamp": datetime.datetime.now().isoformat(), "environment": env, "configuration": cfg,
                   "city": city.CITY_NAME, "n_bins": len(sc.bins), "fleet_size": len(sc.fleet),
                   "trips_per_truck": city.TRIPS_PER_TRUCK, "truck_capacity_l": city.TRUCK_CAPACITY_L,
                   "solver_time_limit_s": city.EXPERIMENT_SOLVER_TIME_LIMIT_S, "git_commit_sha": sha,
                   "python_version": sys.version, "model_rmse_used": sc.rmse}, f, indent=4)
    print(agg.round(2).to_string())
    print(f"Experiments completed. Results saved to {EXP_DIR}")
    return agg


if __name__ == "__main__":
    run_experiments(sys.argv[1] if len(sys.argv) > 1 else "development")
