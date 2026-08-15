/**
 * The caps that stopped a live session.
 *
 * A max-position of zero refuses every order before it is sized. It was derived
 * from the balance once, at boot, and returned silently when the balance was not
 * yet readable — so a transient failure at startup killed trading for the whole
 * session with nothing in the log. Reset had the same hole: it zeroed the caps,
 * called the deriver, and reported success whether or not anything was derived.
 */
import { createBinanceAdapter } from "../lib/sweep/exchange/adapter";
import type { AgentState, TradeIntent } from "../lib/sweep/agent";
import type { BinanceConfig } from "../lib/sweep/exchange/binance";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

const cfg = { apiKey: "k", apiSecret: "s", baseUrl: "https://stub", live: false, recvWindowMs: 5000 } as BinanceConfig;
const LIM = {
  maxPositionUsd: 0, maxLeverage: 10, maxDailyLossUsd: 0, maxOpenPositions: 1,
  tradingEnabled: true, stopLossPct: 0.5, maxTradesPerDay: 0, lossCooldownMin: 0,
  marginHeadroomPct: 5,
};
const state = {
  health: { tradeable: true, summary: "live" }, mid: 100_000,
} as unknown as AgentState;
const intent = { id: "i1", side: "buy", reason: "test" } as unknown as TradeIntent;

let positions: unknown[] = [];
globalThis.fetch = (async (u: unknown, init?: { method?: string }) => {
  const url = String(u);
  if (url.includes("/fapi/v1/order") && init?.method === "POST" &&
      new URL(url).searchParams.get("type") === "MARKET") {
    positions = [{ symbol: "BTCUSDT", positionAmt: "0.264", entryPrice: "100000",
      markPrice: "100000", unrealizedProfit: "0", liquidationPrice: "0", leverage: "8" }];
  }
  if (url.includes("/income")) return new Response("[]", { status: 200 });
  if (url.includes("/v2/account")) return new Response(JSON.stringify({
    availableBalance: "3300", totalWalletBalance: "3300", totalUnrealizedProfit: "0",
    totalMaintMargin: "0", totalMarginBalance: "3300", positions }), { status: 200 });
  if (url.includes("positionRisk")) return new Response(JSON.stringify(positions), { status: 200 });
  if (url.includes("openOrders") || url.includes("openAlgoOrders")) return new Response("[]", { status: 200 });
  return new Response(JSON.stringify({ orderId: 1 }), { status: 200 });
}) as typeof fetch;

async function main() {
  console.log("\n## a blank max-position must not be able to stop trading");
  const a = createBinanceAdapter({
    cfg, symbol: "BTCUSDT", limits: () => LIM, quantityPrecision: 3,
    size: () => ({ notionalUsd: 26_400, stopPct: 0.5, leverage: 8, reason: "fixture" }),
  });
  await a.submit(intent, state);
  const rec = a.history[0];
  /*
   * Zero used to mean "refuse everything", which made one empty box the most
   * destructive setting in the program. It now means "no ceiling", consistent
   * with maxDailyLossUsd, maxTradesPerDay and lossCooldownMin — and it is safe,
   * because the risk budget still sets size and the leverage and margin checks
   * still apply.
   */
  ok("a zero cap no longer refuses the order", rec.outcome === "submitted", `${rec.outcome}: ${rec.detail}`);
  ok("size still comes from the risk budget, not from the missing cap",
    /26400/.test(rec.detail), rec.detail);

  console.log("\n## a cap that is set still binds");
  positions = [];
  const derived = { ...LIM, maxPositionUsd: 10_000 };
  const b = createBinanceAdapter({
    cfg, symbol: "BTCUSDT", limits: () => derived, quantityPrecision: 3,
    size: () => ({ notionalUsd: 26_400, stopPct: 0.5, leverage: 8, reason: "fixture" }),
  });
  await b.submit({ ...intent, id: "i2" }, state);
  ok("the order still goes through", b.history[0].outcome === "submitted",
    `${b.history[0].outcome}: ${b.history[0].detail}`);
  ok("and is truncated to the cap", /10000|~10000/.test(b.history[0].detail),
    b.history[0].detail);

  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
}
main();
