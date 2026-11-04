"""
Build the website's data files from the engine's local run.

Run after `python run_pipeline.py` inside engine/:

    python scripts/build_site_data.py            # from the repository root

Reads   engine/waste_management.db, engine/data/*, engine/ml/models/*, engine/experiments/results/*
Writes  data/site.json      summary, wards, results, model, weather, sources
        data/stops.json     4,533 collection stops (column arrays)
        data/history.json   last 72 h of simulated fill per stop (integers, %)
        data/routes.json    optimised routes, snapped to real streets with OSRM (cached)
        data/network.json   the council's full communal-bin register, all waste streams
        data/basemap.json   ward boundaries (ONS) and streets, rivers, parks (OpenStreetMap)

Everything about places, bins, wards, streets and weather is real; fill levels, forecasts and
routes come from the engine's simulation and are labelled as such on the site.
"""
import csv
import datetime as dt
import json
import math
import os
import sqlite3
import subprocess
import sys
import time

import numpy as np
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(ROOT, "engine")
OUT = os.path.join(ROOT, "data")
sys.path.insert(0, ENGINE)
from config import city  # noqa: E402

os.makedirs(OUT, exist_ok=True)
OSRM = "https://router.project-osrm.org/route/v1/driving/"
OSRM_CACHE = os.path.join(ENGINE, "data", "osrm_cache.json")
AREAS = ["City Centre", "Inner Residential", "Outer Residential"]


# ── helpers ────────────────────────────────────────────────────────────────────
def enc_polyline(points, precision=5):
    """Google encoded polyline for [(lat, lon), ...]."""
    f = 10 ** precision
    out, plat, plon = [], 0, 0
    for lat, lon in points:
        ilat, ilon = int(round(lat * f)), int(round(lon * f))
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def simplify(points, tol):
    """Douglas-Peucker on [(x, y)] with tolerance in the same units (iterative)."""
    if len(points) < 3:
        return points
    pts = np.asarray(points, dtype=float)
    keep = np.zeros(len(pts), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        p, q = pts[a], pts[b]
        seg = pts[a + 1:b]
        d = q - p
        n = math.hypot(*d)
        if n == 0:
            dist = np.hypot(*(seg - p).T)
        else:
            dist = np.abs(d[0] * (seg[:, 1] - p[1]) - d[1] * (seg[:, 0] - p[0])) / n
        i = int(dist.argmax())
        if dist[i] > tol:
            k = a + 1 + i
            keep[k] = True
            stack += [(a, k), (k, b)]
    return [tuple(x) for x in pts[keep]]


def r(x, n=1):
    return None if x is None else round(float(x), n)


def hav_km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


# ── stops + live state ─────────────────────────────────────────────────────────
db = sqlite3.connect(os.path.join(ENGINE, "waste_management.db"))
db.row_factory = sqlite3.Row
stops_csv = list(csv.DictReader(open(os.path.join(ENGINE, "data", "edinburgh_stops.csv"))))
wards_gj = json.load(open(city.WARDS_GEOJSON))
ward_feats = sorted(wards_gj["features"], key=lambda f: f["properties"]["WD24CD"])
WARDS = [f["properties"]["WD24NM"] for f in ward_feats]
WARD_CODES = [f["properties"]["WD24CD"] for f in ward_feats]

bins = {row["bin_id"]: row for row in db.execute("SELECT * FROM bins")}
preds = {row["bin_id"]: row for row in db.execute("SELECT * FROM predictions")}
snapshot_ts = db.execute("SELECT MAX(timestamp) FROM fill_history").fetchone()[0]
snap = dt.datetime.fromisoformat(snapshot_ts[:19])
pred_time = preds[next(iter(preds))]["prediction_time"]

meta = json.load(open(os.path.join(ENGINE, "ml", "models", "model_metadata.json")))
rmse = float(meta["rmse"])


def priority(pf, prob, area):
    return round(pf * 0.6 + prob * 100 * 0.2 + city.AREA_PRIORITY.get(area, 0.5) * 100 * 0.2, 1)


# routes: order of collection per stop
routes_rows = list(db.execute("SELECT * FROM optimized_routes ORDER BY truck_id"))
truck_rows = {t["truck_id"]: t for t in db.execute("SELECT * FROM trucks")}
stop_truck, stop_order = {}, {}
for ti, rt in enumerate(routes_rows):
    path = json.loads(rt["route_path"])
    k = 0
    for node in path:
        if node["bin_id"] != "DEPOT":
            k += 1
            stop_truck[node["bin_id"]] = ti
            stop_order[node["bin_id"]] = k

cols = {k: [] for k in ["id", "lat", "lon", "site", "loc", "ward", "area", "cap", "nb", "rec",
                        "fill", "pred", "prob", "prio", "flag", "bat", "sig", "since", "truck", "ord"]}
flag_count = 0
for s in stops_csv:
    b, p = bins[s["bin_id"]], preds[s["bin_id"]]
    pf, prob = float(p["predicted_fill"]), float(p["overflow_probability"])
    pr = priority(pf, prob, s["area_type"])
    flagged = pf >= 80 or pr >= 75
    flag_count += flagged
    lc = b["last_collection_time"]
    since = None if lc is None else round((snap - dt.datetime.fromisoformat(lc[:19])).total_seconds() / 3600)
    site, _, loc = s["street_name"].partition(", ")
    cols["id"].append(s["bin_id"])
    cols["lat"].append(round(float(s["latitude"]), 6))
    cols["lon"].append(round(float(s["longitude"]), 6))
    cols["site"].append(site.strip())
    cols["loc"].append(loc.strip())
    cols["ward"].append(int(s["ward_number"]) - 1)
    cols["area"].append(AREAS.index(s["area_type"]))
    cols["cap"].append(int(float(s["capacity_l"])))
    cols["nb"].append(int(float(s["n_bins"])))
    cols["rec"].append(int(s["n_asset_records"]))
    cols["fill"].append(r(b["current_fill_percentage"]))
    cols["pred"].append(r(pf))
    cols["prob"].append(round(prob, 3))
    cols["prio"].append(pr)
    cols["flag"].append(int(flagged))
    cols["bat"].append(r(b["battery_level"]))
    cols["sig"].append(int(b["signal_strength"]))
    cols["since"].append(since)
    cols["truck"].append(stop_truck.get(s["bin_id"], -1))
    cols["ord"].append(stop_order.get(s["bin_id"], 0))
json.dump(cols, open(os.path.join(OUT, "stops.json"), "w"), separators=(",", ":"))
print(f"stops.json      {len(cols['id']):,} stops, {flag_count:,} flagged")

# ── 72 h history ───────────────────────────────────────────────────────────────
start = (snap - dt.timedelta(hours=71)).isoformat(sep=" ")
hist = {}
for bid, ts, fp in db.execute("SELECT bin_id, timestamp, fill_percentage FROM fill_history "
                              "WHERE timestamp >= ? ORDER BY timestamp", (start,)):
    hist.setdefault(bid, []).append(int(round(fp)))
history = {"start": start, "hours": 72, "fill": [hist.get(i, []) for i in cols["id"]]}
json.dump(history, open(os.path.join(OUT, "history.json"), "w"), separators=(",", ":"))
print(f"history.json    72 h x {len(cols['id']):,}")

# ── routes, snapped to streets with OSRM ───────────────────────────────────────
cache = json.load(open(OSRM_CACHE)) if os.path.exists(OSRM_CACHE) else {}
session = requests.Session()
session.headers["User-Agent"] = "BinSight-Edinburgh-student-project/1.0"
idx_of = {bid: i for i, bid in enumerate(cols["id"])}
depot = (city.DEPOT["latitude"], city.DEPOT["longitude"])
routes_out = []
for ti, rt in enumerate(routes_rows):
    path = json.loads(rt["route_path"])
    trips, cur = [], []
    for node in path:
        if node["bin_id"] == "DEPOT":
            if cur:
                trips.append(cur)
            cur = []
        else:
            cur.append(node)
    if cur:
        trips.append(cur)
    trip_out = []
    for trip in trips:
        pts = [depot] + [(n["latitude"], n["longitude"]) for n in trip] + [depot]
        key = enc_polyline(pts, 6)
        if key not in cache:
            coord = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in pts)
            for attempt in range(4):
                try:
                    # curl, because macOS's bundled Python (LibreSSL) fails the TLS handshake with OSRM
                    raw_json = subprocess.run(
                        ["curl", "-s", "-m", "60", "-A", session.headers["User-Agent"],
                         OSRM + coord + "?overview=full&geometries=geojson"],
                        capture_output=True, text=True, check=True).stdout
                    j = json.loads(raw_json)
                    if j.get("code") == "Ok":
                        rr = j["routes"][0]
                        cache[key] = {"coords": [[c[1], c[0]] for c in rr["geometry"]["coordinates"]],
                                      "m": rr["distance"], "s": rr["duration"]}
                        break
                    print("  OSRM answered", j.get("code"), j.get("message", ""))
                except Exception as e:  # network hiccup: back off and retry
                    print("  OSRM retry", e)
                time.sleep(2 ** attempt)
            time.sleep(1.1)          # public demo server: about one request per second
            json.dump(cache, open(OSRM_CACHE, "w"))
        c = cache.get(key)
        geo = simplify(c["coords"], 0.00004) if c else pts
        load = trip[-1]["load_at_node"]
        trip_out.append({
            "stops": [idx_of[n["bin_id"]] for n in trip],
            "load": int(load),
            "line": enc_polyline(geo),
            "road_km": r(c["m"] / 1000, 2) if c else None,
            "drive_min": r(c["s"] / 60, 1) if c else None,
            "straight_km": r(sum(hav_km(a, b) for a, b in zip(pts[:-1], pts[1:])) * 1.3, 2),
        })
    t = truck_rows[rt["truck_id"]]
    routes_out.append({"truck": rt["truck_id"], "plate": t["plate_number"], "driver": t["driver"],
                       "km": r(rt["distance"], 2), "hours": r(rt["duration"], 2), "trips": trip_out})
json.dump({"depot": city.DEPOT, "capacity_l": city.TRUCK_CAPACITY_L, "fleet": city.FLEET_SIZE,
           "trips_per_truck": city.TRIPS_PER_TRUCK, "routes": routes_out},
          open(os.path.join(OUT, "routes.json"), "w"), separators=(",", ":"))
n_trips = sum(len(x["trips"]) for x in routes_out)
print(f"routes.json     {len(routes_out)} trucks, {n_trips} trips")

# ── full asset register (all streams) ──────────────────────────────────────────
from pyproj import Transformer  # noqa: E402
tf = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
raw = list(csv.DictReader(open(city.RAW_BINS_CSV, encoding="utf-8-sig")))
streams = {}
net = {"lat": [], "lon": [], "s": [], "n": [], "size": []}
for row in raw:
    try:
        x, y = float(row["X"]), float(row["Y"])
    except ValueError:
        continue
    lon, lat = tf.transform(x, y)
    if not (55.8 < lat < 56.05 and -3.55 < lon < -2.95):
        continue
    name = row["feature_type_name"].replace("WS: ", "")
    streams.setdefault(name, len(streams))
    net["lat"].append(round(lat, 5))
    net["lon"].append(round(lon, 5))
    net["s"].append(streams[name])
    net["n"].append(int(row["number_bins"] or 0))
    net["size"].append(int(row["bin_size"] or 0))
net["streams"] = list(streams)
json.dump(net, open(os.path.join(OUT, "network.json"), "w"), separators=(",", ":"))
print(f"network.json    {len(net['s']):,} assets, {len(streams)} streams")

# ── basemap: ONS wards + OSM streets / rivers / parks ──────────────────────────
base = {"wards": [], "roads": {}, "water": [], "parks": []}
for f in ward_feats:
    g = f["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    rings = []
    for poly in polys:
        ring = simplify([(c[1], c[0]) for c in poly[0]], 0.0002)
        if len(ring) > 3:
            rings.append(enc_polyline(ring))
    base["wards"].append({"name": f["properties"]["WD24NM"], "code": f["properties"]["WD24CD"], "rings": rings})
osm = json.load(open(os.path.join(ENGINE, "data", "raw", "osm", "osm.json")))
road_class = {"motorway": "major", "trunk": "major", "primary": "major", "secondary": "minor", "tertiary": "local"}
for el in osm["elements"]:
    tags = el.get("tags", {})
    if el["type"] == "way" and "geometry" in el:
        pts = [(p["lat"], p["lon"]) for p in el["geometry"]]
        if tags.get("highway") in road_class:
            cls = road_class[tags["highway"]]
            line = simplify(pts, 0.00008)
            base["roads"].setdefault(cls, []).append(enc_polyline(line))
        elif tags.get("waterway") in ("river", "canal"):
            base["water"].append({"name": tags.get("name", ""), "line": enc_polyline(simplify(pts, 0.00008))})
        elif tags.get("leisure") == "park" or tags.get("natural") in ("wood", "water"):
            if len(pts) > 3:
                ring = simplify(pts, 0.0001)
                area = abs(sum(a[1] * b[0] - b[1] * a[0] for a, b in zip(ring, ring[1:] + ring[:1]))) / 2
                if area > 4e-6:      # drop pocket parks and ponds; keep the city's big green spaces
                    kind = "water" if tags.get("natural") == "water" else "park"
                    base["parks"].append({"k": kind, "name": tags.get("name", ""), "ring": enc_polyline(ring)})
    elif el["type"] == "relation" and tags.get("leisure") == "park":
        for m in el.get("members", []):
            if m.get("role") == "outer" and "geometry" in m and len(m["geometry"]) > 3:
                ring = simplify([(p["lat"], p["lon"]) for p in m["geometry"]], 0.0001)
                base["parks"].append({"k": "park", "name": tags.get("name", ""), "ring": enc_polyline(ring)})
json.dump(base, open(os.path.join(OUT, "basemap.json"), "w"), separators=(",", ":"))
print(f"basemap.json    {len(base['wards'])} wards, roads {[(k, len(v)) for k, v in base['roads'].items()]}, "
      f"{len(base['water'])} waterways, {len(base['parks'])} parks/water")

# ── weather (real) ─────────────────────────────────────────────────────────────
wx = [row for row in csv.DictReader(open(city.WEATHER_CSV))]
hist_start = (dt.datetime.strptime(city.HISTORY_END, "%Y-%m-%d") - dt.timedelta(days=city.HISTORY_DAYS))
wx = [w for w in wx if hist_start <= dt.datetime.fromisoformat(w["time_local"]) < snap + dt.timedelta(hours=25)]
weather = {"start": wx[0]["time_local"], "temp": [float(w["temperature_c"]) for w in wx],
           "rain": [float(w["precipitation_mm"]) for w in wx],
           "source": "Open-Meteo hourly weather for Edinburgh (55.95 N, 3.19 W)",
           "history_end": city.HISTORY_END}

# ── experiments ────────────────────────────────────────────────────────────────
def read_csv(name):
    p = os.path.join(ENGINE, "experiments", "results", name)
    return [dict((k, (float(v) if k not in ("Strategy", "Variant") else v)) for k, v in row.items())
            for row in csv.DictReader(open(p))]


manifest = json.load(open(os.path.join(ENGINE, "experiments", "results", "manifest.json")))
residual = json.load(open(os.path.join(ENGINE, "experiments", "results", "residual_analysis.json")))

# ── ward table ─────────────────────────────────────────────────────────────────
a = {k: np.array(v) for k, v in cols.items() if k not in ("id", "site", "loc", "since")}
wards = []
for wi, name in enumerate(WARDS):
    m = a["ward"] == wi
    trucks = sorted({int(t) for t in a["truck"][m] if t >= 0})
    wards.append({
        "name": name, "code": WARD_CODES[wi], "stops": int(m.sum()), "bins": int(a["nb"][m].sum()),
        "cap_l": int(a["cap"][m].sum()), "fill": r(a["fill"][m].mean()), "pred": r(a["pred"][m].mean()),
        "flagged": int(a["flag"][m].sum()), "risk": int((a["prob"][m] >= 0.5).sum()),
        "over90": int((a["fill"][m] >= 90).sum()),
        "trucks": [routes_out[t]["truck"] for t in trucks],
        "areas": {AREAS[k]: int(((a["area"] == k) & m).sum()) for k in range(3)},
    })

served = int((a["truck"] >= 0).sum())
road_km = sum(t["road_km"] or 0 for rt in routes_out for t in rt["trips"])
solver_km = sum(rt["km"] for rt in routes_out)
site = {
    "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    "snapshot": snap.isoformat(), "forecast_for": pred_time[:16],
    "city": city.CITY_NAME, "authority": city.AUTHORITY, "depot": city.DEPOT,
    "areas": AREAS, "wards": wards,
    "fleet": {"trucks": city.FLEET_SIZE, "capacity_l": city.TRUCK_CAPACITY_L, "trips_per_truck": city.TRIPS_PER_TRUCK,
              "speed_kmh": 30, "service_min": 10, "fuel_l_per_km": 0.30, "co2_kg_per_l": 2.68},
    "plan": {"flagged": int(a["flag"].sum()), "served": served, "trucks_used": len(routes_out), "trips": n_trips,
             "solver_km": round(solver_km, 1), "road_km": round(road_km, 1),
             "load_l": int(sum(t["load"] for rt in routes_out for t in rt["trips"])),
             "co2_kg": round(solver_km * 0.30 * 2.68, 1)},
    "totals": {"stops": len(cols["id"]), "bins": int(a["nb"].sum()), "cap_l": int(a["cap"].sum()),
               "assets": len(raw), "assets_mapped": len(net["s"]), "general_waste_records": sum(1 for x in raw if x["feature_type_name"] == "WS: Communal Bin"),
               "mean_fill": r(a["fill"].mean()), "mean_pred": r(a["pred"].mean()),
               "risk": int((a["prob"] >= 0.5).sum()), "over90": int((a["fill"] >= 90).sum()),
               "low_battery": int((a["bat"] < 80).sum())},
    "model": {"name": meta["model_name"], "version": meta["model_version"], "rmse": rmse,
              "features": meta["features"], "results": meta["results"], "residual": residual},
    "experiments": {"manifest": manifest, "aggregate": read_csv("aggregate_results.csv"),
                    "ablation": read_csv("ablation_results.csv"), "sensitivity": read_csv("sensitivity_results.csv"),
                    "daily": read_csv("daily_results.csv")},
    "weather": weather,
}
json.dump(site, open(os.path.join(OUT, "site.json"), "w"), separators=(",", ":"))
print(f"site.json       snapshot {site['snapshot']}, forecast for {site['forecast_for']}")
for f in sorted(os.listdir(OUT)):
    print(f"  {f:14s} {os.path.getsize(os.path.join(OUT, f)) / 1024:8.0f} KB")
