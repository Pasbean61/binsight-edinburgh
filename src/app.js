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
const TRUCK_HUES = ["#2a7ab8", "#c2552d", "#7b5ea7", "#2e8b6e", "#c08a1e", "#b8417a", "#4a7d2a", "#3b5bb5", "#a8532f", "#1f8a99"];
const truckColor = i => TRUCK_HUES[i % TRUCK_HUES.length];
const STREAM_COLORS = { "Communal Bin": "#5f6f68", "Packaging": "#2a7ab8", "Bottle Bank - Mixed": "#2e8b6e", "Food Waste Communal": "#a8532f", "Chamberlain Bin": "#7b5ea7", "Paper Bank": "#c08a1e", "Side Loading Communal": "#b8417a", "Textile Bank": "#1f8a99" };

/* ── state ───────────────────────────────────────── */
const D = {};
const UI = { layer: "pred", ward: -1, flagOnly: false, routes: false, selTruck: -1, selStop: -1, follow: -1, hoverWard: -1 };
window.BS = { D, UI };

const DATA_VER = "/*@VER@*/";
async function getJSON(p) { const r = await fetch(p.startsWith("data/") ? p + "?v=" + DATA_VER : p); if (!r.ok) throw new Error(p + " " + r.status); return r.json(); }

async function boot() {
  readPalette();
  const [site, stops, routes, base] = await Promise.all(["data/site.json", "data/stops.json", "data/routes.json", "data/basemap.json"].map(getJSON));
  Object.assign(D, { site, S: stops, R: routes, base });
  derive();
  fillKeys();
  drawHero();
  initSteps();
  initMap();
  initConsole();
  initMaths();
  initResults();
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
  // drive minutes per stop from the model's time estimate (tmin = θ·drive + lifting; drive is 0 below the floor)
  const drv = Array.from(S.tmin, (t, i) => Math.max(0, t - svcMin(i))), pos = drv.filter((v, i) => S.risky[i] && v > 0).sort((a, b) => a - b);
  const med = pos.length ? pos[pos.length >> 1] : 5;
  D.driveEst = drv.map((v, i) => S.risky[i] ? v : med);
  // BHH calibration on the optimised plan
  const served = []; for (let i = 0; i < n; i++) if (S.truck[i] >= 0) served.push(i);
  const plan = D.site.plan;
  const g = geomOf(served);
  const driveH = D.trucks.reduce((a, t) => a + t.drive, 0) / 60;
  D.bhh = { k: (plan.road_km - 2 * plan.trips * g.rbar) / Math.sqrt(served.length * g.area), util: plan.load_l / (plan.trips * D.R.capacity_l), kmh: plan.road_km / driveH };
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

function strat(name) { return D.site.experiments.aggregate.find(r => r.policy === name); }
// the model's decision rule (model/decide.py, choose): fullest projected first while the fleet has time,
// never below the floor. Time per stop = θ·drive from its nearest other candidate + lifting; each full load adds a tip.
BS.choose = ({ floor = D.site.maths.params.FLOOR, fleet = D.site.fleet.trucks, shift = D.site.fleet.shift_min / 60, svc = D.site.fleet.service_per_bin_min, speed = 1 } = {}) => {
  const S = D.S, f = D.site.fleet, cand = [];
  for (let i = 0; i < D.n; i++) if (S.pred[i] >= floor) cand.push(i);
  cand.sort((a, b) => S.pred[b] - S.pred[a]);
  const budget = fleet * shift * 60 * .95, sel = [];
  let used = 0, litres = 0;
  for (const i of cand) {
    const u = used + D.driveEst[i] / speed + f.service_base_min + svc * S.nb[i], q = litres + S.cap[i] * Math.min(S.pred[i], 100) / 100;
    if (u + Math.ceil(q / f.capacity_l) * f.tip_min > budget) break;
    used = u; litres = q; sel.push(i);
  }
  return { cand, sel, litres };
};
const svcMin = i => D.site.fleet.service_base_min + D.site.fleet.service_per_bin_min * D.S.nb[i];
const hhmm = m => { const h = D.site.fleet.start_h + Math.floor(m / 60), mm = Math.floor(m % 60); return String(h % 24).padStart(2, "0") + ":" + String(mm).padStart(2, "0"); };

function fillKeys() {
  const s = D.site, t = s.totals, p = s.plan;
  const fixed = strat("timetable"), bs = strat("binsight");
  const vals = {
    stops: fmt(t.stops), assets: fmt(t.assets), gwRecords: fmt(t.general_waste_records), flagged: fmt(p.flagged),
    planKm: fmt(p.road_km) + " km", trucksUsed: fmt(p.trucks_used), wardsN: String(s.wards.length),
    overflowCut: fixed && bs ? "−" + fmt(100 * (1 - bs.overflow_events_day / fixed.overflow_events_day)) + " %" : "–",
    overflowCutWord: fixed && bs ? fmt(100 * (1 - bs.overflow_events_day / fixed.overflow_events_day)) + "\u00a0%" : "–",
    costCutWord: fixed && bs ? fmt(100 * (1 - bs.cost_day / fixed.cost_day)) + "\u00a0%" : "–",
    forecastShort: fmtDate(s.plan_day + "T06:00", { day: "numeric", month: "short" }),
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
/* ── cover: tomorrow's plan as a short film ──
   The city fades up, every bin stop lights in a wave from the depot, then the 34 trucks leave Seafield
   and each bin turns green as its truck reaches it (real stops, real street routes, simulated fill). */
let heroPts = null;
const CV = { W: 0, H: 0, dpr: 1, P: null, r: 2, x: null, y: null, delay: null, order: null, state: null, t: 0, t0: 0, last: 0, raf: 0, ig: 0, ev: 0, fx: [], trails: [], resetAt: 0, started: false, box: null };
const coverStill = matchMedia("(prefers-reduced-motion: reduce)");
const IGNITE_MS = 2100, TRUCKS_AT = 6200, DAY_MS = 46000, HOLD_MS = 5200, TRAIL_MS = 2600;
const CAPS = [600, 3300, 6200, 19000, 33000];             // when each line of the cover's caption comes in (ms into the film)
function coverProjector(W, H) {
  if (!CV.box) {
    const q = (arr, p) => { const s = [...arr].sort((m, n) => m - n); return s[Math.floor((s.length - 1) * p)]; };
    CV.box = { s: q(D.S.lat, .02), n: q(D.S.lat, .985), w: q(D.S.lon, .03), e: q(D.S.lon, .985) };
  }
  const b = CV.box, kx = Math.cos(55.94 * Math.PI / 180), narrow = W < 760;
  const [x0, y0, x1, y1] = narrow ? [W * .02, 78, W * .98, H * .43] : [W * .05, H * .12, W * .95, H * .72];
  const s = Math.min((x1 - x0) / ((b.e - b.w) * kx), (y1 - y0) / (b.n - b.s));
  const ox = x0 + ((x1 - x0) - (b.e - b.w) * kx * s) / 2, oy = y0 + ((y1 - y0) - (b.n - b.s) * s) / 2;
  return { x: lon => ox + (lon - b.w) * kx * s, y: lat => oy + (b.n - lat) * s, s };
}
const dotsCtx = () => { const c = $("#heroDots").getContext("2d"); c.setTransform(CV.dpr, 0, 0, CV.dpr, 0, 0); return c; };
function litDot(c, i) {
  const v = D.S.pred[i], x = CV.x[i], y = CV.y[i], r = CV.r;
  if (v >= 80) {
    const g = c.createRadialGradient(x, y, 0, x, y, r * 4.5);
    g.addColorStop(0, v >= 90 ? "rgba(214,80,56,.13)" : "rgba(226,140,70,.1)"); g.addColorStop(1, "rgba(0,0,0,0)");
    c.globalCompositeOperation = "lighter"; c.fillStyle = g; c.fillRect(x - r * 4.5, y - r * 4.5, r * 9, r * 9); c.globalCompositeOperation = "source-over";
  }
  c.globalAlpha = v >= 60 ? 1 : .55; c.fillStyle = fillColor(v);
  c.beginPath(); c.arc(x, y, v >= 80 ? r : r * .78, 0, 6.2832); c.fill(); c.globalAlpha = 1;
}
function doneDot(c, i) {
  const x = CV.x[i], y = CV.y[i], r = CV.r;
  const g = c.createRadialGradient(x, y, r * .6, x, y, r * 2.4);
  g.addColorStop(0, "rgba(22,30,36,.92)"); g.addColorStop(1, "rgba(22,30,36,0)");
  c.fillStyle = g; c.beginPath(); c.arc(x, y, r * 2.4, 0, 6.2832); c.fill();
  c.fillStyle = "#57d6a6"; c.beginPath(); c.arc(x, y, r * .82, 0, 6.2832); c.fill();
}
function redrawDots() {
  const c = dotsCtx(); c.clearRect(0, 0, CV.W, CV.H);
  const byFill = [...D.S.pred.keys()].sort((m, n) => D.S.pred[m] - D.S.pred[n]);
  for (const i of byFill) if (CV.state[i] === 1) litDot(c, i);
  for (const i of byFill) if (CV.state[i] === 2) doneDot(c, i);
}
function drawHero() {                                       // lay the cover out (also on resize); the film itself starts once
  const host = $("#heroMap"), base = $("#heroBase"), fx = $("#heroCanvas"); if (!host || !base || !D.S) return;
  const W = host.clientWidth, H = host.clientHeight, S = D.S, n = S.lat.length;
  const dpr = Math.min(2, devicePixelRatio || 1, Math.sqrt(3.4e6 / (W * H)));
  const P = coverProjector(W, H);
  Object.assign(CV, { W, H, dpr, P, r: clamp(P.s / 3200, 1.25, 2.6) });
  for (const cv of [base, $("#heroDots"), fx]) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const c = base.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const N = { land: css("--night-land"), edge: css("--night-edge"), road: css("--night-road"), park: css("--night-park"), ink: css("--night-ink") };
  const path = (pts, close) => { c.beginPath(); pts.forEach(([la, lo], k) => k ? c.lineTo(P.x(lo), P.y(la)) : c.moveTo(P.x(lo), P.y(la))); if (close) c.closePath(); };
  c.lineWidth = 1; c.strokeStyle = N.edge; c.fillStyle = N.land;
  for (const w of D.base.wards) for (const ring of w.rings) { path(decode(ring), true); c.fill(); c.stroke(); }
  c.fillStyle = N.park;
  for (const pk of D.base.parks) { if (pk.k !== "park") continue; path(decode(pk.ring), true); c.fill(); }
  c.strokeStyle = N.road; c.lineWidth = 1.2; c.lineJoin = "round";
  for (const line of (D.base.roads.major || [])) { path(decode(line)); c.stroke(); }
  const dx = P.x(D.site.depot.longitude), dy = P.y(D.site.depot.latitude);
  c.beginPath(); c.arc(dx, dy, 4.5, 0, 6.2832); c.fillStyle = N.ink; c.fill();
  c.beginPath(); c.arc(dx, dy, 9, 0, 6.2832); c.strokeStyle = N.ink; c.lineWidth = 1.2; c.stroke();
  // where every stop sits, and when it lights: a wave spreading from the depot
  if (!CV.state) { CV.state = new Uint8Array(n); CV.delay = new Float32Array(n); }
  CV.x = new Float32Array(n); CV.y = new Float32Array(n); heroPts = [];
  let far = 1;
  for (let i = 0; i < n; i++) { CV.x[i] = P.x(S.lon[i]); CV.y[i] = P.y(S.lat[i]); heroPts.push([CV.x[i], CV.y[i], i]); far = Math.max(far, Math.hypot(CV.x[i] - dx, CV.y[i] - dy)); }
  for (let i = 0; i < n; i++) CV.delay[i] = 250 + Math.hypot(CV.x[i] - dx, CV.y[i] - dy) / far * IGNITE_MS + (i * 7919 % 100) * 2.2;
  CV.order = [...S.pred.keys()].sort((m, k) => CV.delay[m] - CV.delay[k]);
  CV.trails = []; CV.fx = [];
  host.classList.add("live");
  coverHud(0, 0, true);
  if (coverStill.matches) { CV.state.fill(1); redrawDots(); coverCap(1); return; }
  redrawDots();
  if (!CV.started) { CV.started = true; addEventListener("scroll", coverKick, { passive: true }); document.addEventListener("visibilitychange", coverKick); }
  coverKick();
}
function coverKick() {
  const host = $("#heroMap"); if (!host) return;
  const p = clamp(scrollY / Math.max(1, host.offsetHeight), 0, 1).toFixed(3);
  if (host._p !== p) { host._p = p; host.style.setProperty("--p", p); }
  if (!CV.raf && CV.started && !coverStill.matches && !document.hidden && scrollY < host.offsetHeight) { CV.last = 0; CV.raf = requestAnimationFrame(coverFrame); }
}
function coverFrame(now) {
  CV.raf = 0;
  const host = $("#heroMap");
  if (document.hidden || scrollY >= host.offsetHeight) return;         // off screen: coverKick resumes it
  const dt = CV.last ? Math.min(50, now - CV.last) : 16; CV.last = now;
  coverStep(dt);
  CV.raf = requestAnimationFrame(coverFrame);
}
function coverStep(dt) {
  CV.t += dt;
  const t = CV.t - CV.t0, S = D.S, P = CV.P, dc = dotsCtx();
  // 1. the stops light up
  while (CV.ig < CV.order.length && CV.delay[CV.order[CV.ig]] <= t) {
    const i = CV.order[CV.ig++]; if (CV.state[i]) continue;
    CV.state[i] = 1; litDot(dc, i);
    if (S.pred[i] >= 80 && CV.fx.length < 700) CV.fx.push([CV.x[i], CV.y[i], CV.t, 0]);
  }
  // 2. the shift: 06:00 to 14:00 in 46 seconds
  const tt = t - TRUCKS_AT, simT = SIM.end ? clamp(tt / DAY_MS, 0, 1) * SIM.end : 0;
  if (SIM.end && tt > 0) while (CV.ev < SIM.events.length && SIM.events[CV.ev][0] <= simT) {
    const i = SIM.events[CV.ev++][1]; if (CV.state[i] === 2) continue;
    CV.state[i] = 2; doneDot(dc, i);
    if ((i & 3) === 0) CV.fx.push([CV.x[i], CV.y[i], CV.t, 1]);
  }
  coverHud(simT, CV.ev);
  let cap = -1; for (let k = 0; k < CAPS.length; k++) if (t >= CAPS[k]) cap = k;
  coverCap(CV.resetAt ? -1 : cap);
  // 3. light: truck trails, flashes
  const f = $("#heroCanvas").getContext("2d"); f.setTransform(CV.dpr, 0, 0, CV.dpr, 0, 0); f.clearRect(0, 0, CV.W, CV.H);
  f.globalCompositeOperation = "lighter"; f.lineCap = "round"; f.lineJoin = "round";
  if (SIM.end && tt > 0) SIM.trucks.forEach((tk, k) => {
    const tr = CV.trails[k] || (CV.trails[k] = []);
    const p = tt < DAY_MS ? truckPos(tk, simT) : null, moving = p && p.tr;
    const hx = moving ? P.x(p.at[1]) : 0, hy = moving ? P.y(p.at[0]) : 0;
    if (moving) { const l = tr[tr.length - 1]; if (!l || Math.hypot(hx - l[0], hy - l[1]) > 1.4) tr.push([hx, hy, CV.t]); }
    while (tr.length && CV.t - tr[0][2] > TRAIL_MS) tr.shift();
    if (tr.length > 1) {
      const m = tr.length, parts = Math.min(6, m - 1);
      for (let q = 0; q < parts; q++) {
        const from = Math.floor(q * (m - 1) / parts), to = Math.floor((q + 1) * (m - 1) / parts), u = (q + 1) / parts;
        f.beginPath(); f.moveTo(tr[from][0], tr[from][1]); for (let j = from + 1; j <= to; j++) f.lineTo(tr[j][0], tr[j][1]);
        f.strokeStyle = `rgba(110,225,180,${(u * u * .75).toFixed(3)})`; f.lineWidth = .8 + u * 1.4; f.stroke();
      }
    }
    if (moving) {
      const h = [hx, hy], gr = CV.r * 4.6, g = f.createRadialGradient(h[0], h[1], 0, h[0], h[1], gr);
      g.addColorStop(0, "rgba(160,245,210,.55)"); g.addColorStop(1, "rgba(160,245,210,0)");
      f.fillStyle = g; f.fillRect(h[0] - gr, h[1] - gr, gr * 2, gr * 2);
      f.fillStyle = "rgba(255,255,255,.95)"; f.beginPath(); f.arc(h[0], h[1], CV.r * .85, 0, 6.2832); f.fill();
    }
  });
  for (let k = CV.fx.length - 1; k >= 0; k--) {
    const e = CV.fx[k], life = e[3] ? 720 : 430, u = (CV.t - e[2]) / life;
    if (u >= 1) { CV.fx.splice(k, 1); continue; }
    if (e[3]) { f.beginPath(); f.arc(e[0], e[1], 2 + u * 11, 0, 6.2832); f.strokeStyle = `rgba(110,225,180,${((1 - u) * .7).toFixed(3)})`; f.lineWidth = 1.2; f.stroke(); }
    else { f.beginPath(); f.arc(e[0], e[1], CV.r * (1 + u * 2.6), 0, 6.2832); f.fillStyle = `rgba(255,196,150,${((1 - u) * .7).toFixed(3)})`; f.fill(); }
  }
  f.globalCompositeOperation = "source-over";
  // 4. after the shift, hold, fade and play again
  if (SIM.end && tt > DAY_MS + HOLD_MS) {
    const dots = $("#heroDots");
    if (!CV.resetAt) { CV.resetAt = CV.t; dots.classList.add("out"); }
    else if (CV.t - CV.resetAt > 1100) {
      CV.state.fill(0); dc.clearRect(0, 0, CV.W, CV.H); CV.ig = 0; CV.ev = 0; CV.trails = []; CV.fx = []; CV.t0 = CV.t; CV.resetAt = 0; dots.classList.remove("out");
    }
  }
}
// the clock and the three counts beside the film, and its caption
const hudLast = {};
function hudSet(id, v) { if (hudLast[id] !== v) { hudLast[id] = v; const e = $("#" + id); if (e) e.textContent = v; } }
function coverHud(simT, done, init) {
  const flagged = D.site.plan.flagged, m = Math.round((D.R.shift_start_h || 6) * 60 + simT);
  hudSet("cvClock", String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"));
  hudSet("cvDone", fmt(done)); hudSet("cvFull", fmt(Math.max(0, flagged - done)));
  if (init) hudSet("cvSkip", fmt(D.site.totals.stops - flagged));
  const bar = $("#cvBar"); if (bar) bar.style.transform = `scaleX(${SIM.end ? clamp(simT / SIM.end, 0, 1).toFixed(4) : 0})`;
}
function coverCap(k) { if (hudLast.cap === k) return; hudLast.cap = k; $$(".cover-caps span[data-c]").forEach(e => e.classList.toggle("on", +e.dataset.c === k)); }
BS.coverAdvance = ms => { for (let k = 0; k < ms / 16; k++) coverStep(16); return Math.round(CV.t - CV.t0); };   // for checking a frame of the film by hand
function initHeroHover() {
  const cv = $("#heroCanvas"), host = $("#heroMap"), tip = $("#heroTip");
  const pick = (e, rad) => {
    const r = cv.getBoundingClientRect(), k = CV.W / r.width, mx = (e.clientX - r.left) * k, my = (e.clientY - r.top) * k;
    let best = null, bd = rad * rad;
    for (const p of heroPts || []) { const d = (p[0] - mx) ** 2 + (p[1] - my) ** 2; if (d < bd) { bd = d; best = p; } }
    return best && { i: best[2], cx: r.left + best[0] / k, cy: r.top + best[1] / k };
  };
  cv.addEventListener("mousemove", e => {
    const h = pick(e, 8);
    if (!h) { tip.style.opacity = 0; cv.style.cursor = ""; return; }
    const hr = host.getBoundingClientRect(), i = h.i;
    tip.textContent = `${D.S.site[i]} · ${D.wards[D.S.ward[i]].name} · ${fmt(D.S.pred[i])} % tomorrow`;
    tip.style.left = (h.cx - hr.left) + "px"; tip.style.top = (h.cy - hr.top) + "px"; tip.style.opacity = 1; cv.style.cursor = "pointer";
  });
  cv.addEventListener("mouseleave", () => tip.style.opacity = 0);
  cv.addEventListener("click", e => { const h = pick(e, 10); if (h) { BS.focusStop(h.i); BS.jump("#console"); } });
  let t; addEventListener("resize", () => { clearTimeout(t); t = setTimeout(drawHero, 180); });
}

/* ── steps ───────────────────────────────────────── */
function initSteps() {}   // the four steps are plain cards now

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
  map.attributionControl.addAttribution("Wards: ONS (OGL) · Routes: our shortest paths on OpenStreetMap · Bins: City of Edinburgh Council (OGL)");
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
  L.circleMarker(dep, { renderer: canvas, radius: 8, color: PAL.surface, weight: 2, fillColor: PAL.ink, fillOpacity: 1 }).bindTooltip(`Seafield depot · ${D.site.fleet.trucks} trucks`, { direction: "top" }).addTo(map);
  highlight = L.layerGroup().addTo(map);
  map.on("zoomend", restyleStops);
  BS.map = map;
  initPlayback();
  const all = L.latLngBounds(S.lat.map((la, i) => [la, S.lon[i]]));
  map.fitBounds(all, { padding: [20, 20] });
  // the container can change size after first layout (fonts, phones): keep the map filled
  let fitted = false; const born = performance.now();
  setTimeout(() => { fitted = true; }, 4000);   // after the first layout settles, never move the camera on resize
  new ResizeObserver(() => { map.invalidateSize(); if (!fitted && performance.now() - born < 4000 && UI.selStop < 0 && UI.selTruck < 0 && UI.ward < 0 && UI.follow < 0) map.fitBounds(all, { padding: [20, 20] }); }).observe($(".map-shell"));
  ["pointerdown", "wheel", "touchstart"].forEach(ev => $("#map").addEventListener(ev, () => { fitted = true; }, { passive: true }));
  $("#mapNote").textContent = `Snapshot ${fmtDate(D.site.snapshot, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · plan for ${fmtDate(D.site.plan_day + "T06:00", { weekday: "short", day: "numeric", month: "short" })}`;
  initHeroHover();
  initStreetMap();
}

/* ── street-level map ────────────────────────────────
   Every building, street name, house number, tram and rail stop and park in Edinburgh,
   from OpenStreetMap vector tiles (OpenFreeMap, no key) drawn by MapLibre under the
   Leaflet layers and restyled to the platinum palette. If the tiles can't be reached
   (offline, or inside a Claude artifact), the light vector map above stays. */
const OFM_STYLE = "https://tiles.openfreemap.org/styles/positron";
const ML_JS = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.24.0/maplibre-gl.js";
const ML_CSS = "https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.css";
const MLL_JS = "https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-leaflet@0.1.4/leaflet-maplibre-gl.js";
const loadScript = src => new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
async function initStreetMap() {
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
    const style = await fetch(OFM_STYLE, { signal: ctl.signal }).then(r => { if (!r.ok) throw new Error("style"); return r.json(); });
    clearTimeout(tm);
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = ML_CSS; document.head.appendChild(css);
    if (!window.maplibregl) await loadScript(ML_JS);
    if (!L.maplibreGL) await loadScript(MLL_JS);
    if (!window.maplibregl || !L.maplibreGL) return;
    platinumStyle(style);
    const gl = L.maplibreGL({ style, interactive: false, attributionControl: false,
      attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' }).addTo(map);
    const glm = gl.getMaplibreMap();
    let on = false;
    const swap = () => {   // swap only once the first street tiles are drawn, so the map is never blank
      if (on) return; on = true; UI.street = true;
      baseLayers.forEach(([lay]) => wardLayer.removeLayer(lay));
      $("#map").style.background = PAL.land; map.setMaxZoom(19);
      $("#map").classList.add("street");
      map.attributionControl.addAttribution(gl.options.attribution);
      restyleStops();
    };
    glm.once("idle", swap);
    setTimeout(() => { if (!on && glm.loaded()) swap(); }, 9000);
  } catch (e) { /* keep the built-in vector map */ }
}
function platinumStyle(s) {
  const lay = id => s.layers.find(l => l.id === id);
  const P = (ids, k, v) => [].concat(ids).forEach(id => { const l = lay(id); if (l) (l.paint ||= {})[k] = v; });
  const land = "#f5f5f3", bld = "#e8e9ec", ink = "#3c4043", txt = "#5f6368", halo = "#ffffff";   // Google-Maps-like daylight palette
  P("background", "background-color", land);
  P("landuse_residential", "fill-color", "#f1f1ef");
  P("park", "fill-color", "#c9eac6"); P("landcover_wood", "fill-color", "#bfe4bb");
  P("water", "fill-color", "#aadaff"); P("waterway", "line-color", "#aadaff");
  P("building", "fill-color", bld); P("building", "fill-outline-color", "#dadce0");
  P(["highway_minor", "highway_major_inner", "road_pier"], "line-color", "#ffffff");
  P(["highway_motorway_inner", "highway_motorway_bridge_inner", "tunnel_motorway_inner"], "line-color", "#fde293");
  P("highway_path", "line-color", "#ffffff");
  P("highway_major_casing", "line-color", "#d5d8dc");
  P(["highway_motorway_casing", "highway_motorway_bridge_casing", "tunnel_motorway_casing"], "line-color", "#f1bf4e");
  P(["railway", "railway_transit", "railway_service"], "line-color", "#bdc1c6");
  P(["highway-name-path", "highway-name-minor", "highway-name-major"], "text-color", txt);
  P(["highway-name-path", "highway-name-minor", "highway-name-major"], "text-halo-color", halo);
  P(["highway-name-path", "highway-name-minor", "highway-name-major"], "text-halo-width", 1.4);
  s.layers.filter(l => /^label_/.test(l.id)).forEach(l => { l.paint = { ...l.paint, "text-color": ink, "text-halo-color": land, "text-halo-width": 1.4, "text-halo-blur": 0 }; });
  P(["water_name_point_label", "water_name_line_label", "waterway_line_label"], "text-color", "#4a7fc1");
  // the building layer starts a little earlier, and street names one zoom earlier, than stock positron
  if (lay("building")) lay("building").minzoom = 13;
  if (lay("highway-name-minor")) lay("highway-name-minor").minzoom = 14.5;
  // extra detail positron leaves out: house numbers, tram and rail stops, parks and places
  const name = ["coalesce", ["get", "name_en"], ["get", "name"]];
  const extra = [
    { id: "bs-housenumber", type: "symbol", source: "openmaptiles", "source-layer": "housenumber", minzoom: 17,
      layout: { "text-field": ["get", "housenumber"], "text-font": ["Noto Sans Regular"], "text-size": 10 },
      paint: { "text-color": "#80868b", "text-halo-color": bld, "text-halo-width": 1 } },
    { id: "bs-poi", type: "symbol", source: "openmaptiles", "source-layer": "poi", minzoom: 16.5,
      filter: ["!", ["match", ["get", "class"], ["railway", "bus", "park"], true, false]],
      layout: { "text-field": name, "text-font": ["Noto Sans Regular"], "text-size": 10.5, "text-max-width": 8 },
      paint: { "text-color": "#70757a", "text-halo-color": halo, "text-halo-width": 1.2 } },
    { id: "bs-park", type: "symbol", source: "openmaptiles", "source-layer": "poi", minzoom: 14,
      filter: ["==", ["get", "class"], "park"],
      layout: { "text-field": name, "text-font": ["Noto Sans Italic"], "text-size": 11, "text-max-width": 8 },
      paint: { "text-color": "#2f8a4c", "text-halo-color": halo, "text-halo-width": 1.2 } },
    { id: "bs-station", type: "symbol", source: "openmaptiles", "source-layer": "poi", minzoom: 13.5,
      filter: ["==", ["get", "class"], "railway"],
      layout: { "text-field": name, "text-font": ["Noto Sans Bold"], "text-size": 10.5, "text-max-width": 9, "text-anchor": "top", "text-offset": [0, .5] },
      paint: { "text-color": "#3367d6", "text-halo-color": halo, "text-halo-width": 1.4 } },
    { id: "bs-station-dot", type: "circle", source: "openmaptiles", "source-layer": "poi", minzoom: 13.5,
      filter: ["==", ["get", "class"], "railway"],
      paint: { "circle-radius": 3, "circle-color": "#ffffff", "circle-stroke-color": "#3367d6", "circle-stroke-width": 1.4 } },
  ];
  const at = s.layers.findIndex(l => l.id === "highway-name-path");
  s.layers.splice(at < 0 ? s.layers.length : at, 0, ...extra);
  return s;
}
function wardStyle(wi) {
  const sh = wardShapes[wi]; if (!sh) return;
  const sel = UI.ward === wi, hov = UI.hoverWard === wi, dim = UI.ward >= 0 && !sel;
  const zz = map ? map.getZoom() : 11;
  if (UI.street) sh.setStyle({ fillColor: hov && !sel ? PAL.accent : PAL.paper, fillOpacity: dim ? .55 : hov && !sel && zz < 14 ? .07 : 0, color: PAL.ink3, weight: 1, opacity: zz >= 15 ? .25 : .45 });
  else sh.setStyle({ fillColor: hov && !sel ? PAL.accentSoft : PAL.land, fillOpacity: dim ? .55 : 1, color: PAL.line2, weight: 1 });
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
  const z = map.getZoom(), r = z < 11.5 ? 2.6 : z < 13 ? 3.6 : z < 15 ? 5 : z < 17 ? 7 : 8.5;
  const S = D.S, net = UI.layer === "net";
  if (basePal !== PAL.land) { basePal = PAL.land; baseLayers.forEach(([l, st]) => l.setStyle(st())); $("#map").style.background = UI.street ? PAL.land : PAL.sea; }
  for (let i = 0; i < D.n; i++) {
    const m = markers[i], vis = !net && stopVisible(i);
    if (!vis) { if (stopLayer.hasLayer(m)) stopLayer.removeLayer(m); continue; }
    const v = UI.layer === "fill" ? S.fill[i] : S.pred[i];
    const col = fillColor(v);
    if (SIM.emptied?.[i]) m.setStyle({ fillColor: PAL.f0, color: PAL.accent, weight: 1.6 });
    else m.setStyle({ fillColor: col, color: PAL.surface, weight: z >= 14 ? 1.2 : .6 });
    m.setRadius(i === UI.selStop ? r + 3 : r);
    if (!stopLayer.hasLayer(m)) stopLayer.addLayer(m);
  }
  D.wards.forEach((w, wi) => wardStyle(wi));
  routeLines.forEach((pl, ti) => {
    // at street zoom every truck's path shows on its own: few enough routes are on screen to read
    const sel = UI.selTruck, show = !net && (UI.routes || sel === ti || z >= 14);
    if (!show) { routeLayer.removeLayer(pl); return; }
    if (!routeLayer.hasLayer(pl)) routeLayer.addLayer(pl);
    // routes get bolder as you zoom to street level, so each truck's path reads street by street
    const w = z < 13 ? 1.8 : z < 15 ? 2.6 : z < 17 ? 3.6 : 4.6, op = z < 13 ? .45 : z < 15 ? .62 : .85;
    pl.setStyle({ opacity: sel < 0 ? op : sel === ti ? .95 : .1, weight: sel === ti ? w + 2 : w, lineCap: "round", lineJoin: "round" });
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
  const t = { pred: "Projected fill, 14:00 tomorrow", fill: "Fill now" }[UI.layer];
  const rows = [["90 % and over", 4], ["80–90 %", 3], ["60–80 %", 2], ["35–60 %", 1], ["< 35 %", 0]];
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
const fillPill = v => v >= 100 ? `<span class="pill hi">Projected to overflow</span>` : v >= D.site.maths.params.FLOOR ? `<span class="pill md">Above the ${fmt(D.site.maths.params.FLOOR)} % floor</span>` : `<span class="pill lo">Can wait</span>`;
BS.focusStop = async (i, opts = {}) => {
  if (!map) return;
  UI.selStop = i; UI.selTruck = D.S.truck[i] >= 0 && opts.keepTruck ? D.S.truck[i] : UI.selTruck;
  const S = D.S, w = D.wards[S.ward[i]], area = D.site.areas[S.area[i]], P = D.site.maths.params;
  const ti = S.truck[i];
  map.flyTo([S.lat[i], S.lon[i]], Math.max(map.getZoom(), 15.5), { duration: .6 });
  highlight.clearLayers();
  L.circleMarker([S.lat[i], S.lon[i]], { radius: 14, color: PAL.ink, weight: 2, fill: false, interactive: false }).addTo(highlight);
  restyleStops();
  const fl = fmt(P.FLOOR), proj = `${fmt(S.pred[i])} %`;
  const why = ti >= 0 ? `Projected ${proj} by 14:00 tomorrow: above the ${fl} % floor and among the fullest the fleet has time for, so it goes.`
    : S.flag[i] ? `Projected ${proj}: chosen, but the routes did not fit the fleet, and routing leaves out the least full stops first.`
    : S.risky[i] ? `Projected ${proj}: above the ${fl} % floor, but the fleet’s time went to fuller stops. It waits for the next day.`
    : `Projected ${proj}, below the ${fl} % floor: it can safely wait.`;
  panel(`<div class="dp">
    <span class="eyebrow">${esc(w.name)} ward · ${esc(area)}</span>
    <h3 style="margin-top:8px">${esc(S.site[i])}</h3>
    <div class="sub">${esc(S.loc[i] || "Communal bin stop")} · <span class="mono">${S.id[i]}</span></div>
    <div style="margin-top:10px">${fillPill(S.pred[i])} ${ti >= 0 ? `<span class="pill md">On tomorrow’s plan</span>` : ""}</div>
    <div class="gauge"><div><b>${fmt(S.fill[i])}%</b><span>Fill now · sim</span></div><div><b style="color:${S.pred[i] >= 100 ? "var(--bad)" : "inherit"}">${fmt(Math.min(S.pred[i], 100))}%${S.pred[i] > 100 ? "+" : ""}</b><span>Projected by 14:00 tomorrow · sim</span></div></div>
    <h4>Last 72 hours and the forecast</h4><svg class="spark" id="spark" viewBox="0 0 320 110" role="img" aria-label="Fill history and forecast"></svg>
    <h4>Decision</h4><p class="small" style="margin-top:6px">${why}</p>
    <dl class="kv">
      <dt>Bins at this stop</dt><dd>${S.nb[i]} · ${fmt(S.cap[i])} L total <span class="tag real">Real</span></dd>
      <dt>Council asset records</dt><dd>${S.rec[i]}</dd>
      <dt>Forecast fill speed, ĝ</dt><dd>${fmt(S.gain[i], 1)} points a day</dd>
      <dt>Projected fill, ŷ</dt><dd>${fmt(S.pred[i], 1)} %</dd>
      <dt>Truck time it uses, t</dt><dd>${S.risky[i] ? fmt(S.tmin[i], 1) + " min" : "– (below the floor)"}</dd>
      <dt>Last emptied</dt><dd>${S.since[i] == null ? "–" : S.since[i] + " h ago"}</dd>
      <dt>Sensor battery · signal</dt><dd>${fmt(S.bat[i])} % · ${S.sig[i]} <span class="tag sim">Sim</span></dd>
      <dt>Coordinates</dt><dd class="mono">${S.lat[i].toFixed(5)}, ${S.lon[i].toFixed(5)}</dd>
    </dl>
    <h4>Tomorrow’s collection</h4>
    <p class="small" style="margin-top:6px">${ti >= 0 ? `Stop <b>${S.ord[i]}</b> of ${D.trucks[ti].stops.length} on <button class="linkbtn" data-truck="${ti}">${D.trucks[ti].truck}</button>, arriving about <b>${hhmm(S.eta[i])}</b>.` : S.flag[i] ? "Chosen, but the routes could not fit it tomorrow." : "Not needed tomorrow. The truck skips this stop."}</p>
  </div>`);
  $$("#panel [data-truck]").forEach(b => b.onclick = () => BS.focusTruck(+b.dataset.truck));
  drawSpark(i);
};
async function drawSpark(i) {
  if (!D.hist) { try { D.hist = await getJSON("data/history.json"); } catch { return; } }
  const svg = $("#spark"); if (!svg) return;
  const h = D.hist.fill[i] || [], W = 320, H = 110, ahead = 39, n = h.length + ahead, top = 130;
  const x = k => 4 + k / (n - 1) * (W - 8), y = v => H - 16 - Math.min(v, top) / top * (H - 26);
  const line = h.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = h.length - 1, mu = D.S.pred[i];
  svg.innerHTML = `
    <line class="grid" x1="4" x2="${W - 4}" y1="${y(100)}" y2="${y(100)}" stroke="${PAL.f[4]}" stroke-dasharray="3 3"/>
    <text x="6" y="${y(100) - 4}" style="fill:${PAL.f[4]};font-size:10px">100 %: overflow</text>
    <path d="${line} L${x(last)},${y(0)} L${x(0)},${y(0)} Z" fill="${PAL.accent}" opacity=".10"/>
    <path d="${line}" fill="none" stroke="${PAL.ink}" stroke-width="1.6"/>
    <line x1="${x(last)}" y1="${y(h[last])}" x2="${x(n - 1)}" y2="${y(mu)}" stroke="${PAL.accent}" stroke-width="1.8" stroke-dasharray="4 3"/>
    <circle cx="${x(n - 1)}" cy="${y(mu)}" r="3.5" fill="${PAL.accent}"/>
    <circle cx="${x(last)}" cy="${y(h[last])}" r="3" fill="${PAL.ink}"/>
    <text x="4" y="${H - 2}">−72 h</text><text x="${x(last)}" y="${H - 2}" text-anchor="middle">now</text><text x="${W - 4}" y="${H - 2}" text-anchor="end">14:00</text>`;
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
    <div class="gauge"><div><b>${fmt(t.stops.length)}</b><span>stops</span></div><div><b>${t.trips.length}</b><span>trips (tip between)</span></div><div><b>${fmt(t.km, 1)}</b><span>km on real streets</span></div><div><b>${hhmm(t.trips[t.trips.length - 1].end)}</b><span>back at the depot</span></div></div>
    <dl class="kv"><dt>Waste collected</dt><dd>${fmt(t.load)} L</dd><dt>Load per trip</dt><dd>${t.trips.map(x => fmt(x.load / 1000, 1) + "k").join(" · ")} L</dd><dt>Driving time</dt><dd>${fmt(t.drive / 60, 1)} h</dd><dt>Lifting time</dt><dd>${fmt(t.stops.reduce((a, i) => a + svcMin(i), 0) / 60, 1)} h</dd><dt>Tipping</dt><dd>${t.trips.length} × ${D.site.fleet.tip_min} min</dd></dl>
    <h4>Wards on this route</h4><p class="small" style="margin-top:6px">${wards.map(([w, c]) => `${esc(w)} (${c})`).join(", ")}</p>
    <p class="small" style="margin-top:14px"><button class="linkbtn" id="openDriver">Open driver view with every stop in order</button></p>
  </div>`);
  $("#followBtn").onclick = () => { BS.follow(ti); $("#followBtn").textContent = UI.follow === ti ? "Stop following" : "Follow this truck through the shift"; };
  $("#openDriver").onclick = () => { BS.openTab("routes"); selectTruckInList(ti); BS.jump("#ctabs"); };
};
BS.focusWard = wi => {
  UI.ward = wi; $("#wardSel").value = wi; UI.selTruck = -1; highlight.clearLayers(); restyleStops(); renderBins();
  if (wi < 0) { map.flyToBounds(L.latLngBounds(D.S.lat.map((la, i) => [la, D.S.lon[i]])), { padding: [20, 20] }); $("#panel").hidden = true; return; }
  map.flyToBounds(wardShapes[wi].getBounds(), { padding: [30, 30], duration: .6 });
  const w = D.wards[wi];
  panel(`<div class="dp"><span class="eyebrow">Ward ${wi + 1} of 17 · ${w.code}</span><h3 style="margin-top:8px">${esc(w.name)}</h3>
    <div class="sub">Electoral ward, City of Edinburgh <span class="tag real">Real boundary</span></div>
    <div class="gauge"><div><b>${fmt(w.stops)}</b><span>communal bin stops</span></div><div><b>${fmt(w.bins)}</b><span>bins · ${fmt(w.cap_l / 1000)} m³</span></div><div><b>${fmt(w.flagged)}</b><span>flagged tomorrow</span></div><div><b>${fmt(w.pred)}%</b><span>mean forecast</span></div></div>
    <dl class="kv"><dt>Mean fill now</dt><dd>${fmt(w.fill)} %</dd><dt>Projected ≥ ${fmt(D.site.maths.params.FLOOR)} %</dt><dd>${fmt(w.risk)} stops</dd><dt>Over 90 % now</dt><dd>${fmt(w.over90)} stops</dd><dt>Trucks serving it</dt><dd>${w.trucks.length}</dd></dl>
    <h4>Area mix</h4><p class="small" style="margin-top:6px">${Object.entries(w.areas).filter(a => a[1]).map(([a, c]) => `${a}: ${c}`).join(" · ")}</p>
  </div>`);
};
/* ── shift replay: trucks drive their real street routes, bins empty as they are reached ── */
const SIM = { t: 0, end: 0, playing: false, speed: 15, trucks: [], events: [], ptr: 0, emptied: null, layer: null, marks: [], started: false };
function initPlayback() {
  const S = D.S;
  SIM.emptied = new Uint8Array(D.n);
  const kx = 111.32 * Math.cos(55.95 * Math.PI / 180), ky = 110.57;
  const dist = (a, b) => Math.hypot((a[1] - b[1]) * kx, (a[0] - b[0]) * ky);
  SIM.trucks = D.trucks.map(t => {
    const trips = [];
    for (const tr of t.trips) {
      const pts = decode(tr.line), cum = [0];
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + dist(pts[k - 1], pts[k]));
      const total = cum[cum.length - 1] || 1;
      // place each stop on the street line (nearest vertex, never going backwards); times come from the schedule
      let j0 = 0; const stops = [];
      tr.stops.forEach((i, k) => {
        const p = [S.lat[i], S.lon[i]]; let best = j0, bd = Infinity;
        for (let j = j0; j < pts.length; j++) { const d = dist(p, pts[j]); if (d < bd) { bd = d; best = j; } }
        j0 = best;
        const tArr = tr.eta[k];
        stops.push({ i, d: cum[best], tArr, tDep: tArr + svcMin(i) });
        SIM.events.push([tArr, i]);
      });
      // the truck reaches the depot before tipping
      const back = tr.end - D.site.fleet.tip_min;
      trips.push({ pts, cum, total, t0: tr.start, t1: back, tEnd: tr.end, stops, road: tr.road_km || 0 });
    }
    return { trips, end: t.trips.length ? t.trips[t.trips.length - 1].end : 0, color: t.color, id: t.truck };
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
  for (const tr of tk.trips) if (t > tr.t1 && t <= tr.tEnd) return { at: [D.site.depot.latitude, D.site.depot.longitude], state: "tipping at Seafield", next: 0 };
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
const clock = m => hhmm(m);
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
    if (p.state === "driving" || p.state === "emptying" || p.state === "to depot") onRoad++;
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
  // the shift starts at 06:00 on the forecast day; past midnight the label moves to the next day
  const day = new Date(D.site.plan_day + "T06:00:00"); day.setMinutes(day.getMinutes() + SIM.t);
  const dayLbl = day.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  $("#pbDay").textContent = SIM.t <= 0 ? "Shift starts" : SIM.t >= SIM.end ? `${dayLbl} · all trucks back` : `${dayLbl} · simulated`;
  $("#pbRange").value = Math.round(SIM.t / SIM.end * 1000);
  $("#pbStats").innerHTML = `<span><b>${fmt(SIM.ptr)}</b> / ${fmt(ev.length)} stops emptied</span><span><b>${fmt(litres / 1000)}</b> m³ collected</span><span><b>${fmt(km)}</b> km driven</span><span><b>${onRoad}</b> trucks on the road</span><span class="bar"><span style="width:${pctDone}%"></span></span>`;
}
function styleStop(i, r) {
  const m = markers[i]; if (!m || !stopLayer.hasLayer(m)) return;
  if (SIM.emptied[i]) m.setStyle({ fillColor: PAL.f0, color: PAL.accent, weight: 1.6 });
  else { const v = UI.layer === "fill" ? D.S.fill[i] : D.S.pred[i]; m.setStyle({ fillColor: fillColor(v), color: PAL.surface, weight: .6 }); }
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
  const key = { pred: i => S.pred[i], fill: i => S.fill[i], gain: i => S.gain[i], cap: i => S.cap[i], site: i => S.site[i], ward: i => D.wards[S.ward[i]].name }[binSort.k];
  ids.sort((a, b) => { const x = key(a), y = key(b); return (x > y ? 1 : x < y ? -1 : 0) * binSort.dir; });
  const per = 25, pages = Math.max(1, Math.ceil(ids.length / per)); binPage = clamp(binPage, 0, pages - 1);
  const rows = ids.slice(binPage * per, binPage * per + per);
  const th = (k, l, n) => `<th class="sortable ${n ? "n" : ""}" data-k="${k}">${l}${binSort.k === k ? (binSort.dir < 0 ? " ↓" : " ↑") : ""}</th>`;
  const bar = (v, c) => `<span class="bar-cell">${fmt(v)}%<span class="bar"><span style="width:${v}%;background:${c}"></span></span></span>`;
  host.innerHTML = `<div class="tablewrap"><table><thead><tr>${th("site", "Street")}<th>Location</th>${th("ward", "Ward")}${th("cap", "Capacity", 1)}${th("fill", "Now", 1)}${th("pred", "Tomorrow", 1)}${th("gain", "Fills a day", 1)}<th>Truck</th></tr></thead><tbody>
    ${rows.map(i => `<tr data-i="${i}"><td><b>${esc(S.site[i])}</b></td><td class="muted" style="max-width:240px;overflow:hidden;text-overflow:ellipsis">${esc(S.loc[i])}</td><td>${esc(D.wards[S.ward[i]].name)}</td><td class="n">${fmt(S.cap[i])} L</td><td class="n">${bar(S.fill[i], fillColor(S.fill[i]))}</td><td class="n">${bar(S.pred[i], fillColor(S.pred[i]))}</td><td class="n">${fmt(S.gain[i])} pts</td><td class="mono">${S.truck[i] >= 0 ? D.trucks[S.truck[i]].truck.replace("EDI-", "") : "–"}</td></tr>`).join("")}
  </tbody></table></div><div class="pager"><span>${fmt(ids.length)} stops${binQuery ? ` on ${esc(binQuery)} <button class="linkbtn" id="clearQ">show all</button>` : ""}${UI.ward >= 0 ? " in " + esc(D.wards[UI.ward].name) : ""} · simulated fill</span><span><button id="pgPrev" ${binPage ? "" : "disabled"}>Previous</button> ${binPage + 1} / ${pages} <button id="pgNext" ${binPage < pages - 1 ? "" : "disabled"}>Next</button></span></div>`;
  $$("th.sortable", host).forEach(t => t.onclick = () => { binSort = { k: t.dataset.k, dir: binSort.k === t.dataset.k ? -binSort.dir : -1 }; renderBins(); });
  $$("tbody tr", host).forEach(tr => tr.onclick = () => { BS.focusStop(+tr.dataset.i); BS.jump(".map-shell", "center"); });
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
  $$("#driverView li[data-i]").forEach(li => li.onclick = () => { BS.focusStop(+li.dataset.i, { keepTruck: true }); BS.jump(".map-shell", "center"); });
  $("#showOnMap").onclick = () => { BS.focusTruck(ti); BS.jump(".map-shell", "center"); };
  if (fly) BS.focusTruck(ti);
}
let wardSort = { k: "flagged", dir: -1 };
function renderWards() {
  const host = $("#pane-wards");
  const rows = D.wards.map((w, i) => ({ ...w, i })).sort((a, b) => ((a[wardSort.k] > b[wardSort.k]) - (a[wardSort.k] < b[wardSort.k])) * wardSort.dir);
  const max = Math.max(...D.wards.map(w => w.stops));
  const th = (k, l, n) => `<th class="sortable ${n ? "n" : ""}" data-k="${k}">${l}${wardSort.k === k ? (wardSort.dir < 0 ? " ↓" : " ↑") : ""}</th>`;
  host.innerHTML = `<div class="tablewrap"><table><thead><tr>${th("name", "Ward")}${th("stops", "Stops", 1)}${th("bins", "Bins", 1)}${th("cap_l", "Capacity", 1)}${th("fill", "Mean now", 1)}${th("pred", "Mean tomorrow", 1)}${th("flagged", "Flagged", 1)}${th("risk", "Projected ≥ " + fmt(D.site.maths.params.FLOOR) + " %", 1)}<th class="n">Trucks</th></tr></thead><tbody>
    ${rows.map(w => `<tr data-i="${w.i}"><td><b>${esc(w.name)}</b> <span class="muted mono small">${w.code}</span></td><td class="n"><span class="bar-cell">${w.stops}<span class="bar"><span style="width:${w.stops / max * 100}%;background:var(--accent)"></span></span></span></td><td class="n">${fmt(w.bins)}</td><td class="n">${fmt(w.cap_l / 1000)} m³</td><td class="n">${fmt(w.fill)}%</td><td class="n">${fmt(w.pred)}%</td><td class="n">${fmt(w.flagged)}</td><td class="n">${fmt(w.risk)}</td><td class="n">${w.trucks.length}</td></tr>`).join("")}</tbody></table></div>
    <p class="note">Ward boundaries: ONS Wards (December 2024), Edinburgh’s 17 multi-member wards. Stop counts and capacities are real; fill levels are simulated.</p>`;
  $$("th.sortable", host).forEach(t => t.onclick = () => { wardSort = { k: t.dataset.k, dir: wardSort.k === t.dataset.k ? -wardSort.dir : -1 }; renderWards(); });
  $$("tbody tr", host).forEach(tr => tr.onclick = () => { BS.focusWard(+tr.dataset.i); BS.jump(".map-shell", "center"); });
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
  $$("li[data-i]", host).forEach(li => li.onclick = () => { BS.focusStop(+li.dataset.i); BS.jump(".map-shell", "center"); });
}
function drawWeather() {
  const host = $("#pane-weather"); if (!host || host.hidden && host.dataset.done) return;
  const w = D.site.weather, histN = w.temp.length - 24, fc = w.forecast;
  // left half: the last 7 observed days before the snapshot; right half: the 7-day forecast issued that day
  const P = 7 * 24, obsT = w.temp.slice(histN - P, histN), obsR = w.rain.slice(histN - P, histN);
  const fT = fc ? fc.temp : w.temp.slice(histN), fR = fc ? fc.rain : w.rain.slice(histN);
  const temp = obsT.concat(fT), rain = obsR.concat(fR), n = temp.length, split = P;
  // naive local days (the hourly series crosses the 25 Oct clock change, so step by calendar day)
  const dayAt = j => { const d = new Date(D.site.plan_day + "T12:00"); d.setDate(d.getDate() - 7 + j); return d; }, t0 = dayAt(0);
  const W = 1000, H = 280, pl = 40, pr = 16, pt = 34, pb = 34;
  const x = k => pl + k / (n - 1) * (W - pl - pr);
  const tmin = Math.floor(Math.min(...temp) / 2) * 2, tmax = Math.ceil(Math.max(...temp) / 2) * 2;
  const yT = v => pt + (tmax - v) / (tmax - tmin) * (H - pt - pb);
  const rmax = Math.max(2, Math.ceil(Math.max(...rain)));
  const yR = v => H - pb - v / rmax * (H - pt - pb) * .55;
  const path = (arr, k0) => arr.map((v, k) => `${k ? "L" : "M"}${x(k0 + k).toFixed(1)},${yT(v).toFixed(1)}`).join("");
  const sum = a => a.reduce((p, q) => p + q, 0), avg = a => sum(a) / a.length;
  const allT = w.temp.slice(0, histN), allR = w.rain.slice(0, histN);
  const day = (d, o) => d.toLocaleDateString("en-GB", o || { day: "numeric", month: "short" });
  const issued = fc ? day(new Date(fc.issued + "T12:00")) : "";
  const kpi = (lab, t, r, cls) => `<div class="wk ${cls}"><span class="wk-h">${lab}</span><div class="wk-row"><div><b>${fmt(avg(t), 1)} °C</b><span>mean</span></div><div><b>${fmt(Math.min(...t), 1)} / ${fmt(Math.max(...t), 1)}</b><span>min / max °C</span></div><div><b>${fmt(sum(r), 1)} mm</b><span>rain</span></div><div><b>${r.filter(v => v > 0).length} h</b><span>wet hours</span></div></div></div>`;
  host.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;align-items:baseline"><h3 style="font-size:20px">Edinburgh weather: the last week and the week ahead <span class="tag real">Real</span></h3><span class="muted small">${esc(w.source)}</span></div>
    <div class="wks">${kpi(`Observed · ${day(t0)} – ${day(dayAt(6))}`, obsT, obsR, "obs")}${kpi(fc ? `Forecast issued ${issued} · next 7 days` : "Forecast day", fT, fR, "fc")}</div>
    <div class="wscroll" style="overflow-x:auto"><svg class="chart" viewBox="0 0 ${W} ${H}" style="min-width:640px" role="img" aria-label="Hourly temperature and rain: seven observed days, then the seven-day forecast">
      ${[tmin, (tmin + tmax) / 2, tmax].map(v => `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${yT(v)}" y2="${yT(v)}"/><text x="${pl - 6}" y="${yT(v) + 4}" text-anchor="end">${fmt(v)}°</text>`).join("")}
      <rect x="${x(split)}" y="${pt}" width="${x(n - 1) - x(split)}" height="${H - pt - pb}" fill="${PAL.accent}" opacity=".07"/>
      <rect x="${x(split)}" y="${pt}" width="${x(split + 24) - x(split)}" height="${H - pt - pb}" fill="${PAL.accent}" opacity=".07"/>
      <line x1="${x(split)}" x2="${x(split)}" y1="${pt - 6}" y2="${H - pb}" stroke="${PAL.ink3}" stroke-dasharray="3 3"/>
      <text x="${x(split) - 8}" y="${pt - 12}" text-anchor="end" style="fill:${PAL.ink};font-weight:600">Observed</text>
      <text x="${x(split) + 8}" y="${pt - 12}" style="fill:${PAL.accent};font-weight:600">Forecast${fc ? ` issued ${issued}` : ""}</text>
      <text x="${x(split + 12)}" y="${pt + 14}" text-anchor="middle" style="fill:${PAL.accent}">plan day</text>
      ${rain.map((v, k) => v > 0 ? `<rect x="${x(k) - 1.3}" y="${yR(v)}" width="2.6" height="${H - pb - yR(v)}" fill="${k < split ? PAL.f[1] : PAL.accent}" opacity="${k < split ? 1 : .45}"/>` : "").join("")}
      <path d="${path(obsT, 0)}" fill="none" stroke="${PAL.ink}" stroke-width="1.6"/>
      <path d="M${x(split - 1).toFixed(1)},${yT(obsT[P - 1]).toFixed(1)}${path(fT, split).replace(/^M/, "L")}" fill="none" stroke="${PAL.accent}" stroke-width="1.8" stroke-dasharray="5 3"/>
      ${Array.from({ length: Math.round(n / 24) }, (_, j) => j * 24).map(k => { const d = dayAt(k / 24); return `<line class="grid" x1="${x(k)}" x2="${x(k)}" y1="${H - pb}" y2="${H - pb + 4}"/><text x="${x(k + 12)}" y="${H - 12}" text-anchor="middle" style="${k >= split ? `fill:${PAL.accent}` : ""}">${day(d, { weekday: "short", day: "numeric" })}</text>`; }).join("")}
    </svg></div>
    <p class="note">Solid line: observed hourly temperature. Dashed line: the hourly forecast as Open-Meteo issued it on ${issued || "the snapshot day"}, before any of it happened. Bars: rain per hour (scale up to ${rmax} mm). Rain slightly slows how fast bins fill in the model; weekends and bank holidays speed it up. The simulated history ran on the real weather from ${day(new Date(w.start))} to ${day(dayAt(6), { day: "numeric", month: "short", year: "numeric" })} (mean ${fmt(avg(allT), 1)} °C, ${fmt(sum(allR), 1)} mm of rain in ${allR.filter(v => v > 0).length} wet hours). Tomorrow’s plan assumes the plan-day weather is known; the rest of the week is shown only.</p></div>`;
  // on narrow screens the chart scrolls: open it centred on the observed / forecast split
  requestAnimationFrame(() => { const sc = $(".wscroll", host); if (sc) sc.scrollLeft = (sc.scrollWidth - sc.clientWidth) * (x(split) / W); });
  host.dataset.done = 1;
}

/*@MATHS@*/

/* ── results ─────────────────────────────────────── */
const POLICIES = ["timetable", "reactive", "binsight"];
const STRAT_LABEL = { timetable: "Timetable", reactive: "Reactive", binsight: "BinSight" };
function initResults() {
  const ex = D.site.experiments, P = D.site.maths.params, F = strat("timetable"), R = strat("reactive"), B = strat("binsight");
  const ch = (a, b) => `${b <= a ? "−" : "+"}${fmt(Math.abs(100 * (b / a - 1)))} %`;
  // 1 · three headline numbers, each with a before/after pair of bars
  const pair = (a, b, f) => { const m = Math.max(a, b); return [["Timetable", a, 0], ["BinSight", b, 1]].map(([n, v, on]) =>
    `<div class="pb${on ? " on" : ""}"><span>${n}</span><i><u style="width:${Math.max(1.5, 100 * v / m)}%"></u></i><b>${f(v)}</b></div>`).join(""); };
  $("#takeaways").innerHTML = [
    [ch(F.overflow_events_day, B.overflow_events_day), "overflowing bins", pair(F.overflow_events_day, B.overflow_events_day, v => fmt(v) + " a day")],
    [ch(F.cost_day, B.cost_day), "cost", pair(F.cost_day, B.cost_day, v => "£" + fmt(v) + " a day")],
    [ch(F.km_day, B.km_day), "distance driven", pair(F.km_day, B.km_day, v => fmt(v) + " km a day")],
  ].map(([b, t, bars]) => `<div class="card takeaway"><b>${b}</b><h4>${t}</h4>${bars}</div>`).join("");
  // 2 · the three methods side by side
  const M = [
    [F, "Today", "Every bin, every 2 days, full or not.", `${fmt(100 * F.share_under_40)} % of its visits find a bin less than 40 % full.`],
    [R, "Sensors only", `Empty a bin once it reads ${fmt(P.REACTIVE_AT)} %.`, "Too late: the bin often overflows before the truck arrives."],
    [B, "Sensors + forecast", "Empty the bins that will be full tomorrow.", "Sees the overflow coming and gets there first."],
  ];
  $("#methods").innerHTML = M.map(([r, tag, how, verdict]) => `<div class="card method${r.policy === "binsight" ? " on" : ""}">
    <span class="eyebrow">${tag}</span><h4>${STRAT_LABEL[r.policy]}</h4><p class="how">${how}</p>
    <div class="big"><b>${fmt(r.overflow_events_day)}</b><span>overflows a day</span></div>
    <dl><dt>Cost a day</dt><dd>£${fmt(r.cost_day)}</dd><dt>Distance a day</dt><dd>${fmt(r.km_day)} km</dd></dl>
    <p class="verdict">${verdict}</p></div>`).join("");
}

/* ── business ────────────────────────────────────── */
const MODELS = [
  ["A", "Sensors + subscription", "Councils", "Pay per sensor, then a yearly fee."],
  ["B", "Pay from savings", "Councils · lowest risk", "No upfront cost. We take a share of the savings."],
  ["C", "Contractor licence", "Waste companies", "Run our routing on their own trucks."],
  ["D", "Alerts for shops", "Small businesses", "Empty their trade bin only when it’s full."],
  ["E", "Data reports", "Councils, policymakers", "Anonymised waste and recycling data."],
  ["F", "Student move-out", "Universities", "Spot the peaks; send reusables to the student marketplace."],
  ["G", "Community rewards", "Residents, local shops", "Report a full bin, earn a café voucher."],
];
function initBusiness() {
  const NS = "http://www.w3.org/2000/svg";
  // 1. who gets what, who pays: value flows out of BinSight, money flows back in
  const NODES = [
    ["City of Edinburgh Council", ["Gets lower costs,", "fewer overflows"], "Pays per sensor + a yearly fee"],
    ["Community", ["Gets cleaner streets", "and café vouchers"], "Shops sponsor the vouchers"],
    ["Recycling plant", ["Gets arrival forecasts", "and early warnings"], "Pays a data subscription"],
  ];
  const LAYOUTS = {
    wide: { w: 680, h: 440, hub: [340, 222, 60], boxes: [[30, 24, 236, 104], [414, 24, 236, 104], [222, 326, 236, 104]], ends: [[266, 104], [414, 104], [340, 326]] },
    narrow: { w: 340, h: 520, hub: [170, 218, 54], boxes: [[30, 14, 280, 98], [6, 380, 160, 128], [174, 380, 160, 128]], ends: [[170, 112], [86, 380], [254, 380]] },
  };
  const svgFor = (name, L) => {
    const [hx, hy, hr] = L.hub, still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let out = `<svg class="p-${name}" viewBox="0 0 ${L.w} ${L.h}" role="img" aria-label="BinSight in the middle. The council, the community and the recycling plant each get something from it and pay for it.">`;
    L.ends.forEach(([ex, ey], k) => {
      const dx = ex - hx, dy = ey - hy, d = Math.hypot(dx, dy), sx = hx + dx / d * hr, sy = hy + dy / d * hr;
      out += `<path id="pf-${name}-${k}" class="bz-link" d="M${sx.toFixed(1)} ${sy.toFixed(1)} L${ex} ${ey}"/><path id="pb-${name}-${k}" d="M${ex} ${ey} L${sx.toFixed(1)} ${sy.toFixed(1)}" fill="none" stroke="none"/>`;
      if (!still) for (let j = 0; j < 3; j++) {
        out += `<circle class="bz-val" r="4.2"><animateMotion dur="2.7s" begin="${(j * .9 + k * .3).toFixed(2)}s" repeatCount="indefinite"><mpath href="#pf-${name}-${k}"/></animateMotion></circle>`;
        out += `<circle class="bz-pay" r="4.2"><animateMotion dur="2.7s" begin="${(j * .9 + k * .3 + .45).toFixed(2)}s" repeatCount="indefinite"><mpath href="#pb-${name}-${k}"/></animateMotion></circle>`;
      }
    });
    out += `<circle class="bz-halo" cx="${hx}" cy="${hy}" r="${hr}"/><circle class="bz-hub" cx="${hx}" cy="${hy}" r="${hr}"/>
      <text class="bz-hub-t" x="${hx}" y="${hy - 2}" text-anchor="middle">BinSight</text><text class="bz-hub-s" x="${hx}" y="${hy + 16}" text-anchor="middle">sensors + platform</text>`;
    L.boxes.forEach(([x, y, w, h], k) => {
      const [t, gets, pays] = NODES[k], cx = x + w / 2, narrowBox = w < 200;
      const tl = narrowBox && t.length > 18 ? [t] : [t];
      out += `<g class="bz-node" style="--d:${300 + k * 220}ms"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14"/>
        <text class="bz-n-t" x="${cx}" y="${y + 26}" text-anchor="middle">${tl[0]}</text>
        ${gets.map((g, i) => `<text class="bz-n-g" x="${cx}" y="${y + 48 + i * 17}" text-anchor="middle">${g}</text>`).join("")}
        ${(narrowBox ? pays.replace(/^(\S+ \S+) /, "$1\n") : pays).split("\n").map((pl, i, arr) => `<text class="bz-n-p" x="${cx}" y="${y + h - 14 - (arr.length - 1 - i) * 16}" text-anchor="middle">${pl}</text>`).join("")}</g>`;
    });
    return out + "</svg>";
  };
  $("#partnersSvg").innerHTML = svgFor("wide", LAYOUTS.wide) + svgFor("narrow", LAYOUTS.narrow);
  if ("IntersectionObserver" in window) {
    const svgs = $$("#partnersSvg svg"), host = $("#partnersSvg"), pg = host.closest(".page");
    let vis = false; const sync = () => svgs.forEach(sv => (vis && !(pg && pg.classList.contains("buried"))) ? sv.unpauseAnimations() : sv.pauseAnimations());
    new IntersectionObserver(es => { vis = es[0].isIntersecting; sync(); }).observe(host); addEventListener("bs:pages", sync);
  }

  // 2. seven revenue models as tiles
  $("#modelTiles").innerHTML = MODELS.map(([k, t, who, line], i) => `<div class="bz-tile${k === "B" ? " star" : ""}" style="--d:${i * 90}ms"><span class="bz-l">${k}</span><div><b>${t}</b><span class="bz-who">${who}</span><p>${line}</p></div></div>`).join("");

  // 3. Model B: a cost bar, the saved slice, and how that slice is split
  const pct = v => (v * 100).toFixed(2) + "%";
  const calc = () => {
    const P = +$("#cProps").value || 0, C = +$("#cCost").value || 0, s = (+$("#cSave").value || 0) / 100, sh = (+$("#cShare").value || 0) / 100;
    const cost = P * C, saving = cost * s;
    $("#oProps").textContent = fmt(P); $("#oCost").textContent = "£" + fmt(C, 2); $("#oSave").textContent = fmt(s * 100) + " %"; $("#oShare").textContent = fmt(sh * 100) + " %";
    const split = $("#split");
    split.style.setProperty("--save", pct(s)); split.style.setProperty("--share", pct(sh));
    $("#vCost").textContent = money(cost); $("#vSaved").textContent = money(saving);
    $("#calcRes").innerHTML = `<div class="ours"><b>${money(saving * sh)}</b><span>a year to BinSight<br>£${fmt(C * s * sh, 2)} per property</span></div><div class="keep"><b>${money(saving * (1 - sh))}</b><span>a year the council keeps</span></div>`;
  };
  const money = v => v >= 1e6 ? "£" + (v >= 1e7 ? (Math.round(v / 1e5) / 10).toFixed(1) : (Math.round(v / 1e4 + 1e-6) / 100).toFixed(2)) + "m" : "£" + fmt(Math.round(v / 1000)) + "k";
  ["cProps", "cCost", "cSave", "cShare"].forEach(id => $("#" + id).addEventListener("input", calc)); calc();
  BS.gainShare = (P = 100000, C = 72.35, s = 20, sh = 25) => { const saving = P * C * s / 100; return { saving, binsight: saving * sh / 100, council: saving * (1 - sh / 100), perProperty: C * s / 100 * sh / 100 }; };

  // 4. who buys it
  const IC = {
    council: '<path d="M4 20h16M6 20v-8M10 20v-8M14 20v-8M18 20v-8M3 11h18L12 4 3 11z"/>',
    truck: '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    uni: '<path d="M2 9l10-5 10 5-10 5-10-5z"/><path d="M6 11v5c3 2 9 2 12 0v-5M22 9v6"/>',
    shop: '<path d="M4 10v10h16V10M3 6h18l-1 4H4L3 6zM9 20v-5h6v5"/>',
    tent: '<path d="M12 4L3 20h18L12 4zM12 4v16M9 20l3-6 3 6"/>',
  };
  const BUY = [["council", "Local councils", "Main customer", "Overflowing bins, rising costs, the 2028 landfill ban"],
    ["truck", "Private contractors", "", "Fuel and hours lost on fixed rounds"],
    ["uni", "Universities", "", "Waste peaks at move-in and move-out"],
    ["shop", "Businesses, landlords", "", "Paying to empty half-empty bins"],
    ["tent", "Event organisers", "", "Short, sharp peaks, like the August festivals"]];
  $("#buyerTiles").innerHTML = BUY.map(([ic, t, tag, line], i) => `<div class="bz-buyer${tag ? " main" : ""}" style="--d:${i * 110}ms"><svg viewBox="0 0 24 24" aria-hidden="true">${IC[ic]}</svg><b>${t}</b>${tag ? `<span class="bz-tag">${tag}</span>` : ""}<p>${line}</p></div>`).join("");

  // 5. go-to-market: a line draws itself through three stages
  const STAGES = [["0–6 months", "Campus pilot", "50–100 bins at one university", 1], ["6–18 months", "Council pilot", "One Edinburgh area, grant-funded", 1], ["18 months +", "Scale", "32 Scottish councils, then the UK", 32]];
  $("#road").innerHTML = `<div class="bz-line"><i></i></div>` + STAGES.map(([when, t, line, n], i) => `<div class="bz-stage" style="--d:${400 + i * 650}ms"><span class="bz-dot"></span><span class="bz-when">${when}</span><b>${t}</b><p>${line}</p><div class="bz-pips" aria-hidden="true">${Array.from({ length: n }, (_, j) => `<i style="--e:${j * 28}ms"></i>`).join("")}</div></div>`).join("");

  // 6. evidence: each number gets a small moving picture
  const EV = [
    ["44", " %", "lower collection cost when routes follow real fill levels", "Hannan et al. (2020), Sustainable Cities and Society 62", "bars", 44],
    ["53", " %", "fewer bin visits in Derby’s 200-bin sensor trial", 'Derby City Council via <a href="https://www.government-transformation.com/connected-places/derby-city-council-rolls-out-litter-bin-sensors" target="_blank" rel="noopener">Government Transformation</a> (2023)', "ticks", 53],
    ["11000", "", "sensors already in Edinburgh’s bins (a £6.4m programme). The data exists; routes don’t use it yet.", '<a href="https://www.edinburgh.gov.uk/bins-recycling/smart-bin-sensors/1" target="_blank" rel="noopener">City of Edinburgh Council</a>', "grid", 0],
    ["2700", "", "of about 3,400 communal glass bins had sensors by late 2024", '<a href="https://theedinburghreporter.co.uk/2024/12/glass-recycling-bins-to-be-fitted-with-sensors/" target="_blank" rel="noopener">Edinburgh Reporter</a> (2024)', "ring", 2700 / 3400],
  ];
  const viz = (kind, v) => {
    if (kind === "bars") return `<svg viewBox="0 0 200 64" aria-hidden="true"><text x="0" y="15" class="bz-vl">fixed rounds</text><rect class="bz-b0" x="0" y="20" width="200" height="12" rx="6"/><text x="0" y="49" class="bz-vl">fill-level routing</text><rect class="bz-b1 bz-grow" x="0" y="54" width="${200 * (1 - v / 100)}" height="10" rx="5"/></svg>`;
    if (kind === "ticks") return `<svg viewBox="0 0 200 64" aria-hidden="true">${Array.from({ length: 15 }, (_, j) => `<rect class="bz-tk${[1, 3, 4, 6, 8, 10, 12, 13].includes(j) ? " gone" : ""}" style="--e:${j * 60}ms" x="${j * 13.4}" y="14" width="9" height="36" rx="3"/>`).join("")}</svg>`;
    if (kind === "grid") return `<svg viewBox="0 0 200 64" aria-hidden="true">${Array.from({ length: 110 }, (_, j) => `<circle class="bz-gd" style="--e:${(j * 37 % 110) * 9}ms" cx="${5 + (j % 22) * 9.1}" cy="${8 + ((j / 22) | 0) * 12}" r="2.6"/>`).join("")}</svg>`;
    const C = 2 * Math.PI * 26;
    return `<svg viewBox="0 0 200 64" aria-hidden="true"><circle cx="34" cy="32" r="26" class="bz-r0"/><circle cx="34" cy="32" r="26" class="bz-r1" style="--c:${C.toFixed(1)};--o:${(C * (1 - v)).toFixed(1)}" transform="rotate(-90 34 32)"/><text x="34" y="37" text-anchor="middle" class="bz-rt">${Math.round(v * 100)}%</text><text x="74" y="29" class="bz-vl">glass bins</text><text x="74" y="45" class="bz-vl">with a sensor</text></svg>`;
  };
  $("#evTiles").innerHTML = EV.map(([n, suf, line, src, kind, v]) => `<div class="bz-evt"><div class="bz-viz">${viz(kind, v)}</div><b data-count="${n}" data-suf="${suf}">${(+n).toLocaleString("en-GB")}${suf}</b><p>${line}</p><span class="src">${src}</span></div>`).join("");

  // 7. risks turn from red to green
  const RISKS = [["Councils buy slowly", "Start with universities, businesses and a grant-funded campus pilot"],
    ["Bins come in many shapes", "One universal mounting kit"],
    ["Sensors get damaged", "Cheap, tough sensors inside the lid"],
    ["The council already has routing software", "Plug in through an API, don’t compete"],
    ["Data protection (UK GDPR)", "Bin data only; the app asks for minimal personal data, with consent"],
    ["Savings not yet proven here", "Gain-share: the council pays only when it saves"],
    ["Fake or duplicate reports", "Only verified reports earn points, with a daily limit"],
    ["Too few voucher sponsors", "Start with a few shops near the pilot; the council co-funds at first"],
    ["Recycling plants won’t pay yet", "Free data during the pilot"],
    ["Drivers’ shift time (from our model)", "Add a working-time limit to the solver"]];
  $("#risks").innerHTML = RISKS.map(([r, f], i) => `<div class="bz-risk" style="--d:${i * 120}ms"><span class="bz-st" aria-hidden="true"></span><span class="bz-r">${r}</span><span class="bz-ar" aria-hidden="true">→</span><span class="bz-f">${f}</span></div>`).join("");

  // play each card once it comes on screen
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const count = b => {
    const end = +b.dataset.count, suf = b.dataset.suf || "", show = v => b.textContent = Math.round(v).toLocaleString("en-GB") + suf;
    if (still) return show(end);
    const t0 = performance.now(), step = now => { const u = Math.min(1, (now - t0) / 1600); show(end * (1 - Math.pow(1 - u, 3))); if (u < 1) requestAnimationFrame(step); };
    show(0); requestAnimationFrame(step);
  };
  const cards = $$("#business .bz");
  document.documentElement.classList.add("bz-ready");
  const play = c => { c.classList.add("play"); $$("b[data-count]", c).forEach(count); };
  if (still || !("IntersectionObserver" in window)) return cards.forEach(play);
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); play(e.target); } }), { threshold: .25 });
  cards.forEach(c => io.observe(c));
  BS.playBusiness = () => cards.forEach(play);
}

/* ── sources ─────────────────────────────────────── */
const REFS = [
  ["Broughton Spurtle (n.d.) ‘Fewer bins emptied more often’.", "https://broughtonspurtle.org.uk/news/fewer-bins-emptied-more-often"],
  ["Circular Online (n.d.) ‘Edinburgh Fringe Festival to see 500 tonnes of extra glass collected’.", "https://www.circularonline.co.uk/news/edinburgh-fringe-festival-to-see-500-tonnes-of-extra-glass-collected/"],
  ["City of Edinburgh Council (2025a) Environment LGBF 2024/25 (PDF).", "https://www.edinburgh.gov.uk/downloads/file/40593/environment-lgbf-2024-25"],
  ["City of Edinburgh Council (2025b) Council Budget: Key Facts and Figures 2025–2026 (Word document).", "https://www.edinburgh.gov.uk/downloads/file/38260/council-budget-key-facts-and-figures-2025--2026"],
  ["City of Edinburgh Council (n.d.-a) Smart bin sensors.", "https://www.edinburgh.gov.uk/bins-recycling/smart-bin-sensors/1"],
  ["City of Edinburgh Council (n.d.-b) Communal Bins register, open data (Open Government Licence v3.0).", "https://data.edinburghcouncilmaps.info/datasets/283caa7cb2434db3874526d16efe8c67_27/about"],
  ["City of Edinburgh Council (n.d.-c) Communal bin review.", "https://www.edinburgh.gov.uk/bins-recycling/communal-bin-review"],
  ["COSLA (2024) Extended Producer Responsibility on Packaging (pEPR), 21 June (PDF).", "https://cosla.gov.uk/__data/assets/pdf_file/0018/52074/24-06-21-Item-06-Extended-Producer-Responsibility-on-Packaging-pEPR.pdf"],
  ["Edinburgh Evening News (2019) ‘Edinburgh Council blames increase in overflowing bins on “explosion” of Airbnb-style short term lets’.", "https://www.edinburghnews.scotsman.com/news/politics/council/edinburgh-council-blames-increase-in-overflowing-bins-on-explosion-of-airbnb-style-short-term-lets-1331605"],
  ["Edinburgh Liberal Democrats (2025) ‘Fighting for a better Leith Walk in 2025’.", "https://www.edinburghlibdems.org/news/article/fighting-for-a-better-leith-walk-in-2025"],
  ["Edinburgh Reporter (2024) ‘Glass recycling bins to be fitted with sensors’.", "https://theedinburghreporter.co.uk/2024/12/glass-recycling-bins-to-be-fitted-with-sensors/"],
  ["European Cleaning Journal (n.d.) ‘Manchester to use smart bins to tackle issue of dirty streets’.", "https://www.europeancleaningjournal.com/magazine/articles/latest-news/manchester-to-use-smart-bins-to-tackle-issue-of-dirty-streets"],
  ["GOV.UK (2026) Local authority payment values 2026 to 2027: Scotland (pEPR).", "https://www.gov.uk/government/publications/extended-producer-responsibility-for-packaging-local-authority-payment-calculations-2026-to-2027/local-authority-payment-values-2026-to-2027-scotland"],
  ["Government Transformation (2023) ‘Derby City Council rolls out litter bin sensors’, 28 June.", "https://www.government-transformation.com/connected-places/derby-city-council-rolls-out-litter-bin-sensors"],
  ["Hannan, M.A. et al. (2020) ‘Waste collection route optimisation model for linking cost saving and emission reduction to achieve sustainable development goals’, Sustainable Cities and Society, 62, 102393.", "https://doi.org/10.1016/j.scs.2020.102393"],
  ["letsrecycle.com (2026) ‘Scotland’s household recycling rate fell to 42.8% in 2025’.", "https://www.letsrecycle.com/news/scotlands-household-recycling-rate-fell-to-42-8-in-2025/"],
  ["Ramos, T.R.P., de Morais, C.S. and Barbosa-Póvoa, A.P. (2018) ‘The smart waste collection routing problem: alternative operational management approaches’, Expert Systems with Applications, 103, pp. 146–158.", "https://doi.org/10.1016/j.eswa.2018.03.001"],
  ["recycle.co.uk (2026) Recycling in City of Edinburgh.", "https://recycle.co.uk/councils/city-of-edinburgh/"],
  ["Scottish Parliament (2024) SPICe Briefing SB 24-33: Circular Economy (Scotland) Bill, consideration prior to Stage 3.", "https://www.parliament.scot/chamber-and-committees/research-prepared-for-parliament/research-briefings/2024/6/21/sb-2433"],
  ["Sensoneo (n.d.) ‘Efficient waste collection driving cost savings’ (vendor figures).", "https://www.sensoneo.com/success-stories/new-waste-collection-routes/"],
  ["SEPA (2017) Materials Recovery Code: the quality of recyclables processed at MRFs in Scotland (PDF).", "https://www.sepa.org.uk/media/306565/materials-recovery-code-the-quality-of-recyclables-processed-at-mrfs-in-scotland.pdf"],
  ["SEPA (2025a) Household waste generated and managed 2024 (official statistics, by council).", "https://shiny.data.gov.scot/sepa/waste/household.html"],
  ["SEPA (2025b) ‘Small rise in Scottish household recycling rate, but big gains are still going in our bins’.", "https://beta.sepa.scot/news/2025/small-rise-in-scottish-household-recycling-rate-but-big-gains-are-still-go/"],
  ["SEPA (n.d.) Biodegradable municipal waste landfill ban.", "https://beta.sepa.scot/topics/waste/landfill/biodegradable-municipal-waste-landfill-ban/"],
];
function initSources() {
  const t = D.site.totals;
  const rows = [
    ["Bin locations, bin sizes, bin counts, street descriptions", "real", `City of Edinburgh Council, <a href="https://data.edinburghcouncilmaps.info/datasets/283caa7cb2434db3874526d16efe8c67_27/about" target="_blank" rel="noopener"><i>Communal Bins</i> asset register</a>, ${fmt(t.assets)} records (Open Government Licence v3.0; contains OS data © Crown copyright 2026)`],
    ["Ward of every stop", "real", `ONS Open Geography Portal, <a href="https://geoportal.statistics.gov.uk/datasets/ons::wards-december-2024-boundaries-uk-bgc" target="_blank" rel="noopener">Wards (December 2024) Boundaries UK BGC</a>; point-in-polygon for each stop`],
    ["Street map: every building, street name, house number, station and park", "real", `<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> (ODbL), vector tiles from <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> drawn with MapLibre; a light fallback map from the Overpass API`],
    ["Road network: every drivable street", "real", `OpenStreetMap via the Overpass API (ODbL): ${fmt(t.road_nodes)} junctions and bends, ${fmt(t.road_edges)} street segments, ${fmt(t.road_km)} km. Our Dijkstra shortest paths give every distance, time and route line.`],
    ["Hourly temperature and rain", "real", `<a href="https://open-meteo.com/en/docs/historical-weather-api" target="_blank" rel="noopener">Open-Meteo</a>, Edinburgh, ${fmtDate(D.site.weather.start, { day: "numeric", month: "short" })} to ${fmtDate(D.site.plan_day + "T06:00", { day: "numeric", month: "short", year: "numeric" })}`],
    ["Seven-day weather forecast", "real", `<a href="https://open-meteo.com/en/docs/previous-runs-api" target="_blank" rel="noopener">Open-Meteo Previous Runs API</a>: the hourly forecast for 3–9 Nov as it was issued on 2 Nov 2026 (scripts/fetch_forecast.py). Shown on the Weather tab only; the model does not use it.`],
    ["Problem, market and policy statistics", "real", "Cited under each figure; full list below"],
    ["Public and school holidays", "real", "City of Edinburgh Council holiday dates (model/config.py)"],
    ["Fill levels, collections, sensor battery and signal", "sim", "Our fill simulator (model/simulate.py): 30 L bags arriving at random, calibrated so the council’s every-two-days timetable overflows on 1 % of collections, as its complaint rate implies, and driven by the real weather and holidays above. The council does not publish its sensor readings."],
    ["Forecasts, decisions and routes", "sim", "Our random-forest forecast, fullest-first rule and simulated-annealing routing (model/), run on the simulated history"],
    ["Area types (City Centre / Inner / Outer)", "asm", "City Centre ward, then 4 km from Princes Street; labels only"],
    [`Fleet and costs: ${fmt(D.site.fleet.trucks)} trucks (what the timetable needs on its busiest round) × 60 m³, 8-hour shift, 2 min a stop + 1 min a bin, 25 min to tip, £1.45/km, £75/truck-hour, £60 per overflow`, "asm", "Modelling assumptions, not council figures (model/config.py)"],
  ];
  const tag = { real: `<span class="tag real">Real</span>`, sim: `<span class="tag sim">Simulated</span>`, asm: `<span class="tag asm">Assumed</span>` };
  $("#provRows").innerHTML = rows.map(([a, b, c]) => `<tr><td><b>${a}</b></td><td>${tag[b]}</td><td class="muted">${c}</td></tr>`).join("");
  $("#refs").innerHTML = REFS.map(([t, u]) => `<li>${esc(t)}${u ? ` <a href="${u}" target="_blank" rel="noopener">Link</a>` : ""}</li>`).join("");
  BS.REFS = REFS;
}

/* ── nav ─────────────────────────────────────────── */
function initNav() {
  const links = $$("nav.sections a"), secs = links.map(a => $(a.getAttribute("href")));
  const top = $("header.top"), cover = $("#heroMap"), bar = $(".progress", top);
  const onScroll = () => {
    top.classList.toggle("scrolled", scrollY > 8);
    top.classList.toggle("over", !!cover && scrollY < cover.offsetHeight - 64);
    if (bar) bar.style.transform = `scaleX(${clamp(scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight), 0, 1)})`;
    let cur = -1; secs.forEach((s, k) => { if (s && s.getBoundingClientRect().top < 140) cur = k; });
    links.forEach((a, k) => a.classList.toggle("on", k === cur));
  };
  addEventListener("scroll", onScroll, { passive: true }); onScroll();
}

/* ── pages: a chapter scrolls to its last line, stays there, and the next one rises over it ── */
/* sticky pages report where they are stuck, not where they live; jumps use the page's place in the flow instead */
function flowY(el) {
  const pg = el.closest("main > .page");
  if (!pg) return el.getBoundingClientRect().top + scrollY;
  let y = pg.parentElement.getBoundingClientRect().top + scrollY, n = pg.parentElement.firstElementChild;
  for (; n && n !== pg; n = n.nextElementSibling) {
    const st = getComputedStyle(n); if (st.position === "absolute" || st.position === "fixed" || st.display === "none") continue;
    y += n.offsetHeight + (n === pg.parentElement.firstElementChild ? 0 : parseFloat(st.marginTop) || 0) + (parseFloat(st.marginBottom) || 0);   // the first child's margin collapses into <main>
  }
  return y + (parseFloat(getComputedStyle(pg).marginTop) || 0) + el.getBoundingClientRect().top - pg.getBoundingClientRect().top;
}
BS.jump = (el, block = "start") => {
  if (typeof el === "string") el = $(el); if (!el) return;
  const head = ($("header.top") || {}).offsetHeight || 0, y = flowY(el);
  const to = block === "center" ? y - (innerHeight - el.offsetHeight) / 2 : el.matches("section.chapter") ? y : y - head - 12;
  scrollTo({ top: Math.max(0, Math.round(to)), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
};
document.addEventListener("click", e => {
  const a = e.target.closest && e.target.closest('a[href^="#"]'); if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
  const id = a.getAttribute("href").slice(1), el = id && document.getElementById(id); if (!el || !el.closest("main > .page")) return;
  e.preventDefault(); BS.jump(el); try { history.replaceState(null, "", "#" + id); } catch (_) {}
});
addEventListener("load", () => { const el = location.hash.length > 1 && document.getElementById(location.hash.slice(1)); if (el && el.closest("main > .page")) setTimeout(() => BS.jump(el), 60); });

(function initPages() {
  const pages = $$("main > .page"); if (!pages.length) return;
  const stick = () => pages.forEach(p => { p.style.top = Math.min(0, innerHeight - p.offsetHeight) + "px"; });
  if ("ResizeObserver" in window) { const ro = new ResizeObserver(stick); pages.forEach(p => ro.observe(p)); }
  addEventListener("resize", stick); stick();
  let raf = 0;
  // the page being covered darkens a little. Only one small layer's opacity changes per frame (no style recalc of the page),
  // and a page that is fully covered is hidden, so nothing under the pile is painted or animated.
  const dims = pages.map(p => { const d = document.createElement("i"); d.className = "page-dim"; d.setAttribute("aria-hidden", "true"); p.append(d); return d; });
  const upd = () => {
    raf = 0; const vh = innerHeight, tops = pages.map(p => p.getBoundingClientRect().top);
    pages.forEach((p, k) => {
      const c = k + 1 < pages.length ? clamp((vh - tops[k + 1]) / vh, 0, 1) : 0, q = Math.round(c * 100) / 100;
      if (p._c === q) return; p._c = q;
      dims[k].style.opacity = (q * .5).toFixed(2);
      const buried = q >= 1;
      if (buried !== !!p._b) { p._b = buried; p.classList.toggle("buried", buried); dispatchEvent(new Event("bs:pages")); }
    });
  };
  addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(upd); }, { passive: true }); upd();
})();

/* ── one continuous scroll: each block of a chapter rises into place as it is reached ── */
(function initReveal() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
  let done = false;
  const start = () => {
    if (done) return; done = true;
    const sheet = $("main"); if (!sheet) return;
    const els = [];
    $$("section.chapter", sheet).forEach(sec => {
      for (const ch of sec.children) {
        if (ch.hidden) continue;
        if (ch.matches(".chapter-head, .stats, .steps, .sensor-demo, .takeaways3, .methods, .biz-grid")) els.push(...ch.children);
        else els.push(ch);
      }
    });
    const io = new IntersectionObserver(es => {
      let k = 0;
      es.forEach(e => {
        if (!e.isIntersecting) return;
        const el = e.target; io.unobserve(el);
        el.style.transitionDelay = Math.min(k++, 5) * 90 + "ms";
        el.classList.add("in");
        setTimeout(() => { el.classList.remove("rv", "in"); el.style.transitionDelay = ""; }, 1700);
      });
    }, { threshold: .08, rootMargin: "0px 0px -7% 0px" });
    els.forEach(el => { if (el.getBoundingClientRect().top > innerHeight * .9) { el.classList.add("rv"); io.observe(el); } });
  };
  document.addEventListener("bs:ready", start);
  setTimeout(start, 4000);
})();

/* ── problem: animated facts ── */
(function initStatAnims() {
  const host = $("#statAnims"); if (!host) return;
  const NS = "http://www.w3.org/2000/svg", el = (t, at) => { const e = document.createElementNS(NS, t); for (const k in at) e.setAttribute(k, at[k]); return e; };
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // 96 bins, one icon for about 110 of the 10,657
  const g = $("#vBins .bins-grid");
  for (let r = 0; r < 4; r++) for (let c = 0; c < 24; c++) {
    const x = 6.5 + c * 13, y = 6 + r * 24, b = el("g", { class: "bin" + (rnd() < .14 ? " hot" : "") });
    b.style.setProperty("--d", (c * 26 + r * 70) + "ms"); b.style.setProperty("--h", (rnd() * 5).toFixed(2) + "s");
    b.append(el("rect", { x, y, width: 10, height: 2.4, rx: 1, class: "lidr" }), el("rect", { x: x + 1, y: y + 3.4, width: 8, height: 11, rx: 1.6, class: "body" }));
    g.append(b);
  }
  // 32 councils by recycling rate; Edinburgh is 28th
  const dots = $("#vRank .dots");
  for (let k = 0; k < 32; k++) {
    const d = el("circle", { cx: 24 + k * 8.9, cy: 92, r: k === 27 ? 5.5 : 3.6, class: k === 27 ? "me" : "" });
    d.style.setProperty("--d", (600 + k * 35) + "ms"); dots.append(d);
  }
  dots.append(Object.assign(el("text", { x: 24 + 27 * 8.9, y: 80, "text-anchor": "middle", class: "v-me" }), { textContent: "28th" }));
  // 100 squares of general waste; 52 could have been recycled
  const cells = $("#vMix .cells"), order = [...Array(100).keys()].sort(() => rnd() - .5), rank = new Map(order.map((v, k) => [v, k]));
  for (let k = 0; k < 100; k++) {
    const c = k % 20, r = (k / 20) | 0, sq = el("rect", { x: 62 + c * 10.1, y: 36 + r * 13, width: 8, height: 10, rx: 1.6, class: rank.get(k) < 52 ? "rec" : "" });
    sq.style.setProperty("--d", (300 + rank.get(k) * 24) + "ms"); cells.append(sq);
  }
  const count = b => {
    const end = +b.dataset.count, dec = +(b.dataset.dec || 0), pre = b.dataset.pre || "", suf = (b.dataset.suf || "").replace(" ", " ");
    const show = v => b.textContent = pre + v.toLocaleString("en-GB", { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf;
    if (still) return show(end);
    const t0 = performance.now(), dur = 1500;
    const step = now => { const u = Math.min(1, (now - t0) / dur); show(end * (1 - Math.pow(1 - u, 3))); if (u < 1) requestAnimationFrame(step); };
    show(0); requestAnimationFrame(step);
  };
  const cards = $$(".anim", host.parentElement);
  document.documentElement.classList.add("anim-ready");
  if (still || !("IntersectionObserver" in window)) { cards.forEach(c => c.classList.add("play")); return; }
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    io.unobserve(e.target); e.target.classList.add("play");
    const b = $("b[data-count]", e.target); if (b) count(b);
  }), { threshold: .35 });
  cards.forEach(c => io.observe(c));
})();

/* ── 3D: the sensor, a communal bin cut open, an overflowing bin, the city's bins ──
   Built with three.js (r128), loaded only when a scene is about to come on screen. */
(function init3D() {
  const THREE_JS = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)"), still = reduce.matches;
  let loading = null;
  const three = () => window.THREE ? Promise.resolve() : (loading ||= new Promise((ok, no) => { const s = document.createElement("script"); s.src = THREE_JS; s.onload = ok; s.onerror = no; document.head.appendChild(s); }));
  const scenes = [], studios = [];
  const lazy = (host, build, fail) => {
    if (!host) return;
    const sc = { done: false, go: () => { if (sc.done) return; sc.done = true; try { build(window.THREE, host); host.classList.add("has3d"); } catch (e) { console.warn("3D scene skipped:", e); fail && fail(); } } };
    scenes.push(sc);
    new IntersectionObserver((es, ob) => { if (!es[0].isIntersecting) return; ob.disconnect(); three().then(sc.go, () => fail && fail()); }, { rootMargin: "400px" }).observe(host);
  };
  // for checking by hand: build every scene now, then draw frames one at a time
  BS.build3D = () => three().then(() => scenes.forEach(sc => sc.go()));
  BS.step3D = (n = 1, dt = 1 / 60) => { for (let k = 0; k < n; k++) studios.forEach(st => st.step(dt)); };
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  /* a small studio: renderer, soft room light for reflections, a loop that only runs on screen */
  function studio(T3, cvs, host, o = {}) {
    const renderer = new T3.WebGLRenderer({ canvas: cvs, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputEncoding = T3.sRGBEncoding; renderer.toneMapping = T3.ACESFilmicToneMapping; renderer.toneMappingExposure = o.exposure || .92;
    renderer.physicallyCorrectLights = true;
    if (o.shadows) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = T3.PCFSoftShadowMap; }
    const scene = new T3.Scene();
    const pm = new T3.PMREMGenerator(renderer), room = new T3.Scene();
    room.add(new T3.Mesh(new T3.BoxGeometry(100, 100, 100), new T3.MeshBasicMaterial({ color: 0x8a8578, side: T3.BackSide })));
    const panel = (w, h, x, y, z, ry, rx, k) => { const m = new T3.Mesh(new T3.PlaneGeometry(w, h), new T3.MeshBasicMaterial({ color: new T3.Color(k, k * .97, k * .9), side: T3.DoubleSide })); m.position.set(x, y, z); m.rotation.set(rx, ry, 0); room.add(m); };
    panel(70, 26, 0, 46, 0, 0, Math.PI / 2, 5); panel(30, 44, -48, 6, 10, Math.PI / 2, 0, 3); panel(30, 44, 48, 0, 20, -Math.PI / 2, 0, 1.6); panel(60, 30, 0, 0, 49, Math.PI, 0, 1.3);
    scene.environment = pm.fromScene(room, .04).texture;
    const camera = o.ortho ? new T3.OrthographicCamera(-1, 1, 1, -1, .1, 400) : new T3.PerspectiveCamera(o.fov || 28, 1, .5, 600);
    const key = new T3.DirectionalLight(0xfff3df, o.key || 2.1); key.position.set(-16, 30, 20); scene.add(key);
    const rim = new T3.DirectionalLight(0x9fe8cc, 1.1); rim.position.set(20, 16, -26); scene.add(rim);   // a cool edge light so shapes lift off the night stage
    scene.add(new T3.HemisphereLight(0xdfeee8, 0x1c2328, o.fill || .55));
    if (o.shadows) {
      key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.radius = 5; key.shadow.bias = -.0006;
      const sc = key.shadow.camera, R = o.shadowSize || 20; sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 1; sc.far = 120;
      const ground = new T3.Mesh(new T3.PlaneGeometry(300, 300), new T3.ShadowMaterial({ opacity: o.shadowOpacity || .45 })); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
    }
    let W = 0, H = 0, onScreen = false, running = false, tick = null, fit = null;
    const size = () => { const r = host.getBoundingClientRect(); if (!r.width || !r.height) return; W = r.width; H = r.height; renderer.setSize(W, H, false); if (camera.isPerspectiveCamera) camera.aspect = W / H; fit && fit(W, H); camera.updateProjectionMatrix(); kick(); };
    const page = host.closest(".page"), seen = () => onScreen && !document.hidden && !(page && page.classList.contains("buried"));
    const kick = () => {
      if (running || !seen()) return; running = true; let last = performance.now();
      const step = now => {
        if (!seen()) { running = false; return; }
        const dt = Math.min(.05, (now - last) / 1000); last = now;
        tick && tick(still ? 0 : dt, now / 1000); renderer.render(scene, camera);
        if (still) { running = false; return; }                // reduced motion: draw once, again only when touched
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    new ResizeObserver(size).observe(host);
    new IntersectionObserver(es => { onScreen = es[0].isIntersecting; kick(); }).observe(host);
    document.addEventListener("visibilitychange", kick); addEventListener("bs:pages", kick);
    let clock = 0;
    studios.push({ step: dt => { clock += dt; size(); tick && tick(dt, clock); renderer.render(scene, camera); } });
    return { T3, renderer, scene, camera, key, kick, frame: f => { tick = f; }, fit: f => { fit = f; size(); } };
  }
  /* drag to turn; let go and it eases back into a slow sway */
  function orbit(cvs, host, st, o) {
    const s = { yaw: o.yaw, pitch: o.pitch, vy: 0, idle: 9, drag: null };
    cvs.addEventListener("pointerdown", e => { s.drag = [e.clientX, e.clientY]; cvs.setPointerCapture(e.pointerId); host.classList.add("grabbing"); const h = host.querySelector(".stage-hint"); if (h) h.style.opacity = 0; });
    cvs.addEventListener("pointermove", e => { if (!s.drag) return; const dx = e.clientX - s.drag[0], dy = e.clientY - s.drag[1]; s.drag = [e.clientX, e.clientY]; s.vy = dx * .011; s.yaw += s.vy; s.pitch = clamp(s.pitch + dy * .006, o.pMin, o.pMax); s.idle = 0; st.kick(); });
    const up = () => { s.drag = null; host.classList.remove("grabbing"); };
    cvs.addEventListener("pointerup", up); cvs.addEventListener("pointercancel", up);
    s.step = (dt, t) => {
      s.idle += dt;
      if (!s.drag) { s.yaw += s.vy; s.vy *= .93; if (s.idle > 2.2) { s.yaw += (o.yaw + Math.sin(t / (o.period || 3.4)) * (o.sway || .3) - s.yaw) * .014; s.pitch += (o.pitch - s.pitch) * .02; } }
    };
    return s;
  }

  /* a four-wheeled communal bin, about 1.4 m wide (1 unit = 10 cm) */
  function makeBin(T3, o = {}) {
    const g = new T3.Group(), W = 13.7, D = 10.2, Hb = 10.6, y0 = 1.9, k = .84, tx = W / 2, tz = D / 2, bx = tx * k, bz = tz * k, yt = y0 + Hb;
    const body = new T3.MeshStandardMaterial({ color: 0x245c43, roughness: .5, metalness: .08, side: T3.DoubleSide, envMapIntensity: .6 });
    const dark = new T3.MeshStandardMaterial({ color: 0x18221e, roughness: .42, metalness: .2, envMapIntensity: .6 });
    const glass = new T3.MeshStandardMaterial({ color: 0xbfe3d2, roughness: .25, transparent: true, opacity: .07, depthWrite: false, side: T3.DoubleSide, envMapIntensity: .25 });
    const add = (m, shadow = true) => { m.castShadow = shadow; g.add(m); return m; };
    const quad = (a, b, c, d, mat, shadow) => { const geo = new T3.BufferGeometry(); geo.setAttribute("position", new T3.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3)); geo.computeVertexNormals(); return add(new T3.Mesh(geo, mat), shadow); };
    const B = [[-bx, y0, bz], [bx, y0, bz], [bx, y0, -bz], [-bx, y0, -bz]], T = [[-tx, yt, tz], [tx, yt, tz], [tx, yt, -tz], [-tx, yt, -tz]];
    quad(B[0], B[1], T[1], T[0], o.cutaway ? glass : body, !o.cutaway);                                   // front (a window when cut away)
    quad(B[1], B[2], T[2], T[1], body); quad(B[2], B[3], T[3], T[2], body); quad(B[3], B[0], T[0], T[3], body); quad(B[3], B[2], B[1], B[0], body);
    for (const [w, d, x, z] of [[W + .9, .75, 0, tz], [W + .9, .75, 0, -tz], [.75, D + .1, tx, 0], [.75, D + .1, -tx, 0]]) { const m = add(new T3.Mesh(new T3.BoxGeometry(w, .75, d), body)); m.position.set(x, yt, z); }
    for (const s of [-1, 1]) {                                                                             // window frame posts, lifting pins
      const len = Math.hypot(Hb, tx - bx, tz - bz), post = add(new T3.Mesh(new T3.BoxGeometry(.5, len, .5), body));
      post.position.set(s * (tx + bx) / 2, y0 + Hb / 2, (tz + bz) / 2); post.rotation.set(Math.atan2(tz - bz, Hb), 0, -s * Math.atan2(tx - bx, Hb));
      const pin = add(new T3.Mesh(new T3.CylinderGeometry(.3, .3, 1.5, 14), dark)); pin.rotation.z = Math.PI / 2; pin.position.set(s * (tx + .75), yt - 2.3, 0);
    }
    const sill = add(new T3.Mesh(new T3.BoxGeometry(bx * 2 + .5, .5, .5), body)); sill.position.set(0, y0, bz);
    for (const [x, z] of [[-bx + .7, bz - .9], [bx - .7, bz - .9], [-bx + .7, -bz + .9], [bx - .7, -bz + .9]]) {
      const w = add(new T3.Mesh(new T3.CylinderGeometry(.95, .95, .6, 26), dark)); w.rotation.z = Math.PI / 2; w.position.set(x, .95, z);
      const f = add(new T3.Mesh(new T3.BoxGeometry(.95, .8, 1.3), dark)); f.position.set(x, 1.6, z);
    }
    // the curved lid, hinged along the back edge
    const c = D + 1.3, h = 2.1, R = (c * c / 4 + h * h) / (2 * h), a0 = Math.atan2(R - h, c / 2);
    const sh = new T3.Shape(); sh.moveTo(c / 2, 0); sh.absarc(0, -(R - h), R, a0, Math.PI - a0, false); sh.lineTo(c / 2, 0);
    const lg = new T3.ExtrudeGeometry(sh, { depth: W + 1.1, bevelEnabled: true, bevelSize: .14, bevelThickness: .14, bevelSegments: 2, curveSegments: 30 });
    lg.translate(0, 0, -(W + 1.1) / 2); lg.rotateY(Math.PI / 2);
    const lidMat = o.cutaway ? new T3.MeshStandardMaterial({ color: 0x18221e, roughness: .35, metalness: .1, transparent: true, opacity: .3, depthWrite: false, envMapIntensity: .3 }) : dark;
    const lid = new T3.Mesh(lg, lidMat); lid.castShadow = !o.cutaway; lid.position.set(0, 0, c / 2);
    const hinge = new T3.Group(); hinge.position.set(0, yt + .4, -c / 2); hinge.add(lid); g.add(hinge);
    return { group: g, hinge, d: { W, D, Hb, y0, yt, k, tx, tz } };
  }
  /* rubbish bags: crumpled, a little squashed */
  function bagKit(T3) {
    const geos = [0, 1, 2].map(s => { const geo = new T3.IcosahedronGeometry(1, 2), p = geo.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i), n = 1 + .17 * Math.sin(x * 3.1 + s * 2) * Math.cos(y * 2.7 + s) + .1 * Math.sin(z * 4.3 + s * 5); p.setXYZ(i, x * n, y * n * .78, z * n); } geo.computeVertexNormals(); return geo; });
    const mats = [[0x1b1e21, .3], [0x1b1e21, .3], [0x30353a, .38], [0xd9d4c8, .5], [0x24509a, .42]].map(([c, r]) => new T3.MeshStandardMaterial({ color: c, roughness: r, metalness: 0, envMapIntensity: .7 }));
    return () => { const m = new T3.Mesh(geos[(rnd() * 3) | 0], mats[(rnd() * mats.length) | 0]); m.rotation.set(rnd() * 6, rnd() * 6, rnd() * 6); m.castShadow = true; return m; };
  }

  /* How it works: a bin cut open. The sensor under the lid pings the rubbish; the slider fills the bin. */
  let binFill = .65, setBinFill = null;
  function buildBinScene(T3, host) {
    const cvs = $("#bin3d"), st = studio(T3, cvs, host, { fov: 26, shadows: true });
    const bin = makeBin(T3, { cutaway: true }), d = bin.d, pivot = new T3.Group(); pivot.add(bin.group); st.scene.add(pivot);
    const bag = bagKit(T3), bags = [], layers = 7, innerH = d.Hb - .7, lh = innerH / layers;
    for (let L = 0; L < layers; L++) {
      const y = d.y0 + .35 + (L + .5) * lh, s = d.k + (1 - d.k) * (y - d.y0) / d.Hb, sx = (d.W - 2.3) * s / 4, sz = (d.D - 2.1) * s / 3;
      for (let ix = 0; ix < 4; ix++) for (let iz = 0; iz < 3; iz++) {
        const m = bag(); m.position.set((ix - 1.5) * sx + (rnd() - .5) * .7, y + (rnd() - .5) * .35, (iz - 1) * sz + (rnd() - .5) * .6);
        m.userData = { s: 1.42 + rnd() * .4, need: (L + .4) / layers, cur: 0 }; m.scale.setScalar(.001); bin.group.add(m); bags.push(m);
      }
    }
    // the sensor (drawn six times its real size so it can be seen) and its sound
    const ys = d.yt - .55, sensor = new T3.Group(); sensor.position.set(0, ys, 0);
    const pcb = new T3.Mesh(new T3.BoxGeometry(2.9, .14, 1.3), new T3.MeshStandardMaterial({ color: 0x1d4fa6, roughness: .5 })); pcb.position.y = .35; sensor.add(pcb);
    const metal = new T3.MeshStandardMaterial({ color: 0xdfe3e7, metalness: 1, roughness: .28 });
    for (const x of [-.82, .82]) { const can = new T3.Mesh(new T3.CylinderGeometry(.5, .5, .62, 28), metal); can.position.set(x, 0, 0); sensor.add(can); }
    const led = new T3.Mesh(new T3.SphereGeometry(.11, 12, 12), new T3.MeshBasicMaterial({ color: 0x3fe0a0 })); led.position.set(1.25, .26, .45); sensor.add(led);
    bin.group.add(sensor);
    const beam = new T3.Mesh(new T3.ConeGeometry(1, 1, 44, 1, true), new T3.MeshBasicMaterial({ color: 0x16a070, transparent: true, opacity: .1, side: T3.DoubleSide, depthWrite: false })); bin.group.add(beam);
    const rings = [0, 1, 2, 3].map(() => { const r = new T3.Mesh(new T3.TorusGeometry(1, .045, 8, 60), new T3.MeshBasicMaterial({ color: 0x16a070, transparent: true, opacity: 0, depthWrite: false })); r.rotation.x = Math.PI / 2; bin.group.add(r); return r; });
    const hit = new T3.Mesh(new T3.RingGeometry(.82, 1, 56), new T3.MeshBasicMaterial({ color: 0xe0a02a, transparent: true, opacity: 0, side: T3.DoubleSide, depthWrite: false })); hit.rotation.x = -Math.PI / 2; bin.group.add(hit);
    const out = new T3.Color(0x16a070), back = new T3.Color(0xe0a02a);
    const orb = { yaw: -.5, pitch: 0, step() {} };   // the bin holds still: no drag, no sway
    st.fit((W, H) => { const a = W / H, z = a < 1.15 ? 46 * 1.15 / a : 46; st.camera.position.set(0, 17 + (z - 46) * .2, z); st.camera.lookAt(0, 7.4, 0); });
    let fill = 0, ph = 0;
    st.frame((dt, t) => {
      orb.step(dt, t); pivot.rotation.y = orb.yaw; pivot.rotation.x = orb.pitch * .5;
      fill += (binFill - fill) * (still ? 1 : Math.min(1, dt * 4));
      for (const m of bags) { const u = m.userData, to = fill >= u.need ? 1 : 0; u.cur += (to - u.cur) * (still ? 1 : Math.min(1, dt * 7)); m.scale.setScalar(Math.max(.001, u.cur * u.s)); m.visible = u.cur > .01; }
      const top = d.y0 + .35 + Math.min(fill, .985) * innerH + .5, dist = Math.max(.5, ys - .4 - top), r = Math.min(4.2, .5 + dist * .3);
      beam.position.y = ys - .35 - dist / 2; beam.scale.set(r, dist, r);
      ph = (ph + dt / (.9 + dist * .13)) % 1;                                        // an emptier bin: a longer wait for the echo
      rings.forEach((m, k) => {
        const p = (ph + k / 4) % 1, down = p < .5, u = down ? p * 2 : (1 - p) * 2, rr = .4 + u * (r - .4);
        m.position.y = ys - .35 - u * dist; m.scale.set(rr, rr, 1); m.material.color.copy(down ? out : back); m.material.opacity = still ? (k % 2 ? 0 : .5) : Math.sin(Math.PI * (p * 2 % 1)) * .85;
      });
      const q = (ph % .25) / .25; hit.position.y = top + .08; hit.scale.setScalar(r * (.72 + q * .5)); hit.material.opacity = still ? .4 : (1 - q) * .6;
    });
    setBinFill = () => st.kick();
  }

  /* Problem: a bin that nobody came for */
  function buildOverflow(T3, host) {
    const cvs = host.querySelector("canvas"), st = studio(T3, cvs, host, { fov: 24, shadows: true, shadowOpacity: .16 });
    const bin = makeBin(T3), d = bin.d, pivot = new T3.Group(); pivot.add(bin.group); st.scene.add(pivot);
    const bag = bagKit(T3), heap = [];
    for (let k = 0; k < 13; k++) {
      const a = k / 13 * 6.28 + rnd(), rr = k < 5 ? 1.2 : 3.6 + rnd(), m = bag();
      m.position.set(Math.cos(a) * rr * 1.15, d.yt - .2 + (k < 5 ? 2.3 + rnd() * .9 : rnd() * 1.3), Math.sin(a) * rr * .8); m.scale.setScalar(1.55 + rnd() * .45); m.userData.y = m.position.y; m.userData.p = rnd() * 6; bin.group.add(m); heap.push(m);
    }
    for (const [x, z, s] of [[d.tx + 2.6, 2.4, 1.7], [d.tx + 4.6, -.6, 1.5], [-d.tx - 2.4, 3.2, 1.6], [d.tx + 3.1, 4.6, 1.3]]) { const m = bag(); m.position.set(x, s * .72, z); m.scale.setScalar(s); pivot.add(m); }
    bin.hinge.rotation.x = -.72;
    const orbS = { yaw: -.55 };
    st.fit((W, H) => { st.camera.position.set(0, 19, 62); st.camera.lookAt(0, 8.6, 0); st.camera.setViewOffset(W, H, W * .27, 0, W, H); });
    st.frame((dt, t) => {
      pivot.rotation.y = orbS.yaw + (still ? 0 : Math.sin(t / 3.1) * .22);
      bin.hinge.rotation.x = -.72 + (still ? 0 : Math.sin(t * 1.9) * .035);
      if (!still) for (const m of heap) m.position.y = m.userData.y + Math.sin(t * 1.6 + m.userData.p) * .07;
    });
  }

  /* Problem: 96 bins, one for about every 110 on Edinburgh's streets */
  function buildField(T3, host) {
    const cvs = host.querySelector("canvas"), st = studio(T3, cvs, host, { ortho: true, shadows: true, shadowSize: 22, shadowOpacity: .18 });
    const cols = 16, rows = 6, n = cols * rows, dx = 1.62, dz = 1.5;
    const bodyG = new T3.BoxGeometry(1, 1.05, .8); bodyG.translate(0, .62, 0);
    const lidG = new T3.BoxGeometry(1.12, .2, .92); lidG.translate(0, 1.25, 0);
    const bodies = new T3.InstancedMesh(bodyG, new T3.MeshStandardMaterial({ color: 0xffffff, roughness: .5, metalness: .05, envMapIntensity: .6 }), n);
    const lids = new T3.InstancedMesh(lidG, new T3.MeshStandardMaterial({ color: 0x18221e, roughness: .4, metalness: .2, envMapIntensity: .6 }), n);
    bodies.castShadow = lids.castShadow = true; st.scene.add(bodies, lids);
    const green = new T3.Color(0x245c43), hot = new T3.Color(0xc93a22), col = new T3.Color(), M = new T3.Matrix4(), P = new T3.Vector3(), Q = new T3.Quaternion(), S = new T3.Vector3();
    const info = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) info.push({ x: (c - (cols - 1) / 2) * dx, z: (r - (rows - 1) / 2) * dz, delay: .15 + c * .045 + r * .09, hot: rnd() < .15, ph: rnd() * 6.28 });
    const place = (k, s) => { const i = info[k]; P.set(i.x, 0, i.z); S.setScalar(Math.max(.001, s)); M.compose(P, Q, S); bodies.setMatrixAt(k, M); lids.setMatrixAt(k, M); };
    info.forEach((i, k) => { place(k, still ? 1 : 0); bodies.setColorAt(k, i.hot && still ? hot : green); });
    const yaw = -.52, pitch = .62, dir = new T3.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    st.fit((W, H) => { const a = W / H, hh = Math.max(14.4 / a, 6.9), cam = st.camera; cam.left = -hh * a; cam.right = hh * a; cam.top = hh; cam.bottom = -hh; cam.position.copy(dir).multiplyScalar(60); cam.lookAt(0, .4, 0); });
    const back = x => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
    let t0 = -1;
    st.frame((dt, t) => {
      if (still) return;
      if (t0 < 0) t0 = t; const e = t - t0;
      if (e < 3.2) { info.forEach((i, k) => place(k, back(clamp((e - i.delay) / .55, 0, 1)))); bodies.instanceMatrix.needsUpdate = lids.instanceMatrix.needsUpdate = true; }
      info.forEach((i, k) => { if (!i.hot) return; const u = clamp((Math.sin(e * 1.1 + i.ph) - .2) * 2.2, 0, 1); col.copy(green).lerp(hot, e > 2.4 ? u : 0); bodies.setColorAt(k, col); });
      bodies.instanceColor.needsUpdate = true;
    });
  }

  function buildSensor() {
    const T3 = window.THREE, cvs = $("#sensor3d"), stage = $("#stage");
    const renderer = new T3.WebGLRenderer({ canvas: cvs, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputEncoding = T3.sRGBEncoding;
    renderer.toneMapping = T3.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    renderer.physicallyCorrectLights = true;
    const scene = new T3.Scene();
    const camera = new T3.PerspectiveCamera(28, 1, 1, 1000);
    camera.position.set(0, 4, 118);

    // a soft studio for the metal to reflect: a grey room with three light panels
    const pm = new T3.PMREMGenerator(renderer);
    const room = new T3.Scene();
    room.add(new T3.Mesh(new T3.BoxGeometry(100, 100, 100), new T3.MeshBasicMaterial({ color: 0x6f7773, side: T3.BackSide })));
    const panel = (w, h, x, y, z, ry, rx, k) => { const m = new T3.Mesh(new T3.PlaneGeometry(w, h), new T3.MeshBasicMaterial({ color: new T3.Color(k, k, k), side: T3.DoubleSide })); m.position.set(x, y, z); m.rotation.set(rx, ry, 0); room.add(m); };
    panel(60, 20, 0, 45, 0, 0, Math.PI / 2, 5);
    panel(30, 40, -48, 5, 10, Math.PI / 2, 0, 3);
    panel(30, 40, 48, 0, 20, -Math.PI / 2, 0, 1.8);
    panel(60, 30, 0, 0, 49, Math.PI, 0, 1.4);
    scene.environment = pm.fromScene(room, .035).texture;
    const key = new T3.DirectionalLight(0xffffff, 2.2); key.position.set(-30, 50, 80); scene.add(key);
    scene.add(new T3.HemisphereLight(0xffffff, 0x8899aa, .6));

    const tex = (w, h, draw) => { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h); const t = new T3.CanvasTexture(c); t.encoding = T3.sRGBEncoding; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); return t; };
    const PX = 40;                                           // texture pixels per millimetre
    const BLUE = "#1d4fa6", BLUE_D = "#173f87";
    const hole = (g, x, y) => {                               // a plated mounting hole at board coordinates (mm, origin centre, y up)
      const cx = (x + 22.5) * PX, cy = (10 - y) * PX;
      g.fillStyle = "#d4b25a"; g.beginPath(); g.arc(cx, cy, 1.1 * PX, 0, 7); g.fill();
      g.fillStyle = "#1b1d1f"; g.beginPath(); g.arc(cx, cy, .6 * PX, 0, 7); g.fill();
    };
    const traces = (g, seed) => {
      g.strokeStyle = BLUE_D; g.lineWidth = .35 * PX; g.lineCap = "round"; g.lineJoin = "round";
      let r = seed; const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
      for (let k = 0; k < 22; k++) {
        let x = rnd() * 45 * PX, y = rnd() * 20 * PX; g.beginPath(); g.moveTo(x, y);
        for (let s = 0; s < 3; s++) { if (rnd() < .5) x += (rnd() - .5) * 14 * PX; else y += (rnd() - .5) * 8 * PX; g.lineTo(x, y); }
        g.stroke();
      }
    };
    const front = tex(45 * PX, 20 * PX, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, "#2257b1"); gr.addColorStop(1, BLUE); g.fillStyle = gr; g.fillRect(0, 0, w, h);
      traces(g, 7);
      [[-21, 8.5], [21, 8.5], [-21, -8.5], [21, -8.5]].forEach(([x, y]) => hole(g, x, y));
      g.fillStyle = "#f4f6f8"; g.textAlign = "center"; g.textBaseline = "middle";
      g.font = `700 ${2.1 * PX}px Arial, sans-serif`; g.fillText("HC-SR04", 22.5 * PX, 3.2 * PX);
      g.font = `700 ${1.6 * PX}px Arial, sans-serif`; g.fillText("T", 3.2 * PX, 18.2 * PX); g.fillText("R", 41.8 * PX, 18.2 * PX);
      g.save(); g.translate(22.5 * PX, 14.8 * PX); g.font = `600 ${1.05 * PX}px Arial, sans-serif`;
      ["Vcc", "Trig", "Echo", "Gnd"].forEach((t, k) => { g.save(); g.translate((k - 1.5) * 2.54 * PX, 0); g.rotate(-Math.PI / 2); g.fillText(t, 0, 0); g.restore(); });
      g.restore();
      // solder pads for the four header pins
      for (let k = 0; k < 4; k++) { g.fillStyle = "#cfd3d6"; g.beginPath(); g.arc((22.5 + (k - 1.5) * 2.54) * PX, 18.6 * PX, .75 * PX, 0, 7); g.fill(); }
    });
    const back = tex(45 * PX, 20 * PX, (g, w, h) => {
      g.fillStyle = BLUE; g.fillRect(0, 0, w, h); traces(g, 19);
      [[-21, 8.5], [21, 8.5], [-21, -8.5], [21, -8.5]].forEach(([x, y]) => hole(g, -x, y));
      g.fillStyle = "#f4f6f8"; g.textAlign = "center"; g.font = `600 ${1.2 * PX}px Arial, sans-serif`; g.fillText("BinSight firmware", 22.5 * PX, 18.6 * PX);
    });
    const edge = new T3.MeshStandardMaterial({ color: 0x1a4796, roughness: .6 });
    const pcb = new T3.Mesh(new T3.BoxGeometry(45, 20, 1.6), [edge, edge, edge, edge,
      new T3.MeshStandardMaterial({ map: front, roughness: .48, metalness: .05 }), new T3.MeshStandardMaterial({ map: back, roughness: .5 })]);
    const board = new T3.Group(); board.add(pcb);

    const metal = new T3.MeshStandardMaterial({ color: 0xdfe3e7, metalness: 1, roughness: .26 });
    const plastic = new T3.MeshStandardMaterial({ color: 0x1b1d1f, roughness: .55 });
    const mesh = tex(512, 512, (g, w, h) => {
      g.fillStyle = "#1d1f22"; g.fillRect(0, 0, w, h);
      g.strokeStyle = "rgba(205,210,215,.55)"; g.lineWidth = 2.2;
      for (let k = -w; k < 2 * w; k += 11) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k + h, h); g.stroke(); g.beginPath(); g.moveTo(k + h, 0); g.lineTo(k, h); g.stroke(); }
      const v = g.createRadialGradient(w / 2, h / 2, w * .2, w / 2, h / 2, w * .5); v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,.55)"); g.fillStyle = v; g.fillRect(0, 0, w, h);
    });
    const grille = new T3.MeshStandardMaterial({ map: mesh, metalness: .6, roughness: .45 });
    const cyl = (r, h, mat, open) => { const m = new T3.Mesh(new T3.CylinderGeometry(r, r, h, 72, 1, open), mat); m.rotation.x = Math.PI / 2; return m; };
    const can = x => {
      const g = new T3.Group(); g.position.set(x, 1, .8);
      const foot = cyl(8.25, 1, plastic); foot.position.z = .5; g.add(foot);
      const body = cyl(8, 11.6, metal, true); body.position.z = 1 + 5.8; g.add(body);
      const lip = new T3.Mesh(new T3.TorusGeometry(7.65, .42, 16, 72), metal); lip.position.z = 12.55; g.add(lip);
      const face = new T3.Mesh(new T3.CircleGeometry(7.5, 72), grille); face.position.z = 12.1; g.add(face);
      const inner = new T3.Mesh(new T3.RingGeometry(7.2, 7.6, 72), new T3.MeshStandardMaterial({ color: 0x0e0f10, roughness: .8 })); inner.position.z = 12.15; g.add(inner);
      board.add(g);
    };
    can(-13); can(13);
    // sound leaving the left can and coming back to the right one
    const rings = [];
    for (let k = 0; k < 3; k++) for (const [x, colr, dirn] of [[-13, 0x12906a, 1], [13, 0xd9982b, -1]]) {
      const r = new T3.Mesh(new T3.RingGeometry(.93, 1, 64), new T3.MeshBasicMaterial({ color: colr, transparent: true, opacity: 0, depthWrite: false, side: T3.DoubleSide }));
      r.position.set(x, 1, 14); board.add(r); rings.push([r, k, dirn]);
    }
    const pulse = now => rings.forEach(([m, k, dirn]) => { let u = (now / 2400 + k / 3) % 1; if (dirn < 0) u = 1 - u; m.position.z = 14 + u * 24; const sc = 7 + u * 8; m.scale.set(sc, sc, 1); m.material.opacity = still ? 0 : Math.sin(Math.PI * u) * .6; });
    // the crystal oscillator (HC-49/S): a rounded metal can lying between the transducers
    const xs = new T3.Shape(), L = 5.5, Rr = 2.3;
    xs.moveTo(-L + Rr, -Rr); xs.lineTo(L - Rr, -Rr); xs.absarc(L - Rr, 0, Rr, -Math.PI / 2, Math.PI / 2, false); xs.lineTo(-L + Rr, Rr); xs.absarc(-L + Rr, 0, Rr, Math.PI / 2, Math.PI * 1.5, false);
    const xtal = new T3.Mesh(new T3.ExtrudeGeometry(xs, { depth: 3, bevelEnabled: true, bevelSize: .35, bevelThickness: .35, bevelSegments: 4, curveSegments: 24 }), metal);
    xtal.position.set(0, 6.4, .8 + .35); board.add(xtal);
    // the four header pins and their plastic spacer, sticking out of the bottom edge
    const spacer = new T3.Mesh(new T3.BoxGeometry(10.16, 2.5, 2.5), plastic); spacer.position.set(0, -11.25, 0); board.add(spacer);
    const pinMat = new T3.MeshStandardMaterial({ color: 0xd8c27a, metalness: 1, roughness: .3 });
    for (let k = 0; k < 4; k++) { const p = new T3.Mesh(new T3.BoxGeometry(.64, 8.6, .64), pinMat); p.position.set((k - 1.5) * 2.54, -13.6, 0); board.add(p); }
    // chips on the back
    [[-9, 2, 6, 4], [3, 2, 6, 4], [12.5, -3, 4.5, 4]].forEach(([x, y, w, h]) => {
      const c = new T3.Mesh(new T3.BoxGeometry(w, h, 1.5), plastic); c.position.set(x, y, -.8 - .75); board.add(c);
      for (let k = 0; k < Math.round(w / 1.27); k++) [-1, 1].forEach(s => { const l = new T3.Mesh(new T3.BoxGeometry(.4, .9, .3), metal); l.position.set(x - w / 2 + .6 + k * 1.27, y + s * (h / 2 + .35), -.95); board.add(l); });
    });
    const pivot = new T3.Group(); pivot.add(board); board.position.set(0, 1.5, -6); scene.add(pivot);
    // a soft contact shadow on the floor
    const shTex = tex(256, 256, (g, w, h) => { const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); r.addColorStop(0, "rgba(0,0,0,.32)"); r.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = r; g.fillRect(0, 0, w, h); });
    shTex.encoding = T3.LinearEncoding;
    const shadow = new T3.Mesh(new T3.PlaneGeometry(70, 26), new T3.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = -24; scene.add(shadow);

    // hotspots follow points on the model
    const spots = { t: new T3.Vector3(-21, 1, 9), r: new T3.Vector3(21, 1, 9), x: new T3.Vector3(2.5, 8.6, 3.5), p: new T3.Vector3(0, -17.8, 0) };
    const spotEls = $$(".hs", stage);
    const nrm = new T3.Vector3(), tmp = new T3.Vector3(), camDir = new T3.Vector3();

    // turning: drag to spin, it settles back into a gentle sway
    let yaw = -.55, pitch = .32, vy = 0, vp = 0, drag = null, idle = 0, t0 = performance.now(), dirty = true;
    const still = reduce.matches;
    cvs.addEventListener("pointerdown", e => { drag = [e.clientX, e.clientY]; cvs.setPointerCapture(e.pointerId); stage.classList.add("grabbing"); $("#stageHint").style.opacity = 0; });
    cvs.addEventListener("pointermove", e => {
      if (!drag) return;
      const dx = e.clientX - drag[0], dy = e.clientY - drag[1]; drag = [e.clientX, e.clientY];
      vy = dx * .012; vp = dy * .008; yaw += vy; pitch = Math.max(-.9, Math.min(1.1, pitch + vp)); idle = 0; dirty = true;
    });
    const up = () => { drag = null; stage.classList.remove("grabbing"); };
    cvs.addEventListener("pointerup", up); cvs.addEventListener("pointercancel", up);

    let W3 = 0, H3 = 0;
    const size = () => {
      const r = stage.getBoundingClientRect(); W3 = r.width; H3 = r.height;
      renderer.setSize(W3, H3, false); camera.aspect = W3 / H3;
      camera.position.z = W3 / H3 < .9 ? 185 : 140;                // phones: step back a little
      camera.updateProjectionMatrix(); dirty = true;
    };
    new ResizeObserver(size).observe(stage); size();
    let onScreen = true;
    const sPage = stage.closest(".page"), seen = () => onScreen && !document.hidden && !(sPage && sPage.classList.contains("buried"));
    new IntersectionObserver(es => { onScreen = es[0].isIntersecting; if (seen()) loop(); }).observe(stage);
    addEventListener("bs:pages", () => { if (seen()) loop(); }); document.addEventListener("visibilitychange", () => { if (seen()) loop(); });
    let running = false;
    function loop() {
      if (running) return; running = true;
      const step = now => {
        if (!seen()) { running = false; return; }
        const dt = Math.min(.05, (now - t0) / 1000); t0 = now; idle += dt;
        if (!drag) {
          yaw += vy; pitch = Math.max(-.9, Math.min(1.1, pitch + vp)); vy *= .94; vp *= .9;
          if (!still && idle > 2.5) { yaw += (-.55 + Math.sin(now / 2600) * .45 - yaw) * .012; pitch += (.32 - pitch) * .015; }
          if (!still || Math.abs(vy) > 1e-4 || Math.abs(vp) > 1e-4) dirty = true;
        }
        if (dirty) {
          pulse(now); pivot.rotation.set(pitch, yaw, 0); pivot.position.y = still ? 0 : Math.sin(now / 1800) * .6;
          renderer.render(scene, camera);
          pivot.updateMatrixWorld();
          nrm.set(0, 0, 1).transformDirection(board.matrixWorld);
          camera.getWorldDirection(camDir);
          const facing = -nrm.dot(camDir);
          spotEls.forEach(el => {
            const k = el.dataset.hs;
            tmp.copy(spots[k]).applyMatrix4(board.matrixWorld).project(camera);
            const x = (tmp.x + 1) / 2 * W3, y = (1 - tmp.y) / 2 * H3;
            const show = k === "p" ? 1 : Math.max(0, Math.min(1, (facing - .25) * 3));
            el.style.opacity = W3 < 380 && k === "x" ? 0 : show;
            const right = k === "r" || k === "x" ? true : k === "t" ? false : x > W3 * .5;
            el.style.transform = `translate(${right ? x - 5 : x - el.offsetWidth + 5}px, ${y - el.offsetHeight / 2}px)`;
            el.style.flexDirection = right ? "row" : "row-reverse";
            el.style.padding = right ? "5px 11px 5px 6px" : "5px 6px 5px 11px";
          });
          dirty = still ? false : dirty;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    loop();
  }


  lazy($("#stage"), buildSensor, () => { const f = $("#stageFallback"); if (f) f.hidden = false; });
  lazy($("#binStage"), buildBinScene, () => { const f = $("#binFallback"); if (f) f.hidden = false; });
  lazy($("#vOver3d"), buildOverflow);
  lazy($("#vField3d"), buildField);

  /* how the sensor measures: time the echo, get the distance, get the fill (an example bin 1.2 m deep) */
  const fillIn = $("#eFill");
  if (fillIn) {
    const DEPTH = 1.2, SOUND = 343;
    const upd = () => {
      const f = +fillIn.value / 100, dist = Math.max(.02, DEPTH * (1 - f));
      $("#oFill").textContent = Math.round(f * 100) + " %";
      $("#eTime").textContent = (2 * dist / SOUND * 1000).toFixed(1) + " ms";
      $("#eDist").textContent = dist.toFixed(2) + " m";
      $("#ePct").textContent = Math.round((1 - dist / DEPTH) * 100) + " %";
      binFill = f; setBinFill && setBinFill();
    };
    fillIn.addEventListener("input", upd); upd();
  }
})();

boot().catch(err => {
  console.error(err);
  const n = $("#mapNote"); if (n) n.textContent = "Data failed to load: " + err.message;
});
})();
