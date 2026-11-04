/* BinSight Edinburgh: page logic. Data comes from data/*.json, built by scripts/build_site_data.py. */
(() => {
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt = (n, d = 0) => n == null || isNaN(n) ? "–" : Number(n).toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n, d = 0) => fmt(n, d) + " %";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

function decode(str, precision = 5) {
  const f = Math.pow(10, precision), out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let b, shift = 0, res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = (res & 1) ? ~(res >> 1) : (res >> 1);
      if (which === 0) lat += d; else lon += d;
    }
    out.push([lat / f, lon / f]);
  }
  return out;
}
const havKm = (a, b) => { const R = Math.PI / 180, dLa = (b[0] - a[0]) * R, dLo = (b[1] - a[1]) * R; const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * R) * Math.cos(b[0] * R) * Math.sin(dLo / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };

/* fill colour scale */
let PAL = {};
function readPalette() { PAL = { accentSoft: css("--accent-soft"), f: ["--f0", "--f1", "--f2", "--f3", "--f4"].map(css), accent: css("--accent"), ink: css("--ink"), ink3: css("--ink-3"), land: css("--land"), sea: css("--sea"), road: css("--road"), park: css("--park"), line: css("--line"), surface: css("--surface"), paper: css("--paper"), line2: css("--line-2"), good: css("--good"), warn: css("--warn"), bad: css("--bad") }; }
const fillColor = v => v >= 90 ? PAL.f[4] : v >= 80 ? PAL.f[3] : v >= 60 ? PAL.f[2] : v >= 35 ? PAL.f[1] : PAL.f[0];
const probColor = p => p >= .9 ? PAL.f[4] : p >= .5 ? PAL.f[3] : p >= .1 ? PAL.f[2] : p >= .01 ? PAL.f[1] : PAL.f[0];
const TRUCK_HUES = ["#2a7ab8", "#c2552d", "#7b5ea7", "#2e8b6e", "#c08a1e", "#b8417a", "#4a7d2a", "#3b5bb5", "#a8532f", "#1f8a99"];
const truckColor = i => TRUCK_HUES[i % TRUCK_HUES.length];
const STREAM_COLORS = { "Communal Bin": "#5f6f68", "Packaging": "#2a7ab8", "Bottle Bank - Mixed": "#2e8b6e", "Food Waste Communal": "#a8532f", "Chamberlain Bin": "#7b5ea7", "Paper Bank": "#c08a1e", "Side Loading Communal": "#b8417a", "Textile Bank": "#1f8a99" };

/* ── state ───────────────────────────────────────── */
const D = {};
const UI = { layer: "pred", ward: -1, flagOnly: false, routes: false, selTruck: -1, selStop: -1, follow: -1, hoverWard: -1 };
window.BS = { D, UI };

async function getJSON(p) { const r = await fetch(p); if (!r.ok) throw new Error(p + " " + r.status); return r.json(); }

async function boot() {
  readPalette();
  const [site, stops, routes, base] = await Promise.all(["data/site.json", "data/stops.json", "data/routes.json", "data/basemap.json"].map(getJSON));
  Object.assign(D, { site, S: stops, R: routes, base });
  derive();
  fillKeys();
  drawHero();
  initExplainer();
  initSteps();
  initMap();
  initConsole();
  initResults();
  initPlanner();
  initBusiness();
  initSources();
  initNav();
  document.dispatchEvent(new CustomEvent("bs:ready"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { readPalette(); drawHero(); restyleStops(); drawWeather(); });
  new MutationObserver(() => { readPalette(); drawHero(); restyleStops(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

function derive() {
  const S = D.S, n = S.id.length;
  D.n = n;
  D.wards = D.site.wards;
  D.idx = new Map(S.id.map((id, i) => [id, i]));
  // street index: group stops by site name
  const streets = new Map();
  for (let i = 0; i < n; i++) { const k = S.site[i]; if (!streets.has(k)) streets.set(k, []); streets.get(k).push(i); }
  D.streets = streets;
  D.streetNames = [...streets.keys()].sort();
  // routes
  D.trucks = D.R.routes.map((r, ti) => {
    const stops = r.trips.flatMap(t => t.stops);
    const road = r.trips.reduce((a, t) => a + (t.road_km || 0), 0);
    const drive = r.trips.reduce((a, t) => a + (t.drive_min || 0), 0);
    const load = r.trips.reduce((a, t) => a + t.load, 0);
    const wards = {}; stops.forEach(i => { const w = D.wards[S.ward[i]].name; wards[w] = (wards[w] || 0) + 1; });
    return { ...r, ti, stops, road, drive, load, wards, color: truckColor(ti) };
  });
  // BHH calibration on the optimised plan
  const served = []; for (let i = 0; i < n; i++) if (S.truck[i] >= 0) served.push(i);
  const plan = D.site.plan;
  const g = geomOf(served);
  D.bhh = { k: (plan.solver_km - 2 * plan.trips * g.rbar) / Math.sqrt(served.length * g.area), util: plan.load_l / (plan.trips * D.R.capacity_l) };
}
function geomOf(ids) {
  const dep = [D.site.depot.latitude, D.site.depot.longitude];
  if (!ids.length) return { rbar: 0, area: 0 };
  let s = 0; const pts = [];
  const kx = 111.32 * Math.cos(55.95 * Math.PI / 180), ky = 110.57;
  for (const i of ids) { s += havKm(dep, [D.S.lat[i], D.S.lon[i]]) * 1.3; pts.push([D.S.lon[i] * kx, D.S.lat[i] * ky]); }
  return { rbar: s / ids.length, area: hullArea(pts) };
}
function hullArea(p) {
  if (p.length < 3) return 0;
  p = p.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  const h = lo.slice(0, -1).concat(up.slice(0, -1));
  let a = 0; for (let i = 0; i < h.length; i++) { const j = (i + 1) % h.length; a += h[i][0] * h[j][1] - h[j][0] * h[i][1]; }
  return Math.abs(a) / 2;
}
const fmtDate = (iso, opts) => new Date(iso.replace(" ", "T")).toLocaleString("en-GB", opts);

function strat(name) { return D.site.experiments.aggregate.find(r => r.Strategy === name); }

function fillKeys() {
  const s = D.site, t = s.totals, p = s.plan;
  const fixed = strat("Fixed"), pred = strat("Predictive");
  const vals = {
    stops: fmt(t.stops), assets: fmt(t.assets), gwRecords: fmt(t.general_waste_records), flagged: fmt(p.flagged),
    planKm: fmt(p.solver_km) + " km", trucksUsed: fmt(p.trucks_used), wardsN: String(s.wards.length),
    overflowCut: fixed && pred ? "−" + fmt(100 * (1 - pred.Overflow_Bin_Hours_mean / fixed.Overflow_Bin_Hours_mean)) + " %" : "–",
    forecastShort: fmtDate(s.forecast_for, { day: "numeric", month: "short" }),
    generated: "Data built " + fmtDate(s.generated, { day: "numeric", month: "long", year: "numeric" }),
  };
  $$("[data-k]").forEach(el => { const v = vals[el.dataset.k]; if (v != null) el.textContent = v; });
}

/* ── hero canvas ─────────────────────────────────── */
function projector(w, h, pad = 18) {
  const b = { s: 55.885, n: 56.0, w: -3.43, e: -3.05 };
  const kx = Math.cos(55.94 * Math.PI / 180);
  const sx = (w - 2 * pad) / ((b.e - b.w) * kx), sy = (h - 2 * pad) / (b.n - b.s);
  const s = Math.min(sx, sy);
  const ox = (w - (b.e - b.w) * kx * s) / 2, oy = (h - (b.n - b.s) * s) / 2;
  return { x: lon => ox + (lon - b.w) * kx * s, y: lat => oy + (b.n - lat) * s };
}
let heroPts = null;
function drawHero() {
  const cv = $("#heroCanvas"); if (!cv || !D.S) return;
  const box = cv.parentElement.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = box.width * dpr; cv.height = box.height * dpr;
  const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const P = projector(box.width, box.height);
  c.fillStyle = PAL.sea; c.fillRect(0, 0, box.width, box.height);
  // wards = land
  c.lineWidth = 1; c.strokeStyle = PAL.line2;
  for (const w of D.base.wards) for (const ring of w.rings) {
    const pts = decode(ring); c.beginPath();
    pts.forEach(([la, lo], i) => i ? c.lineTo(P.x(lo), P.y(la)) : c.moveTo(P.x(lo), P.y(la)));
    c.closePath(); c.fillStyle = PAL.land; c.fill(); c.stroke();
  }
  c.fillStyle = PAL.park;
  for (const pk of D.base.parks) { if (pk.k !== "park") continue; const pts = decode(pk.ring); c.beginPath(); pts.forEach(([la, lo], i) => i ? c.lineTo(P.x(lo), P.y(la)) : c.moveTo(P.x(lo), P.y(la))); c.fill(); }
  c.strokeStyle = PAL.road; c.lineWidth = 1.2;
  for (const line of (D.base.roads.major || [])) { const pts = decode(line); c.beginPath(); pts.forEach(([la, lo], i) => i ? c.lineTo(P.x(lo), P.y(la)) : c.moveTo(P.x(lo), P.y(la))); c.stroke(); }
  // stops, low first so the full ones sit on top
  const S = D.S, order = [...S.pred.keys()].sort((a, b) => S.pred[a] - S.pred[b]);
  heroPts = [];
  for (const i of order) {
    const x = P.x(S.lon[i]), y = P.y(S.lat[i]);
    heroPts.push([x, y, i]);
    c.beginPath(); c.arc(x, y, 1.9, 0, Math.PI * 2); c.fillStyle = fillColor(S.pred[i]); c.fill();
  }
  // depot
  const dx = P.x(D.site.depot.longitude), dy = P.y(D.site.depot.latitude);
  c.beginPath(); c.arc(dx, dy, 6, 0, Math.PI * 2); c.fillStyle = PAL.ink; c.fill();
  c.beginPath(); c.arc(dx, dy, 10, 0, Math.PI * 2); c.strokeStyle = PAL.ink; c.lineWidth = 1.2; c.stroke();
  c.fillStyle = PAL.ink; c.font = "600 11px " + css("--body"); c.fillText("Seafield depot", dx + 14, dy + 4);
}
function initHeroHover() {
  const cv = $("#heroCanvas"), tip = $("#heroTip");
  cv.addEventListener("mousemove", e => {
    if (!heroPts) return;
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 64;
    for (const p of heroPts) { const d = (p[0] - mx) ** 2 + (p[1] - my) ** 2; if (d < bd) { bd = d; best = p; } }
    if (!best) { tip.style.opacity = 0; return; }
    const i = best[2];
    tip.textContent = `${D.S.site[i]} · ${D.wards[D.S.ward[i]].name} · ${fmt(D.S.pred[i])} % tomorrow`;
    tip.style.left = best[0] + "px"; tip.style.top = best[1] + "px"; tip.style.opacity = 1;
  });
  cv.addEventListener("mouseleave", () => tip.style.opacity = 0);
  cv.addEventListener("click", e => {
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 100;
    for (const p of heroPts || []) { const d = (p[0] - mx) ** 2 + (p[1] - my) ** 2; if (d < bd) { bd = d; best = p; } }
    if (best) { BS.focusStop(best[2]); $("#console").scrollIntoView(); }
  });
  let t; addEventListener("resize", () => { clearTimeout(t); t = setTimeout(drawHero, 150); });
}

/* ── explainer (illustration) ────────────────────── */
function initExplainer() {
  const rates = [9, 14, 22, 31, 12, 38, 18, 26], days = 14, fixedDays = new Set([3, 6, 9, 12]);
  const start = [20, 35, 10, 40, 55, 15, 30, 45];
  function run(mode) {
    let f = start.slice(); const frames = [];
    const tally = { visits: 0, overflowDays: 0, waste: 0 };
    frames.push({ f: f.slice(), hit: [], over: [], waste: [], tally: { ...tally } });
    for (let d = 1; d <= days; d++) {
      const hit = [], waste = [];
      for (let b = 0; b < 8; b++) {
        const collect = mode === "fixed" ? fixedDays.has(d) : (f[b] + rates[b] >= 80);
        if (collect) { tally.visits++; hit.push(b); if (f[b] < 40) { tally.waste++; waste.push(b); } f[b] = 0; }
      }
      const over = [];
      for (let b = 0; b < 8; b++) { f[b] += rates[b]; if (f[b] > 100) { over.push(b); tally.overflowDays++; } }
      frames.push({ f: f.slice(), hit, over, waste, tally: { ...tally } });
    }
    return frames;
  }
  const runs = { fixed: run("fixed"), smart: run("smart") };
  let mode = "fixed", day = 0, timer = null;
  const host = $("#exBins");
  host.innerHTML = rates.map((r, b) => `<div class="ex-bin" data-b="${b}"><span class="truck">emptied</span><span class="spill"></span><div class="tank"><div class="lvl"></div></div><div class="lbl">Bin ${"ABCDEFGH"[b]}<br><span class="mono">+${r} %/day</span></div></div>`).join("");
  function render() {
    const fr = runs[mode][day];
    $$(".ex-bin", host).forEach((el, b) => {
      const v = Math.min(100, fr.f[b]);
      const lvl = $(".lvl", el); lvl.style.height = v + "%"; lvl.style.background = fillColor(fr.f[b]);
      el.classList.toggle("over", fr.over.includes(b));
      el.classList.toggle("hit", fr.hit.includes(b));
      el.classList.toggle("waste", fr.waste.includes(b));
      $(".truck", el).textContent = fr.waste.includes(b) ? "half-empty" : "emptied";
    });
    $("#exDay").value = day; $("#exDayLbl").textContent = "Day " + day;
    const a = runs.fixed[day].tally, s = runs.smart[day].tally;
    const cell = (x, y, lowerBetter = true) => `<b>${x}</b><b class="${(lowerBetter ? y < x : y > x) ? "better" : ""}">${y}</b>`;
    $("#exScore").innerHTML = `<span class="h"></span><span class="h">Timetable</span><span class="h">BinSight</span>
      <span>Bin visits</span>${cell(a.visits, s.visits)}
      <span>Overflowing bin-days</span>${cell(a.overflowDays, s.overflowDays)}
      <span>Emptied under 40 % full</span>${cell(a.waste, s.waste)}`;
    $("#exExplain").textContent = mode === "fixed"
      ? "The timetable empties every bin on days 3, 6, 9 and 12, whether it is full or not. Fast bins overflow in between."
      : "BinSight empties a bin only when tomorrow’s forecast reaches 80 %. Slow bins are skipped, fast bins are visited sooner.";
  }
  $$(".seg button[data-mode]").forEach(b => b.onclick = () => { mode = b.dataset.mode; $$(".seg button[data-mode]").forEach(x => x.classList.toggle("on", x === b)); render(); });
  $("#exDay").oninput = e => { day = +e.target.value; render(); };
  $("#exPlay").onclick = () => {
    if (timer) { clearInterval(timer); timer = null; $("#exPlay").textContent = "Play"; return; }
    if (day >= days) day = 0;
    $("#exPlay").textContent = "Pause";
    timer = setInterval(() => { day++; render(); if (day >= days) { clearInterval(timer); timer = null; $("#exPlay").textContent = "Replay"; } }, 650);
  };
  render();
}

/* ── steps ───────────────────────────────────────── */
function initSteps() {
  const m = D.site.model, f = D.site.fleet;
  const best = m.results[m.name] || {};
  const content = [
    `<div><h4>A sensor that fits the bins Edinburgh already has</h4><p class="muted">An ultrasonic sensor in the lid measures the distance to the waste and converts it to a fill level. The prototype runs on an ESP32 in the Wokwi simulator and posts readings to the platform’s <span class="mono">/api/bin/update</span> endpoint.</p>
      <ul><li>Universal mount for communal, trade and campus bins</li><li>Bin-level data only, no personal data (UK GDPR)</li><li>Fitted first where fill levels vary most</li><li>Works with sensors councils already own: Edinburgh has 11,000 installed</li></ul></div>
     <div><div class="formula">fill % = 100 × (1 − distance / bin depth)
reading → POST /api/bin/update
  { bin_id: "EDI-600024560",
    fill: 72.4, battery: 91 }</div><p class="note">Example stop EDI-600024560 is the real communal bin at High Street (Bell’s Wynd).</p></div>`,
    `<div><h4>Forecast each bin 24 hours ahead</h4><p class="muted">The model learns how each stop fills from ${m.features.length} features: recent fill (1, 2 and 24 hours ago), 6- and 24-hour rolling averages, hours since the last collection, hour, weekday, Scottish bank holidays, and real Edinburgh temperature and rain.</p>
      <ul><li>${esc(m.name)}, trained on the first 75 % of the history and tested on the rest</li><li>Test error: MAE ${fmt(best.MAE, 2)} points, R² ${fmt(best.R2, 3)}, F1 at 80 % ${fmt(best.F1, 3)}</li><li>Beats “tomorrow = today” (R² ${fmt(m.results["Baseline (Persistence)"]?.R2, 2)}) by a wide margin</li></ul></div>
     <div><div class="formula">P(overflow) = 1 − Φ((80 − forecast) / RMSE)
RMSE = ${fmt(m.rmse, 2)} points

priority = 0.6 × forecast
         + 0.2 × 100 × P(overflow)
         + 0.2 × 100 × area weight

collect if forecast ≥ 80 or priority ≥ 75</div></div>`,
    `<div><h4>A capacitated vehicle-routing problem</h4><p class="muted">Google OR-Tools plans routes from Seafield depot. Each truck carries ${fmt(f.capacity_l)} L of bin volume per load and can tip and go out again up to ${f.trips_per_truck} times a shift. The solver starts from the cheapest-arc solution and improves it with guided local search.</p>
      <ul><li>${fmt(D.site.plan.served)} stops in ${D.site.plan.trips} trips by ${D.site.plan.trucks_used} trucks, ${fmt(D.site.plan.solver_km)} km</li><li>Stops the fleet cannot reach are reported, never silently dropped</li><li>Routes are then snapped to real streets with OSRM: ${fmt(D.site.plan.road_km)} km by road</li></ul></div>
     <div><div class="formula">minimise   Σ distance(i → j)
subject to  each flagged stop visited once
            load per trip ≤ ${fmt(f.capacity_l)} L
            trips per truck ≤ ${f.trips_per_truck}
distance   = great-circle × 1.3 road factor</div></div>`,
    `<div><h4>Crews follow the plan; residents fill the gaps</h4><p class="muted">Each driver sees an ordered stop list and map for their truck, and marks stops as collected or reports a problem (blocked access, damaged bin). Residents report full or misused bins in the app with a photo; verified reports earn points for vouchers at local businesses.</p>
      <ul><li>Only verified reports earn points, with a daily limit per person</li><li>Only the first report on a bin is rewarded</li><li>Reports act as human sensors for bins without one</li></ul></div>
     <div><p class="muted small" style="margin-bottom:10px">Try it: open any truck’s driver view.</p><button class="btn ghost" type="button" onclick="BS.openTab('routes');document.getElementById('console').scrollIntoView()">Open the driver view</button></div>`,
  ];
  const show = k => { $("#stepDetail").innerHTML = content[k]; $$("#steps .step").forEach(s => s.classList.toggle("on", +s.dataset.step === k)); };
  $$("#steps .step").forEach(s => s.onclick = () => show(+s.dataset.step));
  show(0);
}

/* ── map ─────────────────────────────────────────── */
let map, stopLayer, routeLayer, netLayer, wardLayer, markers = [], routeLines = [], wardShapes = [], highlight, baseLayers = [], basePal = "";
function initMap() {
  if (!window.L) { $("#mapNote").textContent = "The map library did not load. Check your connection."; return; }
  const canvas = L.canvas({ padding: 0.3, tolerance: 4 });
  map = L.map("map", { preferCanvas: true, renderer: canvas, zoomControl: true, attributionControl: true, minZoom: 10, maxZoom: 18, zoomSnap: 0.25, scrollWheelZoom: false })
    .setView([55.94, -3.2], 11.5);
  map.attributionControl.setPrefix(false);
  // the wheel scrolls the page until someone clicks the map; then it zooms, until the pointer leaves
  map.on("click focus", () => map.scrollWheelZoom.enable());
  map.on("mouseout blur", () => map.scrollWheelZoom.disable());
  $("#map").addEventListener("pointerdown", () => map.scrollWheelZoom.enable());
  map.attributionControl.addAttribution("Wards: ONS (OGL) · Streets © OpenStreetMap · Bins: City of Edinburgh Council (OGL)");
  const B = D.base;
  // land / wards
  map.createPane("hi"); map.getPane("hi").style.zIndex = 450; map.getPane("hi").style.pointerEvents = "none";
  const hiR = L.svg({ pane: "hi" });
  wardHi = { hover: L.polygon([], { pane: "hi", renderer: hiR, fill: false, color: PAL.accent, weight: 2, opacity: 0, dashArray: "5 4", interactive: false }).addTo(map),
             sel: L.polygon([], { pane: "hi", renderer: hiR, fill: false, color: PAL.accent, weight: 2.8, opacity: 0, interactive: false }).addTo(map) };
  wardLayer = L.layerGroup().addTo(map);
  D.base.wards.forEach((w, wi) => {
    const shape = L.polygon(w.rings.map(r => decode(r)), { renderer: canvas, color: PAL.line2, weight: 1, fillColor: PAL.land, fillOpacity: 1, interactive: true, bubblingMouseEvents: false });
    const ws = D.site.wards[wi];
    shape.bindTooltip(() => `<b>${esc(ws.name)}</b><br>${fmt(ws.stops)} stops · ${fmt(ws.flagged)} flagged tomorrow`, { sticky: true, direction: "top", offset: [0, -8] });
    shape.on("mouseover", () => { UI.hoverWard = wi; wardStyle(wi); });
    shape.on("mouseout", () => { if (UI.hoverWard === wi) UI.hoverWard = -1; wardStyle(wi); });
    shape.on("click", () => BS.focusWard(wi));
    shape.addTo(wardLayer); wardShapes[wi] = shape;
  });
  const parks = B.parks.filter(p => p.k === "park").map(p => decode(p.ring)), lakes = B.parks.filter(p => p.k === "water").map(p => decode(p.ring));
  if (parks.length) baseLayers.push([L.polygon(parks, { renderer: canvas, stroke: false, fillOpacity: 1, interactive: false }).addTo(wardLayer), () => ({ fillColor: PAL.park })]);
  if (lakes.length) baseLayers.push([L.polygon(lakes, { renderer: canvas, stroke: false, fillOpacity: 1, interactive: false }).addTo(wardLayer), () => ({ fillColor: PAL.sea })]);
  if (B.water.length) baseLayers.push([L.polyline(B.water.map(w => decode(w.line)), { renderer: canvas, weight: 3, interactive: false }).addTo(wardLayer), () => ({ color: PAL.sea })]);
  const roadStyle = { local: [0.8, 0.8], minor: [1.3, 0.9], major: [2.4, 1] };
  for (const cls of ["local", "minor", "major"]) if ((B.roads[cls] || []).length) baseLayers.push([L.polyline(B.roads[cls].map(l => decode(l)), { renderer: canvas, weight: roadStyle[cls][0], opacity: roadStyle[cls][1], interactive: false }).addTo(wardLayer), () => ({ color: PAL.road })]);
  baseLayers.forEach(([l, st]) => l.setStyle(st()));
  // ward labels
  const lbl = L.layerGroup();
  D.wards.forEach((w, wi) => {
    const ids = []; for (let i = 0; i < D.n; i++) if (D.S.ward[i] === wi) ids.push(i);
    const c = ids.reduce((a, i) => [a[0] + D.S.lat[i] / ids.length, a[1] + D.S.lon[i] / ids.length], [0, 0]);
    w._c = c;
  });
  // routes
  routeLayer = L.layerGroup().addTo(map);
  D.trucks.forEach((t, ti) => {
    const lines = t.trips.map(tr => decode(tr.line));
    const pl = L.polyline(lines, { renderer: canvas, color: t.color, weight: 2.2, opacity: .75 });
    pl.on("click", () => BS.focusTruck(ti));
    pl.bindTooltip(`${t.truck} · ${t.trips.length} trips · ${fmt(t.stops.length)} stops`, { sticky: true });
    pl.addTo(routeLayer); routeLines[ti] = pl;
  });
  // stops
  stopLayer = L.layerGroup().addTo(map);
  const S = D.S;
  for (let i = 0; i < D.n; i++) {
    const m = L.circleMarker([S.lat[i], S.lon[i]], { renderer: canvas, radius: 4, weight: 1, color: PAL.surface, fillOpacity: .95 });
    m.on("click", () => BS.focusStop(i));
    m.bindTooltip(() => `<b>${esc(S.site[i])}</b><br>${esc(D.wards[S.ward[i]].name)} · ${fmt(S.pred[i])} % tomorrow`, { direction: "top", offset: [0, -4] });
    markers[i] = m;
  }
  restyleStops();
  // depot
  const dep = [D.site.depot.latitude, D.site.depot.longitude];
  L.circleMarker(dep, { renderer: canvas, radius: 8, color: PAL.surface, weight: 2, fillColor: PAL.ink, fillOpacity: 1 }).bindTooltip("Seafield depot · 24 trucks", { direction: "top" }).addTo(map);
  highlight = L.layerGroup().addTo(map);
  map.on("zoomend", restyleStops);
  BS.map = map;
  initPlayback();
  const all = L.latLngBounds(S.lat.map((la, i) => [la, S.lon[i]]));
  map.fitBounds(all, { padding: [20, 20] });
  // the container can change size after first layout (fonts, the twin rail, phones): keep the map filled
  let fitted = false; const born = performance.now();
  setTimeout(() => { fitted = true; }, 4000);   // after the first layout settles, never move the camera on resize
  new ResizeObserver(() => { map.invalidateSize(); if (!fitted && performance.now() - born < 4000 && UI.selStop < 0 && UI.selTruck < 0 && UI.ward < 0 && UI.follow < 0) map.fitBounds(all, { padding: [20, 20] }); }).observe($(".map-shell"));
  ["pointerdown", "wheel", "touchstart"].forEach(ev => $("#map").addEventListener(ev, () => { fitted = true; }, { passive: true }));
  $("#mapNote").textContent = `Snapshot ${fmtDate(D.site.snapshot, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · forecast for ${fmtDate(D.site.forecast_for, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
  initHeroHover();
}
function wardStyle(wi) {
  const sh = wardShapes[wi]; if (!sh) return;
  const sel = UI.ward === wi, hov = UI.hoverWard === wi, dim = UI.ward >= 0 && !sel;
  sh.setStyle({ fillColor: hov && !sel ? PAL.accentSoft : PAL.land, fillOpacity: dim ? .55 : 1, color: PAL.line2, weight: 1 });
  // outlines live in their own pane above the canvas, so they never hide the stops
  if (wardHi) {
    const rings = wi => D.base.wards[wi].rings.map(r => decode(r));
    if (UI.hoverWard >= 0 && UI.hoverWard !== UI.ward) wardHi.hover.setLatLngs(rings(UI.hoverWard)).setStyle({ opacity: .9 }); else wardHi.hover.setStyle({ opacity: 0 });
    if (UI.ward >= 0) wardHi.sel.setLatLngs(rings(UI.ward)).setStyle({ opacity: 1 }); else wardHi.sel.setStyle({ opacity: 0 });
  }
}
let wardHi = null;
function stopVisible(i) {
  if (UI.ward >= 0 && D.S.ward[i] !== UI.ward) return false;
  if (UI.flagOnly && !D.S.flag[i]) return false;
  return true;
}
function restyleStops() {
  if (!map) return;
  const z = map.getZoom(), r = z < 11.5 ? 2.6 : z < 13 ? 3.6 : z < 15 ? 5 : 7;
  const S = D.S, net = UI.layer === "net";
  if (basePal !== PAL.land) { basePal = PAL.land; baseLayers.forEach(([l, st]) => l.setStyle(st())); $("#map").style.background = PAL.sea; }
  for (let i = 0; i < D.n; i++) {
    const m = markers[i], vis = !net && stopVisible(i);
    if (!vis) { if (stopLayer.hasLayer(m)) stopLayer.removeLayer(m); continue; }
    const v = UI.layer === "fill" ? S.fill[i] : S.pred[i];
    const col = UI.layer === "prob" ? probColor(S.prob[i]) : fillColor(v);
    if (SIM.emptied?.[i]) m.setStyle({ fillColor: PAL.f0, color: PAL.accent, weight: 1.6 });
    else m.setStyle({ fillColor: col, color: PAL.surface, weight: z >= 14 ? 1.2 : .6 });
    m.setRadius(i === UI.selStop ? r + 3 : r);
    if (!stopLayer.hasLayer(m)) stopLayer.addLayer(m);
  }
  D.wards.forEach((w, wi) => wardStyle(wi));
  routeLines.forEach((pl, ti) => {
    const sel = UI.selTruck, show = !net && (UI.routes || sel === ti);
    if (!show) { routeLayer.removeLayer(pl); return; }
    if (!routeLayer.hasLayer(pl)) routeLayer.addLayer(pl);
    pl.setStyle({ opacity: sel < 0 ? .45 : sel === ti ? .95 : .1, weight: sel === ti ? 4 : 1.8 });
    if (sel === ti) pl.bringToFront();
  });
  SIM.trails?.forEach((tl, ti) => tl.setStyle({ opacity: UI.selTruck < 0 || UI.selTruck === ti ? .9 : .15 }));
  drawLegend();
}
function drawLegend() {
  const L_ = $("#legend");
  if (UI.layer === "net") {
    const st = D.net?.streams || [];
    L_.innerHTML = `<div class="title">Council register, ${fmt(D.site.totals.assets)} assets</div>` + st.filter(s => STREAM_COLORS[s]).map(s => `<div class="row"><i style="background:${STREAM_COLORS[s]}"></i>${esc(s)}</div>`).join("");
    return;
  }
  const t = { pred: "Forecast fill tomorrow", fill: "Fill now", prob: "Chance of passing 80 %" }[UI.layer];
  const rows = UI.layer === "prob"
    ? [["≥ 90 %", 4], ["50–90 %", 3], ["10–50 %", 2], ["1–10 %", 1], ["< 1 %", 0]]
    : [["90–100 %", 4], ["80–90 %", 3], ["60–80 %", 2], ["35–60 %", 1], ["< 35 %", 0]];
  L_.innerHTML = `<div class="title">${t} <span class="tag sim" style="margin-left:4px">Sim</span></div>` + rows.map(([l, k]) => `<div class="row"><i style="background:${PAL.f[k]}"></i>${l}</div>`).join("") +
    `<div class="row" style="margin-top:6px"><i style="background:${PAL.f0};box-shadow:0 0 0 1.6px ${PAL.accent} inset"></i>Emptied by a truck</div>` +
    `<div class="row"><i style="background:${truckColor(0)};box-shadow:0 0 0 2px #fff inset"></i>Truck and its trail (${D.trucks.length})</div>`;
}
async function showNetwork(on) {
  if (on && !netLayer) {
    $("#mapNote").textContent = "Loading the council register…";
    D.net = await getJSON("data/network.json");
    const canvas = L.canvas({ padding: .3 });
    netLayer = L.layerGroup();
    const N = D.net;
    for (let i = 0; i < N.s.length; i++) {
      const name = N.streams[N.s[i]];
      L.circleMarker([N.lat[i], N.lon[i]], { renderer: canvas, radius: 2.6, stroke: false, fillColor: STREAM_COLORS[name] || "#888", fillOpacity: .85, interactive: false }).addTo(netLayer);
    }
    $("#mapNote").textContent = `${fmt(N.s.length)} assets in ${N.streams.length} waste streams (City of Edinburgh Council)`;
  }
  if (netLayer) on ? netLayer.addTo(map) : netLayer.remove();
}

/* detail panel */
function panel(html) { const p = $("#panel"); p.innerHTML = `<button class="x" type="button" aria-label="Close panel">×</button>` + html; p.hidden = false; $(".x", p).onclick = () => { p.hidden = true; UI.selStop = -1; UI.selTruck = -1; UI.follow = -1; $$("#fleet button").forEach(b => b.classList.remove("on")); highlight.clearLayers(); restyleStops(); }; p.scrollTop = 0; }
const riskPill = p => p >= .5 ? `<span class="pill hi">High risk</span>` : p >= .1 ? `<span class="pill md">Watch</span>` : `<span class="pill lo">Low risk</span>`;
BS.focusStop = async (i, opts = {}) => {
  if (!map) return;
  UI.selStop = i; UI.selTruck = D.S.truck[i] >= 0 && opts.keepTruck ? D.S.truck[i] : UI.selTruck;
  const S = D.S, w = D.wards[S.ward[i]], area = D.site.areas[S.area[i]];
  const areaW = { "City Centre": .9, "Inner Residential": .6, "Outer Residential": .4 }[area];
  const parts = [S.pred[i] * .6, S.prob[i] * 100 * .2, areaW * 100 * .2];
  const ti = S.truck[i];
  map.flyTo([S.lat[i], S.lon[i]], Math.max(map.getZoom(), 15.5), { duration: .6 });
  highlight.clearLayers();
  L.circleMarker([S.lat[i], S.lon[i]], { radius: 14, color: PAL.ink, weight: 2, fill: false, interactive: false }).addTo(highlight);
  restyleStops();
  panel(`<div class="dp">
    <span class="eyebrow">${esc(w.name)} ward · ${esc(area)}</span>
    <h3 style="margin-top:8px">${esc(S.site[i])}</h3>
    <div class="sub">${esc(S.loc[i] || "Communal bin stop")} · <span class="mono">${S.id[i]}</span></div>
    <div style="margin-top:10px">${riskPill(S.prob[i])} ${S.flag[i] ? `<span class="pill md">Flagged</span>` : ""}</div>
    <div class="gauge"><div><b>${fmt(S.fill[i])}%</b><span>Fill now · sim</span></div><div><b style="color:${S.pred[i] >= 80 ? "var(--bad)" : "inherit"}">${fmt(S.pred[i])}%</b><span>Forecast in 24 h · sim</span></div></div>
    <h4>Last 72 hours and the forecast</h4><svg class="spark" id="spark" viewBox="0 0 320 110" role="img" aria-label="Fill history"></svg>
    <h4>Priority score ${fmt(S.prio[i], 1)} <span class="muted small">/ 100, collect at 75</span></h4>
    <div class="prio-bar"><span style="width:${parts[0]}%;background:var(--ink)"></span><span style="width:${parts[1]}%;background:var(--f3)"></span><span style="width:${parts[2]}%;background:var(--accent)"></span></div>
    <div class="muted small" style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px"><span>Forecast ${fmt(parts[0], 1)}</span><span>Risk ${fmt(parts[1], 1)}</span><span>Location ${fmt(parts[2], 1)}</span></div>
    <dl class="kv">
      <dt>Bins at this stop</dt><dd>${S.nb[i]} · ${fmt(S.cap[i])} L total <span class="tag real">Real</span></dd>
      <dt>Council asset records</dt><dd>${S.rec[i]}</dd>
      <dt>Chance of passing 80 %</dt><dd>${fmt(S.prob[i] * 100, 1)} %</dd>
      <dt>Last emptied</dt><dd>${S.since[i] == null ? "–" : S.since[i] + " h ago"}</dd>
      <dt>Sensor battery · signal</dt><dd>${fmt(S.bat[i])} % · ${S.sig[i]} <span class="tag sim">Sim</span></dd>
      <dt>Coordinates</dt><dd class="mono">${S.lat[i].toFixed(5)}, ${S.lon[i].toFixed(5)}</dd>
    </dl>
    <h4>Tomorrow’s collection</h4>
    <p class="small" style="margin-top:6px">${ti >= 0 ? `Stop <b>${S.ord[i]}</b> of ${D.trucks[ti].stops.length} on <button class="linkbtn" data-truck="${ti}">${D.trucks[ti].truck}</button>.` : S.flag[i] ? "Flagged, but not reached by the fleet." : "Not needed tomorrow. The truck skips this stop."}</p>
    <p class="small" style="margin-top:12px"><button class="linkbtn" data-ask="${esc(S.site[i])}">Ask the twin about ${esc(S.site[i])}</button></p>
  </div>`);
  $$("#panel [data-truck]").forEach(b => b.onclick = () => BS.focusTruck(+b.dataset.truck));
  $$("#panel [data-ask]").forEach(b => b.onclick = () => BS.ask?.(`How full are the bins on ${b.dataset.ask}?`));
  drawSpark(i);
};
async function drawSpark(i) {
  if (!D.hist) { try { D.hist = await getJSON("data/history.json"); } catch { return; } }
  const svg = $("#spark"); if (!svg) return;
  const h = D.hist.fill[i] || [], W = 320, H = 110, n = h.length + 24;
  const x = k => 4 + k / (n - 1) * (W - 8), y = v => H - 16 - v / 100 * (H - 26);
  const line = h.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = h.length - 1;
  svg.innerHTML = `
    <line class="grid" x1="4" x2="${W - 4}" y1="${y(80)}" y2="${y(80)}" stroke="${PAL.f[3]}" stroke-dasharray="3 3"/>
    <text x="6" y="${y(80) - 4}" style="fill:${PAL.f[3]};font-size:10px">80 % collection line</text>
    <path d="${line} L${x(last)},${y(0)} L${x(0)},${y(0)} Z" fill="${PAL.accent}" opacity=".10"/>
    <path d="${line}" fill="none" stroke="${PAL.ink}" stroke-width="1.6"/>
    <line x1="${x(last)}" y1="${y(h[last])}" x2="${x(n - 1)}" y2="${y(D.S.pred[i])}" stroke="${PAL.accent}" stroke-width="1.8" stroke-dasharray="4 3"/>
    <circle cx="${x(n - 1)}" cy="${y(D.S.pred[i])}" r="3.5" fill="${PAL.accent}"/>
    <circle cx="${x(last)}" cy="${y(h[last])}" r="3" fill="${PAL.ink}"/>
    <text x="4" y="${H - 2}">−72 h</text><text x="${x(last)}" y="${H - 2}" text-anchor="middle">now</text><text x="${W - 4}" y="${H - 2}" text-anchor="end">+24 h</text>`;
}
BS.focusTruck = (ti, opts = {}) => {
  if (!map) return;
  const t = D.trucks[ti];
  UI.selTruck = ti;
  if (!opts.follow && UI.follow !== ti) { UI.follow = -1; $$("#fleet button").forEach(b => b.classList.remove("on")); }
  highlight.clearLayers();
  restyleStops();
  if (opts.follow) {
    const pn = $("#panel"), off = innerWidth > 640 ? 190 : 0;
    map.setView(SIM.marks[ti].getLatLng(), 14, { animate: false });
    map.panBy([off, 55], { animate: false });
  }
  else map.flyToBounds(routeLines[ti].getBounds(), { padding: [40, 40], duration: .6 });
  const wards = Object.entries(t.wards).sort((a, b) => b[1] - a[1]);
  panel(`<div class="dp">
    <span class="eyebrow" style="color:${t.color}">Truck route</span>
    <h3 style="margin-top:8px">${t.truck}</h3>
    <div class="sub">${esc(t.driver)} · plate ${esc(t.plate)} · from Seafield depot</div>
    <p class="small" id="followLive" style="margin-top:10px;padding:8px 10px;background:var(--paper);border-radius:10px">${truckStatus(ti)}</p>
    <div style="margin-top:8px"><button class="linkbtn" id="followBtn">${UI.follow === ti ? "Stop following" : "Follow this truck through the shift"}</button></div>
    <div class="gauge"><div><b>${fmt(t.stops.length)}</b><span>stops</span></div><div><b>${t.trips.length}</b><span>trips (tip between)</span></div><div><b>${fmt(t.km, 1)}</b><span>km planned</span></div><div><b>${fmt(t.road, 1)}</b><span>km by road (OSRM)</span></div></div>
    <dl class="kv"><dt>Waste collected</dt><dd>${fmt(t.load)} L</dd><dt>Load per trip</dt><dd>${t.trips.map(x => fmt(x.load / 1000, 1) + "k").join(" · ")} L</dd><dt>Driving time</dt><dd>${fmt(t.drive / 60, 1)} h</dd><dt>Service time (10 min/stop)</dt><dd>${fmt(t.stops.length * 10 / 60, 1)} h</dd></dl>
    <h4>Wards on this route</h4><p class="small" style="margin-top:6px">${wards.map(([w, c]) => `${esc(w)} (${c})`).join(", ")}</p>
    <p class="small" style="margin-top:14px"><button class="linkbtn" id="openDriver">Open driver view with every stop in order</button></p>
  </div>`);
  $("#followBtn").onclick = () => { BS.follow(ti); $("#followBtn").textContent = UI.follow === ti ? "Stop following" : "Follow this truck through the shift"; };
  $("#openDriver").onclick = () => { BS.openTab("routes"); selectTruckInList(ti); $("#ctabs").scrollIntoView({ block: "start" }); };
};
BS.focusWard = wi => {
  UI.ward = wi; $("#wardSel").value = wi; UI.selTruck = -1; highlight.clearLayers(); restyleStops(); renderBins();
  if (wi < 0) { map.flyToBounds(L.latLngBounds(D.S.lat.map((la, i) => [la, D.S.lon[i]])), { padding: [20, 20] }); $("#panel").hidden = true; return; }
  map.flyToBounds(wardShapes[wi].getBounds(), { padding: [30, 30], duration: .6 });
  const w = D.wards[wi];
  panel(`<div class="dp"><span class="eyebrow">Ward ${wi + 1} of 17 · ${w.code}</span><h3 style="margin-top:8px">${esc(w.name)}</h3>
    <div class="sub">Electoral ward, City of Edinburgh <span class="tag real">Real boundary</span></div>
    <div class="gauge"><div><b>${fmt(w.stops)}</b><span>communal bin stops</span></div><div><b>${fmt(w.bins)}</b><span>bins · ${fmt(w.cap_l / 1000)} m³</span></div><div><b>${fmt(w.flagged)}</b><span>flagged tomorrow</span></div><div><b>${fmt(w.pred)}%</b><span>mean forecast</span></div></div>
    <dl class="kv"><dt>Mean fill now</dt><dd>${fmt(w.fill)} %</dd><dt>High overflow risk</dt><dd>${fmt(w.risk)} stops</dd><dt>Over 90 % now</dt><dd>${fmt(w.over90)} stops</dd><dt>Trucks serving it</dt><dd>${w.trucks.length}</dd></dl>
    <h4>Area mix</h4><p class="small" style="margin-top:6px">${Object.entries(w.areas).filter(a => a[1]).map(([a, c]) => `${a}: ${c}`).join(" · ")}</p>
  </div>`);
};
/* ── shift replay: trucks drive their real street routes, bins empty as they are reached ── */
const SIM = { t: 0, end: 0, playing: false, speed: 15, trucks: [], events: [], ptr: 0, emptied: null, layer: null, marks: [], started: false };
function initPlayback() {
  const svc = D.site.fleet.service_min, S = D.S;
  SIM.emptied = new Uint8Array(D.n);
  const kx = 111.32 * Math.cos(55.95 * Math.PI / 180), ky = 110.57;
  const dist = (a, b) => Math.hypot((a[1] - b[1]) * kx, (a[0] - b[0]) * ky);
  SIM.trucks = D.trucks.map(t => {
    let t0 = 0; const trips = [];
    for (const tr of t.trips) {
      const pts = decode(tr.line), cum = [0];
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + dist(pts[k - 1], pts[k]));
      const total = cum[cum.length - 1] || 1;
      const driveMin = tr.drive_min ?? (tr.straight_km / D.site.fleet.speed_kmh * 60);
      // place each stop on the street line (nearest vertex, never going backwards)
      let j0 = 0; const stops = [];
      tr.stops.forEach((i, k) => {
        const p = [S.lat[i], S.lon[i]]; let best = j0, bd = Infinity;
        for (let j = j0; j < pts.length; j++) { const d = dist(p, pts[j]); if (d < bd) { bd = d; best = j; } }
        j0 = best;
        const tArr = t0 + cum[best] / total * driveMin + k * svc;
        stops.push({ i, d: cum[best], tArr, tDep: tArr + svc });
        SIM.events.push([tArr, i]);
      });
      const dur = driveMin + tr.stops.length * svc;
      trips.push({ pts, cum, total, t0, t1: t0 + dur, driveMin, stops, road: tr.road_km || 0 });
      t0 += dur;
    }
    return { trips, end: t0, color: t.color, id: t.truck };
  });
  SIM.events.sort((a, b) => a[0] - b[0]);
  SIM.end = Math.ceil(Math.max(...SIM.trucks.map(t => t.end)) / 10) * 10 + 10;
  SIM.totalL = SIM.events.reduce((a, [, i]) => a + S.cap[i] * Math.min(S.pred[i], 100) / 100, 0);
  // truck markers
  const canvas = L.canvas({ padding: .3 });
  // trails: the road each truck has already covered, growing as the shift plays
  SIM.trails = SIM.trucks.map(tk => L.polyline([], { renderer: canvas, color: tk.color, weight: 3.2, opacity: .9, lineCap: "round", interactive: false }).addTo(map));
  SIM.layer = L.layerGroup().addTo(map);
  SIM.marks = SIM.trucks.map((tk, ti) => {
    const m = L.circleMarker([D.site.depot.latitude, D.site.depot.longitude], { renderer: canvas, radius: 7, color: "#fff", weight: 2.2, fillColor: tk.color, fillOpacity: 1 });
    m.bindTooltip(() => truckStatus(ti), { direction: "top", offset: [0, -6] });
    m.on("click", () => BS.focusTruck(ti));
    return m.addTo(SIM.layer);
  });
  // controls
  const range = $("#pbRange");
  $("#pbPlay").onclick = () => SIM.playing ? pause() : play();
  range.oninput = () => { pause(); setT(+range.value / 1000 * SIM.end); };
  $$(".pb-speed button").forEach(b => b.onclick = () => { SIM.speed = +b.dataset.s; $$(".pb-speed button").forEach(x => x.classList.toggle("on", x === b)); });
  // fleet strip: click a truck to follow it
  $("#fleet").innerHTML = `<span class="lbl">Follow a truck</span>` + D.trucks.map((t, ti) => `<button type="button" data-ti="${ti}" title="${t.truck}: ${t.stops.length} stops"><i style="background:${t.color}"></i>${t.truck.replace("EDI-RCV-", "")}<span class="pc" data-pc="${ti}"></span></button>`).join("");
  $$("#fleet button").forEach(b => b.onclick = () => BS.follow(+b.dataset.ti));
  map.on("dragstart", () => { if (UI.follow >= 0) { UI.follow = -1; $$("#fleet button").forEach(b => b.classList.remove("on")); const fb = $("#followBtn"); if (fb) fb.textContent = "Follow this truck through the shift"; } });
  setT(0);
  // start by itself the first time the map is on screen
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  new IntersectionObserver((es, ob) => { if (es.some(e => e.isIntersecting) && !SIM.started && !reduce) { ob.disconnect(); play(); } }, { threshold: .45 }).observe($(".map-shell"));
  BS.play = play; BS.pause = pause; BS.setShiftTime = min => { pause(); setT(min); };
}
function truckPos(tk, t) {
  for (const tr of tk.trips) {
    if (t > tr.t1) continue;
    if (t < tr.t0) break;
    let prevD = 0, prevT = tr.t0, k = 0;
    for (const s of tr.stops) {
      if (t < s.tArr) return { at: along(tr, prevD + (s.d - prevD) * (t - prevT) / Math.max(1e-6, s.tArr - prevT)), state: "driving", next: k, tr };
      if (t <= s.tDep) return { at: along(tr, s.d), state: "emptying", next: k, tr };
      prevD = s.d; prevT = s.tDep; k++;
    }
    return { at: along(tr, prevD + (tr.total - prevD) * (t - prevT) / Math.max(1e-6, tr.t1 - prevT)), state: "to depot", next: k, tr };
  }
  return { at: [D.site.depot.latitude, D.site.depot.longitude], state: t <= 0 ? "at depot" : "done", next: 0 };
}
function along(tr, d) {
  const c = tr.cum; let lo = 0, hi = c.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (c[mid] <= d) lo = mid; else hi = mid; }
  const f = c[hi] > c[lo] ? (d - c[lo]) / (c[hi] - c[lo]) : 0, a = tr.pts[lo], b = tr.pts[hi];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}
function nearestCum(tr, at) {
  // distance along the trip line of the truck's current position (it lies on the line, so the closest vertex is enough)
  let best = 0, bd = Infinity;
  for (let k = 0; k < tr.pts.length; k++) { const d = (tr.pts[k][0] - at[0]) ** 2 + (tr.pts[k][1] - at[1]) ** 2; if (d < bd) { bd = d; best = k; } }
  return tr.cum[best];
}
BS.follow = ti => {
  if (UI.follow === ti) { UI.follow = -1; $$("#fleet button").forEach(b => b.classList.remove("on")); return; }
  UI.follow = ti;
  $$("#fleet button").forEach(b => b.classList.toggle("on", +b.dataset.ti === ti));
  BS.focusTruck(ti, { follow: true });
  if (!SIM.playing) play();
};
function truckStatus(ti) {
  const tk = SIM.trucks[ti], p = truckPos(tk, SIM.t), done = SIM.events.filter(([tt, i]) => tt <= SIM.t && D.S.truck[i] === ti).length;
  const n = D.trucks[ti].stops.length;
  const st = p.state === "emptying" ? `emptying ${esc(D.S.site[p.tr.stops[p.next].i])}` : p.state === "driving" ? `driving to ${esc(D.S.site[p.tr.stops[p.next].i])}` : p.state;
  return `<b>${tk.id}</b> · ${done}/${n} stops<br>${st}`;
}
const clock = m => { const h = 6 + Math.floor(m / 60), mm = Math.floor(m % 60); return String(h % 24).padStart(2, "0") + ":" + String(mm).padStart(2, "0"); };
function setT(t) {
  SIM.t = clamp(t, 0, SIM.end);
  const S = D.S, z = map.getZoom(), r = z < 11.5 ? 2.6 : z < 13 ? 3.6 : z < 15 ? 5 : 7;
  // move the event pointer, restyling only the stops whose state changes
  const ev = SIM.events;
  while (SIM.ptr < ev.length && ev[SIM.ptr][0] <= SIM.t) { const i = ev[SIM.ptr][1]; SIM.emptied[i] = 1; styleStop(i, r); SIM.ptr++; }
  while (SIM.ptr > 0 && ev[SIM.ptr - 1][0] > SIM.t) { SIM.ptr--; const i = ev[SIM.ptr][1]; SIM.emptied[i] = 0; styleStop(i, r); }
  let km = 0, onRoad = 0;
  const drawTrails = Math.abs(SIM.t - (SIM.lastTrail ?? -99)) >= 1.5 || !SIM.playing;
  SIM.trucks.forEach((tk, ti) => {
    const p = truckPos(tk, SIM.t); SIM.marks[ti].setLatLng(p.at);
    if (p.state !== "done" && p.state !== "at depot") onRoad++;
    for (const tr of tk.trips) km += tr.road * clamp((SIM.t - tr.t0) / (tr.t1 - tr.t0), 0, 1);
    if (drawTrails) {
      const lines = [];
      for (const tr of tk.trips) {
        if (SIM.t >= tr.t1) lines.push(tr.pts);
        else if (SIM.t > tr.t0 && p.tr === tr) { const c = tr.cum, dNow = nearestCum(tr, p.at); const part = []; for (let k = 0; k < c.length && c[k] <= dNow; k++) part.push(tr.pts[k]); part.push(p.at); lines.push(part); }
      }
      SIM.trails[ti].setLatLngs(lines);
      const pc = document.querySelector(`[data-pc="${ti}"]`); if (pc) pc.textContent = SIM.t > 0 ? " " + Math.round(100 * SIM.events.filter(([tt, i]) => tt <= SIM.t && D.S.truck[i] === ti).length / D.trucks[ti].stops.length) + "%" : "";
    }
    if (UI.follow === ti && p.state !== "done" && !map._panAnim?._inProgress) {
      // re-centre only when the truck nears the edge of the part of the map the panel doesn't cover
      const pn = $("#panel"), size = map.getSize(), off = !pn.hidden && innerWidth > 640 ? pn.offsetWidth + 28 : 0;
      const pt = map.latLngToContainerPoint(p.at), w = size.x - off, mx = w * .22, my = size.y * .22;
      if (pt.x < mx || pt.x > w - mx || pt.y < my || pt.y > size.y - my - 110) {
        map.panTo(map.unproject(map.project(p.at).add([off / 2, 55])), { animate: true, duration: .5 });
      }
    }
  });
  if (drawTrails) SIM.lastTrail = SIM.t;
  if (UI.follow >= 0 && UI.selTruck === UI.follow && !$("#panel").hidden && $("#followLive")) $("#followLive").innerHTML = truckStatus(UI.follow);
  let litres = 0; for (let k = 0; k < SIM.ptr; k++) { const i = ev[k][1]; litres += S.cap[i] * Math.min(S.pred[i], 100) / 100; }
  const pctDone = SIM.ptr / ev.length * 100;
  $("#pbClock").textContent = clock(SIM.t);
  $("#pbDay").textContent = SIM.t <= 0 ? "Shift starts" : SIM.t >= SIM.end ? "All trucks back" : fmtDate(D.site.forecast_for, { weekday: "short", day: "numeric", month: "short" }) + " · simulated";
  $("#pbRange").value = Math.round(SIM.t / SIM.end * 1000);
  $("#pbStats").innerHTML = `<span><b>${fmt(SIM.ptr)}</b> / ${fmt(ev.length)} stops emptied</span><span><b>${fmt(litres / 1000)}</b> m³ collected</span><span><b>${fmt(km)}</b> km driven</span><span><b>${onRoad}</b> trucks on the road</span><span class="bar"><span style="width:${pctDone}%"></span></span>`;
}
function styleStop(i, r) {
  const m = markers[i]; if (!m || !stopLayer.hasLayer(m)) return;
  if (SIM.emptied[i]) m.setStyle({ fillColor: PAL.f0, color: PAL.accent, weight: 1.6 });
  else { const v = UI.layer === "fill" ? D.S.fill[i] : D.S.pred[i]; m.setStyle({ fillColor: UI.layer === "prob" ? probColor(D.S.prob[i]) : fillColor(v), color: PAL.surface, weight: .6 }); }
}
let raf = 0, last = 0;
function play() {
  SIM.started = true; if (SIM.t >= SIM.end) setT(0);
  SIM.playing = true; $("#pbIcon").setAttribute("d", "M3 1.5h3v11H3zM8 1.5h3v11H8z"); $("#pbPlay").setAttribute("aria-label", "Pause");
  last = performance.now(); cancelAnimationFrame(raf);
  const step = now => {
    if (!SIM.playing) return;
    const dt = Math.min(.5, (now - last) / 1000); last = now;
    setT(SIM.t + dt * SIM.speed);
    if (SIM.t >= SIM.end) { pause(); return; }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}
function pause() { SIM.playing = false; cancelAnimationFrame(raf); $("#pbIcon").setAttribute("d", "M3 1.5v11l9-5.5z"); $("#pbPlay").setAttribute("aria-label", "Play tomorrow's collection"); }

BS.highlightStops = ids => {
  highlight.clearLayers();
  ids.slice(0, 400).forEach(i => L.circleMarker([D.S.lat[i], D.S.lon[i]], { radius: 9, color: PAL.ink, weight: 1.6, fill: false, interactive: false }).addTo(highlight));
  if (ids.length) map.flyToBounds(L.latLngBounds(ids.map(i => [D.S.lat[i], D.S.lon[i]])).pad(.2), { maxZoom: 16, duration: .6 });
};

/* ── console toolbar + tabs ──────────────────────── */
function initConsole() {
  const s = D.site, p = s.plan, t = s.totals;
  $("#consoleKpis").innerHTML = [
    [fmt(t.stops), "stops monitored"], [fmt(p.flagged), "flagged for tomorrow"], [`${p.trucks_used} / ${p.trips}`, "trucks / trips"],
    [fmt(p.solver_km) + " km", "planned distance"], [fmt(p.load_l / 1000) + " m³", "waste to collect"], [fmt(p.co2_kg) + " kg", "CO₂ from driving"],
  ].map(([b, s]) => `<div class="ck"><b>${b}</b><span>${s}</span></div>`).join("");
  const ws = $("#wardSel");
  D.wards.map((w, i) => [w, i]).sort((a, b) => a[0].name.localeCompare(b[0].name)).forEach(([w, i]) => ws.insertAdjacentHTML("beforeend", `<option value="${i}">${esc(w.name)} (${w.stops})</option>`));
  ws.onchange = () => BS.focusWard(+ws.value);
  $("#layerSel").onchange = async e => { UI.layer = e.target.value; await showNetwork(UI.layer === "net"); restyleStops(); };
  $("#routesChk").onchange = e => { UI.routes = e.target.checked; restyleStops(); };
  $("#flagChk").onchange = e => { UI.flagOnly = e.target.checked; restyleStops(); renderBins(); };
  // search
  const inp = $("#search"), sug = $("#suggest");
  let items = [], cur = -1;
  const pick = it => { sug.hidden = true; inp.value = it.label; if (it.type === "stop") BS.focusStop(it.i); else if (it.type === "street") { const ids = D.streets.get(it.name); ids.length === 1 ? BS.focusStop(ids[0]) : (BS.highlightStops(ids), streetPanel(it.name)); } else if (it.type === "ward") BS.focusWard(it.i); else if (it.type === "truck") BS.focusTruck(it.i); binQuery = it.type === "street" ? it.name : ""; renderBins(); };
  inp.oninput = () => {
    const q = inp.value.trim().toLowerCase(); cur = -1;
    if (q.length < 2) { sug.hidden = true; return; }
    items = BS.searchAll(q, 9);
    sug.innerHTML = items.map((it, k) => `<button type="button" data-k="${k}">${esc(it.label)}<small>${esc(it.hint)}</small></button>`).join("") || `<button type="button" disabled>No match. Try a street name such as “Easter Road”.</button>`;
    sug.hidden = false;
    $$("button[data-k]", sug).forEach(b => b.onclick = () => pick(items[+b.dataset.k]));
  };
  inp.onkeydown = e => {
    if (sug.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); cur = clamp(cur + (e.key === "ArrowDown" ? 1 : -1), 0, items.length - 1); $$("button", sug).forEach((b, k) => b.classList.toggle("on", k === cur)); }
    if (e.key === "Enter" && items.length) { e.preventDefault(); pick(items[Math.max(cur, 0)]); }
    if (e.key === "Escape") sug.hidden = true;
  };
  document.addEventListener("click", e => { if (!e.target.closest(".grow")) sug.hidden = true; });
  // tabs
  $$("#ctabs button").forEach(b => b.onclick = () => BS.openTab(b.dataset.tab));
  renderBins(); renderRoutes(); renderWards(); renderAlerts(); drawWeather();
}
function streetPanel(name) {
  const ids = D.streets.get(name), S = D.S;
  const fl = ids.filter(i => S.flag[i]).length;
  panel(`<div class="dp"><span class="eyebrow">Street</span><h3 style="margin-top:8px">${esc(name)}</h3><div class="sub">${ids.length} communal bin stops · ${esc([...new Set(ids.map(i => D.wards[S.ward[i]].name))].join(", "))}</div>
    <div class="gauge"><div><b>${fmt(ids.reduce((a, i) => a + S.pred[i], 0) / ids.length)}%</b><span>mean forecast</span></div><div><b>${fl}</b><span>flagged tomorrow</span></div></div>
    <div class="manifest" style="max-height:none"><ol>${ids.sort((a, b) => S.pred[b] - S.pred[a]).map(i => `<li data-i="${i}"><span class="o">${fmt(S.pred[i])}%</span><span>${esc(S.loc[i] || S.id[i])}</span><span>${S.truck[i] >= 0 ? D.trucks[S.truck[i]].truck.replace("EDI-", "") : ""}</span></li>`).join("")}</ol></div></div>`);
  $$("#panel li[data-i]").forEach(li => li.onclick = () => BS.focusStop(+li.dataset.i));
}
BS.searchAll = (q, limit = 8) => {
  q = q.toLowerCase().trim(); const out = [];
  const idm = q.match(/edi-?(\d{4,})/i);
  if (idm) { const i = D.idx.get("EDI-" + idm[1]); if (i != null) out.push({ type: "stop", i, label: D.S.id[i], hint: D.S.site[i] }); }
  D.wards.forEach((w, i) => { if (w.name.toLowerCase().includes(q)) out.push({ type: "ward", i, label: w.name, hint: `ward · ${w.stops} stops` }); });
  const tm = q.match(/(?:truck|rcv)[\s-]*0?(\d{1,2})/);
  if (tm) { const ti = D.trucks.findIndex(t => t.truck.endsWith("-" + tm[1].padStart(2, "0"))); if (ti >= 0) out.push({ type: "truck", i: ti, label: D.trucks[ti].truck, hint: `${D.trucks[ti].stops.length} stops` }); }
  const starts = [], contains = [];
  for (const name of D.streetNames) { const l = name.toLowerCase(); if (l.startsWith(q)) starts.push(name); else if (l.includes(q)) contains.push(name); }
  for (const name of starts.concat(contains)) { if (out.length >= limit) break; const ids = D.streets.get(name); out.push({ type: "street", name, label: name, hint: `${ids.length} stop${ids.length > 1 ? "s" : ""} · ${D.wards[D.S.ward[ids[0]]].name}` }); }
  return out.slice(0, limit);
};
BS.openTab = tab => { $$("#ctabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab)); $$(".tabpane").forEach(p => p.hidden = p.id !== "pane-" + tab); if (tab === "weather") drawWeather(); };

let binSort = { k: "pred", dir: -1 }, binPage = 0, binQuery = "";
function renderBins() {
  const S = D.S, host = $("#pane-bins");
  let ids = []; for (let i = 0; i < D.n; i++) if (stopVisible(i) && (!binQuery || S.site[i] === binQuery)) ids.push(i);
  const key = { pred: i => S.pred[i], fill: i => S.fill[i], prob: i => S.prob[i], prio: i => S.prio[i], cap: i => S.cap[i], site: i => S.site[i], ward: i => D.wards[S.ward[i]].name }[binSort.k];
  ids.sort((a, b) => { const x = key(a), y = key(b); return (x > y ? 1 : x < y ? -1 : 0) * binSort.dir; });
  const per = 25, pages = Math.max(1, Math.ceil(ids.length / per)); binPage = clamp(binPage, 0, pages - 1);
  const rows = ids.slice(binPage * per, binPage * per + per);
  const th = (k, l, n) => `<th class="sortable ${n ? "n" : ""}" data-k="${k}">${l}${binSort.k === k ? (binSort.dir < 0 ? " ↓" : " ↑") : ""}</th>`;
  const bar = (v, c) => `<span class="bar-cell">${fmt(v)}%<span class="bar"><span style="width:${v}%;background:${c}"></span></span></span>`;
  host.innerHTML = `<div class="tablewrap"><table><thead><tr>${th("site", "Street")}<th>Location</th>${th("ward", "Ward")}${th("cap", "Capacity", 1)}${th("fill", "Now", 1)}${th("pred", "Tomorrow", 1)}${th("prob", "Risk", 1)}${th("prio", "Priority", 1)}<th>Truck</th></tr></thead><tbody>
    ${rows.map(i => `<tr data-i="${i}"><td><b>${esc(S.site[i])}</b></td><td class="muted" style="max-width:240px;overflow:hidden;text-overflow:ellipsis">${esc(S.loc[i])}</td><td>${esc(D.wards[S.ward[i]].name)}</td><td class="n">${fmt(S.cap[i])} L</td><td class="n">${bar(S.fill[i], fillColor(S.fill[i]))}</td><td class="n">${bar(S.pred[i], fillColor(S.pred[i]))}</td><td class="n">${fmt(S.prob[i] * 100)}%</td><td class="n">${fmt(S.prio[i], 1)}</td><td class="mono">${S.truck[i] >= 0 ? D.trucks[S.truck[i]].truck.replace("EDI-", "") : "–"}</td></tr>`).join("")}
  </tbody></table></div><div class="pager"><span>${fmt(ids.length)} stops${binQuery ? ` on ${esc(binQuery)} <button class="linkbtn" id="clearQ">show all</button>` : ""}${UI.ward >= 0 ? " in " + esc(D.wards[UI.ward].name) : ""} · simulated fill</span><span><button id="pgPrev" ${binPage ? "" : "disabled"}>Previous</button> ${binPage + 1} / ${pages} <button id="pgNext" ${binPage < pages - 1 ? "" : "disabled"}>Next</button></span></div>`;
  $$("th.sortable", host).forEach(t => t.onclick = () => { binSort = { k: t.dataset.k, dir: binSort.k === t.dataset.k ? -binSort.dir : -1 }; renderBins(); });
  $$("tbody tr", host).forEach(tr => tr.onclick = () => { BS.focusStop(+tr.dataset.i); $(".map-shell").scrollIntoView({ block: "center" }); });
  $("#pgPrev").onclick = () => { binPage--; renderBins(); }; $("#pgNext").onclick = () => { binPage++; renderBins(); };
  $("#clearQ") && ($("#clearQ").onclick = () => { binQuery = ""; renderBins(); });
}
function renderRoutes() {
  const host = $("#pane-routes");
  host.innerHTML = `<div class="trucks"><div class="truck-list" id="truckList">${D.trucks.map((t, ti) => `<button type="button" data-ti="${ti}"><i style="background:${t.color}"></i><span><b>${t.truck}</b><br><span class="muted small">${t.stops.length} stops · ${t.trips.length} trips</span></span><span class="mono small">${fmt(t.km, 1)} km</span></button>`).join("")}</div><div class="card driver" id="driverView"></div></div>`;
  $$("#truckList button").forEach(b => b.onclick = () => selectTruckInList(+b.dataset.ti, true));
  selectTruckInList(0);
}
function selectTruckInList(ti, fly) {
  $$("#truckList button").forEach(b => b.classList.toggle("on", +b.dataset.ti === ti));
  const t = D.trucks[ti], S = D.S;
  let k = 0;
  const trips = t.trips.map((tr, n) => `<li class="depot"><span class="o">↺</span><span>${n ? "Tip at Seafield, start trip " + (n + 1) : "Leave Seafield depot, trip 1"}</span><span></span></li>` +
    tr.stops.map(i => `<li data-i="${i}"><span class="o">${++k}</span><span><b>${esc(S.site[i])}</b><br><span class="muted small">${esc(S.loc[i])}</span></span><span class="mono small">${fmt(S.pred[i])}%</span></li>`).join("")).join("") + `<li class="depot"><span class="o">■</span><span>Return to Seafield depot</span><span></span></li>`;
  $("#driverView").innerHTML = `<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline"><div><span class="eyebrow" style="color:${t.color}">Driver view</span><h3 style="font-size:22px;margin-top:6px">${t.truck} · ${esc(t.driver)}</h3></div><button class="btn ghost" type="button" id="showOnMap" style="padding:7px 14px">Show on map</button></div>
    <p class="muted small" style="margin-top:6px">${t.stops.length} stops in ${t.trips.length} trips · ${fmt(t.km, 1)} km planned, ${fmt(t.road, 1)} km on real streets · ${fmt(t.load)} L of waste</p>
    <div class="manifest"><ol>${trips}</ol></div>`;
  $$("#driverView li[data-i]").forEach(li => li.onclick = () => { BS.focusStop(+li.dataset.i, { keepTruck: true }); $(".map-shell").scrollIntoView({ block: "center" }); });
  $("#showOnMap").onclick = () => { BS.focusTruck(ti); $(".map-shell").scrollIntoView({ block: "center" }); };
  if (fly) BS.focusTruck(ti);
}
let wardSort = { k: "flagged", dir: -1 };
function renderWards() {
  const host = $("#pane-wards");
  const rows = D.wards.map((w, i) => ({ ...w, i })).sort((a, b) => ((a[wardSort.k] > b[wardSort.k]) - (a[wardSort.k] < b[wardSort.k])) * wardSort.dir);
  const max = Math.max(...D.wards.map(w => w.stops));
  const th = (k, l, n) => `<th class="sortable ${n ? "n" : ""}" data-k="${k}">${l}${wardSort.k === k ? (wardSort.dir < 0 ? " ↓" : " ↑") : ""}</th>`;
  host.innerHTML = `<div class="tablewrap"><table><thead><tr>${th("name", "Ward")}${th("stops", "Stops", 1)}${th("bins", "Bins", 1)}${th("cap_l", "Capacity", 1)}${th("fill", "Mean now", 1)}${th("pred", "Mean tomorrow", 1)}${th("flagged", "Flagged", 1)}${th("risk", "High risk", 1)}<th class="n">Trucks</th></tr></thead><tbody>
    ${rows.map(w => `<tr data-i="${w.i}"><td><b>${esc(w.name)}</b> <span class="muted mono small">${w.code}</span></td><td class="n"><span class="bar-cell">${w.stops}<span class="bar"><span style="width:${w.stops / max * 100}%;background:var(--accent)"></span></span></span></td><td class="n">${fmt(w.bins)}</td><td class="n">${fmt(w.cap_l / 1000)} m³</td><td class="n">${fmt(w.fill)}%</td><td class="n">${fmt(w.pred)}%</td><td class="n">${fmt(w.flagged)}</td><td class="n">${fmt(w.risk)}</td><td class="n">${w.trucks.length}</td></tr>`).join("")}</tbody></table></div>
    <p class="note">Ward boundaries: ONS Wards (December 2024), Edinburgh’s 17 multi-member wards. Stop counts and capacities are real; fill levels are simulated.</p>`;
  $$("th.sortable", host).forEach(t => t.onclick = () => { wardSort = { k: t.dataset.k, dir: wardSort.k === t.dataset.k ? -wardSort.dir : -1 }; renderWards(); });
  $$("tbody tr", host).forEach(tr => tr.onclick = () => { BS.focusWard(+tr.dataset.i); $(".map-shell").scrollIntoView({ block: "center" }); });
}
function renderAlerts() {
  const S = D.S, host = $("#pane-alerts");
  const over = [], unserved = [], lowbat = [];
  for (let i = 0; i < D.n; i++) { if (S.fill[i] >= 80) over.push(i); if (S.flag[i] && S.truck[i] < 0) unserved.push(i); if (S.bat[i] < 80) lowbat.push(i); }
  over.sort((a, b) => S.fill[b] - S.fill[a]); lowbat.sort((a, b) => S.bat[a] - S.bat[b]);
  const list = (ids, f) => `<div class="manifest" style="max-height:300px"><ol>${ids.slice(0, 60).map(i => `<li data-i="${i}"><span class="o">${f(i)}</span><span><b>${esc(S.site[i])}</b><br><span class="muted small">${esc(D.wards[S.ward[i]].name)}</span></span><span></span></li>`).join("")}</ol></div>`;
  // battery histogram
  const bins = new Array(6).fill(0); S.bat.forEach(b => bins[clamp(Math.floor((b - 70) / 5), 0, 5)]++);
  const mx = Math.max(...bins);
  host.innerHTML = `<div class="mini-grid">
    <div class="card"><h4 style="font-size:16px">At 80 % or more right now</h4><p class="muted small">${fmt(over.length)} stops already past the collection line. Crews should check these first.</p>${list(over, i => fmt(S.fill[i]) + "%")}</div>
    <div class="card"><h4 style="font-size:16px">Flagged but not routed</h4><p class="muted small">${fmt(unserved.length)} stops the fleet could not fit tomorrow.</p>${unserved.length ? list(unserved, i => fmt(S.pred[i]) + "%") : `<p style="margin-top:14px">None. Every flagged stop is on a route.</p>`}</div>
    <div class="card"><h4 style="font-size:16px">Sensor batteries <span class="tag sim">Sim</span></h4><p class="muted small">${fmt(lowbat.length)} sensors below 80 % for the maintenance team.</p>
      <svg class="chart" viewBox="0 0 300 130" style="margin-top:12px">${bins.map((c, k) => `<rect x="${10 + k * 48}" y="${105 - c / mx * 90}" width="38" height="${c / mx * 90}" rx="3" fill="${k < 2 ? PAL.f[3] : PAL.accent}" opacity=".85"/><text x="${29 + k * 48}" y="122" text-anchor="middle">${70 + k * 5}–${75 + k * 5}</text><text class="val" x="${29 + k * 48}" y="${100 - c / mx * 90}" text-anchor="middle">${c}</text>`).join("")}</svg>
      ${list(lowbat.slice(0, 20), i => fmt(S.bat[i]) + "%")}</div></div>`;
  $$("li[data-i]", host).forEach(li => li.onclick = () => { BS.focusStop(+li.dataset.i); $(".map-shell").scrollIntoView({ block: "center" }); });
}
function drawWeather() {
  const host = $("#pane-weather"); if (!host || host.hidden && host.dataset.done) return;
  const w = D.site.weather, n = w.temp.length, W = 1000, H = 260, pl = 40, pr = 16, pt = 16, pb = 34;
  const t0 = new Date(w.start), histN = D.site.weather.temp.length - 24;
  const x = k => pl + k / (n - 1) * (W - pl - pr);
  const tmin = Math.floor(Math.min(...w.temp) / 2) * 2, tmax = Math.ceil(Math.max(...w.temp) / 2) * 2;
  const yT = v => pt + (tmax - v) / (tmax - tmin) * (H - pt - pb);
  const rmax = Math.max(2, Math.ceil(Math.max(...w.rain)));
  const yR = v => H - pb - v / rmax * (H - pt - pb) * .55;
  const days = []; for (let k = 0; k < n; k += 24) days.push(k);
  const line = w.temp.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${yT(v).toFixed(1)}`).join("");
  const total = w.rain.slice(0, histN).reduce((a, b) => a + b, 0), wet = w.rain.slice(0, histN).filter(v => v > 0).length;
  const mean = w.temp.slice(0, histN).reduce((a, b) => a + b, 0) / histN;
  host.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;align-items:baseline"><h3 style="font-size:20px">Edinburgh weather that drove the simulation <span class="tag real">Real</span></h3><span class="muted small">${esc(w.source)}</span></div>
    <div class="consolekpis" style="margin-top:14px;grid-template-columns:repeat(4,minmax(0,1fr))"><div class="ck"><b>${fmt(mean, 1)} °C</b><span>mean temperature</span></div><div class="ck"><b>${fmt(Math.min(...w.temp.slice(0, histN)), 1)} / ${fmt(Math.max(...w.temp.slice(0, histN)), 1)} °C</b><span>min / max</span></div><div class="ck"><b>${fmt(total, 1)} mm</b><span>total rain</span></div><div class="ck"><b>${wet} h</b><span>hours with rain</span></div></div>
    <div style="overflow-x:auto"><svg class="chart" viewBox="0 0 ${W} ${H}" style="min-width:640px">
      ${[tmin, (tmin + tmax) / 2, tmax].map(v => `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${yT(v)}" y2="${yT(v)}"/><text x="${pl - 6}" y="${yT(v) + 4}" text-anchor="end">${fmt(v)}°</text>`).join("")}
      <rect x="${x(histN)}" y="${pt}" width="${x(n - 1) - x(histN)}" height="${H - pt - pb}" fill="${PAL.accent}" opacity=".07"/>
      <text x="${x(histN) + 6}" y="${pt + 12}" style="fill:${PAL.accent}">forecast day</text>
      ${w.rain.map((v, k) => v > 0 ? `<rect x="${x(k) - 1}" y="${yR(v)}" width="2.4" height="${H - pb - yR(v)}" fill="${PAL.f[1]}"/>` : "").join("")}
      <path d="${line}" fill="none" stroke="${PAL.ink}" stroke-width="1.5"/>
      ${days.filter((_, j) => j % 3 === 0).map(k => { const d = new Date(t0.getTime() + k * 3600e3); return `<text x="${x(k)}" y="${H - 12}" text-anchor="middle">${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</text>`; }).join("")}
    </svg></div>
    <p class="note">Line: hourly temperature. Bars: rain per hour (up to ${rmax} mm). Rain slightly slows how fast bins fill in the model; bank holidays and weekends speed it up.</p></div>`;
  host.dataset.done = 1;
}

/* ── results ─────────────────────────────────────── */
const METRICS = [
  ["Overflow_Bin_Hours", "Overflow bin-hours", "Hours that bins spent at 80 % or more, per day", true],
  ["Overflow_Events", "Overflow events", "Times a bin crossed 80 %, per day", true],
  ["Distance_km", "Distance (km)", "Kilometres driven per day", true],
  ["Bins_Collected", "Stops emptied", "Stops emptied per day", null],
  ["Unnecessary_Collections", "Emptied under 40 %", "Stops emptied while under 40 % full, per day", true],
  ["Mean_Fill_at_Collection", "Fill when emptied (%)", "Average fill level when a stop is emptied", null],
  ["CO2_kg", "CO₂ (kg)", "Diesel CO₂ per day", true],
];
const STRAT_LABEL = { Fixed: "Fixed rota (every 3rd day)", Reactive: "Reactive (fill now ≥ 80 %)", Predictive: "Predictive (forecast ≥ 80 %)", "Full EcoBin": "Predictive + priority score" };
function initResults() {
  const ex = D.site.experiments, mf = ex.manifest;
  let metric = 0;
  $("#metricPills").innerHTML = METRICS.map((m, k) => `<button type="button" data-k="${k}" class="${k ? "" : "on"}">${m[1]}</button>`).join("");
  const draw = () => {
    const [key, label, desc] = METRICS[metric];
    const rows = ["Fixed", "Reactive", "Predictive", "Full EcoBin"].map(s => ex.aggregate.find(r => r.Strategy === s)).filter(Boolean);
    const vals = rows.map(r => r[key + "_mean"]), sds = rows.map(r => r[key + "_std"] || 0);
    const max = Math.max(...vals.map((v, k) => v + sds[k])) * 1.08;
    const W = 640, x0 = 200, bw = W - x0 - 70;
    $("#stratChart").innerHTML = `<text x="${x0}" y="14">${esc(desc)}</text>` + rows.map((r, k) => {
      const y = 34 + k * 52, w = vals[k] / max * bw, sw = sds[k] / max * bw;
      const best = r.Strategy === "Predictive" || r.Strategy === "Full EcoBin";
      return `<text class="lbl" x="${x0 - 12}" y="${y + 19}" text-anchor="end">${esc(STRAT_LABEL[r.Strategy])}</text>
        <rect x="${x0}" y="${y + 4}" width="${Math.max(2, w)}" height="24" rx="4" fill="${best ? PAL.accent : PAL.ink3}" opacity="${best ? 1 : .55}"/>
        ${sw > 1 ? `<line x1="${x0 + w - sw}" x2="${x0 + w + sw}" y1="${y + 16}" y2="${y + 16}" stroke="${PAL.ink}" stroke-width="1.2"/><line x1="${x0 + w + sw}" x2="${x0 + w + sw}" y1="${y + 11}" y2="${y + 21}" stroke="${PAL.ink}" stroke-width="1.2"/>` : ""}
        <text class="val" x="${x0 + w + Math.max(sw, 0) + 8}" y="${y + 21}">${fmt(vals[k], key.includes("Fill") ? 1 : 0)}</text>`;
    }).join("");
    $("#stratNote").textContent = `Mean per day over ${mf.configuration.days} replayed test days × ${mf.configuration.seeds} random seeds (“${mf.environment}” run), with ±1 standard deviation. Same 4,533 stops, same 24 trucks, simulated fill.`;
    $$("#metricPills button").forEach(b => b.classList.toggle("on", +b.dataset.k === metric));
  };
  $$("#metricPills button").forEach(b => b.onclick = () => { metric = +b.dataset.k; draw(); });
  draw();
  const F = strat("Fixed"), P = strat("Predictive"), R = strat("Reactive");
  $("#takeaways").innerHTML = [
    [`−${fmt(100 * (1 - P.Overflow_Bin_Hours_mean / F.Overflow_Bin_Hours_mean))} %`, `overflow bin-hours with forecast-driven collection compared with the fixed rota (${fmt(P.Overflow_Bin_Hours_mean)} vs ${fmt(F.Overflow_Bin_Hours_mean)} a day).`],
    [`${P.Distance_km_mean >= F.Distance_km_mean ? "+" : "−"}${fmt(Math.abs(100 * (P.Distance_km_mean / F.Distance_km_mean - 1)))} %`, `distance driven. The predictive plan drives ${fmt(P.Distance_km_mean)} km a day against ${fmt(F.Distance_km_mean)} km, but visits the stops that need it.`],
    [`${fmt(F.Unnecessary_Collections_mean)} → ${fmt(P.Unnecessary_Collections_mean, 1)}`, `stops a day emptied while under 40 % full. Reacting to current fill alone waits until bins average ${fmt(R.Mean_Fill_at_Collection_mean)} % and overflows ${fmt(R.Overflow_Events_mean)} times a day.`],
  ].map(([b, p]) => `<div class="card takeaway"><b>${b}</b><p>${p}</p></div>`).join("");
  // model table
  const res = D.site.model.results;
  const names = Object.keys(res);
  $("#modelTable").innerHTML = `<thead><tr><th>Model</th><th class="n">MAE</th><th class="n">RMSE</th><th class="n">R²</th><th class="n">F1 at 80 %</th></tr></thead><tbody style="cursor:default">` +
    names.map(n => `<tr><td>${n === D.site.model.name ? "<b>" + esc(n) + "</b>" : esc(n)}</td><td class="n">${fmt(res[n].MAE, 2)}</td><td class="n">${fmt(res[n].RMSE, 2)}</td><td class="n">${fmt(res[n].R2, 3)}</td><td class="n">${fmt(res[n].F1, 3)}</td></tr>`).join("") + "</tbody>";
  const rs = D.site.model.residual;
  $("#modelNote").textContent = `Errors are in fill-level percentage points. Residual mean ${fmt(rs.residual_mean, 2)}, Brier score for the overflow probability ${fmt(rs.brier_score, 4)}. Accuracy is measured on simulated data, so it is optimistic: real sensor data would be noisier.`;
  // reality check
  const p = D.site.plan, f = D.site.fleet;
  const lift = p.served * f.service_min / 60, drive = p.solver_km / f.speed_kmh, per = (lift + drive) / p.trucks_used;
  $("#realityText").innerHTML = `The optimised plan sends ${p.trucks_used} trucks to ${fmt(p.served)} stops. At ${f.service_min} minutes a stop that is <b>${fmt(lift)} hours</b> of lifting plus <b>${fmt(drive)} hours</b> of driving: about <b>${fmt(per, 1)} hours per truck</b>, against an 8-hour shift. The solver, like EcoBin’s, has no shift-length limit. A real deployment needs a time constraint, more crews, or faster lifts.`;
  // ablation
  const ab = ex.ablation.concat(ex.sensitivity);
  const pretty = v => ({ Only_Forecasting: "Forecast only (weight 1.0, so collects at ≥ 75 %)", Forecast_and_Uncertainty: "Forecast + overflow probability", Full_EcoBin_Proposed: "Forecast + probability + location (proposed)" }[v] || v.replace(/^w_(\d)_(\d)_(\d)$/, (_, a, b, c) => `Weights ${a / 10} / ${b / 10} / ${c / 10}`));
  $("#ablationTable").innerHTML = `<thead><tr><th>Variant</th><th class="n">Distance km</th><th class="n">Overflow bin-h</th><th class="n">Overflow events</th><th class="n">Stops emptied</th><th class="n">Under 40 %</th></tr></thead><tbody style="cursor:default">` +
    ab.map(r => `<tr><td>${esc(pretty(r.Variant))}</td><td class="n">${fmt(r.Distance_km_mean)}</td><td class="n">${fmt(r.Overflow_Bin_Hours_mean)}</td><td class="n">${fmt(r.Overflow_Events_mean)}</td><td class="n">${fmt(r.Bins_Collected_mean)}</td><td class="n">${fmt(r.Unnecessary_Collections_mean, 1)}</td></tr>`).join("") + "</tbody>";
  const spread = ex.sensitivity.map(r => r.Overflow_Bin_Hours_mean);
  const fo = ex.ablation.find(r => r.Variant === "Only_Forecasting"), fu = ex.ablation.find(r => r.Variant === "Full_EcoBin_Proposed");
  $("#ablationNote").textContent = (fo && fu ? `The forecast-only variant gives the forecast weight 1.0, so in practice it collects every stop forecast at 75 % or more. It empties ${fmt(fo.Bins_Collected_mean - fu.Bins_Collected_mean)} more stops a day and cuts overflow bin-hours by ${fmt(100 * (1 - fo.Overflow_Bin_Hours_mean / fu.Overflow_Bin_Hours_mean))} %, for ${fmt(100 * (fo.Distance_km_mean / fu.Distance_km_mean - 1))} % more driving. ` : "") +
    `Across the weight settings, overflow bin-hours stay between ${fmt(Math.min(...spread))} and ${fmt(Math.max(...spread))}: the threshold matters far more than the weights. On simulated data the overflow probability is almost always 0 or 1, so the risk term adds little; with noisier real data it should matter more.`;
}

/* ── planner ─────────────────────────────────────── */
BS.planCalc = ({ thr = 80, fleet = 24, shift = 8, svc = 10, speed = 30, prio = true } = {}) => {
  const S = D.S, sel = []; let litres = 0, missP = 0;
  for (let i = 0; i < D.n; i++) {
    if (S.pred[i] >= thr || (prio && S.prio[i] >= 75)) { sel.push(i); litres += S.cap[i] * Math.min(S.pred[i], 100) / 100; }
    else missP += S.prob[i];
  }
  const trips = Math.ceil(litres / (D.R.capacity_l * D.bhh.util));
  const g = geomOf(sel);
  const km = sel.length ? 2 * trips * g.rbar + D.bhh.k * Math.sqrt(sel.length * g.area) : 0;
  const lift = sel.length * svc / 60, drive = km / speed, need = lift + drive, have = fleet * shift;
  const tripsMax = fleet * D.R.trips_per_truck;
  const trucksNeeded = Math.max(Math.ceil(need / shift), Math.ceil(trips / D.R.trips_per_truck));
  return { thr, fleet, shift, svc, speed, prio, sel, n: sel.length, litres, missP, trips, g, km, co2: km * .3 * 2.68, lift, drive, need, have, tripsMax, trucksNeeded, ok: need <= have && trips <= tripsMax };
};
function initPlanner() {
  const ids = ["pThr", "pFleet", "pShift", "pSvc", "pSpeed", "pPrio"];
  const upd = () => {
    const thr = +$("#pThr").value, fleet = +$("#pFleet").value, shift = +$("#pShift").value, svc = +$("#pSvc").value, speed = +$("#pSpeed").value, prio = $("#pPrio").checked;
    $("#oThr").textContent = thr + " %"; $("#oFleet").textContent = fleet; $("#oShift").textContent = shift.toFixed(1) + " h"; $("#oSvc").textContent = svc + " min"; $("#oSpeed").textContent = speed + " km/h";
    const { sel, litres, missP, trips, g, km, lift, drive, need, have, tripsMax, trucksNeeded, ok } = BS.planCalc({ thr, fleet, shift, svc, speed, prio });
    $("#planOut").innerHTML = [
      [fmt(sel.length), "stops to empty"], [fmt(litres / 1000) + " m³", "waste to collect"], [fmt(trips), "truck loads"],
      [fmt(km) + " km", "estimated distance"], [fmt(km * .3 * 2.68) + " kg", "CO₂ from diesel"], [fmt(missP, 1), "stops expected past 80 % but skipped"],
    ].map(([b, s]) => `<div class="po"><b>${b}</b><span>${s}</span></div>`).join("");
    const pc = v => clamp(v / Math.max(need, have) * 100, 0, 100);
    $("#planHours").innerHTML = `<div class="track"><span class="seg2" style="left:0;width:${pc(lift)}%;background:var(--ink)"></span><span class="seg2" style="left:${pc(lift)}%;width:${pc(drive)}%;background:var(--f2)"></span><span class="cap" style="left:${pc(have)}%"></span></div>
      <div class="keys"><span><i style="background:var(--ink)"></i>Lifting ${fmt(lift)} h</span><span><i style="background:var(--f2)"></i>Driving ${fmt(drive)} h</span><span><i style="background:var(--ink);width:2px"></i>Fleet time ${fmt(have)} h (${fleet} × ${shift} h)</span></div>`;
    $("#planFeas").className = "feas " + (ok ? "ok" : "no");
    $("#planFeas").innerHTML = ok
      ? `<span>✓</span><span><b>Feasible.</b> ${fleet} trucks have ${fmt(have)} crew-hours for ${fmt(need)} hours of work (${fmt(need / have * 100)} % used) and ${tripsMax} trip slots for ${trips} loads.</span>`
      : `<span>!</span><span><b>Not feasible with ${fleet} trucks.</b> The work needs ${fmt(need)} crew-hours${trips > tripsMax ? ` and ${trips} loads (only ${tripsMax} trip slots)` : ""}. You would need about <b>${trucksNeeded} trucks</b>, a longer shift, or faster lifts.</span>`;
    $("#planNote").textContent = `Distance = 2 × loads × mean depot distance + k·√(n·A), where n is stops, A the area they cover (${fmt(g.area)} km²) and k = ${D.bhh.k.toFixed(3)} fitted so the formula reproduces the optimised plan (${fmt(D.site.plan.solver_km)} km for ${fmt(D.site.plan.served)} stops). Loads assume the plan’s ${fmt(D.bhh.util * 100)} % truck fill.`;
  };
  ids.forEach(id => $("#" + id).addEventListener("input", upd));
  upd();
  BS.planner = (o = {}) => { if (o.thr) $("#pThr").value = o.thr; if (o.fleet) $("#pFleet").value = o.fleet; if (o.shift) $("#pShift").value = o.shift; if (o.svc) $("#pSvc").value = o.svc; if (o.speed) $("#pSpeed").value = o.speed; upd(); };
}

/* ── business ────────────────────────────────────── */
const MODELS = {
  A: ["Sensors and platform subscription", "Councils · core model", ["A one-off fee per sensor, covering hardware and installation on the council’s existing bins.", "An annual platform subscription per connected sensor: software, data, maintenance and battery replacement.", "Hardware as a service: no upfront fee, the sensor cost spread over a higher subscription, for councils with tight capital budgets.", "Route in: a funded pilot through CivTech, Zero Waste Scotland or Innovate UK, then a multi-year procurement contract."]],
  B: ["Pay from savings (gain-share)", "Councils · lowest risk", ["We fit sensors and run the platform at no upfront cost.", "The council pays a fixed share, for example 25 %, of verified collection savings.", "Removes the risk for a cautious, budget-constrained buyer: they pay only if it works.", "Worked example: 100,000 properties → about £362,000 a year for us; the council keeps about £1.09m."]],
  C: ["Licence for private contractors", "Waste companies", ["Contractors buy sensors for the bins they service.", "A monthly licence to run our forecasting and routing engine on their own fleets."]],
  D: ["Sensor subscription for small businesses", "Shops, restaurants, landlords", ["A small monthly fee for a sensor on the business’s own trade-waste bin.", "The platform alerts their existing contractor only when the bin is nearly full: fewer, fuller collections."]],
  E: ["Data and insight reports", "Councils, policymakers, packaging producers", ["Anonymised data on waste volumes, recycling and contamination.", "Sold as reports for service planning and policy."]],
  F: ["Joint offer with the student marketplace", "Universities", ["During move-out, sensors show where and when waste peaks.", "Reusable items are diverted to the student marketplace (Idea 1) instead of the bin: one move-out solution for reuse and monitoring."]],
  G: ["Community reporting rewards", "Residents and local businesses, with the council", ["Residents report full, overflowing or misused bins with a photo and location.", "Verified reports (by sensor data or the crew) earn points for vouchers at local cafés, restaurants and shops.", "The council funds part of the reward pool from savings on complaints; businesses pay a platform fee to sponsor vouchers.", "Misuse controls: only verified reports, a daily limit per user, and only the first report on a bin is rewarded."]],
};
function initBusiness() {
  // partners diagram
  $("#partners").innerHTML = `<h3 style="font-size:20px">Who gets what, who pays</h3>
  <svg viewBox="0 0 520 380" role="img" aria-label="BinSight at the centre with the council, the community and recycling facilities around it">
    <g stroke="${PAL.line2}" stroke-width="1.5" fill="none"><path d="M260 190 L110 80"/><path d="M260 190 L410 80"/><path d="M260 190 L260 320"/></g>
    <circle cx="260" cy="190" r="54" fill="${PAL.ink}"/><text x="260" y="186" text-anchor="middle" style="fill:${PAL.paper};font:700 17px var(--display)">BinSight</text><text x="260" y="205" text-anchor="middle" style="fill:${PAL.paper};font-size:11px;opacity:.8">sensors + platform</text>
    ${[[110, 70, "City of Edinburgh Council", "Model A", "Gets: fewer overflows and complaints,", "lower costs, recycling progress", "Pays: per sensor + annual subscription"],
       [410, 70, "Community", "Model G", "Gets: cleaner streets, vouchers;", "businesses get footfall", "Pays: businesses sponsor vouchers"],
       [260, 320, "Recycling facilities", "e.g. Millerhill", "Gets: arrival forecasts, early", "contamination warnings", "Pays: annual data subscription"]].map(([x, y, a, b, c, d, e]) => `
      <rect x="${x - 112}" y="${y - 42}" width="224" height="${y > 300 ? 92 : 100}" rx="12" fill="${PAL.surface}" stroke="${PAL.line}"/>
      <text x="${x}" y="${y - 20}" text-anchor="middle" style="font-weight:650">${a}</text><text class="t2" x="${x}" y="${y - 4}" text-anchor="middle" style="fill:${PAL.accent}">${b}</text>
      <text class="t2" x="${x}" y="${y + 14}" text-anchor="middle">${c}</text><text class="t2" x="${x}" y="${y + 29}" text-anchor="middle">${d}</text><text class="t2" x="${x}" y="${y + 46}" text-anchor="middle" style="fill:${PAL.ink}">${e}</text>`).join("")}
  </svg>`;
  const tabs = $("#modelTabs"), body = $("#modelBody");
  tabs.innerHTML = Object.keys(MODELS).map(k => `<button type="button" data-m="${k}" aria-label="Model ${k}">${k}</button>`).join("");
  const show = k => { const [t, who, pts] = MODELS[k]; body.innerHTML = `<h3>Model ${k}: ${t}</h3><div class="who">${who}</div><ul>${pts.map(p => `<li>${p}</li>`).join("")}</ul>`; $$("button", tabs).forEach(b => b.classList.toggle("on", b.dataset.m === k)); };
  $$("button", tabs).forEach(b => b.onclick = () => show(b.dataset.m)); show("A");
  BS.showModel = show;
  // calculator
  const calc = () => {
    const P = +$("#cProps").value || 0, C = +$("#cCost").value || 0, s = (+$("#cSave").value || 0) / 100, sh = (+$("#cShare").value || 0) / 100;
    const saving = P * C * s;
    $("#calcRes").innerHTML = `<div><b>£${fmt(saving * sh)}</b><span>BinSight revenue a year (£${fmt(C * s * sh, 2)} per property)</span></div><div><b>£${fmt(saving * (1 - sh))}</b><span>the council keeps (of £${fmt(saving)} saved)</span></div>`;
  };
  ["cProps", "cCost", "cSave", "cShare"].forEach(id => $("#" + id).addEventListener("input", calc)); calc();
  BS.gainShare = (P = 100000, C = 72.35, s = 20, sh = 25) => { const saving = P * C * s / 100; return { saving, binsight: saving * sh / 100, council: saving * (1 - sh / 100), perProperty: C * s / 100 * sh / 100 }; };
  // risks
  const risks = [["Slow public-sector procurement", "Earn early revenue from universities, businesses and contractors; start with a grant-funded campus pilot."],
    ["Bins come in many shapes and sizes", "A universal mounting kit, so the sensor fits existing bins."],
    ["Sensors damaged or vandalised", "Robust, low-cost sensors inside the lid, fitted first where fill varies most."],
    ["Council already uses route-planning software", "Connect through an API rather than compete."],
    ["Data protection (UK GDPR)", "Sensors collect bin-level data only; the resident app collects minimal personal data, with consent."],
    ["Savings not proven locally", "Gain-share: the council pays only when savings are achieved."],
    ["Fake or duplicate reports", "Only verified reports earn points, with daily limits per user."],
    ["Too few businesses sponsor vouchers", "Start with a few partners near the pilot area; the council co-funds rewards at first."],
    ["Recycling facilities unwilling to pay at first", "Free data during the pilot to prove its value."],
    ["Shift time (from our own model)", "Add a working-time constraint to the solver and size the fleet with the planner above."]];
  $("#risks").innerHTML = risks.map(([a, b]) => `<div class="risk"><b>${a}</b><span>${b}</span></div>`).join("");
}

/* ── sources ─────────────────────────────────────── */
const REFS = [
  ["BBC News (2026) ‘Scotland’s recycling rates fall to lowest level in five years’.", ""],
  ["Broughton Spurtle (n.d.) ‘Fewer bins emptied more often’.", "https://broughtonspurtle.org.uk/news/fewer-bins-emptied-more-often"],
  ["Circular Online (n.d.) ‘Edinburgh Fringe Festival to see 500 tonnes of extra glass collected’.", "https://www.circularonline.co.uk/news/edinburgh-fringe-festival-to-see-500-tonnes-of-extra-glass-collected/"],
  ["City of Edinburgh Council (2025a) Environment LGBF 2024/25.", "https://www.edinburgh.gov.uk/downloads/file/40593/environment-lgbf-2024-25"],
  ["City of Edinburgh Council (2025b) Council Budget: Key Facts and Figures 2025–2026.", "https://www.edinburgh.gov.uk/downloads/file/38260/council-budget-key-facts-and-figures-2025--2026"],
  ["City of Edinburgh Council (n.d.-a) Smart bin sensors.", "https://www.edinburgh.gov.uk/bins-recycling/smart-bin-sensors/1"],
  ["City of Edinburgh Council (n.d.-b) Communal Bin Review: statement of reasons.", "https://www.edinburgh.gov.uk/downloads/file/38128/statement-of-reasons"],
  ["COSLA (2024) Extended Producer Responsibility on Packaging (pEPR), 21 June.", "https://cosla.gov.uk/__data/assets/pdf_file/0018/52074/24-06-21-Item-06-Extended-Producer-Responsibility-on-Packaging-pEPR.pdf"],
  ["Derby City Council (2023) ‘Waste tech trial roll out’.", "https://www.derby.gov.uk/news/2023/june/waste-tech-trial-roll-out"],
  ["Edinburgh Evening News (2019) ‘Edinburgh Council blames increase in overflowing bins on “explosion” of Airbnb-style short term lets’.", "https://www.edinburghnews.scotsman.com/news/politics/council/edinburgh-council-blames-increase-overflowing-bins-explosion-airbnb-style-short-term-lets-1331605"],
  ["Edinburgh Liberal Democrats (2025) ‘Fighting for a better Leith Walk in 2025’.", "https://www.edinburghlibdems.org/news/article/fighting-for-a-better-leith-walk-in-2025"],
  ["Edinburgh Reporter (2024) ‘Glass recycling bins to be fitted with sensors’.", "https://theedinburghreporter.co.uk/2024/12/glass-recycling-bins-to-be-fitted-with-sensors/"],
  ["European Cleaning Journal (n.d.) ‘Manchester to use smart bins to tackle issue of dirty streets’.", "https://www.europeancleaningjournal.com/magazine/articles/latest-news/manchester-to-use-smart-bins-to-tackle-issue-of-dirty-streets"],
  ["GOV.UK (2026) Local authority payment values 2026 to 2027: Scotland (pEPR).", "https://www.gov.uk/government/publications/extended-producer-responsibility-for-packaging-local-authority-payment-calculations-2026-to-2027/local-authority-payment-values-2026-to-2027-scotland"],
  ["Hannan, M.A. et al. (2020) ‘Waste collection route optimisation model for linking cost saving and emission reduction to achieve sustainable development goals’, Sustainable Cities and Society, 62, 102393.", "https://doi.org/10.1016/j.scs.2020.102393"],
  ["letsrecycle.com (2026) ‘Scotland’s household recycling rate fell to 42.8% in 2025’.", "https://www.letsrecycle.com/news/scotlands-household-recycling-rate-fell-to-42-8-in-2025/"],
  ["Ramos, T.R.P., de Morais, C.S. and Barbosa-Póvoa, A.P. (2018) ‘The smart waste collection routing problem: alternative operational management approaches’, Expert Systems with Applications, pp. 146–158.", ""],
  ["recycle.co.uk (2026) Recycling in City of Edinburgh.", "https://recycle.co.uk/councils/city-of-edinburgh/"],
  ["Scottish Parliament (2024) SPICe Briefing: Circular Economy (Scotland) Bill.", "https://www.parliament.scot/chamber-and-committees/research-prepared-for-parliament/research-briefings/2024/6/21/sb-2433"],
  ["Sensoneo (n.d.) ‘More efficient waste collection resulting in cost savings’ (vendor figures).", "https://old.sensoneo.com/reference/new-waste-collection-routes/"],
  ["SEPA (2017) Materials Recovery Code: the quality of recyclables processed at MRFs in Scotland.", "https://www.sepa.org.uk/media/306565/materials-recovery-code-the-quality-of-recyclables-processed-at-mrfs-in-scotland.pdf"],
  ["SEPA (2025) ‘Small rise in Scottish household recycling rate, but big gains are still going in our bins’.", "https://beta.sepa.scot/news/2025/small-rise-in-scottish-household-recycling-rate-but-big-gains-are-still-go/"],
  ["SEPA (n.d.) Biodegradable municipal waste landfill ban.", "https://www.sepa.org.uk/regulations/waste/landfill/biodegradable-municipal-waste-landfill-ban"],
];
function initSources() {
  const t = D.site.totals;
  const rows = [
    ["Bin locations, bin sizes, bin counts, street descriptions", "real", `City of Edinburgh Council, <i>Communal Bins</i> asset register, ${fmt(t.assets)} records (Open Government Licence v3.0; contains OS data © Crown copyright 2026)`],
    ["Ward of every stop", "real", "ONS Open Geography Portal, Wards (December 2024) Boundaries UK BGC; point-in-polygon for each stop"],
    ["Streets, rivers and parks on the map", "real", "© OpenStreetMap contributors (ODbL), via the Overpass API"],
    ["Route geometry on real streets", "real", "OSRM public routing service over OpenStreetMap"],
    ["Hourly temperature and rain", "real", `Open-Meteo, Edinburgh, ${fmtDate(D.site.weather.start, { day: "numeric", month: "short" })} to ${fmtDate(D.site.forecast_for, { day: "numeric", month: "short", year: "numeric" })}`],
    ["Bank holidays", "real", "Scottish bank holidays 2026, gov.scot"],
    ["Problem, market and policy statistics", "real", "Cited under each figure; full list below"],
    ["Fill levels, collections, sensor battery and signal", "sim", "EcoBin’s hourly fill model with Edinburgh parameters, driven by the real weather above. The council does not publish its sensor readings."],
    ["Forecasts and routes", "sim", `${esc(D.site.model.name)} and Google OR-Tools run on the simulated history`],
    ["Area types (City Centre / Inner / Outer)", "asm", "Distance rings from Princes Street, used only to set fill rates"],
    ["Fleet: 24 trucks × 60,000 L, 3 trips, 10 min per stop, 30 km/h", "asm", "Modelling assumptions, not council figures"],
  ];
  const tag = { real: `<span class="tag real">Real</span>`, sim: `<span class="tag sim">Simulated</span>`, asm: `<span class="tag asm">Assumed</span>` };
  $("#provRows").innerHTML = rows.map(([a, b, c]) => `<tr><td><b>${a}</b></td><td>${tag[b]}</td><td class="muted">${c}</td></tr>`).join("");
  $("#refs").innerHTML = REFS.map(([t, u]) => `<li>${esc(t)}${u ? ` <a href="${u}" target="_blank" rel="noopener">Link</a>` : ""}</li>`).join("");
  BS.REFS = REFS;
}

/* ── nav ─────────────────────────────────────────── */
function initNav() {
  const links = $$("nav.sections a"), secs = links.map(a => $(a.getAttribute("href")));
  const top = $("header.top");
  const onScroll = () => {
    top.classList.toggle("scrolled", scrollY > 8);
    let cur = -1; secs.forEach((s, k) => { if (s && s.getBoundingClientRect().top < 140) cur = k; });
    links.forEach((a, k) => a.classList.toggle("on", k === cur));
  };
  addEventListener("scroll", onScroll, { passive: true }); onScroll();
}

boot().catch(err => {
  console.error(err);
  const n = $("#mapNote"); if (n) n.textContent = "Data failed to load: " + err.message;
});
})();
