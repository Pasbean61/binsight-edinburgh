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
    `<line class="ax" x1="${x(0)}" x2="${x(0)}" y1="${t}" y2="${y(0)}"/><text x="${x(0)}" y="${H - 8}" text-anchor="middle">now (05:00)</text><text x="${x(-n0 + 1)}" y="${H - 8}">−72 h</text><text x="${W - r}" y="${H - 8}" text-anchor="end">14:00 tomorrow</text>`;
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

/* 4 · tomorrow's optimised routes: drag through the day and watch one truck drive its trips on the real streets */
function mathsRoute(M) {
  const R = D.R, MR = M.route, S = D.S, F = D.site.fleet, dep = [R.depot.latitude, R.depot.longitude];
  $("#optCost").innerHTML = `Simulated annealing: £${fmt(MR.start)} → <b>£${fmt(MR.final)}</b> a day <em>−${fmt(100 * (1 - MR.final / MR.start))} %</em>`;
  const routes = R.routes.filter(r => r.trips && r.trips.length), cols = [PAL.accent, PAL.warn, PAL.bad];
  const kx = Math.cos(dep[0] * Math.PI / 180), dist = (a, b) => Math.hypot((a[1] - b[1]) * 111.32 * kx, (a[0] - b[0]) * 110.57);
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // put the stops on the street line in visiting order: the monotone matching with the least total distance
  // (dynamic programming; a plain "nearest point" snaps a stop to a later pass along the same street)
  const align = (pts, qs) => {
    const V = pts.length, arg = []; let g = new Float64Array(V);
    for (const q of qs) {
      const ng = new Float64Array(V), ga = new Int32Array(V);
      for (let j = 0; j < V; j++) { const f = dist(q, pts[j]) + g[j]; if (j && ng[j - 1] <= f) { ng[j] = ng[j - 1]; ga[j] = ga[j - 1]; } else { ng[j] = f; ga[j] = j; } }
      arg.push(ga); g = ng;
    }
    const out = []; let j = V - 1;
    for (let n = qs.length - 1; n >= 0; n--) { j = arg[n][j]; out[n] = j; }
    return out;
  };
  // one truck's day on the street geometry, with the times from the schedule
  const days = new Map();
  const dayOf = k => {
    if (days.has(k)) return days.get(k);
    const trips = routes[k].trips.map(t => {
      const pts = t.line ? decode(t.line) : [dep, dep], cum = [0];
      for (let j = 1; j < pts.length; j++) cum.push(cum[j - 1] + dist(pts[j - 1], pts[j]));
      const fill = t.stops.map(i => S.cap[i] * Math.min(S.pred[i], 100) / 100), tot = fill.reduce((a, v) => a + v, 0) || 1;
      const at = align(pts, t.stops.map(i => [S.lat[i], S.lon[i]]));
      let load = 0;
      const stops = t.stops.map((i, n) => {
        load += t.load * fill[n] / tot;
        return { i, d: cum[at[n]], tArr: t.eta[n], tDep: t.eta[n] + svcMin(i), load };
      });
      return { pts, cum, total: cum[cum.length - 1] || 1, t0: t.start, t1: t.end - F.tip_min, tEnd: t.end, stops, km: t.road_km || 0 };
    });
    const day = { trips, end: trips[trips.length - 1].tEnd, n: trips.reduce((a, t) => a + t.stops.length, 0), km: routes[k].km };
    days.set(k, day); return day;
  };
  const dAt = (tr, t) => {
    let pd = 0, pt = tr.t0;
    for (const s of tr.stops) {
      if (t < s.tArr) return pd + (s.d - pd) * (t - pt) / Math.max(1e-6, s.tArr - pt);
      if (t <= s.tDep) return s.d;
      pd = s.d; pt = s.tDep;
    }
    return Math.min(tr.total, pd + (tr.total - pd) * (t - pt) / Math.max(1e-6, tr.t1 - pt));
  };
  // where the truck is at minute t: trip j, distance d along it, bins emptied, km driven, load on board
  const at = (day, t) => {
    let done = 0, km = 0;
    for (let j = 0; j < day.trips.length; j++) {
      const tr = day.trips[j], last = tr.stops.length ? tr.stops[tr.stops.length - 1].load : 0;
      if (t < tr.t0) return { j, d: -1, done, km, load: 0, state: j ? "Back at Seafield" : "At Seafield, ready to go" };
      if (t <= tr.t1) {
        let n = 0; while (n < tr.stops.length && tr.stops[n].tArr <= t) n++;
        const s = tr.stops[n - 1], next = tr.stops[n], d = dAt(tr, t);
        const state = s && t <= s.tDep ? `emptying bins on ${S.site[s.i]}` : next ? `driving to ${S.site[next.i]}` : "heading back to Seafield to tip";
        return { j, d, done: done + n, km: km + tr.km * d / tr.total, load: s ? s.load : 0, state: `Trip ${j + 1} · ${state}` };
      }
      done += tr.stops.length; km += tr.km;
      if (t < tr.tEnd) return { j, d: tr.total, done, km, load: last, state: `Trip ${j + 1} · tipping the load at Seafield` };
    }
    return { j: day.trips.length, d: 0, done, km, load: 0, state: `Shift done at ${hhmm(day.end)}, back at Seafield` };
  };
  // faint street map underneath: decoded once, each piece with its bounding box
  let bg = null;
  const box = pts => pts.reduce((b, [la, lo]) => [Math.min(b[0], la), Math.max(b[1], la), Math.min(b[2], lo), Math.max(b[3], lo)], [90, -90, 180, -180]);
  const piece = pts => ({ pts, b: box(pts) });
  const background = () => bg || (bg = {
    parks: (D.base.parks || []).filter(p => p.k === "park").map(p => piece(decode(p.ring))),
    lakes: (D.base.parks || []).filter(p => p.k === "water").map(p => piece(decode(p.ring))),
    water: (D.base.water || []).map(w => piece(decode(w.line))),
    minor: ((D.base.roads || {}).minor || []).map(l => piece(decode(l))),
    major: ((D.base.roads || {}).major || []).map(l => piece(decode(l))),
  });
  const svgEl = $("#mRoute"), tIn = $("#mRtT"), kIn = $("#mRtK"), el = {};
  const tMax = Math.max(F.shift_min, ...routes.map(r => r.trips[r.trips.length - 1].end));
  tIn.max = tMax; kIn.max = routes.length;
  let k = 0, t = 0, day = null, X = null, Y = null, raf = 0;
  const draw = () => {
    day = dayOf(k);
    const W = 520, H = 360, pad = 16, foot = 26;
    let la0 = dep[0], la1 = dep[0], lo0 = dep[1], lo1 = dep[1];
    for (const tr of day.trips) for (const [la, lo] of tr.pts) { if (la < la0) la0 = la; if (la > la1) la1 = la; if (lo < lo0) lo0 = lo; if (lo > lo1) lo1 = lo; }
    const w = Math.max((lo1 - lo0) * kx, 1e-4), h = Math.max(la1 - la0, 1e-4);
    const sc = Math.min((W - 2 * pad) / w, (H - 2 * pad - foot) / h), ox = (W - w * sc) / 2, oy = (H - foot - h * sc) / 2;
    X = lo => ox + (lo - lo0) * kx * sc; Y = la => oy + (la1 - la) * sc;
    const line = pts => pts.map(([la, lo], j) => `${j ? "L" : "M"}${X(lo).toFixed(1)},${Y(la).toFixed(1)}`).join("");
    const v = [la1 - (H - oy) / sc, la1 + oy / sc, lo0 - ox / (kx * sc), lo0 + (W - ox) / (kx * sc)];
    const inView = p => p.b[1] >= v[0] && p.b[0] <= v[1] && p.b[3] >= v[2] && p.b[2] <= v[3];
    const layer = (list, close) => list.filter(inView).map(p => line(p.pts) + (close ? "Z" : "")).join("");
    const G = background();
    let svg = `<g opacity=".55"><path d="${layer(G.parks, true)}" fill="${PAL.park}"/><path d="${layer(G.lakes, true)}" fill="${PAL.sea}"/><path d="${layer(G.water)}" fill="none" stroke="${PAL.sea}" stroke-width="2.5"/>` +
      `<path d="${layer(G.minor)}" fill="none" stroke="${PAL.road}" stroke-width=".7"/><path d="${layer(G.major)}" fill="none" stroke="${PAL.road}" stroke-width="1.4"/></g>`;
    // the planned trips faint, the road already driven bright on top
    svg += day.trips.map((tr, j) => `<path d="${line(tr.pts)}" fill="none" stroke="${cols[j % 3]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity=".25"/>`).join("");
    svg += day.trips.map((tr, j) => `<path class="rt-done" d="" fill="none" stroke="${cols[j % 3]}" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"/>`).join("");
    svg += day.trips.map((tr, j) => tr.stops.map(s => `<circle data-j="${j}" cx="${X(S.lon[s.i]).toFixed(1)}" cy="${Y(S.lat[s.i]).toFixed(1)}" r="3.2" fill="${PAL.surface}" stroke="${cols[j % 3]}" stroke-width="1.6"><title>${esc(S.site[s.i])}</title></circle>`).join("")).join("");
    const dx = X(dep[1]), dy = Y(dep[0]), right = dx > W - 90;
    svg += `<rect x="${(dx - 7).toFixed(1)}" y="${(dy - 7).toFixed(1)}" width="14" height="14" rx="3" fill="${PAL.ink}"/><text x="${(right ? dx - 12 : dx + 12).toFixed(1)}" y="${(dy + 4).toFixed(1)}" text-anchor="${right ? "end" : "start"}" style="fill:${PAL.ink};font-weight:600">Seafield depot</text>`;
    const pxKm = sc / 111.32, km = [0.5, 1, 2, 5, 10].find(v => v * pxKm >= 50) || 10, bx = pad, by = H - 10;
    svg += `<line x1="${bx}" x2="${(bx + km * pxKm).toFixed(1)}" y1="${by}" y2="${by}" stroke="${PAL.ink3}" stroke-width="2"/><text x="${(bx + km * pxKm + 6).toFixed(1)}" y="${by + 4}" style="fill:${PAL.ink3}">${km} km</text>`;
    svg += `<g id="rtTruck"><circle r="11" fill="${PAL.ink}" opacity=".18"/><circle r="6" fill="${PAL.ink}" stroke="${PAL.surface}" stroke-width="2"/></g>`;
    svgEl.innerHTML = svg;
    el.done = [...svgEl.querySelectorAll(".rt-done")];
    el.dots = day.trips.map((tr, j) => [...svgEl.querySelectorAll(`circle[data-j="${j}"]`)]);
    el.truck = $("#rtTruck");
    $("#oRtK").textContent = `${k + 1} of ${routes.length}`;
    $("#rtKey").innerHTML = day.trips.map((tr, j) => `<span><i style="background:${cols[j % 3]}"></i>Trip ${j + 1} · ${tr.stops.length} bins</span>`).join("");
  };
  const upTo = (tr, d) => {
    const c = tr.cum; let lo = 0, hi = c.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (c[mid] <= d) lo = mid; else hi = mid; }
    const p = along(tr, d);
    return tr.pts.slice(0, lo + 1).concat([p]).map(([la, lo_], j) => `${j ? "L" : "M"}${X(lo_).toFixed(1)},${Y(la).toFixed(1)}`).join("");
  };
  const show = () => {
    const p = at(day, t);
    day.trips.forEach((tr, j) => {
      const d = j < p.j ? tr.total : j > p.j ? 0 : p.d;
      el.done[j].setAttribute("d", d > 0 ? upTo(tr, d) : "");
      el.dots[j].forEach((c, n) => c.setAttribute("fill", tr.stops[n].tArr <= t ? cols[j % 3] : PAL.surface));
    });
    const pos = p.j < day.trips.length && p.d >= 0 ? along(day.trips[p.j], p.d) : dep;
    el.truck.setAttribute("transform", `translate(${X(pos[1]).toFixed(1)},${Y(pos[0]).toFixed(1)})`);
    tIn.value = t; $("#oRtT").textContent = hhmm(t); $("#rtState").textContent = p.state;
    $("#rtOut").innerHTML = [[`${fmt(p.done)} / ${fmt(day.n)}`, "bins emptied"], [`${fmt(p.km, 1)} km`, `of ${fmt(day.km, 1)} km driven`], [`${fmt(100 * p.load / R.capacity_l)} %`, "truck full"]]
      .map(([a, b]) => `<div><b>${a}</b><span>${b}</span></div>`).join("");
  };
  // play the truck's day in about six seconds; any drag on the sliders takes over
  const halt = () => { cancelAnimationFrame(raf); raf = 0; };
  const play = () => {
    halt();
    if (still) { t = day.end; show(); return; }
    let last = 0; t = 0;
    const step = now => { if (last) t = Math.min(day.end, t + (now - last) * day.end / 6000); last = now; show(); raf = t < day.end ? requestAnimationFrame(step) : 0; };
    raf = requestAnimationFrame(step);
  };
  tIn.oninput = () => { halt(); t = +tIn.value; show(); };
  kIn.oninput = () => { halt(); k = +kIn.value - 1; draw(); show(); };
  kIn.onchange = play;
  draw(); show();
  if ("IntersectionObserver" in window) new IntersectionObserver((es, ob) => { if (es.some(e => e.isIntersecting)) { ob.disconnect(); play(); } }, { threshold: .4 }).observe(svgEl);
  else { t = day.end; show(); }
}

/* 5 · before and after: the three policies */
function mathsCheck(M) {
  const ag = D.site.experiments.aggregate, f = p => ag.find(a => a.policy === p), tt = f("timetable"), re = f("reactive"), bs = f("binsight");
  if (!tt || !bs) return;
  const cut = (a, b) => fmt(100 * (1 - b / a));
  $("#chkResult").textContent = `${cut(tt.overflow_events_day, bs.overflow_events_day)} % fewer overflows and ${cut(tt.cost_day, bs.cost_day)} % lower cost than the timetable.`;
  $("#chkReact").textContent = re ? `By the time a bin reads ${fmt(M.params.REACTIVE_AT)} % it is often too late: reacting overflows ${fmt(re.overflow_events_day)} times a day, against ${fmt(bs.overflow_events_day)} for BinSight.` : "";
}
