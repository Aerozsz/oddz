/**
 * Verifies the two properties that protect the shared proxy IP:
 *   1. a 429 does NOT fail over to the other route
 *   2. while the cooldown is live, no further request reaches the network
 */
import { RateLimited, api, rateLimitCooldownMs } from "../lib/sweep/binance/rest";

// Headless, the proxy route exists only with an explicit origin. The failover
// assertions below need both routes to be reachable.
process.env.SWEEP_PROXY_ORIGIN = "https://oddz-ruby.vercel.app";

let calls: string[] = [];

function mockFetch(status: number, retryAfter?: string) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const headers = new Headers({ "content-type": "application/json" });
    if (retryAfter) headers.set("retry-after", retryAfter);
    return new Response(JSON.stringify({ code: -1003, msg: "Too many requests" }), {
      status,
      headers,
    });
  }) as typeof fetch;
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   ${msg}`);
  }
}

async function main() {
  // --- 429 must not fail over to the second route -------------------------
  mockFetch(429, "2");
  calls = [];
  let err: unknown;
  try {
    await api("/fapi/v1/depth", { symbol: "INTCUSDT", limit: 1000 });
  } catch (e) {
    err = e;
  }
  assert(err instanceof RateLimited, "429 surfaces as RateLimited");
  assert(calls.length === 1, `429 hits exactly one route (got ${calls.length}: ${calls.join(", ")})`);

  // --- the throttled route stays parked; the other one may still be used --
  calls = [];
  let err2: unknown;
  try {
    await api("/fapi/v1/depth", { symbol: "INTCUSDT", limit: 1000 });
  } catch (e) {
    err2 = e;
  }
  assert(err2 instanceof RateLimited, "second call still reports RateLimited");
  assert(
    !calls.some((c) => c.startsWith("https://fapi.binance.com")),
    `the throttled route is not retried while cooling (${calls.join(", ") || "no calls"})`,
  );
  assert(rateLimitCooldownMs() > 0, `cooldown is reported as active (${rateLimitCooldownMs()}ms)`);

  // --- once every route is cooling, nothing reaches the network at all ----
  calls = [];
  let err3: unknown;
  try {
    await api("/fapi/v1/depth", { symbol: "INTCUSDT", limit: 1000 });
  } catch (e) {
    err3 = e;
  }
  assert(err3 instanceof RateLimited, "both routes cooling still reports RateLimited");
  assert(calls.length === 0, `both routes cooling blocks the network (extra calls: ${calls.length})`);

  // --- an ordinary error DOES fail over to the other route ----------------
  await new Promise((r) => setTimeout(r, 2100)); // let the 2s Retry-After lapse
  mockFetch(500);
  calls = [];
  try {
    await api("/fapi/v1/depth", { symbol: "INTCUSDT", limit: 1000 });
  } catch {
    /* expected */
  }
  assert(calls.length === 2, `a 5xx still tries both routes (got ${calls.length})`);
  assert(
    calls.some((c) => c.startsWith("https://fapi.binance.com")) && calls.some((c) => c.includes("/api/sweep")),
    "failover covers direct and proxy",
  );
}

void main();
