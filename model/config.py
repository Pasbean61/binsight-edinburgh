"""
BinSight model settings.

Every number here is either REAL (from a published source), or an ASSUMPTION that the website
labels as such. Change them and rerun `python -m model.run`.
"""
import os
import datetime as dt

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ROOT, "data", "raw")
CACHE = os.path.join(ROOT, "data", "cache")
SITE_DATA = os.path.join(os.path.dirname(ROOT), "data")
os.makedirs(CACHE, exist_ok=True)

# ── real inputs ───────────────────────────────────────────────────────────────
BINS_CSV = os.path.join(RAW, "communal_bins.csv")            # City of Edinburgh Council, OGL v3.0
WARDS_GEOJSON = os.path.join(RAW, "wards_dec2024.geojson")   # ONS Wards (December 2024), OGL v3.0
WEATHER_CSV = os.path.join(RAW, "weather_edinburgh_hourly.csv")  # Open-Meteo, CC BY 4.0
OSM_ROADS = os.path.join(CACHE, "osm_roads.json")           # OpenStreetMap via Overpass, ODbL
GENERAL_WASTE = "WS: Communal Bin"
DEPOT = {"name": "Seafield Depot", "latitude": 55.9675, "longitude": -3.1372}
CITY_CENTRE = (55.9520, -3.1900)                            # Waverley / Princes Street
BBOX = {"south": 55.84, "north": 56.01, "west": -3.45, "east": -3.05}

# ── time window ───────────────────────────────────────────────────────────────
HISTORY_START = dt.datetime(2026, 10, 4, 0, 0)               # first simulated hour
SNAPSHOT = dt.datetime(2026, 11, 2, 23, 0)                   # last reading before the plan
PLAN_DAY = dt.date(2026, 11, 3)                              # "tomorrow" on the website
HOURS = int((SNAPSHOT - HISTORY_START).total_seconds() // 3600) + 1 + 48   # history + 2 days ahead
LEARN_DAYS = 7          # the first week runs on the timetable while the forecaster learns

# ── fill process (Layer 1) ────────────────────────────────────────────────────
# REAL: communal general-waste bins are emptied every two days
#   (City of Edinburgh Council, communal bin hubs, "Phase 6 additional information").
COLLECT_EVERY_DAYS = 2
# REAL: of about 100,000 communal-bin collections a month, 1–1.5 % draw a complaint (City of Edinburgh
#   Council, Transport and Environment Committee, 7 Dec 2017, "Enhancing communal bin collections").
#   Used as the overflow rate of the timetable; a lower bound, since not every overflow is reported.
TARGET_OVERFLOW = 0.01
# CALIBRATED by calibrate.py to TARGET_OVERFLOW: average fill when the timetable truck comes.
FILL_AT_COLLECTION = 0.415   # → 1.0 % overflow; mean true fill when emptied ≈ 44 %
# REAL: a small/medium kitchen pedal bin holds 30 L (Merseyside Recycling and Waste Authority,
#   volume conversion table). Each deposit is one such bag.
BAG_L = 30.0
# REAL: ultrasonic bin sensors are accurate to about ±10 mm; on a container about 1 m deep that is
#   about 1 percentage point of fill (manufacturer data sheets).
SENSOR_NOISE = 1.0
# STRUCTURAL ASSUMPTION: log-normal spread of fill speed across stops (the register does not say
#   how many flats each stop serves). Hour-of-day profile: simulate.HOUR_W.
DAILY_FILL_SPREAD = 0.35
# REAL: City of Edinburgh Council public holidays 2026 (Spring holiday and Victoria Day still to be
#   checked) and school holidays 2026/27 (edinburgh.gov.uk/schools/term-dates). Forecast inputs only.
PUBLIC_HOLIDAYS = ["2026-01-01", "2026-01-02", "2026-04-03", "2026-04-06", "2026-05-04",
                   "2026-09-14", "2026-12-25", "2026-12-28"]
SCHOOL_HOLIDAYS = [("2026-10-12", "2026-10-19")]        # October mid-term break, inclusive

# ── assumed operations ────────────────────────────────────────────────────────
# DERIVED: the trucks the council's own every-two-days timetable needs on its busiest day
#   (experiment.setup routes each round without a fleet limit and counts them). All three policies
#   then get that same fleet, so BinSight is compared with today's practice at equal resources.
#   Check: Edinburgh runs a refuse fleet of about 100 trucks across all waste streams (Dennis Eagle,
#   Facts magazine). The value below is only a placeholder until setup() runs.
FLEET = 24
TRUCK_LOAD_L = 60_000   # loose bin volume per load before tipping
SHIFT_MIN = 480         # 8-hour shift, depot to depot
SHIFT_START_H = 6       # 06:00
TIP_MIN = 25            # unload at the depot between loads
SERVICE_BASE_MIN = 2.0  # pull up, walk to the bin store
SERVICE_PER_BIN_MIN = 1.0  # lift and empty one container
# road speeds for a refuse truck, km/h, by OpenStreetMap highway class
SPEED = {"motorway": 70, "trunk": 48, "primary": 28, "secondary": 26, "tertiary": 24,
         "unclassified": 20, "residential": 20, "road": 20, "living_street": 10, "service": 12}

# ── assumed costs (used to score plans; the decision rule itself only ranks by projected fill) ──
COST_KM = 1.45          # £/km: 0.65 L/km diesel × £1.45/L + £0.50 wear
COST_HOUR = 75.0        # £ per truck-hour: driver, two loaders, vehicle time
COST_OVERFLOW = 60.0    # £ per overflow: complaint, side waste, street clean-up
# REAL: smart-bin systems commonly flag a bin for collection at 80 % full (industry practice, 80–90 %).
FLOOR = 80.0            # BinSight only empties a stop projected to pass 80 % before the next chance
REACTIVE_AT = 80.0      # the reactive baseline empties every stop reading ≥ 80 % at 05:00
HORIZON_H = 32          # a skipped stop next gets a truck by 14:00 tomorrow: 06:00 + 32 h

# ── experiment ────────────────────────────────────────────────────────────────
SEEDS = [1, 2]
EVAL_DAYS = 7           # 26 Oct – 1 Nov, after three weeks of warm-up
TIMETABLE_EVERY = COLLECT_EVERY_DAYS   # the timetable baseline: every stop every second day
