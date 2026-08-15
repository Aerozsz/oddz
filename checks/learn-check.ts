/**
 * The learning loop, and specifically its refusals.
 *
 * The easy half — does it compute a win rate — is not where this breaks. It
 * breaks by finding things. Twenty conditions split at their medians is forty
 * comparisons, and at the conventional threshold two of those come back
 * "significant" on noise alone, every single run, by arithmetic. A loop that
 * acts on those is not learning, and it will produce a confident story each
 * time it does it.
 *
 * So the load-bearing test here is the noise one: random outcomes, every field
 * randomised, must yield zero actionable findings. If that test ever passes
 * something through, the panel is manufacturing parameters out of nothing.
 */
import {
  analyse, classifyLoss, familyZ, lossAnatomy, meanCi, rMultiple, recommendations, splits, wilson,
} from "@/lib/sweep/agent/learn";
import type { EntryConditions, TradeRecord } from "@/lib/sweep/agent/postmortem";
import { ParticipantTracker } from "@/lib/sweep/metrics/participants";
import { appendTrade, loadTrades } from "@/lib/sweep/metrics/trade-log";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

/* A deterministic generator, so a red run is reproducible. */
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function conditions(over: Partial<EntryConditions> = {}): EntryConditions {
  return {
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
  };
}

function trade(over: Partial<TradeRecord> = {}): TradeRecord {
  const entryPrice = 100;
  return {
    id: `t${rnd()}`, symbol: "INTCUSDT", side: "long",
    openedAt: 1_000, closedAt: 61_000, heldMs: 60_000,
    entryPrice, exitPrice: 99.8, stopPrice: 99.5, targetPrice: 100.3,
    notionalUsd: 100_000, leverage: 20,
    realisedPnlUsd: -200, feesUsd: 100, roiPct: -4, outcome: "loss",
    maePct: -0.5, mfePct: 0.05, peakProgress: 0.17, excursionComplete: true,
    exitReason: "the stop filled", entryConditions: conditions(), news: [],
    ...over,
  };
}

console.log("\n## intervals behave at the counts this will actually see");
{
  const [lo, hi] = wilson(3, 3);
  ok("three wins from three is not reported as certainty", hi >= 0.99 && lo < 0.5, `${lo.toFixed(2)}–${hi.toFixed(2)}`);
  const [lo0] = wilson(0, 4);
  ok("zero wins from four does not report a negative lower bound", lo0 >= 0);
  const wide = wilson(10, 20)[1] - wilson(10, 20)[0];
  const narrow = wilson(100, 200)[1] - wilson(100, 200)[0];
  ok("the interval narrows as the sample grows", narrow < wide / 2, `${wide.toFixed(2)} → ${narrow.toFixed(2)}`);

  ok("a single observation has no usable mean interval", !Number.isFinite(meanCi([1.5]).lo));
  ok("the family correction widens with the number of tests", familyZ(20) > familyZ(1), `${familyZ(1).toFixed(2)} → ${familyZ(20).toFixed(2)}`);
  ok("...and familyZ(1) is the ordinary 1.96", Math.abs(familyZ(1) - 1.96) < 0.02, familyZ(1).toFixed(3));
}

console.log("\n## the result is expressed against the risk taken, not in dollars");
{
  // Same dollars, ten times the size. These are not the same event.
  const small = trade({ notionalUsd: 10_000, realisedPnlUsd: 300 });
  const big = trade({ notionalUsd: 100_000, realisedPnlUsd: 300 });
  const rs = rMultiple(small)!, rb = rMultiple(big)!;
  ok("a fixed profit on a small position is a bigger result", rs > rb * 5, `${rs.toFixed(2)}R vs ${rb.toFixed(2)}R`);
  ok("...and the stop distance sets the denominator", Math.abs(rs - 300 / (0.005 * 10_000)) < 0.01);
  ok("a trade with no settlement has no R", rMultiple(trade({ realisedPnlUsd: null })) === null);
}

console.log("\n## the four failures are told apart");
{
  const gave = trade({ mfePct: 0.28, peakProgress: 0.93, maePct: -0.5 });
  ok("a trade that reached 93% and lost is an exit problem", classifyLoss(gave).kind === "gave-it-back");

  const never = trade({ mfePct: 0.02, peakProgress: 0.07 });
  ok("a trade that never moved is an entry problem", classifyLoss(never).kind === "never-worked");

  const mid = trade({ mfePct: 0.2, peakProgress: 0.4, maePct: -0.5 });
  ok("a trade stopped after moving in favour is a geometry problem", classifyLoss(mid).kind === "stopped-mid-move");

  const cut = trade({ mfePct: 0.15, peakProgress: 0.3, maePct: -0.2, exitReason: "the reason for this trade has expired — depth has refilled" });
  ok("a trade closed by the hold engine is its own class", classifyLoss(cut).kind === "cut-on-time");

  // The asymmetry that a restart forces.
  const partialLow = trade({ mfePct: 0.02, peakProgress: 0.07, excursionComplete: false });
  ok("an unwatched stretch is never read as a motionless one", classifyLoss(partialLow).kind === "unclassified");
  const partialHigh = trade({ mfePct: 0.28, peakProgress: 0.93, excursionComplete: false });
  ok("...but an excursion that was observed still counts", classifyLoss(partialHigh).kind === "gave-it-back");
}

console.log("\n## the anatomy is ranked by what it cost, not by how often it happened");
{
  const many = Array.from({ length: 6 }, () => trade({ mfePct: 0.02, peakProgress: 0.05, realisedPnlUsd: -20 }));
  const few = Array.from({ length: 2 }, () => trade({ mfePct: 0.28, peakProgress: 0.9, realisedPnlUsd: -400 }));
  const a = lossAnatomy([...many, ...few]);
  ok("the expensive failure leads even when it is rarer", a[0].kind === "gave-it-back", `${a[0].kind} at $${a[0].costUsd}`);
  ok("...and the shares still sum to the whole", Math.abs(a.reduce((s, x) => s + x.share, 0) - 1) < 1e-9);
  ok("every class carries a fix", a.every((x) => x.prescription.length > 40));
}

console.log("\n## THE LOAD-BEARING TEST — noise produces no findings");
{
  /*
   * Forty trades, outcome decided by a coin, every condition randomised
   * independently of it. There is nothing to find here by construction, so
   * anything reported as decisive is manufactured.
   */
  const noise: TradeRecord[] = [];
  for (let i = 0; i < 40; i++) {
    const won = rnd() > 0.5;
    noise.push(trade({
      outcome: won ? "win" : "loss",
      realisedPnlUsd: won ? 200 : -200,
      mfePct: rnd() * 0.4, peakProgress: rnd(),
      entryConditions: conditions({
        lwiAdj: rnd(), spreadBps: rnd() * 5, cancelShare: rnd(), cascadeRisk: rnd(),
        targetDistPct: rnd(), adverseDistPct: rnd(), volatilityPct: rnd(),
        replenishSec: rnd() * 5, sliceUniformity: rnd(), mechanical: rnd(),
        sweepShare: rnd(), largestBurstUsd: rnd() * 200_000, aggressorImbalance: rnd() * 2 - 1,
        takerIntensity: rnd() * 3000, aggressorConcentration: rnd(),
        utcHour: Math.floor(rnd() * 24), biasConviction: rnd(), sizeRetained: rnd(),
        participantRegime: rnd() > 0.5 ? "liquidity-present" : "liquidity-withdrawing",
        session: rnd() > 0.5 ? "morning" : "afternoon",
      }),
    }));
  }
  const r = analyse(noise);
  ok(`${r.splits.length} conditions were compared`, r.splits.length > 5, "enough tests to expect false positives");
  ok("NONE of them is reported as actionable", r.actionable.length === 0,
    r.actionable.map((s) => s.label).join(", ") || "clean");
  ok("...and the report says so in words", r.caveats.some((c) => c.includes("none of them separated")));
  ok("the sample size is called out as too small", r.caveats.some((c) => c.includes("too few")));
}

console.log("\n## a real difference is still found");
{
  /*
   * The mirror of the test above: if the guard were simply "never conclude
   * anything", it would pass that one and be useless. Here the condition
   * genuinely determines the outcome, with a sample large enough to prove it.
   */
  const real: TradeRecord[] = [];
  for (let i = 0; i < 120; i++) {
    const swept = i % 2 === 0;
    // Sweeping books win most of the time; drifting ones mostly lose.
    const won = swept ? rnd() > 0.2 : rnd() > 0.85;
    real.push(trade({
      outcome: won ? "win" : "loss",
      realisedPnlUsd: won ? 400 : -200,
      entryConditions: conditions({ sweepShare: swept ? 0.75 + rnd() * 0.2 : rnd() * 0.2 }),
    }));
  }
  const r = analyse(real);
  const found = r.actionable.find((s) => s.field === "sweepShare");
  ok("a condition that really does separate the trades is found", !!found, found?.note ?? "not found");
  ok("...and it is the strongest one", r.splits[0].field === "sweepShare", r.splits[0].field);
  const best = found?.arms.reduce((a, b) => (a.r.mean > b.r.mean ? a : b));
  ok("...pointing at the right side of the split", (best?.label ?? "").startsWith(">"), best?.label);
}

console.log("\n## a thin arm is dropped rather than shown with a caveat");
{
  const lopsided = [
    ...Array.from({ length: 30 }, () => trade({ entryConditions: conditions({ spreadBps: 1 }) })),
    ...Array.from({ length: 2 }, () => trade({ entryConditions: conditions({ spreadBps: 90 }) })),
  ];
  const s = splits(lopsided).find((x) => x.field === "spreadBps");
  ok("a two-trade arm is not put next to a thirty-trade one", !s, s ? `${s.arms.map((a) => a.n)}` : "dropped");
}

console.log("\n## recommendations require a clear majority and never apply themselves");
{
  const nowLimits = { breakEvenAtPct: 60, stopLossPct: 0.2, maxHoldMinutes: 30, riskPerTradePct: 4 };

  const gaveBack = analyse(Array.from({ length: 8 }, () => trade({ mfePct: 0.28, peakProgress: 0.9, realisedPnlUsd: -300 })));
  const r1 = recommendations(gaveBack, nowLimits);
  ok("a clear give-back problem produces a ratchet change", r1[0]?.setting === "Break-even at", r1[0]?.why);
  ok("...that only ever moves the ratchet earlier", (r1[0]?.suggested ?? 0) < nowLimits.breakEvenAtPct);

  const tight = analyse(Array.from({ length: 8 }, () => trade({ mfePct: 0.2, peakProgress: 0.4, maePct: -0.5, realisedPnlUsd: -300 })));
  const r2 = recommendations(tight, nowLimits);
  ok("a stop inside the noise produces a wider stop", r2[0]?.setting === "Stop distance", r2[0]?.why);
  ok("...widened, not tightened", (r2[0]?.suggested ?? 0) > nowLimits.stopLossPct);

  // Two failure modes with opposite fixes, evenly split: the honest answer is
  // to change nothing until they separate.
  const mixed = analyse([
    ...Array.from({ length: 4 }, () => trade({ mfePct: 0.28, peakProgress: 0.9, realisedPnlUsd: -300 })),
    ...Array.from({ length: 4 }, () => trade({ mfePct: 0.2, peakProgress: 0.4, maePct: -0.5, realisedPnlUsd: -300 })),
  ]);
  ok("an evenly split diagnosis recommends nothing", recommendations(mixed, nowLimits).length === 0);

  const thin = analyse([trade(), trade()]);
  ok("two trades recommend nothing", recommendations(thin, nowLimits).length === 0);
}

console.log("\n## a scratch is not a win");
{
  const r = analyse([
    trade({ outcome: "scratch", realisedPnlUsd: 3 }),
    trade({ outcome: "win", realisedPnlUsd: 300 }),
    trade({ outcome: "loss", realisedPnlUsd: -300 }),
  ]);
  ok("a fee-sized result does not count toward the hit rate", Math.abs(r.winRate - 1 / 3) < 1e-9, `${(r.winRate * 100).toFixed(0)}%`);
}

console.log("\n## instant orders are recovered from the prints they arrive as");
{
  const t = new ParticipantTracker();
  const base = Date.now();
  // One marketable buy walking four levels: four prints, milliseconds apart.
  const sweep = [
    { t: base, price: 100.00, qty: 100, notional: 10_000, buyerIsMaker: false },
    { t: base + 3, price: 100.01, qty: 100, notional: 10_001, buyerIsMaker: false },
    { t: base + 7, price: 100.02, qty: 100, notional: 10_002, buyerIsMaker: false },
    { t: base + 11, price: 100.03, qty: 100, notional: 10_003, buyerIsMaker: false },
  ];
  // Then a slow drip of the same total, one per second, all at one price.
  const drip = Array.from({ length: 20 }, (_, i) => ({
    t: base + 2_000 + i * 1_000, price: 100.0, qty: 20, notional: 2_000, buyerIsMaker: true,
  }));
  for (const x of [...sweep, ...drip]) t.onTrade(x, x.t);
  const a = t.read(base + 25_000).aggressor;

  ok("the four prints are recovered as one order", a.largestBurstLevels === 4, `${a.largestBurstLevels} levels`);
  ok("...at its true size", Math.abs(a.largestBurstUsd - 40_006) < 1, `$${a.largestBurstUsd}`);
  ok("...and the drip is not merged into it", a.burstsPerMin > 0 && a.largestBurstUsd < 45_000);
  ok("the sweep share reflects what walked the book", a.sweepShare > 0.4 && a.sweepShare < 0.6, a.sweepShare.toFixed(2));
  // Equal notional each way, so the imbalance is ~0 despite the buying being
  // one order and the selling twenty. Imbalance measures volume, not structure;
  // sweepShare is the field that carries the structure.
  ok("equal notional both ways nets to no imbalance", Math.abs(a.aggressorImbalance) < 0.01, a.aggressorImbalance.toFixed(4));

  const oneSided = new ParticipantTracker();
  for (let i = 0; i < 20; i++) {
    const row = { t: base + i * 500, price: 100 + i * 0.01, qty: 10, notional: 1_000, buyerIsMaker: i < 3 };
    oneSided.onTrade(row, row.t);
  }
  const os = oneSided.read(base + 12_000).aggressor;
  ok("...and lopsided buying reports as positive", os.aggressorImbalance > 0.5, os.aggressorImbalance.toFixed(2));

  // A quiet tape must not report a sweep.
  const q = new ParticipantTracker();
  for (let i = 0; i < 20; i++) {
    const row = { t: base + i * 2_000, price: 100 + i * 0.01, qty: 1, notional: 100, buyerIsMaker: i % 2 === 0 };
    q.onTrade(row, row.t);
  }
  const qa = q.read(base + 41_000).aggressor;
  ok("evenly spaced small prints produce no sweeps", qa.sweepShare === 0, qa.notes[0]);
}

console.log("\n## the log survives being written badly");
{
  const dir = mkdtempSync(join(tmpdir(), "learn-"));
  const path = join(dir, "trades.jsonl");
  appendTrade(trade({ id: "a" }), path);
  appendTrade(trade({ id: "b" }), path);
  ok("what was written comes back", loadTrades(path).records.length === 2);

  // A crash mid-append leaves a torn last line.
  writeFileSync(path, `${JSON.stringify(trade({ id: "a" }))}\n{"id":"torn","symb`, { flag: "w" });
  const torn = loadTrades(path);
  ok("a torn last line costs one row, not the file", torn.records.length === 1);
  ok("...and is reported rather than hidden", torn.skipped === 1);

  // A row with no conditions cannot be grouped, so it must not be counted.
  writeFileSync(path, `${JSON.stringify({ id: "x", outcome: "loss" })}\n`, { flag: "w" });
  ok("an ungroupable row is dropped, not counted", loadTrades(path).records.length === 0);

  ok("a missing file is not an error", loadTrades(join(dir, "nope.jsonl")).records.length === 0);
}

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
