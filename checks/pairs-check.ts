/**
 * Market-neutral spreads. Two things must hold or the structure is a lie: the
 * legs must actually cancel, and half a pair must never survive.
 */
import { proposePair, shouldClosePair, PAIR_THRESHOLDS } from "@/lib/sweep/agent/pairs";
import { openPair, closePair } from "@/lib/sweep/exchange/pair-orders";
import { DislocationTracker, EMPTY_DISLOCATION, type DislocationRead } from "@/lib/sweep/metrics/dislocation";
import type { BinanceConfig } from "@/lib/sweep/exchange/binance";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

const read = (over: Partial<DislocationRead> = {}): DislocationRead =>
  ({ ...EMPTY_DISLOCATION, warm: true, coupled: true, correlation: 0.85, z: 2.0, peers: 3, ...over });

const input = (over: Record<string, unknown> = {}) => ({
  symbol: "ETHUSDT", peer: "BTCUSDT", dislocation: read(), beta: 1.4,
  priceA: 3000, priceB: 60000, equity: 5000, riskFraction: 0.02,
  maxGrossNotionalUsd: 20000, spreadVolPct: 0.35, roundTripPctPerLeg: 0.1,
  ...over,
});

console.log("\n## the legs actually cancel");
{
  const r = proposePair(input());
  ok("it proposes", r.ok, r.ok ? "" : r.reasons.join("; "));
  if (r.ok) {
    ok("one leg each way", r.legs[0].side !== r.legs[1].side, `${r.legs[0].side}/${r.legs[1].side}`);
    ok("the rich one is shorted", r.legs.find((l) => l.symbol === r.rich)?.side === "short");
    ok("the cheap one is bought", r.legs.find((l) => l.symbol === r.cheap)?.side === "long");
    // Beta-weighted, so the livelier leg carries less notional.
    const eth = r.legs.find((l) => l.symbol === "ETHUSDT")!;
    const btc = r.legs.find((l) => l.symbol === "BTCUSDT")!;
    ok("the higher-beta leg carries less notional", eth.notionalUsd < btc.notionalUsd,
      `${eth.notionalUsd.toFixed(0)} vs ${btc.notionalUsd.toFixed(0)}`);
    ok("...in the beta ratio", Math.abs(btc.notionalUsd / eth.notionalUsd - 1.4) < 0.01,
      (btc.notionalUsd / eth.notionalUsd).toFixed(3));
    ok("net delta is near zero", Math.abs(r.netDeltaUsd) < r.grossNotionalUsd * 0.02,
      `${r.netDeltaUsd.toFixed(0)} of ${r.grossNotionalUsd.toFixed(0)} gross`);
    ok("...and is reported rather than assumed", r.reasoning.some((x) => x.includes("net directional")));
  }
}

console.log("\n## it refuses what is not a pair");
{
  const loose = proposePair(input({ dislocation: read({ correlation: 0.3 }) }));
  ok("uncorrelated names are refused", !loose.ok);
  ok("...saying the hedge would not hedge", !loose.ok && loose.reasons[0].includes("not a pair"), !loose.ok ? loose.reasons[0] : "");

  const cold = proposePair(input({ dislocation: { ...EMPTY_DISLOCATION } }));
  ok("a cold spread is refused", !cold.ok);

  const flat = proposePair(input({ dislocation: read({ z: 0.4 }) }));
  ok("a spread at its mean is refused", !flat.ok && flat.reasons[0].includes("entry threshold"),
    !flat.ok ? flat.reasons[0] : "");
}

console.log("\n## the far tail is refused, not treated as the best entry");
{
  const wide = proposePair(input({ dislocation: read({ z: 4.0 }) }));
  ok("a 4σ divergence is refused", !wide.ok, wide.ok ? "allowed!" : "");
  ok("...because it is more likely news than flow",
    !wide.ok && wide.reasons[0].includes("news"), !wide.ok ? wide.reasons[0] : "");

  // The shape that matters: 2σ trades, 4σ does not.
  ok("...while an ordinary divergence still trades", proposePair(input({ dislocation: read({ z: 2.0 }) })).ok);
}

console.log("\n## a pair pays the round trip twice");
{
  // Tiny expected move against two legs of cost.
  const thin = proposePair(input({ dislocation: read({ z: 1.7 }), spreadVolPct: 0.05 }));
  ok("a spread that cannot clear two round trips is refused", !thin.ok, thin.ok ? "allowed!" : "");
  ok("...and says the cost is paid twice",
    !thin.ok && thin.reasons[0].includes("twice"), !thin.ok ? thin.reasons[0] : "");
}

console.log("\n## beta is clamped rather than trusted");
{
  const wild = proposePair(input({ beta: 25 }));
  ok("an absurd beta still proposes", wild.ok, wild.ok ? "" : wild.reasons.join("; "));
  ok("...clamped to something usable", wild.ok && wild.beta <= 4, wild.ok ? String(wild.beta) : "");
  ok("...and says it was clamped", wild.ok && wild.reasoning.some((x) => x.includes("clamped")));
}

console.log("\n## exits");
{
  const held = 10 * 60_000;
  const maxHold = 240 * 60_000;
  ok("reverting to the mean closes", shouldClosePair(2.0, 0.3, held, maxHold).close);
  ok("...as a target, not a stop", shouldClosePair(2.0, 0.3, held, maxHold).reason.includes("target"));
  ok("still apart holds", !shouldClosePair(2.0, 1.5, held, maxHold).close);
  ok("widening past the stop closes", shouldClosePair(2.0, 3.8, held, maxHold).close);
  ok("...naming the stop", shouldClosePair(2.0, 3.8, held, maxHold).reason.includes("stop"));
  // Sign flip: the relationship inverted rather than reverted, so the position
  // now expresses the opposite view to the one that was taken.
  const flipped = shouldClosePair(2.0, -1.5, held, maxHold);
  ok("an inverted spread closes", flipped.close);
  ok("...because it is now the opposite trade", flipped.reason.includes("opposite"));
  ok("the time limit closes a spread that never reverted",
    shouldClosePair(2.0, 1.8, maxHold + 1, maxHold).close);
  ok("...and zero disables it", !shouldClosePair(2.0, 1.8, 99e9, 0).close);
}

/* ------------------------------------------------------- execution safety */

interface Stub { posAmt: Record<string, number>; rejectSymbol: string | null; unwindFails: boolean; sent: string[] }
let S: Stub;
const reset = (o: Partial<Stub> = {}) => { S = { posAmt: {}, rejectSymbol: null, unwindFails: false, sent: [], ...o }; };
reset();

const cfg: BinanceConfig = { apiKey: "k", apiSecret: "s", baseUrl: "https://stub.invalid", live: false, recvWindowMs: 5000 };

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url));
  const p = Object.fromEntries(u.searchParams);
  const method = init?.method ?? "GET";
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

  if (u.pathname === "/fapi/v1/order" && method === "POST") {
    S.sent.push(`${p.side} ${p.symbol}${p.reduceOnly === "true" ? " reduce" : ""}`);
    if (p.symbol === S.rejectSymbol && p.reduceOnly !== "true") return json({ code: -2019, msg: "insufficient margin" }, 400);
    if (p.reduceOnly === "true") {
      if (S.unwindFails) return json({ code: -1001, msg: "internal error" }, 400);
      S.posAmt[p.symbol] = 0;
      return json({ orderId: 1, symbol: p.symbol, side: p.side, status: "FILLED", executedQty: p.quantity, avgPrice: "100" });
    }
    S.posAmt[p.symbol] = (p.side === "BUY" ? 1 : -1) * Number(p.quantity);
    return json({ orderId: 1, symbol: p.symbol, side: p.side, status: "FILLED", executedQty: p.quantity, avgPrice: "100" });
  }
  if (u.pathname === "/fapi/v2/positionRisk") {
    const amt = S.posAmt[p.symbol] ?? 0;
    return json(amt === 0 ? [] : [{ symbol: p.symbol, positionAmt: String(amt), entryPrice: "100", markPrice: "100",
      unRealizedProfit: "0", liquidationPrice: "0", leverage: "2", notional: "100", marginType: "cross", isolatedMargin: "0" }]);
  }
  return json({}, 404);
}) as typeof fetch;

async function execution() {
  console.log("\n## half a pair never survives");
  {
    reset();
    const r = await openPair(cfg, { symbol: "ETHUSDT", side: "SELL", quantity: "1" }, { symbol: "BTCUSDT", side: "BUY", quantity: "0.05" });
    ok("a clean pair opens both legs", r.ok && r.fills.length === 2, r.detail);
    ok("...both positions exist", S.posAmt.ETHUSDT !== 0 && S.posAmt.BTCUSDT !== 0);
  }

  {
    // The dangerous case: leg one fills, leg two is rejected.
    reset({ rejectSymbol: "BTCUSDT" });
    const r = await openPair(cfg, { symbol: "ETHUSDT", side: "SELL", quantity: "1" }, { symbol: "BTCUSDT", side: "BUY", quantity: "0.05" });
    ok("a failed second leg fails the pair", !r.ok);
    ok("...and the first leg is unwound", r.unwound === "ETHUSDT", String(r.unwound));
    ok("...leaving the account flat", (S.posAmt.ETHUSDT ?? 0) === 0, String(S.posAmt.ETHUSDT));
    ok("...and saying so plainly", r.detail.includes("account is flat"), r.detail);
  }

  {
    // Worse: the unwind itself fails. This must shout, not shrug.
    reset({ rejectSymbol: "BTCUSDT", unwindFails: true });
    const r = await openPair(cfg, { symbol: "ETHUSDT", side: "SELL", quantity: "1" }, { symbol: "BTCUSDT", side: "BUY", quantity: "0.05" });
    ok("an unwind that fails is not reported as success", !r.ok && r.unwound === null);
    ok("...and names the naked position", r.detail.includes("UNHEDGED"), r.detail);
    ok("...telling the operator to act", r.detail.includes("by hand"));
  }

  {
    // First leg rejected: nothing was opened, so nothing to unwind.
    reset({ rejectSymbol: "ETHUSDT" });
    const r = await openPair(cfg, { symbol: "ETHUSDT", side: "SELL", quantity: "1" }, { symbol: "BTCUSDT", side: "BUY", quantity: "0.05" });
    ok("a rejected first leg opens nothing", !r.ok && r.fills.length === 0);
    ok("...and never touches the second", !S.sent.some((x) => x.includes("BTCUSDT")), S.sent.join(", "));
  }

  console.log("\n## closing takes both legs off");
  {
    reset({ posAmt: { ETHUSDT: -1, BTCUSDT: 0.05 } });
    const r = await closePair(cfg, ["ETHUSDT", "BTCUSDT"]);
    ok("both close", r.ok && r.closed.length === 2, r.detail);

    // One leg refuses: the other is still attempted, and the survivor is named.
    reset({ posAmt: { ETHUSDT: -1, BTCUSDT: 0.05 }, unwindFails: true });
    const partial = await closePair(cfg, ["ETHUSDT", "BTCUSDT"]);
    ok("a failed close is not reported as done", !partial.ok);
    ok("...naming what is still open", partial.stillOpen.length === 2, partial.detail);
    ok("...and warning the hedge is gone", partial.detail.includes("no longer hedged"));
    ok("both legs were attempted regardless", S.sent.filter((x) => x.includes("reduce")).length >= 2,
      S.sent.join(", "));
  }

  console.log("\n## beta and spread vol come off the same window");
  {
    const t = new DislocationTracker();
    const T0 = 1_800_000_000_000;
    let a = 100, b = 50;
    for (let i = 0; i < 200; i++) {
      const common = Math.sin(i * 0.1) * 0.002;
      a *= Math.exp(common * 1.5);   // twice as lively
      b *= Math.exp(common * 0.75);
      t.record("A", a, T0 + i * 5000);
      t.record("B", b, T0 + i * 5000);
    }
    const beta = t.beta("A", "B");
    ok("beta recovers the ratio", beta !== null && Math.abs(beta - 2) < 0.15, beta?.toFixed(3));
    const raw = t.spreadVolPct("A");
    const hedged = t.spreadVolPct("A", "B", beta ?? 1);
    ok("spread vol is measured", raw !== null && raw > 0, raw?.toFixed(4));
    // The whole point of the hedge: once beta is subtracted, almost nothing is
    // left to be volatile about. Sizing a stop on the raw figure would make the
    // position several times smaller for a risk it is not carrying.
    ok("the hedged residual is far smaller than the raw one",
      hedged !== null && raw !== null && hedged < raw * 0.2, `${hedged?.toFixed(4)} vs ${raw?.toFixed(4)}`);
    ok("an unknown pair has no beta", t.beta("A", "NOPE") === null);
  }

  console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
  process.exit(fails === 0 ? 0 : 1);
}
void execution();
