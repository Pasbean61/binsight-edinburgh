"""Export the locally computed API state as a GitHub Pages snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.main import app  # noqa: E402


DEFAULT_OUTPUT = ROOT / "frontend" / "public" / "demo" / "demo-data.json"
OSRM_ROUTE_URL = "https://router.project-osrm.org/route/v1/driving"

ENDPOINTS = {
    "config": "/api/config",
    "bins": "/api/bins",
    "predictions": "/api/predictions",
    "routes": "/api/routes",
    "trucks": "/api/trucks",
    "notifications": "/api/notifications?limit=50",
    "analytics": "/api/analytics",
    "maintenance_jobs": "/api/maintenance/jobs",
    "maintenance_workers": "/api/maintenance/workers",
    "maintenance_stats": "/api/maintenance/stats",
    "maintenance_bins": "/api/maintenance/bins",
    "daily_report": "/api/reports/daily",
}


def route_signature(route: dict) -> str:
    """Return a stable cache key for the ordered route waypoints."""
    waypoints = [
        [round(node["latitude"], 6), round(node["longitude"], 6)]
        for node in route.get("path", [])
        if node.get("latitude") is not None and node.get("longitude") is not None
    ]
    payload = json.dumps(waypoints, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:20]


def straight_line_route(route: dict, signature: str) -> dict:
    stops = [
        [node["latitude"], node["longitude"]]
        for node in route.get("path", [])
        if node.get("latitude") is not None and node.get("longitude") is not None
    ]
    return {
        "coords": stops,
        "steps": [],
        "totalDistanceM": float(route.get("distance_km", 0)) * 1000,
        "totalDurationS": float(route.get("duration_hours", 0)) * 3600,
        "snapped": False,
        "routeSignature": signature,
    }


def fetch_street_route(session: requests.Session, route: dict, signature: str) -> dict:
    stops = [
        node for node in route.get("path", [])
        if node.get("latitude") is not None and node.get("longitude") is not None
    ]
    if len(stops) < 2:
        return straight_line_route(route, signature)

    coordinates = ";".join(f"{node['longitude']},{node['latitude']}" for node in stops)
    response = session.get(
        f"{OSRM_ROUTE_URL}/{coordinates}",
        params={"overview": "full", "geometries": "geojson", "steps": "true"},
        timeout=60,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("code") != "Ok" or not payload.get("routes"):
        raise RuntimeError(f"OSRM returned {payload.get('code', 'no route')}")

    result = payload["routes"][0]
    coords = [[coordinate[1], coordinate[0]] for coordinate in result["geometry"]["coordinates"]]
    steps = []
    for leg in result.get("legs", []):
        for step in leg.get("steps", []):
            steps.append({
                "name": step.get("name", ""),
                "distance": step.get("distance", 0),
                "duration": step.get("duration", 0),
                "maneuver": step.get("maneuver", {"type": "straight"}),
            })
    return {
        "coords": coords,
        "steps": steps,
        "totalDistanceM": result.get("distance", 0),
        "totalDurationS": result.get("duration", 0),
        "snapped": True,
        "routeSignature": signature,
    }


def export_street_routes(routes: list[dict], output: Path) -> dict[str, dict]:
    cached_routes: dict[str, dict] = {}
    if output.exists():
        try:
            cached_routes = json.loads(output.read_text(encoding="utf-8")).get("street_routes", {})
        except (OSError, json.JSONDecodeError):
            pass

    session = requests.Session()
    session.headers.update({"User-Agent": "BinSight-static-export/1.0 (GitHub: mizj1213wcz/binsight)"})
    exported: dict[str, dict] = {}
    network_requests = 0

    for route in routes:
        truck_id = route["truck_id"]
        signature = route_signature(route)
        cached = cached_routes.get(truck_id)
        if cached and cached.get("routeSignature") == signature and cached.get("snapped"):
            exported[truck_id] = cached
            print(f"  {truck_id}: cached street geometry")
            continue

        if network_requests:
            time.sleep(1.1)
        network_requests += 1
        try:
            exported[truck_id] = fetch_street_route(session, route, signature)
            print(f"  {truck_id}: {len(exported[truck_id]['coords']):,} road points")
        except (requests.RequestException, RuntimeError, KeyError, TypeError, ValueError) as exc:
            print(f"  {truck_id}: road routing unavailable ({exc}); using straight-line fallback")
            exported[truck_id] = straight_line_route(route, signature)

    return exported


def export_snapshot(output: Path) -> None:
    snapshot = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "static-demo",
        "data_note": "Locations are City of Edinburgh open data; fill levels and forecasts are simulated.",
    }
    with TestClient(app) as client:
        for key, endpoint in ENDPOINTS.items():
            response = client.get(endpoint)
            response.raise_for_status()
            snapshot[key] = response.json()

    print("Street-snapping routes for the static dashboard...")
    snapshot["street_routes"] = export_street_routes(snapshot["routes"], output)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Static snapshot: {output}")
    print(f"Size: {output.stat().st_size / 1_000_000:.2f} MB")
    print(f"Bins: {len(snapshot['bins']):,}; predictions: {len(snapshot['predictions']):,}; routes: {len(snapshot['routes']):,}")
    snapped = sum(1 for route in snapshot["street_routes"].values() if route.get("snapped"))
    print(f"Street-snapped routes: {snapped}/{len(snapshot['routes'])}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    export_snapshot(args.output.resolve())


if __name__ == "__main__":
    main()
