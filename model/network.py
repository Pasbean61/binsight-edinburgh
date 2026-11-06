"""
Layer 1: the real city.

  stops()      the council's general-waste communal bins, merged into collection stops and
               placed in their ONS ward
  RoadGraph    Edinburgh's drivable street network from OpenStreetMap as a weighted graph;
               every stop and the depot are snapped to it, and shortest paths (Dijkstra) give
               road distance, driving time and the street geometry of every leg
"""
import csv
import json
import math
import os

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components, dijkstra
from scipy.spatial import cKDTree

from . import config as C

R_EARTH = 6371.0088


def hav_km(lat1, lon1, lat2, lon2):
    p = np.pi / 180
    a = np.sin((lat2 - lat1) * p / 2) ** 2 + np.cos(lat1 * p) * np.cos(lat2 * p) * np.sin((lon2 - lon1) * p / 2) ** 2
    return 2 * R_EARTH * np.arcsin(np.sqrt(a))


def local_xy(lat, lon):
    """Equirectangular metres around Edinburgh; fine for snapping and nearest neighbours."""
    lat0 = 55.95 * np.pi / 180
    return np.column_stack([np.asarray(lon) * 111_320 * np.cos(lat0), np.asarray(lat) * 110_574])


# ── wards ─────────────────────────────────────────────────────────────────────
def wards():
    gj = json.load(open(C.WARDS_GEOJSON))
    feats = sorted(gj["features"], key=lambda f: f["properties"]["WD24CD"])
    out = []
    for f in feats:
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        out.append({"name": f["properties"]["WD24NM"], "code": f["properties"]["WD24CD"],
                    "rings": [np.asarray(p[0]) for p in polys]})
    return out


def _in_ring(lon, lat, ring):
    """Vectorised ray casting: points (lon, lat) inside polygon ring [[lon, lat], ...]."""
    x, y = ring[:, 0], ring[:, 1]
    inside = np.zeros(len(lon), dtype=bool)
    j = len(ring) - 1
    for i in range(len(ring)):
        cond = ((y[i] > lat) != (y[j] > lat)) & (lon < (x[j] - x[i]) * (lat - y[i]) / (y[j] - y[i] + 1e-15) + x[i])
        inside ^= cond
        j = i
    return inside


def ward_of(lat, lon, W):
    idx = np.full(len(lat), -1)
    for wi, w in enumerate(W):
        for ring in w["rings"]:
            hit = (idx < 0) & _in_ring(lon, lat, ring)
            idx[hit] = wi
    miss = np.flatnonzero(idx < 0)
    if len(miss):   # a few coastal stops fall just outside the generalised boundary: nearest ward
        cen = np.array([np.vstack(w["rings"]).mean(0) for w in W])
        d = (lon[miss, None] - cen[None, :, 0]) ** 2 * 0.31 + (lat[miss, None] - cen[None, :, 1]) ** 2
        idx[miss] = d.argmin(1)
    return idx


# ── stops ─────────────────────────────────────────────────────────────────────
def stops():
    """Merge general-waste communal bin records at the same spot (to 1 m) into collection stops."""
    from pyproj import Transformer
    tf = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
    groups = {}
    for row in csv.DictReader(open(C.BINS_CSV, encoding="utf-8-sig")):
        if row["feature_type_name"] != C.GENERAL_WASTE:
            continue
        try:
            x, y = float(row["X"]), float(row["Y"])
        except ValueError:
            continue
        key = (round(x), round(y))
        n = max(1, int(float(row["number_bins"] or 1)))
        size = int(float(row["bin_size"] or 1100))
        g = groups.setdefault(key, {"x": x, "y": y, "asset": row["central_asset_id"], "site": row["site_name"].strip(),
                                    "loc": row["feature_location"].strip(), "n": 0, "cap": 0, "rec": 0})
        g["n"] += n
        g["cap"] += n * size
        g["rec"] += 1
    G = list(groups.values())
    lon, lat = tf.transform(np.array([g["x"] for g in G]), np.array([g["y"] for g in G]))
    keep = (lat > C.BBOX["south"]) & (lat < C.BBOX["north"]) & (lon > C.BBOX["west"]) & (lon < C.BBOX["east"])
    G = [g for g, k in zip(G, keep) if k]
    lat, lon = lat[keep], lon[keep]
    W = wards()
    ward = ward_of(lat, lon, W)
    ids, seen = [], {}
    for g in G:
        base = "EDI-" + ("".join(ch for ch in g["asset"] if ch.isdigit()).lstrip("0") or "0")
        k = seen.get(base, 0)
        seen[base] = k + 1
        ids.append(base if k == 0 else f"{base}-{k}")
    d_centre = hav_km(lat, lon, *C.CITY_CENTRE)
    return {
        "id": ids, "lat": lat, "lon": lon, "site": [g["site"] for g in G], "loc": [g["loc"] for g in G],
        "ward": ward, "cap": np.array([g["cap"] for g in G], float), "nb": np.array([g["n"] for g in G]),
        "rec": np.array([g["rec"] for g in G]), "d_centre": d_centre, "wards": W,
        "records": sum(g["rec"] for g in G),
    }


# ── road graph ────────────────────────────────────────────────────────────────
class RoadGraph:
    """Undirected street graph; edge weights are length (km) and driving time (min)."""

    def __init__(self, path=C.OSM_ROADS):
        osm = json.load(open(path))
        nodes = {e["id"]: (e["lat"], e["lon"]) for e in osm["elements"] if e["type"] == "node"}
        nid = {k: i for i, k in enumerate(nodes)}
        coords = np.array(list(nodes.values()))
        a, b, cls = [], [], []
        for e in osm["elements"]:
            if e["type"] != "way":
                continue
            hw = e.get("tags", {}).get("highway", "road").replace("_link", "")
            speed = C.SPEED.get(hw, 20)
            ns = [nid[n] for n in e["nodes"] if n in nid]
            a += ns[:-1]
            b += ns[1:]
            cls += [speed] * (len(ns) - 1)
        a, b, sp = np.array(a), np.array(b), np.array(cls, float)
        km = hav_km(coords[a, 0], coords[a, 1], coords[b, 0], coords[b, 1])
        mins = km / sp * 60
        n = len(coords)
        # keep the largest connected piece of the network
        adj = csr_matrix((np.ones(len(a)), (a, b)), shape=(n, n))
        _, lab = connected_components(adj, directed=False)
        big = np.bincount(lab).argmax()
        keep_node = lab == big
        remap = -np.ones(n, int)
        remap[keep_node] = np.arange(keep_node.sum())
        ok = keep_node[a] & keep_node[b] & (a != b)
        a, b, km, mins = remap[a[ok]], remap[b[ok]], km[ok], mins[ok]
        self.coords = coords[keep_node]
        self.n = len(self.coords)
        sym = lambda w: csr_matrix((np.r_[w, w], (np.r_[a, b], np.r_[b, a])), shape=(self.n, self.n))
        # duplicate edges sum in csr_matrix; take the minimum instead by building from a dict
        best = {}
        for u, v, k, t in zip(a, b, km, mins):
            key = (u, v) if u < v else (v, u)
            if key not in best or t < best[key][1]:
                best[key] = (k, t)
        ua = np.array([k[0] for k in best]); va = np.array([k[1] for k in best])
        kk = np.array([v[0] for v in best.values()]); tt = np.array([v[1] for v in best.values()])
        self.G_km = sym(kk)
        self.G_min = sym(tt)
        self.edges = len(best)
        self.road_km = float(kk.sum())
        self.tree = cKDTree(local_xy(self.coords[:, 0], self.coords[:, 1]))

    def snap(self, lat, lon):
        d, i = self.tree.query(local_xy(lat, lon))
        return i, d

    def matrices(self, nodes, cache=None):
        """Shortest-path driving time (min) and road distance (km) between graph nodes."""
        if cache and os.path.exists(cache):
            z = np.load(cache)
            if np.array_equal(z["nodes"], nodes):
                return z["T"], z["D"]
        T = dijkstra(self.G_min, directed=False, indices=nodes)[:, nodes].astype(np.float32)
        D = dijkstra(self.G_km, directed=False, indices=nodes)[:, nodes].astype(np.float32)
        if cache:
            np.savez(cache, nodes=nodes, T=T, D=D)
        return T, D

    def paths(self, legs):
        """Street geometry, km and minutes of each leg (u, v) along the fastest path."""
        out = {}
        src = sorted({u for u, _ in legs})
        for chunk in range(0, len(src), 200):
            S = src[chunk:chunk + 200]
            _, pred = dijkstra(self.G_min, directed=False, indices=S, return_predecessors=True)
            row = {s: k for k, s in enumerate(S)}
            for u, v in legs:
                if u not in row or (u, v) in out:
                    continue
                p = pred[row[u]]
                seq = [v]
                while seq[-1] != u and seq[-1] >= 0:
                    seq.append(p[seq[-1]])
                seq = seq[::-1]
                pts = self.coords[seq]
                km = float(hav_km(pts[:-1, 0], pts[:-1, 1], pts[1:, 0], pts[1:, 1]).sum()) if len(seq) > 1 else 0.0
                mins = float(sum(self.G_min[seq[i], seq[i + 1]] for i in range(len(seq) - 1)))
                out[(u, v)] = (pts, km, mins)
        return out
