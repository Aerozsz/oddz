/**
 * Tracker configuration.
 *
 * Deliberately NOT read through lib/env.ts: that module requires DATABASE_URL
 * and CRON_SECRET and throws without them. The holder tracker is pure chain
 * reads and must run in a checkout that has no database configured.
 */

export interface TrackerConfig {
  /** JSON-RPC endpoints, tried in order on failure. */
  rpcUrls: string[];
  token: string;
  /** The AMM pair that forms the token's exit. Auto-detected if unset. */
  pair: string | null;
  /** Block to start the Transfer replay from. 0 = genesis (slow on old chains). */
  fromBlock: number;
  /** Max blocks per eth_getLogs call. Public RPCs commonly cap this. */
  logChunk: number;
  /** DexScreener chain slug for the price overlay. */
  dexscreenerChain: string;
  /** GeckoTerminal network slug for the fallback price overlay. */
  geckoterminalNetwork: string;
  /** Holders returned to the client. */
  topN: number;
  /** Flow-feed retention. */
  maxFlows: number;
}

/**
 * The RIPE token and its RIPE/NVDA Uniswap-V2 pool on Robinhood Chain, both
 * confirmed from the explorer. They are only defaults — every field can be
 * overridden per request or by env, so the tracker works on any EVM chain.
 */
export const RIPE_TOKEN = "0x4d3f37a965b21ab4122e92dd41d2693e742c883b";
export const RIPE_NVDA_PAIR = "0x9b8537be00b0dc8f76f2ab8b2c6b6e79cd2a769d";

function list(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

export function trackerConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    // No default endpoint is baked in on purpose. Guessing an RPC URL and
    // shipping it would produce a tracker that silently reports zero holders
    // against a host that never answers; an empty list surfaces as an explicit
    // "RPC not configured" state instead.
    rpcUrls: list(process.env.HOLDERS_RPC_URLS),
    token: (process.env.HOLDERS_TOKEN || RIPE_TOKEN).toLowerCase(),
    pair: (process.env.HOLDERS_PAIR || RIPE_NVDA_PAIR).toLowerCase() || null,
    fromBlock: int(process.env.HOLDERS_FROM_BLOCK, 0),
    logChunk: int(process.env.HOLDERS_LOG_CHUNK, 2_000),
    dexscreenerChain: process.env.HOLDERS_DEXSCREENER_CHAIN || "robinhood",
    geckoterminalNetwork: process.env.HOLDERS_GECKOTERMINAL_NETWORK || "robinhood",
    topN: int(process.env.HOLDERS_TOP_N, 100),
    maxFlows: int(process.env.HOLDERS_MAX_FLOWS, 200),
    ...overrides,
  };
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";

/** Addresses that hold supply but can never sell it. */
export const BURN_ADDRESSES = new Set([ZERO_ADDRESS, DEAD_ADDRESS]);
