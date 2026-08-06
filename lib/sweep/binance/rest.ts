import { FAPI_REST, REST_PROXY, SYMBOL } from "../config";
import type { Kline, SymbolMeta } from "../types";

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

function url(base: Route, path: string, params: Record<string, string | number>) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  const prefix = base === "direct" ? FAPI_REST : REST_PROXY;
  return `${prefix}${path}${qs ? `?${qs}` : ""}`;
}

async function attempt(base: Route, path: string, params: Record<string, string | number>) {
  const res = await fetch(url(base, path, params), {
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function api<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const order: Route[] = route ? [route] : ["direct", "proxy"];
  let lastError: unknown;
  for (const base of order) {
    try {
      const data = await attempt(base, path, params);
      setRoute(base);
      return data as T;
    } catch (err) {
      lastError = err;
    }
  }
  // The remembered route just failed. Try the other one before giving up.
  if (route) {
    const other: Route = route === "direct" ? "proxy" : "direct";
    try {
      const data = await attempt(other, path, params);
      setRoute(other);
      return data as T;
    } catch (err) {
      lastError = err;
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

export async function fetchMeta(): Promise<SymbolMeta> {
  const data = await api<{ symbols: RawSymbol[] }>("/fapi/v1/exchangeInfo");
  const s = data.symbols.find((x) => x.symbol === SYMBOL);
  if (!s) throw new Error(`${SYMBOL} is not listed on USDⓈ-M futures`);
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

export function fetchDepthSnapshot(limit = 1000) {
  return api<DepthSnapshot>("/fapi/v1/depth", { symbol: SYMBOL, limit });
}

type RawKline = [number, string, string, string, string, string, number, string, ...unknown[]];

export async function fetchKlines(interval: string, limit: number): Promise<Kline[]> {
  const rows = await api<RawKline[]>("/fapi/v1/klines", { symbol: SYMBOL, interval, limit });
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

export async function fetchOpenInterest(): Promise<{ qty: number; t: number }> {
  const d = await api<{ openInterest: string; time: number }>("/fapi/v1/openInterest", {
    symbol: SYMBOL,
  });
  return { qty: Number(d.openInterest), t: d.time };
}

/**
 * Account-level long/short skew. Used only to split the modelled liquidation
 * ladder between the two sides; absent, the ladder assumes an even book.
 */
export async function fetchLongShortRatio(): Promise<number | null> {
  try {
    const rows = await api<{ longShortRatio: string }[]>(
      "/futures/data/globalLongShortAccountRatio",
      { symbol: SYMBOL, period: "5m", limit: 1 },
    );
    const v = Number(rows.at(-1)?.longShortRatio);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
