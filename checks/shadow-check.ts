import { resolveShadow, scoreShadow, type ShadowTrade } from "@/lib/sweep/exchange/shadow";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

const base = (over: Partial<ShadowTrade> = {}): ShadowTrade => ({
  at: Date.now(), intentId: "i1", signalKind: "withdrawal", reason: "r", side: "long",
  entryPrice: 100, stopPrice: 98, targetPrice: 103, quantity: 50, notionalUsd: 5000,
  leverage: 2, riskUsd: 100, rewardRisk: 1.5,
  style: { entry: "maker", exit: "taker" }, feeUsd: 3.5, feeBps: 7, fundingUsd: 0,
  mid: 100, spreadBps: 2, markoutToxicity: 0.3, markoutInformed: 0.1,
  intraday: "morning", biasConviction: 0.4, outcomes: {}, ...over,
});

console.log("\n## shadow scoring");

// A win, net of fees.
let t = base();
scoreShadow(t, "t900", 102);
ok("a long that rose is a win", (t.outcomes.t900.pct ?? 0) > 0);
ok("...net of fees", Math.abs((t.outcomes.t900.netUsd ?? 0) - (100 - 3.5)) < 0.01, `${t.outcomes.t900.netUsd?.toFixed(2)}`);

// A move too small to clear the round trip is a LOSS, not a win.
t = base();
scoreShadow(t, "t900", 100.05);
ok("a 5bp move is gross positive", (t.outcomes.t900.pct ?? 0) > 0);
ok("...but net negative after fees", (t.outcomes.t900.netUsd ?? 0) < 0, `${t.outcomes.t900.netUsd?.toFixed(2)}`);

// Shorts are signed the other way.
t = base({ side: "short", stopPrice: 102, targetPrice: 97 });
scoreShadow(t, "t900", 98);
ok("a short that fell is a win", (t.outcomes.t900.pct ?? 0) > 0, `${t.outcomes.t900.pct?.toFixed(2)}%`);

// Funding is a cost when paid, ignored when received (already in the price).
t = base({ fundingUsd: 20 });
scoreShadow(t, "t900", 102);
ok("funding paid comes out of net", Math.abs((t.outcomes.t900.netUsd ?? 0) - (100 - 3.5 - 20)) < 0.01);
t = base({ fundingUsd: -20 });
scoreShadow(t, "t900", 102);
ok("funding received is not counted as profit", Math.abs((t.outcomes.t900.netUsd ?? 0) - (100 - 3.5)) < 0.01);

// A null price does not fabricate an outcome.
t = base();
scoreShadow(t, "t900", null);
ok("an unresolvable horizon scores null", t.outcomes.t900.netUsd === null);

console.log("\n## stop and target resolution");

// THE ONE THAT MATTERS: price dipped through the stop, then recovered. Scoring
// on the horizon price alone would call this flat.
t = base();
ok("a stop touched mid-window resolves as a stop", resolveShadow(t, 101, 97.5) === "stop");
ok("a target reached resolves as target", resolveShadow(t, 103.5, 99.5) === "target");
ok("neither touched stays open", resolveShadow(t, 101, 99) === "open");
ok("stop wins when both were touched (pessimistic)", resolveShadow(t, 104, 97) === "stop");

t = base({ side: "short", stopPrice: 102, targetPrice: 97 });
ok("short stop is above", resolveShadow(t, 102.5, 99) === "stop");
ok("short target is below", resolveShadow(t, 101, 96.5) === "target");

t = base({ targetPrice: null });
ok("no target cannot resolve as target", resolveShadow(t, 200, 99) === "open");

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails ? 1 : 0);
