import { z } from "zod";
import { fetchJson } from "@/lib/http";
import { log } from "@/lib/logger";
import type { TrackerConfig } from "./config";
import type { MarketState } from "./types";

/**
 * Price and liquidity overlay.
 *
 * These aggregators are the right source for price, volume and USD liquidity
 * and the wrong source for holders: DexScreener exposes no holder endpoint at
 * all, and GMGN's top-holder route covers Solana, Ethereum, Base and BSC
 * rather than arbitrary chains. Holders come from the log replay; only the
 * valuation layer comes from here.
 *
 * Both calls run server-side. That is not incidental — neither API sends
 * permissive CORS headers, so a browser calling them directly is blocked, and
 * routing through our own API route is what makes the client work at all.
 */

const num = z.union([z.string(), z.number()]).nullish();

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const dexPair = z.object({
  chainId: z.string().optional(),
  dexId: z.string().optional(),
  pairAddress: z.string().optional(),
  baseToken: z.object({ address: z.string(), symbol: z.string().optional() }).optional(),
  quoteToken: z.object({ address: z.string(), symbol: z.string().optional() }).optional(),
  priceNative: num,
  priceUsd: num,
  txns: z.object({ h24: z.object({ buys: z.number().nullish(), sells: z.number().nullish() }).optional() }).optional(),
  volume: z.object({ h24: num }).optional(),
  priceChange: z.object({ h24: num }).optional(),
  liquidity: z.object({ usd: num, base: num, quote: num }).optional(),
});

const dexTokensResponse = z.object({ pairs: z.array(dexPair).nullish() });
const dexPairsArray = z.array(dexPair);

type DexPair = z.infer<typeof dexPair>;

/** Prefer the configured pair; otherwise the deepest pool for the token. */
function pickPair(pairs: DexPair[], cfg: TrackerConfig): DexPair | null {
  if (pairs.length === 0) return null;
  if (cfg.pair) {
    const exact = pairs.find((p) => p.pairAddress?.toLowerCase() === cfg.pair);
    if (exact) return exact;
  }
  return [...pairs].sort(
    (a, b) => (toNum(b.liquidity?.usd) ?? 0) - (toNum(a.liquidity?.usd) ?? 0),
  )[0];
}

function fromDexPair(p: DexPair): MarketState {
  const priceUsd = toNum(p.priceUsd);
  const priceNative = toNum(p.priceNative);
  return {
    source: "dexscreener",
    priceUsd,
    // The quote token's own USD price, needed to value the exact quote
    // amounts the log replay extracts from Swap events.
    quoteUsd:
      priceUsd !== null && priceNative !== null && priceNative !== 0
        ? priceUsd / priceNative
        : null,
    liquidityUsd: toNum(p.liquidity?.usd),
    volume24hUsd: toNum(p.volume?.h24),
    priceChange24hPct: toNum(p.priceChange?.h24),
    buys24h: p.txns?.h24?.buys ?? null,
    sells24h: p.txns?.h24?.sells ?? null,
    pairAddress: p.pairAddress?.toLowerCase() ?? null,
    quoteSymbol: p.quoteToken?.symbol ?? null,
    fetchedAt: Date.now(),
    error: null,
  };
}

async function fromDexScreener(cfg: TrackerConfig): Promise<MarketState | null> {
  // Two shapes exist: the chain-scoped token-pairs route returns a bare array,
  // the legacy tokens route returns { pairs }. Try the scoped one first, it is
  // cheaper and does not sweep every chain.
  try {
    const arr = await fetchJson(
      `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(cfg.dexscreenerChain)}/${cfg.token}`,
      { schema: dexPairsArray, source: "dexscreener", retries: 1, timeoutMs: 8_000 },
    );
    const p = pickPair(arr, cfg);
    if (p) return fromDexPair(p);
  } catch (err) {
    log.warn("dexscreener token-pairs failed", { error: String(err).slice(0, 160) });
  }

  try {
    const res = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${cfg.token}`, {
      schema: dexTokensResponse,
      source: "dexscreener",
      retries: 1,
      timeoutMs: 8_000,
    });
    const p = pickPair(res.pairs ?? [], cfg);
    if (p) return fromDexPair(p);
  } catch (err) {
    log.warn("dexscreener tokens failed", { error: String(err).slice(0, 160) });
  }
  return null;
}

const gtPool = z.object({
  data: z.object({
    attributes: z.object({
      address: z.string().optional(),
      base_token_price_usd: num,
      quote_token_price_usd: num,
      price_change_percentage: z.object({ h24: num }).optional(),
      volume_usd: z.object({ h24: num }).optional(),
      reserve_in_usd: num,
      transactions: z
        .object({
          h24: z.object({ buys: z.number().nullish(), sells: z.number().nullish() }).optional(),
        })
        .optional(),
    }),
  }),
});

async function fromGeckoTerminal(cfg: TrackerConfig): Promise<MarketState | null> {
  if (!cfg.pair) return null;
  try {
    const res = await fetchJson(
      `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(cfg.geckoterminalNetwork)}/pools/${cfg.pair}`,
      { schema: gtPool, source: "geckoterminal", retries: 1, timeoutMs: 8_000 },
    );
    const a = res.data.attributes;
    return {
      source: "geckoterminal",
      priceUsd: toNum(a.base_token_price_usd),
      quoteUsd: toNum(a.quote_token_price_usd),
      liquidityUsd: toNum(a.reserve_in_usd),
      volume24hUsd: toNum(a.volume_usd?.h24),
      priceChange24hPct: toNum(a.price_change_percentage?.h24),
      buys24h: a.transactions?.h24?.buys ?? null,
      sells24h: a.transactions?.h24?.sells ?? null,
      pairAddress: a.address?.toLowerCase() ?? cfg.pair,
      quoteSymbol: null,
      fetchedAt: Date.now(),
      error: null,
    };
  } catch (err) {
    log.warn("geckoterminal failed", { error: String(err).slice(0, 160) });
    return null;
  }
}

export const EMPTY_MARKET: MarketState = {
  source: "none",
  priceUsd: null,
  quoteUsd: null,
  liquidityUsd: null,
  volume24hUsd: null,
  priceChange24hPct: null,
  buys24h: null,
  sells24h: null,
  pairAddress: null,
  quoteSymbol: null,
  fetchedAt: 0,
  error: null,
};

/**
 * Fetch the overlay, cached briefly.
 *
 * The cache is deliberately shorter than the aggregators' own update cadence
 * so the page stays live, but long enough that ten open tabs polling every two
 * seconds do not turn into ten requests per second at DexScreener.
 */
let cached: { at: number; state: MarketState } | null = null;
const MARKET_TTL_MS = 10_000;

export async function getMarket(cfg: TrackerConfig, force = false): Promise<MarketState> {
  if (!force && cached && Date.now() - cached.at < MARKET_TTL_MS) return cached.state;
  const state = (await fromDexScreener(cfg)) ?? (await fromGeckoTerminal(cfg));
  const resolved: MarketState = state ?? {
    ...EMPTY_MARKET,
    fetchedAt: Date.now(),
    error: "no price source reachable (DexScreener and GeckoTerminal both failed)",
  };
  cached = { at: Date.now(), state: resolved };
  return resolved;
}
