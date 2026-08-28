import { FAPI_REST, REST_PROXY, SYMBOL } from "../config";
import type { Kline, SymbolMeta } from "../types";

/**
 * The contract a call is about.
 *
 * Every function here takes an optional symbol and falls back to the configured
 * one, so a single-symbol caller is unchanged while several engines can run
 * side by side against different contracts.
 */
const sym = (s?: string) => s ?? SYMBOL;

/**
 * REST is used only for things that have no stream: the initial book snapshot
 * required to sync the diff feed, contract metadata, historical klines, and
 * open interest. Price, book updates, trades and liquidations all arrive over
 * WebSocket — nothing on the live path is polled.
 *
 * Requests go to Binance directly from the browser first. Binance serves
 * `Access-Control-Allow-Origin: *` on fapi, so that works from most places and
 * keeps the data path free of our own infrastructure. Where it doesn't work —
 * a region Binance refuses, or a network that blocks the host — we fall back
 * once to a same-origin proxy route and remember the choice.
 */

type Route = "direct" | "proxy";

let route: Route | null = null;
const listeners = new Set<(r: Route) => void>();

/**
 * Binance rate limits by IP, and answers an exhausted limit with 429 and then
 * 418 — an IP ban that escalates from two minutes to three days if you keep
 * knocking. Both routes are tracked separately because they are different IPs:
 * "direct" is the visitor's own, "proxy" is one Vercel egress address shared by
 * every visitor at once.
 *
 * The policy that asymmetry buys:
 *
 *  - A rate limit never fails over *within the same call*. Retrying immediately
 *    on the other address turns one throttled IP into two, so the error is
 *    raised instead and the caller is expected to back off.
 *  - The throttled route is then parked until its cooldown expires. A later
 *    call may legitimately use the other route — otherwise a throttled visitor
 *    just gets a dead page.
 *  - Falling back onto the shared address is affordable only because the proxy
 *    is CDN-cached per path, so any number of visitors arriving at once
 *    collapses into roughly one upstream call. That cache is what keeps a
 *    crowd on the fallback route from spending the shared budget; without it
 *    this policy would be unsafe.
 */
export class RateLimited extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number,
  ) {
    super(`rate limited (${status}) — retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "RateLimited";
  }
}

const cooldownUntil: Record<Route, number> = { direct: 0, proxy: 0 };

function coolingDown(r: Route) {
  return Date.now() < cooldownUntil[r];
}

/**
 * Milliseconds until some route is usable again; 0 when one already is.
 *
 * Only routes that exist here are counted. Headless without a configured proxy
 * origin there is just the direct one, and taking the minimum across both would
 * read the permanently-zero proxy slot as "a route is available" and report no
 * throttling at all — while the only route in use was parked.
 */
export function rateLimitCooldownMs(): number {
  const routes: Route[] = proxyBase() === null ? ["direct"] : ["direct", "proxy"];
  const soonest = Math.min(...routes.map((r) => cooldownUntil[r]));
  return Math.max(0, soonest - Date.now());
}

export function onRouteChange(cb: (r: Route) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function currentRoute(): Route | "unknown" {
  return route ?? "unknown";
}

function setRoute(r: Route) {
  if (route === r) return;
  route = r;
  for (const cb of listeners) cb(r);
}

/**
 * Where the proxy route lives, or null when it cannot be reached from here.
 *
 * REST_PROXY is same-origin and therefore relative, which resolves only in a
 * browser. A headless runner has no origin, so `fetch("/api/...")` throws
 * "Failed to parse URL" before any request is made — and because that happens
 * inside the fallback path, it surfaces as a confusing parse error at the
 * moment the direct route is already in trouble.
 *
 * Outside a browser the proxy is therefore used only when an absolute origin is
 * configured, and otherwise reported as unavailable so the caller stays on the
 * direct route rather than failing over into something that cannot work.
 */
function proxyBase(): string | null {
  if (typeof window !== "undefined") return REST_PROXY;
  const origin =
    typeof process !== "undefined" ? process.env.SWEEP_PROXY_ORIGIN?.replace(/\/+$/, "") : undefined;
  return origin ? `${origin}${REST_PROXY}` : null;
}

function url(base: Route, path: string, params: Record<string, string | number>) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  const prefix = base === "direct" ? FAPI_REST : proxyBase();
  if (prefix === null) throw new Error("proxy route unavailable (set SWEEP_PROXY_ORIGIN to enable it)");
  return `${prefix}${path}${qs ? `?${qs}` : ""}`;
}

async function attempt(base: Route, path: string, params: Record<string, string | number>) {
  const res = await fetch(url(base, path, params), {
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (res.status === 429 || res.status === 418) {
    // Retry-After is in seconds when Binance sends one at all. The floor keeps
    // a missing or nonsensical header from turning into an instant retry.
    const header = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(header) && header > 0 ? header * 1000 : 60_000;
    cooldownUntil[base] = Date.now() + wait;
    throw new RateLimited(res.status, wait);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function api<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const preferred: Route[] = route ? [route, route === "direct" ? "proxy" : "direct"] : ["direct", "proxy"];
  const usable = proxyBase() === null ? preferred.filter((r) => r !== "proxy") : preferred;
  const order = usable.filter((r) => !coolingDown(r));
  if (order.length === 0) {
    throw new RateLimited(429, rateLimitCooldownMs());
  }

  let lastError: unknown;
  for (const base of order) {
    try {
      const data = await attempt(base, path, params);
      setRoute(base);
      return data as T;
    } catch (err) {
      lastError = err;
      // A rate limit says the address is spent, not that the route is broken.
      // Failing over here would move the load onto the other IP and get that
      // one throttled too, so stop and let the caller back off instead.
      if (err instanceof RateLimited) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

interface RawFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
}

interface RawSymbol {
  symbol: string;
  status: string;
  contractType: string;
  pricePrecision: number;
  quantityPrecision: number;
  filters: RawFilter[];
}

export async function fetchMeta(symbol?: string): Promise<SymbolMeta> {
  const data = await api<{ symbols: RawSymbol[] }>("/fapi/v1/exchangeInfo");
  const s = data.symbols.find((x) => x.symbol === sym(symbol));
  if (!s) throw new Error(`${sym(symbol)} is not listed on USDⓈ-M futures`);
  const price = s.filters.find((f) => f.filterType === "PRICE_FILTER");
  const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
  return {
    symbol: s.symbol,
    tickSize: Number(price?.tickSize ?? 0.01),
    stepSize: Number(lot?.stepSize ?? 0.01),
    pricePrecision: s.pricePrecision,
    quantityPrecision: s.quantityPrecision,
    status: s.status,
    contractType: s.contractType,
  };
}

export interface DepthSnapshot {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

export function fetchDepthSnapshot(limit = 1000, symbol?: string) {
  return api<DepthSnapshot>("/fapi/v1/depth", { symbol: sym(symbol), limit });
}

type RawKline = [number, string, string, string, string, string, number, string, ...unknown[]];

export async function fetchKlines(interval: string, limit: number, symbol?: string): Promise<Kline[]> {
  const rows = await api<RawKline[]>("/fapi/v1/klines", { symbol: sym(symbol), interval, limit });
  return rows.map((r) => ({
    openTime: r[0],
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    quoteVolume: Number(r[7]),
    closed: true,
  }));
}

/**
 * Recent aggregated prints, over REST.
 *
 * The tape normally arrives on the WebSocket, and against this account it does
 * not: five separate sockets to fstream, the one carrying depth delivering
 * 124,362 frames while the four carrying aggTrade, forceOrder, markPrice and
 * kline sat open and silent, with the subscription acknowledged. That is not
 * something the client can fix, and klines already come this way for the same
 * reason — which is why volatility survived a dead kline stream and the trade
 * tape did not.
 *
 * `fromId` continues from the last print already seen, so a poll returns only
 * what is new and prints are neither duplicated nor skipped. Without it the
 * endpoint returns the most recent window, which double-counts every overlap.
 */
export async function fetchAggTrades(
  opts: { fromId?: number; limit?: number; symbol?: string } = {},
): Promise<{ id: number; price: number; qty: number; t: number; buyerIsMaker: boolean }[]> {
  const params: Record<string, string | number> = {
    symbol: sym(opts.symbol),
    limit: opts.limit ?? 1000,
  };
  if (typeof opts.fromId === "number") params.fromId = opts.fromId;
  const rows = await api<{ a: number; p: string; q: string; T: number; m: boolean }[]>(
    "/fapi/v1/aggTrades",
    params,
  );
  return rows.map((r) => ({
    id: r.a,
    price: Number(r.p),
    qty: Number(r.q),
    t: r.T,
    buyerIsMaker: r.m,
  }));
}

export async function fetchOpenInterest(symbol?: string): Promise<{ qty: number; t: number }> {
  const d = await api<{ openInterest: string; time: number }>("/fapi/v1/openInterest", {
    symbol: sym(symbol),
  });
  return { qty: Number(d.openInterest), t: d.time };
}

/**
 * Settled funding rates, oldest first.
 *
 * Only history: the rate for the *next* settlement arrives continuously on the
 * mark-price stream. This exists so the live rate can be placed against its own
 * distribution — an absolute rate says nothing without knowing what is normal
 * for the contract — and so the settlement interval can be inferred from
 * consecutive timestamps rather than assumed to be eight hours.
 */
export async function fetchFundingHistory(limit = 200, symbol?: string): Promise<{ time: number; rate: number }[]> {
  try {
    const rows = await api<{ fundingTime: number; fundingRate: string }[]>("/fapi/v1/fundingRate", {
      symbol: sym(symbol),
      limit,
    });
    return rows
      .map((r) => ({ time: Number(r.fundingTime), rate: Number(r.fundingRate) }))
      .filter((r) => Number.isFinite(r.time) && Number.isFinite(r.rate))
      .sort((a, b) => a.time - b.time);
  } catch {
    // Absent, funding still reports the live rate — it just cannot say whether
    // that rate is unusual, and `stretched` stays false rather than guessing.
    return [];
  }
}

/**
 * Account-level long/short skew. Used only to split the modelled liquidation
 * ladder between the two sides; absent, the ladder assumes an even book.
 */
export async function fetchLongShortRatio(symbol?: string): Promise<number | null> {
  try {
    const rows = await api<{ longShortRatio: string }[]>(
      "/futures/data/globalLongShortAccountRatio",
      { symbol: sym(symbol), period: "5m", limit: 1 },
    );
    const v = Number(rows.at(-1)?.longShortRatio);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
