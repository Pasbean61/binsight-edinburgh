"""
24-hour-ahead fill forecasts for every stop, written to the predictions table.

Shared by run_pipeline.py and POST /api/predict (EcoBin had two copies of this logic).
"""
import datetime
import json
import os
import pickle

import numpy as np
import pandas as pd
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from database.db import engine
from database.models import FillHistory, Prediction
from ml.forecasting.models import calculate_overflow_probability
from ml.preprocessing.calendar_features import is_public_holiday
from ml.preprocessing.features import build_features

MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "models")
MODEL_PATH = os.path.join(MODEL_DIR, "xgb_model.pkl")
META_PATH = os.path.join(MODEL_DIR, "model_metadata.json")


class ModelNotTrained(RuntimeError):
    pass


class NoHistory(RuntimeError):
    pass


def generate_predictions(db: Session) -> dict:
    if not (os.path.exists(MODEL_PATH) and os.path.exists(META_PATH)):
        raise ModelNotTrained("ML model not found. Train models first via POST /api/train.")
    with open(MODEL_PATH, "rb") as f:
        model = pickle.load(f)
    with open(META_PATH) as f:
        metadata = json.load(f)
    feature_cols, area_cols, rmse = metadata["features"], metadata["area_cols"], metadata["rmse"]
    model_version = metadata.get("model_version", "xgboost_v1")

    max_ts = db.query(func.max(FillHistory.timestamp)).scalar()
    if not max_ts:
        raise NoHistory("No historical data found. Run /api/generate-data first.")

    query = text("""
        SELECT fh.timestamp, fh.bin_id, fh.fill_percentage, fh.temperature,
               fh.rainfall, fh.holiday, fh.population_density, fh.waste_generated,
               b.capacity, b.area_type
        FROM fill_history fh JOIN bins b ON fh.bin_id = b.bin_id
        WHERE fh.timestamp >= :start
    """)
    df = pd.read_sql(query, con=engine, params={"start": max_ts - datetime.timedelta(days=3)})
    df["timestamp"] = pd.to_datetime(df["timestamp"])

    feats = build_features(df, is_training=False)
    latest = feats.loc[feats.groupby("bin_id")["timestamp"].idxmax()].copy()
    pred_times = latest["timestamp"] + pd.Timedelta(hours=24)
    latest["timestamp"] = pred_times
    latest["hour"] = latest["timestamp"].dt.hour
    latest["day_of_week"] = latest["timestamp"].dt.dayofweek
    latest["month"] = latest["timestamp"].dt.month
    latest["is_weekend"] = (latest["day_of_week"] >= 5).astype(int)
    latest["holiday"] = latest["timestamp"].apply(is_public_holiday)
    for col in area_cols:
        latest[col] = (latest["area_type"] == col.replace("area_", "")).astype(int)

    preds = np.clip(model.predict(latest[feature_cols]), 0.0, 100.0)
    db.query(Prediction).delete()
    db.bulk_insert_mappings(Prediction, [{
        "bin_id": bid, "prediction_time": pt.to_pydatetime(), "predicted_fill": float(pf),
        "overflow_probability": calculate_overflow_probability(float(pf), rmse, threshold=80.0),
        "model_version": model_version, "created_at": datetime.datetime.utcnow(),
    } for bid, pt, pf in zip(latest["bin_id"], pred_times, preds)])
    db.commit()
    return {"n_bins": int(len(latest)), "n_critical": int((preds >= 80).sum())}
