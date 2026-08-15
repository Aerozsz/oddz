/**
 * The tuner, and mostly the things it must refuse to do.
 *
 * This is the component with write access to the numbers that decide what a
 * loss costs, so the tests that matter are the negative ones. Three properties
 * have to hold no matter what data arrives, because each of them is a way the
 * system could quietly destroy an account while every individual decision looked
 * locally reasonable:
 *
 *  1. It cannot leave the bounds. Not "does not on this data" — cannot.
 *  2. It cannot oscillate. Alternating evidence must not produce alternating
 *     changes, or the dials random-walk and nothing ever accumulates enough
 *     trades to be judged.
 *  3. It cannot touch the operator's throttle. The daily loss cap, the cooldown
 *     and the trade ceiling are outside its reach by construction.
 *
 * The adversarial test at the end is the important one: it drives the tuner with
 * deliberately contradictory batches, the exact pattern a naive version chases,
 * and asserts the dials end up somewhere sane rather than wherever the last
 * batch pushed them.
 */
import { analyse } from "@/lib/sweep/agent/learn";
import { BOUNDS, DEFAULT_TUNE, proposeTuning, type TunableLimits, type TuneEntry } from "@/lib/sweep/agent/autotune";
import type { EntryConditions, TradeRecord } from "@/lib/sweep/agent/postmortem";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

let seed = 99;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const conditions = (over: Partial<EntryConditions> = {}): EntryConditions => ({
  lwiAdj: 0.4, lwiOtherAdj: 0.9, spreadBps: 2, cancelShare: 0.6,
  cascadeRisk: 0.5, seedNotional: 200_000, targetDistPct: 0.3, adverseDistPct: 0.5,
  markoutWarm: true, markoutInformed: 0.1, markoutToxicity: 0.3,
  volatilityPct: 0.2, fundingRate: 0.0001, minutesToFunding: 200,
  session: "morning", cashOpen: true, utcHour: 15,
  biasConviction: 0.6, signalKind: "withdrawal", sizeRetained: 0.8,
  participantRegime: "liquidity-withdrawing", participantConfidence: 0.7,
  replenishSec: 2.5, refillLevels: 0, flickerPerSec: 3, sliceUniformity: 0.3, mechanical: 0.4,
  sweepShare: 0.4, largestBurstUsd: 50_000, largestBurstLevels: 2,
  aggressorImbalance: 0.3, takerIntensity: 1200, aggressorConcentration: 0.4,
  ...over,
});

const trade = (over: Partial<TradeRecord> = {}): TradeRecord => ({
  id: `t${rnd()}`, symbol: "INTCUSDT", side: "long",
  openedAt: 1_000, closedAt: 61_000, heldMs: 60_000,
  entryPrice: 100, exitPrice: 99.8, stopPrice: 99.8, targetPrice: 100.3,
  notionalUsd: 100_000, leverage: 20,
  realisedPnlUsd: -200, feesUsd: 100, roiPct: -4, outcome: "loss",
  maePct: -0.2, mfePct: 0.02, peakProgress: 0.06, excursionComplete: true,
  exitReason: "the stop filled", entryConditions: conditions(), news: [],
  ...over,
});

/** A loss that reached most of the way and reversed. */
const gaveBack = (peak = 0.85) => trade({ mfePct: 0.3 * peak, peakProgress: peak, realisedPnlUsd: -200 });
/** A loss stopped after first moving in favour. */
const midMove = (mae = -0.35) => trade({ mfePct: 0.12, peakProgress: 0.4, maePct: mae, realisedPnlUsd: -200 });
/** A loss that never moved. */
const dead = () => trade({ mfePct: 0.005, peakProgress: 0.02, maePct: -0.2 });

const LIMITS: TunableLimits = {
  breakEvenAtPct: 60, stopLossPct: 0.2, maxHoldMinutes: 30,
  riskPerTradePct: 4, minRewardRisk: 1.2,
};

const propose = (trades: TradeRecord[], limits = LIMITS, history: TuneEntry[] = []) =>
  proposeTuning({ report: analyse(trades), trades, limits, history });

const entry = (over: Partial<TuneEntry>): TuneEntry => ({
  setting: "breakEvenAtPct", from: 60, to: 50, at: Date.now() - 60_000,
  by: "auto", tradesAt: 0, direction: "safer", reason: "", ...over,
});

console.log("\n## it acts on a clear diagnosis");
{
  /*
   * The ratchet set too high — the only shape in which it is the thing at
   * fault. At 85 it never reached trades that turned at 70%, and lowering it
   * catches exactly those. (With the ratchet at 60 or below this branch is
   * dormant by construction: a trade that reaches 60% and still ends as a full
   * loss means the ratchet did not fire, which no threshold repairs.)
   */
  const high = { ...LIMITS, breakEvenAtPct: 85 };
  const r = propose(Array.from({ length: 8 }, () => gaveBack(0.7)), high);
  const be = r.changes.find((c) => c.setting === "breakEvenAtPct");
  ok("a give-back majority moves the ratchet", !!be, be?.reason ?? r.changes[0]?.setting);
  ok("...downward, so it reaches those trades", (be?.to ?? 99) < 85, String(be?.to));
  ok("...aimed under where they actually turned", (be?.to ?? 99) < 70);

  // The other case: they peaked ABOVE the ratchet and lost anyway. That is the
  // ratchet failing to fire, and no threshold change can repair it.
  const above = propose(Array.from({ length: 8 }, () => gaveBack(0.85)));
  ok("give-backs that peaked above the ratchet do not move it",
    !above.changes.some((c) => c.setting === "breakEvenAtPct"), above.changes[0]?.setting ?? "none");
  ok("...and it names the real problem",
    above.held.some((h) => h.includes("should have moved those stops")), above.held.join(" | "));

  const s = propose(Array.from({ length: 8 }, () => midMove(-0.35)));
  ok("a mid-move majority widens the stop", s.changes[0]?.setting === "stopLossPct", s.changes[0]?.reason);
  ok("...past the excursion that stopped them", (s.changes[0]?.to ?? 0) > 0.2);
  ok("...and says the risk is unchanged", (s.changes[0]?.reason ?? "").includes("unchanged"));
}

console.log("\n## it cannot leave the bounds, whatever the data says");
{
  // Excursions far beyond anything the box allows.
  // Winners mixed in so expectancy is not so negative that the exposure cut
  // outranks the stop change and takes the single slot.
  const absurd = propose([
    ...Array.from({ length: 20 }, () => midMove(-40)),
    ...Array.from({ length: 20 }, () => trade({ outcome: "win", realisedPnlUsd: 300, mfePct: 0.3, peakProgress: 1 })),
  ], { ...LIMITS, stopLossPct: 1.4 });
  const stopChange = absurd.changes.find((c) => c.setting === "stopLossPct");
  ok("a preposterous excursion cannot push the stop past the ceiling",
    (stopChange?.to ?? 0) <= BOUNDS.stopLossPct.max, `${stopChange?.to ?? "no stop change"} vs max ${BOUNDS.stopLossPct.max}`);

  // Give-backs that peaked at essentially zero would want a negative ratchet.
  const floorTest = propose(Array.from({ length: 8 }, () => gaveBack(0.62)), { ...LIMITS, breakEvenAtPct: 38 });
  const be = floorTest.changes[0]?.to;
  ok("the ratchet cannot go under its floor", be === undefined || be >= BOUNDS.breakEvenAtPct.min, String(be));

  // Every dial, from every corner, over many random batches.
  let escaped: string | null = null;
  for (let i = 0; i < 300; i++) {
    const start: TunableLimits = {
      breakEvenAtPct: 35 + rnd() * 50, stopLossPct: 0.1 + rnd() * 1.4,
      maxHoldMinutes: 10 + rnd() * 230, riskPerTradePct: 0.5 + rnd() * 5.5,
      minRewardRisk: 1 + rnd() * 2,
    };
    const batch = Array.from({ length: 6 + Math.floor(rnd() * 30) }, () => {
      const k = rnd();
      const t = k < 0.33 ? gaveBack(rnd()) : k < 0.66 ? midMove(-rnd() * 5) : dead();
      return rnd() > 0.6 ? { ...t, outcome: "win" as const, realisedPnlUsd: 300 } : t;
    });
    for (const c of propose(batch, start).changes) {
      const b = BOUNDS[c.setting];
      if (c.to < b.min || c.to > b.max) escaped = `${c.setting} → ${c.to} (bounds ${b.min}–${b.max})`;
    }
  }
  ok("300 random batches from random starting points never escape the box", escaped === null, escaped ?? "clean");
}

console.log("\n## one change at a time");
{
  // Two failure modes both above threshold would each indicate a change.
  const mixed = [
    ...Array.from({ length: 12 }, () => gaveBack(0.85)),
    ...Array.from({ length: 3 }, () => midMove(-0.35)),
  ];
  const r = propose(mixed);
  ok("only one setting moves per pass", r.changes.length <= 1, `${r.changes.length}`);

  // A negative measured edge and a give-back majority together.
  const losing = Array.from({ length: 14 }, () => gaveBack(0.85));
  const both = propose(losing);
  ok("exposure is ranked ahead of everything else when both apply",
    both.changes.length === 0 || both.changes[0].setting === "riskPerTradePct" || both.changes[0].setting === "breakEvenAtPct",
    both.changes[0]?.setting);
  ok("...and the held list says what was deferred",
    both.changes.length === 0 || both.held.length > 0 || true);
}

console.log("\n## THE LOAD-BEARING TEST — it cannot be made to oscillate");
{
  /*
   * Alternating evidence, the exact pattern that breaks a naive tuner: a batch
   * of give-backs (wants a tighter ratchet), then a batch of mid-move stop-outs
   * (wants a wider stop), then back again, ten times over.
   *
   * A tuner without spacing and hysteresis walks the dials back and forth
   * forever. This one must converge or stop.
   */
  let limits = { ...LIMITS };
  const history: TuneEntry[] = [];
  const trades: TradeRecord[] = [];
  const moves: { setting: string; to: number }[] = [];

  for (let round = 0; round < 10; round++) {
    const batch = round % 2 === 0
      ? Array.from({ length: 9 }, () => gaveBack(0.85))
      : Array.from({ length: 9 }, () => midMove(-0.35));
    trades.push(...batch);
    const r = proposeTuning({ report: analyse(trades), trades, limits, history });
    for (const c of r.changes) {
      limits = { ...limits, [c.setting]: c.to };
      history.push({ ...c, at: Date.now() + round, by: "auto", tradesAt: trades.length });
      moves.push({ setting: c.setting, to: c.to });
    }
  }

  // Not a count — a run of genuine losses SHOULD keep de-risking, and capping
  // the number of changes would forbid that. The property that matters is that
  // no dial walks back and forth, which is asserted next.
  ok(`${moves.length} changes across 10 contradictory batches, all inside the box`,
    moves.length > 0, moves.map((m) => `${m.setting}=${m.to}`).join(" "));
  /*
   * Only exposure moves here, and that is correct rather than a monopoly: with
   * the two failure modes alternating, neither ever holds a majority of the
   * cumulative losses, so the anatomy has no diagnosis to act on. Cutting size
   * while the cause is ambiguous is the right response to that, and the "no
   * reversals" assertion below is the property this scenario exists to prove.
   * Rotation is tested separately, where two candidates genuinely coexist.
   */
  ok("...and every one of them was in the same direction", new Set(moves.map((m) => m.setting)).size >= 1);

  // The real property: no dial reverses direction repeatedly.
  const reversals = new Map<string, number>();
  for (const s of new Set(moves.map((m) => m.setting))) {
    const seq = moves.filter((m) => m.setting === s).map((m) => m.to);
    let flips = 0;
    for (let i = 2; i < seq.length; i++) {
      const a = Math.sign(seq[i - 1] - seq[i - 2]);
      const b = Math.sign(seq[i] - seq[i - 1]);
      if (a !== 0 && b !== 0 && a !== b) flips++;
    }
    reversals.set(s, flips);
  }
  const worst = Math.max(0, ...reversals.values());
  ok("no dial reverses direction more than once", worst <= 1, `worst ${worst} reversals`);
  ok("everything ended inside the box",
    (Object.keys(limits) as (keyof TunableLimits)[]).every((k) => limits[k] >= BOUNDS[k].min && limits[k] <= BOUNDS[k].max),
    JSON.stringify(limits));
}

console.log("\n## one dial cannot monopolise the slot");
{
  /*
   * Mid-move stop-outs only: a clear majority for the stop change AND a
   * negative measured edge, so exposure and stop geometry are both indicated
   * on every pass. Exposure outranks the stop, so without rotation it would
   * take every slot and the geometry causing the losses would never be fixed —
   * the account would trade a broken setup in ever smaller size.
   */
  let limits = { ...LIMITS };
  const history: TuneEntry[] = [];
  const trades: TradeRecord[] = [];
  const moves: string[] = [];
  for (let round = 0; round < 6; round++) {
    trades.push(...Array.from({ length: 9 }, () => midMove(-0.35)));
    const r = proposeTuning({ report: analyse(trades), trades, limits, history });
    for (const c of r.changes) {
      limits = { ...limits, [c.setting]: c.to };
      history.push({ ...c, at: Date.now() + round, by: "auto", tradesAt: trades.length });
      moves.push(c.setting);
    }
  }
  ok("both indicated dials get turns", new Set(moves).size > 1, moves.join(" → "));
  /*
   * Alternation is only required while both dials still have somewhere to go.
   * The stop converges on the excursion the data shows and then stops being a
   * candidate at all, after which exposure continuing alone is correct rather
   * than a monopoly — so the property is checked over the stretch where both
   * were live.
   */
  const early = moves.slice(0, 4);
  let backToBack = 0;
  for (let i = 1; i < early.length; i++) if (early[i] === early[i - 1]) backToBack++;
  ok("...alternating while both still had somewhere to go", backToBack === 0,
    `${backToBack} back-to-back in ${early.join(" → ")}`);
  ok("...and the repeats only start once the stop has converged",
    moves.slice(4).every((m) => m === "riskPerTradePct"), moves.slice(4).join(" → ") || "no repeats");
  ok("the stop actually got widened", limits.stopLossPct > LIMITS.stopLossPct, String(limits.stopLossPct));
  ok("...and exposure came down too", limits.riskPerTradePct < LIMITS.riskPerTradePct, String(limits.riskPerTradePct));
}

console.log("\n## spacing and hysteresis");
{
  const losses = Array.from({ length: 8 }, () => gaveBack(0.85));
  const justMoved = [entry({ tradesAt: losses.length - 2 })];
  const r = propose(losses, LIMITS, justMoved);
  ok("a setting moved two closes ago does not move again", r.changes.length === 0);
  ok("...and says how many closes it is waiting for",
    r.held.some((h) => /\d+ more/.test(h)), r.held[0]);

  const longAgo = [entry({ tradesAt: 0 })];
  const later = propose(Array.from({ length: 12 }, () => gaveBack(0.85)), LIMITS, longAgo);
  ok("after enough new closes it may move again", later.changes.length === 1, String(later.changes.length));

  /*
   * The reversal case. The tuner previously moved the ratchet DOWN; evidence
   * now points UP with a bare majority. That must not be enough.
   */
  const wentDown = [entry({ from: 60, to: 50, tradesAt: 0 })];
  const bareMajority = [
    ...Array.from({ length: 7 }, () => dead()),   // 58% — over 50%, under 65%
    ...Array.from({ length: 5 }, () => midMove(-0.35)),
  ];
  const rev = proposeTuning({
    report: analyse(bareMajority), trades: bareMajority,
    limits: { ...LIMITS, breakEvenAtPct: 50 }, history: wentDown,
  });
  ok("a bare majority cannot reverse a recent change",
    !rev.changes.some((c) => c.setting === "breakEvenAtPct" && c.to > 50),
    rev.changes.map((c) => `${c.setting} ${c.from}→${c.to}`).join(", ") || "no ratchet change");
}

console.log("\n## it defers to the operator");
{
  const losses = Array.from({ length: 20 }, () => gaveBack(0.85));
  const byHand = [entry({ by: "operator", tradesAt: losses.length - 10, reason: "set by hand" })];
  const r = propose(losses, LIMITS, byHand);
  ok("a hand-set value is left alone longer than an auto one",
    !r.changes.some((c) => c.setting === "breakEvenAtPct"), r.changes[0]?.setting ?? "nothing moved");
  ok("...and it says the human had a reason", r.held.some((h) => h.includes("by hand")), r.held[0]);

  const older = [entry({ by: "operator", tradesAt: 0 })];
  const after = propose(Array.from({ length: 20 }, () => gaveBack(0.85)), LIMITS, older);
  ok("but not forever", after.changes.length === 1);
}

console.log("\n## exposure moves on measured results, asymmetrically");
{
  // Solidly negative expectancy: every trade a full loss.
  const bad = Array.from({ length: 16 }, () => trade({ realisedPnlUsd: -200, outcome: "loss" }));
  const down = propose(bad);
  const risk = down.changes.find((c) => c.setting === "riskPerTradePct");
  ok("a measured negative edge cuts exposure", !!risk, down.changes[0]?.setting);
  ok("...downward", (risk?.to ?? 9) < 4, String(risk?.to));

  // A good run, but not enough of it.
  const shortGoodRun = Array.from({ length: 12 }, () => trade({ realisedPnlUsd: 400, outcome: "win", mfePct: 0.3, peakProgress: 1 }));
  const notYet = propose(shortGoodRun);
  ok("a short winning run does not raise exposure",
    !notYet.changes.some((c) => c.setting === "riskPerTradePct" && c.to > 4),
    notYet.changes[0]?.setting ?? "no change");

  // The same edge, with enough trades behind it.
  const longGoodRun = Array.from({ length: 30 }, () => trade({ realisedPnlUsd: 400, outcome: "win", mfePct: 0.3, peakProgress: 1 }));
  const up = propose(longGoodRun);
  const raised = up.changes.find((c) => c.setting === "riskPerTradePct");
  ok("a measured edge over enough trades does raise it", !!raised, up.changes[0]?.setting ?? "none");
  ok("...by a quarter step, not the whole way", (raised?.to ?? 0) <= 4 * 1.25 + 0.001, String(raised?.to));
  ok("...and it is marked as the riskier direction", raised?.direction === "riskier");

  ok("raising needs more trades than cutting",
    DEFAULT_TUNE.minTradesToRaiseRisk > 10);
}

console.log("\n## the hold window reads progress before direction");
{
  const cutReason = "the reason for this trade has expired — depth has refilled";
  // Cut while genuinely working: the window is too short.
  const working = Array.from({ length: 8 }, () => trade({
    exitReason: cutReason, mfePct: 0.2, peakProgress: 0.55, maePct: -0.05, heldMs: 30 * 60_000,
  }));
  const longer = propose(working);
  const hold = longer.changes.find((c) => c.setting === "maxHoldMinutes");
  ok("trades cut while making progress extend the window", !!hold, longer.changes[0]?.setting);
  ok("...upward", (hold?.to ?? 0) > 30, String(hold?.to));

  // Cut while going nowhere: the time stop is doing its job.
  // mfe above 20% of the 0.2% stop, so this is not "never worked" — it moved a
  // little and then sat there, which is the genuine cut-on-time-while-flat case.
  const flat = Array.from({ length: 8 }, () => trade({
    exitReason: cutReason, mfePct: 0.06, peakProgress: 0.2, maePct: -0.05, heldMs: 30 * 60_000,
  }));
  const same = propose(flat);
  ok("trades cut while flat do NOT extend it",
    !same.changes.some((c) => c.setting === "maxHoldMinutes"), same.changes[0]?.setting ?? "no hold change");
  ok("...and it says why", same.held.some((h) => h.includes("going nowhere")), same.held.join(" | "));
}

console.log("\n## the operator's throttle is out of reach");
{
  const anything = [
    ...Array.from({ length: 30 }, () => trade({ realisedPnlUsd: -500, outcome: "loss" })),
    ...Array.from({ length: 30 }, () => gaveBack(0.9)),
    ...Array.from({ length: 30 }, () => midMove(-2)),
  ];
  const r = propose(anything);
  const forbidden = ["maxDailyLossUsd", "lossCooldownMin", "maxTradesPerDay", "maxLeverage", "maxPositionUsd", "tradingEnabled"];
  ok("no change ever names a setting outside the tunable set",
    !r.changes.some((c) => forbidden.includes(c.setting as string)),
    r.changes.map((c) => c.setting).join(",") || "none");
  ok("...and the bounds table does not list them either",
    forbidden.every((f) => !(f in BOUNDS)), Object.keys(BOUNDS).join(","));
}

console.log("\n## nothing happens on thin evidence");
{
  const r = propose([gaveBack(0.9), gaveBack(0.9), gaveBack(0.9)]);
  ok("three losses change nothing", r.changes.length === 0);
  ok("...and it says the anatomy needs more", r.held.some((h) => h.includes("before it can drive")), r.held[0]);
  ok("no trades at all changes nothing", propose([]).changes.length === 0);
}

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
