/**
 * The cascade projection, scored against what price actually did.
 *
 * This is the module that decides whether the panel is allowed to claim
 * anything, so its failure modes are the ones worth pinning: flattering the
 * model by counting a move in the wrong direction as partial success, inflating
 * the sample by re-arming while price hovers, and calibrating off two data
 * points.
 */
import { CascadeOutcomes } from "@/lib/sweep/metrics/cascade-outcomes";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

const T0 = 1_800_000_000_000;
const MIN = 60_000;

/** One complete down-cascade: armed near 99.9, triggers, then travels. */
function runOne(t: CascadeOutcomes, opts: {
  start: number; trigger: number; terminal: number; extreme: number;
  at: number; risk?: number; liq?: number; neverTriggers?: boolean;
}) {
  t.observe("down", opts.start, opts.trigger, opts.terminal, opts.risk ?? 60, opts.at);
  if (opts.neverTriggers) {
    t.price(opts.start, opts.at + 31 * MIN);   // past the arm TTL
    return;
  }
  t.price(opts.trigger, opts.at + MIN);         // trades through
  if (opts.liq) t.liquidation(opts.liq);
  t.price(opts.extreme, opts.at + 2 * MIN);     // travels
  t.price(opts.extreme, opts.at + 12 * MIN);    // past the horizon -> settles
}

console.log("\n## arming");
{
  const t = new CascadeOutcomes();
  t.observe("down", 100, 98, 96, 60, T0);
  t.price(100, T0);
  ok("a level 2% away does not arm", t.read().armed === 0, String(t.read().armed));

  t.observe("down", 100, 99.95, 99, 60, T0);
  t.price(100, T0);
  ok("a level inside the window arms", t.read().armed === 1, String(t.read().armed));

  // Hovering must not manufacture samples.
  for (let i = 0; i < 50; i++) t.observe("down", 100, 99.95, 99, 60, T0 + i * 1000);
  ok("hovering near a level does not re-arm", t.read().armed === 1, String(t.read().armed));

  t.observe("up", 100, 100.05, 101, 60, T0);
  ok("the other direction arms independently", t.read().armed === 2, String(t.read().armed));
}

console.log("\n## reach");
{
  const t = new CascadeOutcomes();
  // Five reach the level, five never do.
  for (let i = 0; i < 5; i++) {
    runOne(t, { start: 100, trigger: 99.95, terminal: 99, extreme: 99.5, at: T0 + i * 60 * MIN });
  }
  for (let i = 0; i < 5; i++) {
    runOne(t, { start: 100, trigger: 99.95, terminal: 99, extreme: 99.5, at: T0 + (i + 10) * 60 * MIN, neverTriggers: true });
  }
  const c = t.read();
  ok("both outcomes settle", c.settled === 10, String(c.settled));
  ok("...and only half are counted as triggered", c.triggered === 5, String(c.triggered));
  ok("but ten samples is still too few to calibrate", !c.warm, c.note);
  ok("...so the factor stays neutral", c.factor === 1, String(c.factor));
}

console.log("\n## travel, once there are enough samples");
{
  const t = new CascadeOutcomes();
  // Projection: trigger 99.95, terminal 99.00 — 0.95 of travel projected.
  // Reality: reaches 99.62 — 0.33 of travel, about 35%.
  for (let i = 0; i < 14; i++) {
    runOne(t, { start: 100, trigger: 99.95, terminal: 99, extreme: 99.62, at: T0 + i * 60 * MIN });
  }
  const c = t.read();
  ok("it warms up", c.warm, c.note);
  ok("everything triggered", c.triggered === 14 && c.reachRate === 1, `${c.triggered} / ${c.reachRate}`);
  ok("the measured travel is about a third", c.travelFactor !== null && Math.abs(c.travelFactor - 0.347) < 0.02,
    c.travelFactor?.toFixed(3));
  ok("...and that is what the projection gets scaled by", Math.abs(c.factor - (c.travelFactor ?? 0)) < 1e-9,
    c.factor.toFixed(3));
  ok("the note states it plainly", c.note.includes("of the projected distance"), c.note);
}

console.log("\n## a move the wrong way is not partial credit");
{
  const t = new CascadeOutcomes();
  for (let i = 0; i < 14; i++) {
    // Projected down to 99, actually rallied to 100.4 after triggering.
    runOne(t, { start: 100, trigger: 99.95, terminal: 99, extreme: 100.4, at: T0 + i * 60 * MIN });
  }
  const c = t.read();
  ok("a reversal scores zero, not a negative or a fraction", c.travelFactor === 0, String(c.travelFactor));
  ok("...and the factor is floored rather than zeroed",
    c.factor >= 0.15 - 1e-9 && c.factor <= 0.15 + 1e-9, c.factor.toFixed(3));
}

console.log("\n## the factor cannot run away");
{
  const t = new CascadeOutcomes();
  for (let i = 0; i < 14; i++) {
    // Wildly overshot every time — 10x the projection.
    runOne(t, { start: 100, trigger: 99.95, terminal: 99.9, extreme: 99.45, at: T0 + i * 60 * MIN });
  }
  const c = t.read();
  ok("an overshoot is measured", (c.travelFactor ?? 0) > 5, c.travelFactor?.toFixed(1));
  ok("...but the applied factor is capped", c.factor <= 1.5 + 1e-9, c.factor.toFixed(2));
}

console.log("\n## liquidations are evidence the level was real");
{
  const t = new CascadeOutcomes();
  for (let i = 0; i < 14; i++) {
    runOne(t, {
      start: 100, trigger: 99.95, terminal: 99, extreme: 99.6,
      at: T0 + i * 60 * MIN, liq: i < 7 ? 50_000 : 0,
    });
  }
  const c = t.read();
  ok("the discharge rate is measured", c.dischargeRate !== null && Math.abs(c.dischargeRate - 0.5) < 1e-9,
    c.dischargeRate?.toFixed(2));
  ok("...and reported alongside the rest", c.note.includes("liquidations printed"), c.note);
}

console.log("\n## the evidence is inspectable");
{
  const t = new CascadeOutcomes();
  for (let i = 0; i < 3; i++) {
    runOne(t, { start: 100, trigger: 99.95, terminal: 99, extreme: 99.6, at: T0 + i * 60 * MIN });
  }
  const rows = t.recent(10);
  ok("settled outcomes are readable", rows.length === 3, String(rows.length));
  ok("...newest first", rows[0].armedAt > rows[2].armedAt);
  ok("...carrying both the projection and what happened",
    rows[0].predictedTerminal === 99 && rows[0].realisedExtreme === 99.6);
}

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
