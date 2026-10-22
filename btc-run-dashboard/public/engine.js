// ===== Engine: pure simulation logic (no DOM, no network) =====
const Engine = (() => {
  // Levels for a frictionless venue with the whole margin posted:
  // liquidation sits 1/leverage away, and the target sits wherever
  // the gain equals goal - margin.
  function computePlan(p, entry) {
    const L = p.leverage, m = p.margin, g = p.goal;
    const sgn = p.side === 'long' ? 1 : -1;
    const notional = m * L;
    const stopDist = 1 / L;
    const tpDist = (g / m - 1) / L;
    return {
      side: p.side, sgn, margin: m, leverage: L, goal: g, entry,
      notional, qty: notional / entry, stopDist, tpDist,
      stop: entry * (1 - sgn * stopDist),
      tp: entry * (1 + sgn * tpDist),
    };
  }

  function validate(p) {
    const errs = [];
    if (!(p.margin > 0)) errs.push('Margin has to be above $0.');
    if (!(p.leverage >= 1 && p.leverage <= 1000)) errs.push('Leverage has to be between 1x and 1000x.');
    if (!(p.goal > p.margin)) errs.push('The goal has to be above the margin.');
    if (p.side === 'short' && p.margin > 0 && p.leverage >= 1 && (p.goal / p.margin - 1) / p.leverage >= 1) {
      errs.push('That goal needs BTC to fall more than 100%. Raise leverage or lower the goal.');
    }
    return errs;
  }

  // An existing position copied from a venue: its own bust price, and an
  // optional fee the venue nets out of PnL. The target is the price where
  // equity after that fee reaches the goal.
  function manualPlan(m) {
    const sgn = m.side === 'long' ? 1 : -1;
    const feeDrag = m.feeDrag > 0 ? m.feeDrag : 0;
    const tpDist = (m.goal - m.margin + feeDrag) / m.notional;
    return {
      side: m.side, sgn, margin: m.margin, leverage: m.notional / m.margin, goal: m.goal,
      entry: m.entry, notional: m.notional, qty: m.notional / m.entry, feeDrag,
      stopDist: Math.abs(m.bust - m.entry) / m.entry, tpDist,
      stop: m.bust, tp: m.entry * (1 + sgn * tpDist), manual: true,
    };
  }

  function validateManual(m) {
    const errs = [];
    if (!(m.entry > 0)) errs.push('Entry price has to be above $0.');
    if (!(m.notional > 0)) errs.push('Notional has to be above $0.');
    if (!(m.margin > 0)) errs.push('Margin has to be above $0.');
    if (!(m.goal > m.margin)) errs.push('The goal has to be above the margin.');
    if (!(m.bust > 0)) errs.push('Bust price has to be above $0.');
    else if (m.entry > 0 && (m.side === 'short' ? m.bust <= m.entry : m.bust >= m.entry)) {
      errs.push(m.side === 'short' ? 'For a short, the bust price sits above entry.' : 'For a long, the bust price sits below entry.');
    }
    if (m.side === 'short' && m.notional > 0 && (m.goal - m.margin + (m.feeDrag > 0 ? m.feeDrag : 0)) / m.notional >= 1) {
      errs.push('That goal needs BTC to fall more than 100%.');
    }
    return errs;
  }

  function trackPosition(sim, plan, openedSec) {
    const t = Math.floor(openedSec / 60) * 60;
    sim.plan = plan;
    sim.mark = { time: t, high: plan.entry, low: plan.entry };
    sim.entryTime = t;
    sim.lastBarTime = t;
    sim.limit = null;
    sim.status = 'open';
    return [{ kind: 'track', price: plan.entry, time: t }];
  }

  function pnl(plan, price) { return plan.notional * plan.sgn * (price - plan.entry) / plan.entry - (plan.feeDrag || 0); }
  function equity(plan, price) { return Math.max(0, plan.margin + pnl(plan, price)); }

  // Fraction of the way from price to each level, in log terms.
  function distances(plan, price) {
    return {
      toStop: Math.abs(Math.log(plan.stop / price)),
      toTarget: Math.abs(Math.log(plan.tp / price)),
    };
  }

  function beyond(plan, price) {
    if (plan.sgn < 0) {
      if (price >= plan.stop) return 'stop';
      if (price <= plan.tp) return 'target';
    } else {
      if (price <= plan.stop) return 'stop';
      if (price >= plan.tp) return 'target';
    }
    return null;
  }

  // Driftless chance that the target prints before the stop.
  function probTargetFirst(plan, price) {
    const b = beyond(plan, price);
    if (b === 'stop') return 0;
    if (b === 'target') return 1;
    const { toStop, toTarget } = distances(plan, price);
    return toStop / (toStop + toTarget);
  }

  // Std dev of 1-minute log returns.
  function sigma1m(closes) {
    if (!closes || closes.length < 21) return null;
    const r = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > 0 && closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
    }
    if (r.length < 20) return null;
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const v = r.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (r.length - 1);
    const s = Math.sqrt(v);
    return s > 0 ? s : null;
  }

  // Expected minutes until either level prints (driftless Brownian motion).
  function expectedMinutes(plan, price, sigma) {
    if (!sigma || beyond(plan, price)) return null;
    const { toStop, toTarget } = distances(plan, price);
    return (toStop * toTarget) / (sigma * sigma);
  }

  // Prices traded after a mark, read from a running 1m candle.
  // For candles opened after the mark, the whole range counts. For the
  // candle the mark was set in, only extremes beyond what it had already
  // printed at mark time count, plus the current price.
  function extremesSince(bar, mark) {
    if (!mark || bar.time > mark.time) return { hi: bar.high, lo: bar.low };
    if (bar.time < mark.time) return null;
    const hi = bar.high > mark.high ? bar.high : bar.close;
    const lo = bar.low < mark.low ? bar.low : bar.close;
    return { hi: Math.max(hi, bar.close), lo: Math.min(lo, bar.close) };
  }

  // If one candle covers both levels (only possible when replaying a gap),
  // the stop is assumed to have printed first.
  // With manualClose (a venue with no take-profit orders) the target only
  // counts when the last price is at or through it; a wick that tags it and
  // bounces is reported as a touch. The bust stays wick-based because the
  // venue liquidates on its own.
  function checkExit(plan, ext, close, opts) {
    if (!ext) return null;
    const o = opts || {};
    const hitStop = plan.sgn < 0 ? ext.hi >= plan.stop : ext.lo <= plan.stop;
    const wickTp = plan.sgn < 0 ? ext.lo <= plan.tp : ext.hi >= plan.tp;
    if (hitStop) return { kind: 'stop', price: plan.stop, both: wickTp };
    if (o.noTarget) return null;
    if (plan.manualClose) {
      const lastTp = plan.sgn < 0 ? close <= plan.tp : close >= plan.tp;
      if (lastTp) return { kind: 'target', price: close, both: false };
      if (wickTp) return { kind: 'touch', price: plan.tp, both: false };
      return null;
    }
    if (wickTp) return { kind: 'target', price: plan.tp, both: false };
    return null;
  }

  function checkLimit(side, limit, ext) {
    if (!ext) return false;
    return side === 'short' ? ext.hi >= limit : ext.lo <= limit;
  }

  function markOf(bar) { return { time: bar.time, high: bar.high, low: bar.low }; }

  function newSim(params) {
    return { status: 'idle', params: { ...params }, plan: null, limit: null, mark: null,
      entryTime: null, exit: null, lastBarTime: null, notified: {}, log: [] };
  }

  function enterMarket(sim, bar) {
    sim.plan = computePlan(sim.params, bar.close);
    sim.mark = markOf(bar);
    sim.entryTime = bar.time;
    sim.status = 'open';
    return [{ kind: 'fill', price: bar.close, time: bar.time }];
  }

  function placeLimit(sim, bar, limit) {
    const s = sim.params.side;
    const through = s === 'short' ? bar.close >= limit : bar.close <= limit;
    if (through) return enterMarket(sim, bar);
    sim.limit = limit;
    sim.mark = markOf(bar);
    sim.status = 'pending';
    return [{ kind: 'placed', price: limit, time: bar.time }];
  }

  // Advance the sim with one candle update (live or replayed).
  function step(sim, bar, opts) {
    const out = [];
    if (sim.status === 'pending') {
      const ext = extremesSince(bar, sim.mark);
      if (checkLimit(sim.params.side, sim.limit, ext)) {
        sim.plan = computePlan(sim.params, sim.limit);
        sim.mark = markOf(bar);
        sim.entryTime = bar.time;
        sim.status = 'open';
        sim.limit = null;
        out.push({ kind: 'fill', price: sim.plan.entry, time: bar.time });
      }
    }
    if (sim.status === 'open') {
      const ext = extremesSince(bar, sim.mark);
      const ex = checkExit(sim.plan, ext, bar.close, opts);
      if (ex && ex.kind === 'touch') {
        out.push({ kind: 'touch', price: ex.price, time: bar.time });
      } else if (ex) {
        sim.status = ex.kind === 'target' ? 'won' : 'lost';
        sim.exit = { price: ex.price, time: bar.time, both: ex.both };
        out.push({ kind: ex.kind, price: ex.price, time: bar.time, both: ex.both });
      }
    }
    if (sim.lastBarTime == null || bar.time > sim.lastBarTime) sim.lastBarTime = bar.time;
    return out;
  }

  function crossings(prev, cur, levels) {
    const out = [];
    if (prev == null || cur == null) return out;
    for (const lv of levels) {
      if (prev < lv.price && cur >= lv.price) out.push({ ...lv, dir: 'up' });
      else if (prev > lv.price && cur <= lv.price) out.push({ ...lv, dir: 'down' });
    }
    return out;
  }

  return { computePlan, validate, manualPlan, validateManual, trackPosition, pnl, equity, distances, beyond, probTargetFirst, sigma1m,
    expectedMinutes, extremesSince, checkExit, checkLimit, newSim, enterMarket, placeLimit,
    step, crossings };
})();
if (typeof module !== 'undefined') module.exports = Engine;
