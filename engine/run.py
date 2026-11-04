"""Run the BinSight experiment and its backend-free visual demonstration.

Examples:
    python run.py              # open the already-built static dashboard
    python run.py --refresh    # rerun local processing, refresh snapshot, then open
    python run.py --setup      # create .venv and install Python dependencies
"""

from __future__ import annotations

import argparse
import http.server
import shutil
import subprocess
import sys
import threading
import time
import venv
import webbrowser
from functools import partial
from pathlib import Path


ROOT = Path(__file__).resolve().parent
VENV_DIR = ROOT / ".venv"
DIST_DIR = ROOT / "frontend" / "dist"
PUBLIC_SNAPSHOT = ROOT / "frontend" / "public" / "demo" / "demo-data.json"
DIST_SNAPSHOT = DIST_DIR / "demo" / "demo-data.json"


def project_python() -> Path:
    candidate = VENV_DIR / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    return candidate if candidate.exists() else Path(sys.executable)


def setup() -> None:
    if not VENV_DIR.exists():
        print("Creating project environment...")
        venv.create(VENV_DIR, with_pip=True)
    python = project_python()
    subprocess.run([str(python), "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")], check=True)
    print("Python environment is ready.")


def refresh(experiments: str) -> None:
    if not VENV_DIR.exists():
        raise SystemExit("Project environment is missing. Run `python run.py --setup --no-serve` first.")
    python = project_python()
    try:
        subprocess.run([str(python), str(ROOT / "run_pipeline.py"), "--experiments", experiments], cwd=ROOT, check=True)
        subprocess.run([str(python), str(ROOT / "scripts" / "export_static_demo.py")], cwd=ROOT, check=True)
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"Local processing failed with exit code {exc.returncode}.") from exc

    if DIST_DIR.exists():
        DIST_SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(PUBLIC_SNAPSHOT, DIST_SNAPSHOT)
    print("The local processing results are ready for the dashboard.")


def serve(port: int) -> None:
    index = DIST_DIR / "index.html"
    if not index.exists():
        raise SystemExit("frontend/dist is missing. Use the prepared release copy or build the frontend first.")

    handler = partial(http.server.SimpleHTTPRequestHandler, directory=str(DIST_DIR))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    url = f"http://127.0.0.1:{port}/"
    print(f"BinSight experiment: {url}")
    print("Press Ctrl+C to stop.")
    threading.Thread(target=lambda: (time.sleep(0.5), webbrowser.open(url)), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--setup", action="store_true", help="create .venv and install Python dependencies")
    parser.add_argument("--refresh", action="store_true", help="rerun local data, model, routing, and snapshot export")
    parser.add_argument("--experiments", choices=["none", "smoke", "development", "validation", "publication"], default="smoke")
    parser.add_argument("--no-serve", action="store_true", help="finish after setup or refresh")
    parser.add_argument("--port", type=int, default=4173)
    args = parser.parse_args()

    if args.setup:
        setup()
    if args.refresh:
        refresh(args.experiments)
    if not args.no_serve:
        serve(args.port)


if __name__ == "__main__":
    main()
