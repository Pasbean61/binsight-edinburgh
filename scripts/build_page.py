"""
Assemble the website from src/ into:
  index.html          a complete document for GitHub Pages
  site/binsight.html  the same page without the document skeleton (for a Claude artifact,
                      where the AI twin can answer with Claude)

    python scripts/build_page.py
"""
import glob
import hashlib
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = lambda f: open(os.path.join(ROOT, "src", f), encoding="utf-8").read()

# data version: changes whenever any data file changes, so browsers never mix old data with new code
VER = hashlib.md5(b"".join(open(f, "rb").read() for f in sorted(glob.glob(os.path.join(ROOT, "data", "*.json"))))).hexdigest()[:10]

TITLE = "BinSight Edinburgh"
DESC = ("Forecast-driven waste collection for Edinburgh's communal bins: a live map of 4,533 real bin stops, "
        "tomorrow's optimised routes, results, the business plan and an AI twin.")
HEAD = f"""<title>{TITLE}</title>
<meta name="description" content="{DESC}">
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;1,8..60,400&family=IBM+Plex+Mono:wght@400;500;600&family=Public+Sans:wght@400;500;600;700&display=swap">
<style>
{src("style.css")}
</style>"""
SCRIPTS = f"""<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"></script>
<script>
{src("app.js").replace("/*@MATHS@*/", src("maths.js")).replace("/*@VER@*/", VER)}
</script>
<script>
{src("twin.js")}
</script>"""

fragment = f"{HEAD}\n{src('body.html')}\n{SCRIPTS}\n"
os.makedirs(os.path.join(ROOT, "site"), exist_ok=True)
open(os.path.join(ROOT, "site", "binsight.html"), "w", encoding="utf-8").write(fragment)

doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta property="og:title" content="{TITLE}">
<meta property="og:description" content="{DESC}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='7' y='13' width='18' height='15' rx='3' fill='none' stroke='%2314201b' stroke-width='2.2'/%3E%3Cpath d='M5 13h22' stroke='%2314201b' stroke-width='2.2' stroke-linecap='round'/%3E%3Cpath d='M11 9.5a7 7 0 0 1 10 0' fill='none' stroke='%230d6b55' stroke-width='2.2' stroke-linecap='round'/%3E%3Crect x='11' y='20' width='10' height='5' rx='1.5' fill='%230d6b55'/%3E%3C/svg%3E">
<style>:root{{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
{HEAD}
</head>
<body>
{src('body.html')}
{SCRIPTS}
</body>
</html>
"""
open(os.path.join(ROOT, "index.html"), "w", encoding="utf-8").write(doc)
print("wrote index.html and site/binsight.html", len(doc) // 1024, "KB")
