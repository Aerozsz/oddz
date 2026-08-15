/**
 * The maker entry is a state machine over an unreliable counterparty, so it is
 * tested against a stubbed exchange rather than a live one. Every branch below
 * is a way a real resting order ends.
 */
import { placeMakerEntry } from "@/lib/sweep/exchange/orders";
import type { BinanceConfig } from "@/lib/sweep/exchange/binance";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

const cfg: BinanceConfig = {
  apiKey: "k", apiSecret: "s", baseUrl: "https://stub.invalid", live: false, recvWindowMs: 5000,
};

type Scenario = {
  place?: () => unknown;
  statuses: string[];          // status returned by successive GET /order calls
  executed?: number[];         // executedQty alongside each
  mark?: number;
  cancelExecuted?: number;     // executedQty reported by the cancel response
};

let scenario: Scenario;
let call = 0;
let placed: Record<string, string> | null = null;
let cancelled = false;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request) => {
  const u = String(url);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  if (u.includes("/fapi/v1/premiumIndex")) return json({ markPrice: String(scenario.mark ?? 99.5) });

  if (u.includes("/fapi/v1/order")) {
    const method = u.includes("__delete") ? "DELETE" : "";
    void method;
    const params = Object.fromEntries(new URL(u).searchParams);
    if (params.type === "LIMIT") {
      placed = params;
      if (scenario.place) { const r = scenario.place(); if (r) return r as Response; }
      return json({ orderId: 1, symbol: "INTCUSDT", side: params.side, type: "LIMIT",
        origQty: params.quantity, executedQty: "0", avgPrice: "0", price: params.price, status: "NEW" });
    }
    // GET or DELETE on an existing order.
    const i = Math.min(call, scenario.statuses.length - 1);
    const status = scenario.statuses[i];
    const executed = scenario.executed?.[i] ?? (status === "FILLED" ? 100 : 0);
    call++;
    return json({ orderId: 1, symbol: "INTCUSDT", side: "BUY", type: "LIMIT",
      origQty: "100", executedQty: String(executed), avgPrice: executed > 0 ? "99.5" : "0",
      price: "99.5", status });
  }
  return json({}, 404);
}) as typeof fetch;

// DELETE and GET hit the same path, so the stub distinguishes them by call
// order rather than method; `cancelExecuted` overrides the last reply.
function withCancel(exec: number) {
  scenario.statuses = [...scenario.statuses, "CANCELED"];
  scenario.executed = [...(scenario.executed ?? []), exec];
}

async function main() {
  console.log("\n## maker entry");

  // Fills on the second poll.
  scenario = { statuses: ["NEW", "FILLED"], executed: [0, 100] }; call = 0;
  let r = await placeMakerEntry(cfg, "INTCUSDT", "BUY", "100", "99.50", { waitMs: 5000, pollMs: 10 });
  ok("a filled order reports filled", r.outcome === "filled", r.reason);
  ok("...with the fill quantity", r.filledQty === 100);
  ok("...and the average price", r.avgPrice === 99.5);
  ok("post-only was used", placed?.timeInForce === "GTX", String(placed?.timeInForce));
  ok("...as a LIMIT at the given price", placed?.type === "LIMIT" && placed?.price === "99.50");

  // Never fills, times out, cancel confirms nothing filled.
  scenario = { statuses: ["NEW", "NEW", "NEW", "CANCELED"], executed: [0, 0, 0, 0] }; call = 0;
  r = await placeMakerEntry(cfg, "INTCUSDT", "BUY", "100", "99.50", { waitMs: 60, pollMs: 20 });
  ok("an unfilled order times out", r.outcome === "unfilled", r.reason);
  ok("...with nothing filled", r.filledQty === 0);

  // Times out, but had partially filled.
  scenario = { statuses: ["NEW", "NEW", "CANCELED"], executed: [0, 0, 40] }; call = 0;
  r = await placeMakerEntry(cfg, "INTCUSDT", "BUY", "100", "99.50", { waitMs: 45, pollMs: 20 });
  ok("a partial fill is reported as partial", r.outcome === "partial", r.reason);
  ok("...with the amount that actually filled", r.filledQty === 40);

  // THE RACE: cancel is sent, but the order filled in full first.
  scenario = { statuses: ["NEW", "NEW", "FILLED"], executed: [0, 0, 100] }; call = 0;
  r = await placeMakerEntry(cfg, "INTCUSDT", "BUY", "100", "99.50", { waitMs: 45, pollMs: 20 });
  ok("a fill that beats the cancel is reported as a fill", r.outcome === "filled", r.reason);
  ok("...never as unfilled", r.filledQty === 100);

  // Price runs away from a resting buy.
  scenario = { statuses: ["NEW", "NEW", "CANCELED"], executed: [0, 0, 0], mark: 100.5 }; call = 0;
  r = await placeMakerEntry(cfg, "INTCUSDT", "BUY", "100", "99.50", { waitMs: 5000, pollMs: 10, abandonPct: 0.15 });
  ok("an order price has left behind is abandoned", r.outcome === "abandoned", r.reason);

  // ...but not for a move inside the tolerance.
  scenario = { statuses: ["NEW", "NEW", "NEW", "CANCELED"], executed: [0, 0, 0, 0], mark: 99.55 }; call = 0;
  r = await placeMakerEntry(cfg, "INTCUSDT", "BUY", "100", "99.50", { waitMs: 60, pollMs: 20, abandonPct: 0.15 });
  ok("a small move does not abandon it", r.outcome === "unfilled", r.reason);

  // Post-only rejection: Binance refused because it would have crossed.
  scenario = {
    statuses: ["NEW"],
    place: () => new Response(JSON.stringify({ code: -5022, msg: "Due to the order could not be executed as maker" }), { status: 400 }),
  }; call = 0;
  r = await placeMakerEntry(cfg, "INTCUSDT", "BUY", "100", "99.50", { waitMs: 50, pollMs: 10 });
  ok("a crossing order is refused, not filled as taker", r.outcome === "rejected", r.reason);
  ok("...and says so explicitly", r.wouldHaveCrossed);
  ok("...having filled nothing", r.filledQty === 0);

  // Any other rejection is not mislabelled as a crossing.
  scenario = {
    statuses: ["NEW"],
    place: () => new Response(JSON.stringify({ code: -2019, msg: "Margin is insufficient" }), { status: 400 }),
  }; call = 0;
  r = await placeMakerEntry(cfg, "INTCUSDT", "BUY", "100", "99.50", { waitMs: 50, pollMs: 10 });
  ok("an unrelated rejection is not called a crossing", r.outcome === "rejected" && !r.wouldHaveCrossed, r.reason);

  void withCancel; void cancelled; void realFetch;
  console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
  process.exit(fails ? 1 : 0);
}
void main();
