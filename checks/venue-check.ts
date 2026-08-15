import { fetchTradableSymbols } from "@/lib/sweep/exchange/binance";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

const cfg = (baseUrl: string) => ({ apiKey: "k", apiSecret: "s", baseUrl, live: false, recvWindowMs: 5000 });

// A server that answers the way each real failure mode does.
import { createServer } from "node:http";
const routes: Record<string, [number, string]> = {
  "/good": [200, JSON.stringify({ symbols: [
    { symbol: "BTCUSDT", status: "TRADING" },
    { symbol: "ETHUSDT", status: "TRADING" },
    { symbol: "OLDUSDT", status: "SETTLING" },
  ] })],
  "/empty": [200, JSON.stringify({ symbols: [] })],
  "/noshape": [200, JSON.stringify({ serverTime: 1 })],
  "/deny": [451, "unavailable for legal reasons"],
};
const srv = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname.replace("/fapi/v1/exchangeInfo", "");
  const [code, body] = routes[path] ?? [404, "no"];
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
});

async function main(){
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
const port = (srv.address() as { port: number }).port;
const base = (p: string) => `http://127.0.0.1:${port}${p}`;

console.log("\n## reading the order venue's contract list");
{
  const s = await fetchTradableSymbols(cfg(base("/good")));
  ok("it returns the trading symbols", s.has("BTCUSDT") && s.has("ETHUSDT"), [...s].join(","));
  ok("...and excludes anything not TRADING", !s.has("OLDUSDT"));
  ok("...so a missing contract reads as missing", !s.has("SNDKUSDT"));
}

console.log("\n## it refuses to answer when it cannot");
for (const [path, label] of [["/empty", "an empty list"], ["/noshape", "an unexpected shape"], ["/deny", "a 451"]] as const) {
  let threw = false;
  try { await fetchTradableSymbols(cfg(base(path))); } catch { threw = true; }
  // Every one of these must throw rather than return an empty set: an empty
  // set would read as "nothing is tradeable" and block everything, and a
  // silent pass would be worse still.
  ok(`${label} throws rather than guessing`, threw);
}

  srv.close();
console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);

}
main();
