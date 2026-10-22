// ===== Feeds: every network call the page makes. No DOM. =====
// Hyperliquid public WebSocket for the book, 1m candles, mark/oracle and trades.
// Hyperliquid REST (direct, or through /api/hl if the browser call fails) for candle history.
// Coinversa REST through /api/cv, which holds the API key, for the liquidation map and liquidation events.
const Feeds = (() => {
  const HL_INFO = 'https://api.hyperliquid.xyz/info';
  const HL_WS = 'wss://api.hyperliquid.xyz/ws';
  const ZERO_HASH = /^0x0+$/;

  const toBar = c => ({ time: Math.floor(+c.t / 1000), open: +c.o, high: +c.h, low: +c.l, close: +c.c });
  const okBar = b => isFinite(b.time) && isFinite(b.open) && isFinite(b.high) && isFinite(b.low) && isFinite(b.close);

  async function fetchT(url, opts, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
  }

  // cfg: window.CONFIG. cb: { onStatus, onBBO, onCandle, onMark, onTrades, onHeat, onLiqs, onCvError, passcode }
  function create(cfg, cb) {
    const coin = cfg.COIN;
    const emit = (name, ...a) => { if (typeof cb[name] === 'function') { try { cb[name](...a); } catch (e) { console.error('[feeds] ' + name, e); } } };
    const status = { ws: 'off', book: 'bbo', lastMsgAt: 0, reconnects: 0 };
    let ws = null, running = false, retry = 0, bboSeen = false, useBook = false;
    let reconnectTimer = null, pingTimer = null, watchTimer = null, fallbackTimer = null;
    const pollTimers = {};

    // ----- WebSocket -----
    function setWs(s) { if (status.ws !== s) { status.ws = s; emit('onStatus', { ...status }); } }
    function send(o) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} }
    const sub = s => send({ method: 'subscribe', subscription: s });
    function connect() {
      if (!running) return;
      setWs(status.reconnects ? 'reconnecting' : 'connecting');
      try { ws = new WebSocket(cfg.HL_WS || HL_WS); } catch (e) { scheduleReconnect(); return; }
      const sock = ws;
      sock.onopen = () => {
        if (sock !== ws) return;
        retry = 0; status.lastMsgAt = Date.now();
        sub({ type: 'bbo', coin });
        sub({ type: 'candle', coin, interval: '1m' });
        sub({ type: 'activeAssetCtx', coin });
        sub({ type: 'trades', coin });
        if (useBook) sub({ type: 'l2Book', coin });
        // Older servers without the bbo channel: fall back to the top of the L2 book.
        clearTimeout(fallbackTimer);
        fallbackTimer = setTimeout(() => {
          if (!bboSeen && !useBook && sock === ws) { useBook = true; status.book = 'l2Book'; sub({ type: 'l2Book', coin }); emit('onStatus', { ...status }); }
        }, 8000);
        clearInterval(pingTimer);
        pingTimer = setInterval(() => send({ method: 'ping' }), 30000);
      };
      sock.onmessage = ev => {
        if (sock !== ws) return;
        status.lastMsgAt = Date.now();
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        handle(m);
      };
      sock.onerror = () => {};
      sock.onclose = () => {
        if (sock !== ws) return;
        clearInterval(pingTimer);
        if (running) { status.reconnects++; setWs('reconnecting'); scheduleReconnect(); } else setWs('off');
      };
    }
    function scheduleReconnect() {
      clearTimeout(reconnectTimer);
      const d = Math.min(30000, 1000 * 2 ** retry) + Math.random() * 500;
      retry++;
      reconnectTimer = setTimeout(connect, d);
    }
    function live() { if (status.ws !== 'live') setWs('live'); }
    function handle(m) {
      const ch = m && m.channel, d = m && m.data;
      if (!ch || ch === 'subscriptionResponse' || ch === 'pong') return;
      if (ch === 'bbo' && d && d.bbo && (!d.coin || d.coin === coin)) {
        bboSeen = true;
        const b = d.bbo[0], a = d.bbo[1];
        if (b && a) { live(); emit('onBBO', { bid: +b.px, ask: +a.px, ms: +d.time || Date.now() }); }
      } else if (ch === 'l2Book' && d && d.levels && (!d.coin || d.coin === coin)) {
        if (bboSeen) return;
        const b = d.levels[0] && d.levels[0][0], a = d.levels[1] && d.levels[1][0];
        if (b && a) { live(); emit('onBBO', { bid: +b.px, ask: +a.px, ms: +d.time || Date.now() }); }
      } else if (ch === 'candle' && d) {
        for (const c of Array.isArray(d) ? d : [d]) {
          if (c && (!c.s || c.s === coin) && (!c.i || c.i === '1m')) { const b = toBar(c); if (okBar(b)) emit('onCandle', b); }
        }
      } else if (ch === 'activeAssetCtx' && d && d.ctx && (!d.coin || d.coin === coin)) {
        const mark = +d.ctx.markPx, index = +d.ctx.oraclePx;
        if (mark > 0) emit('onMark', { mark, index: index > 0 ? index : null, ms: Date.now() });
      } else if (ch === 'trades' && Array.isArray(d)) {
        emit('onTrades', groupTrades(d.filter(t => !t.coin || t.coin === coin)));
      } else if (ch === 'error') {
        emit('onStatus', { ...status, error: typeof d === 'string' ? d : JSON.stringify(d) });
      }
    }
    // One taker order that sweeps several resting orders arrives as several fills with the same hash.
    // Summing them gives the order's size. Fills without a real hash are kept one by one.
    function groupTrades(list) {
      const by = new Map();
      for (const t of list) {
        const px = +t.px, sz = +t.sz;
        if (!(px > 0) || !(sz > 0)) continue;
        const key = t.hash && !ZERO_HASH.test(t.hash) ? t.hash + ':' + t.side : 'tid:' + t.tid;
        const g = by.get(key) || { key, side: t.side, n: 0, sz: 0, px, time: +t.time, fills: 0 };
        g.n += px * sz; g.sz += sz; g.px = px; g.time = Math.max(g.time, +t.time); g.fills++;
        by.set(key, g);
      }
      return [...by.values()];
    }
    function watchdog() {
      if (!running || !ws || ws.readyState !== 1) return;
      if (Date.now() - status.lastMsgAt > 20000) { setWs('stale'); try { ws.close(); } catch (e) {} }
    }

    // ----- Candle history -----
    async function candles(startMs, endMs) {
      const body = { type: 'candleSnapshot', req: { coin, interval: '1m', startTime: Math.floor(startMs), endTime: Math.floor(endMs) } };
      let list = null, via = 'Hyperliquid';
      try {
        const r = await fetchT(cfg.HL_INFO || HL_INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 8000);
        if (r.ok) list = await r.json();
      } catch (e) { list = null; }
      if (!Array.isArray(list)) {
        via = 'Hyperliquid via /api/hl';
        const r = await fetchT('/api/hl', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dashboard-key': passcode() }, body: JSON.stringify(body) }, 12000);
        if (r.status === 401) { const e = new Error('passcode'); e.code = 401; throw e; }
        if (!r.ok) throw new Error('history request failed (' + r.status + ')');
        list = await r.json();
        if (!Array.isArray(list)) throw new Error('unexpected history reply');
      }
      const m = new Map();
      for (const c of list) { const b = toBar(c); if (okBar(b)) m.set(b.time, b); }
      return { via, bars: [...m.values()].sort((a, b) => a.time - b.time) };
    }

    // ----- Coinversa through the server proxy -----
    const dayKey = () => 'cv-calls-' + new Date().toISOString().slice(0, 10);
    let memCalls = 0;
    function callsToday() { try { const v = localStorage.getItem(dayKey()); return v == null ? memCalls : +v; } catch (e) { return memCalls; } }
    function countCall() { memCalls = callsToday() + 1; try { localStorage.setItem(dayKey(), String(memCalls)); } catch (e) {} }
    function slowFactor() { const c = callsToday(), b = cfg.BUDGET; return c >= b.stopAt ? Infinity : c >= b.slowAt ? 2 : 1; }
    const passcode = () => (typeof cb.passcode === 'function' ? cb.passcode() || '' : '');
    const quota = { limit: null, remaining: null, reset: null };
    async function cv(route, params) {
      countCall();
      const q = new URLSearchParams({ route, ...params });
      const r = await fetchT('/api/cv?' + q.toString(), { headers: { 'x-dashboard-key': passcode() } }, 15000);
      const h = n => r.headers.get(n);
      if (h('x-ratelimit-remaining') != null) { quota.limit = h('x-ratelimit-limit'); quota.remaining = h('x-ratelimit-remaining'); quota.reset = h('x-ratelimit-reset'); }
      let data = null; try { data = await r.json(); } catch (e) {}
      return { status: r.status, ok: r.ok, data };
    }
    const POLLS = {
      heat: { route: 'heatmap', params: () => ({ coin, range: String(cfg.HEATMAP.range), buckets: String(cfg.HEATMAP.buckets) }), every: () => cfg.HEATMAP.everyMs, on: 'onHeat' },
      liq: { route: 'liquidations', params: () => ({ coin, since: cfg.LIQUIDATIONS.since, limit: String(cfg.LIQUIDATIONS.limit) }), every: () => cfg.LIQUIDATIONS.everyMs, on: 'onLiqs' },
    };
    function schedulePoll(key, delay) { clearTimeout(pollTimers[key]); if (running) pollTimers[key] = setTimeout(() => runPoll(key), delay); }
    async function runPoll(key) {
      if (!running) return;
      const p = POLLS[key], f = slowFactor();
      if (f === Infinity) { emit('onCvError', key, { status: 0, data: { error: 'daily budget reached, liquidation feeds paused until 00:00 UTC' } }); schedulePoll(key, 10 * 60000); return; }
      let res = null;
      try { res = await cv(p.route, p.params()); } catch (e) { res = { status: 0, ok: false, data: { error: e.name === 'AbortError' ? 'timed out' : e.message } }; }
      if (!running) return;
      if (res.ok) emit(p.on, res.data); else emit('onCvError', key, res);
      // A missing key or passcode won't fix itself quickly, so those retry slowly.
      const slow = res.status === 401 || res.status === 503;
      schedulePoll(key, slow ? 5 * 60000 : p.every() * f);
    }
    function pollNow(key) { schedulePoll(key, 50); }

    function start() {
      if (running) return;
      running = true; status.reconnects = 0; retry = 0;
      connect();
      clearInterval(watchTimer); watchTimer = setInterval(watchdog, 5000);
      // The map loads before the liquidation events so the first burst can be read against it.
      schedulePoll('heat', 200); schedulePoll('liq', 1500);
    }
    function stop() {
      running = false;
      clearTimeout(reconnectTimer); clearTimeout(fallbackTimer); clearInterval(pingTimer); clearInterval(watchTimer);
      for (const k in pollTimers) clearTimeout(pollTimers[k]);
      const sock = ws; ws = null;
      if (sock) { try { sock.close(); } catch (e) {} }
      setWs('off');
    }
    function reconnectNow() { if (!running) return; const sock = ws; ws = null; if (sock) { try { sock.close(); } catch (e) {} } retry = 0; connect(); }

    return { start, stop, candles, pollNow, reconnectNow, isRunning: () => running, status: () => ({ ...status }), callsToday, slowFactor, quota: () => ({ ...quota }) };
  }

  return { create, toBar, okBar };
})();
if (typeof module !== 'undefined') module.exports = Feeds;
