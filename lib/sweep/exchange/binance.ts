import { createHmac } from "node:crypto";

/**
 * Authenticated Binance USDⓈ-M futures client.
 *
 * Server-side only. This module reads an API secret and must never reach a
 * browser bundle — nothing under features/ or app/ may import it.
 *
 * Scope is deliberately read-only for now: positions, balance, account risk.
 * Knowing what you already hold is a prerequisite for trading, not a strategy
 * input, and it is the one thing the agent was completely blind to. Order
 * placement lands separately, behind explicit position limits.
 *
 * Defaults to testnet. Going live is an explicit opt-in via BINANCE_LIVE=1,
 * because the failure mode of getting that default wrong is real money.
 */

const LIVE_BASE = "https://fapi.binance.com";
const TESTNET_BASE = "https://testnet.binancefuture.com";

export interface BinanceConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  live: boolean;
  recvWindowMs: number;
}

export class MissingCredentials extends Error {
  constructor(missing: string[]) {
    super(
      `missing ${missing.join(" and ")} — set them in the environment. ` +
        `Create the key with Futures enabled, withdrawals DISABLED, and restricted to this machine's IP.`,
    );
    this.name = "MissingCredentials";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BinanceConfig {
  const apiKey = env.BINANCE_API_KEY?.trim() ?? "";
  const apiSecret = env.BINANCE_API_SECRET?.trim() ?? "";
  const missing: string[] = [];
  if (!apiKey) missing.push("BINANCE_API_KEY");
  if (!apiSecret) missing.push("BINANCE_API_SECRET");
  if (missing.length) throw new MissingCredentials(missing);

  const live = env.BINANCE_LIVE === "1";
  return {
    apiKey,
    apiSecret,
    live,
    baseUrl: live ? LIVE_BASE : TESTNET_BASE,
    // Binance rejects a request whose timestamp is outside this window. Five
    // seconds is their default; a laptop with drifting clock needs the margin.
    recvWindowMs: Number(env.BINANCE_RECV_WINDOW ?? 5_000),
  };
}

/** True when credentials are present, without throwing. */
export function hasCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.BINANCE_API_KEY?.trim() && env.BINANCE_API_SECRET?.trim());
}

/**
 * Never let a secret reach a log line or an HTTP response. Signatures are
 * redacted too: they are derived from the secret, and a large enough sample of
 * signature/payload pairs is not something to leave lying in a log file.
 */
export function redact(text: string): string {
  return text
    .replace(/(signature=)[A-Fa-f0-9]+/g, "$1<redacted>")
    .replace(/(BINANCE_API_SECRET=)\S+/g, "$1<redacted>")
    .replace(/(BINANCE_API_KEY=)\S+/g, "$1<redacted>");
}

function sign(query: string, secret: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

/**
 * Signed GET. Binance signs the exact query string it receives, so the encoded
 * form sent must be byte-identical to the one hashed — build it once and reuse
 * it rather than re-serialising.
 */
async function signedGet<T>(
  cfg: BinanceConfig,
  path: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  const query = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    recvWindow: String(cfg.recvWindowMs),
    timestamp: String(Date.now()),
  }).toString();

  const signature = sign(query, cfg.apiSecret);
  const url = `${cfg.baseUrl}${path}?${query}&signature=${signature}`;

  const res = await fetch(url, {
    headers: { "X-MBX-APIKEY": cfg.apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  const body = await res.text();
  if (!res.ok) {
    // -1021 is a clock-skew rejection and is common on a laptop that has slept;
    // naming it saves a long detour into signature debugging.
    const hint = body.includes("-1021")
      ? " (system clock is out of sync with Binance — resync NTP)"
      : body.includes("-2015")
        ? " (key rejected: check it has Futures enabled and this IP is allowlisted)"
        : "";
    throw new Error(`${res.status} ${redact(body)}${hint}`);
  }
  return JSON.parse(body) as T;
}

/* ------------------------------------------------------------------ shapes */

export interface Position {
  symbol: string;
  /** Signed: positive is long, negative is short, 0 is flat. */
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  /** 0 when flat — Binance reports no liquidation price without a position. */
  liquidationPrice: number;
  leverage: number;
  notional: number;
  marginType: string;
  isolatedMargin: number;
}

export interface AccountRisk {
  /** USDT available to open new positions. */
  availableBalance: number;
  walletBalance: number;
  totalUnrealizedPnl: number;
  /** Total margin used over total margin available; climbing toward 1 is bad. */
  marginRatio: number;
  maintenanceMargin: number;
  marginBalance: number;
  positions: Position[];
  /** Only the positions that are actually open. */
  openPositions: Position[];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

interface RawPosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unrealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  notional?: string;
  marginType?: string;
  isolatedMargin?: string;
}

interface RawAccount {
  availableBalance: string;
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMaintMargin: string;
  totalMarginBalance: string;
  positions: RawPosition[];
}

function toPosition(p: RawPosition): Position {
  return {
    symbol: p.symbol,
    positionAmt: num(p.positionAmt),
    entryPrice: num(p.entryPrice),
    markPrice: num(p.markPrice),
    unrealizedPnl: num(p.unrealizedProfit),
    liquidationPrice: num(p.liquidationPrice),
    leverage: num(p.leverage),
    notional: num(p.notional),
    marginType: p.marginType ?? "cross",
    isolatedMargin: num(p.isolatedMargin),
  };
}

/**
 * Everything needed to answer "what am I holding and how close to trouble".
 *
 * One call rather than several: position and margin have to be read from the
 * same instant, or the agent can size against a balance that no longer matches
 * the position it is looking at.
 */
export async function fetchAccountRisk(cfg: BinanceConfig): Promise<AccountRisk> {
  const raw = await signedGet<RawAccount>(cfg, "/fapi/v2/account");
  const positions = (raw.positions ?? []).map(toPosition);
  const marginBalance = num(raw.totalMarginBalance);
  const maintenanceMargin = num(raw.totalMaintMargin);

  return {
    availableBalance: num(raw.availableBalance),
    walletBalance: num(raw.totalWalletBalance),
    totalUnrealizedPnl: num(raw.totalUnrealizedProfit),
    maintenanceMargin,
    marginBalance,
    // Binance's own definition. Above ~0.8 is where liquidation starts to be a
    // live concern rather than a theoretical one.
    marginRatio: marginBalance > 0 ? maintenanceMargin / marginBalance : 0,
    positions,
    openPositions: positions.filter((p) => p.positionAmt !== 0),
  };
}

/** Position for one symbol, or null when flat. */
export async function fetchPosition(cfg: BinanceConfig, symbol: string): Promise<Position | null> {
  const rows = await signedGet<RawPosition[]>(cfg, "/fapi/v2/positionRisk", { symbol });
  const open = rows.map(toPosition).find((p) => p.positionAmt !== 0);
  return open ?? null;
}

/** Round-trip check that the key works, without touching any position. */
export async function ping(cfg: BinanceConfig): Promise<{ ok: true; live: boolean; balance: number }> {
  const risk = await fetchAccountRisk(cfg);
  return { ok: true, live: cfg.live, balance: risk.availableBalance };
}

export { sign as __signForTest };
