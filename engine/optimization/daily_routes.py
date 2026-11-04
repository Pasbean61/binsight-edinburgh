"""
Plan today's collection routes from the stored predictions (EcoBin's /api/optimize logic).

Bins are scheduled when the 24 h forecast is >= 80 % or EcoBin's priority score is >= 75,
then routed with the CVRP solver from the Seafield depot. Shared by run_pipeline.py and
POST /api/optimize.
"""
import datetime
import json

from sqlalchemy.orm import Session

from config import city
from database.models import Bin, OptimizedRoute, Prediction, RouteStop, Truck
from optimization.vrp_solver.solver import solve_cvrp


def calculate_priority(predicted_fill: float, overflow_prob: float, area_type: str) -> float:
    """Priority 0-100: forecast 60 % + overflow probability 20 % + area weight 20 % (EcoBin)."""
    w = city.AREA_PRIORITY.get(area_type, 0.5)
    return round(predicted_fill * 0.6 + overflow_prob * 100 * 0.2 + w * 100 * 0.2, 1)


def plan_routes(db: Session, time_limit_s: int = None) -> dict:
    preds = db.query(Prediction, Bin).join(Bin, Prediction.bin_id == Bin.bin_id).all()
    bins_to_collect = [{
        "bin_id": b.bin_id, "latitude": b.latitude, "longitude": b.longitude, "capacity": b.capacity,
        "current_fill_liters": b.capacity * (p.predicted_fill / 100.0),
    } for p, b in preds
        if p.predicted_fill >= 80.0 or calculate_priority(p.predicted_fill, p.overflow_probability, b.area_type) >= 75.0]

    fleet = [{"truck_id": t.truck_id, "capacity": t.capacity, "driver": t.driver}
             for t in db.query(Truck).filter(Truck.status.in_(["Idle", "Active"])).all()]
    if not fleet:
        raise RuntimeError("No active trucks available.")

    depot = {"latitude": city.DEPOT["latitude"], "longitude": city.DEPOT["longitude"]}
    results = solve_cvrp(depot, bins_to_collect, fleet, time_limit_s=time_limit_s)

    db.query(RouteStop).delete()
    db.query(OptimizedRoute).delete()
    today = datetime.date.today()
    for truck_id, info in results["routes"].items():
        n_stops = sum(1 for n in info["path"] if n["bin_id"] != "DEPOT")
        db.add(OptimizedRoute(
            truck_id=truck_id, date=today, distance=info["distance_km"],
            fuel=round(info["distance_km"] * 0.3, 2),
            duration=round(info["distance_km"] / 30.0 + n_stops * 10 / 60.0, 2),
            route_path=json.dumps(info["path"]),
        ))
    db.commit()
    results["bins_scheduled"] = len(bins_to_collect)
    return results
