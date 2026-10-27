/* Moteur temps réel dans le navigateur — édition Vercel (pas de serveur permanent).
 * Remplace /api/stream et /api/vol du serveur local, avec des objets de même forme :
 *   - prix BTC/ETH : WebSocket Coinbase (référence) et Kraken (contrôle croisé), barres de 1 s ;
 *   - portefeuille : VL, P&L du jour, coussin, drawdown, risque par position, alarmes, recalculés chaque seconde
 *     à partir de l'état publié chaque soir (state.json) et du prix courant ;
 *   - surface de volatilité : chaîne d'options Deribit (WebSocket JSON-RPC) chaque seconde, SVI en JavaScript.
 * Les WebSocket ne sont pas soumises au CORS : aucune clé ni serveur intermédiaire n'est nécessaire.
 */
(function () {
  "use strict";
  const PRODUCTS = {BTC: {coinbase: "BTC-USD", kraken: "BTC/USD"}, ETH: {coinbase: "ETH-USD", kraken: "ETH/USD"}};
  const quotes = {BTC: {}, ETH: {}}, bars = {BTC: [], ETH: []}, ticks = {BTC: [], ETH: []}, status = {}, events = [];
  const now = () => Date.now() / 1000;
  const event = (level, msg) => { events.unshift({t: new Date().toISOString().slice(0, 19), level, msg}); events.length = Math.min(events.length, 200); };

  function ws(name, url, onOpen, onMsg) {
    let delay = 1000, sock = null;
    const open = () => {
      try { sock = new WebSocket(url); } catch (e) { status[name] = {connected: false, mode: "websocket", error: String(e)}; return setTimeout(open, delay); }
      sock.onopen = () => { delay = 1000; status[name] = {connected: true, mode: "websocket", error: null}; event("info", `Flux ${name} connecté`); onOpen(sock); };
      sock.onmessage = (e) => { try { onMsg(JSON.parse(e.data), sock); } catch (err) { /* message ignoré */ } };
      sock.onclose = () => { if (status[name] && status[name].connected) event("warn", `Flux ${name} interrompu`);
        status[name] = {connected: false, mode: "reconnexion", error: "connexion fermée"}; setTimeout(open, delay); delay = Math.min(delay * 2, 30000); };
      sock.onerror = () => { status[name] = {connected: false, mode: "reconnexion", error: "connexion refusée (pare-feu ou proxy ?)"}; };
    };
    open();
    return () => sock;
  }

  function update(asset, venue, price, bid, ask, open24) {
    quotes[asset][venue] = {price, bid, ask, recv: now(), open_24h: open24};
    if (venue === "coinbase") ticks[asset].push(now());
  }

  function startPriceFeeds() {
    ws("coinbase", "wss://ws-feed.exchange.coinbase.com",
      (s) => s.send(JSON.stringify({type: "subscribe", product_ids: ["BTC-USD", "ETH-USD"], channels: ["ticker", "heartbeat"]})),
      (m) => { if (m.type === "ticker") { const a = m.product_id.split("-")[0]; if (quotes[a]) update(a, "coinbase", +m.price, +m.best_bid, +m.best_ask, +m.open_24h); } });
    ws("kraken", "wss://ws.kraken.com/v2",
      (s) => s.send(JSON.stringify({method: "subscribe", params: {channel: "ticker", symbol: ["BTC/USD", "ETH/USD"]}})),
      (m) => { if (m.channel === "ticker") (m.data || []).forEach((d) => { const a = d.symbol.split("/")[0]; if (quotes[a] && d.last != null) update(a, "kraken", +d.last, d.bid, d.ask); }); });
  }

  // ------------------------------------------------------------------ analytique intraday (barres de 1 s)
  function sample() {
    const sec = Math.floor(now());
    for (const a of Object.keys(quotes)) {
      const p = quotes[a].coinbase || quotes[a].kraken; if (!p) continue;
      const b = bars[a];
      if (b.length && b[b.length - 1][0] === sec) b[b.length - 1][1] = p.price; else b.push([sec, p.price]);
      if (b.length > 3600) b.splice(0, b.length - 3600);
      ticks[a] = ticks[a].filter((t) => now() - t <= 60);
    }
  }
  function intraday(a, lastClose) {
    const b = bars[a]; if (b.length < 3) return {};
    const px = b.map((x) => x[1]), lr = [];
    for (let i = Math.max(1, px.length - 900); i < px.length; i++) lr.push(Math.log(px[i] / px[i - 1]) / Math.sqrt(Math.max(1, b[i][0] - b[i - 1][0])));
    const mean = lr.reduce((s, v) => s + v, 0) / (lr.length || 1), sd = Math.sqrt(lr.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, lr.length - 1));
    const last = px[px.length - 1], ago = (n) => px[Math.max(0, px.length - 1 - n)];
    return {rv_15m: lr.length > 30 ? sd * Math.sqrt(365 * 86400) : null, mom_1m: last / ago(60) - 1, mom_15m: last / ago(900) - 1,
      dd_1h: last / Math.max(...px) - 1, ret_vs_close: lastClose ? last / lastClose - 1 : null};
  }

  // ------------------------------------------------------------------ portefeuille recalculé au prix courant
  function buildLive(S) {
    const t0 = performance.now(), A = {};
    for (const a of Object.keys(quotes)) {
      const q = quotes[a], p = q.coinbase || q.kraken, k = q.kraken;
      const mk = (S && S.markets || []).find((m) => m.key === a);
      const lastClose = mk ? mk.last : null;
      A[a] = Object.assign({price: p ? p.price : null, bid: p && p.bid, ask: p && p.ask, age: p ? now() - p.recv : null,
        venue: q.coinbase ? "coinbase" : q.kraken ? "kraken" : null, kraken: k ? k.price : null,
        xvenue_gap: p && k && q.coinbase ? p.price / k.price - 1 : null, ticks_per_min: ticks[a].length, last_close: lastClose, nowcast: null}, intraday(a, lastClose));
    }
    let portfolio = null;
    if (S && S.live_ref) {
      const R = S.live_ref, marks = [], posRisk = [];
      let intradayPnl = 0;
      for (const p of S.portfolio.positions || []) {
        const side = p.side_n || (p.side === "LONG" ? 1 : -1), px = A[p.asset] && A[p.asset].price;
        if (p.kind !== "crypto" || !px || !p.last_close) {
          marks.push({asset: p.asset, kind: p.kind, ret: p.ret, pnl_intraday: 0, stop: p.stop, tp: p.tp, distance_to_stop: p.ret - p.stop,
            marked: "clôture officielle", notional: p.notional, side});
          continue;
        }
        const move = side * (px / p.last_close - 1), ret = p.idx * (1 + move) - 1, pnl = p.notional * move;
        intradayPnl += pnl;
        marks.push({asset: p.asset, kind: "crypto", price: px, ret, pnl_intraday: pnl, stop: -p.stop_dist, tp: p.tp_dist,
          distance_to_stop: ret + p.stop_dist, stop_px: p.last_close * (1 + side * ((1 - p.stop_dist) / p.idx - 1)),
          tp_px: p.last_close * (1 + side * ((1 + p.tp_dist) / p.idx - 1)), marked: "temps réel", notional: p.notional, side, age: A[p.asset].age});
      }
      const nav = R.nav_close + intradayPnl, floor = S.portfolio.floor, cushion = nav - floor, dayPnl = nav / R.nav_close - 1;
      const dd = nav / Math.max(R.hwm, nav) - 1, cr = R.cushion0 > 0 ? cushion / R.cushion0 : null;
      marks.forEach((m) => posRisk.push({asset: m.asset, risk: m.notional * Math.max(m.distance_to_stop, 0) / nav}));
      const held = marks.filter((m) => m.kind === "crypto").map((m) => m.asset);
      const ages = (held.length ? held : Object.keys(A)).map((a) => A[a].age).filter((x) => x != null);
      const gaps = Object.values(A).map((x) => x.xvenue_gap).filter((x) => x != null).map(Math.abs);
      const checks = {
        drawdown: {value: dd, limit: -R.kill.kill_drawdown, breach: dd <= -R.kill.kill_drawdown},
        cushion_ratio: {value: cr, limit: R.kill.kill_cushion_ratio, breach: cr != null && cr < R.kill.kill_cushion_ratio},
        daily_loss: {value: dayPnl, limit: -R.kill.kill_daily_loss, breach: dayPnl <= -R.kill.kill_daily_loss},
        feed_staleness: {value: ages.length ? Math.max(...ages) : null, limit: 120, breach: held.length > 0 && (!ages.length || Math.max(...ages) > 120)},
        xvenue_gap: {value: gaps.length ? Math.max(...gaps) : null, limit: 0.02, breach: gaps.length > 0 && Math.max(...gaps) > 0.02},
      };
      const reasons = Object.keys(checks).filter((k) => checks[k].breach);
      marks.filter((m) => m.kind === "crypto" && (m.ret <= m.stop || m.ret >= m.tp)).forEach((m) => {
        const key = m.asset + (m.ret <= m.stop ? "stop" : "tp");
        if (!buildLive.done[key]) { buildLive.done[key] = 1; event(m.ret <= m.stop ? "crit" : "good", `${m.asset} : ${m.ret <= m.stop ? "limite de perte" : "objectif"} atteint à ${m.price.toFixed(2)} $ (exécutée par le calcul du soir)`); }
      });
      portfolio = {nav_live: nav, nav_close: R.nav_close, day_pnl: dayPnl, intraday_pnl: intradayPnl, floor, cushion, cushion_ratio: cr, drawdown: dd,
        marks, closed_now: [], kill: {triggered: reasons.length > 0, reasons, checks, halted_until: R.halted_until},
        risk_lock: dayPnl <= -R.max_daily_loss, n_positions: marks.length, last_close_date: (S.markets.find((m) => m.key === "DGS10") || {}).date,
        position_risk: posRisk, gross_live: marks.reduce((s, m) => s + m.notional, 0) / nav,
        crypto_live: marks.filter((m) => m.kind === "crypto").reduce((s, m) => s + m.notional, 0) / nav};
    }
    return {time: now(), ready: !!S, feed: {status: Object.assign({}, status), assets: A}, assets: A, portfolio, reco_crypto: [],
      events: events.slice(0, 40), compute_ms: performance.now() - t0};
  }
  buildLive.done = {};

  // ------------------------------------------------------------------ surface de volatilité (Deribit)
  const vol = {BTC: {status: "en attente", updated_at: null, surface: null, n_updates: 0}, ETH: {status: "en attente", updated_at: null, surface: null, n_updates: 0}};
  const warm = {BTC: {}, ETH: {}};
  let realized = {}, rpcId = 1;
  const pending = {};
  function startDeribit() {
    let timer = null;
    ws("deribit", "wss://www.deribit.com/ws/api/v2", (s) => {
      clearInterval(timer);
      const ask = () => ["BTC", "ETH"].forEach((cur) => { const id = rpcId++; pending[id] = {cur, t: performance.now()};
        if (s.readyState === 1) s.send(JSON.stringify({jsonrpc: "2.0", id, method: "public/get_book_summary_by_currency", params: {currency: cur, kind: "option"}})); });
      ask(); timer = setInterval(ask, 1000);                                   // une surface par seconde
    }, (m) => {
      const q = pending[m.id]; if (!q) return; delete pending[m.id];
      const v = vol[q.cur];
      if (m.error) { v.status = "erreur"; v.error = m.error.message || "erreur Deribit"; return; }
      try {
        const surf = window.QGVol.buildSurface(window.QGVol.parseChain(m.result || []), realized[q.cur], warm[q.cur]);
        surf.n_options = (m.result || []).length;
        Object.assign(v, {status: "ok", updated_at: now(), compute_ms: performance.now() - q.t, surface: surf, error: null, n_updates: v.n_updates + 1});
      } catch (e) { v.status = "erreur"; v.error = String(e); }
    });
    setInterval(() => { if (!status.deribit || !status.deribit.connected) ["BTC", "ETH"].forEach((c) => { if (vol[c].status !== "ok") { vol[c].status = "erreur"; vol[c].error = (status.deribit || {}).error || "connexion à Deribit impossible"; } }); }, 5000);
  }
  function volSnapshot(S) {
    const out = {};
    for (const c of Object.keys(vol)) out[c] = Object.assign({}, vol[c], {age: vol[c].updated_at ? now() - vol[c].updated_at : null});
    return {crypto: out, model: S ? S.vol_model : null, data_date: S && S.recommendations_live ? S.recommendations_live.data_date : null};
  }

  let started = false;
  window.QGStatic = {
    start(getState, onLive) {
      if (started) return; started = true;
      startPriceFeeds(); startDeribit();
      setInterval(() => { sample(); const S = getState(); if (S && S.realized_30d) realized = S.realized_30d; onLive({live: buildLive(S), job: {}}); }, 1000);
    },
    vol: volSnapshot,
    bars: (a, n) => (bars[a] || []).slice(-(n || 900)),
  };
})();
