/* ── the maths: five interactive explainers on the live model output ── */
function rng32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function poisson(l, u) { if (l > 30) { const z = Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u()); return Math.max(0, Math.round(l + Math.sqrt(l) * z)); } let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= u(); } while (p > L); return k - 1; }
const svgAxisY = (x0, x1, y, vals, f) => vals.map(v => `<line class="grid" x1="${x0}" x2="${x1}" y1="${y(v)}" y2="${y(v)}"/><text x="${x0 - 6}" y="${y(v) + 4}" text-anchor="end">${f(v)}</text>`).join("");
const FEATURE_LABEL = { fill: "Latest reading", rate: "Fill rate since last emptied", d24: "Change over the last 24 h", hours_since: "Hours since last emptied", cap: "Capacity", weekday: "Weekday", rain_h: "Hours of rain ahead", temp: "Mean temperature ahead", holiday: "Share of holiday hours ahead" };

/* LaTeX: \( … \) inline and \[ … \] display, typeset by KaTeX when it has loaded (raw LaTeX otherwise) */
const TEX_DELIMS = [{ left: "\\[", right: "\\]", display: true }, { left: "\\(", right: "\\)", display: false }];
const typeset = el => { if (window.renderMathInElement) renderMathInElement(el, { delimiters: TEX_DELIMS, throwOnError: false }); };
const tex = s => window.katex ? katex.renderToString(s, { throwOnError: false }) : s;

function initMaths() {
  const M = D.site.maths; if (!M) return;
  const P = M.params, F = M.forecast;
  // tabs
  const show = k => { $$("#mTabs button").forEach(b => b.classList.toggle("on", +b.dataset.m === k)); $$(".m-pane").forEach(p => p.hidden = +p.dataset.m !== k); };
  $$("#mTabs button").forEach(b => b.onclick = () => show(+b.dataset.m));
  BS.mathsTab = show;
  // numbers in the text
  const vals = {
    K: fmt(P.COLLECT_EVERY_DAYS), sigma: P.DAILY_FILL_SPREAD.toFixed(2), bag: fmt(P.BAG_L), U: P.FILL_AT_COLLECTION.toFixed(3), noise: fmt(P.SENSOR_NOISE),
    trees: fmt(F.trees), nTrain: fmt(F.n_train), floor: fmt(P.FLOOR), loadM3: fmt(P.TRUCK_LOAD_L / 1000),
    roadKm: fmt(D.site.totals.road_km), nStops: fmt(M.route.stops), fleet: fmt(D.site.fleet.trucks),
    snap: dayTime(new Date(D.site.snapshot)), tgt: dayTime(fcTarget()), planDay: new Date(D.site.plan_day + "T12:00").toLocaleString("en-GB", { weekday: "long" }),
  };
  $$("[data-mk]").forEach(el => { const v = vals[el.dataset.mk]; if (v != null) el.textContent = v; });
  // @key@ tokens in the text and in the LaTeX, then typeset the LaTeX with KaTeX
  const fl = D.site.fleet, sg = P.DAILY_FILL_SPREAD;
  const tok = {
    K: fmt(P.COLLECT_EVERY_DAYS), bag: fmt(P.BAG_L), noise: fmt(P.SENSOR_NOISE), target: fmt(100 * P.TARGET_OVERFLOW),
    U: P.FILL_AT_COLLECTION.toFixed(3), sigma: sg.toFixed(2), meanColl: fmt(100 * P.FILL_AT_COLLECTION * Math.exp(sg * sg / 2)),
    betas: `${P.RAIN_EFFECT}, ${P.TEMP_EFFECT}, ${P.HOLIDAY_EFFECT}`, H: fmt(F.example.hours), trees: fmt(F.trees), nTrain: fmt(F.n_train),
    floor: fmt(P.FLOOR), fleet: fmt(fl.trucks), loadM3: fmt(P.TRUCK_LOAD_L / 1000), shift: fmt(P.SHIFT_MIN), tip: fmt(P.TIP_MIN),
    s0: fmt(P.SERVICE_BASE_MIN), s1: fmt(P.SERVICE_PER_BIN_MIN), kappa: P.RAIN_SLOWDOWN.toFixed(2), reactive: fmt(P.REACTIVE_AT),
    costKm: P.COST_KM.toFixed(2), costHour: fmt(P.COST_HOUR), costOverflow: fmt(P.COST_OVERFLOW), exY: fmt(F.example.past[F.example.past.length - 1]), exG: (F.example.gain_day / 24).toFixed(1), exP: fmt(F.example.proj),
  };
  const root = $("#maths"), walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) if (n.nodeValue.includes("@")) n.nodeValue = n.nodeValue.replace(/@(\w+)@/g, (m, k) => tok[k] ?? m);
  typeset(root);
  mathsSimulate(M); mathsPredict(M); mathsDecide(M); mathsRoute(M); mathsCheck(M);
}

/* 1 · Poisson bag arrivals, emptied by the timetable every K days */
function mathsSimulate(M) {
  const P = M.params, cap = M.forecast.example.cap, K = P.COLLECT_EVERY_DAYS * 24;
  const hw = M.fill.hour_w, hm = hw.reduce((s, v) => s + v, 0) / hw.length, a = hw.map(v => v / hm);
  let seed = 11;
  const draw = () => {
    const rho = +$("#mRho").value; $("#oRho").textContent = rho.toFixed(2);
    const W = 520, H = 260, l = 34, r = 10, t = 14, b = 28, x = h => l + h / 168 * (W - l - r), y = v => t + (1 - v / 100) * (H - t - b);
    const bagsDay = cap * rho / P.BAG_L;
    const paths = [], over = [], atColl = [];
    for (let s = 0; s < 3; s++) {
      const u = rng32(seed * 97 + s * 13 + 1), c0 = 8 + Math.floor(u() * 8);   // the truck comes between 08:00 and 16:00
      // the last truck came K − c0 hours before Monday 00:00
      let L = cap * rho * (K - c0) / 24, full = false; const pts = [[0, Math.min(100, 100 * L / cap)]], hits = [];
      for (let h = 0; h < 168; h++) {
        if (h % K === c0) { atColl.push(Math.min(100, 100 * L / cap)); L = 0; full = false; pts.push([h, 0]); }
        L += poisson(bagsDay * a[h % 24] / 24, u) * P.BAG_L;
        const v = Math.min(100, 100 * L / cap); pts.push([h + 1, v]);
        if (v >= 100 && !full) { full = true; hits.push(h + 1); }
      }
      paths.push(pts); over.push(hits);
    }
    const line = pts => pts.map(([h, v], k) => `${k ? "L" : "M"}${x(h).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const cols = [PAL.accent, PAL.f[3], PAL.ink];
    $("#mPaths").innerHTML = svgAxisY(l, W - r, y, [0, 50, 100], v => v + "%") +
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, k) => `<text x="${x(k * 24 + 12)}" y="${H - 8}" text-anchor="middle">${d}</text><line class="ax" x1="${x(k * 24)}" x2="${x(k * 24)}" y1="${y(0)}" y2="${y(0) + 4}"/>`).join("") +
      paths.map((p, s) => `<path d="${line(p)}" fill="none" stroke="${cols[s]}" stroke-width="1.7" opacity=".9"/>` + over[s].map(h => `<circle cx="${x(h)}" cy="${y(100)}" r="4" fill="${PAL.bad}"/>`).join("")).join("") +
      `<text x="${W - r}" y="${y(100) - 5}" text-anchor="end" style="fill:${PAL.bad}">full: overflow until the truck comes</text>`;
    const nOver = over.reduce((s, h) => s + h.length, 0), mean = atColl.length ? atColl.reduce((s, v) => s + v, 0) / atColl.length : 0;
    $("#mPathNote").textContent = `A ${fmt(cap)} L stop filling ${fmt(100 * rho)} % a day, emptied every ${P.COLLECT_EVERY_DAYS} days. These three weeks: ${fmt(mean)} % full on average when the truck came (about ${fmt(Math.min(100, 100 * rho * P.COLLECT_EVERY_DAYS))} % expected), ${nOver} overflow${nOver === 1 ? "" : "s"} in ${atColl.length} collections. Bags arrive at random, so the same rate overflows in one week and not the next. (Weather left out here.)`;
  };
  $("#mRho").oninput = draw; $("#mRedraw").onclick = () => { seed++; draw(); };
  draw();
}

/* 2 · one stop's projection and what the forest looks at */
function mathsPredict(M) {
  const F = M.forecast, ex = F.example, P = M.params;
  $("#fcTitle").textContent = ex.site; $("#fcSub").textContent = `${ex.id} · ${fmt(ex.cap)} L · gains about ${fmt(ex.gain_day, 1)} points a day`;
  const W = 520, H = 250, l = 34, r = 12, t = 12, b = 28, n0 = ex.past.length, n1 = ex.hours;
  const ymax = Math.max(130, Math.ceil((ex.proj + 10) / 10) * 10);
  const x = h => l + (h + n0) / (n0 + n1) * (W - l - r), y = v => t + (1 - Math.max(0, Math.min(v, ymax)) / ymax) * (H - t - b);
  const last = ex.past[n0 - 1];
  const past = ex.past.map((v, j) => `${j ? "L" : "M"}${x(j - n0 + 1).toFixed(1)},${y(v).toFixed(1)}`).join("");
  $("#mFc").innerHTML = svgAxisY(l, W - r, y, [0, 50, 100], v => v + "%") +
    `<line x1="${l}" x2="${W - r}" y1="${y(100)}" y2="${y(100)}" stroke="${PAL.bad}" stroke-dasharray="4 3"/><text x="${l + 4}" y="${y(100) - 5}" style="fill:${PAL.bad}">100 %: overflow</text>` +
    `<line x1="${l}" x2="${W - r}" y1="${y(P.FLOOR)}" y2="${y(P.FLOOR)}" stroke="${PAL.ink3}" stroke-dasharray="2 3"/><text x="${l + 4}" y="${y(P.FLOOR) + 13}" style="fill:${PAL.ink3}">${fmt(P.FLOOR)} % floor</text>` +
    `<path d="${past}" fill="none" stroke="${PAL.ink}" stroke-width="1.6"/>` +
    `<line x1="${x(0)}" y1="${y(last)}" x2="${x(n1)}" y2="${y(ex.proj)}" stroke="${PAL.accent}" stroke-width="2" stroke-dasharray="5 3"/>` +
    `<circle cx="${x(n1)}" cy="${y(ex.proj)}" r="4" fill="${PAL.accent}"/><text x="${x(n1) - 6}" y="${y(ex.proj) - 8}" text-anchor="end" style="fill:${PAL.accent};font-weight:600">ŷ = ${fmt(ex.proj)} %</text>` +
    `<line class="ax" x1="${x(0)}" x2="${x(0)}" y1="${t}" y2="${y(0)}"/><text x="${x(0)}" y="${H - 8}" text-anchor="middle">now (${dayTime(new Date(D.site.snapshot))})</text><text x="${x(-n0 + 1)}" y="${H - 8}">−72 h</text><text x="${W - r}" y="${H - 8}" text-anchor="end">${dayTime(fcTarget())}</text>`;
  $("#fcNote").innerHTML = `Solid: the last 72 hours of readings. Dashed: the projection ${tex(`\\hat y = y + H\\hat g`)} with ${tex(`H = ${fmt(n1)}`)} h, <b>${fmt(ex.proj)} %</b>. ${ex.proj >= P.FLOOR ? `Above the ${fmt(P.FLOOR)} % floor, so it is a candidate for tomorrow.` : `Below the ${fmt(P.FLOOR)} % floor, so it can wait.`}`;
  // importance
  const imp = Object.entries(F.importance).sort((p, q) => q[1] - p[1]);
  const Wi = 520, rowH = 25, x0 = 210, bw = Wi - x0 - 60, mx = imp[0][1] || 1;
  $("#mImp").setAttribute("viewBox", `0 0 ${Wi} ${imp.length * rowH + 8}`);
  $("#mImp").innerHTML = imp.map(([k, v], j) => `<text class="lbl" x="${x0 - 10}" y="${j * rowH + 17}" text-anchor="end">${esc(FEATURE_LABEL[k] || k)}</text><rect x="${x0}" y="${j * rowH + 5}" width="${Math.max(2, v / mx * bw)}" height="16" rx="3" fill="${j ? PAL.ink3 : PAL.accent}" opacity="${j ? .6 : 1}"/><text class="val" x="${x0 + Math.max(2, v / mx * bw) + 6}" y="${j * rowH + 17}">${fmt(100 * v)} %</text>`).join("");
}

/* 3 · fullest first: every stop ranked by projected fill */
function mathsDecide(M) {
  const S = D.S, n = D.n, dm = M.decide, fleet0 = D.site.fleet.trucks;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => S.pred[b] - S.pred[a]);
  const W = 520, H = 300, l = 44, r = 12, t = 30, b = 46, ymax = 150;
  const X = k => l + k / (n - 1) * (W - l - r), Y = v => t + (1 - Math.min(v, ymax) / ymax) * (H - t - b);
  const pts = []; for (let k = 0; k < n; k += 4) pts.push([k, S.pred[order[k]]]); pts.push([n - 1, S.pred[order[n - 1]]]);
  const line = pts.map(([k, v], j) => `${j ? "L" : "M"}${X(k).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  $("#mTrucks").max = Math.max(60, 2 * fleet0); $("#mTrucks").value = fleet0;
  const draw = () => {
    const floor = +$("#mFloor").value, fleet = +$("#mTrucks").value, shift = +$("#mShift").value;
    $("#oFloor").textContent = floor + " %"; $("#oTrucks").textContent = fleet; $("#oShiftM").textContent = shift.toFixed(1) + " h";
    const r_ = BS.choose({ floor, fleet, shift }), nc = r_.cand.length, ns = r_.sel.length;
    const over = r_.cand.slice(ns).filter(i => S.pred[i] >= 100).length;
    const area = pts.filter(([k]) => k < ns).map(([k, v], j) => `${j ? "L" : "M"}${X(k).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    $("#mDec").innerHTML = svgAxisY(l, W - r, Y, [0, 50, 100, 150], v => v + "%") +
      (ns > 1 ? `<path d="${area} L${X(ns - 1)},${Y(0)} L${X(0)},${Y(0)} Z" fill="${PAL.accent}" opacity=".16"/>` : "") +
      `<path d="${line}" fill="none" stroke="${PAL.ink}" stroke-width="1.8"/>` +
      `<line x1="${l}" x2="${W - r}" y1="${Y(floor)}" y2="${Y(floor)}" stroke="${PAL.ink}" stroke-dasharray="5 3"/><text x="${W - r}" y="${Y(floor) - 5}" text-anchor="end">${floor} % line: below it, a bin can wait</text>` +
      `<line x1="${l}" x2="${W - r}" y1="${Y(100)}" y2="${Y(100)}" stroke="${PAL.bad}" stroke-dasharray="2 3" opacity=".7"/><text x="${W - r}" y="${Y(100) - 5}" text-anchor="end" style="fill:${PAL.bad}">100 %: overflow</text>` +
      (ns ? `<line x1="${X(ns - 1)}" x2="${X(ns - 1)}" y1="${t}" y2="${Y(0)}" stroke="${PAL.accent}" stroke-width="1.8"/>` +
        (X(ns - 1) - l > 120 ? `<text x="${(l + X(ns - 1)) / 2}" y="${Y(0) - 12}" text-anchor="middle" style="fill:${PAL.accent};font-weight:650;font-size:13px">get a truck: ${fmt(ns)}</text>` : "") +
        (W - r - X(ns - 1) > 110 ? `<text x="${(X(ns - 1) + W - r) / 2}" y="${Y(0) - 12}" text-anchor="middle" style="font-size:13px">wait: ${fmt(n - ns)}</text>` : "") : "") +
      [1, 1000, 2000, 3000, 4000].filter(k => k < n).map(k => `<line class="ax" x1="${X(k - 1)}" x2="${X(k - 1)}" y1="${Y(0)}" y2="${Y(0) + 4}"/><text x="${X(k - 1)}" y="${Y(0) + 16}" text-anchor="middle">${k === 1 ? "1st" : fmt(k) + "th"}</text>`).join("") +
      `<text x="${l}" y="${H - 6}" style="font-weight:600">← fullest</text><text x="${(l + W - r) / 2}" y="${H - 6}" text-anchor="middle">all ${fmt(n)} bin stops, in order</text><text x="${W - r}" y="${H - 6}" text-anchor="end" style="font-weight:600">emptiest →</text>` +
      `<text x="4" y="14" style="font-weight:600">Forecast fill for tomorrow</text>`;
    $("#decCounts").innerHTML = [[nc, `at or above ${floor} %`], [ns, "fit the fleet’s time"], [nc - ns, "wait a day"]].map(([v, l_]) => `<div><b>${fmt(v)}</b><span>${l_}</span></div>`).join("") +
      `<div style="grid-column:1/-1"><span>${over ? `<b style="display:inline;font-size:15px">${fmt(over)}</b> of the waiting stops are projected past 100 %.` : "No stop projected past 100 % has to wait."} A quick estimate; routing has the final say.</span></div>`;
  };
  $("#mFloor").oninput = draw; $("#mTrucks").oninput = draw; $("#mShift").oninput = draw; draw();
  $("#decNote").textContent = `Tomorrow: ${fmt(dm.risky)} stops are projected at ${fmt(dm.floor)} % or more. Fullest first, ${fmt(dm.chosen)} fit the time of ${fmt(fleet0)} trucks; after routing, ${fmt(dm.served)} are emptied.`;
}

/* 4 · one area, before and after optimising: tomorrow's bins in one window of the city on Edinburgh's street map, planned by the quick rule and by simulated annealing */
function mathsRoute(M) {
  const host = $("#mRoute"), slider = $("#mEx"), still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const COLS = ["#1a73e8", "#f29900", "#9334e6"], RED = "#d93025", step = 1100;   // a colour per trip, red when less than half full
  const dep = [D.site.depot.latitude, D.site.depot.longitude];
  if (!window.L) { host.textContent = "The map library did not load. Check your connection."; return; }
  Promise.all([getJSON("data/route_example.json"), getJSON("data/first_plan.json")]).then(([E, F]) => {
    const plans = E.plans.map(p => ({ ...p, trips: p.trips.map((t, j) => ({ ...t, pts: decode(t.line), col: t.load < .5 ? RED : COLS[j % 3] })) }));
    const area = L.latLngBounds(plans[0].trips.flatMap(t => t.bins));
    // how many bins those stops hold (a stop has one to four), from the stops data
    const at = new Map(D.S.lat.map((la, i) => [`${la.toFixed(5)},${D.S.lon[i].toFixed(5)}`, i]));
    const nBins = plans[0].trips.flatMap(t => t.bins).reduce((a, [la, lo]) => a + (D.S.nb[at.get(`${la.toFixed(5)},${lo.toFixed(5)}`)] || 0), 0);
    const pc = l => { const v = 100 * l; return v > 99.5 && v < 100 ? fmt(v, 1) : fmt(v); };   // 99.6 % is not "100 %"
    let map, inset, seaf, k = -1, timers = [], moved = false;
    const layers = [], base = [];
    // the view: every bin of the example, below the Seafield label and clear of the small map (left of it on wide screens, above it on narrow ones)
    const fit = (animate = false) => {
      const w = inset.offsetWidth + 22, h = inset.offsetHeight + 22, narrow = host.clientWidth < 480;
      map.fitBounds(area, { paddingTopLeft: [narrow ? 20 : w, seaf.offsetHeight + 22], paddingBottomRight: [34, narrow ? h : 24], animate });
    };
    // which way Seafield is from the area, for the arrow on its label
    const mid = area.getCenter(), deg = Math.atan2(dep[0] - mid.lat, (dep[1] - mid.lng) * Math.cos(dep[0] * Math.PI / 180)) * 180 / Math.PI;
    const seafText = p => `<svg viewBox="0 0 16 16" style="transform:rotate(${(-deg).toFixed(0)}deg)" aria-hidden="true"><path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>To Seafield, ${fmt(E.depot_km)} km: <b>${p.trips.length} trips</b> drive it</span>`;
    const build = () => {
      map = L.map(host, { zoomControl: true, attributionControl: true, scrollWheelZoom: true, wheelPxPerZoomLevel: 80, dragging: true, tap: false, minZoom: 10, maxZoom: 19, zoomSnap: .25, zoomDelta: .5 });
      map.fitBounds(area, { animate: false });
      map.attributionControl.setPrefix(false);
      const OSM = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
      map.attributionControl.addAttribution(OSM);
      // zoom freely: wheel, trackpad pinch, double-click, the buttons, two fingers on a phone; drag to move.
      // A page scroll that runs onto the map keeps scrolling the page: the wheel zooms only once it has paused for half a second.
      let pageWheel = 0;
      addEventListener("wheel", e => { if (!host.contains(e.target)) pageWheel = performance.now(); }, { capture: true, passive: true });
      host.addEventListener("wheel", e => { if (performance.now() - pageWheel < 500) { pageWheel = performance.now(); e.stopPropagation(); } }, { capture: true });
      // a button under the zoom buttons goes back to the whole example
      const rc = L.control({ position: "topleft" });
      rc.onAdd = () => {
        const bar = L.DomUtil.create("div", "leaflet-bar ex-reset");
        bar.innerHTML = '<a href="#" role="button" title="Back to the whole example" aria-label="Back to the whole example"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></a>';
        L.DomEvent.disableClickPropagation(bar);
        L.DomEvent.on(bar.firstChild, "click", e => { L.DomEvent.preventDefault(e); fit(true); setTimeout(() => { moved = false; }, 0); });
        return bar;
      };
      rc.addTo(map);
      ["pointerdown", "wheel", "touchstart"].forEach(ev => host.addEventListener(ev, () => { moved = true; }, { passive: true }));
      // a light vector map from our own road data, until the street tiles are drawn
      const cv = L.canvas({ padding: .3 }), B = D.base;
      const parks = B.parks.filter(p => p.k === "park").map(p => decode(p.ring)), lakes = B.parks.filter(p => p.k === "water").map(p => decode(p.ring));
      if (parks.length) base.push(L.polygon(parks, { renderer: cv, stroke: false, fillColor: "#c9eac6", fillOpacity: 1, interactive: false }));
      if (lakes.length) base.push(L.polygon(lakes, { renderer: cv, stroke: false, fillColor: "#aadaff", fillOpacity: 1, interactive: false }));
      for (const [cls, w] of [["local", 1], ["minor", 1.6], ["major", 2.6]]) if ((B.roads[cls] || []).length) base.push(L.polyline(B.roads[cls].map(l => decode(l)), { renderer: cv, color: "#d3d6da", weight: w, interactive: false }));
      base.forEach(l => l.addTo(map));
      // Seafield, for anyone who zooms out
      L.circleMarker(dep, { radius: 7, color: "#fff", weight: 2, fillColor: "#202124", fillOpacity: 1 }).bindTooltip("Seafield depot", { permanent: true, direction: "right", offset: [8, 0], className: "ex-dep" }).addTo(map);
      // one pane per plan; each trip a white-cased line in its colour and its bins as dots
      plans.forEach((p, i) => {
        const pane = "ex" + i; map.createPane(pane).style.zIndex = 450; map.getPane(pane).style.display = "none";
        const r = L.svg({ pane, padding: .5 });
        layers[i] = p.trips.map((t, j) => ({
          lines: [L.polyline(t.pts, { pane, renderer: r, color: "#fff", weight: t.load < .5 ? 10 : 8.5, opacity: .95, lineJoin: "round", lineCap: "round", interactive: false }),
                  L.polyline(t.pts, { pane, renderer: r, color: t.col, weight: t.load < .5 ? 6 : 4.5, opacity: 1, lineJoin: "round", lineCap: "round", interactive: false })]
            .map(l => { l.addTo(map); l._path.setAttribute("pathLength", 1); l._path.style.strokeDasharray = "1 1"; return l; }),
          dots: t.bins.map(b => L.circleMarker(b, { pane, renderer: r, radius: 5.5, color: "#fff", weight: 1.6, fillColor: t.col, fillOpacity: 1 })
            .bindTooltip(`Trip ${j + 1}: ${pc(t.load)} % full`, { direction: "top", offset: [0, -6] }).addTo(map)),
        }));
      });
      // the small map: where this area and Seafield are in Edinburgh
      const ctl = L.control({ position: "bottomleft" });
      ctl.onAdd = () => {
        const div = L.DomUtil.create("div", "ex-inset"), rings = B.wards.flatMap(w => w.rings.map(r => decode(r))), all = rings.flat();
        const la0 = Math.min(...all.map(p => p[0])), la1 = Math.max(...all.map(p => p[0])), lo0 = Math.min(...all.map(p => p[1])), lo1 = Math.max(...all.map(p => p[1]));
        const kx = Math.cos(dep[0] * Math.PI / 180), W = 150, s = W / ((lo1 - lo0) * kx), H = Math.round((la1 - la0) * s);
        const X = lo => (lo - lo0) * kx * s, Y = la => (la1 - la) * s, P = ([la, lo]) => `${X(lo).toFixed(1)},${Y(la).toFixed(1)}`;
        const sw = area.getSouthWest(), ne = area.getNorthEast(), rx = X(sw.lng), ry = Y(ne.lat), rw = Math.max(8, X(ne.lng) - rx), rh = Math.max(8, Y(sw.lat) - ry);
        const c = [rx + rw / 2, ry + rh / 2], d = [X(dep[1]), Y(dep[0])];
        div.innerHTML = `<svg viewBox="-6 -6 ${W + 12} ${H + 12}" role="img" aria-label="Where this area and the Seafield depot are in Edinburgh">` +
          `<path d="${rings.map(r => "M" + r.map(P).join("L") + "Z").join("")}" fill="#eceff1" stroke="#c4c9cf" stroke-width=".6"/>` +
          `<line x1="${c[0].toFixed(1)}" y1="${c[1].toFixed(1)}" x2="${d[0].toFixed(1)}" y2="${d[1].toFixed(1)}" stroke="#5f6368" stroke-width="1.4" stroke-dasharray="3 3"/>` +
          `<rect x="${(rx - (rw < 8 ? 4 : 0)).toFixed(1)}" y="${(ry - (rh < 8 ? 4 : 0)).toFixed(1)}" width="${rw.toFixed(1)}" height="${rh.toFixed(1)}" fill="rgba(217,48,37,.15)" stroke="${RED}" stroke-width="2" rx="2"/>` +
          `<circle cx="${d[0].toFixed(1)}" cy="${d[1].toFixed(1)}" r="4.5" fill="#202124" stroke="#fff" stroke-width="1.5"/>` +
          `<text x="${(d[0] - 2).toFixed(1)}" y="${(d[1] - 8).toFixed(1)}" text-anchor="middle">Seafield</text>` +
          `<text x="${c[0].toFixed(1)}" y="${(ry + rh + 13).toFixed(1)}" text-anchor="middle">these stops</text></svg>`;
        L.DomEvent.disableClickPropagation(div);
        return div;
      };
      ctl.addTo(map); inset = ctl.getContainer();
      // the drive to Seafield leaves the view: a label says where it goes and how many trips drive it
      const sc = L.control({ position: "topright" });
      sc.onAdd = () => L.DomUtil.create("div", "ex-seaf");
      sc.addTo(map); seaf = sc.getContainer(); seaf.innerHTML = seafText(plans[0]);
      fit();
      streetTiles(OSM);
    };
    // the same OpenStreetMap street map as the live map (OpenFreeMap, drawn by MapLibre); if it can't load, the vector map stays
    const streetTiles = async OSM => {
      try {
        const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 8000);
        const style = await fetch(OFM_STYLE, { signal: ctl.signal }).then(r => { if (!r.ok) throw new Error("style"); return r.json(); });
        clearTimeout(tm);
        if (!document.querySelector(`link[href="${ML_CSS}"]`)) { const css = document.createElement("link"); css.rel = "stylesheet"; css.href = ML_CSS; document.head.appendChild(css); }
        if (!window.maplibregl) await loadScript(ML_JS);
        if (!L.maplibreGL) await loadScript(MLL_JS);
        if (!window.maplibregl || !L.maplibreGL) return;
        platinumStyle(style);
        const gl = L.maplibreGL({ style, interactive: false, attributionControl: false,
          attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(map);
        const glm = gl.getMaplibreMap(); let on = false;
        const swap = () => { if (on) return; on = true; base.forEach(l => map.removeLayer(l)); map.attributionControl.removeAttribution(OSM).addAttribution(gl.options.attribution); host.classList.add("street"); };
        glm.once("idle", swap);
        setTimeout(() => { if (!on && glm.loaded()) swap(); }, 9000);
      } catch (e) { /* keep the vector map */ }
    };
    const ready = () => { if (!map && host.clientWidth) { build(); show(k < 0 ? 0 : k, false); } return !!map; };
    // the pane is hidden until its tab opens: build the map the first time it has a size, then keep it filled
    new ResizeObserver(() => { if (!ready()) return; map.invalidateSize(); if (!moved) fit(); }).observe(host);
    // show one plan: its trips are drawn one after another, each with its bins
    const show = (to, animate) => {
      timers.forEach(clearTimeout); timers = [];
      k = to;
      const p = plans[k];
      $("#exStage").textContent = k ? "After simulated annealing" : "Quick plan";
      $("#exSum").innerHTML = `<b>${p.trips.length} trips</b> from Seafield · <b>${fmt(p.km)} km</b> · <b>£${fmt(p.cost)}</b> driving cost`;
      $("#exKey").innerHTML = p.trips.map((t, j) => `<span><i style="background:${t.col}"></i>Trip ${j + 1}: ${t.bins.length} stops, ${pc(t.load)} % full</span>`).join("");
      slider.value = k;
      if (!map) return 0;
      seaf.innerHTML = seafText(p);
      plans.forEach((_, i) => { map.getPane("ex" + i).style.display = i === k ? "" : "none"; });
      const go = animate && !still;
      layers[k].forEach((T, j) => {
        const lines = T.lines.map(l => l._path), dots = T.dots.map(d => d._path);
        const set = (on, ms) => {
          lines.forEach(e => { e.style.transition = ms ? `stroke-dashoffset ${ms}ms ease-in-out` : "none"; e.style.strokeDashoffset = on ? 0 : 1; });
          dots.forEach(e => { e.style.transition = ms ? `opacity ${ms / 2}ms` : "none"; e.style.opacity = on ? 1 : 0; });
        };
        set(false, 0);
        if (go) { lines[0].getBoundingClientRect(); timers.push(setTimeout(() => set(true, step), 60 + j * step)); } else set(true, 0);
      });
      return p.trips.length * step + 60;
    };
    slider.oninput = () => { const to = +slider.value < .5 ? 0 : 1; if (to !== k) show(to, false); };
    slider.onchange = () => show(+slider.value < .5 ? 0 : 1, true);
    slider.onkeydown = e => { const to = { ArrowLeft: 0, ArrowDown: 0, Home: 0, ArrowRight: 1, ArrowUp: 1, End: 1 }[e.key]; if (to != null) { e.preventDefault(); show(to, true); } };
    const [A, Z] = plans, CA = F.compare.first, CZ = F.compare.final;
    $("#exWhy").textContent = `${Z.trips.length} trips instead of ${A.trips.length}: ${fmt(A.km - Z.km)} km less, ${fmt(100 * (1 - Z.cost / A.cost))} % less driving cost. Across the whole city the same effect gives ${fmt(CA.trips - CZ.trips)} fewer trips and £${fmt(CA.total - CZ.total)} a day less driving cost (−${fmt(100 * (1 - CZ.total / CA.total))} %).`;
    $("#exStops").textContent = fmt(E.bins); $("#exBins").textContent = fmt(nBins); $("#exKm").textContent = fmt(E.depot_km);
    show(0, false); ready();
    // the first time it comes into view: draw the quick plan, wait, then the plan after annealing
    if ("IntersectionObserver" in window && !still)
      new IntersectionObserver((es, ob) => {
        if (!es.some(e => e.isIntersecting) || !ready()) return;
        ob.disconnect();
        const t1 = show(0, true);
        timers.push(setTimeout(() => show(1, true), t1 + 1600));
      }, { threshold: .5 }).observe(host);
  }).catch(() => { host.textContent = "The example could not be loaded."; });
}

/* 5 · before and after: the three policies */
function mathsCheck(M) {
  const ag = D.site.experiments.aggregate, f = p => ag.find(a => a.policy === p), tt = f("timetable"), re = f("reactive"), bs = f("binsight");
  if (!tt || !bs) return;
  const cut = (a, b) => fmt(100 * (1 - b / a));
  $("#chkResult").textContent = `${cut(tt.overflow_events_day, bs.overflow_events_day)} % fewer overflows and ${cut(tt.cost_day, bs.cost_day)} % lower cost than the timetable.`;
  $("#chkReact").textContent = re ? `By the time a bin reads ${fmt(M.params.REACTIVE_AT)} % it is often too late: reacting overflows ${fmt(re.overflow_events_day)} times a day, against ${fmt(bs.overflow_events_day)} for BinSight.` : "";
}
