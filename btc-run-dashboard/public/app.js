// ===== Page: state, rules and rendering. Network access lives in feeds.js; trade math in engine.js. =====
(() => {
'use strict';
const $ = id => document.getElementById(id);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const CFG = window.CONFIG;
const COIN = CFG.COIN;
const STORE = 'btc-run-dashboard-v1';
const PASS_KEY = 'btc-run-passcode';
const LEVELS = CFG.LEVELS || [];
const EVENTS = (CFG.EVENTS || []).map(e => ({ ...e, t: Date.parse(e.utc) }));

// ----- formatting -----
const nf = (n, d) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const px = n => '$' + nf(n, 1);
const pct = (x, d = 2) => (x * 100).toFixed(d) + '%';
const spct = (x, d = 2) => x == null || !isFinite(x) ? 'n/a' : (x > 0 ? '+' : x < 0 ? '-' : '') + (Math.abs(x) * 100).toFixed(d) + '%';
const hhmm = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const hhmmss = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const dayLabel = ms => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
const usdM = n => '$' + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
function dur(min) {
  if (min == null || !isFinite(min)) return '...';
  if (min < 1) return 'under 1 min';
  if (min < 60) return Math.round(min) + ' min';
  if (min < 1440) { const h = Math.floor(min / 60), m = Math.round(min % 60); return h + 'h ' + m + 'm'; }
  const d = Math.floor(min / 1440), h = Math.round((min % 1440) / 60); return d + 'd ' + h + 'h';
}
const okBar = b => isFinite(b.time) && isFinite(b.open) && isFinite(b.high) && isFinite(b.low) && isFinite(b.close);
const localInput = ms => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

// ----- state -----
let sim = Engine.newSim(readParams());
let bars = [];
let lastPrice = null;
let lastUpdate = 0;
let lastClosedClose = null;
let sigma = null;
let gapPending = false;
let liveQueue = [];
let manualMode = false;
let savedBars = [];
let monitorOn = false;
let historyReady = false;

const isActive = () => sim.status === 'open' || sim.status === 'pending';

function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ sim, params: readParams(), showTicks: $('showTicks').checked, bars: bars.slice(-300), monitorOn })); } catch (e) {}
}
let saveTimer = null;
function saveSoon() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; save(); }, 3000); }
function load() {
  try {
    const raw = localStorage.getItem(STORE); if (!raw) return false;
    const st = JSON.parse(raw);
    if (st.params) writeParams(st.params);
    if (st.sim && st.sim.status) {
      sim = st.sim; sim.notified = sim.notified || {}; sim.log = sim.log || [];
      sim.actions = (sim.actions || []).map(a => ({ level: 'act', kind: 'done', ...a }));
      if (sim.plan) sim.plan.manualClose = true;
    }
    if (typeof st.showTicks === 'boolean') $('showTicks').checked = st.showTicks;
    if (Array.isArray(st.bars)) savedBars = st.bars.filter(okBar);
    monitorOn = !!st.monitorOn;
    return true;
  } catch (e) { return false; }
}
const passcode = () => { try { return localStorage.getItem(PASS_KEY) || ''; } catch (e) { return ''; } };

// ----- log -----
function addLog(kind, text, at) {
  sim.log.push({ t: at || Date.now(), kind, text });
  if (sim.log.length > 400) sim.log.splice(0, sim.log.length - 400);
  renderLog(); saveSoon();
}
function renderLog() {
  const ol = $('log'); ol.textContent = '';
  const items = sim.log.slice(-200).reverse();
  if (!items.length) {
    const li = document.createElement('li'); li.className = 'tick';
    const a = document.createElement('span'); a.className = 'lt';
    const b = document.createElement('span'); b.className = 'lx';
    b.textContent = 'Nothing yet. Actions, fills, level crosses, releases and feed changes land here.';
    li.append(a, b); ol.appendChild(li); return;
  }
  for (const e of items) {
    const li = document.createElement('li'); li.className = e.kind;
    const a = document.createElement('span'); a.className = 'lt num'; a.textContent = hhmm(e.t);
    const b = document.createElement('span'); b.className = 'lx'; b.textContent = e.text;
    li.append(a, b); ol.appendChild(li);
  }
}

// ----- instructions (actions that need doing) -----
let alertsOn = false, audioCtx = null, staleId = null, swReg = null;
const RANK = { act: 3, prepare: 2, watch: 1 };
const LABEL = { act: 'ACT NOW', prepare: 'GET READY', watch: 'HEADS-UP' };
function pendingActions() {
  return (sim.actions || []).filter(a => !a.done)
    .sort((a, b) => (RANK[b.level || 'act'] - RANK[a.level || 'act']) || (b.t - a.t));
}
function hasPending(prefix) { return (sim.actions || []).some(a => !a.done && String(a.id).indexOf(prefix) === 0); }
function resolvePrefix(prefix) { (sim.actions || []).forEach(a => { if (!a.done && String(a.id).indexOf(prefix) === 0) a.done = true; }); renderActions(); }
function beep(level) {
  if (!audioCtx) return;
  try {
    const t0 = audioCtx.currentTime;
    const times = level === 'act' ? [0, 0.3, 0.6] : [0, 0.32];
    times.forEach(dt => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = level === 'act' ? 990 : 880;
      g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(0.25, t0 + dt + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.25);
      o.connect(g); g.connect(audioCtx.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.27);
    });
  } catch (e) {}
}
async function notify(level, text, id) {
  if (!alertsOn || !('Notification' in window) || Notification.permission !== 'granted') return;
  const title = `${LABEL[level]}, BTC ${sim.plan ? sim.plan.side : ''}`.trim();
  const opts = { body: text, tag: String(id), renotify: true, requireInteraction: level === 'act', icon: '/icon.svg' };
  try { if (swReg) { await swReg.showNotification(title, opts); return; } } catch (e) {}
  try { new Notification(title, opts); } catch (e) {}
}
function raiseAction(id, text, level = 'act', kind = 'done') {
  sim.actions = sim.actions || [];
  if (sim.actions.some(a => a.id === id)) return;
  sim.actions.push({ id, t: Date.now(), text, done: false, level, kind });
  addLog(level === 'watch' ? 'event' : 'action', text);
  if (alertsOn && level !== 'watch') { beep(level); notify(level, text, id); }
  renderActions(); save(); schedule();
}
function resolveAction(id) {
  const a = (sim.actions || []).find(x => x.id === id && !x.done);
  if (a) { a.done = true; renderActions(); save(); schedule(); }
}
function renderActions() {
  const ol = $('actions'); ol.textContent = '';
  const pend = pendingActions();
  ol.hidden = !pend.length;
  for (const a of pend) {
    const level = a.level || 'act';
    const li = document.createElement('li'); li.className = level;
    const at = document.createElement('span'); at.className = 'at num'; at.textContent = LABEL[level] + ', ' + hhmm(a.t);
    const ax = document.createElement('span'); ax.className = 'ax'; ax.textContent = a.text;
    const ab = document.createElement('span'); ab.className = 'ab';
    const btn = (label, fn) => { const b = document.createElement('button'); b.className = 'btn small'; b.type = 'button'; b.textContent = label; b.addEventListener('click', fn); ab.appendChild(b); };
    if (a.kind === 'cut') {
      btn('Closed it', () => closedEarly(a.id));
      btn('Holding instead', () => { resolveAction(a.id); addLog('action', 'You chose to hold through the exit level. Bust and target stay as they were.'); });
    } else btn(level === 'watch' ? 'Dismiss' : 'Done', () => resolveAction(a.id));
    li.append(at, ax, ab); ol.appendChild(li);
  }
}
function clearOpenActions() { (sim.actions || []).forEach(a => { if (!a.done) a.done = true; }); renderActions(); }
function closedEarly(id) {
  resolveAction(id);
  if (sim.status !== 'open') return;
  clearOpenActions();
  const p = lastPrice || sim.plan.entry;
  const left = Math.max(0, Math.floor(Engine.equity(sim.plan, p)));
  sim.status = 'cut'; sim.exit = { price: p, time: Math.floor(Date.now() / 60000) * 60 };
  addLog('action', `Closed early around ${px(p)}. Press Reset to plan the next entry; the paper-plan margin is prefilled with an estimate of what's left, to check against your venue.`);
  writeParams({ mode: 'plan', margin: left || undefined, goal: sim.plan.goal });
  drawLines(); save(); schedule();
}
function expireWatches(now) {
  let changed = false;
  (sim.actions || []).forEach(a => {
    const fading = a.level === 'watch' || /^(shock-|react-|print-|liqburst-)/.test(String(a.id));
    if (!a.done && fading && now - a.t > 15 * 60000) { a.done = true; changed = true; }
  });
  if (changed) { renderActions(); save(); }
}
const throughWord = pl => (pl.sgn < 0 ? 'at or below' : 'at or above');
function renderRules() {
  const pl = sim.plan || previewPlan();
  const th = thesisLevels();
  const dl = $('rules'); dl.textContent = '';
  const side = pl ? pl.side : 'short';
  const toward = pl && pl.sgn < 0 ? 'above' : 'below';
  const rows = [
    ['Normal 1m drift', 'No action. Hold.'],
    [`Hyperliquid ${pl && pl.sgn > 0 ? 'bid' : 'ask'} ${pl ? throughWord(pl) : 'through'} the target`, 'Act now. Press Close, then stop trading.'],
    ['Within 0.1% of target, or a wick tags it', 'Get ready. A wick fills nothing on this venue.'],
  ];
  if (th) {
    rows.push([`1m close ${toward} ${px(th.pressure)}`, `Get ready. The ${side} is under pressure; eases if price closes back.`]);
    rows.push([`1m close ${toward} ${px(th.invalid)}`, "Act now. Close to keep what's left, then re-plan."]);
  }
  rows.push(['Fast move or data shock toward target', 'Heads-up. Hold.']);
  rows.push(['Fast move or data shock toward bust', th ? 'Get ready. The exit level decides.' : 'Get ready. Hold unless it breaks the setup.']);
  rows.push(['Volatility jump or tight squeeze', 'Heads-up. Levels unchanged.']);
  rows.push(['Liquidation burst toward bust', 'Get ready. Squeeze risk.']);
  rows.push([`Taker order toward bust, ${usdM(CFG.PRINTS.watch)}+ / ${usdM(CFG.PRINTS.prepare)}+`, 'Heads-up / get ready. Hold.']);
  rows.push(['Price nearing a big liquidation cluster on the bust side', 'Get ready. Forced orders can speed it up.']);
  rows.push(['A liquidation cluster near price gets used up', 'Heads-up. The map shows the next cluster each way.']);
  if (th) rows.push([`Past ${px(th.pressure)}, squeeze running, liquidations stacked to bust`, 'Act now. Close early; this can jump the exit.']);
  rows.push(['Mark away from the book or from the oracle', 'Get ready. Bust may come on mark.']);
  rows.push(['Mark reaches bust', 'Act now. Check the venue.']);
  rows.push(['Bust prints', 'Act now. Check the venue; run over, no re-entry.']);
  rows.push(['Prices stop coming in while monitoring is on', 'Act now. Watch the venue, or use Manual price.']);
  for (const [k, v] of rows) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); }
}

// ----- position form -----
const PLAN_IDS = ['side', 'lev', 'margin', 'goal', 'entryMode', 'limitPx'];
const TRACK_IDS = ['tSide', 'tOpened', 'tEntry', 'tBust', 'tNotional', 'tMargin', 'tFee', 'tGoal', 'tPressure', 'tInvalid'];
function readParams() {
  const el = id => document.getElementById(id);
  const g = id => parseFloat(el(id) ? el(id).value : NaN);
  const v = (id, d) => (el(id) ? el(id).value : d);
  const opened = Date.parse(v('tOpened', ''));
  return {
    mode: v('mode', 'track'),
    side: v('side', 'short'), leverage: g('lev'), margin: g('margin'), goal: g('goal'),
    entryMode: v('entryMode', 'market'), limitPx: g('limitPx'),
    manual: { side: v('tSide', 'short'), entry: g('tEntry'), bust: g('tBust'), notional: g('tNotional'),
      margin: g('tMargin'), feeDrag: g('tFee') || 0, goal: g('tGoal'), openedMs: isFinite(opened) ? opened : NaN,
      pressure: g('tPressure'), invalid: g('tInvalid'),
      openedRaw: v('tOpened', '') },
  };
}
function writeParams(p) {
  const set = (id, val) => { if (val != null && !(typeof val === 'number' && !isFinite(val))) $(id).value = val; };
  if (p.mode) $('mode').value = p.mode;
  if (p.side) $('side').value = p.side;
  set('lev', p.leverage); set('margin', p.margin); set('goal', p.goal);
  if (p.entryMode) $('entryMode').value = p.entryMode;
  set('limitPx', p.limitPx);
  const m = p.manual;
  if (m) {
    if (m.side) $('tSide').value = m.side;
    if (m.openedRaw) $('tOpened').value = m.openedRaw;
    set('tEntry', m.entry); set('tBust', m.bust); set('tNotional', m.notional); set('tMargin', m.margin);
    set('tFee', m.feeDrag); set('tGoal', m.goal); set('tPressure', m.pressure); set('tInvalid', m.invalid);
  }
}
// The two optional thesis levels between entry and bust. Null when missing or out of order, which turns those rules off.
function thesisLevels() {
  const pl = sim.plan || previewPlan();
  const m = (sim.params && sim.params.mode === 'track' ? sim.params : readParams()).manual;
  if (!pl || !m || !(m.pressure > 0) || !(m.invalid > 0)) return null;
  const ok = pl.sgn < 0 ? (pl.entry < m.pressure && m.pressure < m.invalid && m.invalid < pl.stop)
                        : (pl.stop < m.invalid && m.invalid < m.pressure && m.pressure < pl.entry);
  return ok ? { pressure: m.pressure, invalid: m.invalid } : null;
}
function paramErrors(p) {
  if (p.mode === 'track') {
    const errs = Engine.validateManual(p.manual);
    if (!isFinite(p.manual.openedMs)) errs.push('Set the time the position opened.');
    else if (p.manual.openedMs > Date.now() + 60000) errs.push('The open time is in the future.');
    return errs;
  }
  return Engine.validate(p);
}
function previewPlan() {
  const p = sim.status === 'idle' ? readParams() : sim.params;
  if (sim.status === 'idle' && paramErrors(p).length) return null;
  if (p.mode === 'track') return Engine.manualPlan(p.manual);
  if (sim.status === 'pending') return Engine.computePlan(p, sim.limit);
  const ref = p.entryMode === 'limit' ? p.limitPx : lastPrice;
  if (!(ref > 0)) return null;
  return Engine.computePlan(p, ref);
}
function lockForm() {
  const lock = sim.status !== 'idle';
  const track = $('mode').value === 'track';
  $('mode').disabled = lock;
  $('trackFields').hidden = !track; $('planFields').hidden = track;
  for (const id of PLAN_IDS.concat(TRACK_IDS)) $(id).disabled = lock;
  $('nowBtn').disabled = lock;
  // Pressure and exit levels can be moved while a tracked position is open, when the liquidation map shifts.
  const liveEdit = sim.status === 'open' && sim.params && sim.params.mode === 'track';
  $('tPressure').disabled = !liveEdit && lock; $('tInvalid').disabled = !liveEdit && lock;
  if (!lock) $('limitPx').disabled = $('entryMode').value !== 'limit';
  $('startBtn').textContent = track ? 'Track position' : 'Start';
  $('startBtn').disabled = lock || (!track && lastPrice == null);
}

// ----- chart -----
let chart = null, series = null, lines = {}, refLines = [];
function chartMissing() {
  const el = $('chart'); if (el.querySelector('.chartMsg')) return;
  const p = document.createElement('p'); p.className = 'chartMsg';
  p.textContent = "The chart library didn't load from unpkg.com or jsDelivr. The instructions, the stats and the log still run.";
  el.appendChild(p);
}
function initChart() {
  if (window.LightweightCharts) { buildChart(); return; }
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js';
  s.onload = () => (window.LightweightCharts ? buildChart() : chartMissing());
  s.onerror = chartMissing;
  document.head.appendChild(s);
}
function buildChart() {
  const LC = window.LightweightCharts;
  chart = LC.createChart($('chart'), {
    autoSize: true,
    crosshair: { mode: LC.CrosshairMode.Normal },
    timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 6,
      tickMarkFormatter: (t, type) => type < 3 ? new Date(t * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' }) : hhmm(t * 1000) },
    localization: { timeFormatter: t => dayLabel(t * 1000) + ' ' + hhmm(t * 1000), priceFormatter: p => nf(p, 1) },
  });
  series = chart.addCandlestickSeries({ borderVisible: false, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } });
  applyTheme();
  if (bars.length) { try { series.setData(bars); } catch (e) {} }
  drawLines();
}
function applyTheme() {
  if (!chart) return;
  chart.applyOptions({
    layout: { background: { type: 'solid', color: css('--panel') }, textColor: css('--muted'), fontFamily: 'IBM Plex Mono, ui-monospace, monospace', fontSize: 11 },
    grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
    rightPriceScale: { borderColor: css('--line') }, timeScale: { borderColor: css('--line') },
  });
  series.applyOptions({ upColor: css('--up'), downColor: css('--down'), wickUpColor: css('--up'), wickDownColor: css('--down') });
  drawLines();
}
function drawLines() {
  if (!series) return;
  const LS = window.LightweightCharts.LineStyle;
  for (const k in lines) { try { series.removePriceLine(lines[k]); } catch (e) {} }
  lines = {};
  for (const l of refLines) { try { series.removePriceLine(l); } catch (e) {} }
  refLines = [];
  for (const lv of LEVELS) refLines.push(series.createPriceLine({ price: lv.price, color: css('--muted'), lineWidth: 1, lineStyle: LS.Dotted, axisLabelVisible: false, title: lv.short }));
  const mk = (price, color, style, title, width = 1) => series.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title });
  if (sim.plan && sim.status !== 'idle' && sim.status !== 'pending') {
    lines.entry = mk(sim.plan.entry, css('--accent'), LS.Solid, 'Entry', 2);
    lines.stop = mk(sim.plan.stop, css('--down'), LS.Dashed, 'Bust', 2);
    lines.tp = mk(sim.plan.tp, css('--up'), LS.Dashed, 'Target', 2);
    const th = thesisLevels();
    if (th && sim.status === 'open') {
      lines.pressure = mk(th.pressure, css('--warn'), LS.Dotted, 'Pressure');
      lines.invalid = mk(th.invalid, css('--warn'), LS.Dashed, 'Exit');
    }
  } else {
    const pl = previewPlan();
    if (pl) {
      const prm = readParams();
      if (sim.status === 'pending' || prm.mode === 'track' || prm.entryMode === 'limit') {
        lines.pEntry = mk(pl.entry, css('--accent'), LS.Dotted, sim.status === 'pending' ? 'Limit' : prm.mode === 'track' ? 'Entry (to track)' : 'Limit (plan)');
      }
      lines.pStop = mk(pl.stop, css('--down'), LS.Dotted, 'Bust (plan)');
      lines.pTp = mk(pl.tp, css('--up'), LS.Dotted, 'Target (plan)');
    }
  }
  const markers = [];
  if (sim.plan && sim.entryTime != null && sim.status !== 'pending') {
    const short = sim.plan.sgn < 0;
    markers.push({ time: sim.entryTime, position: short ? 'aboveBar' : 'belowBar', color: css('--accent'), shape: short ? 'arrowDown' : 'arrowUp', text: short ? 'Short' : 'Long' });
  }
  if (sim.exit) markers.push({ time: sim.exit.time, position: sim.status === 'won' ? 'belowBar' : 'aboveBar', color: css(sim.status === 'won' ? '--up' : sim.status === 'cut' ? '--accent' : '--down'), shape: 'circle', text: sim.status === 'won' ? 'Target' : sim.status === 'cut' ? 'Closed' : 'Bust' });
  const have = new Set(bars.map(b => b.time));
  try { series.setMarkers(markers.filter(m => have.has(m.time)).sort((a, b) => a.time - b.time)); } catch (e) {}
}
function movePreviewLines() {
  if (!series || sim.status !== 'idle') return;
  const pl = previewPlan();
  if (!pl) return;
  if (!lines.pStop) { drawLines(); return; }
  try {
    lines.pStop.applyOptions({ price: pl.stop });
    lines.pTp.applyOptions({ price: pl.tp });
    if (lines.pEntry) lines.pEntry.applyOptions({ price: pl.entry });
  } catch (e) {}
}

// ----- bars and the engine -----
function recomputeSigma() { sigma = Engine.sigma1m(bars.slice(-122, -1).map(b => b.close)); }
function mergeHistory(hist) {
  if (!hist || !hist.length) return;
  const map = new Map(bars.map(b => [b.time, b]));
  for (const h of hist) map.set(h.time, h);
  bars = [...map.values()].filter(okBar).sort((a, b) => a.time - b.time).slice(-6000);
  if (series) { try { series.setData(bars); } catch (e) {} }
  lastClosedClose = bars.length > 1 ? bars[bars.length - 2].close : null;
  recomputeSigma(); drawLines(); schedule();
}
function onLiveBar(b, opts) {
  if (!okBar(b)) return;
  const last = bars[bars.length - 1];
  if (last && b.time < last.time) {
    const i = bars.findIndex(x => x.time === b.time);
    if (i >= 0) { bars[i] = b; if (series) { try { series.setData(bars); } catch (e) {} } }
    if (!gapPending) runStep(b, { noTarget: true });
    return;
  }
  if (last && b.time > last.time) { bars.push(b); if (bars.length > 6000) bars.shift(); onCandleClose(last); }
  else if (last && b.time === last.time) bars[bars.length - 1] = b;
  else bars.push(b);
  if (series) { try { series.update(b); } catch (e) {} }
  lastPrice = b.close; lastUpdate = Date.now();
  if (staleId) { resolveAction(staleId); staleId = null; }
  resolveAction('nofeed');
  if (gapPending) { liveQueue.push({ b, opts }); if (liveQueue.length > 3000) liveQueue.shift(); }
  else runStep(b, opts);
  schedule();
}
function runStep(b, opts) {
  const evs = Engine.step(sim, b, opts);
  for (const ev of evs) handleEvent(ev);
  if (sim.status === 'open' && Engine.distances(sim.plan, b.close).toTarget < 0.001) {
    raiseAction('near-' + sim.entryTime, `Price is within 0.1% of the target at ${px(sim.plan.tp)}. Have the Close button on the BTC ${sim.plan.side} ready. The instruction to press it comes the moment the ${sim.plan.sgn > 0 ? 'bid' : 'ask'} is ${throughWord(sim.plan)} ${px(sim.plan.tp)}.`, 'prepare');
  }
  if (evs.length) { drawLines(); save(); } else saveSoon();
}
function handleEvent(ev) {
  const at = ev.time * 1000;
  const venue = manualMode ? 'your manual price' : 'Hyperliquid';
  const quote = sim.plan && sim.plan.sgn > 0 ? 'bid' : 'ask';
  if (ev.kind === 'placed') addLog('start', `Limit ${sim.params.side} placed at ${px(ev.price)}.`, at);
  if (ev.kind === 'track') {
    const pl = sim.plan; pl.manualClose = true;
    addLog('fill', `Tracking the ${pl.side} from ${px(pl.entry)}, opened ${hhmm(at)}, about ${Math.round(pl.leverage)}x. Bust ${px(pl.stop)}, target ${px(pl.tp)}. Nothing to place; you close by hand when told.`, Date.now());
  }
  if (ev.kind === 'fill') {
    sim.plan.manualClose = true;
    addLog('fill', `Filled ${sim.plan.side} at ${px(ev.price)}, ${Math.round(sim.plan.leverage)}x. Bust ${px(sim.plan.stop)}, target ${px(sim.plan.tp)}.`, at);
  }
  if (ev.kind === 'touch') {
    raiseAction('touch-' + sim.entryTime, `A wick on ${venue} tagged the ${px(sim.plan.tp)} target but the ${quote} is back at ${px(lastPrice || ev.price)}. Keep the Close button ready and press it the moment the price is ${throughWord(sim.plan)} ${px(sim.plan.tp)}.`, 'prepare');
  }
  if (ev.kind === 'target') {
    const pl = sim.plan;
    addLog('win', `The ${quote} on ${venue}, ${px(ev.price)}, is through the ${px(pl.tp)} target.`, at);
    clearOpenActions();
    raiseAction('hit-' + sim.entryTime, `Press Close on the BTC ${pl.side} now. The ${quote} on ${venue}, ${px(ev.price)}, is through the ${px(pl.tp)} target, so the close fills there or better. Then stop trading; the run is complete.`);
  }
  if (ev.kind === 'stop') {
    addLog('loss', `Bust ${px(ev.price)} printed on ${venue}.` + (ev.both ? ' The candle covered both levels, so bust is assumed to have printed first.' : ''), at);
    clearOpenActions();
    raiseAction('bust-' + sim.entryTime, `${ev.viaMark ? `Hyperliquid's mark reached bust at ${px(ev.price)}` : `Bust ${px(ev.price)} printed on ${venue}`}. Check the position on your venue. If it's gone, the run is over and nothing gets re-entered. If it's still open, the house mark hasn't reached bust and nothing changes.`);
  }
}
// Checks the candles since the last one the engine saw against the bust (never the target: a past wick
// through the target filled nothing on a manual-close venue). Then live updates take over.
function replayFrom(hist) {
  const since = sim.lastBarTime;
  if (since == null || !hist.length) { gapPending = false; flushQueue(); return; }
  let n = 0;
  for (const b of hist) { if (b.time >= since && isActive()) { Engine.step(sim, b, { noTarget: true }).forEach(handleEvent); n++; } }
  if (isActive()) {
    const first = hist[0].time;
    addLog('feed', first <= since
      ? `Checked ${n} candle${n === 1 ? '' : 's'} from ${hhmm(since * 1000)} against the bust. It didn't print. The target is judged on the live price from here.`
      : `Hyperliquid keeps at most 5,000 one-minute candles per request, so ${hhmm(since * 1000)} to ${hhmm(first * 1000)} went unchecked. The ${n} candles after that were checked against the bust; it didn't print. The target is judged on the live price from here.`);
  }
  gapPending = false;
  flushQueue();
  drawLines(); save(); schedule();
}
function flushQueue() { const q = liveQueue; liveQueue = []; for (const x of q) runStep(x.b, x.opts); }

// ----- reading the 1m tape -----
function tape() {
  if (bars.length < 3) return null;
  const cur = bars[bars.length - 1];
  const closed = bars.slice(0, -1);
  const lc = closed[closed.length - 1];
  const c1 = (lc.close - lc.open) / lc.open;
  const sgn = Math.sign(lc.close - lc.open);
  let streak = 0;
  for (let i = closed.length - 1; i >= 0; i--) { const s = Math.sign(closed[i].close - closed[i].open); if (s !== 0 && s === sgn) streak++; else break; }
  const ch = n => bars.length > n ? cur.close / bars[bars.length - 1 - n].close - 1 : null;
  const ranges = closed.slice(-60).map(b => (b.high - b.low) / b.open).sort((a, b) => a - b);
  const med = ranges.length >= 10 ? ranges[Math.floor(ranges.length / 2)] : null;
  const lcRange = (lc.high - lc.low) / lc.open;
  return { cur, lc, c1, sgn, streak, chNow: ch(1), ch5: ch(5), ch15: ch(15), spike: !!(med && lcRange > 3 * med) };
}
const colorWord = s => (s > 0 ? 'green' : s < 0 ? 'red' : 'flat');
function towardWord(x, pl) { if (x == null || !isFinite(x) || x === 0 || !pl) return null; return x * pl.sgn > 0 ? 'target' : 'bust'; }
function tapeSentence(t, pl) {
  if (!t) return '';
  let s = `Last 1m candle ${colorWord(t.sgn)} ${spct(t.c1)}` + (t.streak > 1 ? `, ${t.streak} ${colorWord(t.sgn)} in a row` : '') + '.';
  if (t.ch15 != null) { const w = towardWord(t.ch15, pl); s += ` 15m ${spct(t.ch15)}` + (w ? `, drifting toward ${w}.` : '.'); }
  if (t.spike) s += " That candle's range was over 3x the hour's typical 1m range.";
  return s;
}
function onCandleClose(bar) {
  recomputeSigma();
  if (isActive() && !gapPending) {
    const t = bar.time * 1000 + 60000;
    for (const c of Engine.crossings(lastClosedClose, bar.close, LEVELS)) {
      let tail = '';
      if (sim.status === 'open') {
        const towardBust = (c.dir === 'up') === (sim.plan.sgn < 0);
        tail = towardBust ? ` Holding. Bust stays at ${px(sim.plan.stop)}.` : ` Holding. Target stays at ${px(sim.plan.tp)}.`;
      } else tail = ` The limit at ${px(sim.limit)} keeps resting.`;
      addLog('level', `Closed ${c.dir === 'up' ? 'above' : 'below'} $${nf(c.price, 0)}, ${c.label}.` + tail, t);
    }
    if (sim.status === 'open') assess(bar);
    if (sim.status === 'open') {
      const pl = sim.plan;
      const c1 = (bar.close - bar.open) / bar.open;
      const i = bars.length - 2;
      const ch15 = i >= 15 ? bar.close / bars[i - 15].close - 1 : null;
      const d = Engine.distances(pl, bar.close);
      addLog('tick', `Close ${px(bar.close)} (${spct(c1)}). 15m ${spct(ch15)}. ${pct(d.toStop)} to bust, ${pct(d.toTarget)} to target. No action.`, t);
    } else if (sim.status === 'pending') {
      addLog('tick', `Close ${px(bar.close)}. Limit at ${px(sim.limit)} still resting.`, t);
    }
  }
  lastClosedClose = bar.close;
}

// ----- scenario checks on each closed 1m candle -----
function medianRange(list) {
  const r = list.map(b => (b.high - b.low) / b.open).filter(x => isFinite(x)).sort((a, b) => a - b);
  return r.length >= 20 ? r[Math.floor(r.length / 2)] : null;
}
function assess(bar) {
  const pl = sim.plan; if (!pl) return;
  const now = Date.now();
  const i = bars.length - 2;           // index of the candle that just closed
  if (i < 1 || bars[i].time !== bar.time) return;
  const towardBust = x => x * pl.sgn < 0; // price change direction against the position
  const beyond = lvl => (pl.sgn < 0 ? bar.close > lvl : bar.close < lvl);
  const side = pl.side, aboveBelow = pl.sgn < 0 ? 'above' : 'below';
  const P = Engine.probTargetFirst(pl, bar.close);

  // 1. The setup's own levels.
  const th = thesisLevels();
  if (th) {
    if (beyond(th.invalid)) {
      resolvePrefix('pressure-');
      raiseAction('cut-' + sim.entryTime, `Close the BTC ${side} now. A 1m candle closed ${aboveBelow} ${px(th.invalid)} at ${px(bar.close)}, which undoes the setup the ${side} was built on, so the odds now lean against it. Bust is ${pct(Engine.distances(pl, bar.close).toStop)} away and the target prints first only about ${pct(P, 0)} of the time even on neutral odds. Closing keeps what's left for a new plan. If the venue's price is already back on the other side of ${px(th.invalid)}, holding is the call.`, 'act', 'cut');
    } else if (beyond(th.pressure)) {
      if (!hasPending('pressure-') && !hasPending('cut-')) {
        raiseAction('pressure-' + bar.time, `A 1m candle closed ${aboveBelow} ${px(th.pressure)} at ${px(bar.close)}. The ${side} is under pressure. Keep holding, and be ready to close if a 1m candle closes ${aboveBelow} ${px(th.invalid)}.`, 'prepare');
      }
    } else if (hasPending('pressure-')) {
      resolvePrefix('pressure-');
      addLog('event', `Closed back on the right side of ${px(th.pressure)} at ${px(bar.close)}. Pressure eased; no action.`);
    }
  }

  // 2. Fast 3-minute move, scaled to the hour's normal 1m range.
  const med = medianRange(bars.slice(Math.max(0, i - 60), i));
  if (i >= 3 && med) {
    const move = bar.close / bars[i - 3].close - 1;
    const thr = Math.max(0.004, 5 * med);
    if (Math.abs(move) >= thr && now - (sim.notified.lastShock || 0) > 10 * 60000) {
      sim.notified.lastShock = now;
      mkt.lastShock = { at: now, dir: towardBust(move) ? 'bust' : 'target' };
      const ev = EVENTS.find(e => Math.abs(now - e.t) < 5 * 60000);
      const why = ev ? `around ${ev.name}` : 'with nothing scheduled, so likely a headline or a liquidation sweep';
      if (towardBust(move)) {
        raiseAction('shock-' + bar.time, `Fast move toward bust: ${spct(move)} in 3 minutes ${why}. Hold for now.` + (th ? ` The exit rule is a 1m close ${aboveBelow} ${px(th.invalid)}.` : ' Only a break of the setup changes the plan.'), 'prepare');
      } else {
        raiseAction('shock-' + bar.time, `Fast move toward target: ${spct(move)} in 3 minutes ${why}. Hold; Close comes when the ${pl.sgn > 0 ? 'bid' : 'ask'} is ${throughWord(pl)} ${px(pl.tp)}.`, 'watch');
      }
    }
  }

  // 3. Reaction to a scheduled release, judged on the first candle after it.
  for (const e of EVENTS) {
    if (sim.notified[e.id + ':react'] || bar.time * 1000 < e.t || bar.time * 1000 >= e.t + 3 * 60000) continue;
    sim.notified[e.id + ':react'] = 1;
    const move = bar.close / bars[i - 1].close - 1;
    if (Math.abs(move) < 0.0025) { addLog('event', `${e.name} came and went with a ${spct(move)} candle. No action.`); continue; }
    if (towardBust(move)) raiseAction('react-' + e.id, `${e.name} moved price ${spct(move)} toward bust. A data-driven move against the ${side} carries more weight than noise. Hold, but treat the next 1m closes seriously` + (th ? `: a close ${aboveBelow} ${px(th.pressure)} puts the ${side} under pressure, ${aboveBelow} ${px(th.invalid)} means close.` : '.'), 'prepare');
    else raiseAction('react-' + e.id, `${e.name} moved price ${spct(move)} toward target. Hold.`, 'watch');
  }

  // 4. Volatility regime: last 5 candles against the hour's normal.
  if (med && i >= 25) {
    const recent = bars.slice(i - 4, i + 1).reduce((a, b) => a + (b.high - b.low) / b.open, 0) / 5;
    if (recent >= 3 * med && now - (sim.notified.lastVol || 0) > 30 * 60000) {
      sim.notified.lastVol = now;
      raiseAction('vol-' + bar.time, `1m ranges just ran about ${(recent / med).toFixed(1)}x the hour's normal. Expect faster moves both ways; the levels don't change.`, 'watch');
    }
  }

  // 5. Squeeze: a very tight 30-minute range tends to end in a burst, direction unknown.
  if (i >= 30) {
    const w = bars.slice(i - 29, i + 1);
    const span = (Math.max(...w.map(b => b.high)) - Math.min(...w.map(b => b.low))) / bar.close;
    const curRange = (bar.high - bar.low) / bar.open;
    if (span < 0.0015 && !(med && curRange > 2 * med) && now - (sim.notified.lastSqueeze || 0) > 60 * 60000) {
      sim.notified.lastSqueeze = now;
      raiseAction('squeeze-' + bar.time, `The last 30 minutes traded in a ${pct(span)} range. Tight ranges usually end in a burst, direction unknown. Keep the page in view.`, 'watch');
    }
  }

  // 6. Liquidation clusters from the map.
  if (mkt.heat && now - mkt.heatAt < 15 * 60000) {
    const against = againstSide(pl), favor = forSide(pl);
    const fuelToBust = fuelBetween(bar.close, bustEdge(pl), against);
    // 6a. Squeeze alarm: past the pressure level, a fast move, a liquidation burst or a big taker order toward bust,
    //     and real fuel ahead. That combination can jump the exit level and the bust between two candles, so it closes early.
    if (th && beyond(th.pressure) && !beyond(th.invalid) && !hasPending('cut-') && !(sim.notified['cut-' + sim.entryTime])) {
      const burst = mkt.lastBurst && now - mkt.lastBurst.at < 3 * 60000 && mkt.lastBurst.dir === 'bust';
      const shock = mkt.lastShock && now - mkt.lastShock.at < 3 * 60000 && mkt.lastShock.dir === 'bust';
      if (fuelToBust >= 5e6 && (burst || shock)) {
        sim.notified['cut-' + sim.entryTime] = 1;
        resolvePrefix('pressure-');
        raiseAction('cut-' + sim.entryTime, `Close the BTC ${side} now. Price is past ${px(th.pressure)}, ${burst ? mkt.lastBurst.what : 'a fast move is running'} toward bust, and about ${usdM(fuelToBust)} of ${against} liquidations sit between here and the bust. A squeeze like that can jump the ${px(th.invalid)} exit and the bust within a candle, the one case the exit level can't catch. Closing now keeps what's left. If the move has already stalled and turned on your venue, holding is the call.`, 'act', 'cut');
      }
    }
    // 6b. Price approaching a large cluster on the bust side.
    for (const k of mkt.heat) {
      const n = against === 'short' ? k.shortN : k.longN;
      if (n < CFG.CLUSTER.min) continue;
      const edge = pl.sgn < 0 ? k.low : k.high;
      const between = pl.sgn < 0 ? (edge > bar.close && edge < pl.stop * 1.003) : (edge < bar.close && edge > pl.stop * 0.997);
      if (!between || Math.abs(edge / bar.close - 1) > 0.003) continue;
      raiseAction('fuel-' + Math.round(edge) + '-' + Math.floor(now / 3600000), `About ${usdM(n)} of ${against} liquidations sit from ${px(k.low)} to ${px(k.high)}, ${pct(Math.abs(edge / bar.close - 1))} away. If price reaches them, forced orders can speed it toward your exit and bust. Hold; the exit rule stands.`, 'prepare');
      break;
    }
    // 6c. A large cluster between price and the target, worth knowing about when price leans that way.
    const fuelToTarget = fuelBetween(pl.tp, bar.close, favor);
    const lean = priceMove(15);
    if (fuelToTarget >= 2e7 && lean != null && lean * pl.sgn > 0.001 && now - (sim.notified.lastCascade || 0) > 60 * 60000) {
      sim.notified.lastCascade = now;
      raiseAction('cascade-' + bar.time, `About ${usdM(fuelToTarget)} of ${favor} liquidations sit between here and the target, and the last 15 minutes lean that way (${spct(lean)}). A break through them can cascade toward the target. Hold.`, 'watch');
    }
  }
  save();
}

// ===== Data: Hyperliquid stream, history and Coinversa (through feeds.js) =====
const src = { ws: 'Off', wsOk: null, candles: 'Off', candlesOk: null, bbo: 'Off', bboOk: null, mark: 'Off', markOk: null, flow: 'Off', flowOk: null, liq: 'Off', liqOk: null, fuel: 'Off', fuelOk: null };
const mkt = { mark: null, index: null, markAt: 0, markCheckAt: 0, bid: null, ask: null, heat: null, heatAt: 0, heatPrev: null, heatPrevAt: 0, heatMeta: null,
  liqSeen: new Set(), liqTimes: [], liqRecent: 0, liqWallets: 0, flows: [], lastBurst: null, lastShock: null, bboAt: 0, candleAt: 0 };
function setConn(state, text) { $('connDot').className = 'dot ' + state; $('connText').textContent = text; }
function showBanner(text) { $('bannerText').textContent = text; $('banner').hidden = false; }
function hideBanner() { $('banner').hidden = true; }
const feeds = Feeds.create(CFG, {
  passcode,
  onStatus: s => onWsStatus(s),
  onBBO: q => onBBO(q),
  onCandle: b => onCandle(b),
  onMark: m => onMark(m),
  onTrades: g => onTrades(g),
  onHeat: d => onHeat(d),
  onLiqs: d => onLiqs(d),
  onCvError: (key, res) => onCvError(key, res),
});

function renderSrc() {
  const set = (id, text, ok) => { const el = $(id); el.textContent = text; el.className = ok == null ? '' : ok ? 'ok' : 'bad'; };
  set('srcWs', src.ws, src.wsOk);
  set('srcBbo', src.bbo, src.bboOk);
  set('srcCandles', src.candles, src.candlesOk);
  set('srcMark', src.mark, src.markOk);
  set('srcFlow', src.flow, src.flowOk);
  set('srcLiq', src.liq, src.liqOk);
  set('srcFuel', src.fuel, src.fuelOk);
  const c = feeds.callsToday(), q = feeds.quota(), f = feeds.slowFactor();
  set('srcBudget', `${nf(c, 0)} today from this browser` + (q.remaining != null ? `, ${q.remaining} left on the key` : '') + (f === Infinity ? ', paused for the day' : f > 1 ? ', slowed 2x' : ''), c < CFG.BUDGET.slowAt);
  $('resumeBtn').hidden = !manualMode;
}
function onWsStatus(s) {
  const map = { off: ['Off', null], connecting: ['Connecting', null], reconnecting: [`Reconnecting (${s.reconnects})`, false], live: ['Live' + (s.book === 'l2Book' ? ', top of book from l2Book' : ''), true], stale: ['No messages for 20s, reconnecting', false] };
  const [text, ok] = map[s.ws] || [s.ws, null];
  src.ws = s.error ? `${text}. Server said: ${s.error}` : text; src.wsOk = ok;
  if (!monitorOn) setConn('', 'Monitoring off');
  else if (manualMode) setConn('live', 'Manual price');
  else if (s.ws === 'live') { setConn('live', 'Hyperliquid live'); hideBanner(); }
  else setConn('wait', s.ws === 'connecting' ? 'Connecting to Hyperliquid' : 'Reconnecting to Hyperliquid');
  renderSrc();
}

// ----- primary feeds: book and candles -----
function onBBO(q) {
  mkt.bid = q.bid; mkt.ask = q.ask; mkt.bboAt = Date.now();
  src.bbo = `${nf(q.bid, 1)} / ${nf(q.ask, 1)} at ${hhmmss(q.ms)}`; src.bboOk = true; renderSrcSoon();
  if (manualMode || !historyReady) return;
  const closeSide = sim.plan && sim.plan.sgn > 0 ? q.bid : q.ask;
  if (closeSide === lastPrice && Date.now() - lastUpdate < 5000) return;
  pushPrice(closeSide, q.ms);
}
function pushPrice(price, ms) {
  const t = Math.floor(ms / 60000) * 60;
  const last = bars[bars.length - 1];
  if (last && t < last.time) return;
  const b = last && last.time === t
    ? { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price }
    : { time: t, open: last ? last.close : price, high: Math.max(price, last ? last.close : price), low: Math.min(price, last ? last.close : price), close: price };
  onLiveBar(b);
}
// Candles carry trade prices; the book carries the close side. The forming bar keeps the book's close and
// widens to the candle's high and low, so the bust check sees every trade. Finished minutes take the candle as is.
function onCandle(c) {
  mkt.candleAt = Date.now();
  src.candles = `Streaming, last update ${hhmmss(Date.now())}`; src.candlesOk = true; renderSrcSoon();
  if (manualMode || !historyReady) return;
  const last = bars[bars.length - 1];
  if (!last || c.time > last.time) { onLiveBar(c, { noTarget: true }); return; }
  if (c.time < last.time) { if (c.time >= last.time - 900) onLiveBar(c, { noTarget: true }); return; }
  const bookLive = Date.now() - mkt.bboAt < 5000;
  onLiveBar({ time: c.time, open: last.open, high: Math.max(last.high, c.high), low: Math.min(last.low, c.low), close: bookLive ? last.close : c.close }, { noTarget: true });
}
let srcTimer = null;
function renderSrcSoon() { if (!srcTimer) srcTimer = setTimeout(() => { srcTimer = null; renderSrc(); }, 500); }

async function loadHistory(reason) {
  historyReady = false;
  const now = Date.now();
  const def = now - CFG.HISTORY_MINUTES * 60000;
  const since = isActive() && sim.lastBarTime != null ? sim.lastBarTime * 1000 : def;
  const start = Math.max(Math.min(since, def), now - 4990 * 60000);
  src.candles = 'Loading history'; src.candlesOk = null; renderSrc();
  try {
    const { via, bars: list } = await feeds.candles(start, now);
    if (!monitorOn) return;
    src.candles = `${nf(list.length, 0)} candles loaded from ${via}`; src.candlesOk = true; renderSrc();
    mergeHistory(savedBars.concat(list)); savedBars = [];
    if (list.length && lastPrice == null) { lastPrice = list[list.length - 1].close; lastUpdate = Date.now(); }
    if (gapPending) replayFrom(list);
  } catch (e) {
    if (!monitorOn) return;
    if (e.code === 401) askPasscode('The history backup at /api/hl needs the dashboard passcode.');
    src.candles = 'History failed: ' + e.message + '. Live candles only.'; src.candlesOk = false; renderSrc();
    if (gapPending) {
      addLog('feed', `Couldn't load candle history (${e.message}), so the time since ${sim.lastBarTime != null ? hhmm(sim.lastBarTime * 1000) : 'the open'} wasn't checked against the bust. Check your venue; live checks run from now.`);
      gapPending = false; flushQueue();
    }
  }
  historyReady = true;
  if (reason) addLog('feed', reason);
  schedule();
}

// ----- mark and oracle -----
function onMark(r) {
  mkt.mark = r.mark; mkt.index = r.index; mkt.markAt = Date.now();
  const now = Date.now();
  if (now - mkt.markCheckAt < 1000) return;   // the stream sends many per second; check once a second
  mkt.markCheckAt = now;
  src.mark = `${nf(r.mark, 1)} mark` + (r.index ? `, ${nf(r.index, 1)} oracle` : ''); src.markOk = true; renderSrcSoon();
  if (sim.status !== 'open' || manualMode || !historyReady) return;
  const pl = sim.plan, slot = Math.floor(now / 600000);
  if (pl.sgn < 0 ? r.mark >= pl.stop : r.mark <= pl.stop) { markBust(r.mark); return; }
  const ref = pl.sgn < 0 ? mkt.ask : mkt.bid;
  if (ref && Math.abs(r.mark / ref - 1) > 0.0015) {
    raiseAction('markgap-' + slot, `Hyperliquid's mark (${px(r.mark)}) sits ${pct(Math.abs(r.mark / ref - 1))} from the ${pl.sgn < 0 ? 'ask' : 'bid'} (${px(ref)}). If your venue liquidates on mark rather than the book, bust can arrive sooner or later than the book shows. Hold, and keep the venue in view.`, 'prepare');
  }
  if (r.index && Math.abs(r.mark / r.index - 1) > 0.002) {
    raiseAction('oracle-' + slot, `Mark and oracle are ${pct(Math.abs(r.mark / r.index - 1))} apart. That usually means a squeeze or a thin book on Hyperliquid, and prices there can jump. Hold; the exit rule stands.`, 'prepare');
  }
}
function markBust(mark) {
  sim.status = 'lost';
  sim.exit = { price: mark, time: Math.floor(Date.now() / 60000) * 60, both: false };
  handleEvent({ kind: 'stop', price: mark, time: sim.exit.time, viaMark: true });
  drawLines(); save(); schedule();
}

// ----- taker orders -----
// Hyperliquid reports the taker's side on each trade: B is a taker buy, A a taker sell.
function onTrades(groups) {
  const now = Date.now();
  for (const g of groups) mkt.flows.push({ t: now, side: g.side, n: g.n });
  mkt.flows = mkt.flows.filter(f => now - f.t < 60000);
  const buy = mkt.flows.filter(f => f.side === 'B').reduce((a, f) => a + f.n, 0);
  const sell = mkt.flows.filter(f => f.side === 'A').reduce((a, f) => a + f.n, 0);
  src.flow = `buy ${usdM(buy)}, sell ${usdM(sell)}`; src.flowOk = true; renderSrcSoon();
  if (sim.status !== 'open' || !historyReady || manualMode) return;
  const pl = sim.plan;
  for (const g of groups) {
    if (g.n < CFG.PRINTS.watch) continue;
    const buyTaker = g.side === 'B';
    const towardBust = (pl.sgn < 0) === buyTaker;
    const what = `a ${usdM(g.n)} taker ${buyTaker ? 'buy' : 'sell'}`;
    if (towardBust && g.n >= CFG.PRINTS.prepare) mkt.lastBurst = { at: now, dir: 'bust', what: what + ' is pushing' };
    const level = towardBust ? (g.n >= CFG.PRINTS.prepare ? 'prepare' : 'watch') : 'watch';
    raiseAction('print-' + g.key, `${what[0].toUpperCase() + what.slice(1)} order hit Hyperliquid at ${px(g.px)} across ${g.fills} fill${g.fills === 1 ? '' : 's'}, pushing toward ${towardBust ? 'bust' : 'target'}. ` + (towardBust ? 'One order doesn\'t make a trend; the next 1m candles show whether it follows through. Hold.' : 'No action. Hold.'), level);
  }
}

// ----- Coinversa: liquidation events and the liquidation map -----
const againstSide = pl => (pl.sgn < 0 ? 'short' : 'long');   // liquidations that push price toward this position's bust
const forSide = pl => (pl.sgn < 0 ? 'long' : 'short');       // liquidations that push price toward its target
function fuelBetween(a, b, side, heat) {
  const h = heat || mkt.heat;
  if (!h) return 0;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  let n = 0;
  for (const k of h) {
    if (k.high <= lo || k.low >= hi) continue;
    const v = side === 'short' ? k.shortN : k.longN;
    const w = k.high - k.low;
    // Count only the part of an edge bucket that lies inside the range.
    n += w > 0 ? v * (Math.min(k.high, hi) - Math.max(k.low, lo)) / w : v;
  }
  return n;
}
function bustEdge(pl) { return pl.sgn < 0 ? pl.stop * 1.003 : pl.stop * 0.997; }
function priceMove(minutes) {
  if (bars.length < 2) return null;
  const now = bars[bars.length - 1];
  const past = bars.slice().reverse().find(b => b.time <= now.time - minutes * 60);
  return past ? now.close / past.close - 1 : null;
}
function onCvError(key, res) {
  const which = key === 'heat' ? 'fuel' : 'liq';
  const msg = res && res.data && (res.data.error || res.data.detail || res.data.message);
  if (res.status === 401) { askPasscode('The liquidation data needs the dashboard passcode.'); src[which] = 'Locked, enter the passcode'; }
  else if (res.status === 503) src[which] = 'Not set up: ' + (msg || 'COINVERSA_API_KEY is missing on the server');
  else if (res.status === 429) src[which] = 'Rate limited by Coinversa, retrying';
  else src[which] = 'Unavailable' + (res.status ? ` (${res.status})` : '') + (msg ? ': ' + msg : '');
  src[which + 'Ok'] = false; renderSrc();
}
function onLiqs(p) {
  if (!p || !Array.isArray(p.events)) { onCvError('liq', { status: 0, data: { error: 'no liquidation list in the reply' } }); return; }
  const now = Date.now();
  for (const e of p.events) {
    const id = e.timestampMs + ':' + e.address + ':' + e.liquidator + ':' + e.closedPnl;
    if (!mkt.liqSeen.has(id)) { mkt.liqSeen.add(id); mkt.liqTimes.push({ t: +e.timestampMs, a: e.address }); }
  }
  if (mkt.liqSeen.size > 5000) mkt.liqSeen = new Set([...mkt.liqSeen].slice(-2500));
  mkt.liqTimes = mkt.liqTimes.filter(x => now - x.t < 30 * 60000);
  const recentList = mkt.liqTimes.filter(x => now - x.t < 2 * 60000);
  const recent = recentList.length, wallets = new Set(recentList.map(x => x.a)).size;
  const base = (mkt.liqTimes.length - recent) / 14; // average fills per 2 minutes over the previous 28 minutes
  mkt.liqRecent = recent; mkt.liqWallets = wallets;
  src.liq = `${recent} fill${recent === 1 ? '' : 's'} from ${wallets} wallet${wallets === 1 ? '' : 's'} in 2 min` + (p.events.length >= CFG.LIQUIDATIONS.limit ? ' (list capped, more fired)' : '');
  src.liqOk = true; renderSrc();
  if (sim.status !== 'open' || !historyReady || recent < Math.max(8, 4 * base)) return;
  const pl = sim.plan, slot = Math.floor(now / 300000);
  if (!mkt.heat) feeds.pollNow('heat');
  const side = burstSide();
  const who = `${wallets} wallet${wallets === 1 ? '' : 's'} liquidated on Hyperliquid in 2 minutes (${recent} fills)`;
  if (!side) {
    raiseAction('liqburst-' + slot, `${who}, but price barely moved and no liquidation cluster is within reach, so which side is being forced out isn't clear yet. No action; the next candles will show it.`, 'watch');
    return;
  }
  const towardBust = side === againstSide(pl);
  mkt.lastBurst = { at: now, dir: towardBust ? 'bust' : 'target', what: 'liquidations are firing' };
  const p0 = lastPrice || pl.entry;
  if (towardBust) {
    const fuel = fuelBetween(p0, bustEdge(pl), againstSide(pl));
    raiseAction('liqburst-' + slot, `${who}, and they're ${side}s: price traded ${side === 'short' ? 'up' : 'down'} into the ${side} liquidation stack, toward your bust. Forced orders can carry price further than the 1m chart suggests.` + (fuel >= 1e6 ? ` About ${usdM(fuel)} more ${side} liquidations sit between here and the bust.` : '') + ' Hold for now; the exit and squeeze rules decide.', 'prepare');
  } else {
    const fuel = fuelBetween(pl.tp, p0, forSide(pl));
    raiseAction('liqburst-' + slot, `${who}, and they're ${side}s: price traded ${side === 'long' ? 'down' : 'up'} into the ${side} liquidation stack, which pushes toward your target.` + (fuel >= 1e6 ? ` About ${usdM(fuel)} more ${side} liquidations sit between here and the target.` : '') + ' No action. Hold.', 'watch');
  }
}
// Which side a liquidation burst is hitting. Longs fire as price trades down into their liquidation prices,
// shorts as it trades up into theirs, so the last 2 minutes' range is checked against the map first.
// Without a map, or when both or neither stack is in reach, the 2-minute move decides, and only if it's at least 0.05%.
function burstSide() {
  const lastT = bars.length ? bars[bars.length - 1].time : 0;
  const recentBars = bars.filter(b => b.time >= lastT - 120);
  if (!recentBars.length) return null;
  const lo = Math.min(...recentBars.map(b => b.low)), hi = Math.max(...recentBars.map(b => b.high));
  if (mkt.heat) {
    const longTops = mkt.heat.filter(k => k.longN >= 2e5).map(k => k.high);
    const shortBottoms = mkt.heat.filter(k => k.shortN >= 2e5).map(k => k.low);
    const nearLong = longTops.length > 0 && lo <= Math.max(...longTops) * 1.001;
    const nearShort = shortBottoms.length > 0 && hi >= Math.min(...shortBottoms) * 0.999;
    if (nearLong && !nearShort) return 'long';
    if (nearShort && !nearLong) return 'short';
  }
  const mv = priceMove(2);
  if (mv != null && Math.abs(mv) >= 0.0005) return mv < 0 ? 'long' : 'short';
  return null;
}
// Runs of adjacent buckets on one side, each at least bucketMin, totalling at least min.
function clustersOf(heat, side) {
  const key = side === 'short' ? 'shortN' : 'longN';
  const out = []; let cur = null;
  for (const k of heat) {
    if (k[key] >= CFG.CLUSTER.bucketMin) {
      if (cur && Math.abs(k.low - cur.high) < 1e-6) { cur.high = k.high; cur.n += k[key]; }
      else { if (cur) out.push(cur); cur = { side, low: k.low, high: k.high, n: k[key] }; }
    } else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.filter(c => c.n >= CFG.CLUSTER.min);
}
function onHeat(p) {
  if (!p || !Array.isArray(p.buckets)) { onCvError('heat', { status: 0, data: { error: 'no buckets in the reply' } }); return; }
  const heat = p.buckets.map(b => ({ low: +b.low, high: +b.high, longN: +b.longNotional || 0, shortN: +b.shortNotional || 0 }))
    .filter(k => isFinite(k.low) && isFinite(k.high)).sort((a, b) => a.low - b.low);
  if (mkt.heat) { mkt.heatPrev = mkt.heat; mkt.heatPrevAt = mkt.heatAt; }
  mkt.heat = heat; mkt.heatAt = Date.now(); mkt.heatMeta = { asOf: p.asOf ? Date.parse(p.asOf) : null, price: +p.currentPrice || null };
  src.fuel = `Updated ${hhmmss(mkt.heatAt)}, ${heat.length} buckets over ±${CFG.HEATMAP.range}%`; src.fuelOk = true; renderSrc();
  checkUsedUp();
  renderMap();
}
// A cluster that held at least CLUSTER.min on the last map, has mostly gone on this one, and that price traded into
// since then, was most likely liquidated. The map can't tell that apart from positions closing or adding margin.
function checkUsedUp() {
  if (!mkt.heatPrev || !historyReady) return;
  const sinceT = Math.floor(mkt.heatPrevAt / 1000) - 60;
  const traded = bars.filter(b => b.time >= sinceT);
  if (!traded.length) return;
  const lo = Math.min(...traded.map(b => b.low)), hi = Math.max(...traded.map(b => b.high));
  const now = lastPrice || traded[traded.length - 1].close;
  for (const side of ['long', 'short']) {
    for (const c of clustersOf(mkt.heatPrev, side)) {
      const reached = side === 'long' ? lo <= c.high : hi >= c.low;
      if (!reached) continue;
      const left = fuelBetween(c.low, c.high, side);
      if (left > 0.4 * c.n) continue;
      const extreme = side === 'long' ? lo : hi;
      let text = `The ${usdM(c.n)} ${side} liquidation cluster at ${px(c.low)} to ${px(c.high)} is mostly gone (${usdM(left)} left). Price reached ${px(extreme)} and is at ${px(now)}.`;
      if (sim.status === 'open') {
        const pl = sim.plan, towardTarget = side === forSide(pl);
        const next = nearestCluster(side, now);
        text += towardTarget
          ? ` That was forced selling toward your target.` + (next ? ` The next ${side} cluster is ${usdM(next.n)} at ${px(next.low)} to ${px(next.high)}, ${pct(Math.abs((side === 'long' ? next.high : next.low) / now - 1))} away.` : ` No other ${side} cluster of ${usdM(CFG.CLUSTER.min)}+ sits within the map.`)
          : ` That was forced buying toward your bust.` + (next ? ` The next ${side} cluster is ${usdM(next.n)} at ${px(next.low)} to ${px(next.high)}.` : '');
        text += ' No action.';
      }
      raiseAction('used-' + side + '-' + Math.round(c.low), text, 'watch');
    }
  }
}
function nearestCluster(side, price) {
  if (!mkt.heat) return null;
  const list = clustersOf(mkt.heat, side).filter(c => side === 'long' ? c.high <= price * 1.0005 : c.low >= price * 0.9995);
  if (!list.length) return null;
  return side === 'long' ? list[list.length - 1] : list[0];
}
function biggestCluster(side, lo, hi) {
  if (!mkt.heat) return null;
  const list = clustersOf(mkt.heat, side).filter(c => c.high > lo && c.low < hi);
  return list.sort((a, b) => b.n - a.n)[0] || null;
}
function renderMap() {
  if (!mkt.heat) return;
  const p = lastPrice || (mkt.heatMeta && mkt.heatMeta.price);
  if (!p) return;
  const pl = sim.status === 'open' ? sim.plan : null;
  const age = Math.round((Date.now() - mkt.heatAt) / 1000);
  $('mapAge').textContent = `Coinversa, updated ${age < 60 ? age + 's' : Math.round(age / 60) + ' min'} ago`;
  let tSide, bSide, tLo, tHi, bLo, bHi, tLabel, bLabel;
  if (pl) {
    tSide = forSide(pl); bSide = againstSide(pl);
    [tLo, tHi] = [Math.min(pl.tp, p), Math.max(pl.tp, p)];
    [bLo, bHi] = [Math.min(p, bustEdge(pl)), Math.max(p, bustEdge(pl))];
    tLabel = `${tSide} liquidations, price to target`; bLabel = `${bSide} liquidations, price to bust`;
  } else {
    const r = CFG.HEATMAP.range / 100;
    tSide = 'long'; bSide = 'short';
    [tLo, tHi] = [p * (1 - r), p]; [bLo, bHi] = [p, p * (1 + r)];
    tLabel = `Longs below, within ${CFG.HEATMAP.range}%`; bLabel = `Shorts above, within ${CFG.HEATMAP.range}%`;
  }
  const tN = fuelBetween(tLo, tHi, tSide), bN = fuelBetween(bLo, bHi, bSide);
  $('balTK').textContent = pl ? 'Toward target' : 'Longs below';
  $('balBK').textContent = pl ? 'Toward bust' : 'Shorts above';
  $('balTV').textContent = usdM(tN); $('balBV').textContent = usdM(bN);
  $('balTS').textContent = tLabel; $('balBS').textContent = bLabel;
  const tot = tN + bN;
  $('balBarT').style.width = (tot ? (tN / tot) * 100 : 50) + '%';
  $('balBarB').style.width = (tot ? (bN / tot) * 100 : 50) + '%';
  let note = '';
  if (tot > 0) {
    const ratio = tN >= bN ? tN / Math.max(bN, 1) : bN / Math.max(tN, 1);
    const bigger = tN >= bN ? (pl ? 'target side' : 'long side') : (pl ? 'bust side' : 'short side');
    note = ratio < 1.15 ? 'About even.' : `The ${bigger} is ${ratio.toFixed(1)}x the other.`;
  }
  if (mkt.heatPrev) {
    const pT = fuelBetween(tLo, tHi, tSide, mkt.heatPrev), pB = fuelBetween(bLo, bHi, bSide, mkt.heatPrev);
    const d = x => (x >= 0 ? '+' : '-') + usdM(Math.abs(x));
    note += ` Since the previous map: ${pl ? 'target side' : 'longs'} ${d(tN - pT)}, ${pl ? 'bust side' : 'shorts'} ${d(bN - pB)}.`;
  }
  $('balNote').textContent = note.trim();
  const dl = $('clusters'); dl.textContent = '';
  const row = (k, v) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); };
  const desc = (c, edge) => c ? `${usdM(c.n)} at ${px(c.low)} to ${px(c.high)}, ${pct(Math.abs(edge / p - 1))} away` : 'none of ' + usdM(CFG.CLUSTER.min) + '+';
  const nT = nearestCluster(tSide, p), nB = nearestCluster(bSide, p);
  const gT = biggestCluster(tSide, tLo, tHi), gB = biggestCluster(bSide, bLo, bHi);
  row(`Nearest ${tSide} cluster`, desc(nT, nT && (tSide === 'long' ? nT.high : nT.low)));
  if (gT && (!nT || gT.low !== nT.low)) row(`Biggest ${tSide} cluster`, desc(gT, tSide === 'long' ? gT.high : gT.low));
  row(`Nearest ${bSide} cluster`, desc(nB, nB && (bSide === 'long' ? nB.high : nB.low)));
  if (gB && (!nB || gB.low !== nB.low)) row(`Biggest ${bSide} cluster`, desc(gB, bSide === 'long' ? gB.high : gB.low));
}

// ----- passcode -----
function askPasscode(why) {
  $('passRow').hidden = false;
  $('srcFix').textContent = why + ' It was set with the deployment (DASHBOARD_KEY).'; $('srcFix').hidden = false;
}
$('passBtn').addEventListener('click', () => {
  const v = $('passIn').value.trim();
  if (!v) { $('passIn').focus(); return; }
  try { localStorage.setItem(PASS_KEY, v); } catch (e) {}
  $('passIn').value = ''; $('passRow').hidden = true; $('srcFix').hidden = true;
  addLog('feed', 'Passcode saved in this browser.');
  if (monitorOn) { feeds.pollNow('heat'); feeds.pollNow('liq'); if (!historyReady || src.candlesOk === false) loadHistory(); }
});
$('passIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('passBtn').click(); });

// ----- monitoring switch -----
let offArmed = null;
function renderMonitor() {
  const b = $('monBtn');
  b.setAttribute('aria-pressed', monitorOn ? 'true' : 'false');
  b.classList.toggle('armed', !!offArmed);
  $('monText').textContent = offArmed ? 'Confirm: stop monitoring' : monitorOn ? 'Monitoring on' : 'Monitoring off';
}
function monitorStart(why) {
  monitorOn = true; offArmed = null;
  if (isActive()) { gapPending = true; liveQueue = []; }
  feeds.start();
  setConn('wait', 'Connecting to Hyperliquid');
  renderMonitor(); save(); schedule();
  loadHistory(why);
}
function monitorStop() {
  monitorOn = false; historyReady = false;
  feeds.stop();
  for (const k of ['ws', 'bbo', 'candles', 'mark', 'flow', 'liq', 'fuel']) { src[k] = 'Off'; src[k + 'Ok'] = null; }
  setConn('', 'Monitoring off'); hideBanner();
  if (staleId) { resolveAction(staleId); staleId = null; }
  resolveAction('nofeed');
  addLog('feed', isActive() ? 'Monitoring off. The position stays tracked; when monitoring comes back on, the candles from now are checked against the bust first.' : 'Monitoring off.');
  renderMonitor(); renderSrc(); save(); schedule();
}
$('monBtn').addEventListener('click', () => {
  if (!monitorOn) { monitorStart('Monitoring on.'); return; }
  if (isActive() && !offArmed) {
    offArmed = setTimeout(() => { offArmed = null; renderMonitor(); }, 4000);
    renderMonitor(); return;
  }
  clearTimeout(offArmed); offArmed = null;
  monitorStop();
});

// ----- keep the screen on, alerts, and catching up after time away -----
let wakeLock = null, wakeWanted = false, hiddenAt = null, actionsAtHide = 0;
function renderWake() {
  const b = $('wakeBtn');
  if (!('wakeLock' in navigator)) { b.textContent = 'Screen lock not available'; b.disabled = true; return; }
  b.textContent = wakeLock ? 'Screen stays on' : 'Keep screen on'; b.classList.toggle('on', !!wakeLock);
}
async function requestWake() {
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; renderWake(); });
  } catch (e) { wakeLock = null; }
  renderWake();
}
$('wakeBtn').addEventListener('click', async () => {
  if (wakeLock) { wakeWanted = false; try { await wakeLock.release(); } catch (e) {} wakeLock = null; renderWake(); return; }
  wakeWanted = true; requestWake();
});
function renderAlerts() {
  const b = $('alertBtn');
  if (!alertsOn) { b.textContent = 'Turn on alerts'; b.classList.remove('on'); return; }
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  b.textContent = perm === 'granted' ? 'Alerts on' : 'Sound on, notifications blocked';
  b.classList.add('on');
}
$('alertBtn').addEventListener('click', async () => {
  alertsOn = true;
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.resume) audioCtx.resume(); } catch (e) {}
  try { if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch (e) {}
  try { if (!swReg && 'serviceWorker' in navigator) swReg = await navigator.serviceWorker.register('/sw.js'); } catch (e) { swReg = null; }
  renderAlerts(); beep('prepare');
});
document.addEventListener('visibilitychange', () => {
  const now = Date.now();
  if (document.hidden) { hiddenAt = now; actionsAtHide = (sim.actions || []).length; return; }
  if (wakeWanted && !wakeLock) requestWake();
  if (monitorOn && feeds.status().ws !== 'live') feeds.reconnectNow();
  if (hiddenAt && now - hiddenAt > 2 * 60000 && isActive() && monitorOn) {
    const raised = (sim.actions || []).length - actionsAtHide;
    if (raised > 0) raiseAction('away-' + now, `You were away ${dur((now - hiddenAt) / 60000)}. ${raised} instruction${raised === 1 ? '' : 's'} came up meanwhile; see below.`, 'watch');
  }
  hiddenAt = null;
});

// ----- my call -----
function nearEvent(now) {
  for (const e of EVENTS) {
    if (now >= e.t - 10 * 60000 && now < e.t) return { ...e, phase: 'pre', mins: Math.max(1, Math.ceil((e.t - now) / 60000)) };
    if (now >= e.t && now < e.t + 5 * 60000) return { ...e, phase: 'post' };
  }
  return null;
}
function currentCall(now) {
  const s = sim;
  const pend = pendingActions();
  if (pend.length) {
    const top = pend[0], level = top.level || 'act';
    return { cls: level === 'act' ? 'act' : level === 'prepare' ? 'prep' : 'watch', action: LABEL[level], alert: level !== 'watch', soft: level === 'watch',
      text: top.text + (pend.length > 1 ? ` (${pend.length - 1} more below.)` : '') };
  }
  if (s.status === 'cut') return { cls: 'done', action: 'CLOSED', text: `Closed early around ${px(s.exit.price)}. Press Reset, then start a new plan with what's left. The paper-plan margin is prefilled with an estimate to check against your venue.` };
  if (s.status === 'won') return { cls: 'done', action: 'DONE', text: `Closed at the target, ${px(s.exit.price)}. The run is complete, no more trades.` };
  if (s.status === 'lost') return { cls: 'over', action: 'OVER', text: `Bust printed at ${px(s.exit.price)}. The run is over.` };
  if (!monitorOn) {
    return { cls: 'wait', action: 'OFF', text: isActive()
      ? `Monitoring is off, so nothing is checking the ${s.plan ? s.plan.side + ' from ' + px(s.plan.entry) : 'position'}. Turn it on to stream Hyperliquid prices; the time it was off gets checked against the bust first.`
      : 'Monitoring is off. Fill in the position, then turn monitoring on when you resume testing. Nothing runs and no Coinversa calls are made while it is off.' };
  }
  const p = lastPrice;
  if (p == null) return { cls: 'wait', action: 'WAIT', text: 'Waiting for the first bid and ask from Hyperliquid.' };
  if (s.status === 'idle') {
    const prm = readParams(); const errs = paramErrors(prm);
    if (errs.length) return { cls: 'ready', action: 'READY', text: errs[0] };
    const pl = previewPlan(); if (!pl) return { cls: 'ready', action: 'READY', text: 'Set a limit price to see the levels.' };
    if (prm.mode === 'track') return { cls: 'ready', action: 'READY', text: `Track position follows the ${pl.side} from ${px(pl.entry)} with bust at ${px(pl.stop)} and target at ${px(pl.tp)}.` };
    const entry = prm.entryMode === 'limit' ? `with a limit at ${px(pl.entry)}` : 'at market';
    return { cls: 'ready', action: 'READY', text: `No position. Start opens a ${prm.side} ${entry}, ${prm.leverage}x, with bust at ${px(pl.stop)} and target at ${px(pl.tp)}.` };
  }
  if (s.status === 'pending') {
    const pl = previewPlan();
    return { cls: 'wait', action: 'WAIT', text: `Limit ${s.params.side} resting at ${px(s.limit)}, ${pct(Math.abs(Math.log(s.limit / p)))} from ${px(p)}. No action until it fills. On a fill, bust goes to ${px(pl.stop)} and target to ${px(pl.tp)}.` };
  }
  const pl = s.plan; const d = Engine.distances(pl, p);
  const read = tapeSentence(tape(), pl);
  const ev = nearEvent(now);
  const NA = { cls: 'hold', action: 'NO ACTION' };
  if (ev && ev.phase === 'pre') return { ...NA, text: `Hold through ${ev.name} at ${hhmm(ev.t)}, ${ev.mins} min out. ${read} Nothing to change before the print.` };
  if (ev && ev.phase === 'post') return { ...NA, text: `${ev.name} just came out. ${read} Hold. Only a print at bust or target needs anything from you.` };
  if (d.toStop < 0.25 * pl.stopDist) return { ...NA, text: `Hold. ${pct(d.toStop)} from bust at ${px(pl.stop)}. ${read} Don't add margin or move anything; the bust is the exit on this side.` };
  if (d.toTarget < 0.25 * pl.tpDist) return { ...NA, text: `Hold. ${pct(d.toTarget)} from target at ${px(pl.tp)}. ${read} The instruction to press Close comes the moment the ${pl.sgn > 0 ? 'bid' : 'ask'} is ${throughWord(pl)} it.` };
  const eta = Engine.expectedMinutes(pl, p, sigma);
  return { ...NA, text: `Hold. ${read} ${pct(d.toStop)} to bust, ${pct(d.toTarget)} to target` + (eta ? `; one of them prints in about ${dur(eta)} on the recent pace.` : '.') };
}
let monitorSince = 0;
function feedWatch(now) {
  if (!monitorOn || !historyReady || manualMode) { monitorSince = 0; return; }
  if (!monitorSince) monitorSince = now;
  if (!isActive()) return;
  if (!lastUpdate && now - monitorSince > 45000) {
    raiseAction('nofeed', "No price has come in yet. Check the Feeds panel for what Hyperliquid returned, and type the ask from your venue into Manual price so the levels keep getting checked.");
  } else if (lastUpdate && now - lastUpdate > 45000 && !staleId && !document.hidden) {
    staleId = 'stale-' + now;
    raiseAction(staleId, 'No new price for 45 seconds. Watch the position on your venue directly until prices come back, or type the ask into Manual price.');
    showBanner('The Hyperliquid stream has gone quiet. The page keeps reconnecting.');
  }
}
function eventReminders(now) {
  if (!isActive() || !monitorOn) return;
  for (const e of EVENTS) {
    if (now >= e.t - 10 * 60000 && now < e.t && !sim.notified[e.id + ':pre']) { sim.notified[e.id + ':pre'] = 1; addLog('event', `${e.name} at ${hhmm(e.t)}. No action; holding through it.`); }
    if (now >= e.t && now < e.t + 5 * 60000 && !sim.notified[e.id + ':post']) { sim.notified[e.id + ':post'] = 1; addLog('event', `${e.name} released. No action.`); }
  }
}

// ----- render -----
let rafPending = false;
function schedule() {
  if (rafPending) return;
  rafPending = true;
  const run = () => { rafPending = false; render(); };
  if (document.hidden || typeof requestAnimationFrame !== 'function') setTimeout(run, 250); else requestAnimationFrame(run);
}
function setStat(id, v, sub, cls) {
  const el = $(id); el.textContent = v; el.className = 'v num' + (cls ? ' ' + cls : '');
  if (sub != null) $(id + 'S').textContent = sub;
}
function render() {
  const now = Date.now();
  const p = lastPrice;
  $('price').textContent = p != null ? nf(p, 1) : '...';
  const age = lastUpdate ? Math.round((now - lastUpdate) / 1000) : null;
  const srcName = manualMode ? 'Manual price' : `Hyperliquid BTC perp, ${sim.plan && sim.plan.sgn > 0 ? 'bid' : 'ask'} (your close side)`;
  $('venue').textContent = !monitorOn ? (p != null ? `Monitoring off, last price ${age != null ? dur(age / 60) + ' ago' : ''}` : 'Monitoring off')
    : p != null ? `${srcName}, updated ${age <= 1 ? 'just now' : age + 's ago'}` : 'Waiting for Hyperliquid';

  const chip = $('chip');
  chip.textContent = { idle: 'No position', pending: 'Limit resting', open: (sim.plan ? sim.plan.side : '') + ' open', won: 'Target hit', lost: 'Bust', cut: 'Closed early' }[sim.status];
  chip.className = 'chip ' + sim.status;

  const pl = sim.status === 'idle' || sim.status === 'pending' ? previewPlan() : sim.plan;
  const t = tape();
  const dirCls = x => (x == null || !isFinite(x) || x === 0 ? '' : x > 0 ? 'up' : 'down');
  const towardSub = x => { const w = towardWord(x, pl); return w ? 'toward ' + w : ''; };
  setStat('sNow', t ? spct(t.chNow) : '...', t ? towardSub(t.chNow) : '', t ? dirCls(t.chNow) : '');
  setStat('s5', t ? spct(t.ch5) : '...', t ? towardSub(t.ch5) : '', t ? dirCls(t.ch5) : '');
  setStat('s15', t ? spct(t.ch15) : '...', t ? towardSub(t.ch15) : '', t ? dirCls(t.ch15) : '');
  if (pl && (sim.status === 'won' || sim.status === 'lost' || sim.status === 'cut')) {
    setStat('sStop', px(pl.stop), 'Bust level'); setStat('sTp', px(pl.tp), 'Target level');
    setStat('sProb', sim.status === 'won' ? '100%' : sim.status === 'lost' ? '0%' : 'Closed', 'Settled');
  } else if (pl && p != null && (sim.status === 'open' || (sim.status === 'idle' && readParams().mode === 'track'))) {
    const d = Engine.distances(pl, p);
    setStat('sStop', pct(d.toStop), 'at ' + px(pl.stop));
    setStat('sTp', pct(d.toTarget), 'at ' + px(pl.tp));
    setStat('sProb', pct(Engine.probTargetFirst(pl, p), 1), 'From the current price');
  } else if (pl) {
    const d = Engine.distances(pl, pl.entry);
    setStat('sStop', pct(d.toStop), 'at ' + px(pl.stop));
    setStat('sTp', pct(d.toTarget), 'at ' + px(pl.tp));
    setStat('sProb', pct(Engine.probTargetFirst(pl, pl.entry), 1), 'Driftless geometry');
  } else { ['sStop', 'sTp', 'sProb'].forEach(id => setStat(id, '...', null)); }

  const dp = sim.status === 'idle' || sim.status === 'pending' ? previewPlan() : sim.plan;
  $('dEntry').textContent = dp ? px(dp.entry) : '...';
  $('dStop').textContent = dp ? px(dp.stop) : '...';
  $('dTp').textContent = dp ? px(dp.tp) : '...';
  const errs = sim.status === 'idle' ? paramErrors(readParams()) : [];
  $('formErr').hidden = !errs.length; $('formErr').textContent = errs.join(' ');

  const c = currentCall(now);
  $('callAction').textContent = c.action; $('callAction').className = 'callAction ' + c.cls;
  $('callText').textContent = c.text.replace(/\s{2,}/g, ' ').trim();
  $('callBox').classList.toggle('alert', !!c.alert);
  $('callBox').classList.toggle('soft', !!c.soft);

  lockForm();
  movePreviewLines();
}
function renderEvents() {
  const now = Date.now();
  const ul = $('events'); ul.textContent = '';
  const list = EVENTS.filter(e => e.t > now - 60 * 60000).slice(0, 8);
  if (!list.length) { const li = document.createElement('li'); li.textContent = 'No scheduled events left on the list. Add them in config.js.'; ul.appendChild(li); return; }
  for (const e of list) {
    const li = document.createElement('li');
    const diff = e.t - now;
    li.className = diff < 0 ? 'past' : diff < 30 * 60000 ? 'soon' : '';
    const t = document.createElement('span'); t.className = 't num'; t.textContent = sameDay(e.t, now) ? hhmm(e.t) : dayLabel(e.t);
    const n = document.createElement('span'); n.className = 'n'; n.textContent = e.name;
    const cd = document.createElement('span'); cd.className = 'c num'; cd.textContent = diff < 0 ? `${dur(-diff / 60000)} ago` : `in ${dur(diff / 60000)}`;
    const note = document.createElement('span'); note.className = 'note'; note.textContent = (sameDay(e.t, now) ? '' : hhmm(e.t) + '. ') + e.note;
    li.append(t, n, cd, note); ul.appendChild(li);
  }
}

// ----- controls -----
['tPressure', 'tInvalid'].forEach(id => $(id).addEventListener('change', () => {
  if (sim.status !== 'open' || !sim.params || sim.params.mode !== 'track') return;
  const v = parseFloat($(id).value);
  const key = id === 'tPressure' ? 'pressure' : 'invalid';
  const before = sim.params.manual[key];
  sim.params.manual[key] = v > 0 ? v : NaN;
  const other = sim.params.manual[key === 'pressure' ? 'invalid' : 'pressure'];
  if (v > 0 && other > 0 && !thesisLevels()) {
    sim.params.manual[key] = before; $(id).value = before > 0 ? before : '';
    $('formErr').textContent = 'Keep entry < pressure < exit < bust (reversed for a long).'; $('formErr').hidden = false; return;
  }
  resolvePrefix('pressure-');
  addLog('feed', `${key === 'pressure' ? 'Pressure' : 'Exit'} level ${v > 0 ? `set to ${px(v)}` : 'cleared'}${before > 0 ? `, was ${px(before)}` : ''}.`);
  renderRules(); drawLines(); save(); schedule();
}));
PLAN_IDS.concat(TRACK_IDS, ['mode']).forEach(id => $(id).addEventListener('input', () => {
  if (sim.status !== 'idle') return;
  sim.params = readParams(); lockForm(); drawLines(); renderRules(); schedule(); save();
}));
$('nowBtn').addEventListener('click', () => { $('tOpened').value = localInput(Date.now()); $('tOpened').dispatchEvent(new Event('input')); });
function startTracking(prm) {
  sim.params = prm;
  Engine.trackPosition(sim, Engine.manualPlan(prm.manual), prm.manual.openedMs / 1000).forEach(handleEvent);
  gapPending = true; liveQueue = [];
  if (manualMode) { gapPending = false; flushQueue(); }
  else if (monitorOn) loadHistory();
  // With monitoring off, the replay runs when it's turned on.
  renderRules(); drawLines(); save(); schedule();
}
$('startBtn').addEventListener('click', () => {
  if (sim.status !== 'idle') return;
  const prm = readParams();
  if (paramErrors(prm).length) { schedule(); return; }
  if (prm.mode === 'track') { startTracking(prm); return; }
  if (!bars.length) return;
  if (prm.entryMode === 'limit' && !(prm.limitPx > 0)) return;
  sim.params = prm;
  const b = bars[bars.length - 1];
  const evs = prm.entryMode === 'limit' ? Engine.placeLimit(sim, b, prm.limitPx) : Engine.enterMarket(sim, b);
  evs.forEach(ev => handleEvent({ ...ev, time: Math.floor(Date.now() / 1000) }));
  drawLines(); save(); schedule();
});
let resetArmed = null;
$('resetBtn').addEventListener('click', () => {
  const btn = $('resetBtn');
  if (!resetArmed && sim.status !== 'idle') {
    btn.textContent = 'Confirm reset'; btn.classList.add('armed');
    resetArmed = setTimeout(() => { resetArmed = null; btn.textContent = 'Reset'; btn.classList.remove('armed'); }, 4000);
    return;
  }
  clearTimeout(resetArmed); resetArmed = null; btn.textContent = 'Reset'; btn.classList.remove('armed');
  sim = Engine.newSim(readParams());
  sim.actions = [];
  gapPending = false; liveQueue = [];
  addLog('start', 'Reset. No position.');
  renderActions(); renderRules(); drawLines(); renderMap(); save(); schedule();
});
$('manualBtn').addEventListener('click', () => {
  const p = parseFloat($('manualPx').value);
  if (!(p > 0)) { $('manualPx').focus(); return; }
  if (!manualMode) {
    manualMode = true;
    if (gapPending) { gapPending = false; flushQueue(); }
    addLog('feed', 'Switched to manual prices. Hyperliquid updates are ignored until you switch back.');
    setConn('live', 'Manual price'); hideBanner(); renderSrc();
  }
  pushPrice(p, Date.now());
});
$('manualPx').addEventListener('keydown', e => { if (e.key === 'Enter') $('manualBtn').click(); });
$('resumeBtn').addEventListener('click', () => {
  manualMode = false;
  addLog('feed', 'Back to Hyperliquid prices.');
  if (monitorOn) { setConn('wait', 'Waiting for Hyperliquid'); loadHistory(); } else setConn('', 'Monitoring off');
  renderSrc();
});
$('showTicks').addEventListener('change', e => { $('log').classList.toggle('hideTicks', !e.target.checked); save(); });

const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
if (mq && mq.addEventListener) mq.addEventListener('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ----- boot -----
load();
sim.actions = sim.actions || [];
$('log').classList.toggle('hideTicks', !$('showTicks').checked);
initChart();
if (savedBars.length) { mergeHistory(savedBars); lastPrice = null; }
renderLog(); renderActions(); renderEvents(); renderSrc(); renderRules(); renderWake(); renderAlerts(); renderMonitor(); render();
if (monitorOn) monitorStart('Monitoring resumed on page load.'); else setConn('', 'Monitoring off');
if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then(r => { if (r) swReg = r; }).catch(() => {});
setInterval(() => { const now = Date.now(); eventReminders(now); feedWatch(now); expireWatches(now); renderEvents(); render(); if (mkt.heat) renderMap(); }, 1000);
window.addEventListener('beforeunload', save);
window.__btcRun = { get sim() { return sim; }, get bars() { return bars; }, mkt, feeds, src };
})();
