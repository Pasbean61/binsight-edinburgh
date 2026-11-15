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

/* 4 · before and after optimising: the first plan and the plan after simulated annealing, split by a line you drag */
function mathsRoute(M) {
  const R = D.R, dep = [R.depot.latitude, R.depot.longitude], kx = Math.cos(dep[0] * Math.PI / 180);
  const svg = $("#mRoute"), wrap = $("#cmpMap"), knob = $("#cmpKnob"), bar = $("#cmpLine"), W = 520, H = 380, pad = 10;
  const box = pts => pts.reduce((b, [la, lo]) => [Math.min(b[0], la), Math.max(b[1], la), Math.min(b[2], lo), Math.max(b[3], lo)], [90, -90, 180, -180]);
  getJSON("data/first_plan.json").then(F => {
    // both plans' trips on the streets; a trip that leaves Seafield less than half full is drawn in red
    const plans = [F.routes, R.routes].map(rs => rs.flatMap(r => r.trips.map(t => ({ half: t.load < R.capacity_l / 2, line: decode(t.line) }))));
    let b = [dep[0], dep[0], dep[1], dep[1]];
    for (const p of plans) for (const t of p) { const q = box(t.line); b = [Math.min(b[0], q[0]), Math.max(b[1], q[1]), Math.min(b[2], q[2]), Math.max(b[3], q[3])]; }
    const w = (b[3] - b[2]) * kx, h = b[1] - b[0], sc = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h), ox = (W - w * sc) / 2, oy = (H - h * sc) / 2;
    const X = lo => ox + (lo - b[2]) * kx * sc, Y = la => oy + (b[1] - la) * sc;
    const line = pts => pts.map(([la, lo], j) => `${j ? "L" : "M"}${X(lo).toFixed(1)},${Y(la).toFixed(1)}`).join("");
    const v = [b[1] - (H - oy) / sc, b[1] + oy / sc, b[2] - ox / (kx * sc), b[2] + (W - ox) / (kx * sc)];
    const layer = (list, close) => list.map(decode).filter(p => { const q = box(p); return q[1] >= v[0] && q[0] <= v[1] && q[3] >= v[2] && q[2] <= v[3]; }).map(p => line(p) + (close ? "Z" : "")).join("");
    const B = D.base, parks = B.parks || [], roads = B.roads || {};
    const trips = (p, half) => p.filter(t => t.half === half).map(t => line(t.line)).join("");
    const plan = p => `<path d="${trips(p, false)}" fill="none" stroke="${PAL.ink3}" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" opacity=".7"/>` +
      `<path d="${trips(p, true)}" fill="none" stroke="${PAL.bad}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
    svg.innerHTML = `<defs><clipPath id="cmpClipL"><rect id="cmpRectL" x="0" y="0" width="${W / 2}" height="${H}"/></clipPath><clipPath id="cmpClipR"><rect id="cmpRectR" x="${W / 2}" y="0" width="${W / 2}" height="${H}"/></clipPath></defs>` +
      `<g opacity=".5"><path d="${layer(parks.filter(p => p.k === "park").map(p => p.ring), true)}" fill="${PAL.park}"/><path d="${layer(parks.filter(p => p.k === "water").map(p => p.ring), true)}" fill="${PAL.sea}"/>` +
      `<path d="${layer((B.water || []).map(x => x.line))}" fill="none" stroke="${PAL.sea}" stroke-width="2"/><path d="${layer(roads.major || [])}" fill="none" stroke="${PAL.road}" stroke-width="1"/></g>` +
      `<g clip-path="url(#cmpClipL)">${plan(plans[0])}</g><g clip-path="url(#cmpClipR)">${plan(plans[1])}</g>` +
      `<rect x="${(X(dep[1]) - 6).toFixed(1)}" y="${(Y(dep[0]) - 6).toFixed(1)}" width="12" height="12" rx="3" fill="${PAL.ink}" stroke="${PAL.surface}" stroke-width="2"><title>Seafield depot</title></rect>`;
    const rl = $("#cmpRectL"), rr = $("#cmpRectR");
    // the cost of each side on the map, and the objective term by term underneath
    const A = F.compare.first, Z = F.compare.final, pc = fmt(100 * (1 - Z.total / A.total));
    $("#cmpTagL").innerHTML = `First plan <b>£${fmt(A.total)}</b>`;
    $("#cmpTagR").innerHTML = `After annealing <b>£${fmt(Z.total)}</b>`;
    const rows = [
      ["Trips", fmt(A.trips), fmt(Z.trips)],
      [`<i class="cmp-red"></i>Less than half full`, fmt(A.half_empty), fmt(Z.half_empty)],
      ["Road driven", `${fmt(A.km)} km`, `${fmt(Z.km)} km`],
      ["Driving time", `${fmt(A.drive_h, 1)} h`, `${fmt(Z.drive_h, 1)} h`],
      [`Driving cost <span>£${fmt(D.site.fleet.cost_km, 2)}/km + £${fmt(D.site.fleet.cost_hour)}/h</span>`, `£${fmt(A.cost)}`, `£${fmt(Z.cost)}`],
      [`Bins left out <span>£${fmt(D.site.fleet.cost_overflow)} × fill each</span>`, fmt(A.left_out), fmt(Z.left_out)],
    ];
    $("#cmpRows").innerHTML = rows.map(([a, x, y]) => `<tr><th scope="row">${a}</th><td>${x}</td><td>${y}</td></tr>`).join("") +
      `<tr class="tot"><th scope="row">Total cost <span>the objective</span></th><td>£${fmt(A.total)}</td><td>£${fmt(Z.total)} <em>−${pc}\u00a0%</em></td></tr>`;
    $("#cmpWhy").innerHTML = `<b>Why it is cheaper:</b> the same bins go in ${fmt(Z.trips)} fuller trips instead of ${fmt(A.trips)} (trucks ${fmt(Z.load)}\u00a0% full on average, not ${fmt(A.load)}\u00a0%), so the fleet drives ${fmt(A.depot_km - Z.depot_km)} km less to and from Seafield.`;
    // the dividing line: drag it anywhere on the map, or use the arrow keys on the handle
    let f = .5, raf = 0;
    const set = x => {
      f = clamp(x, 0, 1);
      rl.setAttribute("width", (W * f).toFixed(1)); rr.setAttribute("x", (W * f).toFixed(1)); rr.setAttribute("width", (W * (1 - f)).toFixed(1));
      const pct = `${(100 * f).toFixed(2)}%`; knob.style.left = bar.style.left = pct;
      knob.setAttribute("aria-valuenow", Math.round(100 * f));
      $("#cmpTagL").style.opacity = f < .18 ? 0 : 1; $("#cmpTagR").style.opacity = f > .82 ? 0 : 1;
    };
    const halt = () => { cancelAnimationFrame(raf); raf = 0; };
    let drag = false;
    const at = e => { const r = wrap.getBoundingClientRect(); set((e.clientX - r.left) / r.width); };
    wrap.addEventListener("pointerdown", e => { halt(); drag = true; wrap.setPointerCapture(e.pointerId); at(e); });
    wrap.addEventListener("pointermove", e => { if (drag) at(e); });
    ["pointerup", "pointercancel"].forEach(t => wrap.addEventListener(t, () => { drag = false; }));
    knob.addEventListener("keydown", e => {
      const d = { ArrowLeft: -.05, ArrowDown: -.05, ArrowRight: .05, ArrowUp: .05 }[e.key];
      if (d != null || e.key === "Home" || e.key === "End") { e.preventDefault(); halt(); set(e.key === "Home" ? 0 : e.key === "End" ? 1 : f + d); }
    });
    set(.5);
    // once, when the map comes into view: sweep the line across so it is clear that it moves
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches && "IntersectionObserver" in window)
      new IntersectionObserver((es, ob) => {
        if (!es.some(e => e.isIntersecting)) return;
        ob.disconnect();
        const keys = [.5, .85, .15, .5], dur = 2600; let t0 = 0;
        const step = now => {
          t0 = t0 || now; const u = Math.min(1, (now - t0) / dur), s = u * (keys.length - 1), i = Math.min(keys.length - 2, Math.floor(s)), e = s - i;
          set(keys[i] + (keys[i + 1] - keys[i]) * (e < .5 ? 2 * e * e : 1 - (-2 * e + 2) ** 2 / 2));
          raf = u < 1 ? requestAnimationFrame(step) : 0;
        };
        raf = requestAnimationFrame(step);
      }, { threshold: .5 }).observe(wrap);
  }).catch(() => { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">The routes could not be loaded.</text>`; });
}

/* 5 · before and after: the three policies */
function mathsCheck(M) {
  const ag = D.site.experiments.aggregate, f = p => ag.find(a => a.policy === p), tt = f("timetable"), re = f("reactive"), bs = f("binsight");
  if (!tt || !bs) return;
  const cut = (a, b) => fmt(100 * (1 - b / a));
  $("#chkResult").textContent = `${cut(tt.overflow_events_day, bs.overflow_events_day)} % fewer overflows and ${cut(tt.cost_day, bs.cost_day)} % lower cost than the timetable.`;
  $("#chkReact").textContent = re ? `By the time a bin reads ${fmt(M.params.REACTIVE_AT)} % it is often too late: reacting overflows ${fmt(re.overflow_events_day)} times a day, against ${fmt(bs.overflow_events_day)} for BinSight.` : "";
}
