/** Exercises the proxy route handler directly — no server, no network. */
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.CRON_SECRET ??= "dummy";

import { GET } from "../app/api/sweep/binance/[...path]/route";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; } else console.log(`ok   ${msg}`);
}

const upstream: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  upstream.push(String(input));
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const call = (url: string, path: string[]) =>
  GET(new Request(url), { params: Promise.resolve({ path }) });

async function main() {
  // --- cache-busting parameters are dropped -------------------------------
  upstream.length = 0;
  await call("https://x.dev/api/sweep/binance/fapi/v1/openInterest?symbol=INTCUSDT&_=93417", ["fapi", "v1", "openInterest"]);
  assert(upstream.length === 1, "one upstream call");
  assert(!upstream[0].includes("_="), `the cache-buster is stripped (${upstream[0]})`);
  assert(upstream[0].includes("symbol=INTCUSDT"), "the real parameter survives");

  // two different busters must produce one identical upstream URL
  upstream.length = 0;
  await call("https://x.dev/?symbol=INTCUSDT&junk=a", ["fapi", "v1", "openInterest"]);
  await call("https://x.dev/?symbol=INTCUSDT&junk=b", ["fapi", "v1", "openInterest"]);
  assert(upstream[0] === upstream[1], "distinct junk collapses to one cache key");

  // --- limit is clamped ----------------------------------------------------
  upstream.length = 0;
  await call("https://x.dev/?symbol=INTCUSDT&limit=99999", ["fapi", "v1", "depth"]);
  assert(upstream[0].includes("limit=1000"), `limit is clamped (${upstream[0]})`);

  upstream.length = 0;
  await call("https://x.dev/?symbol=INTCUSDT&limit=abc", ["fapi", "v1", "depth"]);
  assert(!upstream[0].includes("limit="), "a non-numeric limit is dropped");

  // --- parameter ordering is canonical ------------------------------------
  upstream.length = 0;
  await call("https://x.dev/?limit=500&symbol=INTCUSDT", ["fapi", "v1", "depth"]);
  const a = upstream[0];
  upstream.length = 0;
  await call("https://x.dev/?symbol=INTCUSDT&limit=500", ["fapi", "v1", "depth"]);
  assert(a === upstream[0], "parameter order does not fork the cache");

  // --- injection attempts --------------------------------------------------
  upstream.length = 0;
  await call("https://x.dev/?symbol=" + encodeURIComponent("INTC&apiKey=x"), ["fapi", "v1", "openInterest"]);
  assert(!upstream[0].includes("apiKey"), `a smuggled parameter is rejected (${upstream[0]})`);

  // --- allowlist still holds ----------------------------------------------
  const denied = await call("https://x.dev/", ["fapi", "v1", "order"]);
  assert(denied.status === 404, "an unlisted path is refused");

  // --- caching headers -----------------------------------------------------
  const ok = await call("https://x.dev/?symbol=INTCUSDT", ["fapi", "v1", "exchangeInfo"]);
  assert(
    (ok.headers.get("cache-control") ?? "").includes("s-maxage=300"),
    `metadata is cached long (${ok.headers.get("cache-control")})`,
  );

  // --- upstream 429 is passed through, not cached as data ------------------
  globalThis.fetch = (async () =>
    new Response("{}", { status: 429, headers: { "retry-after": "30", "content-type": "application/json" } })) as typeof fetch;
  const limited = await call("https://x.dev/?symbol=INTCUSDT", ["fapi", "v1", "depth"]);
  assert(limited.status === 429, "a 429 is passed through");
  assert(limited.headers.get("retry-after") === "30", "Retry-After survives");

  // --- upstream 5xx is never cached ---------------------------------------
  globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
  const bad = await call("https://x.dev/?symbol=INTCUSDT", ["fapi", "v1", "depth"]);
  assert(bad.headers.get("cache-control") === "no-store", "a 5xx is not cached");

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
