"""Fetch the 7-day Edinburgh weather forecast as it was issued on the snapshot day (2 Nov 2026).

Open-Meteo's Previous Runs API keeps old forecast runs: `temperature_2m_previous_dayN` at hour T is
the forecast for T made N days earlier. For an hour on day SNAPSHOT + N we take lead N, so every
value below is the forecast as it stood on the snapshot day, never a later observation.

    python3 scripts/fetch_forecast.py          → model/data/raw/weather_forecast_2026-11-02.csv
                                                 and the `forecast` block in data/site.json

The model does not use this forecast: tomorrow's plan uses the weather that actually happened
(we assume tomorrow's weather is known). It is shown on the site as the week ahead.
"""
import csv, datetime as dt, json, os, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from model import config as C  # noqa: E402

ISSUED = C.SNAPSHOT.date()                     # 2 Nov 2026
DAYS = 7                                       # the Previous Runs API goes back at most 7 days
CSV = os.path.join(ROOT, "model", "data", "raw", f"weather_forecast_{ISSUED.isoformat()}.csv")


def fetch():
    var = ",".join(f"temperature_2m_previous_day{d},precipitation_previous_day{d}" for d in range(1, DAYS + 1))
    a, b = ISSUED + dt.timedelta(days=1), ISSUED + dt.timedelta(days=DAYS)
    url = ("https://previous-runs-api.open-meteo.com/v1/forecast?latitude=55.95&longitude=-3.19"
           f"&hourly={var}&timezone=Europe/London&start_date={a}&end_date={b}")
    h = json.load(urllib.request.urlopen(url, timeout=60))["hourly"]
    rows = []
    for k, t in enumerate(h["time"]):
        lead = (dt.date.fromisoformat(t[:10]) - ISSUED).days
        rows.append({"time_local": t, "lead_days": lead,
                     "temperature_c": h[f"temperature_2m_previous_day{lead}"][k],
                     "precipitation_mm": h[f"precipitation_previous_day{lead}"][k]})
    if any(r["temperature_c"] is None or r["precipitation_mm"] is None for r in rows):
        raise SystemExit("Open-Meteo returned gaps; not writing")
    with open(CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    return rows


def block(rows=None):
    """The `forecast` block for site.json, from the saved CSV."""
    if rows is None:
        if not os.path.exists(CSV):
            return None
        rows = list(csv.DictReader(open(CSV)))
    return {"issued": ISSUED.isoformat(), "start": rows[0]["time_local"],
            "temp": [round(float(r["temperature_c"]), 1) for r in rows],
            "rain": [round(float(r["precipitation_mm"]), 2) for r in rows],
            "source": "Open-Meteo Previous Runs API: the forecast as issued on "
                      + dt.date.fromisoformat(ISSUED.isoformat()).strftime("%-d %b %Y")}


if __name__ == "__main__":
    rows = fetch()
    p = os.path.join(ROOT, "data", "site.json")
    site = json.load(open(p))
    site["weather"]["forecast"] = block(rows)
    json.dump(site, open(p, "w"), separators=(",", ":"), allow_nan=False)
    print(f"{len(rows)} forecast hours from {rows[0]['time_local']} to {rows[-1]['time_local']} → {CSV}")
