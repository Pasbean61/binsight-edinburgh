"""
Smart Waste Management Platform — full pipeline, City of Edinburgh.

  1. Database schema
  2. Collection stops from the council's Communal Bins export + synthetic sensor history
  3. XGBoost forecasting model (Persistence and Ridge baselines)
  4. 24 h fill predictions for every stop
  5. CVRP route optimisation from Seafield depot (Google OR-Tools)
  6. Residual analysis
  7. Strategy comparison (Fixed / Reactive / Predictive / Full EcoBin)
  8. Ablation and weight-sensitivity study

Usage:
    python run_pipeline.py                 # build whatever is missing, then run everything
    python run_pipeline.py --force-data    # rebuild stops and history from scratch
    python run_pipeline.py --retrain       # retrain the model even if one exists
    python run_pipeline.py --experiments development   # longer experiment run (default: smoke)
"""
import argparse
import os

from config import city
from database.db import SessionLocal, engine, init_db
from database.models import Base, Bin, FillHistory

MODEL_PATH = os.path.join(os.path.dirname(__file__), "ml", "models", "xgb_model.pkl")


def _ensure_schema():
    try:
        init_db()
        db = SessionLocal()
        db.query(Bin.source_asset_id).first()
        db.close()
        return False
    except Exception as e:
        print(f"  [WARN] Schema mismatch ({e.__class__.__name__}); rebuilding tables.")
        Base.metadata.drop_all(bind=engine)
        Base.metadata.create_all(bind=engine)
        return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force-data", action="store_true", help="rebuild stops and history")
    ap.add_argument("--skip-data", action="store_true", help="never generate data")
    ap.add_argument("--retrain", action="store_true", help="retrain the model")
    ap.add_argument("--skip-train", action="store_true", help="never train")
    ap.add_argument("--experiments", default="smoke", choices=["none", "smoke", "development", "validation", "publication"])
    args = ap.parse_args()

    print("=" * 65)
    print("  AI-Powered Smart Waste Management Platform")
    print(f"  {city.AUTHORITY} — communal bins")
    print("=" * 65 + "\n")

    print("[1/8] Initialising database schema...")
    rebuilt = _ensure_schema()

    from ml.data_generator.edinburgh_stops import load_stops
    stops = load_stops(rebuild=args.force_data)
    db = SessionLocal()
    n_bins, n_hist = db.query(Bin).count(), db.query(FillHistory).count()
    db.close()
    expected = len(stops) * city.HISTORY_DAYS * 24
    print(f"  Bins: {n_bins:,}   Fill history: {n_hist:,}\n")

    print("[2/8] Collection stops and sensor history...")
    if args.force_data or rebuilt or (not args.skip_data and (n_bins != len(stops) or n_hist < 0.9 * expected)):
        from ml.data_generator.generator import run_generation
        run_generation()
    else:
        print(f"  Dataset present ({n_bins:,} stops). Use --force-data to regenerate.")
    print()

    print("[3/8] Forecasting model...")
    if args.skip_train:
        print("  Skipped (--skip-train).")
    elif args.retrain or args.force_data or not os.path.exists(MODEL_PATH):
        from ml.forecasting.models import train_and_evaluate_models
        train_and_evaluate_models()
    else:
        print("  Trained model found. Use --retrain to retrain.")
    print()

    print("[4/8] 24 h fill predictions...")
    from ml.forecasting.predict import generate_predictions
    db = SessionLocal()
    p = generate_predictions(db)
    print(f"  [OK] {p['n_bins']:,} stops forecast, {p['n_critical']:,} predicted to reach 80 % within 24 h\n")

    print("[5/8] CVRP route optimisation (Google OR-Tools)...")
    from optimization.daily_routes import plan_routes
    r = plan_routes(db)
    db.close()
    print(f"  [OK] {r['bins_scheduled']:,} stops scheduled, {len(r['routes'])} trucks / {r['trips_used']} trips, "
          f"{r['total_distance_km']:,} km, {len(r['unserved_bins'])} unserved\n")

    if args.experiments == "none":
        return
    print("[6/8] Residual analysis...")
    from ml.forecasting.residual_analysis import analyze_residuals
    analyze_residuals()
    print()

    print(f"[7/8] Strategy comparison ({args.experiments})...")
    from optimization.experiment_runner import run_experiments
    run_experiments(args.experiments)
    print()

    print(f"[8/8] Ablation and sensitivity ({args.experiments})...")
    from optimization.sensitivity_analysis import run_sensitivity
    run_sensitivity(args.experiments)

    print("\nPipeline complete.")
    print("  Start API:      python -m uvicorn backend.main:app --port 8000")
    print("  Start frontend: cd frontend && npm run dev")


if __name__ == "__main__":
    main()
