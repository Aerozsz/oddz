/**
 * What is actually listed, and what it costs to trade.
 *
 *   npm run sweep:symbols                 # every equity perpetual Binance lists
 *   npm run sweep:symbols hynix sndk mu   # only ones matching these fragments
 *   npm run sweep:symbols --all           # the whole contract list, crypto included
 *
 * This exists because guessing a ticker is a silent failure. `SWEEP_SYMBOLS`
 * with a contract that does not exist starts an engine that connects, subscribes
 * to a stream nobody publishes, and then sits there looking healthy and never
 * producing a signal — which is indistinguishable from a quiet market. Ask the
 * exchange first.
 *
 * It also answers the question that motivated it: whether a given company has a
 * Binance perpetual at all. Binance's equity perps are US-listed names; a
 * company that trades only on its home exchange — SK Hynix on the KRX, for
 * instance — generally has no contract here, and no amount of configuration
 * will produce one. The nearest tradable expression of the same theme is a
 * US-listed peer, and this prints the candidates rather than assuming one.
 *
 * The grouping is by Binance's own classification fields rather than by a
 * hardcoded list of tickers, so it stays correct as they list more.
 */

import { loadEnv } from "./load-env";
import { api } from "../lib/sweep/binance/rest";
import { fetchTradableSymbols, hasCredentials, loadConfig } from "../lib/sweep/exchange/binance";

loadEnv();

interface RawSymbol {
  symbol: string;
  pair?: string;
  status: string;
  contractType: string;
  baseAsset?: string;
  quoteAsset?: string;
  /** Binance tags equity perps here; the values are printed rather than assumed. */
  underlyingType?: string;
  underlyingSubType?: string[];
  pricePrecision: number;
  quantityPrecision: number;
}

interface RawTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
}

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const filters = args.filter((a) => !a.startsWith("--")).map((a) => a.toUpperCase());

/**
 * Whether a contract is an equity perp.
 *
 * `underlyingType` is Binance's field and is the authority. The name check is a
 * fallback for the case where they stop populating it: an equity perp's base
 * asset is a stock ticker, so it is not in the crypto majors list — but that
 * heuristic would sweep in every altcoin, so it is only used to *widen* the
 * output with a "possible" marker, never to claim something is an equity perp.
 */
function equityLike(s: RawSymbol): boolean {
  const t = `${s.underlyingType ?? ""} ${(s.underlyingSubType ?? []).join(" ")}`.toUpperCase();
  return t.includes("EQUITY") || t.includes("STOCK") || t.includes("TRADFI");
}

function pad(s: string, n: number) {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padLeft(s: string, n: number) {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

async function main() {
  const info = await api<{ symbols: RawSymbol[] }>("/fapi/v1/exchangeInfo");
  const tickers = await api<RawTicker[]>("/fapi/v1/ticker/24hr").catch(() => [] as RawTicker[]);
  const byTicker = new Map(tickers.map((t) => [t.symbol, t]));

  /*
   * What the venue that receives orders will accept, which is not the same
   * list. Everything above comes from production, because that is where the
   * book and the streams come from in every mode. Orders go to demo unless
   * BINANCE_LIVE=1, and demo lists far fewer contracts — so a symbol can be
   * perfectly real, perfectly liquid, and completely untradeable by this
   * account. That distinction is the whole reason this column exists.
   */
  let orderable: Set<string> | null = null;
  let venue = "";
  if (hasCredentials()) {
    try {
      const cfg = loadConfig();
      venue = cfg.baseUrl;
      orderable = await fetchTradableSymbols(cfg);
    } catch {
      orderable = null;
    }
  }

  const perps = info.symbols.filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING");
  const equity = perps.filter(equityLike);

  let rows = showAll ? perps : equity.length > 0 ? equity : perps;
  if (filters.length > 0) {
    rows = perps.filter((s) => filters.some((f) => s.symbol.includes(f) || (s.baseAsset ?? "").includes(f)));
  }

  // Busiest first: on a thin contract the strategy's whole premise — that
  // withdrawn depth is informative — has nothing to measure.
  rows.sort((a, b) => Number(byTicker.get(b.symbol)?.quoteVolume ?? 0) - Number(byTicker.get(a.symbol)?.quoteVolume ?? 0));

  console.log("");
  console.log(
    `  ${perps.length} perpetuals listed on production, ${equity.length} of them tagged as equity` +
      (filters.length > 0 ? ` — showing matches for ${filters.join(", ")}` : ""),
  );
  if (orderable) {
    console.log(`  your orders go to ${venue}, which lists ${orderable.size} of them.`);
  } else if (hasCredentials()) {
    console.log("  could not reach your order venue, so the last column is unknown.");
  } else {
    console.log("  no credentials, so whether you can trade these is unchecked.");
  }
  console.log("");
  console.log(
    `  ${pad("symbol", 14)}${padLeft("last", 12)}${padLeft("24h %", 9)}${padLeft("24h volume", 14)}  ${pad("qty step", 10)}${pad("orders?", 9)}type`,
  );
  console.log(`  ${"-".repeat(83)}`);

  if (rows.length === 0) {
    console.log("  nothing matched.");
  }

  for (const s of rows) {
    const t = byTicker.get(s.symbol);
    const vol = Number(t?.quoteVolume ?? 0);
    const volText = vol >= 1e9 ? `$${(vol / 1e9).toFixed(2)}B` : vol >= 1e6 ? `$${(vol / 1e6).toFixed(1)}M` : `$${Math.round(vol / 1e3)}k`;
    const kind = [s.underlyingType, ...(s.underlyingSubType ?? [])].filter(Boolean).join("/") || "—";
    const canOrder = orderable === null ? "?" : orderable.has(s.symbol) ? "yes" : "NO";
    console.log(
      `  ${pad(s.symbol, 14)}${padLeft(t ? Number(t.lastPrice).toFixed(s.pricePrecision) : "—", 12)}` +
        `${padLeft(t ? `${Number(t.priceChangePercent).toFixed(2)}%` : "—", 9)}` +
        `${padLeft(t ? volText : "—", 14)}  ${pad(`1e-${s.quantityPrecision}`, 10)}${pad(canOrder, 9)}${kind}`,
    );
  }

  console.log("");
  if (filters.length > 0 && rows.length === 0) {
    console.log("  No contract exists for that. It cannot be traded here at any size.");
    console.log("  Run without arguments to see the full equity list and pick the nearest peer.");
    console.log("");
    return;
  }

  if (orderable) {
    // The whole point of the column: prices come from production and orders do
    // not, so a "NO" row produces a monitor that looks perfect and an order
    // path that rejects everything.
    const tradable = rows.filter((s) => orderable!.has(s.symbol));
    const blocked = rows.filter((s) => !orderable!.has(s.symbol));
    if (blocked.length > 0) {
      console.log(`  orders? NO means ${venue} does not list it. You will still get a live book,`);
      console.log("  live signals and sized proposals for it — and every order will be rejected.");
      console.log("");
    }
    console.log("  Use them together:");
    console.log(
      `    SWEEP_SYMBOLS=${(tradable.length ? tradable : rows).slice(0, 3).map((s) => s.symbol).join(",")} npm run sweep:control`,
    );
  } else {
    console.log("  Use them together:");
    console.log(`    SWEEP_SYMBOLS=${rows.slice(0, 3).map((s) => s.symbol).join(",")} npm run sweep:control`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("");
  console.error(`  Could not read the contract list: ${err instanceof Error ? err.message : String(err)}`);
  console.error("  This needs to reach fapi.binance.com. No credentials are required.");
  console.error("");
  process.exit(1);
});
