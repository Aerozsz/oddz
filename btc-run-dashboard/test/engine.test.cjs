const assert = require('assert');
const E = require('../public/engine.js');
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

const P = { side: 'short', margin: 3000, leverage: 100, goal: 9000 };

// 1. Levels match the chat plan
const plan = E.computePlan(P, 82907);
near(plan.stop, 83736.07, 0.01);
near(plan.tp, 81248.86, 0.01);
near(plan.notional, 300000);
near(E.pnl(plan, plan.stop), -3000, 1e-6);
near(E.pnl(plan, plan.tp), 6000, 1e-6);
near(E.equity(plan, plan.tp), 9000, 1e-6);
near(E.equity(plan, 90000), 0);

// 2. Probability at entry (log geometry) ~ 33.0%
const p0 = E.probTargetFirst(plan, 82907);
near(p0, Math.log(1.01) / (Math.log(1.01) - Math.log(0.98)), 1e-9);
assert.ok(p0 > 0.329 && p0 < 0.331, 'p0 ' + p0);
assert.strictEqual(E.probTargetFirst(plan, 83800), 0);
assert.strictEqual(E.probTargetFirst(plan, 81000), 1);

// 3. Long mirror
const lp = E.computePlan({ ...P, side: 'long' }, 82907);
near(lp.stop, 82077.93, 0.01);
near(lp.tp, 84565.14, 0.01);

// 4. Validation
assert.deepStrictEqual(E.validate(P), []);
assert.ok(E.validate({ ...P, leverage: 2 }).length === 1);
assert.ok(E.validate({ ...P, goal: 2000 }).length === 1);

// 5. extremesSince on the entry candle
const mark = { time: 600, high: 83000, low: 82800 };
let ext = E.extremesSince({ time: 600, open: 82900, high: 83000, low: 82800, close: 82950 }, mark);
assert.deepStrictEqual(ext, { hi: 82950, lo: 82950 });
ext = E.extremesSince({ time: 600, open: 82900, high: 83100, low: 82800, close: 82990 }, mark);
assert.deepStrictEqual(ext, { hi: 83100, lo: 82990 });
ext = E.extremesSince({ time: 660, open: 82990, high: 83050, low: 82700, close: 82750 }, mark);
assert.deepStrictEqual(ext, { hi: 83050, lo: 82700 });
assert.strictEqual(E.extremesSince({ time: 540, open: 1, high: 1, low: 1, close: 1 }, mark), null);

// 6. Market entry then target
let sim = E.newSim(P);
const b0 = { time: 0, open: 82900, high: 82950, low: 82850, close: 82907 };
E.enterMarket(sim, b0);
assert.strictEqual(sim.status, 'open');
near(sim.plan.entry, 82907);
let ev = E.step(sim, { time: 60, open: 82907, high: 83500, low: 82500, close: 82600 });
assert.deepStrictEqual(ev, []);
ev = E.step(sim, { time: 120, open: 82600, high: 82650, low: 81240, close: 81300 });
assert.strictEqual(ev[0].kind, 'target');
assert.strictEqual(sim.status, 'won');
// Further steps do nothing
assert.deepStrictEqual(E.step(sim, { time: 180, open: 1, high: 99999, low: 1, close: 1 }), []);

// 7. Market entry then stop
sim = E.newSim(P);
E.enterMarket(sim, b0);
ev = E.step(sim, { time: 60, open: 82907, high: 83740, low: 82800, close: 83700 });
assert.strictEqual(ev[0].kind, 'stop');
assert.strictEqual(sim.status, 'lost');
near(sim.exit.price, sim.plan.stop);

// 8. Both levels in one replayed candle: stop assumed first
sim = E.newSim(P);
E.enterMarket(sim, b0);
ev = E.step(sim, { time: 60, open: 82907, high: 84000, low: 81000, close: 82000 });
assert.strictEqual(ev[0].kind, 'stop');
assert.strictEqual(ev[0].both, true);

// 9. Entry candle range printed before entry does not count
sim = E.newSim(P);
E.enterMarket(sim, { time: 0, open: 83000, high: 83800, low: 82800, close: 82907 });
ev = E.step(sim, { time: 0, open: 83000, high: 83800, low: 82800, close: 82920 });
assert.deepStrictEqual(ev, []);
ev = E.step(sim, { time: 0, open: 83000, high: 83801, low: 82800, close: 83801 });
assert.strictEqual(ev[0].kind, 'stop');

// 10. Limit short below market fills at market; above market rests then fills
sim = E.newSim(P);
ev = E.placeLimit(sim, { time: 0, open: 1, high: 82950, low: 82850, close: 82907 }, 82800);
assert.strictEqual(ev[0].kind, 'fill');
near(sim.plan.entry, 82907);
sim = E.newSim(P);
ev = E.placeLimit(sim, { time: 0, open: 1, high: 82950, low: 82850, close: 82907 }, 83200);
assert.strictEqual(sim.status, 'pending');
ev = E.step(sim, { time: 0, open: 1, high: 82950, low: 82850, close: 82930 });
assert.deepStrictEqual(ev, []);
ev = E.step(sim, { time: 60, open: 82930, high: 83210, low: 82900, close: 83150 });
assert.strictEqual(ev[0].kind, 'fill');
near(sim.plan.entry, 83200);
near(sim.plan.stop, 83200 * 1.01, 1e-6);
assert.strictEqual(sim.status, 'open');
// fill candle's earlier high (83210) must not count toward the new stop
ev = E.step(sim, { time: 60, open: 82930, high: 83210, low: 82900, close: 83100 });
assert.deepStrictEqual(ev, []);

// 11. Sigma and expected time
const closes = [];
let px = 82907;
for (let i = 0; i < 121; i++) { closes.push(px); px *= i % 2 ? 1.0005 : 0.9995; }
const s = E.sigma1m(closes);
assert.ok(s > 0.0004 && s < 0.0006, 's ' + s);
const em = E.expectedMinutes(plan, 82907, s);
near(em, (Math.log(1.01) * -Math.log(0.98)) / (s * s), 1e-6);
assert.strictEqual(E.sigma1m([1, 2, 3]), null);

// 12. Crossings
const lv = [{ price: 83000, label: 'ceiling' }, { price: 82600, label: 'origin' }];
assert.deepStrictEqual(E.crossings(82950, 83010, lv).map(x => x.dir + x.price), ['up83000']);
assert.deepStrictEqual(E.crossings(82700, 82590, lv).map(x => x.dir + x.price), ['down82600']);
assert.deepStrictEqual(E.crossings(83100, 82500, lv).map(x => x.dir + x.price), ['down83000', 'down82600']);

console.log('all engine tests passed; p0 =', p0.toFixed(4), 'expected min =', em.toFixed(1));

// 13. Manual plan from the testnet screenshot
const M = { side: 'short', entry: 82709.5, notional: 299900, margin: 2999.44, bust: 83496.8, feeDrag: 124, goal: 9000 };
assert.deepStrictEqual(E.validateManual(M), []);
const mp = E.manualPlan(M);
near(mp.stop, 83496.8);
near(E.pnl(mp, 82538.5), 495.96, 0.2);              // matches the screenshot PnL
near(E.equity(mp, mp.tp), 9000, 1e-6);              // goal net of the fee
near(mp.tp, 81020.4, 0.2);
near(mp.leverage, 99.98, 0.01);
const pm = E.probTargetFirst(mp, 82538.5);
assert.ok(pm > 0.38 && pm < 0.39, 'pm ' + pm);
assert.ok(E.validateManual({ ...M, bust: 82000 }).length === 1);
let ts = E.newSim(M);
E.trackPosition(ts, mp, 1000 * 60 + 25);
assert.strictEqual(ts.status, 'open');
assert.strictEqual(ts.entryTime, 60000);
ev = E.step(ts, { time: 60060, open: 82700, high: 83000, low: 82400, close: 82500 });
assert.deepStrictEqual(ev, []);
ev = E.step(ts, { time: 60120, open: 82500, high: 83497, low: 82450, close: 83400 });
assert.strictEqual(ev[0].kind, 'stop');
console.log('manual plan tests passed; target', mp.tp.toFixed(1), 'P now', pm.toFixed(4));

// 14. Manual close: wick touch is not a fill, last price at/through target is
const mc = E.manualPlan(M); mc.manualClose = true;
let ms2 = E.newSim(M); E.trackPosition(ms2, mc, 60000);
ev = E.step(ms2, { time: 60060, open: 81300, high: 81350, low: 81000, close: 81200 });
assert.strictEqual(ev[0].kind, 'touch'); assert.strictEqual(ms2.status, 'open');
ev = E.step(ms2, { time: 60120, open: 81200, high: 81250, low: 81010, close: 81015 });
assert.strictEqual(ev[0].kind, 'target'); near(ms2.exit.price, 81015); assert.strictEqual(ms2.status, 'won');
// bust stays wick-based
ms2 = E.newSim(M); E.trackPosition(ms2, mc, 60000);
ev = E.step(ms2, { time: 60060, open: 83000, high: 83500, low: 82900, close: 83100 });
assert.strictEqual(ev[0].kind, 'stop');
// noTarget option skips target during replay but still checks bust
ms2 = E.newSim(M); E.trackPosition(ms2, mc, 60000);
assert.deepStrictEqual(E.step(ms2, { time: 60060, open: 81100, high: 81100, low: 80900, close: 80950 }, { noTarget: true }), []);
assert.strictEqual(E.step(ms2, { time: 60120, open: 81100, high: 83600, low: 80900, close: 80950 }, { noTarget: true })[0].kind, 'stop');
console.log('manual close tests passed');
