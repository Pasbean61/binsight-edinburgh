"""
Write the website's data files (data/*.json) from a model run.

  site.json      summary, wards, plan, experiments, the maths section's numbers, weather
  stops.json     every collection stop as column arrays (real place, simulated state, forecast, decision)
  history.json   the last 72 h of simulated fill per stop
  routes.json    tomorrow's trucks, trips, arrival times and street geometry (our Dijkstra on OSM)
  network.json   the council's full communal-bin register, all waste streams (real)
  basemap.json   ONS ward boundaries and OpenStreetMap streets, rivers and parks (real)
"""
import csv
import json
import math
import os

import numpy as np

from . import config as C

AREAS = ["City Centre", "Inner Residential", "Outer Residential"]


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
    """Douglas–Peucker with tolerance in degrees."""
    if len(points) < 3:
        return [tuple(p) for p in points]
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
        dist = np.hypot(*(seg - p).T) if n == 0 else np.abs(d[0] * (seg[:, 1] - p[1]) - d[1] * (seg[:, 0] - p[0])) / n
        i = int(dist.argmax())
        if dist[i] > tol:
            k = a + 1 + i
            keep[k] = True
            stack += [(a, k), (k, b)]
    return [tuple(x) for x in pts[keep]]


def r(x, n=1):
    return None if x is None else round(float(x), n)


def dump(name, obj):
    path = os.path.join(C.SITE_DATA, name)
    json.dump(obj, open(path, "w"), separators=(",", ":"), allow_nan=False)
    print(f"  {name:<14} {os.path.getsize(path) / 1e6:.2f} MB")


def area_of(st):
    centre = np.array([w["name"] == "City Centre" for w in st["wards"]])[st["ward"]]
    return np.where(centre, 0, np.where(st["d_centre"] < 4.0, 1, 2))


# ── real layers that do not depend on the model run ──────────────────────────
def network_layer():
    from pyproj import Transformer
    tf = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
    streams, net = {}, {"lat": [], "lon": [], "s": [], "n": [], "size": []}
    for row in csv.DictReader(open(C.BINS_CSV, encoding="utf-8-sig")):
        try:
            x, y = float(row["X"]), float(row["Y"])
        except ValueError:
            continue
        lon, lat = tf.transform(x, y)
        if not (55.8 < lat < 56.05 and -3.55 < lon < -2.95):
            continue
        name = row["feature_type_name"].replace("WS: ", "")
        streams.setdefault(name, len(streams))
        net["lat"].append(round(lat, 5)); net["lon"].append(round(lon, 5))
        net["s"].append(streams[name]); net["n"].append(int(row["number_bins"] or 0))
        net["size"].append(int(row["bin_size"] or 0))
    net["streams"] = list(streams)
    dump("network.json", net)
    return len(net["s"])


def basemap_layer(st):
    base = {"wards": [], "roads": {}, "water": [], "parks": []}
    for w in st["wards"]:
        rings = [enc_polyline(simplify([(c[1], c[0]) for c in ring], 0.0002)) for ring in w["rings"] if len(ring) > 3]
        base["wards"].append({"name": w["name"], "code": w["code"], "rings": rings})
    path = os.path.join(C.CACHE, "osm_basemap.json")
    if os.path.exists(path):
        osm = json.load(open(path))
        cls_of = {"motorway": "major", "trunk": "major", "primary": "major", "secondary": "minor", "tertiary": "local"}
        for el in osm["elements"]:
            tags = el.get("tags", {})
            if el["type"] == "way" and "geometry" in el:
                pts = [(p["lat"], p["lon"]) for p in el["geometry"]]
                if tags.get("highway") in cls_of:
                    base["roads"].setdefault(cls_of[tags["highway"]], []).append(enc_polyline(simplify(pts, 0.00008)))
                elif tags.get("waterway") in ("river", "canal"):
                    base["water"].append({"name": tags.get("name", ""), "line": enc_polyline(simplify(pts, 0.00008))})
                elif (tags.get("leisure") == "park" or tags.get("natural") in ("wood", "water")) and len(pts) > 3:
                    ring = simplify(pts, 0.0001)
                    a = abs(sum(p[1] * q[0] - q[1] * p[0] for p, q in zip(ring, ring[1:] + ring[:1]))) / 2
                    if a > 4e-6:
                        base["parks"].append({"k": "water" if tags.get("natural") == "water" else "park",
                                              "name": tags.get("name", ""), "ring": enc_polyline(ring)})
            elif el["type"] == "relation" and tags.get("leisure") == "park":
                for m in el.get("members", []):
                    if m.get("role") == "outer" and "geometry" in m and len(m["geometry"]) > 3:
                        ring = simplify([(p["lat"], p["lon"]) for p in m["geometry"]], 0.0001)
                        base["parks"].append({"k": "park", "name": tags.get("name", ""), "ring": enc_polyline(ring)})
    dump("basemap.json", base)


# ── model outputs ─────────────────────────────────────────────────────────────
def stops_layer(st, L):
    """L: dict of per-stop numpy arrays from the live run (see run.py)."""
    n = len(st["cap"])
    cols = {
        "id": st["id"], "lat": [r(v, 6) for v in st["lat"]], "lon": [r(v, 6) for v in st["lon"]],
        "site": st["site"], "loc": st["loc"], "ward": [int(v) for v in st["ward"]],
        "area": [int(v) for v in area_of(st)], "cap": [int(v) for v in st["cap"]],
        "nb": [int(v) for v in st["nb"]], "rec": [int(v) for v in st["rec"]],
    }
    for k, d in (("fill", 1), ("pred", 1), ("sd", 1), ("prob", 3), ("tau", 1), ("dcost", 2), ("prio", 2),
                 ("bat", 1)):
        cols[k] = [r(v, d) for v in L[k]]
    for k in ("flag", "mand", "sig", "since", "truck", "ord", "eta"):
        cols[k] = [None if v is None or (isinstance(v, float) and math.isnan(v)) else int(v) for v in L[k]]
    assert all(len(v) == n for v in cols.values())
    dump("stops.json", cols)


def history_layer(Y, t_end, hours=72):
    start = C.HISTORY_START + __import__("datetime").timedelta(hours=t_end - hours)
    dump("history.json", {"start": start.isoformat(sep=" "), "hours": hours,
                          "fill": np.round(Y[:, t_end - hours:t_end]).astype(int).tolist()})


def routes_layer(trucks):
    dump("routes.json", {"depot": C.DEPOT, "capacity_l": C.TRUCK_LOAD_L, "fleet": C.FLEET,
                         "shift_min": C.SHIFT_MIN, "shift_start_h": C.SHIFT_START_H, "routes": trucks})
