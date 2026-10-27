/* Surface de volatilité implicite — portage JavaScript de quantguard/models/volsurface.py
 * (édition Vercel : calcul dans le navigateur, chaque seconde).
 * SVI « raw » par échéance (Gatheral, 2004), ajustée par Levenberg-Marquardt avec jacobien
 * analytique et démarrage à chaud ; deltas forward, maturités constantes, contrôles d'arbitrage.
 * Utilisable dans le navigateur (window.QGVol) et sous Node (module.exports) pour les tests.
 */
(function (root) {
  "use strict";
  const MONTHS = {JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11};
  const INSTR = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:d\d+)?)-([CP])$/;
  const DELTA_COLS = [["10Δ put", -0.10], ["15Δ put", -0.15], ["25Δ put", -0.25], ["35Δ put", -0.35], ["ATM", 0],
    ["35Δ call", 0.35], ["25Δ call", 0.25], ["15Δ call", 0.15], ["10Δ call", 0.10]];
  const CM_DAYS = [7, 14, 30, 60, 90, 180, 365];
  const YEAR = 365 * 86400 * 1000;

  // fonction de répartition normale (Abramowitz & Stegun 7.1.26, erreur < 1,5e-7)
  function ncdf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
    return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }
  const median = (a) => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]); };

  function parseChain(rows, now = Date.now(), minDays = 1) {
    const byExp = {};
    for (const r of rows) {
      const m = INSTR.exec(r.instrument_name || ""), iv = r.mark_iv, fwd = r.underlying_price;
      if (!m || !iv || iv <= 0 || !fwd || fwd <= 0) continue;
      const [, , d, mon, yy, strike, cp] = m;
      const exp = Date.UTC(2000 + +yy, MONTHS[mon], +d, 8);           // échéance 08:00 UTC
      const T = (exp - now) / YEAR;
      if (T * 365 < minDays) continue;
      const K = parseFloat(strike.replace("d", "."));
      const key = new Date(exp).toISOString().slice(0, 10);
      const e = byExp[key] = byExp[key] || {T, F: [], pts: []};
      e.F.push(fwd);
      const k = Math.log(K / fwd);
      if ((cp === "P" && K <= fwd) || (cp === "C" && K >= fwd)) e.pts.push([k, iv / 100, K, cp]);
    }
    const out = {};
    Object.keys(byExp).sort().forEach((key) => {
      const e = byExp[key], pts = e.pts.filter((p) => Math.abs(p[0]) <= 1.2).sort((a, b) => a[0] - b[0]);
      if (pts.length >= 5) out[key] = {T: e.T, F: median(e.F), k: pts.map((p) => p[0]), iv: pts.map((p) => p[1]), K: pts.map((p) => p[2]), cp: pts.map((p) => p[3])};
    });
    return out;
  }

  const sviW = (p, k) => { const [a, b, rho, m, s] = p, x = k - m; return a + b * (rho * x + Math.sqrt(x * x + s * s)); };

  function solve(A, y) {                                             // élimination de Gauss (5 × 5)
    const n = y.length, M = A.map((row, i) => row.concat([y[i]]));
    for (let c = 0; c < n; c++) {
      let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      if (Math.abs(M[c][c]) < 1e-18) return null;
      for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j]; x[r] = s / M[r][r]; }
    return x;
  }

  function fitSVI(k, iv, T, x0) {
    const w = iv.map((v) => v * v * T), wmin = Math.min(...w), wmax = Math.max(...w);
    const lo = [-1, 1e-6, -0.999, -1, 1e-4], hi = [Math.max(wmax * 2, 1e-3), 5, 0.999, 1, 2];
    const clamp = (p) => p.map((v, i) => Math.min(hi[i] - 1e-9, Math.max(lo[i] + 1e-9, v)));
    let p = x0 && x0.every((v, i) => v > lo[i] && v < hi[i]) ? x0.slice() : [Math.max(wmin * 0.8, 1e-5), 0.1, -0.1, 0, 0.1];
    const cost = (q) => k.reduce((s, kk, i) => { const r = sviW(q, kk) - w[i]; return s + r * r; }, 0);
    let c = cost(p), lam = 1e-3;
    for (let it = 0; it < 120; it++) {
      const JtJ = Array.from({length: 5}, () => new Array(5).fill(0)), Jtr = new Array(5).fill(0);
      const [, b, rho, m, s] = p;
      for (let i = 0; i < k.length; i++) {
        const x = k[i] - m, R = Math.sqrt(x * x + s * s), r = sviW(p, k[i]) - w[i];
        const J = [1, rho * x + R, b * x, b * (-rho - x / R), b * s / R];
        for (let a = 0; a < 5; a++) { Jtr[a] += J[a] * r; for (let bb = 0; bb < 5; bb++) JtJ[a][bb] += J[a] * J[bb]; }
      }
      let improved = false;
      for (let tries = 0; tries < 8 && !improved; tries++) {
        const A = JtJ.map((row, a) => row.map((v, bb) => a === bb ? v * (1 + lam) + 1e-14 : v));
        const d = solve(A, Jtr.map((v) => -v));
        if (!d) { lam *= 10; continue; }
        const q = clamp(p.map((v, i) => v + d[i])), cq = cost(q);
        if (cq < c) { const rel = (c - cq) / (c + 1e-30); p = q; c = cq; lam = Math.max(lam / 3, 1e-9); improved = true; if (rel < 1e-10) it = 999; }
        else lam *= 4;
      }
      if (!improved) break;
    }
    const fitIv = k.map((kk) => Math.sqrt(Math.max(sviW(p, kk), 1e-10) / T));
    const rmse = Math.sqrt(fitIv.reduce((s, v, i) => s + (v - iv[i]) ** 2, 0) / k.length);
    return {params: p, rmse_vol: rmse, kmin: Math.min(...k), kmax: Math.max(...k)};
  }

  const sviIv = (fit, k, T) => Math.sqrt(Math.max(sviW(fit.params, k), 1e-10) / T);

  function butterflyG(fit, k) {
    const [a, b, rho, m, s] = fit.params, x = k - m, r = Math.sqrt(x * x + s * s);
    const w = a + b * (rho * x + r), w1 = b * (rho + x / r), w2 = b * s * s / (r * r * r);
    return (1 - k * w1 / (2 * w)) ** 2 - w1 * w1 / 4 * (1 / w + 0.25) + w2 / 2;
  }

  function kForDeltas(fit, T, deltas) {
    const N = 1201, K = new Array(N), nd = new Array(N);
    for (let i = 0; i < N; i++) { const k = -3 + 6 * i / (N - 1), s = sviIv(fit, k, T); K[i] = k; nd[i] = ncdf((-k + 0.5 * s * s * T) / (s * Math.sqrt(T))); }
    return deltas.map((d) => {
      if (d === 0) return 0;
      const target = d > 0 ? d : 1 + d;                                 // N(d1) visé, décroissant en k
      for (let i = 1; i < N; i++) if (nd[i] <= target) { const t = (nd[i - 1] - target) / ((nd[i - 1] - nd[i]) || 1); return K[i - 1] + t * (K[i] - K[i - 1]); }
      return K[N - 1];
    });
  }

  function buildSurface(chain, realized30, warm) {
    const slices = [], fits = [];
    for (const [exp, e] of Object.entries(chain)) {
      let fit; try { fit = fitSVI(e.k, e.iv, e.T, warm && warm[exp]); } catch (err) { continue; }
      if (warm) warm[exp] = fit.params;
      fits.push([exp, e.T, fit]);
      let gmin = Infinity; for (let i = 0; i <= 40; i++) gmin = Math.min(gmin, butterflyG(fit, fit.kmin + (fit.kmax - fit.kmin) * i / 40));
      const ks = kForDeltas(fit, e.T, DELTA_COLS.map((c) => c[1])), cols = {};
      DELTA_COLS.forEach(([name], i) => { const k = ks[i]; cols[name] = (k >= fit.kmin - 0.05 && k <= fit.kmax + 0.05) ? sviIv(fit, k, e.T) : null; });
      const atm = cols.ATM, c25 = cols["25Δ call"], p25 = cols["25Δ put"];
      const smile = Array.from({length: 30}, (_, i) => fit.kmin + (fit.kmax - fit.kmin) * i / 29);
      slices.push({expiry: exp, days: e.T * 365, T: e.T, forward: e.F, n: e.k.length, atm, rr25: c25 && p25 ? c25 - p25 : null,
        bf25: c25 && p25 && atm ? 0.5 * (c25 + p25) - atm : null, rmse: fit.rmse_vol, deltas: cols, butterfly_ok: gmin >= -1e-6, g_min: gmin,
        market: e.k.map((k, i) => ({m: Math.exp(k), iv: e.iv[i], K: e.K[i], cp: e.cp[i]})),
        fit: smile.map((k) => ({m: Math.exp(k), iv: sviIv(fit, k, e.T)}))});
    }
    fits.sort((a, b) => a[1] - b[1]);
    let cal = 0;
    for (let i = 0; i + 1 < fits.length; i++) {
      const f1 = fits[i][2], f2 = fits[i + 1][2], lo = Math.max(f1.kmin, f2.kmin), hi = Math.min(f1.kmax, f2.kmax);
      if (hi > lo) for (let j = 0; j <= 20; j++) { const k = lo + (hi - lo) * j / 20; if (sviW(f1.params, k) > sviW(f2.params, k) + 1e-6) cal++; }
    }
    const Ts = slices.map((s) => s.T), cm = CM_DAYS.map((days) => {
      const T = days / 365, row = {days, deltas: {}};
      if (Ts.length && T >= Math.min(...Ts) && T <= Math.max(...Ts)) {
        let j = Ts.findIndex((x) => x >= T); j = Math.min(Math.max(j, 1), Ts.length - 1);
        DELTA_COLS.forEach(([name]) => {
          if (Ts.length === 1) { row.deltas[name] = slices[0].deltas[name]; return; }
          const s1 = slices[j - 1], s2 = slices[j], v1 = s1.deltas[name], v2 = s2.deltas[name];
          if (v1 == null || v2 == null) { row.deltas[name] = null; return; }
          const w = v1 * v1 * s1.T + (v2 * v2 * s2.T - v1 * v1 * s1.T) * (T - s1.T) / (s2.T - s1.T);
          row.deltas[name] = Math.sqrt(Math.max(w, 0) / T);
        });
      } else DELTA_COLS.forEach(([name]) => { row.deltas[name] = null; });
      return row;
    });
    const mGrid = Array.from({length: 37}, (_, i) => Math.exp(Math.log(0.5) + (Math.log(2) - Math.log(0.5)) * i / 36));
    const grid = {moneyness: mGrid.map((m) => Math.round(m * 1000) / 10), days: [], iv: []};
    fits.forEach(([, T, fit]) => {
      grid.days.push(Math.round(T * 3650) / 10);
      grid.iv.push(mGrid.map((m) => { const k = Math.log(m); return (k >= fit.kmin - 0.03 && k <= fit.kmax + 0.03) ? Math.round(sviIv(fit, k, T) * 10000) / 100 : null; }));
    });
    const atm30 = (cm.find((r) => r.days === 30) || {deltas: {}}).deltas.ATM ?? null;
    return {slices, constant_maturity: cm, delta_cols: DELTA_COLS.map((c) => c[0]), grid3d: grid,
      calendar_violations: cal, butterfly_violations: slices.filter((s) => !s.butterfly_ok).length,
      atm_30d: atm30, realized_30d: realized30 ?? null, vrp_30d: atm30 != null && realized30 != null ? atm30 - realized30 : null};
  }

  const api = {parseChain, fitSVI, sviW, sviIv, butterflyG, kForDeltas, buildSurface, ncdf, DELTA_COLS};
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.QGVol = api;
})(typeof window !== "undefined" ? window : globalThis);
