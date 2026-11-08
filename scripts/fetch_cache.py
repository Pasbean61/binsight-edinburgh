"""Download the road-network cache the model needs into model/data/cache/.

    python3 scripts/fetch_cache.py           # skips files that are already there
    python3 scripts/fetch_cache.py --force   # download and overwrite

The cache (OpenStreetMap streets and the stop-to-stop distance/time matrix, 188 MB unzipped) is too
big for the git repository, so it is attached to the GitHub release `road-cache-v1`:
https://github.com/Pasbean61/binsight-edinburgh/releases/tag/road-cache-v1
Map data © OpenStreetMap contributors, ODbL.
"""
import hashlib, os, sys, tempfile, urllib.request, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "model", "data", "cache")
URL = "https://github.com/Pasbean61/binsight-edinburgh/releases/download/road-cache-v1/binsight-road-cache.zip"
SHA256 = "cf936fa107286909fcd873f14555223e8f96b47318714e4bd6ca1876e6c00e9d"
FILES = ["osm_roads.json", "matrix.npz", "osm_basemap.json"]


def main(force=False):
    os.makedirs(CACHE, exist_ok=True)
    if not force and all(os.path.exists(os.path.join(CACHE, f)) for f in FILES):
        print(f"cache already in {CACHE}; use --force to download again")
        return
    with tempfile.TemporaryDirectory() as tmp:
        zpath = os.path.join(tmp, "cache.zip")
        print(f"downloading {URL} (131 MB) …", flush=True)
        with urllib.request.urlopen(URL, timeout=120) as r, open(zpath, "wb") as f:
            total, done = int(r.headers.get("Content-Length", 0)), 0
            while chunk := r.read(1 << 20):
                f.write(chunk); done += len(chunk)
                if total:
                    print(f"\r  {done / 1e6:.0f} / {total / 1e6:.0f} MB", end="", flush=True)
        print()
        h = hashlib.sha256(open(zpath, "rb").read()).hexdigest()
        if h != SHA256:
            sys.exit(f"checksum mismatch ({h}); the download is incomplete or the release changed")
        with zipfile.ZipFile(zpath) as z:
            names = z.namelist()
            if sorted(names) != sorted(FILES):
                sys.exit(f"unexpected files in the zip: {names}")
            z.extractall(CACHE)
    for f in FILES:
        print(f"  {f:<18} {os.path.getsize(os.path.join(CACHE, f)) / 1e6:6.1f} MB")
    print(f"done: {CACHE}")


if __name__ == "__main__":
    main(force="--force" in sys.argv)
