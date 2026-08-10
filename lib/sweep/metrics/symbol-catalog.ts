import { api } from "../binance/rest";
import { fetchTradableSymbols, hasCredentials, loadConfig } from "../exchange/binance";

/**
 * What the exchange actually lists, so a symbol can be chosen instead of typed.
 *
 * Typing a ticker is a silent failure, and the failure looks exactly like
 * success: `SWEEP_SYMBOLS` with a contract that does not exist starts an engine
 * that connects, subscribes to a stream nobody publishes, and then sits there
 * reporting itself healthy and producing no signals — indistinguishable from a
 * quiet market. `sweep:symbols` was written to answer that from the terminal.
 * This is the same question asked from the page, where the answer can be turned
 * straight into a running desk.
 *
 * Two facts about a contract matter and they come from different places:
 *
 *  - **Is it listed and liquid?** From production, because the book and the
 *    streams always come from production regardless of where orders go.
 *  - **Can this account trade it?** From the order venue, which is demo unless
 *    BINANCE_LIVE=1 — and demo lists far fewer contracts. A symbol can be
 *    perfectly real, perfectly liquid, and completely untradeable here.
 *
 * Conflating the two is how an operator ends up watching a contract for an hour
 * before discovering no order could ever have been placed on it.
 */

export interface CatalogEntry {
  symbol: string;
  baseAsset: string;
  /** Binance's own classification. "equity" is the one the models are built for. */
  kind: "equity" | "crypto";
  lastPrice: number;
  changePct: number;
  /** 24h quote volume, in USDT. The liquidity screen. */
  volumeUsd: number;
  quantityPrecision: number;
  pricePrecision: number;
  /**
   * Whether the venue receiving orders lists it. Null when that could not be
   * checked, which is not the same as false and must not be shown as false.
   */
  orderable: boolean | null;
}

export interface Catalog {
  entries: CatalogEntry[];
  /** Where orders would go, so the page can say which venue "orderable" means. */
  orderVenue: string | null;
  fetchedAt: number;
  error: string | null;
}

interface RawSymbol {
  symbol: string;
  status: string;
  contractType: string;
  baseAsset?: string;
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

/**
 * Whether a contract is an equity perp.
 *
 * `underlyingType` is Binance's field and is the authority. Kept as a positive
 * test only: the tempting fallback — "its base asset is not a crypto major, so
 * it must be a stock" — would sweep in every altcoin and label it equity, which
 * is worse than leaving the field alone, because the session model and the
 * leverage ladder are then applied to something they were never built for.
 */
function equityLike(s: RawSymbol): boolean {
  const t = `${s.underlyingType ?? ""} ${(s.underlyingSubType ?? []).join(" ")}`.toUpperCase();
  return t.includes("EQUITY") || t.includes("STOCK") || t.includes("TRADFI");
}

/*
 * Cached, because the page polls and the contract list does not change on that
 * timescale. Ten minutes is far shorter than the interval at which Binance
 * lists anything and far longer than any plausible click rate, so the operator
 * never waits on a network round trip to filter a list they are already looking
 * at.
 */
const TTL_MS = 10 * 60_000;
let cache: Catalog | null = null;
let inFlight: Promise<Catalog> | null = null;

export async function loadCatalog(force = false): Promise<Catalog> {
  const now = Date.now();
  if (!force && cache && now - cache.fetchedAt < TTL_MS) return cache;
  // Shared, so ten simultaneous searches on a cold cache make one request set
  // rather than ten. The rate limit this protects is the same one the live
  // book depends on.
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<Catalog> => {
    try {
      const [info, tickers] = await Promise.all([
        api<{ symbols: RawSymbol[] }>("/fapi/v1/exchangeInfo"),
        api<RawTicker[]>("/fapi/v1/ticker/24hr").catch(() => [] as RawTicker[]),
      ]);
      const byTicker = new Map((Array.isArray(tickers) ? tickers : []).map((t) => [t.symbol, t]));

      let orderable: Set<string> | null = null;
      let orderVenue: string | null = null;
      if (hasCredentials()) {
        try {
          const cfg = loadConfig();
          orderVenue = cfg.baseUrl;
          orderable = await fetchTradableSymbols(cfg);
        } catch {
          // Left null rather than empty. An unreachable venue means "unknown",
          // and rendering unknown as "cannot trade this" would hide every
          // contract behind a transient network error.
          orderable = null;
        }
      }

      const entries: CatalogEntry[] = (info.symbols ?? [])
        .filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING")
        .map((s) => {
          const t = byTicker.get(s.symbol);
          return {
            symbol: s.symbol,
            baseAsset: s.baseAsset ?? s.symbol.replace(/USDT$/, ""),
            kind: equityLike(s) ? ("equity" as const) : ("crypto" as const),
            lastPrice: Number(t?.lastPrice ?? 0),
            changePct: Number(t?.priceChangePercent ?? 0),
            volumeUsd: Number(t?.quoteVolume ?? 0),
            quantityPrecision: s.quantityPrecision,
            pricePrecision: s.pricePrecision,
            orderable: orderable ? orderable.has(s.symbol) : null,
          };
        })
        // Busiest first. On a thin contract the whole premise — that withdrawn
        // depth is informative — has nothing to measure, so volume is the right
        // default order for a list someone is picking from.
        .sort((a, b) => b.volumeUsd - a.volumeUsd);

      cache = { entries, orderVenue, fetchedAt: Date.now(), error: null };
      return cache;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A stale catalog beats no catalog: the list barely changes, and refusing
      // to show one because a refresh failed turns a slow network into a broken
      // picker.
      if (cache) return { ...cache, error: message };
      cache = { entries: [], orderVenue: null, fetchedAt: Date.now(), error: message };
      return cache;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Search by ticker or company-ish fragment.
 *
 * Equity perps sort ahead of crypto at equal relevance because they are what
 * the models here are calibrated for — but crypto is never filtered out, since
 * pointing at BTCUSDT to prove the order path works is a legitimate and
 * frequently-used thing to do.
 */
export function searchCatalog(catalog: Catalog, query: string, limit = 20): CatalogEntry[] {
  const q = query.trim().toUpperCase();
  const scored = catalog.entries
    .map((e) => {
      let score = -1;
      if (!q) score = 0;
      else if (e.symbol === q) score = 100;
      else if (e.baseAsset === q) score = 90;
      else if (e.symbol.startsWith(q) || e.baseAsset.startsWith(q)) score = 60;
      else if (e.symbol.includes(q)) score = 30;
      if (score < 0) return null;
      // Equity first, then volume — expressed as a small bonus rather than a
      // separate sort so an exact crypto match still outranks a loose equity one.
      return { e, score: score + (e.kind === "equity" ? 5 : 0) };
    })
    .filter((x): x is { e: CatalogEntry; score: number } => x !== null);

  scored.sort((a, b) => b.score - a.score || b.e.volumeUsd - a.e.volumeUsd);
  return scored.slice(0, limit).map((x) => x.e);
}

/** One contract, or null when the exchange does not list it. */
export function findContract(catalog: Catalog, symbol: string): CatalogEntry | null {
  const want = symbol.trim().toUpperCase();
  return catalog.entries.find((e) => e.symbol === want) ?? null;
}
