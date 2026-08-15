/**
 * A drifted clock must not be able to stop trading silently.
 *
 * Binance rejects a signed request whose timestamp is more than `recvWindow`
 * from its own clock, with -1021. The rejection happens below the strategy, so
 * nothing is tallied as a refusal and the signal count keeps climbing — an
 * agent reporting armed, healthy and warm, placing no orders, indistinguishable
 * from a quiet market. The code recognised the error code and turned it into a
 * helpful sentence for a human, which is not a fix.
 */
import { createServer } from "node:http";
import { syncClock, clockState, signedRequest } from "../lib/sweep/exchange/binance";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`  ok — ${name}`);
};

/** A venue whose clock is deliberately wrong, and which enforces recvWindow. */
function fakeVenue(skewMs: number, windowMs: number) {
  let rejections = 0;
  let accepted = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/fapi/v1/time") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ serverTime: Date.now() + skewMs }));
      return;
    }
    const ts = Number(url.searchParams.get("timestamp"));
    const theirNow = Date.now() + skewMs;
    if (!Number.isFinite(ts) || Math.abs(theirNow - ts) > windowMs) {
      rejections++;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: -1021, msg: "Timestamp for this request was outside of the recvWindow." }));
      return;
    }
    accepted++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  return { server, stats: () => ({ rejections, accepted }) };
}

async function main() {
  console.log("clock drift");
  // Eight seconds of skew against a five-second window: every request fails
  // uncorrected, and every request succeeds corrected.
  const { server, stats } = fakeVenue(8_000, 5_000);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const cfg = {
    apiKey: "k", apiSecret: "s", baseUrl: `http://127.0.0.1:${port}`,
    recvWindowMs: 5_000, live: false,
  } as unknown as Parameters<typeof syncClock>[0];

  const offset = await syncClock(cfg);
  ok("the offset is measured", Math.abs(offset - 8_000) < 500, `${offset}ms`);
  ok("and reported", Math.abs(clockState().offsetMs - 8_000) < 500, JSON.stringify(clockState()));

  const res = await signedRequest<{ ok: boolean }>(cfg, "GET", "/fapi/v1/order");
  ok("a signed request succeeds against a skewed venue", res.ok === true);
  ok("without needing the retry", stats().rejections === 0, `${stats().rejections} rejections`);

  server.close();
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\nall good");
}

main();
