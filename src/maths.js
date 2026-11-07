/* ── the maths: five interactive explainers on the live model output ── */
const Phi = x => { const t = 1 / (1 + .3275911 * Math.abs(x) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x / 2); return x >= 0 ? .5 * (1 + y) : .5 * (1 - y); };
function rng32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function poisson(l, u) { if (l > 30) { const z = Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u()); return Math.max(0, Math.round(l + Math.sqrt(l) * z)); } let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= u(); } while (p > L); return k - 1; }
function gammaDraw(k, th, u) { const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d); for (;;) { let x, v; do { x = Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u()); v = 1 + c * x; } while (v <= 0); v = v * v * v; const w = u(); if (w < 1 - .0331 * x ** 4 || Math.log(w) < .5 * x * x + d * (1 - v + Math.log(v))) return d * v * th; } }
const svgAxisY = (x0, x1, y, vals, f) => vals.map(v => `<line class="grid" x1="${x0}" x2="${x1}" y1="${y(v)}" y2="${y(v)}"/><text x="${x0 - 6}" y="${y(v) + 4}" text-anchor="end">${f(v)}</text>`).join("");

function initMaths() {
  const M = D.site.maths; if (!M) return;
  const P = M.params, F = M.forecast;
  // tabs
  const show = k => { $$("#mTabs button").forEach(b => b.classList.toggle("on", +b.dataset.m === k)); $$(".m-pane").forEach(p => p.hidden = +p.dataset.m !== k); };
  $$("#mTabs button").forEach(b => b.onclick = () => show(+b.dataset.m));
  BS.mathsTab = show;
  // numbers in the text
  const lamT = M.decide.rounds?.at(-1)?.lambda;
  const rainCut = 100 * (1 - F.rain), rainTrue = 100 * (1 - Math.exp(P.RAIN_EFFECT));
  const vals = {
    bag: fmt(P.BAG_L), median: P.DAILY_FILL_MEDIAN.toFixed(2), phiTrue: fmt(P.BAG_L * (1 + 1 / P.BAG_SHAPE), 1), phiHat: fmt(F.phi, 1),
    rainFx: `${fmt(rainCut, 1)} % fewer deposits in a wet hour (true value ${fmt(rainTrue, 1)} %)`,
    co: fmt(P.COST_OVERFLOW), alpha: P.ALPHA.toFixed(2), ckm: P.COST_KM.toFixed(2), chr: fmt(P.COST_HOUR),
    roadKm: fmt(D.site.totals.road_km), nStops: fmt(M.route.stops), fleet: fmt(D.site.fleet.trucks),
    lambda: lamT == null ? "–" : lamT > 0 ? `λ = £${fmt(lamT, 2)} per truck-minute: the fleet is the bottleneck` : "λ = 0, the fleet has room",
  };
  $$("[data-mk]").forEach(el => { const v = vals[el.dataset.mk]; if (v != null) el.textContent = v; });
  mathsModel(M); mathsPredict(M); mathsDecide(M); mathsRoute(M); mathsCheck(M);
}

/* 1 · compound Poisson paths */
function mathsModel(M) {
  const hw = M.fill.hour_w, dw = M.fill.day_w, P = M.params, cap = M.forecast.example.cap;
  const a = []; for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) a.push(dw[d] * hw[h]);
  const am = a.reduce((s, v) => s + v, 0) / a.length; for (let k = 0; k < a.length; k++) a[k] /= am;
  let seed = 11;
  const draw = () => {
    const rho = +$("#mRho").value; $("#oRho").textContent = rho.toFixed(2);
    const W = 520, H = 260, l = 34, r = 10, t = 14, b = 28, x = h => l + h / 168 * (W - l - r), y = v => t + (1 - v / 100) * (H - t - b);
    const lamDay = cap * rho / P.BAG_L;
    const paths = [], full = [];
    for (let s = 0; s < 3; s++) {
      const u = rng32(seed * 97 + s * 13 + 1); let L = 0, hit = null; const pts = [[0, 0]];
      for (let h = 0; h < 168; h++) {
        const n = poisson(lamDay * a[h] / 24, u);
        if (n) L += gammaDraw(n * P.BAG_SHAPE, P.BAG_L / P.BAG_SHAPE, u);
        const v = Math.min(100, 100 * L / cap); pts.push([h + 1, v]);
        if (v >= 100 && hit == null) hit = h + 1;
      }
      paths.push(pts); full.push(hit);
    }
    let E = 0; const mean = [[0, 0]]; for (let h = 0; h < 168; h++) { E += lamDay * a[h] / 24 * P.BAG_L; mean.push([h + 1, Math.min(100, 100 * E / cap)]); }
    const line = pts => pts.map(([h, v], k) => `${k ? "L" : "M"}${x(h).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const cols = [PAL.accent, PAL.f[3], PAL.ink];
    $("#mPaths").innerHTML = svgAxisY(l, W - r, y, [0, 50, 100], v => v + "%") +
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, k) => `<text x="${x(k * 24 + 12)}" y="${H - 8}" text-anchor="middle">${d}</text><line class="ax" x1="${x(k * 24)}" x2="${x(k * 24)}" y1="${y(0)}" y2="${y(0) + 4}"/>`).join("") +
      `<path d="${line(mean)}" fill="none" stroke="${PAL.ink3}" stroke-width="1.4" stroke-dasharray="4 4"/>` +
      paths.map((p, s) => `<path d="${line(p)}" fill="none" stroke="${cols[s]}" stroke-width="1.7" opacity=".9"/>` + (full[s] ? `<circle cx="${x(full[s])}" cy="${y(100)}" r="4" fill="${PAL.bad}"/>` : "")).join("") +
      `<text x="${W - r}" y="${y(100) - 5}" text-anchor="end" style="fill:${PAL.bad}">full: overflow from here</text><text x="${x(150)}" y="${y(Math.min(100, mean[150][1])) + 16}" text-anchor="end">expected</text>`;
    const days = full.map(f => f ? fmt(f / 24, 1) + " d" : "not this week");
    $("#mPathNote").textContent = `A ${fmt(cap)} L stop is expected to fill in ${fmt(1 / rho, 1)} days. These three weeks: ${days.join(", ")}. Bags arrive in bursts, so two weeks with the same rate fill at different times.`;
  };
  $("#mRho").oninput = draw; $("#mRedraw").onclick = () => { seed++; draw(); };
  draw();
}

/* 2 · forecast fan, reliability, accuracy */
function mathsPredict(M) {
  const F = M.forecast, ex = F.example, m = F.metrics;
  $("#fanTitle").textContent = ex.site; $("#fanSub").textContent = `${ex.id} · ${fmt(ex.cap)} L · learned rate ${fmt(ex.rate_l_day)} L a day`;
  const draw = () => {
    const k = +$("#mSig").value; $("#oSig").textContent = "× " + k.toFixed(2);
    const W = 520, H = 250, l = 34, r = 12, t = 12, b = 28, n0 = ex.past.length, n1 = ex.mu.length;
    const x = h => l + (h + n0) / (n0 + n1 - 1) * (W - l - r), ymax = 130, y = v => t + (1 - clamp(v, 0, ymax) / ymax) * (H - t - b);
    const band = z => { const up = ex.mu.map((v, j) => [j, v + z * k * ex.sd[j]]), lo = ex.mu.map((v, j) => [j, v - z * k * ex.sd[j]]).reverse(); return up.concat(lo).map(([j, v], q) => `${q ? "L" : "M"}${x(j).toFixed(1)},${y(v).toFixed(1)}`).join("") + "Z"; };
    const past = ex.past.map((v, j) => `${j ? "L" : "M"}${x(j - n0).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const fut = ex.mu.map((v, j) => `${j ? "L" : "M"}${x(j).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const muE = ex.mu[n1 - 1], sdE = ex.sd[n1 - 1] * k, p = 1 - Phi((100 - muE) / sdE);
    $("#mFan").innerHTML = svgAxisY(l, W - r, y, [0, 50, 100], v => v + "%") +
      `<line x1="${l}" x2="${W - r}" y1="${y(100)}" y2="${y(100)}" stroke="${PAL.bad}" stroke-dasharray="4 3"/><text x="${l + 4}" y="${y(100) - 5}" style="fill:${PAL.bad}">100 %: overflow</text>` +
      `<path d="${band(1.96)}" fill="${PAL.accent}" opacity=".12"/><path d="${band(1.2816)}" fill="${PAL.accent}" opacity=".2"/>` +
      `<path d="${past}" fill="none" stroke="${PAL.ink}" stroke-width="1.6"/><path d="${fut}" fill="none" stroke="${PAL.accent}" stroke-width="2"/>` +
      `<line class="ax" x1="${x(0)}" x2="${x(0)}" y1="${t}" y2="${y(0)}"/><text x="${x(0)}" y="${H - 8}" text-anchor="middle">now (23:00)</text><text x="${x(-n0)}" y="${H - 8}">−72 h</text><text x="${W - r}" y="${H - 8}" text-anchor="end">14:00 the day after</text>` +
      `<circle cx="${x(n1 - 1)}" cy="${y(muE)}" r="3.5" fill="${PAL.accent}"/>`;
    $("#fanP").innerHTML = `Bands: 80 % and 95 % intervals. <b>p = ${fmt(100 * p, 1)} %</b> chance of overflowing before the next truck${k === 1 ? " (the model’s value)" : ""}: ${p > M.params.ALPHA ? "above α, so it must be collected" : "below α, so the cost rule decides"}.`;
  };
  $("#mSig").oninput = draw; draw();
  const rows = [["BinSight forecast", m.binsight], ["Persistence (fill stays the same)", m.persistence], ["Last-day trend", m.trend]];
  $("#fcTable").innerHTML = `<thead><tr><th>Forecast of fill by the next truck</th><th class="n">MAE</th><th class="n">RMSE</th></tr></thead><tbody style="cursor:default">` +
    rows.map(([lbl, v], q) => `<tr><td>${q ? esc(lbl) : "<b>" + lbl + "</b>"}</td><td class="n">${fmt(v.mae, 1)}</td><td class="n">${fmt(v.rmse, 1)}</td></tr>`).join("") + "</tbody>";
  // reliability
  const W = 250, H = 200, l = 34, r = 8, t = 8, b = 30, x = v => l + v * (W - l - r), y = v => t + (1 - v) * (H - t - b);
  $("#mRel").innerHTML = svgAxisY(l, W - r, y, [0, .5, 1], v => v) + `<line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="${PAL.ink3}" stroke-dasharray="3 3"/>` +
    m.reliability.map(q => `<circle cx="${x(q.p)}" cy="${y(q.obs)}" r="${clamp(Math.sqrt(q.n) / 6, 2.5, 7)}" fill="${PAL.accent}" opacity=".85"><title>${fmt(q.n)} forecasts: predicted ${fmt(100 * q.p)} %, happened ${fmt(100 * q.obs)} %</title></circle>`).join("") +
    `<text x="${x(.5)}" y="${H - 6}" text-anchor="middle">forecast risk p</text><text x="${l}" y="${t + 10}" dx="4">share that overflowed</text>`;
  const hi = m.reliability.filter(q => q.p > .05 && q.n > 0), hp = hi.reduce((a, q) => a + q.p * q.n, 0), ho = hi.reduce((a, q) => a + q.obs * q.n, 0), hn = hi.reduce((a, q) => a + q.n, 0);
  const relNote = hn ? `for the ${fmt(hn)} forecasts of 10 % or more the model predicted ${fmt(100 * hp / hn, 1)} % on average and ${fmt(100 * ho / hn, 1)} % overflowed, so it ${hp > ho ? "overstates risk in the tail, which errs on the side of collecting." : "understates risk in the tail."}` : "";
  $("#fcNote").innerHTML = `Scored on ${fmt(m.n)} forecasts over the 7 test days and 2 seeds, for stops no truck emptied in between, against the true simulated fill. Brier score <b>${fmt(m.brier, 4)}</b> against ${fmt(m.brier_climatology, 4)} for always predicting the average rate (skill ${fmt(100 * (1 - m.brier / m.brier_climatology))} %). The 80 % interval holds the truth <b>${fmt(100 * m.coverage80)} %</b> of the time and the 95 % interval ${fmt(100 * m.coverage95)} %. Dots near the diagonal would mean perfectly calibrated risks; ${relNote} The test data come from the same simulator, so real sensors would score worse.`;
}

/* 3 · decision rule scatter */
function mathsDecide(M) {
  const S = D.S, n = D.n, pick = []; for (let i = 0; i < n; i += 5) pick.push(i);
  const s = { p: pick.map(i => S.prob[i]), ratio: pick.map(i => earlyCost(i)) }, scale = n / s.p.length;
  const W = 520, H = 330, l = 46, r = 12, t = 12, b = 34;
  const lx = p => Math.log10(clamp(p, 1e-4, 1)), X = p => l + (lx(p) + 4) / 4 * (W - l - r);
  const ys = s.ratio.filter(v => v > 0), lo = Math.floor(Math.log10(Math.max(.05, Math.min(...ys)))), hi = Math.ceil(Math.log10(Math.max(...ys)));
  const Y = v => t + (1 - (Math.log10(clamp(v, 10 ** lo, 10 ** hi)) - lo) / (hi - lo)) * (H - t - b);
  const draw = () => {
    const co = +$("#mCo").value, al = +$("#mAl").value;
    $("#oCo").textContent = "£" + co; $("#oAl").textContent = al >= 1 ? "off" : al.toFixed(2);
    let mand = 0, opt = 0, skip = 0, risk = 0;
    const dots = s.p.map((p, k) => {
      const m = p > al, o = !m && p * co > s.ratio[k];
      if (m) mand++; else if (o) opt++; else { skip++; risk += p; }
      return `<circle cx="${X(p).toFixed(1)}" cy="${Y(s.ratio[k]).toFixed(1)}" r="2.6" fill="${m ? PAL.ink : o ? PAL.accent : PAL.line2}" opacity="${m || o ? .85 : .7}"/>`;
    }).join("");
    const bx0 = -4, bx1 = 0, line = [bx0, bx1].map(e => [X(10 ** e), Y(co * 10 ** e)]);
    $("#mDec").innerHTML = [-4, -3, -2, -1, 0].map(e => `<line class="grid" x1="${X(10 ** e)}" x2="${X(10 ** e)}" y1="${t}" y2="${H - b}"/><text x="${X(10 ** e)}" y="${H - b + 14}" text-anchor="middle">${e === 0 ? "1" : "10" + "⁻" + "¹²³⁴"[-e - 1]}</text>`).join("") +
      Array.from({ length: hi - lo + 1 }, (_, q) => lo + q).map(e => `<line class="grid" x1="${l}" x2="${W - r}" y1="${Y(10 ** e)}" y2="${Y(10 ** e)}"/><text x="${l - 6}" y="${Y(10 ** e) + 4}" text-anchor="end">£${10 ** e >= 1 ? fmt(10 ** e) : (10 ** e).toFixed(1)}</text>`).join("") +
      dots +
      `<line x1="${line[0][0]}" y1="${line[0][1]}" x2="${line[1][0]}" y2="${line[1][1]}" stroke="${PAL.accent}" stroke-width="2"/>` +
      (al < 1 ? `<line x1="${X(al)}" x2="${X(al)}" y1="${t}" y2="${H - b}" stroke="${PAL.ink}" stroke-width="1.6" stroke-dasharray="5 3"/><text x="${X(al) - 4}" y="${t + 10}" text-anchor="end" style="fill:${PAL.ink}">p = α</text>` : "") +
      `<text x="${(l + W - r) / 2}" y="${H - 4}" text-anchor="middle">overflow risk if skipped, p (log scale)</text><text transform="translate(12 ${(t + H - b) / 2}) rotate(-90)" text-anchor="middle">cost of going early, Δ/τ</text>`;
    $("#decCounts").innerHTML = [[mand * scale, "must go (p > α)"], [opt * scale, "worth going (p·c_o > Δk/τ)"], [skip * scale, "skipped"]].map(([v, l_]) => `<div><b>${fmt(Math.round(v / 10) * 10)}</b><span>${l_}</span></div>`).join("") +
      `<div style="grid-column:1/-1"><span>Expected overflows among skipped stops: <b style="display:inline;font-size:15px">${fmt(risk * scale, 1)}</b> · each dot is one of ${s.p.length} stops (every 5th), counts scaled to all ${fmt(n)}</span></div>`;
  };
  $("#mCo").oninput = draw; $("#mAl").oninput = draw; draw();
  const dm = M.decide, rd = dm.rounds;
  $("#decNote").textContent = `Tomorrow: ${fmt(dm.mand)} stops are above α and must go; the cost rule adds ${fmt(dm.optional)} more, ${fmt(dm.chosen)} in all. ` +
    `Over ${rd.length} rounds of choosing and routing: ${rd.map(r => fmt(r.chosen) + " stops, " + fmt(r.minutes / 60) + " truck-hours" + (r.lambda > 0 ? ` at λ = £${fmt(r.lambda, 2)}/min` : "")).join(" → ")}.`;
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

/* 5 · validation, bound, fleet, Pareto, sensitivity */
function mathsCheck(M) {
  const V = M.route.validation, S = V.summary, K = M.check;
  const lbl = { nn: "Nearest neighbour", cw: "Clarke–Wright savings", ls: "Savings + local search", ours: "Full heuristic (+ annealing)" };
  $("#valTable").innerHTML = `<thead><tr><th>Method</th><th class="n">Mean gap</th><th class="n">Worst gap</th><th class="n">Optimal</th></tr></thead><tbody style="cursor:default">` +
    ["nn", "cw", "ls", "ours"].map(k => `<tr><td>${k === "ours" ? "<b>" + lbl[k] + "</b>" : lbl[k]}</td><td class="n">${fmt(S[k].mean_gap, 2)} %</td><td class="n">${fmt(S[k].max_gap, 1)} %</td><td class="n">${S[k].optimal} / ${V.instances.length}</td></tr>`).join("") + "</tbody>";
  const lb = K.lower_bound, base = K.base;
  $("#lbText").innerHTML = `Tomorrow’s routes cost <b>£${fmt(base.cost)}</b> in driving: the routing objective, £${D.site.fleet.cost_km}/km plus £${D.site.fleet.cost_hour} per hour at the wheel. (Lifting and tipping take the same time whatever the order, so they sit outside the objective; with them the day costs £${fmt(D.site.fleet.cost_km * D.site.plan.road_km + D.site.fleet.cost_hour * D.site.plan.hours)}.) The best bound is £${fmt(lb.bound)} (radial £${fmt(lb.radial)}, Held–Karp £${fmt(lb.held_karp)}), so the plan is <b>at most ${fmt(100 * K.gap_max, 1)} %</b> above the true optimum. That is a proof, not an estimate, and a loose one: the gap is mostly the bound’s weakness, as the exact tests suggest. HiGHS proved ${V.proven} of ${V.instances.length} small optima in ${fmt(V.t_exact_mean, 1)} s on average; the heuristic takes ${fmt(V.t_ours_mean, 2)} s.`;
  const fl = K.fleet;
  $("#fleetText").textContent = `With unlimited trucks, tomorrow’s ${fmt(fl.chosen)} chosen stops need ${fl.needed} trucks. No plan can manage with fewer than ${fl.lower_bound}: lifting time, plus the shortest way out of every stop, plus tipping, divided by an 8-hour shift. We assume ${fl.fleet}; the plan uses ${fl.used_in_plan}.`;
  // Pareto
  const pts = K.pareto.slice().sort((a, b) => a.c_o - b.c_o);
  const ag = D.site.experiments.aggregate, pol = { timetable: "Timetable", reactive: "Reactive", binsight: "BinSight" };
  const all = pts.map(p => [p.route_cost_day, p.overflow_events_day]).concat(ag.map(a => [a.route_cost_day, a.overflow_events_day]));
  const W = 520, H = 300, l = 52, r = 14, t = 14, b = 36;
  const x0 = Math.min(...all.map(p => p[0])) * .92, x1 = Math.max(...all.map(p => p[0])) * 1.04, y1 = Math.max(...all.map(p => p[1])) * 1.1;
  const X = v => l + (v - x0) / (x1 - x0) * (W - l - r), Y = v => t + (1 - v / y1) * (H - t - b);
  const yt = [0, y1 / 3, 2 * y1 / 3].map(v => Math.round(v / 10) * 10), xt = [x0, (x0 + x1) / 2, x1].map(v => Math.round(v / 1000) * 1000);
  $("#mPareto").innerHTML = svgAxisY(l, W - r, Y, yt, v => fmt(v)) + xt.map(v => `<text x="${X(v)}" y="${H - b + 15}" text-anchor="middle">£${fmt(v / 1000)}k</text>`).join("") +
    `<path d="${pts.map((p, k) => `${k ? "L" : "M"}${X(p.route_cost_day)},${Y(p.overflow_events_day)}`).join("")}" fill="none" stroke="${PAL.accent}" stroke-width="1.8"/>` +
    pts.map(p => `<circle cx="${X(p.route_cost_day)}" cy="${Y(p.overflow_events_day)}" r="4" fill="${PAL.accent}"/><text x="${X(p.route_cost_day) + 6}" y="${Y(p.overflow_events_day) - 6}">£${p.c_o}</text>`).join("") +
    ag.map(a => `<rect x="${X(a.route_cost_day) - 5}" y="${Y(a.overflow_events_day) - 5}" width="10" height="10" rx="2" fill="${a.policy === "binsight" ? PAL.ink : PAL.f[3]}"/><text class="lbl" x="${X(a.route_cost_day) + 9}" y="${Y(a.overflow_events_day) + 4}">${pol[a.policy]}${a.policy === "binsight" ? " (α 0.2, £60)" : ""}</text>`).join("") +
    `<text x="${(l + W - r) / 2}" y="${H - 4}" text-anchor="middle">route cost per day (driving + crew time)</text><text transform="translate(12 ${(t + H - b) / 2}) rotate(-90)" text-anchor="middle">overflows per day</text>`;
  const best = pts.reduce((a, q) => q.overflow_events_day < a.overflow_events_day ? q : a, pts[0]);
  $("#paretoNote").textContent = `Green: the cost rule alone (α off) for overflow costs from £${pts[0].c_o} to £${pts[pts.length - 1].c_o}. Raising c_o from £${pts[0].c_o} buys fewer overflows for more driving, down to ${fmt(best.overflow_events_day, 1)} a day at £${best.c_o}. Beyond that the curve turns back: the rule only looks one day ahead, so a high c_o makes every small risk today worth a detour, and the fleet’s hours go on stops that could have waited while tomorrow’s urgent ones are pushed out. That is why BinSight pairs a moderate c_o with the hard α rule. Squares: the three policies in the main experiment.`;
  // sensitivity
  const rows = [{ variant: "Tomorrow’s plan (base)", ...base }].concat(K.sensitivity);
  $("#sensTable").innerHTML = `<thead><tr><th>Change</th><th class="n">Stops</th><th class="n">Trucks</th><th class="n">km</th><th class="n">£ driving</th><th class="n">E[overflow]</th></tr></thead><tbody style="cursor:default">` +
    rows.map((r_, q) => `<tr><td>${q ? esc(r_.variant) : "<b>" + r_.variant + "</b>"}</td><td class="n">${fmt(r_.served)}</td><td class="n">${r_.trucks}</td><td class="n">${fmt(r_.km)}</td><td class="n">${fmt(r_.cost)}</td><td class="n">${fmt(r_.exp_overflow, 1)}</td></tr>`).join("") + "</tbody>";
}
