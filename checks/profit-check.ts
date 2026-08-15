/**
 * The profit side, and the two ways it could quietly destroy the edge.
 *
 * A trailing stop that can move away from the position turns a bounded loss
 * into an unbounded one, and it does so at exactly the moment the trade is
 * going wrong. A target that extends on hope rather than on a level never
 * closes at all. Both failures look like patience while they are happening.
 *
 * So the load-bearing assertions here are monotonicity — the stop only ever
 * improves, from any sequence of prices — and that extension requires a named
 * level plus an intact thesis, never one without the other.
 */
import { DEFAULT_PROFIT, profitDecision } from "@/lib/sweep/agent/profit";
import type { AgentState } from "@/lib/sweep/agent/types";
import { NO_EVENT_RISK } from "@/lib/sweep/metrics/events";
import { EMPTY_FUNDING } from "@/lib/sweep/metrics/funding";
import { EMPTY_MARKOUT } from "@/lib/sweep/metrics/markout";
import { WEIGHTS } from "@/lib/sweep/metrics/session";
import type { Cluster } from "@/lib/sweep/types";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

let seed = 4242;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const cluster = (price: number): Cluster => ({
  price, effect: "amplifying", pushes: price > 100 ? "up" : "down", notional: 500_000,
  confidence: 0.7, sources: ["leverage-long"], spent: 0, distPct: Math.abs(price - 100),
});

function state(mark: number, above: number | null = null, below: number | null = null): AgentState {
  return {
    ts: Date.now(), symbol: "INTCUSDT",
    health: { level: "ok", tradeable: true, reasons: [], summary: "live", snapshotAgeMs: 40 },
    session: { cashOpen: true, phase: "regular", msToNext: 3_600_000, nextLabel: "close",
      intraday: "morning", weights: WEIGHTS.morning, msSincePhaseStart: 1_800_000, transitioning: false },
    mid: mark, mark, last: mark, bestBid: mark - 0.01, bestAsk: mark + 0.01,
    liquidity: { lwi: 0.4, lwiBid: 0.4, lwiAsk: 0.4, lwiAdj: 0.4, lwiBidAdj: 0.4, lwiAskAdj: 0.4,
      warm: true, imbalance: 0, spreadBps: 2, bidNotional: 100_000, askNotional: 100_000,
      withdrawnBid: 5_000, withdrawnAsk: 5_000, consumedBid: 5_000, consumedAsk: 5_000, windowSec: 10 },
    cascadeUp: null, cascadeDown: null,
    nearestAbove: above === null ? null : cluster(above),
    nearestBelow: below === null ? null : cluster(below),
    volatilityPct: 0.15, participants: null,
    markout: EMPTY_MARKOUT, funding: EMPTY_FUNDING, events: NO_EVENT_RISK,
    openInterestNotional: 50_000_000, longShortRatio: 1.1, flow: { buy: 1000, sell: 1000 },
  } as unknown as AgentState;
}

/** Entry 100, stop 0.2% (99.8), so 1R = 0.20 in price. Target 100.4 = 2R. */
const BASE = {
  side: "long" as const, entryPrice: 100, initialStopPct: 0.2,
  targetPrice: 100.4, scaledOut: 0, targetRolls: 0, feePct: 0.1, thesisHealth: 0.9,
};
const decide = (over: Record<string, unknown>) =>
  profitDecision({ ...BASE, ...over } as Parameters<typeof profitDecision>[0]);

console.log("\n## the trail waits until the trade has earned it");
{
  // +0.5R: the trade has produced half what it risked. Too early.
  const early = decide({ state: state(100.1), stopPrice: 99.8, highWaterPrice: 100.1 });
  ok("no trail below the arming threshold", early.stopPrice === null, String(early.stopPrice));
  ok("...and it says how far off it is", early.reason.includes("before it arms"), early.reason);

  // +1R exactly.
  const armed = decide({ state: state(100.2), stopPrice: 99.8, highWaterPrice: 100.2 });
  ok("at 1R the trail arms", armed.stopPrice !== null, armed.reason);
  ok("...and improves on the original stop", (armed.stopPrice ?? 0) > 99.8, String(armed.stopPrice));
  ok("...but stays below mark, so it cannot fill instantly", (armed.stopPrice ?? 0) < 100.2);
}

console.log("\n## it follows the high-water mark, not the current price");
{
  // Ran to 100.6 (+3R) then eased to 100.55. Both decisions see the same mark;
  // only the remembered peak differs, which is the whole point.
  const remembers = decide({ state: state(100.55), stopPrice: 100.0, highWaterPrice: 100.6 });
  const forgets = decide({ state: state(100.55), stopPrice: 100.0, highWaterPrice: 100.55 });
  ok("the trail is set from the peak, not the current price", remembers.stopPrice !== null, remembers.reason);
  ok("...and a remembered peak protects more than the price alone would",
    (remembers.stopPrice ?? 0) > (forgets.stopPrice ?? 0),
    `${remembers.stopPrice} vs ${forgets.stopPrice}`);

  /*
   * The deep-pullback case, which must refuse rather than improvise: the peak
   * says the trail belongs at 100.5, but price is already back at 100.25, so
   * placing it there would fill instantly at market.
   */
  const deep = decide({ state: state(100.25), stopPrice: 100.0, highWaterPrice: 100.6 });
  ok("a trail that would sit the wrong side of mark is not placed", deep.stopPrice === null, String(deep.stopPrice));
  ok("...and says so rather than silently doing nothing",
    deep.notes.some((n) => n.includes("wrong side of mark")), deep.notes.join(" | "));
}

console.log("\n## it tightens as the move extends");
{
  const at1 = decide({ state: state(100.2), stopPrice: 99.8, highWaterPrice: 100.2 });
  const at3 = decide({ state: state(100.6), stopPrice: 99.8, highWaterPrice: 100.6 });
  const gap1 = 100.2 - (at1.stopPrice ?? 0);
  const gap3 = 100.6 - (at3.stopPrice ?? 0);
  ok("the trail distance narrows as R grows", gap3 < gap1, `${gap1.toFixed(4)} → ${gap3.toFixed(4)}`);
  ok("...but never below its floor",
    gap3 >= 100 * (BASE.initialStopPct / 100) * DEFAULT_PROFIT.trailMinMultiple - 1e-9,
    gap3.toFixed(4));

  // Far beyond the tightening point, it must not keep closing in.
  const at10 = decide({ state: state(102), stopPrice: 101, highWaterPrice: 102 });
  const gap10 = 102 - (at10.stopPrice ?? 0);
  ok("the floor holds at extreme R", Math.abs(gap10 - gap3) < 1e-9, `${gap10.toFixed(4)} vs ${gap3.toFixed(4)}`);
}

console.log("\n## THE LOAD-BEARING TEST — the stop can never move away");
{
  /*
   * A random walk with the trail applied at every step, both directions. If any
   * sequence of prices can loosen the stop, the bounded loss this whole system
   * depends on is not bounded.
   */
  let loosened: string | null = null;
  for (let run = 0; run < 200 && !loosened; run++) {
    for (const long of [true, false]) {
      let stop = long ? 99.8 : 100.2;
      let peak = 100;
      let price = 100;
      for (let step = 0; step < 60; step++) {
        price += (rnd() - 0.45) * 0.15 * (long ? 1 : -1);
        peak = long ? Math.max(peak, price) : Math.min(peak, price);
        const d = profitDecision({
          ...BASE,
          side: long ? "long" : "short",
          targetPrice: long ? 100.4 : 99.6,
          state: state(price),
          stopPrice: stop,
          highWaterPrice: peak,
        } as Parameters<typeof profitDecision>[0]);
        if (d.stopPrice !== null) {
          const worse = long ? d.stopPrice < stop : d.stopPrice > stop;
          if (worse) { loosened = `${long ? "long" : "short"}: ${stop} → ${d.stopPrice}`; break; }
          // It also must never be placed the wrong side of the mark.
          const wrongSide = long ? d.stopPrice >= price : d.stopPrice <= price;
          if (wrongSide) { loosened = `${long ? "long" : "short"}: stop ${d.stopPrice} vs mark ${price}`; break; }
          stop = d.stopPrice;
        }
      }
    }
  }
  ok("400 random walks, long and short, never loosen the stop", loosened === null, loosened ?? "clean");
}

console.log("\n## scaling out happens once, and only when the fee is worth paying");
{
  // 100.3 is 1.5R and banks 0.30% against a 0.10% round trip.
  const at = decide({ state: state(100.3), stopPrice: 100, highWaterPrice: 100.3 });
  ok("at 1.5R part of the position comes off", at.scaleOutFraction > 0, at.reason);
  ok("...a fraction, never the whole thing", at.scaleOutFraction > 0 && at.scaleOutFraction <= 0.9, String(at.scaleOutFraction));
  // The move sizes this strategy actually produces must clear the gate.
  const realWorld = decide({
    state: state(100.2), stopPrice: 100, highWaterPrice: 100.2,
    config: { scaleOutAtR: 1 }, feePct: 0.1,
  });
  ok("a 0.20% winner — the size this strategy really makes — clears the fee gate",
    realWorld.scaleOutFraction > 0, realWorld.notes.join(" | "));

  const already = decide({ state: state(100.5), stopPrice: 100, highWaterPrice: 100.5, scaledOut: 0.4 });
  ok("it does not fire twice", already.scaleOutFraction === 0, String(already.scaleOutFraction));

  const tooEarly = decide({ state: state(100.2), stopPrice: 99.9, highWaterPrice: 100.2 });
  ok("nothing comes off below the threshold", tooEarly.scaleOutFraction === 0);

  // A move worth less than a few round trips is not worth an extra exit.
  const expensive = decide({ state: state(100.3), stopPrice: 100, highWaterPrice: 100.3, feePct: 0.4 });
  ok("a fee larger than the move blocks the partial exit", expensive.scaleOutFraction === 0, expensive.notes.join(" | "));
  ok("...and says the arithmetic that blocked it",
    expensive.notes.some((n) => n.includes("too close to the")), expensive.notes.join(" | "));

  const disabled = decide({ state: state(100.3), stopPrice: 100, highWaterPrice: 100.3, config: { scaleOutAtR: 0 } });
  ok("it can be switched off entirely", disabled.scaleOutFraction === 0);
}

console.log("\n## the target extends only to a real level, with the thesis intact");
{
  // Arrived at the 100.4 target, another cluster at 100.9, book still good.
  const roll = decide({ state: state(100.38, 100.9), stopPrice: 100.2, highWaterPrice: 100.38 });
  ok("a further cluster with a healthy thesis rolls the target", roll.targetPrice === 100.9, String(roll.targetPrice));

  const dying = decide({ state: state(100.38, 100.9), stopPrice: 100.2, highWaterPrice: 100.38, thesisHealth: 0.4 });
  ok("a dying thesis takes the planned target instead", dying.targetPrice === null, String(dying.targetPrice));
  ok("...and says why", dying.notes.some((n) => n.includes("intact")), dying.notes.join(" | "));

  // Nothing beyond: hope is not a level.
  const nothing = decide({ state: state(100.38, null), stopPrice: 100.2, highWaterPrice: 100.38 });
  ok("with no level beyond, the target stands", nothing.targetPrice === null);

  // A "further" cluster that is actually nearer than the current target.
  const backwards = decide({ state: state(100.38, 100.2), stopPrice: 100.1, highWaterPrice: 100.38 });
  ok("a nearer cluster never becomes the new target", backwards.targetPrice === null, String(backwards.targetPrice));

  // Not yet arrived — extension is a decision made on approach, not early.
  const midway = decide({ state: state(100.15, 100.9), stopPrice: 99.9, highWaterPrice: 100.15 });
  ok("the target is not rolled halfway there", midway.targetPrice === null, String(midway.targetPrice));
}

console.log("\n## shorts are the mirror, not an afterthought");
{
  const short = {
    ...BASE, side: "short" as const, entryPrice: 100, targetPrice: 99.6,
  };
  const armed = profitDecision({ ...short, state: state(99.8), stopPrice: 100.2, highWaterPrice: 99.8 } as Parameters<typeof profitDecision>[0]);
  ok("a short trails downward", (armed.stopPrice ?? 999) < 100.2, String(armed.stopPrice));
  ok("...staying above mark", (armed.stopPrice ?? 0) > 99.8);

  const roll = profitDecision({ ...short, state: state(99.62, null, 99.1), stopPrice: 99.9, highWaterPrice: 99.62 } as Parameters<typeof profitDecision>[0]);
  ok("a short extends to a lower cluster", roll.targetPrice === 99.1, String(roll.targetPrice));

  const backwards = profitDecision({ ...short, state: state(99.62, null, 99.8), stopPrice: 99.9, highWaterPrice: 99.62 } as Parameters<typeof profitDecision>[0]);
  ok("...but never to a higher one", backwards.targetPrice === null, String(backwards.targetPrice));
}

console.log("\n## degenerate inputs do not produce orders");
{
  const noRisk = decide({ state: state(100.2), stopPrice: 99.8, highWaterPrice: 100.2, initialStopPct: 0 });
  ok("a zero stop distance produces nothing", noRisk.stopPrice === null && noRisk.scaleOutFraction === 0, noRisk.reason);

  const noEntry = decide({ state: state(100.2), stopPrice: 99.8, highWaterPrice: 100.2, entryPrice: 0 });
  ok("a zero entry produces nothing", noEntry.stopPrice === null);

  const underwater = decide({ state: state(99.9), stopPrice: 99.8, highWaterPrice: 99.9 });
  ok("a losing position is left entirely to its stop",
    underwater.stopPrice === null && underwater.scaleOutFraction === 0 && underwater.targetPrice === null,
    underwater.reason);

  const noTarget = decide({ state: state(100.4), stopPrice: 100, highWaterPrice: 100.4, targetPrice: null });
  ok("no target still allows the trail", noTarget.stopPrice !== null, noTarget.reason);
  ok("...and rolls nothing", noTarget.targetPrice === null);
}

console.log("\n## THE RUNAWAY — a target must never retreat forever");
{
  /*
   * The bug this exists to prevent, reproduced as it actually happened: a
   * position grinding upward, with a cluster always sitting further out. Each
   * roll looked justified on its own, so the target moved away every time price
   * came near it and the position could not close in profit however far it ran.
   *
   * Simulated over a long trend, counting how many times the target moves. The
   * position must end up with a target it can actually reach.
   */
  let price = 100;
  let target = 100.4;
  let rolls = 0;
  let peak = 100;
  for (let step = 0; step < 400; step++) {
    price += 0.01;                       // a steady grind up, no retracement
    peak = Math.max(peak, price);
    // There is always another cluster ahead — the condition that made this run.
    const d = profitDecision({
      ...BASE, state: state(price, price + 0.5), targetPrice: target,
      stopPrice: price - 0.3, highWaterPrice: peak, targetRolls: rolls,
    } as Parameters<typeof profitDecision>[0]);
    if (d.targetPrice !== null) { target = d.targetPrice; rolls++; }
  }
  ok("the target stops moving after its cap", rolls <= DEFAULT_PROFIT.maxTargetRolls,
    `${rolls} rolls over 400 sweeps`);
  ok("...so price eventually overtakes it and the trade can close",
    price > target, `price ${price.toFixed(2)} vs target ${target.toFixed(2)}`);
  ok("...and it says why it stopped rolling",
    profitDecision({ ...BASE, state: state(price, price + 0.5), targetPrice: target,
      stopPrice: price - 0.3, highWaterPrice: peak, targetRolls: DEFAULT_PROFIT.maxTargetRolls,
    } as Parameters<typeof profitDecision>[0]).notes.some((n) => n.includes("already been rolled")), "");

  // Rolling with no trail armed would remove the only profit exit.
  const noTrail = profitDecision({
    // 92% of the way to a near target, so it has "arrived", but only 0.28R —
    // the trail is nowhere near armed.
    ...BASE, state: state(100.055, 101), targetPrice: 100.06,
    stopPrice: 99.8, highWaterPrice: 100.055, targetRolls: 0,
  } as Parameters<typeof profitDecision>[0]);
  ok("no roll before the trail has armed", noTrail.targetPrice === null, String(noTrail.targetPrice));
  ok("...and it names that reason", noTrail.notes.some((n) => n.includes("trail has not armed")), noTrail.notes.join(" | "));

  // A cluster absurdly far away cannot be adopted in one jump.
  const farAway = profitDecision({
    ...BASE, state: state(100.38, 140), targetPrice: 100.4,
    stopPrice: 100.2, highWaterPrice: 100.38, targetRolls: 0,
  } as Parameters<typeof profitDecision>[0]);
  ok("a distant cluster is refused by the R ceiling", farAway.targetPrice === null, String(farAway.targetPrice));
}

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
