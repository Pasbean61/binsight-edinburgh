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

/* 4 · toy routing demo */
function mathsRoute(M) {
  const toy = M.route.toy, C = toy.cost, K = toy.km, Tm = toy.min, n = toy.stops.length;
  const pts = [[toy.depot.latitude, toy.depot.longitude], ...toy.stops.map(s => [s.lat, s.lon])];
  const kx = Math.cos(55.95 * Math.PI / 180);
  const xs = pts.map(p => p[1] * kx), ys = pts.map(p => p[0]);
  const W = 520, H = 330, pad = 26, sx = (W - 2 * pad) / (Math.max(...xs) - Math.min(...xs)), sy = (H - 2 * pad) / (Math.max(...ys) - Math.min(...ys)), sc = Math.min(sx, sy);
  const ox = (W - (Math.max(...xs) - Math.min(...xs)) * sc) / 2, oy = (H - (Math.max(...ys) - Math.min(...ys)) * sc) / 2;
  const PX = k => ox + (xs[k] - Math.min(...xs)) * sc, PY = k => oy + (Math.max(...ys) - ys[k]) * sc;
  const cost = tour => tour.slice(1).reduce((a, v, k) => a + C[tour[k]][v], 0), km = tour => tour.slice(1).reduce((a, v, k) => a + K[tour[k]][v], 0), mins = tour => tour.slice(1).reduce((a, v, k) => a + Tm[tour[k]][v], 0);
  const nn = () => { const left = new Set(Array.from({ length: n }, (_, k) => k + 1)), t = [0]; let cur = 0; while (left.size) { let best = -1, bc = Infinity; for (const j of left) if (C[cur][j] < bc) { bc = C[cur][j]; best = j; } t.push(best); left.delete(best); cur = best; } t.push(0); return t; };
  const cw = () => {
    const route = new Map(), of = []; for (let i = 1; i <= n; i++) { route.set(i, [i]); of[i] = i; }
    const sv = []; for (let i = 1; i <= n; i++) for (let j = i + 1; j <= n; j++) sv.push([C[0][i] + C[0][j] - C[i][j], i, j]);
    sv.sort((a, b) => b[0] - a[0]);
    for (const [, i, j] of sv) {
      const ri = of[i], rj = of[j]; if (ri === rj) continue;
      let A = route.get(ri), B = route.get(rj);
      if ((A[0] !== i && A[A.length - 1] !== i) || (B[0] !== j && B[B.length - 1] !== j)) continue;
      if (A[A.length - 1] !== i) A = A.reverse(); if (B[0] !== j) B = B.reverse();
      const m = A.concat(B); route.set(ri, m); route.delete(rj); B.forEach(v => of[v] = ri);
    }
    return [0, ...[...route.values()][0], 0];
  };
  const opt2 = t => { t = t.slice(); let imp = true; while (imp) { imp = false; for (let a = 0; a < t.length - 3; a++) for (let b = a + 2; b < t.length - 1; b++) { const d = C[t[a]][t[b]] + C[t[a + 1]][t[b + 1]] - C[t[a]][t[a + 1]] - C[t[b]][t[b + 1]]; if (d < -1e-9) { const seg = t.slice(a + 1, b + 1).reverse(); t.splice(a + 1, seg.length, ...seg); imp = true; } } } return t; };
  const hk = () => {
    const S = 1 << n, dp = new Float64Array(S * n).fill(Infinity), par = new Int8Array(S * n).fill(-1);
    for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = C[0][j + 1];
    for (let m = 1; m < S; m++) for (let j = 0; j < n; j++) {
      if (!(m & (1 << j))) continue; const cur = dp[m * n + j]; if (cur === Infinity) continue;
      for (let k = 0; k < n; k++) { if (m & (1 << k)) continue; const nm = m | (1 << k), v = cur + C[j + 1][k + 1]; if (v < dp[nm * n + k]) { dp[nm * n + k] = v; par[nm * n + k] = j; } }
    }
    let best = Infinity, end = -1; for (let j = 0; j < n; j++) { const v = dp[(S - 1) * n + j] + C[j + 1][0]; if (v < best) { best = v; end = j; } }
    const t = []; let m = S - 1, j = end; while (j >= 0) { t.push(j + 1); const pj = par[m * n + j]; m &= ~(1 << j); j = pj; }
    return [0, ...t.reverse(), 0];
  };
  const t0 = performance.now(), opt = hk(), hkMs = performance.now() - t0;
  const tours = { nn: nn(), cw: cw() }; tours.opt2 = opt2(tours.cw); tours.hk = opt;
  const best = cost(opt);
  $("#toySub").textContent = `${esc(toy.stops[0].site)} and nearby, from one of tomorrow’s trips`;
  const draw = a => {
    $$("#toyBtns button").forEach(b => b.classList.toggle("on", b.dataset.a === a));
    const t = tours[a];
    const path = t.map((v, k) => `${k ? "L" : "M"}${PX(v).toFixed(1)},${PY(v).toFixed(1)}`).join("");
    $("#mToy").innerHTML = `<path d="${path}" fill="none" stroke="${a === "hk" ? PAL.accent : PAL.ink}" stroke-width="2" stroke-linejoin="round" opacity=".85"/>` +
      t.slice(1, -1).map((v, k) => `<circle cx="${PX(v)}" cy="${PY(v)}" r="9" fill="${PAL.surface}" stroke="${PAL.ink}" stroke-width="1.4"><title>${esc(toy.stops[v - 1].site)} · ${toy.stops[v - 1].id}</title></circle><text x="${PX(v)}" y="${PY(v) + 4}" text-anchor="middle" style="fill:${PAL.ink};font-weight:600;font-size:10px">${k + 1}</text>`).join("") +
      `<rect x="${PX(0) - 8}" y="${PY(0) - 8}" width="16" height="16" rx="3" fill="${PAL.ink}"/><text x="${PX(0) + 13}" y="${PY(0) + 4}" style="fill:${PAL.ink};font-weight:600">Seafield depot</text>`;
    const c = cost(t), gap = 100 * (c / best - 1);
    $("#toyOut").innerHTML = [[`£${fmt(c, 2)}`, "route cost"], [`${fmt(km(t), 1)} km · ${fmt(mins(t))} min`, "driving"], [gap < 1e-6 ? "optimal" : `+${fmt(gap, 1)} %`, "above the optimum"]].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join("") +
      (a === "hk" ? `<div style="grid-column:1/-1"><span>Exact optimum found in ${fmt(hkMs, 0)} ms over ${fmt((1 << n) * n)} states. Brute force would check ${fmt(479001600 / 2)} tours.</span></div>` : "");
  };
  $$("#toyBtns button").forEach(b => b.onclick = () => draw(b.dataset.a));
  draw("nn");
  const R = M.route;
  $("#routeNote").textContent = `Tomorrow’s ${fmt(R.stops)} stops: start £${fmt(R.start)} → annealed £${fmt(R.final)} after ${fmt(R.iterations)} tried changes, in ${R.trips} trips on ${R.trucks} trucks, solved in ${fmt(R.seconds, 1)} s. Rain slowdown θ = ${fmt(R.theta, 3)}.`;
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
