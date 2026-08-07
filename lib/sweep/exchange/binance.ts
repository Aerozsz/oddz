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
/**
 * Demo trading (formerly "testnet").
 *
 * Binance migrated this: the old https://testnet.binancefuture.com is the
 * legacy host and the current REST base is demo-fapi.binance.com. The old one
 * still serves the sign-up and API-key *website*, which is the confusing part —
 * you create the key at testnet.binancefuture.com and then call a different
 * host with it. Pointing the client at the website host produces authentication
 * failures that look like a bad key rather than a wrong endpoint.
 *
 * Overridable, because this has now moved once and may move again.
 */
const TESTNET_BASE = "https://demo-fapi.binance.com";

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
  const override = env.BINANCE_BASE_URL?.trim();
  return {
    apiKey,
    apiSecret,
    live,
    baseUrl: override || (live ? LIVE_BASE : TESTNET_BASE),
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
/**
 * Binance error codes that mean something specific and actionable.
 *
 * The raw body is accurate and useless: `{"code":-4411,"msg":"..."}` in a log
 * line does not tell an operator that an order was rejected because a checkbox
 * on a website has not been ticked, and that no amount of retrying or
 * reconfiguring will change it. These are the ones that have actually been hit
 * here, each mapped to the thing to do about it.
 */
const KNOWN_ERRORS: { code: number; explain: (symbol: string) => string }[] = [
  {
    code: -4411,
    explain: (symbol) =>
      `${symbol} is a traditional-asset perpetual, and Binance requires a separate agreement per ` +
      `account before it will accept any order on one. Nothing here can sign it — it is a modal on ` +
      `their website, under Trading Rules for Traditional Asset Perpetuals. On the demo environment ` +
      `that modal frequently fails with "System abnormality", in which case the agreement cannot be ` +
      `signed there at all and this contract cannot be tested on demo. Prove the order path on a ` +
      `crypto pair instead — SWEEP_SYMBOL=BTCUSDT npm run sweep:control — which needs no agreement. ` +
      `The agreement is per account, so signing it on live is a separate step from signing it on demo.`,
  },
  {
    code: -4120,
    explain: () =>
      `A conditional order was sent to the wrong endpoint. Binance moved stops and take-profits to ` +
      `the Algo Order service; this build already targets it, so seeing this means something is ` +
      `still calling the old path.`,
  },
  {
    code: -5022,
    explain: () =>
      `A post-only entry would have crossed the spread, so it was rejected rather than filled as a ` +
      `taker. That is the order type working: the next signal is priced fresh.`,
  },
  {
    code: -2019,
    explain: () => `Not enough margin for the position at the leverage in force. Reduce the size or the risk per trade.`,
  },
  {
    code: -1021,
    explain: () =>
      `The request timestamp was outside Binance's window — this machine's clock has drifted. ` +
      `Sync it (Windows: Settings > Time & language > Date & time > Sync now).`,
  },
];

/**
 * A Binance error with the operator's next action attached, when it has one.
 *
 * Returns the original message unchanged when the code is not one that has a
 * specific answer, because a wrong explanation is worse than none.
 */
export function explainError(message: string, symbol = "this contract"): string {
  const match = message.match(/"code"\s*:\s*(-?\d+)/);
  if (!match) return message;
  const known = KNOWN_ERRORS.find((k) => k.code === Number(match[1]));
  return known ? `${message}\n    → ${known.explain(symbol)}` : message;
}

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
 * Signed request. Binance verifies the signature against the exact query string
 * it receives, so the string that was hashed is the one sent — built once and
 * reused rather than re-serialised, which is where signature bugs come from.
 */
export async function signedRequest<T>(
  cfg: BinanceConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | boolean> = {},
): Promise<T> {
  const query = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    recvWindow: String(cfg.recvWindowMs),
    timestamp: String(Date.now()),
  }).toString();

  const signature = sign(query, cfg.apiSecret);
  const url = `${cfg.baseUrl}${path}?${query}&signature=${signature}`;

  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": cfg.apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  const body = await res.text();
  if (!res.ok) {
    // -1021 is a clock-skew rejection and is common on a laptop that has slept;
    // naming it saves a long detour into signature debugging.
    const hint = body.includes("-1021")
      ? " (system clock is out of sync with Binance — resync NTP)"
      : body.includes("-4411")
        ? " (INTCUSDT is a TradFi perpetual — it tracks a stock, and Binance requires a separate " +
          "agreement for those on top of the normal futures one. Open the INTCUSDT page in the " +
          "Binance interface for this environment and accept the prompt, then retry. It is a " +
          "one-off per account and cannot be done over the API.)"
      : body.includes("-2015") || body.includes("-2014")
        ? cfg.live
          ? " (key rejected: check it has Futures enabled and this IP is allowlisted)"
          : ` (key rejected against ${cfg.baseUrl} — demo keys are created at testnet.binancefuture.com` +
            ` but must be used against demo-fapi.binance.com, and a live key will not work here at all)`
        : "";
    throw new Error(`${res.status} ${redact(body)}${hint}`);
  }
  return JSON.parse(body) as T;
}

const signedGet = <T>(cfg: BinanceConfig, path: string, params: Record<string, string | number> = {}) =>
  signedRequest<T>(cfg, "GET", path, params);

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

/**
 * Which contracts the venue that receives orders will actually accept.
 *
 * This exists because market data and orders do not go to the same place.
 * Prices, the book and every stream come from production fapi.binance.com in
 * all modes — demo trading has no meaningful order book of its own, and reading
 * one would mean calibrating against a market that does not exist. Orders go to
 * demo-fapi.binance.com unless BINANCE_LIVE=1.
 *
 * The gap that opens up is silent and expensive: demo lists far fewer contracts
 * than production. A symbol present in one and absent from the other produces a
 * perfectly healthy engine — real book, real signals, sizer approving setups —
 * and then every single order is rejected as an unknown symbol. Nothing about
 * the monitor looks wrong, because nothing about the monitor is wrong.
 *
 * So the order venue is asked directly, at startup, and a symbol it does not
 * list is reported as untradeable before anything is armed rather than after a
 * night of watching nothing happen.
 *
 * Unsigned: exchangeInfo needs no credentials, so this works before the keys
 * have been checked and cannot fail for a reason belonging to them.
 */
export async function fetchTradableSymbols(cfg: BinanceConfig): Promise<Set<string>> {
  const res = await fetch(`${cfg.baseUrl}/fapi/v1/exchangeInfo`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${cfg.baseUrl}`);
  const data = (await res.json()) as { symbols?: { symbol: string; status: string }[] };
  const rows = data.symbols ?? [];
  if (rows.length === 0) throw new Error(`${cfg.baseUrl} returned no contracts`);
  return new Set(rows.filter((s) => s.status === "TRADING").map((s) => s.symbol));
}

/* ------------------------------------------------------------- funding */

/**
 * Move USDT between the spot wallet and the futures wallet.
 *
 * Off by default and gated on BINANCE_ALLOW_TRANSFER=1, because it needs the
 * "Permits Universal Transfer" permission on the API key and that is a real
 * widening of what a leaked .env file can do. It cannot move money *out* of
 * the account — only between your own wallets — so it is far short of
 * withdrawal, but it is still more than a trading key needs in order to trade,
 * and the default should be the smaller key.
 *
 * There is no equivalent on demo trading. Binance funds a demo account from a
 * faucet on the testnet website, with no API behind it, so the GUI links there
 * instead of offering a button that cannot work.
 */
export function transfersAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BINANCE_ALLOW_TRANSFER === "1";
}

export type TransferDirection = "spot-to-futures" | "futures-to-spot";

export async function transferUsdt(
  cfg: BinanceConfig,
  direction: TransferDirection,
  amount: number,
): Promise<{ tranId: number }> {
  if (!transfersAllowed()) {
    throw new Error(
      "transfers are disabled — set BINANCE_ALLOW_TRANSFER=1 and give the API key the " +
        "Universal Transfer permission. Leave it off unless you are actually moving funds.",
    );
  }
  if (!cfg.live) {
    throw new Error(
      "demo trading has no transfer API — fund it from the faucet on testnet.binancefuture.com",
    );
  }
  if (!(amount > 0)) throw new Error("amount must be greater than zero");

  // 1 = spot to USDⓈ-M futures, 2 = the reverse.
  const type = direction === "spot-to-futures" ? 1 : 2;
  return signedRequest<{ tranId: number }>(cfg, "POST", "/sapi/v1/futures/transfer", {
    asset: "USDT",
    amount: amount.toFixed(2),
    type,
  });
}

/** USDT sitting in the spot wallet, i.e. what is available to transfer in. */
export async function fetchSpotUsdt(cfg: BinanceConfig): Promise<number> {
  const rows = await signedRequest<{ asset: string; free: string }[]>(cfg, "GET", "/sapi/v3/asset/getUserAsset", {
    asset: "USDT",
  });
  return num(rows.find((r) => r.asset === "USDT")?.free);
}

export { sign as __signForTest };
