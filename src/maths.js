/* ── the maths: five interactive explainers on the live model output ── */
function rng32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function poisson(l, u) { if (l > 30) { const z = Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u()); return Math.max(0, Math.round(l + Math.sqrt(l) * z)); } let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= u(); } while (p > L); return k - 1; }
const svgAxisY = (x0, x1, y, vals, f) => vals.map(v => `<line class="grid" x1="${x0}" x2="${x1}" y1="${y(v)}" y2="${y(v)}"/><text x="${x0 - 6}" y="${y(v) + 4}" text-anchor="end">${f(v)}</text>`).join("");
const FEATURE_LABEL = { fill: "Latest reading", rate: "Fill rate since last emptied", d24: "Change over the last 24 h", hours_since: "Hours since last emptied", cap: "Capacity", weekday: "Weekday", rain_h: "Hours of rain ahead", temp: "Mean temperature ahead", holiday: "Share of holiday hours ahead" };

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
  $("#fcNote").innerHTML = `Solid: the last 72 hours of readings. Dashed: the projection <var>ŷ</var> = <var>y</var> + <var>ĝ</var> · hours over the next ${fmt(n1)} hours, <b>${fmt(ex.proj)} %</b>. ${ex.proj >= P.FLOOR ? `Above the ${fmt(P.FLOOR)} % floor, so it is a candidate for tomorrow.` : `Below the ${fmt(P.FLOOR)} % floor, so it can wait.`}`;
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
  const W = 520, H = 300, l = 40, r = 12, t = 12, b = 34, ymax = 150;
  const X = k => l + k / (n - 1) * (W - l - r), Y = v => t + (1 - Math.min(v, ymax) / ymax) * (H - t - b);
  const pts = []; for (let k = 0; k < n; k += 4) pts.push([k, S.pred[order[k]]]); pts.push([n - 1, S.pred[order[n - 1]]]);
  const line = pts.map(([k, v], j) => `${j ? "L" : "M"}${X(k).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  $("#mTrucks").max = Math.max(60, 2 * fleet0); $("#mTrucks").value = fleet0;
  const draw = () => {
    const floor = +$("#mFloor").value, fleet = +$("#mTrucks").value;
    $("#oFloor").textContent = floor + " %"; $("#oTrucks").textContent = fleet;
    const r_ = BS.choose({ floor, fleet }), nc = r_.cand.length, ns = r_.sel.length;
    const over = r_.cand.slice(ns).filter(i => S.pred[i] >= 100).length;
    const area = pts.filter(([k]) => k < ns).map(([k, v], j) => `${j ? "L" : "M"}${X(k).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    $("#mDec").innerHTML = svgAxisY(l, W - r, Y, [0, 50, 100, 150], v => v + "%") +
      (ns > 1 ? `<path d="${area} L${X(ns - 1)},${Y(0)} L${X(0)},${Y(0)} Z" fill="${PAL.accent}" opacity=".16"/>` : "") +
      `<path d="${line}" fill="none" stroke="${PAL.ink}" stroke-width="1.8"/>` +
      `<line x1="${l}" x2="${W - r}" y1="${Y(floor)}" y2="${Y(floor)}" stroke="${PAL.ink}" stroke-dasharray="5 3"/><text x="${W - r}" y="${Y(floor) - 5}" text-anchor="end">floor ${floor} %</text>` +
      `<line x1="${l}" x2="${W - r}" y1="${Y(100)}" y2="${Y(100)}" stroke="${PAL.bad}" stroke-dasharray="2 3" opacity=".7"/>` +
      (ns ? `<line x1="${X(ns - 1)}" x2="${X(ns - 1)}" y1="${t}" y2="${Y(0)}" stroke="${PAL.accent}" stroke-width="1.8"/><text x="${X(ns - 1) + 5}" y="${t + 12}" style="fill:${PAL.accent};font-weight:600">${ns < nc ? "fleet out of time" : "all above the floor fit"}</text>` : "") +
      `<text x="${(l + W - r) / 2}" y="${H - 6}" text-anchor="middle">all ${fmt(n)} stops, fullest first</text><text transform="translate(11 ${(t + H - b) / 2}) rotate(-90)" text-anchor="middle">projected fill ŷ</text>`;
    $("#decCounts").innerHTML = [[nc, `at or above ${floor} %`], [ns, "fit the fleet’s time"], [nc - ns, "wait for the next day"]].map(([v, l_]) => `<div><b>${fmt(v)}</b><span>${l_}</span></div>`).join("") +
      `<div style="grid-column:1/-1"><span>${over ? `<b style="display:inline;font-size:15px">${fmt(over)}</b> of the waiting stops are projected past 100 %.` : "No stop projected past 100 % has to wait."} Estimate from the model’s own time per stop; routing has the final say.</span></div>`;
  };
  $("#mFloor").oninput = draw; $("#mTrucks").oninput = draw; draw();
  $("#decNote").textContent = `Tomorrow: ${fmt(dm.risky)} stops are projected at ${fmt(dm.floor)} % or more. Fullest first, ${fmt(dm.chosen)} fit the time of ${fmt(fleet0)} trucks; after routing, ${fmt(dm.served)} are emptied.`;
}

/* 4 · simulated annealing, live, on 12 real stops of one of tomorrow's trips */
function mathsRoute(M) {
  const toy = M.route.toy, C = toy.cost, K = toy.km, n = toy.stops.length;
  const cost = t => { let s = 0; for (let k = 1; k < t.length; k++) s += C[t[k - 1]][t[k]]; return s; };
  const km = t => t.slice(1).reduce((a, v, k) => a + K[t[k]][v], 0);
  // the exact optimum (Held–Karp), for reference
  const hk = () => {
    const S = 1 << n, dp = new Float64Array(S * n).fill(Infinity);
    for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = C[0][j + 1];
    for (let m = 1; m < S; m++) for (let j = 0; j < n; j++) {
      if (!(m & (1 << j))) continue; const cur = dp[m * n + j]; if (cur === Infinity) continue;
      for (let k = 0; k < n; k++) { if (m & (1 << k)) continue; const nm = m | (1 << k), v = cur + C[j + 1][k + 1]; if (v < dp[nm * n + k]) dp[nm * n + k] = v; }
    }
    let best = Infinity; for (let j = 0; j < n; j++) best = Math.min(best, dp[(S - 1) * n + j] + C[j + 1][0]);
    return best;
  };
  const t0 = performance.now(), OPT = hk(), hkMs = performance.now() - t0;
  const greedy = (() => { const left = new Set(Array.from({ length: n }, (_, k) => k + 1)), t = [0]; let cur = 0; while (left.size) { let b = -1, bc = Infinity; for (const j of left) if (C[cur][j] < bc) { bc = C[cur][j]; b = j; } t.push(b); left.delete(b); cur = b; } t.push(0); return t; })();
  // annealing settings, as in route.py: T from 3 to 0.002 times the mean cost of one leg
  let arcs = 0; for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) if (i !== j) arcs += C[i][j];
  const meanArc = arcs / (n * (n + 1)), T0 = 3 * meanArc, T1 = .002 * meanArc, N = 2000, NEAR = 5;
  const near = Array.from({ length: n + 1 }, (_, v) => Array.from({ length: n }, (_, k) => k + 1).filter(w => w !== v).sort((a, b) => C[v][a] - C[v][b]).slice(0, NEAR));
  const temp = k => T0 * Math.pow(T1 / T0, k / N);

  // ── map: zoom to the stops; the depot sits off the edge, in its true direction ──
  const W = 520, H = 280, pad = 30, kx = Math.cos(55.95 * Math.PI / 180);
  const sx = toy.stops.map(s => s.lon * kx), sy = toy.stops.map(s => s.lat);
  const x0 = Math.min(...sx), x1 = Math.max(...sx), y0 = Math.min(...sy), y1 = Math.max(...sy);
  const sc = Math.min((W - 2 * pad - 150) / (x1 - x0 || 1e-9), (H - 2 * pad) / (y1 - y0 || 1e-9));
  const ox = pad + 20 + ((W - 2 * pad - 150) - (x1 - x0) * sc) / 2, oy = pad + ((H - 2 * pad) - (y1 - y0) * sc) / 2;
  const P = toy.stops.map((s, k) => [ox + (sx[k] - x0) * sc, oy + (y1 - sy[k]) * sc]);
  for (let it = 0; it < 300; it++) for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {   // nudge overlapping circles apart (display only)
    const dx = P[b][0] - P[a][0], dy = P[b][1] - P[a][1], d = Math.hypot(dx, dy) || .01;
    if (d < 23) { const m = (23 - d) / 2, ux = dx / d || 1, uy = dy / d; P[a][0] -= ux * m; P[a][1] -= uy * m; P[b][0] += ux * m; P[b][1] += uy * m; }
  }
  const cx = P.reduce((a, p) => a + p[0], 0) / n, cy = P.reduce((a, p) => a + p[1], 0) / n;
  const dX = ox + (toy.depot.longitude * kx - x0) * sc - cx, dY = oy + (y1 - toy.depot.latitude) * sc - cy;
  const DP = [W - 24, Math.max(52, Math.min(H - 60, cy + (W - 24 - cx) * dY / (Math.abs(dX) > 1e-9 ? dX : 1e-9)))];
  const pt = v => v === 0 ? DP : P[v - 1];
  const dist0 = Math.min(...Array.from({ length: n }, (_, k) => K[0][k + 1]));

  const drawMap = (t, hl = []) => {
    const legs = t.slice(1).map((v, k) => { const a = pt(t[k]), b = pt(v), dep = t[k] === 0 || v === 0; return `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${PAL.ink}" stroke-width="${dep ? 1.4 : 2}" ${dep ? 'stroke-dasharray="5 4" opacity=".55"' : 'opacity=".85"'} stroke-linecap="round"/>`; }).join("");
    $("#mToy").innerHTML = legs +
      P.map((p, k) => { const on = hl.includes(k + 1); return `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="10" fill="${on ? PAL.accent : PAL.surface}" stroke="${on ? PAL.accent : PAL.ink}" stroke-width="1.4"><title>${esc(toy.stops[k].site)} · ${esc(toy.stops[k].id)}</title></circle><text x="${p[0].toFixed(1)}" y="${(p[1] + 3.8).toFixed(1)}" text-anchor="middle" style="fill:${on ? PAL.paper : PAL.ink};font-weight:650;font-size:10.5px">${k + 1}</text>`; }).join("") +
      `<rect x="${DP[0] - 8}" y="${DP[1] - 8}" width="16" height="16" rx="3" fill="${PAL.ink}"/><text x="${DP[0] + 8}" y="${DP[1] - 28}" text-anchor="end" style="fill:${PAL.ink};font-weight:600">Seafield depot</text><text x="${DP[0] + 8}" y="${DP[1] - 14}" text-anchor="end">${fmt(dist0, 1)} km away by road</text>`;
  };

  // ── chart: cost over the moves, best so far, the exact optimum, and the temperature ──
  const CW = 520, CH = 170, l = 46, r = 12, tp = 10, bt = 26;
  const drawChart = () => {
    const ymax = Math.ceil(Math.max(...S.hist) / 5) * 5 + 2, ymin = Math.floor(OPT * .88);
    const X = k => l + k / N * (CW - l - r), Y = v => tp + (1 - (v - ymin) / (ymax - ymin)) * (CH - tp - bt);
    const step = Math.max(1, Math.floor(S.hist.length / 400));
    const line = (arr) => arr.map((v, k) => (k % step && k !== arr.length - 1) ? "" : `${k ? "L" : "M"}${X(k).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    const Ty = k => tp + (1 - Math.log(temp(k) / T1) / Math.log(T0 / T1)) * (CH - tp - bt);
    let tl = ""; for (let k = 0; k <= N; k += 50) tl += `${k ? "L" : "M"}${X(k).toFixed(1)},${Ty(k).toFixed(1)}`;
    $("#mSa").innerHTML = svgAxisY(l, CW - r, Y, [ymin, Math.round((ymin + ymax) / 2), ymax], v => "£" + fmt(v)) +
      `<path d="${tl}" fill="none" stroke="${PAL.f[3]}" stroke-width="1.2" stroke-dasharray="2 3"/><text x="${X(N * .3) + 6}" y="${Ty(N * .3) - 6}" style="fill:${PAL.f[3]}">temperature T (log scale)</text>` +
      `<line x1="${l}" x2="${CW - r}" y1="${Y(OPT)}" y2="${Y(OPT)}" stroke="${PAL.ink}" stroke-dasharray="5 3" opacity=".7"/><text x="${X(N * .62)}" y="${Y(OPT) + 13}" text-anchor="middle" style="fill:${PAL.ink}">exact optimum (Held–Karp) £${fmt(OPT, 2)}</text>` +
      `<path d="${line(S.hist)}" fill="none" stroke="${PAL.ink3}" stroke-width="1" opacity=".75"/>` +
      `<path d="${line(S.bestHist)}" fill="none" stroke="${PAL.accent}" stroke-width="2.2"/>` +
      `<text x="${l}" y="${CH - 7}">move 0</text><text x="${CW - r}" y="${CH - 7}" text-anchor="end">move ${fmt(N)}</text><text x="${(l + CW - r) / 2}" y="${CH - 7}" text-anchor="middle"><tspan style="fill:${PAL.accent};font-weight:600">best so far</tspan> · <tspan>current plan</tspan></text>`;
  };

  // ── the annealing state ──
  let seed = 1, S, raf = 0;
  const reset = () => {
    cancelAnimationFrame(raf);
    const u = rng32(seed * 7919 + 3), order = Array.from({ length: n }, (_, k) => k + 1);
    for (let k = n - 1; k > 0; k--) { const j = Math.floor(u() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
    const tour = [0, ...order, 0], c = cost(tour);
    S = { u, tour, c, best: c, bestTour: tour.slice(), k: 0, up: 0, hist: [c], bestHist: [c], running: false, last: null };
    paint();
  };
  const NAMES = ["move", "swap", "reverse"];
  const step = () => {
    if (S.k >= N) return false;
    const u = S.u, T = temp(S.k), v = 1 + Math.floor(u() * n), w = near[v][Math.floor(u() * NEAR)], m = Math.floor(u() * 3);
    const t = S.tour.slice(), a = t.indexOf(v), b = t.indexOf(w);
    if (m === 0) { t.splice(a, 1); t.splice(t.indexOf(w) + 1, 0, v); }
    else if (m === 1) { t[a] = w; t[b] = v; }
    else { const i = Math.min(a, b), j = Math.max(a, b); const seg = t.slice(i, j + 1).reverse(); t.splice(i, seg.length, ...seg); }
    const nc = cost(t), d = nc - S.c, p = d <= 0 ? 1 : Math.exp(-d / T), ok = d <= 1e-12 || u() < p;
    if (ok) { if (d > 1e-9) S.up++; S.tour = t; S.c = nc; if (nc < S.best - 1e-9) { S.best = nc; S.bestTour = t.slice(); } }
    S.k++; S.hist.push(S.c); S.bestHist.push(S.best);
    S.last = { m, v, w, d, T, p, ok };
    return true;
  };
  const moveText = L => L.m === 0 ? `move stop ${L.v} next to ${L.w}` : L.m === 1 ? `swap stops ${L.v} and ${L.w}` : `reverse the path between ${L.v} and ${L.w}`;
  const paint = () => {
    const L = S.last, done = S.k >= N;
    drawMap(done ? S.bestTour : S.tour, L && !done ? [L.v, L.w] : []);
    drawChart();
    $("#saLog").innerHTML = !L ? `A random order through the 12 stops: £${fmt(S.c, 2)}. Press <b>Run</b>, or <b>One move</b> to see a single decision.`
      : done ? `Done: the best plan seen costs <b>£${fmt(S.best, 2)}</b>, ${S.best <= OPT + 1e-6 ? "the exact optimum" : `${fmt(100 * (S.best / OPT - 1), 2)} % above the exact optimum`}. ${fmt(S.up)} of the ${fmt(N)} moves made the plan worse and were kept anyway.`
      : `Move ${fmt(S.k)}: ${moveText(L)}. Δ = ${Math.abs(L.d) < .005 ? "" : L.d > 0 ? "+" : "−"}£${fmt(Math.abs(L.d), 2)}, <var>T</var> = £${fmt(L.T, 2)}. ` +
        (L.d <= 1e-12 ? `Not worse, so <b>kept</b>.` : `Worse, so kept with probability e<sup>−Δ/<var>T</var></sup> = ${fmt(L.p, 2)}: <b>${L.ok ? "kept" : "rejected"}</b>.`);
    $("#toyOut").innerHTML = [[`£${fmt(S.c, 2)}`, `current plan · ${fmt(km(S.tour), 1)} km`], [`£${fmt(S.best, 2)}`, S.best <= OPT + 1e-6 ? "best so far · optimal" : `best so far · +${fmt(100 * (S.best / OPT - 1), 1)} %`], [fmt(S.k), `of ${fmt(N)} moves · T = £${fmt(temp(Math.min(S.k, N)), 2)}`]].map(([v, l_]) => `<div><b>${v}</b><span>${l_}</span></div>`).join("");
    $("#saPlay").textContent = S.running ? "Pause" : done ? "Run again" : S.k ? "Continue" : "Run";
  };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const run = () => {
    if (S.k >= N) { seed++; reset(); }
    S.running = true;
    if (reduce) { while (step()); S.running = false; paint(); return; }
    const frame = () => { if (!S.running) return; for (let j = 0; j < 3 && step(); j++); paint(); if (S.k < N) raf = requestAnimationFrame(frame); else { S.running = false; paint(); } };
    raf = requestAnimationFrame(frame);
  };
  $("#saPlay").onclick = () => { if (S.running) { S.running = false; cancelAnimationFrame(raf); paint(); } else run(); };
  $("#saStep").onclick = () => { S.running = false; cancelAnimationFrame(raf); if (S.k >= N) { seed++; reset(); } step(); paint(); };
  $("#saNew").onclick = () => { seed++; reset(); };
  $("#toySub").textContent = `${toy.stops[0].site} and nearby, from one of tomorrow’s trips`;
  reset();
  const gGap = 100 * (cost(greedy) / OPT - 1);
  $("#saNote").innerHTML = `The demo starts from a random order so the search has work to do: on these stops, the greedy start used for the full plan is already ${gGap < .05 ? "at the optimum" : `${fmt(gGap, 1)} % above it`}. The three in-trip moves are shown (crossing trips, dropping a stop and opening a trip need more than one trip). <var>T</var> runs from 3 to 0.002 times the mean cost of one leg, as in the full model. The dashed line is the exact optimum by Held–Karp dynamic programming over ${fmt((1 << n) * n)} states, solved in your browser in ${fmt(hkMs, 0)} ms. Lines are straight; costs are road costs.`;
  const R = M.route;
  $("#routeNote").textContent = `Tomorrow’s ${fmt(R.stops)} stops: the greedy start costs £${fmt(R.start)}. Annealing tried ${fmt(R.iterations)} changes in ${fmt(R.seconds, 0)} s and ended at £${fmt(R.final)} (${fmt(100 * (1 - R.final / R.start), 1)} % less), in ${R.trips} trips on ${R.trucks} trucks. Rain slowdown θ = ${fmt(R.theta, 3)}.`;
}

/* 5 · before and after: the three policies */
function mathsCheck(M) {
  const ex = D.site.experiments, ag = ex.aggregate, P = M.params, pol = { timetable: "Timetable", reactive: "Reactive", binsight: "BinSight" };
  const tt = ag.find(a => a.policy === "timetable"), bs = ag.find(a => a.policy === "binsight");
  $("#calText").textContent = tt ? `On the test days the every-${P.COLLECT_EVERY_DAYS}-days timetable overflowed on ${fmt(100 * tt.overflow_events_day / tt.collections_day, 2)} % of its collections (target ${fmt(100 * P.TARGET_OVERFLOW)} %), and bins were ${fmt(tt.fill_at_collection)} % full on average when it emptied them (about 44 % expected).` : "";
  $("#checkSub").textContent = `${ex.eval_days} test days × ${ex.seeds.length} seeds, mean per day`;
  const all = ag.map(a => [a.route_cost_day, a.overflow_events_day]);
  const W = 520, H = 300, l = 52, r = 14, t = 14, b = 36;
  const x0 = Math.min(...all.map(p => p[0])) * .85, x1 = Math.max(...all.map(p => p[0])) * 1.1, y1 = Math.max(...all.map(p => p[1])) * 1.15 || 1;
  const X = v => l + (v - x0) / (x1 - x0) * (W - l - r), Y = v => t + (1 - v / y1) * (H - t - b);
  const yt = [0, y1 / 3, 2 * y1 / 3, y1].map(v => y1 > 30 ? Math.round(v / 10) * 10 : Math.round(v)), xt = [x0, (x0 + x1) / 2, x1].map(v => Math.round(v / 1000) * 1000);
  $("#mCheck").innerHTML = svgAxisY(l, W - r, Y, yt, v => fmt(v)) + xt.map(v => `<text x="${X(v)}" y="${H - b + 15}" text-anchor="middle">£${fmt(v / 1000)}k</text>`).join("") +
    ag.map(a => `<rect x="${X(a.route_cost_day) - 6}" y="${Y(a.overflow_events_day) - 6}" width="12" height="12" rx="2" fill="${a.policy === "binsight" ? PAL.accent : a.policy === "timetable" ? PAL.ink : PAL.f[3]}"/><text class="lbl" x="${X(a.route_cost_day) + 10}" y="${Y(a.overflow_events_day) + 4}">${pol[a.policy]}</text>`).join("") +
    `<text x="${(l + W - r) / 2}" y="${H - 4}" text-anchor="middle">route cost per day (driving + crew time)</text><text transform="translate(12 ${(t + H - b) / 2}) rotate(-90)" text-anchor="middle">overflows per day</text>`;
  $("#checkNote").textContent = tt && bs ? `BinSight: ${fmt(bs.overflow_events_day, 1)} overflows a day against ${fmt(tt.overflow_events_day, 1)} for the timetable, for £${fmt(bs.route_cost_day)} of driving and crew time against £${fmt(tt.route_cost_day)}. Down and to the left is better. The comparison is relative: absolute numbers depend on the simulated city.` : "";
}
