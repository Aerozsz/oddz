/**
 * The protective stop is the property everything else rests on: positions are
 * deliberately left open on shutdown, and that is only safe because the stop
 * lives on the exchange. Binance moved conditional orders to a separate service
 * on 2025-12-09, so this pins the new contract.
 */
import {
  checkProtection,
  findProtectiveStop,
  listOpenOrders,
  placeProtectiveStop,
  type Order,
} from "@/lib/sweep/exchange/orders";
import type { BinanceConfig, Position } from "@/lib/sweep/exchange/binance";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

const cfg: BinanceConfig = { apiKey: "k", apiSecret: "s", baseUrl: "https://stub.invalid", live: false, recvWindowMs: 5000 };
const position = (amt: number): Position => ({
  symbol: "BTCUSDT", positionAmt: amt, entryPrice: 100, markPrice: 100, unrealizedPnl: 0,
  liquidationPrice: 0, leverage: 2, notional: amt * 100, marginType: "cross", isolatedMargin: 0,
});

let sent: { method: string; path: string; params: Record<string, string> }[] = [];
let algoOpen: unknown[] = [];
let plainOpen: unknown[] = [];

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url));
  const params = Object.fromEntries(u.searchParams);
  sent.push({ method: init?.method ?? "GET", path: u.pathname, params });
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

  if (u.pathname === "/fapi/v1/algoOrder" && (init?.method ?? "GET") === "POST") {
    // The old endpoint would have rejected this; the algo one accepts it.
    return json({
      algoId: 3358, algoType: "CONDITIONAL", orderType: "STOP_MARKET", symbol: params.symbol,
      side: params.side, quantity: "0", triggerPrice: params.triggerPrice,
      closePosition: params.closePosition === "true", algoStatus: "NEW", workingType: params.workingType,
    });
  }
  if (u.pathname === "/fapi/v1/openAlgoOrders") return json(algoOpen);
  if (u.pathname === "/fapi/v1/openOrders") return json(plainOpen);
  if (u.pathname === "/fapi/v1/order" && (init?.method ?? "GET") === "POST") {
    // Reproduce the real failure: conditional types are refused here now.
    if (String(params.type).includes("STOP")) {
      return new Response(JSON.stringify({ code: -4120, msg: "Order type not supported for this endpoint. Please use the Algo Order API endpoints instead." }), { status: 400 });
    }
    return json({ orderId: 1, symbol: params.symbol, side: params.side, type: params.type, status: "FILLED", origQty: params.quantity, executedQty: params.quantity, avgPrice: "100" });
  }
  return json({});
}) as typeof fetch;

async function main() {
  console.log("\n## protective stop, on the Algo Order service");

  sent = [];
  const stop = await placeProtectiveStop(cfg, "BTCUSDT", position(1), 97, 2);
  const req = sent.find((r) => r.method === "POST");

  ok("goes to the algo endpoint, not /fapi/v1/order", req?.path === "/fapi/v1/algoOrder", req?.path);
  ok("declares algoType CONDITIONAL", req?.params.algoType === "CONDITIONAL");
  ok("sends triggerPrice, not stopPrice", req?.params.triggerPrice === "97.00" && req?.params.stopPrice === undefined,
    JSON.stringify({ triggerPrice: req?.params.triggerPrice, stopPrice: req?.params.stopPrice }));
  ok("keeps closePosition", req?.params.closePosition === "true");
  ok("keeps MARK_PRICE triggering", req?.params.workingType === "MARK_PRICE");
  ok("closes a long by selling", req?.params.side === "SELL");
  ok("returns the algoId as the order id", stop.orderId === 3358);
  ok("...flagged as an algo order so it cancels by algoId", stop.isAlgo === true);
  ok("...with the trigger readable as stopPrice", stop.stopPrice === 97);

  // A short is the mirror.
  sent = [];
  await placeProtectiveStop(cfg, "BTCUSDT", position(-1), 103, 2);
  ok("closes a short by buying", sent.find((r) => r.method === "POST")?.params.side === "BUY");

  // Geometry is still rejected before anything is sent.
  let threw = false;
  try { await placeProtectiveStop(cfg, "BTCUSDT", position(1), 103, 2); } catch { threw = true; }
  ok("a long stop above the mark is refused", threw);
  threw = false;
  try { await placeProtectiveStop(cfg, "BTCUSDT", position(-1), 97, 2); } catch { threw = true; }
  ok("a short stop below the mark is refused", threw);

  console.log("\n## finding it again");

  algoOpen = [{
    algoId: 3358, orderType: "STOP_MARKET", symbol: "BTCUSDT", side: "SELL",
    triggerPrice: "97.00", closePosition: true, algoStatus: "NEW",
  }];
  plainOpen = [{ orderId: 9, symbol: "BTCUSDT", side: "BUY", type: "LIMIT", status: "NEW", origQty: "1", price: "99" }];

  const all = await listOpenOrders(cfg, "BTCUSDT");
  ok("both services are queried", all.length === 2, `${all.length} orders`);
  ok("the resting entry is still visible", all.some((o) => o.type === "LIMIT" && !o.isAlgo));

  const found = findProtectiveStop(all, position(1));
  ok("the algo stop is recognised as protection", found !== null && found.orderId === 3358);

  const state = await checkProtection(cfg, "BTCUSDT", position(1));
  ok("a position with an algo stop reads as protected", state.protected, state.reason);
  ok("...and reports the distance", Math.abs((state.stopDistancePct ?? 0) - 3) < 0.01, `${state.stopDistancePct?.toFixed(2)}%`);

  algoOpen = [];
  const bare = await checkProtection(cfg, "BTCUSDT", position(1));
  ok("a position with no stop reads as UNPROTECTED", !bare.protected, bare.reason);

  // The regression that started this: the old endpoint must not be used.
  ok("no conditional order was ever sent to /fapi/v1/order",
    !sent.some((r) => r.path === "/fapi/v1/order" && String(r.params.type).includes("STOP")));

  console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
  process.exit(fails ? 1 : 0);
}
void main();
