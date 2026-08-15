/** Closing a position at a chosen price, against a stubbed exchange. */
import { closePositionAtLimit } from "../lib/sweep/exchange/orders";
import type { BinanceConfig } from "../lib/sweep/exchange/binance";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

const cfg = { apiKey: "k", apiSecret: "s", baseUrl: "https://stub", live: false, recvWindowMs: 5000 } as BinanceConfig;

let posAmt = "0.05";
let posted: Record<string, string> | null = null;
globalThis.fetch = (async (u: unknown, init: { method?: string } | undefined) => {
  const url = String(u);
  if (url.includes("positionRisk")) {
    return new Response(JSON.stringify(posAmt === "0" ? [] : [{ positionAmt: posAmt }]), { status: 200 });
  }
  if (url.includes("bookTicker")) {
    return new Response(JSON.stringify({ bidPrice: "100000", askPrice: "100010" }), { status: 200 });
  }
  if (url.includes("/fapi/v1/order") && init?.method === "POST") {
    posted = Object.fromEntries(new URL(url).searchParams);
    return new Response(JSON.stringify({ orderId: 42 }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
}) as typeof fetch;

async function main() {
  console.log("\n## a long, resting above the market");
  posted = null;
  let r = await closePositionAtLimit(cfg, "BTCUSDT", 101_000, 3, 2);
  ok("a long is closed by selling", r.side === "SELL" && posted!.side === "SELL");
  ok("the whole position is offered", r.quantity === 0.05, String(r.quantity));
  ok("it is reduce-only, so it cannot reverse the position", posted!.reduceOnly === "true");
  ok("it is a GTC limit — the point is that it waits", posted!.type === "LIMIT" && posted!.timeInForce === "GTC");
  ok("priced where asked", posted!.price === "101000.00", posted!.price);
  ok("above the bid, so it rests", r.marketable === false, r.reason);

  console.log("\n## a long, priced through the market");
  r = await closePositionAtLimit(cfg, "BTCUSDT", 99_000, 3, 2);
  ok("crossing is reported, not silently done", r.marketable === true, r.reason);

  console.log("\n## a short is the mirror");
  posAmt = "-0.05";
  r = await closePositionAtLimit(cfg, "BTCUSDT", 99_000, 3, 2);
  ok("a short is closed by buying", r.side === "BUY" && posted!.side === "BUY");
  ok("below the ask, so it rests", r.marketable === false, r.reason);
  r = await closePositionAtLimit(cfg, "BTCUSDT", 101_000, 3, 2);
  ok("above the ask crosses", r.marketable === true, r.reason);

  console.log("\n## refusals");
  posAmt = "0";
  ok("flat is refused", await closePositionAtLimit(cfg, "BTCUSDT", 100_000, 3, 2).then(() => false).catch(() => true));
  posAmt = "0.05";
  ok("a zero price is refused", await closePositionAtLimit(cfg, "BTCUSDT", 0, 3, 2).then(() => false).catch(() => true));
  ok("a negative price is refused", await closePositionAtLimit(cfg, "BTCUSDT", -5, 3, 2).then(() => false).catch(() => true));

  console.log("\n## precision");
  posAmt = "0.0567";
  await closePositionAtLimit(cfg, "BTCUSDT", 100_000.987, 3, 1);
  ok("quantity floors to the step, never rounds up past the position", posted!.quantity === "0.056", posted!.quantity);
  ok("price is written at the contract's precision", posted!.price === "100001.0", posted!.price);

  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
}
main();
