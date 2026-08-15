/**
 * A record with no entry price must not be diagnosed as a patience problem.
 *
 * `entryPrice` was 0 on 25 of 27 live records, because a market order's
 * immediate response carries avgPrice 0 and the journal wrote it down as-is.
 * Both the diagnostic branches of `classifyLoss` are guarded on a stop distance
 * that cannot be computed without it, so control fell through to the time-exit
 * branch and 21 of 23 losses were filed as `cut-on-time` — prescription: "a
 * patience problem", fixed by holding longer. The trades were dying at entry.
 *
 * `rMultiple` has the same guard, which is why expectancy was reported over 2
 * trades while the win rate was reported over 27, in the same object.
 */

import { classifyLoss, rMultiple } from "../lib/sweep/agent/learn";
import type { TradeRecord } from "../lib/sweep/agent/postmortem";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`  ok — ${name}`);
  }
};

/** A real losing trade, closed by the hold engine, with fields overridable. */
function trade(over: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: "t", symbol: "BTCUSDT", source: "live", side: "long",
    openedAt: 0, closedAt: 1_800_000, heldMs: 1_800_000,
    entryPrice: 64_320, exitPrice: 64_300, stopPrice: 63_999, targetPrice: 65_000,
    notionalUsd: 10_840, leverage: 5,
    realisedPnlUsd: -12.86, feesUsd: 7.6, roiPct: -0.6, outcome: "loss",
    maePct: -0.068, mfePct: 0.0, peakProgress: 0.0, excursionComplete: true,
    // The real string, verbatim: the time-exit test matches on "has not started",
    // so a truncated paraphrase silently takes a different branch.
    exitReason:
      "30 min in and only -1% of the way to target — this mechanism works quickly " +
      "when it works, and this one has not started",
    entryConditions: {} as TradeRecord["entryConditions"],
    news: [],
    ...over,
  };
}

function withoutEntryPrice() {
  const broken = classifyLoss(trade({ entryPrice: 0 }));
  ok(
    "a record with no entry price is not called a patience problem",
    broken.kind !== "cut-on-time",
    `classified as ${broken.kind}`,
  );
  ok("it is called unclassified", broken.kind === "unclassified", broken.kind);
  ok(
    "and it names the missing field rather than guessing",
    /no stop distance/.test(broken.detail),
    broken.detail,
  );
  ok("R is unavailable, not zero", rMultiple(trade({ entryPrice: 0 })) === null);
}

function withEntryPrice() {
  /*
   * The same trade, with the price the exchange reported. The stop sat 0.50%
   * away and the best it ever got was 0.0%, so it never started — an entry
   * problem, which is the opposite prescription to the one it was getting.
   */
  const t = trade();
  const real = classifyLoss(t);
  ok("with the entry price it is diagnosed as an entry problem", real.kind === "never-worked", real.kind);
  ok("and quotes the stop it is measured against", /0\.50% stop/.test(real.detail), real.detail);

  const r = rMultiple(t);
  ok("R is computable", r !== null, String(r));
  // risk = 0.4995% of $10,840 = $54.15; -12.86 / 54.15 = -0.238
  ok("and correct", r !== null && Math.abs(r + 0.2375) < 0.01, String(r));
}

function stillClassifiesRealTimeExits() {
  /*
   * A trade that did move — past a fifth of the stop distance — and was then
   * closed by the clock is a genuine cut-on-time. The branch must survive.
   */
  const moved = classifyLoss(trade({ mfePct: 0.3, peakProgress: 0.3 }));
  ok("a trade that moved and was then cut on time still reads that way", moved.kind === "cut-on-time", moved.kind);

  const gaveBack = classifyLoss(trade({ mfePct: 0.738, peakProgress: 0.69 }));
  ok("and a give-back is still a give-back", gaveBack.kind === "gave-it-back", gaveBack.kind);
}

console.log("loss classification without an entry price");
withoutEntryPrice();
withEntryPrice();
stillClassifiesRealTimeExits();

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall good");
