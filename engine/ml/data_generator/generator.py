"""
Synthetic sensor history for the City of Edinburgh communal-bin network.

Bin locations, sizes and counts are real (City of Edinburgh Council open data, see
ml/data_generator/edinburgh_stops.py). Fill levels are simulated: the open data has no
sensor readings. The simulation follows EcoBin's original hourly model
(area base rate x peak-hour x day-type x temperature x rain x noise, collection when a bin
passes 85 % or after 72-120 h) with Edinburgh parameters from config/city.py, and is
vectorised over all stops so a month of hourly readings for ~4,500 stops builds in seconds.
"""
import datetime
import random

import numpy as np
import pandas as pd
from sqlalchemy.orm import Session

from config import city
from database.db import SessionLocal, engine, init_db
from database.models import (Bin, CollectionRequest, Driver, FillHistory, MaintenanceLog, Notification,
                             OptimizedRoute, Prediction, RouteStop, Truck)
from ml.data_generator.edinburgh_stops import load_stops

AREA_PARAMS = city.AREA_PARAMS

TRUCK_FLEET = [
    {"truck_id": f"EDI-RCV-{i:02d}", "plate": f"RCV-{i:02d}", "capacity": city.TRUCK_CAPACITY_L,
     "driver": f"Driver {i:02d}", "driver_id": f"DRV{i:03d}"}
    for i in range(1, city.FLEET_SIZE + 1)
]
DRIVER_DETAILS = [{"driver_id": t["driver_id"], "name": t["driver"], "phone": None, "license": None}
                  for t in TRUCK_FLEET]


_REAL_WEATHER = None


def _real_weather():
    """Hourly observed/forecast weather for Edinburgh from data/raw (Open-Meteo), keyed by local hour."""
    global _REAL_WEATHER
    if _REAL_WEATHER is None:
        import os
        _REAL_WEATHER = {}
        if os.path.exists(city.WEATHER_CSV):
            w = pd.read_csv(city.WEATHER_CSV)
            for t, temp, rain in w.itertuples(index=False):
                _REAL_WEATHER[pd.Timestamp(t).to_pydatetime()] = (float(temp), float(rain))
    return _REAL_WEATHER


def _weather(ts: datetime.datetime, rng: np.random.Generator):
    """City-wide temperature (°C) and rainfall (mm/h) for one hour: the real Edinburgh record
    when data/raw/weather_edinburgh_hourly.csv covers the hour, else EcoBin's synthetic model."""
    real = _real_weather().get(ts)
    if real is not None:
        return real
    seasonal = city.TEMP_MEAN_C + city.TEMP_AMPLITUDE_C * np.sin(2 * np.pi * (ts.timetuple().tm_yday - 105) / 365)
    diurnal = 2.5 * np.sin(2 * np.pi * (ts.hour - 9) / 24)
    temperature = float(np.clip(rng.normal(seasonal + diurnal, 1.5), -8, 30))
    rainfall = float(rng.exponential(city.RAIN_MEAN_MM)) if rng.random() < city.RAIN_PROBABILITY_PER_HOUR else 0.0
    return temperature, rainfall


def run_generation(history_days: int = city.HISTORY_DAYS, seed: int = 42):
    rng = np.random.default_rng(seed)
    random.seed(seed)
    stops = load_stops()
    n, hours = len(stops), history_days * 24

    print("=" * 60)
    print("  SMART WASTE MANAGEMENT - DATA GENERATOR")
    print(f"  City: {city.CITY_NAME} ({city.AUTHORITY} communal bins)")
    print(f"  Stops: {n:,}   Period: {history_days} days   Records: {n * hours:,}")
    print("=" * 60)

    init_db()
    db: Session = SessionLocal()
    try:
        print("\n[1/5] Clearing existing data...")
        for model in (RouteStop, OptimizedRoute, Prediction, Notification, CollectionRequest,
                      MaintenanceLog, FillHistory, Truck, Driver, Bin):
            db.query(model).delete()
        db.commit()

        print(f"[2/5] Inserting {len(DRIVER_DETAILS)} drivers and {len(TRUCK_FLEET)} trucks...")
        db.bulk_insert_mappings(Driver, [
            {"driver_id": d["driver_id"], "name": d["name"], "phone": d["phone"],
             "license_number": d["license"], "status": "Available"} for d in DRIVER_DETAILS])
        db.bulk_insert_mappings(Truck, [
            {"truck_id": t["truck_id"], "plate_number": t["plate"], "capacity": t["capacity"],
             "driver": t["driver"], "driver_id": t["driver_id"], "status": "Idle"} for t in TRUCK_FLEET])
        db.commit()

        # ── per-stop parameters ──
        areas = list(AREA_PARAMS)
        area_idx = stops["area_type"].map({a: i for i, a in enumerate(areas)}).to_numpy()
        base = np.array([AREA_PARAMS[a]["base_fill_rate"] for a in areas])[area_idx]
        base = base * rng.lognormal(-city.BIN_RATE_SPREAD ** 2 / 2, city.BIN_RATE_SPREAD, n)
        peak = np.zeros((len(areas), 24), dtype=bool)
        for i, a in enumerate(areas):
            peak[i, AREA_PARAMS[a]["peak_hours"]] = True
        holiday_boost = np.array([AREA_PARAMS[a]["holiday_boost"] for a in areas])[area_idx]
        pop_density = np.array([AREA_PARAMS[a]["pop_density"] for a in areas], dtype=float)[area_idx]
        cap = stops["capacity_l"].to_numpy(dtype=float)

        end_dt = datetime.datetime.strptime(city.HISTORY_END, "%Y-%m-%d")
        start_dt = end_dt - datetime.timedelta(days=history_days)
        print(f"[3/5] Simulating {hours} hours from {start_dt:%Y-%m-%d}...")
        fill = rng.uniform(5, 25, n)
        last_collection = np.zeros(n, dtype=int)
        last_collection_ts = np.full(n, np.datetime64("NaT", "s"))
        fills = np.empty((hours, n), dtype=np.float32)
        waste = np.empty((hours, n), dtype=np.float32)
        weather = []
        for h in range(hours):
            ts = start_dt + datetime.timedelta(hours=h)
            is_holiday = ts.strftime("%Y-%m-%d") in city.SCOTLAND_HOLIDAYS
            temperature, rainfall = _weather(ts, rng)
            weather.append((ts, temperature, rainfall, int(is_holiday)))

            due = (h - last_collection) >= rng.integers(72, 121, n)
            collect = ((fill >= 85.0) | due) & (fill > 20)
            fill[collect] = rng.uniform(2, 10, int(collect.sum()))
            last_collection[collect] = h
            last_collection_ts[collect] = np.datetime64(ts, "s")

            hour_mult = np.where(peak[area_idx, ts.hour], 1.8, 0.6)
            day_mult = holiday_boost if is_holiday else (1.1 if ts.weekday() >= 5 else 1.0)
            temp_effect = 1.0 + max(0.0, (temperature - city.TEMP_EFFECT_THRESHOLD_C) * 0.02)
            rain_effect = 1.0 - min(0.4, rainfall * 0.05)
            rate = base * hour_mult * day_mult * temp_effect * rain_effect * rng.normal(1.0, 0.15, n)
            waste_l = np.maximum(0.0, rate * cap / 100.0)
            fill = np.minimum(100.0, fill + waste_l / cap * 100.0)
            fills[h], waste[h] = fill, waste_l

        print("[4/5] Inserting stop records...")
        install = datetime.date(2022, 1, 1)
        db.bulk_insert_mappings(Bin, [{
            "bin_id": r.bin_id, "source_asset_id": r.source_asset_id, "latitude": r.latitude,
            "longitude": r.longitude, "street_name": r.street_name, "area_name": r.area_name,
            "ward": r.ward, "ward_number": int(r.ward_number), "area_type": r.area_type,
            "capacity": float(r.capacity_l), "current_fill_percentage": round(float(fill[i]), 2),
            "battery_level": round(random.uniform(75, 100), 1), "signal_strength": random.randint(65, 98),
            "temperature": round(weather[-1][1], 1), "status": "Active",
            "last_updated": weather[-1][0],
            "last_collection_time": (pd.Timestamp(last_collection_ts[i]).to_pydatetime()
                                     if not np.isnat(last_collection_ts[i]) else None),
            "installation_date": install + datetime.timedelta(days=random.randint(0, 180)),
        } for i, r in enumerate(stops.itertuples())])
        db.commit()

        print(f"[5/5] Writing {n * hours:,} hourly readings...")
        w = pd.DataFrame(weather, columns=["timestamp", "temperature", "rainfall", "holiday"])
        hist = pd.DataFrame({
            "bin_id": np.tile(stops["bin_id"].to_numpy(), hours),
            "timestamp": np.repeat(w["timestamp"].to_numpy(), n),
            "fill_percentage": fills.ravel().round(2),
            "battery": rng.uniform(75, 100, n * hours).round(1),
            "temperature": np.repeat(w["temperature"].round(1).to_numpy(), n),
            "rainfall": np.repeat(w["rainfall"].round(2).to_numpy(), n),
            "holiday": np.repeat(w["holiday"].to_numpy(), n),
            "population_density": np.tile(pop_density, hours),
            "waste_generated": waste.ravel().round(2),
        })
        chunk = 200_000
        for i in range(0, len(hist), chunk):
            hist.iloc[i:i + chunk].to_sql("fill_history", engine, if_exists="append", index=False,
                                          method="multi" if engine.dialect.name == "postgresql" else None,
                                          chunksize=5_000 if engine.dialect.name == "postgresql" else None)   # Postgres: <=65,535 bind params per statement
            print(f"  Progress: {min(100, (i + chunk) / len(hist) * 100):.0f}%", end="\r")
        print(f"\n  [OK] Inserted {len(hist):,} fill history records")
        print("=" * 60 + "\n  DATA GENERATION COMPLETE!\n" + "=" * 60)
    except Exception as e:
        db.rollback()
        print(f"\n[ERROR] Data generation failed: {e}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    run_generation()
