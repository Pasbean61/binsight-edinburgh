"""
Capacitated Vehicle Routing (CVRP) with Google OR-Tools.

Unchanged from EcoBin: haversine distance x 1.3 road factor in integer metres,
PATH_CHEAPEST_ARC first solution, GUIDED_LOCAL_SEARCH, the fuel/CO2/time constants and the
output format of solve_cvrp() / simulate_fixed_schedule().

Changed for city scale (thousands of stops):
  * the distance matrix is built with numpy and handed to OR-Tools as a matrix instead of a
    Python callback;
  * each truck may make several trips per shift (tip at the depot, go out again).
    The solver sees trucks x trips vehicles; trips are merged back into one route per truck,
    whose path visits the depot between trips;
  * if demand exceeds what the fleet can carry, bins are dropped with a large penalty and
    listed in "unserved_bins" instead of the solver returning no solution.
"""
import math

import numpy as np
from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from config import city

TRUCK_SPEED_KMH = 30.0          # average truck speed in the city
FUEL_CONSUMPTION_L_PER_KM = 0.30
CO2_KG_PER_LITER = 2.68
SERVICE_MIN_PER_BIN = 10
ROAD_FACTOR = 1.3
EARTH_RADIUS_KM = 6371.0
DROP_PENALTY = 10_000_000       # metres-equivalent; far above any detour


def haversine_distance(lat1, lon1, lat2, lon2):
    """Great-circle distance in km, multiplied by 1.3 to approximate road distance."""
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
    return EARTH_RADIUS_KM * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a)) * ROAD_FACTOR


def compute_distance_matrix(locations):
    """Distance matrix in integer metres; locations[0] is the depot."""
    lat = np.radians([l["latitude"] for l in locations])
    lon = np.radians([l["longitude"] for l in locations])
    dlat = lat[:, None] - lat[None, :]
    dlon = lon[:, None] - lon[None, :]
    a = np.sin(dlat / 2) ** 2 + np.cos(lat)[:, None] * np.cos(lat)[None, :] * np.sin(dlon / 2) ** 2
    km = EARTH_RADIUS_KM * 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a)) * ROAD_FACTOR
    m = (km * 1000).astype(np.int64)
    np.fill_diagonal(m, 0)
    return m


def _empty_result(truck_capacities):
    return {"routes": {}, "total_distance_km": 0.0, "total_duration_hours": 0.0,
            "total_fuel_liters": 0.0, "total_co2_kg": 0.0, "total_collected_liters": 0,
            "total_truck_capacity": sum(truck_capacities), "truck_utilization_pct": 0.0,
            "trips_used": 0, "unserved_bins": []}


def solve_cvrp(depot_coords, bins_to_collect, truck_fleet, time_limit_s=None, trips_per_truck=None):
    """
    depot_coords:    {"latitude", "longitude"}
    bins_to_collect: [{"bin_id", "latitude", "longitude", "current_fill_liters", ...}]
    truck_fleet:     [{"truck_id", "capacity", "driver"}]
    Returns EcoBin's result dict; routes are keyed by truck_id.
    """
    time_limit_s = time_limit_s or city.SOLVER_TIME_LIMIT_S
    trips = trips_per_truck or city.TRIPS_PER_TRUCK
    truck_capacities = [int(t["capacity"]) for t in truck_fleet]
    if not bins_to_collect or not truck_fleet:
        return _empty_result(truck_capacities)

    locations = [depot_coords] + bins_to_collect
    demands = [0] + [int(math.ceil(b["current_fill_liters"])) for b in bins_to_collect]
    # a single stop larger than a truck is capped at one full load (it would need two lifts)
    max_cap = max(truck_capacities)
    demands = [min(d, max_cap) for d in demands]
    dm = compute_distance_matrix(locations)

    # vehicle v -> (truck index, trip number)
    vehicles = [(ti, k) for ti in range(len(truck_fleet)) for k in range(trips)]
    manager = pywrapcp.RoutingIndexManager(len(dm), len(vehicles), 0)
    routing = pywrapcp.RoutingModel(manager)
    transit = routing.RegisterTransitMatrix(dm.tolist())
    routing.SetArcCostEvaluatorOfAllVehicles(transit)
    demand_cb = routing.RegisterUnaryTransitVector(demands)
    routing.AddDimensionWithVehicleCapacity(
        demand_cb, 0, [truck_capacities[ti] for ti, _ in vehicles], True, "Capacity")
    for node in range(1, len(dm)):
        routing.AddDisjunction([manager.NodeToIndex(node)], DROP_PENALTY)

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.seconds = int(time_limit_s)
    solution = routing.SolveWithParameters(params)

    results = _empty_result(truck_capacities)
    if not solution:
        results["unserved_bins"] = [b["bin_id"] for b in bins_to_collect]
        return results

    def node_info(node, load):
        if node == 0:
            return {"bin_id": "DEPOT", "latitude": depot_coords["latitude"],
                    "longitude": depot_coords["longitude"], "load_at_node": load}
        b = bins_to_collect[node - 1]
        return {"bin_id": b["bin_id"], "latitude": b["latitude"], "longitude": b["longitude"],
                "load_at_node": load}

    served = set()
    per_truck = {}
    for v, (ti, k) in enumerate(vehicles):
        idx = routing.Start(v)
        nodes = []
        while not routing.IsEnd(idx):
            nodes.append(manager.IndexToNode(idx))
            idx = solution.Value(routing.NextVar(idx))
        nodes.append(0)
        if len(nodes) <= 2:
            continue
        served.update(nodes[1:-1])
        per_truck.setdefault(ti, []).append(nodes)

    total_m, total_load, n_trips = 0, 0, 0
    for ti, trip_list in per_truck.items():
        truck = truck_fleet[ti]
        path, dist_m, load_total = [], 0, 0
        for t_i, nodes in enumerate(trip_list):
            load = 0
            for j, node in enumerate(nodes):
                load += demands[node]
                if t_i > 0 and j == 0:
                    continue          # previous trip already ended at the depot
                path.append(node_info(node, load))   # load on board this trip
            dist_m += int(sum(dm[a, b] for a, b in zip(nodes[:-1], nodes[1:])))
            load_total += load
        n_trips += len(trip_list)
        total_m += dist_m
        total_load += load_total
        results["routes"][truck["truck_id"]] = {
            "truck_id": truck["truck_id"],
            "driver": truck.get("driver"),
            "path": path,
            "trips": len(trip_list),
            "distance_km": round(dist_m / 1000.0, 2),
            "load_collected_liters": load_total,
            "capacity_liters": truck["capacity"],
        }

    km = round(total_m / 1000.0, 2)
    n_served = len(served)
    results.update({
        "total_distance_km": km,
        # travel time + 10 min service time per bin collected (EcoBin)
        "total_duration_hours": round(km / TRUCK_SPEED_KMH + n_served * SERVICE_MIN_PER_BIN / 60.0, 2),
        "total_fuel_liters": round(km * FUEL_CONSUMPTION_L_PER_KM, 2),
        "total_co2_kg": round(km * FUEL_CONSUMPTION_L_PER_KM * CO2_KG_PER_LITER, 2),
        "total_collected_liters": total_load,
        "trips_used": n_trips,
        "unserved_bins": [bins_to_collect[i - 1]["bin_id"] for i in range(1, len(dm)) if i not in served],
    })
    # utilisation per trip actually driven (each trip can carry one truck load)
    trip_capacity = sum(truck_fleet[ti]["capacity"] * len(tl) for ti, tl in per_truck.items())
    results["truck_utilization_pct"] = round(100 * total_load / trip_capacity, 1) if trip_capacity else 0.0
    return results


def simulate_fixed_schedule(depot_coords, all_bins, truck_fleet, day_index=0, time_limit_s=None):
    """Traditional schedule: every bin collected every third day, by a rotation on bin_id."""
    bins_to_collect = []
    for i, b in enumerate(sorted(all_bins, key=lambda x: x["bin_id"])):
        if (i % 3) == (day_index % 3):
            bins_to_collect.append({
                "bin_id": b["bin_id"], "latitude": b["latitude"], "longitude": b["longitude"],
                "capacity": b["capacity"],
                "current_fill_liters": b.get("current_fill_liters", b["capacity"] * 0.45),
            })
    return solve_cvrp(depot_coords, bins_to_collect, truck_fleet, time_limit_s=time_limit_s)
