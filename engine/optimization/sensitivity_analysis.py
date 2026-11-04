"""
Ablation and weight-sensitivity study of EcoBin's priority score on the Edinburgh network.

priority = w_forecast x forecast + w_uncertainty x 100 x P(fill >= 80 %) + w_area x 100 x area weight
A bin is collected when forecast >= 80 % or priority >= 75.

Usage: python -m optimization.sensitivity_analysis [smoke|development|validation|publication]
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from optimization.simulation import CONFIGS, EXP_DIR, aggregate, load_scenario, simulate  # noqa: E402

ABLATION = {
    "Only_Forecasting": (1.0, 0.0, 0.0),
    "Forecast_and_Uncertainty": (0.6, 0.4, 0.0),
    "Full_EcoBin_Proposed": (0.6, 0.2, 0.2),
}
SENSITIVITY = {
    "w_8_1_1": (0.8, 0.1, 0.1), "w_7_2_1": (0.7, 0.2, 0.1), "w_7_1_2": (0.7, 0.1, 0.2),
    "w_6_3_1": (0.6, 0.3, 0.1), "w_6_2_2": (0.6, 0.2, 0.2), "w_6_1_3": (0.6, 0.1, 0.3),
    "w_5_3_2": (0.5, 0.3, 0.2), "w_5_2_3": (0.5, 0.2, 0.3),
}


def _selector(w):
    wf, wu, wa = w
    return lambda fill, pred, prob, area: (pred >= 80.0) | (pred * wf + prob * 100 * wu + area * 100 * wa >= 75.0)


def run_sensitivity(env="development"):
    cfg = CONFIGS[env]
    print(f"Starting Sensitivity Analysis: {cfg['days']} days x {cfg['seeds']} seeds...")
    sc = load_scenario()
    os.makedirs(EXP_DIR, exist_ok=True)
    for name, group in (("ablation", ABLATION), ("sensitivity", SENSITIVITY)):
        print(f"Running {name} study...")
        df = simulate(sc, {k: _selector(w) for k, w in group.items()}, env, label="Variant")
        aggregate(df, "Variant").to_csv(os.path.join(EXP_DIR, f"{name}_results.csv"))
    print("Sensitivity and Ablation analyses completed.")


if __name__ == "__main__":
    run_sensitivity(sys.argv[1] if len(sys.argv) > 1 else "development")
