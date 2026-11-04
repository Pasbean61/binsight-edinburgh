"""
City configuration — City of Edinburgh.

Every place-specific constant lives here, so the rest of the code base has no hardcoded
coordinates, fleet numbers or holiday lists. Values marked ASSUMPTION are modelling choices,
not figures published by the council; see README "Assumptions".
"""
import os

CITY_NAME = "Edinburgh"
AUTHORITY = "City of Edinburgh Council"

# ── Depot ───────────────────────────────────────────────────────────────────────
# Seafield, next to the Seafield Household Waste Recycling Centre (76 Seafield Road).
# Coordinates taken from the council's own communal-bin records located at that site.
DEPOT = {"name": "Seafield Depot", "latitude": 55.9675, "longitude": -3.1372}

# Map view used by the dashboard (frontend reads it from GET /api/config)
MAP_CENTER = {"latitude": 55.9420, "longitude": -3.2050}
MAP_ZOOM = 12

# ── Source data ─────────────────────────────────────────────────────────────────
RAW_BINS_CSV = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "communal_bins.csv")
STOPS_CSV = os.path.join(os.path.dirname(__file__), "..", "data", "edinburgh_stops.csv")
# General-waste communal bins only. Packaging, glass, food and side-loading bins are
# emptied by different vehicles on different rounds, so they are separate routing problems.
FEATURE_TYPES = ["WS: Communal Bin"]
DEFAULT_BIN_SIZE_L = 1280
# City of Edinburgh council area, used to drop records with impossible coordinates
CITY_BBOX = {"south": 55.80, "west": -3.55, "north": 56.05, "east": -2.95}
N_COLLECTION_ZONES = 24          # legacy k-means zones; replaced by real council wards below
# Real electoral wards (ONS Open Geography, Wards December 2024, BGC; Edinburgh's 17 wards are
# unchanged since 2017). Every stop is assigned to the ward that contains it.
WARDS_GEOJSON = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "wards_dec2024.geojson")
# Real hourly weather for Edinburgh (Open-Meteo, ECMWF/UKMO reanalysis + forecast), local time.
WEATHER_CSV = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "weather_edinburgh_hourly.csv")
# The simulated history covers the HISTORY_DAYS before this date (local midnight), so the
# snapshot is reproducible and lines up with the real weather file.
HISTORY_END = os.getenv("HISTORY_END", "2026-11-03")

# ── Area types (ASSUMPTION) ─────────────────────────────────────────────────────
# The open data has no land-use field, so stops are grouped by distance from the city
# centre (Princes Street / Waverley). Fill-rate parameters per group drive the simulation.
CITY_CENTRE_POINT = (55.9520, -3.1900)
AREA_RINGS_KM = [(1.2, "City Centre"), (3.5, "Inner Residential"), (float("inf"), "Outer Residential")]

AREA_PARAMS = {
    # base_fill_rate: % of capacity per hour before multipliers (~21.6x per day → 20-32 %/day)
    "City Centre":       {"base_fill_rate": 1.50, "peak_hours": [11, 12, 13, 18, 19, 20, 21], "pop_density": 9000, "holiday_boost": 1.30},
    "Inner Residential": {"base_fill_rate": 1.20, "peak_hours": [7, 8, 18, 19, 20, 21],       "pop_density": 6500, "holiday_boost": 1.15},
    "Outer Residential": {"base_fill_rate": 0.95, "peak_hours": [7, 8, 17, 18, 19, 20],       "pop_density": 3000, "holiday_boost": 1.10},
}
# Weight used in EcoBin's priority score (fill 60 % + overflow prob 20 % + area 20 %)
AREA_PRIORITY = {"City Centre": 0.9, "Inner Residential": 0.6, "Outer Residential": 0.4}
BIN_RATE_SPREAD = 0.35           # per-stop lognormal multiplier on the area rate (ASSUMPTION)

# ── Weather (ASSUMPTION, for the synthetic history) ──────────────────────────────
# Monthly mean temperature roughly 4 °C in January to 15 °C in July; frequent light rain.
TEMP_MEAN_C = 9.5
TEMP_AMPLITUDE_C = 5.5
RAIN_PROBABILITY_PER_HOUR = 0.18
RAIN_MEAN_MM = 1.0
TEMP_EFFECT_THRESHOLD_C = 18.0   # EcoBin used 28 °C for Hyderabad

# ── History length ──────────────────────────────────────────────────────────────
HISTORY_DAYS = int(os.getenv("HISTORY_DAYS", "30"))
TRAIN_FRACTION = 0.75            # first 75 % of days train the model, the rest test it

# ── Fleet (ASSUMPTION) ──────────────────────────────────────────────────────────
# One load = 60,000 L of bin volume (~20 m³ body with ~3:1 compaction).
# Each truck may tip and return to the depot up to TRIPS_PER_TRUCK times per shift.
FLEET_SIZE = int(os.getenv("FLEET_SIZE", "24"))
TRUCK_CAPACITY_L = 60000
TRIPS_PER_TRUCK = int(os.getenv("TRIPS_PER_TRUCK", "3"))
SOLVER_TIME_LIMIT_S = int(os.getenv("SOLVER_TIME_LIMIT_S", "15"))
EXPERIMENT_SOLVER_TIME_LIMIT_S = int(os.getenv("EXPERIMENT_SOLVER_TIME_LIMIT_S", "8"))

# ── Public holidays: Scotland 2026, as listed at gov.scot/publications/bank-holidays ──
# Add later years here when the history window moves past 2026.
SCOTLAND_HOLIDAYS = {
    "2026-01-01", "2026-01-02", "2026-04-03", "2026-05-04", "2026-05-25",
    "2026-06-15", "2026-08-03", "2026-11-30", "2026-12-25", "2026-12-28",
}
