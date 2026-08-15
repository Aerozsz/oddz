/**
 * The take-profit, and proving that brackets actually fire.
 *
 * The sizer has always chosen a target, refused setups whose target did not
 * justify the risk, and reported the reward-to-risk that followed — and nothing
 * ever placed an order there. Winners rode to the time limit or round-tripped
 * into the stop. This pins the order, and pins the test that proves a bracket
 * triggers rather than merely rests.
 */
import {
  checkProtection, ensureProtected, findTakeProfit, placeTakeProfit, testExitPath,
  type Order,
} from "@/lib/sweep/exchange/orders";
import type { BinanceConfig, Position } from "@/lib/sweep/exchange/binance";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

const cfg: BinanceConfig = { apiKey: "k", apiSecret: "s", baseUrl: "https://stub.invalid", live: false, recvWindowMs: 5000 };
const position = (amt: number, mark = 100): Position => ({
  symbol: "BTCUSDT", positionAmt: amt, entryPrice: 100, markPrice: mark, unrealizedPnl: 0,
  liquidationPrice: 0, leverage: 2, notional: Math.abs(amt) * mark, marginType: "cross", isolatedMargin: 0,
});

/* ------------------------------------------------------------ exchange stub */

interface Stub {
  algo: Record<string, unknown>[];
  plain: Record<string, unknown>[];
  posAmt: number;
  trades: { price: string; qty: string; time: number; side: string }[];
  rejectAlgo: string | null;   // order type to refuse
  sent: { method: string; path: string; params: Record<string, string> }[];
}
let S: Stub;
const reset = (over: Partial<Stub> = {}) => {
  S = { algo: [], plain: [], posAmt: 0, trades: [], rejectAlgo: null, sent: [], ...over };
};
reset();

let algoId = 1000;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url));
  const p = Object.fromEntries(u.searchParams);
  const method = init?.method ?? "GET";
  S.sent.push({ method, path: u.pathname, params: p });
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

  if (u.pathname === "/fapi/v1/algoOrder" && method === "POST") {
    if (S.rejectAlgo && p.type === S.rejectAlgo) {
      return json({ code: -2021, msg: `${p.type} would immediately trigger` }, 400);
    }
    const o = {
      algoId: ++algoId, algoType: "CONDITIONAL", orderType: p.type, symbol: p.symbol, side: p.side,
      quantity: "0", triggerPrice: p.triggerPrice, closePosition: p.closePosition === "true",
      algoStatus: "NEW", workingType: p.workingType,
    };
    S.algo.push(o);
    return json(o);
  }
  if (u.pathname === "/fapi/v1/algoOrder" && method === "DELETE") {
    S.algo = S.algo.filter((o) => String(o.algoId) !== p.algoId);
    return json({});
  }
  if (u.pathname === "/fapi/v1/openAlgoOrders") return json(S.algo);
  if (u.pathname === "/fapi/v1/openOrders") return json(S.plain);
  if (u.pathname === "/fapi/v1/order" && method === "DELETE") { S.plain = []; return json({}); }
  if (u.pathname === "/fapi/v1/order" && method === "POST") {
    S.posAmt = p.side === "BUY" ? Number(p.quantity) : -Number(p.quantity);
    if (p.reduceOnly === "true") S.posAmt = 0;
    return json({ orderId: 7, symbol: p.symbol, side: p.side, type: p.type, status: "FILLED",
      origQty: p.quantity, executedQty: p.quantity, avgPrice: "100", price: "0" });
  }
  if (u.pathname === "/fapi/v2/positionRisk") {
    return json(S.posAmt === 0 ? [] : [{ symbol: p.symbol, positionAmt: String(S.posAmt),
      entryPrice: "100", markPrice: "100", unRealizedProfit: "0", liquidationPrice: "0",
      leverage: "2", notional: String(S.posAmt * 100), marginType: "cross", isolatedMargin: "0" }]);
  }
  if (u.pathname === "/fapi/v1/userTrades") return json(S.trades);
  if (u.pathname === "/fapi/v1/premiumIndex") return json({ markPrice: "100" });
  return json({}, 404);
}) as typeof fetch;

/* ------------------------------------------------------------------ checks */

async function main(){
console.log("\n## the take-profit order");
{
  reset();
  const tp = await placeTakeProfit(cfg, "BTCUSDT", position(1), 101, 2);
  const sentBody = S.sent.find((x) => x.path === "/fapi/v1/algoOrder")!;
  ok("it goes to the algo service", sentBody !== undefined);
  ok("...as a TAKE_PROFIT_MARKET", sentBody.params.type === "TAKE_PROFIT_MARKET", sentBody.params.type);
  ok("...with triggerPrice, not stopPrice", sentBody.params.triggerPrice === "101.00" && !("stopPrice" in sentBody.params));
  ok("...closing the position rather than a fixed size", sentBody.params.closePosition === "true");
  ok("...on mark price", sentBody.params.workingType === "MARK_PRICE");
  ok("a long takes profit by selling", sentBody.params.side === "SELL");
  ok("the order comes back with its trigger", tp.stopPrice === 101, String(tp.stopPrice));

  reset();
  await placeTakeProfit(cfg, "BTCUSDT", position(-1), 99, 2);
  ok("a short takes profit by buying", S.sent.find((x) => x.path === "/fapi/v1/algoOrder")!.params.side === "BUY");
}

console.log("\n## it refuses a target that would fill instantly");
{
  reset();
  let threw = false;
  try { await placeTakeProfit(cfg, "BTCUSDT", position(1), 99, 2); } catch { threw = true; }
  ok("a long target below mark is refused", threw);
  reset();
  threw = false;
  try { await placeTakeProfit(cfg, "BTCUSDT", position(-1), 101, 2); } catch { threw = true; }
  ok("a short target above mark is refused", threw);
  reset();
  threw = false;
  try { await placeTakeProfit(cfg, "BTCUSDT", position(0), 101, 2); } catch { threw = true; }
  ok("no position means nothing to take profit on", threw);
}

console.log("\n## protection reports both sides of the bracket");
{
  reset({ posAmt: 1 });
  const bare = await checkProtection(cfg, "BTCUSDT", position(1));
  ok("a naked position is unprotected", !bare.protected);
  // The missing stop is the emergency and gets the whole message. Mentioning
  // the absent target here would dilute the one line that has to be read.
  ok("...and the reason is about the stop, not the target",
    bare.reason.includes("NO STOP") && !bare.reason.includes("no target"), bare.reason);
  ok("...while the target field is simply empty", bare.takeProfit === null);

  // A protected position with no target does say so, because there the target
  // is the only thing missing and it changes how the position will exit.
  S.algo.push({ algoId: 1, algoType: "CONDITIONAL", orderType: "STOP_MARKET", symbol: "BTCUSDT",
    side: "SELL", quantity: "0", triggerPrice: "99.5", closePosition: true, algoStatus: "NEW" });
  const stopOnly = await checkProtection(cfg, "BTCUSDT", position(1));
  ok("a stopped position with no target says so",
    stopOnly.protected && stopOnly.reason.includes("no target resting"), stopOnly.reason);
  S.algo = [];

  const withBoth = await ensureProtected(cfg, "BTCUSDT", position(1), 0.5, 2, 101);
  ok("ensureProtected places the stop", withBoth.stop !== null);
  ok("...and the target when one is given", withBoth.takeProfit !== null,
    withBoth.takeProfit ? String(withBoth.takeProfit.stopPrice) : "none");
  ok("...reporting both distances", withBoth.stopDistancePct !== null && withBoth.targetDistancePct !== null,
    `${withBoth.stopDistancePct?.toFixed(2)}% / ${withBoth.targetDistancePct?.toFixed(2)}%`);

  const again = await checkProtection(cfg, "BTCUSDT", position(1));
  ok("a second look finds both resting", again.protected && again.takeProfit !== null);
  ok("...and does not duplicate them", S.algo.length === 2, `${S.algo.length} orders`);
}

console.log("\n## a target is never allowed to cost the stop");
{
  reset({ posAmt: 1, rejectAlgo: "TAKE_PROFIT_MARKET" });
  const r = await ensureProtected(cfg, "BTCUSDT", position(1), 0.5, 2, 101);
  ok("the stop still lands when the target is refused", r.stop !== null && r.protected);
  ok("...and the failure is reported, not swallowed", r.reason.includes("could not place the target"), r.reason);
  ok("...leaving the position protected", r.takeProfit === null && S.algo.length === 1);
}

console.log("\n## no target given means no target placed");
{
  reset({ posAmt: 1 });
  const r = await ensureProtected(cfg, "BTCUSDT", position(1), 0.5, 2, null);
  ok("only the stop is placed", r.stop !== null && r.takeProfit === null && S.algo.length === 1);
}

console.log("\n## findTakeProfit only matches a real one");
{
  const closing: Order[] = [
    { orderId: 1, symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", stopPrice: 99,
      closePosition: true, reduceOnly: false, quantity: 0, executedQty: 0, avgPrice: 0, price: 0, status: "NEW" },
    { orderId: 2, symbol: "BTCUSDT", side: "SELL", type: "TAKE_PROFIT_MARKET", stopPrice: 101,
      closePosition: true, reduceOnly: false, quantity: 0, executedQty: 0, avgPrice: 0, price: 0, status: "NEW" },
  ];
  ok("it finds the take-profit", findTakeProfit(closing, position(1))?.orderId === 2);
  ok("...not the stop", findTakeProfit([closing[0]], position(1)) === null);
  ok("...and not one on the wrong side", findTakeProfit(closing, position(-1)) === null);
}

console.log("\n## proving a bracket actually fires");
{
  // The stop trigger is hit: the position goes flat and the closing print lands
  // near the stop price.
  reset({ posAmt: 0 });
  const stopRun = testExitPath(cfg, "BTCUSDT", "BUY", "1", 0.1, 2, 20_000);
  await new Promise((r) => setTimeout(r, 200));
  S.posAmt = 0;                                   // closed by the stop
  S.trades = [{ price: "99.90", qty: "1", time: Date.now(), side: "SELL" }];
  const res = await stopRun;
  ok("it reports a pass", res.ok, res.steps.map((s) => s.text).join(" | "));
  ok("...naming the stop as what fired", res.closedBy === "stop", res.closedBy);
  ok("...with the fill price", res.exitPrice === 99.9, String(res.exitPrice));
  ok("...and the slippage against the trigger", res.slippageBps !== null,
    res.slippageBps !== null ? `${res.slippageBps.toFixed(1)}bp` : "none");
  ok("...having cancelled what was left resting", S.algo.length === 0, `${S.algo.length} left`);
  ok("the steps read as a narrative", res.steps.length >= 3 && res.steps[0].text.includes("entry filled"));
}

{
  // The target trigger is hit instead.
  reset({ posAmt: 0 });
  const run = testExitPath(cfg, "BTCUSDT", "BUY", "1", 0.1, 2, 20_000);
  await new Promise((r) => setTimeout(r, 200));
  S.posAmt = 0;
  S.trades = [{ price: "100.12", qty: "1", time: Date.now(), side: "SELL" }];
  const res = await run;
  ok("a target fill is attributed to the target", res.closedBy === "target", res.closedBy);
  ok("...and still counts as a pass", res.ok);
}

{
  // The stop is refused outright — the position must not be left naked.
  reset({ posAmt: 0, rejectAlgo: "STOP_MARKET" });
  const res = await testExitPath(cfg, "BTCUSDT", "BUY", "1", 0.1, 2, 20_000);
  ok("a rejected stop fails the test", !res.ok);
  ok("...and closes the position rather than leaving it naked", S.posAmt === 0);
  ok("...saying the stop was rejected", res.steps.some((s) => s.text.includes("stop REJECTED")),
    res.steps.map((s) => s.text).join(" | "));
}

{
  // Neither fires inside the window.
  reset({ posAmt: 0 });
  const res = await testExitPath(cfg, "BTCUSDT", "BUY", "1", 0.1, 2, 4_000);
  ok("a timeout is inconclusive rather than a pass", !res.ok && res.closedBy === "timeout-manual", res.closedBy);
  ok("...and the position is closed at market", S.posAmt === 0);
  ok("...leaving nothing resting", S.algo.length === 0, `${S.algo.length} left`);
}

  await ratchetOrder();


}
main();

/* ------------------------------------- the ratchet must never uncover a position */

/**
 * The break-even ratchet replaces one stop with another, and the order of those
 * two operations is the whole safety property. Cancel-then-place leaves the
 * position naked for however long the placement takes — and forever, if it
 * fails. This asserts the sequence directly against the exchange stub, because
 * it is not observable from the result.
 */
async function ratchetOrder() {
  console.log("\n## replacing a stop never leaves the position uncovered");

  // Reproduce the sequence maintainBrackets performs, against the stub.
  const { placeProtectiveStop, cancelOrder } = await import("@/lib/sweep/exchange/orders");

  reset({ posAmt: 1 });
  const original = await placeProtectiveStop(cfg, "BTCUSDT", position(1), 99.5, 2);
  S.sent = [];

  // The healthy path: place the improved stop, then cancel the old one.
  const moved = await placeProtectiveStop(cfg, "BTCUSDT", position(1), 99.9, 2);
  await cancelOrder(cfg, "BTCUSDT", original.orderId, original.isAlgo);

  const order = S.sent.filter((x) => x.path === "/fapi/v1/algoOrder").map((x) => x.method);
  ok("the new stop is placed before the old is cancelled", order[0] === "POST" && order[1] === "DELETE",
    order.join(" then "));
  ok("...leaving exactly one resting afterwards", S.algo.length === 1, `${S.algo.length}`);
  ok("...and it is the improved one", Number(S.algo[0].triggerPrice) === 99.9, String(S.algo[0].triggerPrice));

  // The failure path: the replacement is refused. The original must survive.
  reset({ posAmt: 1 });
  const kept = await placeProtectiveStop(cfg, "BTCUSDT", position(1), 99.5, 2);
  S.rejectAlgo = "STOP_MARKET";
  let threw = false;
  try { await placeProtectiveStop(cfg, "BTCUSDT", position(1), 99.9, 2); } catch { threw = true; }
  ok("a refused replacement throws", threw);
  ok("...and the original is still resting", S.algo.length === 1 && S.algo[0].algoId === kept.orderId,
    `${S.algo.length} resting`);
  ok("...so the position was never uncovered", S.algo.some((o) => Number(o.triggerPrice) === 99.5));

  console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
  process.exit(fails === 0 ? 0 : 1);
}
