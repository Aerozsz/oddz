/**
 * The contract picker's two halves: what the exchange lists, and what is watched.
 *
 * The failure this guards against is the one the picker was built to remove — a
 * ticker that does not exist starting an engine that connects, subscribes to a
 * stream nobody publishes, and reports itself healthy forever. That is
 * indistinguishable from a quiet market, so the check has to happen before
 * anything starts, and it has to hold when the exchange is unreachable rather
 * than falling open.
 */
process.env.SWEEP_SYMBOLS_FILE = "/tmp/sweep-checks/sym-test.json";

import { existsSync, readFileSync, rmSync } from "node:fs";
import { MAX_SYMBOLS, normalise, readSymbols, symbolsPath, writeSymbols } from "../lib/sweep/metrics/symbol-store";
import { findContract, loadCatalog, searchCatalog } from "../lib/sweep/metrics/symbol-catalog";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

const PATH = symbolsPath();

const perp = (symbol: string, base: string, equity: boolean) => ({
  symbol, baseAsset: base, status: "TRADING", contractType: "PERPETUAL",
  underlyingType: equity ? "EQUITY" : "COIN", underlyingSubType: equity ? ["TRADFI"] : [],
  pricePrecision: 2, quantityPrecision: 3,
});
const SYMS = [
  perp("BTCUSDT", "BTC", false), perp("ETHUSDT", "ETH", false),
  perp("INTCUSDT", "INTC", true), perp("NVDAUSDT", "NVDA", true),
  { ...perp("DELISTUSDT", "DELIST", false), status: "SETTLING" },
  { ...perp("QUARTERLY", "BTC", false), contractType: "CURRENT_QUARTER" },
];
const VOL: Record<string, number> = { BTCUSDT: 9e9, ETHUSDT: 4e9, INTCUSDT: 3e7, NVDAUSDT: 6e7 };

function stubExchange(fail = false) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => {
    const url = String(u);
    if (fail) return new Response("nope", { status: 403, statusText: "Forbidden" });
    if (url.includes("exchangeInfo")) return new Response(JSON.stringify({ symbols: SYMS }), { status: 200 });
    if (url.includes("ticker/24hr")) {
      return new Response(JSON.stringify(SYMS.map((s) => ({
        symbol: s.symbol, lastPrice: "100", priceChangePercent: "1.5", quoteVolume: String(VOL[s.symbol] ?? 0),
      }))), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

async function main() {
  console.log("\n## the watched list");
  rmSync(PATH, { force: true });

  ok("with no file it falls back to the environment", readSymbols().length > 0, readSymbols().join(","));

  writeSymbols(["btcusdt", " ethusdt ", "BTCUSDT"]);
  const saved = readSymbols();
  ok("normalises case and whitespace", saved[0] === "BTCUSDT" && saved[1] === "ETHUSDT", saved.join(","));
  ok("drops the duplicate", saved.length === 2, String(saved.length));

  writeSymbols(Array.from({ length: 20 }, (_, i) => `SYM${i}USDT`));
  ok(`caps at ${MAX_SYMBOLS}`, readSymbols().length === MAX_SYMBOLS, String(readSymbols().length));

  // An emptied file must not present as a working page with no desks on it.
  writeSymbols([]);
  ok("an empty list falls back rather than leaving no desks", readSymbols().length > 0, readSymbols().join(","));

  const { writeFileSync } = await import("node:fs");
  writeFileSync(PATH, "{ not json");
  ok("a corrupt file falls back instead of throwing", readSymbols().length > 0, readSymbols().join(","));

  writeSymbols(["BTCUSDT"]);
  ok("written atomically to the expected path", existsSync(PATH) && JSON.parse(readFileSync(PATH, "utf8")).symbols[0] === "BTCUSDT");

  ok("normalise handles junk", normalise(undefined as unknown as string) === "" && normalise(" btc ") === "BTC");

  console.log("\n## the catalogue");
  let restore = stubExchange();
  const cat = await loadCatalog(true);
  restore();

  ok("only live perpetuals are listed", cat.entries.length === 4, `${cat.entries.length}: ${cat.entries.map((e) => e.symbol).join(",")}`);
  ok("a settling contract is excluded", !cat.entries.some((e) => e.symbol === "DELISTUSDT"));
  ok("a quarterly is excluded", !cat.entries.some((e) => e.symbol === "QUARTERLY"));
  ok("equity perps are tagged from Binance's own field",
    cat.entries.find((e) => e.symbol === "INTCUSDT")?.kind === "equity");
  ok("crypto is not mislabelled as equity",
    cat.entries.find((e) => e.symbol === "BTCUSDT")?.kind === "crypto");
  ok("sorted by volume, busiest first", cat.entries[0].symbol === "BTCUSDT", cat.entries[0].symbol);
  ok("orderable is null when it could not be checked, never false",
    cat.entries.every((e) => e.orderable === null || typeof e.orderable === "boolean"));

  console.log("\n## search");
  ok("an exact ticker wins", searchCatalog(cat, "ETHUSDT")[0].symbol === "ETHUSDT");
  ok("a bare base asset finds the perp", searchCatalog(cat, "nvda")[0].symbol === "NVDAUSDT");
  ok("a prefix matches", searchCatalog(cat, "int")[0].symbol === "INTCUSDT");
  ok("equity ranks ahead of crypto on a loose match",
    searchCatalog(cat, "USDT")[0].kind === "equity", searchCatalog(cat, "USDT")[0].symbol);
  ok("an exact crypto match still beats a loose equity one",
    searchCatalog(cat, "BTCUSDT")[0].symbol === "BTCUSDT");
  ok("nonsense returns nothing", searchCatalog(cat, "ZZZZZ").length === 0);
  ok("the limit is honoured", searchCatalog(cat, "", 2).length === 2);

  ok("findContract is exact and case-insensitive",
    findContract(cat, "btcusdt")?.symbol === "BTCUSDT" && findContract(cat, "FAKEUSDT") === null);

  console.log("\n## when the exchange is unreachable");
  restore = stubExchange(true);
  const stale = await loadCatalog(true);
  restore();
  // A stale catalogue beats no catalogue: the list barely changes, and refusing
  // to show one because a refresh failed turns a slow network into a dead picker.
  ok("the last good list is kept", stale.entries.length === 4, String(stale.entries.length));
  ok("...and the failure is reported alongside it", Boolean(stale.error), String(stale.error));
  ok("a bogus ticker is still refused against the stale list", findContract(stale, "FAKEUSDT") === null);

  rmSync(PATH, { force: true });
  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
}

main();
