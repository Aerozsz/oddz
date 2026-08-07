/**
 * Local control plane for the sweep agent — HTTP API plus a GUI.
 *
 *   npm run sweep:control
 *
 * Binds to 127.0.0.1 only and requires a token printed at startup. This process
 * reads exchange credentials and will eventually place orders, so it is never
 * to be exposed to a network or deployed anywhere. It is a local operator
 * console, not a web service.
 *
 * What it does: runs and stops the monitor, shows feed health, market state and
 * live signals, reads the exchange position and margin, holds the risk limits,
 * suggests a setup with its full reasoning, previews a position before anything
 * is sent, and — only while armed — places orders through the execution loop.
 *
 * Entries rest on the book as post-only orders when mark-out says the passive
 * side is being paid to be there, and cross when it is not. That is the same
 * test the sizer prices the trade with, so the cost quoted in a suggestion and
 * the cost actually paid cannot disagree.
 */

import { readHeartbeat } from "./heartbeat";
import { loadEnv } from "./load-env";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { attachCalendar } from "../lib/sweep/metrics/event-store";
import { getEngine } from "../lib/sweep/engine";
import { createSweepFeed, type SweepFeed } from "../lib/sweep/agent";
import type { Signal } from "../lib/sweep/agent";
import {
  fetchAccountRisk,
  fetchSpotUsdt,
  hasCredentials,
  loadConfig,
  redact,
  transferUsdt,
  transfersAllowed,
  type AccountRisk,
} from "../lib/sweep/exchange/binance";
import { previewPosition } from "../lib/sweep/exchange/preview";
import { proposePosition } from "../lib/sweep/agent/sizing";
import { directionalBias } from "../lib/sweep/agent/bias";
import { DEFAULT_FEES, type FeeSchedule, canPostEntry, parseFeeTiers } from "../lib/sweep/metrics/fees";
import {
  checkProtection,
  closePosition,
  ensureProtected,
  openProtectedPosition,
  setLeverage,
  type ProtectionState,
} from "../lib/sweep/exchange/orders";
import { fetchPosition } from "../lib/sweep/exchange/binance";
import { dayDrawdown, fetchDayActivity, type DayActivity } from "../lib/sweep/exchange/activity";
import { createBinanceAdapter, flatten, type ExecutionRecord } from "../lib/sweep/exchange/adapter";
import { attachExecution, intentId, type ExecutionRunner } from "../lib/sweep/agent";
import { CONFIG, IS_CALIBRATED_SYMBOL, SYMBOL } from "../lib/sweep/config";

/*
 * Node 22 or newer. The engine uses the global WebSocket, which older releases
 * do not provide — without this check that surfaces as "WebSocket is not
 * defined" deep inside a stream callback, which is a miserable first
 * experience for something that is really just a version mismatch.
 */
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 22) {
  console.error("");
  console.error(`  This needs Node 22 or newer. You are on ${process.versions.node}.`);
  console.error("  Install the current LTS from https://nodejs.org and run this again.");
  console.error("");
  process.exit(1);
}

// Before anything reads process.env. Nothing else loads .env for a worker.
const dotenv = loadEnv();

const PORT = Number(process.env.SWEEP_CONTROL_PORT ?? 7777);
/*
 * Loopback by default. This process holds an exchange secret and can move a
 * position, so it is not something to put on a network casually — binding wider
 * is an explicit choice, and the safe way to reach it from elsewhere is a
 * tunnel (Cloudflare Tunnel, Tailscale) that authenticates before traffic ever
 * arrives here, rather than opening a port and relying on the token alone.
 */
const HOST = process.env.SWEEP_CONTROL_HOST ?? "127.0.0.1";
const TOKEN = process.env.SWEEP_CONTROL_TOKEN ?? randomBytes(16).toString("hex");
const LIMITS_PATH = resolve(process.env.SWEEP_LIMITS ?? "data/sweep-limits.json");

/**
 * Everything the server says, kept in a ring so the GUI can show it.
 *
 * Telling an operator to watch a terminal is telling them the interface is
 * incomplete: the console is where the interesting things happen — an order
 * going out, a stop landing, the sizer explaining a refusal — and none of it
 * was reachable from the page they are actually looking at.
 *
 * Redacted on the way in, the same as the console, so a secret cannot reach the
 * browser even though this is loopback-only.
 */
interface LogLine {
  t: number;
  text: string;
}
const logLines: LogLine[] = [];

const log = (...a: unknown[]) => {
  const text = a.map((x) => (typeof x === "string" ? redact(x) : JSON.stringify(x))).join(" ");
  logLines.push({ t: Date.now(), text });
  if (logLines.length > 500) logLines.shift();
  console.log("[control]", text);
};

/* -------------------------------------------------------------------- state */

interface Limits {
  maxPositionUsd: number;
  maxLeverage: number;
  maxDailyLossUsd: number;
  maxOpenPositions: number;
  /** Nothing may be submitted while this is false. Defaults off. */
  tradingEnabled: boolean;
  /**
   * How far from the mark the protective stop sits, in percent. Every position
   * gets one on the exchange; this is the only tunable part of that.
   */
  stopLossPct: number;
  /** Entries allowed per day. Overtrading is how discipline usually fails. */
  maxTradesPerDay: number;
  /** Minutes to wait after a loss before another entry. */
  lossCooldownMin: number;
  /** Only trade while the Nasdaq cash market is open. */
  requireCashOpen: boolean;
  /** Minimum reward-to-risk before a setup is worth taking. */
  minRewardRisk: number;
  /**
   * Percent of free collateral put at risk if the stop fills. This is the dial
   * that actually sets aggression — leverage only decides how much margin the
   * same position ties up, whereas this decides what a loss costs.
   */
  riskPerTradePct: number;
}

/*
 * The structural constraints stay on whatever the dials are set to — a daily
 * loss cap, a cooldown after a loss, a ceiling on trades per day, and a
 * minimum reward-to-risk. Those are not conservatism, they are the difference
 * between a plan and improvisation, and they cost nothing when the numbers are
 * loose.
 *
 * The dials themselves are set here at a middle setting: meaningfully more
 * exposure than a cautious default, and far short of the leverage where one
 * adverse move ends the account.
 */
const DEFAULT_LIMITS: Limits = {
  maxPositionUsd: 0,
  maxLeverage: 8,
  maxDailyLossUsd: 0,
  maxOpenPositions: 1,
  tradingEnabled: false,
  // Wider than the cautious setting on purpose: a bigger position behind a
  // tighter stop is the same risk with worse odds of surviving noise, so the
  // stop widens as the size does.
  stopLossPct: 3,
  maxTradesPerDay: 12,
  lossCooldownMin: 15,
  requireCashOpen: false,
  minRewardRisk: 1.2,
  riskPerTradePct: 2,
};

/**
 * The fee schedule the sizer prices against.
 *
 * Read from the environment rather than hardcoded, because the two things most
 * likely to be wrong here are account-specific: whether the BNB discount is
 * switched on, and whether this account is on a rate schedule that escalates
 * with activity. Both change the arithmetic of every proposal, and at this
 * frequency the arithmetic of fees is most of the arithmetic.
 *
 *   SWEEP_FEE_DISCOUNT=0.9      # BNB fee payment enabled
 *   SWEEP_MAX_FEE_SHARE=0.4     # refuse once fees pass 40% of the day's gross
 *   SWEEP_MAX_DAILY_FEE=100     # ...or once they pass this many dollars
 *   SWEEP_FEE_TIERS='[{"fromTradeCount":10,"makerRate":0.0004,"takerRate":0.0008}]'
 *
 * The default is the published Binance VIP-0 schedule with no discount applied,
 * which is the honest default: assuming a discount that has not been enabled
 * would make every proposal look cheaper than it really is.
 */
function readFeeSchedule(): FeeSchedule {
  const parsed = parseFeeTiers(process.env.SWEEP_FEE_TIERS);
  if (parsed.error) log(`fee tiers ignored: ${parsed.error}`);
  const num = (name: string, fallback: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    ...DEFAULT_FEES,
    discount: num("SWEEP_FEE_DISCOUNT", DEFAULT_FEES.discount),
    maxFeeShareOfGross: num("SWEEP_MAX_FEE_SHARE", DEFAULT_FEES.maxFeeShareOfGross),
    maxDailyFeeUsd: num("SWEEP_MAX_DAILY_FEE", DEFAULT_FEES.maxDailyFeeUsd),
    tiers: parsed.tiers,
  };
}

function readLimits(): Limits {
  const stored = (() => {
    if (!existsSync(LIMITS_PATH)) return { ...DEFAULT_LIMITS };
    try {
      return { ...DEFAULT_LIMITS, ...JSON.parse(readFileSync(LIMITS_PATH, "utf8")) };
    } catch {
      return { ...DEFAULT_LIMITS };
    }
  })();

  /*
   * Always boot disarmed, whatever the file says.
   *
   * Every other limit is a preference worth remembering. This one is a live
   * instruction to place orders, and a process that resumes placing them on its
   * own — after a crash, an OS update, a machine rebooting overnight — is doing
   * something nobody was present to decide. The restart is precisely the moment
   * to look at the account before continuing.
   *
   * Costs one click per session, which is the right price. Any position left
   * open is untouched: its stop is on Binance and keeps working regardless of
   * whether this program is armed, running, or installed.
   */
  return { ...stored, tradingEnabled: false };
}

function writeLimits(next: Limits) {
  mkdirSync(dirname(LIMITS_PATH), { recursive: true });
  writeFileSync(LIMITS_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

let feed: SweepFeed | null = null;

/** Contract metadata from the exchange, once the engine has fetched it. */
const meta = () => getEngine().getSnapshot().meta;
let startedAt = 0;
let account: { risk: AccountRisk | null; error: string | null; at: number } = {
  risk: null,
  error: null,
  at: 0,
};
let limits = readLimits();
const fees = readFeeSchedule();

function startEngine() {
  if (feed) return;
  feed = createSweepFeed();
  attachCalendar(getEngine());
  feed.onSignal((s) => {
    if (s.kind !== "health") signalsSeen++;
  });
  startedAt = Date.now();
  log("engine started");
}

function stopEngine() {
  if (!feed) return;
  feed.close();
  feed = null;
  startedAt = 0;
  log("engine stopped");
}

let day: { activity: DayActivity | null; error: string | null; at: number } = { activity: null, error: null, at: 0 };
let execHistory: ExecutionRecord[] = [];
let runner: ExecutionRunner | null = null;

let protection: { state: ProtectionState | null; error: string | null; at: number } = {
  state: null,
  error: null,
  at: 0,
};

async function refreshAccount() {
  if (!hasCredentials()) {
    account = { risk: null, error: "no credentials configured", at: Date.now() };
    protection = { state: null, error: null, at: Date.now() };
    return;
  }
  try {
    const cfg = loadConfig();
    account = { risk: await fetchAccountRisk(cfg), error: null, at: Date.now() };
    const position = await fetchPosition(cfg, SYMBOL);
    protection = { state: await checkProtection(cfg, SYMBOL, position), error: null, at: Date.now() };
    day = { activity: await fetchDayActivity(cfg, SYMBOL), error: null, at: Date.now() };
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    account = { risk: null, error: message, at: Date.now() };
    protection = { state: null, error: message, at: Date.now() };
  }
}

/**
 * Startup reconciliation.
 *
 * A position can outlive this process — that is the whole point of leaving it
 * in place rather than closing on exit — so the first thing a new run does is
 * ask the exchange what is open and whether a stop is resting against it. A
 * position found unprotected is covered immediately rather than reported and
 * left, because the window where it is uncovered is the risk.
 */
async function reconcileOnStart() {
  if (!hasCredentials()) return;
  try {
    const cfg = loadConfig();
    const position = await fetchPosition(cfg, SYMBOL);
    if (!position) {
      log("startup: flat, nothing to reconcile");
      return;
    }
    log(`startup: found an open position of ${position.positionAmt} ${SYMBOL}`);
    const before = await checkProtection(cfg, SYMBOL, position);
    if (before.protected) {
      log(`startup: ${before.reason}`);
      protection = { state: before, error: null, at: Date.now() };
      return;
    }
    log(`startup: ${before.reason} — placing one now`);
    const after = await ensureProtected(cfg, SYMBOL, position, limits.stopLossPct, 2);
    log(`startup: ${after.reason}`);
    protection = { state: after, error: null, at: Date.now() };
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    log(`startup reconciliation FAILED: ${message}`);
    protection = { state: null, error: message, at: Date.now() };
  }
}

/**
 * Connects signals to the exchange.
 *
 * The strategy here is deliberately thin: it takes a signal, asks the sizer
 * what it would do, and forwards the answer. All the judgement lives in
 * proposePosition and all the safety lives in the adapter — this only decides
 * that a signal is worth asking about at all.
 */
/**
 * Why the loop is or is not running, and what it has been doing.
 *
 * "Armed" and "armed but silently not attached" looked identical, and so did
 * "armed and waiting for a setup" versus "armed and refusing every one". Silence
 * is the expected state here — signals are rare on purpose — which is exactly
 * why it has to be legible rather than inferred.
 */
let lastRefusal: { at: number; reason: string } | null = null;
let signalsSeen = 0;

function startExecutionLoop() {
  if (runner) return;
  if (!feed) {
    log("cannot arm: the engine is not running — start it first");
    return;
  }
  if (!hasCredentials()) {
    log("cannot arm: no API credentials");
    return;
  }
  const cfg = loadConfig();
  const adapter = createBinanceAdapter({
    cfg,
    symbol: SYMBOL,
    limits: () => ({ ...limits }),
    // From the exchange, not hardcoded: 0/2 is right for INTCUSDT and wrong for
    // anything else — BTCUSDT quantities carry three decimals, and a quantity
    // rounded to the wrong precision is rejected outright.
    quantityPrecision: meta()?.quantityPrecision ?? 0,
    pricePrecision: meta()?.pricePrecision ?? 2,
    /**
     * The size that actually gets ordered.
     *
     * Runs the same sizer the Suggest panel runs, against the same limits and
     * the same fee schedule, so what the operator is shown and what the loop
     * would send are the same number rather than two calculations that agree by
     * coincidence.
     */
    size: (_intent, state, availableBalance) => {
      const direction = _intent.side === "buy" ? "up" : "down";
      const proposal = proposePosition({
        direction,
        state,
        equity: availableBalance,
        realisedLossToday: day.activity ? dayDrawdown(day.activity) : 0,
        tradesToday: day.activity?.trades ?? 0,
        lastLossAt: day.activity?.lastLossAt ?? 0,
        feesPaidToday: day.activity?.fees ?? 0,
        grossProfitToday: day.activity?.realisedPnl ?? 0,
        limits: {
          maxPositionUsd: limits.maxPositionUsd,
          maxLeverage: limits.maxLeverage,
          maxDailyLossUsd: limits.maxDailyLossUsd,
          stopLossPct: limits.stopLossPct,
          maxTradesPerDay: limits.maxTradesPerDay,
          lossCooldownMin: limits.lossCooldownMin,
          requireCashOpen: limits.requireCashOpen,
          minRewardRisk: limits.minRewardRisk,
        },
        costCurve: feed?.getCostCurve() ?? [],
        clusters: feed?.getClusters() ?? [],
        config: { riskFraction: limits.riskPerTradePct / 100, fees, canPostEntries: true },
      });
      if (!proposal.ok) {
        lastRefusal = { at: Date.now(), reason: proposal.reasons.join("; ") };
        log(`sizer declined: ${proposal.reasons.join("; ")}`);
        return null;
      }
      return {
        notionalUsd: proposal.notionalUsd,
        stopPct: proposal.stopDistancePct,
        leverage: proposal.leverage,
        reason: proposal.reasoning.join(" · "),
      };
    },
    /**
     * Where to rest an entry, or null to cross.
     *
     * Joining the queue at the touch rather than improving on it: a buy rests
     * at the current best bid. Improving the price would fill faster but gives
     * away part of the spread that resting was meant to earn, which defeats
     * the exercise.
     *
     * Returns null when mark-out says the passive side is being picked off, so
     * a toxic tape falls back to crossing rather than resting into it — the
     * same test the sizer priced the trade with, so the quoted cost and the
     * execution cannot disagree.
     */
    makerEntryPrice: (side) => {
      const state = feed?.getState();
      if (!state) return null;
      if (!canPostEntry(state.markout).ok) return null;
      const price = side === "BUY" ? state.bestBid : state.bestAsk;
      return price && price > 0 ? price : null;
    },
    // Every fill goes into the mark-out tracker, which is what turns the
    // maker-entry argument from a claim into a measurement: it reports the
    // slippage against the mid we decided on, and how the position marked out
    // 30s later. A maker fill that consistently marks out badly is being
    // adversely selected, and that is worth more than the 3bp it saved.
    onFill: (f) => {
      getEngine().recordOwnFill(f);
      log(`fill ${f.tag} ${f.side} ${f.notional.toFixed(0)} at ${f.price}`);
    },
    onRecord: (r) => {
      execHistory = [r, ...execHistory].slice(0, 200);
      log(`execution ${r.outcome}: ${r.detail}`);
    },
  });

  runner = attachExecution(feed, {
    adapter,
    minIntervalMs: Math.max(60_000, limits.lossCooldownMin * 60_000),
    maxPerHour: Math.max(1, limits.maxTradesPerDay),
    onRejected: (reason) => {
      lastRefusal = { at: Date.now(), reason };
      log(`intent rejected: ${reason}`);
    },
    // The commonest outcome by far, and previously invisible: a signal fired,
    // the bias looked at it and would not call a side, so nothing was proposed.
    // The reason comes from the evaluation that caused it, not a later one.
    onDeclined: (_signal, _state, reason) => {
      lastRefusal = { at: Date.now(), reason: reason ?? "the strategy passed on this signal" };
    },
    strategy: (signal, state) => {
      // Health signals describe the feed, not the market.
      if (signal.kind === "health") return null;
      const bias = directionalBias(state);
      if (!bias.direction) {
        runner?.noteDecline(bias.summary);
        return null;
      }

      const proposal = proposePosition({
        direction: bias.direction,
        state,
        equity: account.risk?.availableBalance ?? 0,
        realisedLossToday: day.activity ? dayDrawdown(day.activity) : 0,
        tradesToday: day.activity?.trades ?? 0,
        lastLossAt: day.activity?.lastLossAt ?? 0,
        // Both from Binance's income ledger rather than from anything this
        // process remembers: a restart is exactly when a costly run has just
        // happened, and in-memory counters would clear the budget at the moment
        // it matters. REALIZED_PNL is booked before commission, so it is the
        // gross figure the fee share is measured against.
        feesPaidToday: day.activity?.fees ?? 0,
        grossProfitToday: day.activity?.realisedPnl ?? 0,
        limits: {
          maxPositionUsd: limits.maxPositionUsd,
          maxLeverage: limits.maxLeverage,
          maxDailyLossUsd: limits.maxDailyLossUsd,
          stopLossPct: limits.stopLossPct,
          maxTradesPerDay: limits.maxTradesPerDay,
          lossCooldownMin: limits.lossCooldownMin,
          requireCashOpen: limits.requireCashOpen,
          minRewardRisk: limits.minRewardRisk,
        },
        costCurve: feed!.getCostCurve(),
        clusters: feed!.getClusters(),
        config: { riskFraction: limits.riskPerTradePct / 100, fees, canPostEntries: true },
      });
      if (!proposal.ok) {
        // Otherwise this surfaces as "the strategy passed on this signal",
        // above a GUI line asserting the bias called no side — which is the
        // opposite of what happened: it called a side and the sizer refused it.
        runner?.noteDecline(`sized out (${bias.direction}): ${proposal.reasons.join("; ")}`);
        return null;
      }

      return {
        id: intentId(signal),
        t: Date.now(),
        side: proposal.side === "long" ? "buy" : "sell",
        signalId: signal.id,
        signalKind: signal.kind,
        reason: `${signal.detail} | ${bias.summary}`,
        confidence: bias.conviction,
        reference: {
          mid: proposal.entryPrice,
          trigger: proposal.targetPrice,
          invalidation: proposal.stopPrice,
        },
      };
    },
  });
  log(`execution loop attached (${adapter.name})`);
}

function stopExecutionLoop() {
  runner?.stop();
  runner = null;
}

function status() {
  const state = feed?.getState() ?? null;
  const creds = hasCredentials();
  let mode: "none" | "testnet" | "live" = "none";
  if (creds) mode = process.env.BINANCE_LIVE === "1" ? "live" : "testnet";

  return {
    engine: {
      running: feed !== null,
      uptimeSec: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
      symbol: SYMBOL,
    },
    mode,
    hasCredentials: creds,
    health: state?.health ?? null,
    market: state
      ? {
          mid: state.mid,
          mark: state.mark,
          spreadBps: state.liquidity?.spreadBps ?? null,
          lwi: state.liquidity?.lwi ?? null,
          lwiBid: state.liquidity?.lwiBid ?? null,
          lwiAsk: state.liquidity?.lwiAsk ?? null,
          warm: state.liquidity?.warm ?? null,
          riskUp: state.cascadeUp?.risk ?? null,
          riskDown: state.cascadeDown?.risk ?? null,
          nearestAbove: state.nearestAbove?.price ?? null,
          nearestBelow: state.nearestBelow?.price ?? null,
          session: state.session.phase,
          flow: state.flow,
        }
      : null,
    account: {
      at: account.at,
      error: account.error,
      availableBalance: account.risk?.availableBalance ?? null,
      walletBalance: account.risk?.walletBalance ?? null,
      unrealizedPnl: account.risk?.totalUnrealizedPnl ?? null,
      marginRatio: account.risk?.marginRatio ?? null,
      positions:
        account.risk?.openPositions.map((p) => ({
          symbol: p.symbol,
          amt: p.positionAmt,
          entry: p.entryPrice,
          mark: p.markPrice,
          pnl: p.unrealizedPnl,
          liquidation: p.liquidationPrice,
          leverage: p.leverage,
          notional: p.notional,
        })) ?? [],
    },
    limits,
    day: day.activity
      ? {
          at: day.at,
          realisedPnl: day.activity.realisedPnl,
          drawdown: dayDrawdown(day.activity),
          trades: day.activity.trades,
          fees: day.activity.fees,
          funding: day.activity.funding,
          lastLossAt: day.activity.lastLossAt,
          cooldownLeftMin:
            limits.lossCooldownMin > 0 && day.activity.lastLossAt > 0
              ? Math.max(0, limits.lossCooldownMin - (Date.now() - day.activity.lastLossAt) / 60_000)
              : 0,
        }
      : { at: day.at, error: day.error },
    // Top-level rather than nested under `execution`, which is where the GUI
    // reads it from. Nested, every tile rendered "—" and the "loop is not
    // attached" warning fired permanently — a false alarm about the one thing
    // it exists to report truthfully.
    loop: {
      attached: runner !== null,
      signalsSeen,
      ...(runner
        ? runner.stats()
        : { seen: 0, accepted: 0, rejected: 0, declined: 0, lastAcceptedAt: 0 }),
      lastRefusal,
    },
    execution: {
      available: hasCredentials() && limits.tradingEnabled,
      armed: limits.tradingEnabled,
      running: runner !== null,
      reason: !hasCredentials()
        ? "no exchange credentials configured — monitor only"
        : !limits.tradingEnabled
          ? "trading is disarmed; set your caps and arm it to allow orders"
          : "armed — orders will be placed when a setup passes every check",
      history: execHistory.slice(0, 20),
      stats: runner?.stats() ?? null,
    },
    protection: {
      at: protection.at,
      error: protection.error,
      flat: protection.state ? protection.state.position === null : null,
      protected: protection.state?.protected ?? null,
      stopPrice: protection.state?.stop?.stopPrice ?? null,
      stopDistancePct: protection.state?.stopDistancePct ?? null,
      reason: protection.state?.reason ?? null,
    },
  };
}

/* ----------------------------------------------------------------- http api */

function send(res: ServerResponse, code: number, body: unknown, type = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, {
    "content-type": type,
    // A local console has no business being framed, cached or referred out.
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  res.end(text);
}

function authorised(req: IncomingMessage, url: URL): boolean {
  const header = req.headers["x-control-token"];
  const supplied = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("token") ?? "";
  // Length-independent compare is overkill on loopback, but the token is the
  // only thing standing between another local process and this API.
  if (supplied.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i++) diff |= supplied.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (!authorised(req, url)) {
    send(res, 401, { error: "bad or missing token", hint: "open the URL printed by the server" });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    send(res, 200, html(TOKEN), "text/html; charset=utf-8");
    return;
  }

  try {
    switch (`${req.method} ${url.pathname}`) {
      case "GET /api/status":
        send(res, 200, status());
        return;

      case "GET /api/signals": {
        const limit = Number(url.searchParams.get("limit") ?? 40);
        send(res, 200, { signals: feed?.recentSignals(limit) ?? [] });
        return;
      }

      case "POST /api/engine/start":
        startEngine();
        send(res, 200, status());
        return;

      case "POST /api/engine/stop":
        stopEngine();
        send(res, 200, status());
        return;

      case "POST /api/account/refresh":
        await refreshAccount();
        send(res, 200, status());
        return;

      case "POST /api/limits": {
        const body = await readJson(req);
        const n = (k: string, fallback: number) => {
          const v = Number(body[k]);
          return Number.isFinite(v) && v >= 0 ? v : fallback;
        };
        limits = {
          maxPositionUsd: n("maxPositionUsd", limits.maxPositionUsd),
          maxLeverage: Math.max(1, n("maxLeverage", limits.maxLeverage)),
          maxDailyLossUsd: n("maxDailyLossUsd", limits.maxDailyLossUsd),
          maxOpenPositions: Math.max(0, Math.round(n("maxOpenPositions", limits.maxOpenPositions))),
          tradingEnabled: body.tradingEnabled === true,
          stopLossPct: Math.max(0.1, n("stopLossPct", limits.stopLossPct)),
          maxTradesPerDay: Math.max(0, Math.round(n("maxTradesPerDay", limits.maxTradesPerDay))),
          lossCooldownMin: Math.max(0, n("lossCooldownMin", limits.lossCooldownMin)),
          // Absent means "unchanged", not "true". This previously read
          // `body.requireCashOpen !== false`, and the save-limits form does not
          // send the field — so undefined !== false turned cash-open-only ON
          // the first time anyone clicked Save, then persisted it to disk. The
          // default is false and the dial below is now the only thing that
          // moves it.
          requireCashOpen:
            typeof body.requireCashOpen === "boolean" ? body.requireCashOpen : limits.requireCashOpen,
          minRewardRisk: Math.max(0, n("minRewardRisk", limits.minRewardRisk)),
          // Capped at 10%: past that a short losing run ends the account
          // regardless of how good the entries are.
          riskPerTradePct: Math.min(10, Math.max(0.01, n("riskPerTradePct", limits.riskPerTradePct))),
        };
        writeLimits(limits);
        log(`limits updated: ${JSON.stringify(limits)}`);
        // Arming and disarming take effect immediately rather than at restart.
        if (limits.tradingEnabled) startExecutionLoop();
        else stopExecutionLoop();
        send(res, 200, status());
        return;
      }

      case "POST /api/suggest": {
        // Computes numbers and returns them. It does not apply anything, does
        // not touch the stored limits, and cannot place an order — the operator
        // reads the reasoning and decides what the caps should be.
        const body = await readJson(req);
        const state = feed?.getState() ?? null;
        if (!state) { send(res, 200, { error: "engine is not running" }); return; }
        const bias = directionalBias(state);
        // "auto" hands the choice to the bias read; an explicit side overrides it.
        const chosen =
          body.direction === "auto" || body.direction === undefined
            ? bias.direction
            : body.direction === "down"
              ? "down"
              : "up";
        if (!chosen) {
          send(res, 200, { result: { ok: false, reasons: [bias.summary] }, bias, participants: state.participants, volatilityPct: state.volatilityPct, appliedNothing: true });
          return;
        }
        const result = proposePosition({
          direction: chosen,
          state,
          equity: account.risk?.availableBalance ?? Number(body.assumeEquity) ?? 0,
          realisedLossToday: 0,
          tradesToday: 0,
          lastLossAt: 0,
          // Advisory: the day counters are zeroed so a suggestion is not
          // suppressed by the caps. The fee tier is not zeroed, because a
          // suggestion priced at a rate that is no longer in force is worse
          // than no suggestion.
          feeTierTradeCount: day.activity?.trades ?? 0,
          feesPaidToday: day.activity?.fees ?? 0,
          grossProfitToday: day.activity?.realisedPnl ?? 0,
          limits: {
            maxPositionUsd: limits.maxPositionUsd > 0 ? limits.maxPositionUsd : Number(body.assumeMaxPositionUsd) || 0,
            maxLeverage: limits.maxLeverage,
            maxDailyLossUsd: limits.maxDailyLossUsd,
            stopLossPct: limits.stopLossPct,
            maxTradesPerDay: limits.maxTradesPerDay,
            lossCooldownMin: limits.lossCooldownMin,
            requireCashOpen: limits.requireCashOpen,
            minRewardRisk: limits.minRewardRisk,
          },
          costCurve: feed ? feed.getCostCurve() : [],
          clusters: feed ? feed.getClusters() : [],
          config: { riskFraction: limits.riskPerTradePct / 100, fees, canPostEntries: true },
        });
        send(res, 200, {
          result,
          bias,
          participants: state.participants,
          volatilityPct: state.volatilityPct,
          markout: state.markout,
          funding: state.funding,
          events: state.events,
          session: state.session,
          appliedNothing: true,
        });
        return;
      }

      case "POST /api/place": {
        /*
         * A manual order, for testing the order path.
         *
         * The automatic loop refuses almost everything on a quiet book, and
         * correctly so: on an overnight INTC the nearest cluster is a few basis
         * points away against a 7bp round trip, which is a guaranteed loss. But
         * that leaves the entry, the protective stop and the flatten path
         * exercised only against a stubbed exchange, and those are precisely
         * the things worth proving against a real one before real money.
         *
         * So this bypasses the strategy, the bias and the sizer — the parts
         * that decide *whether* — and keeps every interlock that decides
         * *whether it is safe*: the position cap, the leverage ceiling, one
         * position at a time, and a protective stop that is placed or the
         * entry is unwound.
         */
        const body = await readJson(req);
        if (!hasCredentials()) { send(res, 200, { error: "no API credentials" }); return; }

        const side = body.side === "short" ? "short" : "long";
        const notional = Math.max(0, Number(body.notionalUsd) || 0);
        const stopPct = Math.max(0.1, Number(body.stopPct) || limits.stopLossPct);

        // Local checks first. "Enter a size" is a more useful answer to an
        // empty field than "no price yet", and neither needs the network.
        if (notional <= 0) { send(res, 200, { error: "enter a size" }); return; }
        if (limits.maxPositionUsd > 0 && notional > limits.maxPositionUsd) {
          send(res, 200, { error: `${notional} exceeds the ${limits.maxPositionUsd} max position` });
          return;
        }

        const state = feed?.getState() ?? null;
        const price = state?.mark ?? state?.mid ?? 0;
        if (!price) { send(res, 200, { error: "no price yet — start the engine and wait for the book" }); return; }

        try {
          const cfg2 = loadConfig();
          const existing = await fetchPosition(cfg2, SYMBOL);
          if (existing) {
            send(res, 200, { error: `already holding ${existing.positionAmt} — close it first` });
            return;
          }
          const risk2 = await fetchAccountRisk(cfg2);
          const leverage = Math.min(limits.maxLeverage, Math.max(1, Math.ceil(notional / Math.max(risk2.availableBalance, 1e-9))));

          // Rounded to the contract's own step, not to whole units: BTCUSDT
          // trades in thousandths and 1 BTC is not a test order.
          const qtyPrecision = meta()?.quantityPrecision ?? 0;
          const qty = Number((notional / price).toFixed(qtyPrecision));
          if (!(qty > 0)) {
            const min = Number((10 ** -qtyPrecision * price).toFixed(2));
            send(res, 200, {
              error: `${notional} is below the smallest tradable size at ${price.toFixed(2)} — the minimum is about ${min}`,
            });
            return;
          }

          await setLeverage(cfg2, SYMBOL, leverage);
          log(`MANUAL ORDER: ${side} ${qty} ${SYMBOL} at market, ${leverage}x, stop ${stopPct}%`);
          const { entry, stop } = await openProtectedPosition(
            cfg2,
            SYMBOL,
            side === "long" ? "BUY" : "SELL",
            String(qty),
            stopPct,
            meta()?.pricePrecision ?? 2,
          );
          log(`MANUAL ORDER filled — stop resting at ${stop.stopPrice}`);
          await refreshAccount();
          send(res, 200, { ok: true, entry, stop, leverage, quantity: qty, ...status() });
        } catch (err) {
          const message = err instanceof Error ? redact(err.message) : String(err);
          log(`MANUAL ORDER failed: ${message}`);
          send(res, 200, { error: message });
        }
        return;
      }

      case "POST /api/close": {
        // Flatten without stopping the engine, which is what Kill does.
        if (!hasCredentials()) { send(res, 200, { error: "no API credentials" }); return; }
        try {
          const cfg2 = loadConfig();
          await closePosition(cfg2, SYMBOL);
          log("MANUAL CLOSE: position flattened at market");
          await refreshAccount();
          send(res, 200, { ok: true, ...status() });
        } catch (err) {
          const message = err instanceof Error ? redact(err.message) : String(err);
          log(`manual close failed: ${message}`);
          send(res, 200, { error: message });
        }
        return;
      }

      case "POST /api/preview": {
        const body = await readJson(req);
        const state = feed?.getState() ?? null;
        const entry = Number(body.entryPrice) || state?.mark || state?.mid || 0;
        if (!entry) {
          send(res, 200, { error: "no price available yet — start the engine and wait for the book" });
          return;
        }
        const raw = feed ? feed.getClusters() : [];
        const preview = previewPosition({
          side: body.side === "short" ? "short" : "long",
          notionalUsd: Math.max(0, Number(body.notionalUsd) || 0),
          leverage: Math.max(1, Number(body.leverage) || 1),
          entryPrice: entry,
          availableBalance: account.risk?.availableBalance ?? 0,
          maintMarginRate: Number(body.maintMarginRate) || CONFIG.maintenanceMarginRate,
          takerFeeRate: Number(body.takerFeeRate) || 0.0005,
          makerFeeRate: Number(body.makerFeeRate) || 0.0002,
          stepSize: meta()?.stepSize ?? 0.001,
          pricePrecision: meta()?.pricePrecision ?? 2,
          clusters: raw,
        });
        // Checked against the limits already stored, so the preview says
        // whether this position would be allowed, not merely what it costs.
        const breaches: string[] = [];
        if (limits.maxPositionUsd > 0 && preview.notional > limits.maxPositionUsd) {
          breaches.push(`notional ${preview.notional.toFixed(0)} exceeds max ${limits.maxPositionUsd}`);
        }
        if (preview.leverage > limits.maxLeverage) {
          breaches.push(`leverage ${preview.leverage}x exceeds max ${limits.maxLeverage}x`);
        }
        if ((account.risk?.openPositions.length ?? 0) >= limits.maxOpenPositions) {
          breaches.push(`already at max open positions (${limits.maxOpenPositions})`);
        }
        send(res, 200, { preview, breaches, usedEntry: entry, accountKnown: account.risk !== null });
        return;
      }

      case "POST /api/protect": {
        if (!hasCredentials()) { send(res, 200, { error: "no credentials configured" }); return; }
        const cfg = loadConfig();
        const position = await fetchPosition(cfg, SYMBOL);
        const state = await ensureProtected(cfg, SYMBOL, position, limits.stopLossPct, 2);
        protection = { state, error: null, at: Date.now() };
        log(`manual protect: ${state.reason}`);
        send(res, 200, status());
        return;
      }

      case "POST /api/flatten": {
        if (!hasCredentials()) { send(res, 200, { error: "no credentials configured" }); return; }
        const result = await flatten(loadConfig(), SYMBOL);
        log(`FLATTEN: ${result}`);
        await refreshAccount();
        send(res, 200, { ...status(), flattened: result });
        return;
      }

      case "GET /api/diagnose": {
        /*
         * One place that answers "why is nothing happening".
         *
         * Every check here corresponds to something that has actually gone
         * wrong in this project rather than to a category someone imagined:
         * .env not being read, a saved flag quietly refusing every setup out of
         * hours, the loop claiming to be armed while attached to nothing, a
         * worker judged dead because its output file was empty. The point is to
         * return the specific next action, not a status colour.
         */
        const checks: {
          name: string;
          ok: boolean;
          severity: "ok" | "warn" | "bad";
          detail: string;
          fix?: string;
        }[] = [];
        const add = (
          name: string,
          ok: boolean,
          detail: string,
          fix?: string,
          severity: "ok" | "warn" | "bad" = ok ? "ok" : "bad",
        ) => checks.push({ name, ok, severity, detail, fix });

        add(
          ".env loaded",
          dotenv.found && dotenv.count > 0,
          dotenv.found ? `${dotenv.path} — ${dotenv.count} values` : `not found at ${dotenv.path}`,
          dotenv.found ? "Check the key names are exactly BINANCE_API_KEY and BINANCE_API_SECRET."
            : "On Windows, Notepad saves it as .env.txt unless you set Save as type to All Files.",
        );

        const creds = hasCredentials();
        add("credentials present", creds,
          creds ? (process.env.BINANCE_LIVE === "1" ? "LIVE — real money" : "demo trading") : "none",
          creds ? undefined : "Run npm run sweep:check to test them on their own.");

        const acctOk = account.risk !== null;
        add("exchange reachable", acctOk,
          acctOk ? `balance ${account.risk?.availableBalance.toFixed(2)} USDT`
                 : (account.error ?? "no account read yet"),
          acctOk ? undefined : "npm run sweep:check names the specific cause.");

        const engineOn = feed !== null;
        add("engine running", engineOn, engineOn ? `up ${Math.round((Date.now() - startedAt) / 1000)}s` : "stopped",
          engineOn ? undefined : "Press Start at the top of this page.");

        const st = feed?.getState();
        const healthy = st?.health.tradeable === true;
        add("feed tradeable", healthy,
          st ? `${st.health.level}${st.health.tradeable ? "" : " — " + st.health.summary}` : "no state",
          healthy ? undefined
            : "Depth baselines need about a minute. If it stays blind, the WebSocket to Binance is blocked.",
          healthy ? "ok" : st?.health.level === "degraded" ? "warn" : "bad");

        add("max position set", limits.maxPositionUsd > 0,
          limits.maxPositionUsd > 0 ? `${limits.maxPositionUsd} USD` : "not set — every setup is refused",
          "Set it in Risk limits and save.");

        add("max daily loss set", limits.maxDailyLossUsd > 0,
          limits.maxDailyLossUsd > 0 ? `${limits.maxDailyLossUsd} USD` : "not set",
          "Set it in Risk limits and save.");

        // The specific trap: a flag that silently refuses everything out of hours.
        const cashBlocking = limits.requireCashOpen && st?.session.cashOpen === false;
        add("session rule", !cashBlocking,
          limits.requireCashOpen
            ? `set to "do not trade" while Nasdaq is shut — currently ${st?.session.phase ?? "?"}`
            : "trades outside cash hours at reduced size",
          cashBlocking ? 'Set "When Nasdaq is shut" to "trade, sized down".' : undefined,
          cashBlocking ? "warn" : "ok");

        add("armed", limits.tradingEnabled,
          limits.tradingEnabled ? "orders will be placed when a setup passes" : "disarmed — nothing will be sent",
          limits.tradingEnabled ? undefined : "Press Start trading. It always boots disarmed by design.",
          limits.tradingEnabled ? "ok" : "warn");

        add("execution loop attached", runner !== null,
          runner ? "listening to the signal stream" : "not attached",
          runner ? undefined : "Needs the engine running and credentials. Disarm and re-arm.",
          runner ? "ok" : limits.tradingEnabled ? "bad" : "warn");

        for (const [worker, label, cmd] of [
          ["sweep-paper", "evidence sampler", "npm run sweep:paper"],
          ["sweep-shadow", "shadow run", "npm run sweep:shadow"],
        ] as const) {
          const b = readHeartbeat(worker);
          add(label, b.running,
            b.running ? `${Math.round(b.ageMs / 1000)}s since its last beat`
              : b.stale ? `last beat ${Math.round(b.ageMs / 60_000)} min ago — stopped or wedged`
              : "never started",
            b.running ? undefined : `Run ${cmd} in its own window.`,
            b.running ? "ok" : "warn");
        }

        const s2 = runner?.stats();
        if (s2) {
          const explained = s2.accepted + s2.rejected + s2.declined;
          add("loop accounting", explained === s2.seen,
            `${s2.seen} seen = ${s2.accepted} placed + ${s2.declined} no side + ${s2.rejected} refused`,
            explained === s2.seen ? undefined : "Signals are going unaccounted — that is a bug, not a setting.",
            explained === s2.seen ? "ok" : "bad");
        }

        add("symbol", IS_CALIBRATED_SYMBOL,
          IS_CALIBRATED_SYMBOL
            ? `${SYMBOL} — what every model here is calibrated to`
            : `${SYMBOL} — NOT the calibrated contract`,
          IS_CALIBRATED_SYMBOL
            ? undefined
            : "Fine for testing that orders place. The leverage ladder, maintenance rate, session " +
              "weights and earnings calendar are all built for an equity perp on Nasdaq and mean " +
              "nothing here — do not read a strategy result off this.",
          IS_CALIBRATED_SYMBOL ? "ok" : "warn");

        const bad = checks.filter((c) => c.severity === "bad");
        const warn = checks.filter((c) => c.severity === "warn");
        send(res, 200, {
          checks,
          verdict: bad.length
            ? `${bad.length} thing${bad.length === 1 ? "" : "s"} broken`
            : warn.length
              ? `nothing broken; ${warn.length} thing${warn.length === 1 ? "" : "s"} would stop a trade`
              : "everything checks out — quiet means no setup has qualified yet",
          worst: bad.length ? "bad" : warn.length ? "warn" : "ok",
        });
        return;
      }

      case "GET /api/log": {
        const since = Number(new URL(req.url ?? "", "http://x").searchParams.get("since") ?? 0);
        send(res, 200, { lines: logLines.filter((l) => l.t > since).slice(-200), now: Date.now() });
        return;
      }

      case "GET /api/runs": {
        /*
         * The paper sampler and the shadow run are separate processes, so their
         * stdout is not reachable from here. Their output files are, and the
         * files are the part worth seeing anyway — whether they are running,
         * how much they have recorded, and what the shadow run would have made.
         */
        const read = (file: string) => {
          const full = resolve(file);
          if (!existsSync(full)) return { path: full, exists: false, rows: 0, lastAt: 0, lines: [] as string[] };
          const text = readFileSync(full, "utf8");
          const lines = text.split("\n").filter((l) => l.trim());
          let lastAt = 0;
          try {
            lastAt = JSON.parse(lines[lines.length - 1] ?? "{}").at ?? JSON.parse(lines[lines.length - 1] ?? "{}").t ?? 0;
          } catch { /* a half-written last line is normal while appending */ }
          return { path: full, exists: true, rows: lines.length, lastAt, lines: lines.slice(-30) };
        };

        const paper = read(process.env.SWEEP_PAPER_OUT ?? "data/sweep-paper.jsonl");
        const shadowRaw = read(process.env.SWEEP_SHADOW_OUT ?? "data/sweep-shadow.jsonl");
        // Liveness comes from the heartbeat, never from the output file: the
        // shadow run writes nothing until its first trade has been open a full
        // fifteen minutes, so an empty file is the normal state of a healthy
        // process rather than evidence it is not running.
        const paperBeat = readHeartbeat("sweep-paper");
        const shadowBeat = readHeartbeat("sweep-shadow");

        interface ShadowRow {
          at: number; side: string; entryPrice: number; quantity: number; signalKind: string;
          feeUsd: number; resolved?: string; style: { entry: string };
          outcomes: Record<string, { netUsd: number | null }>;
        }
        const trades: ShadowRow[] = [];
        for (const line of shadowRaw.lines) {
          try { trades.push(JSON.parse(line) as ShadowRow); } catch { /* skip */ }
        }
        const scored = trades.filter((t) => typeof t.outcomes?.t900?.netUsd === "number");
        const net = scored.reduce((a, t) => a + (t.outcomes.t900.netUsd as number), 0);
        const fees = scored.reduce((a, t) => a + t.feeUsd, 0);

        send(res, 200, {
          paper: { ...paper, lines: undefined, beat: paperBeat },
          shadow: {
            beat: shadowBeat,
            path: shadowRaw.path,
            exists: shadowRaw.exists,
            rows: shadowRaw.rows,
            lastAt: shadowRaw.lastAt,
            scored: scored.length,
            netUsd: net,
            feesUsd: fees,
            wins: scored.filter((t) => (t.outcomes.t900.netUsd as number) > 0).length,
            recent: trades.slice(-8).reverse(),
          },
          now: Date.now(),
        });
        return;
      }

      case "GET /api/funds": {
        if (!hasCredentials()) { send(res, 200, { error: "no credentials" }); return; }
        const cfg2 = loadConfig();
        let spot: number | null = null;
        let spotError: string | null = null;
        if (cfg2.live && transfersAllowed()) {
          try { spot = await fetchSpotUsdt(cfg2); }
          catch (err) { spotError = err instanceof Error ? redact(err.message) : String(err); }
        }
        send(res, 200, {
          live: cfg2.live,
          transfersAllowed: transfersAllowed(),
          spotUsdt: spot,
          spotError,
          futuresUsdt: account.risk?.availableBalance ?? null,
          // Demo has no transfer API at all; Binance funds it from a faucet on
          // the website, so the GUI points there rather than showing a button
          // that cannot do anything.
          faucetUrl: cfg2.live ? null : "https://testnet.binancefuture.com",
        });
        return;
      }

      case "POST /api/transfer": {
        const body = await readJson(req);
        const amount = Number(body.amount);
        const direction = body.direction === "futures-to-spot" ? "futures-to-spot" : "spot-to-futures";
        try {
          const cfg2 = loadConfig();
          const r = await transferUsdt(cfg2, direction, amount);
          log(`transfer ${direction} ${amount} USDT — tranId ${r.tranId}`);
          await refreshAccount();
          send(res, 200, { ok: true, ...r, ...status() });
        } catch (err) {
          send(res, 200, { error: err instanceof Error ? redact(err.message) : String(err) });
        }
        return;
      }

      case "POST /api/arm": {
        // Arming is its own endpoint rather than a field on the limits form, so
        // it cannot be flipped as a side effect of saving something else — which
        // is exactly how requireCashOpen turned itself on.
        const body = await readJson(req);
        const want = body.armed === true;
        if (want) {
          if (!hasCredentials()) { send(res, 200, { error: "no API credentials — nothing can be placed" }); return; }
          if (limits.maxPositionUsd <= 0) { send(res, 200, { error: "set a max position size first" }); return; }
          if (limits.maxDailyLossUsd <= 0) { send(res, 200, { error: "set a max daily loss first" }); return; }
        }
        limits = { ...limits, tradingEnabled: want };
        writeLimits(limits);
        if (want) startExecutionLoop(); else stopExecutionLoop();
        log(want ? "ARMED — orders will be placed when a setup passes every check" : "disarmed");
        send(res, 200, status());
        return;
      }

      case "POST /api/kill": {
        // The stop-everything control. Today that means killing the feed and
        // disarming trading; once orders exist it also cancels and flattens.
        limits = { ...limits, tradingEnabled: false };
        writeLimits(limits);
        stopExecutionLoop();
        stopEngine();
        log("KILL: execution detached, engine stopped, trading disarmed");
        send(res, 200, { ...status(), killed: true });
        return;
      }

      default:
        send(res, 404, { error: "not found" });
    }
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    log("request failed:", message);
    send(res, 500, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  // The file may still say armed from the last session; readLimits() has
  // already overridden it, and writing it back keeps the two in step.
  writeLimits(limits);
  startEngine();
  void (async () => {
    await reconcileOnStart();
    await refreshAccount();
  })();
  const url = `http://${HOST}:${PORT}/?token=${TOKEN}`;
  console.log("");
  console.log("  Sweep agent control");
  console.log(`  ${url}`);
  console.log("");
  console.log(`  mode:        ${hasCredentials() ? (process.env.BINANCE_LIVE === "1" ? "LIVE" : "testnet") : "no credentials (monitor only)"}`);
  if (HOST !== "127.0.0.1") {
    console.log("");
    console.log(`  !! bound to ${HOST}, not loopback — this port can move money.`);
    console.log("     Only do this behind a tunnel that authenticates before traffic reaches here.");
  }
  console.log(`  symbol:      ${SYMBOL}${IS_CALIBRATED_SYMBOL ? "" : "  (NOT the calibrated contract — plumbing tests only)"}`);
  console.log(`  limits file: ${LIMITS_PATH}`);
  // Say plainly where credentials were looked for and what turned up. "No
  // credentials" with a .env sitting right there is a confusing thing to be
  // told, and the answer is almost always that the file was not found or the
  // names are misspelt rather than that the keys are wrong.
  console.log(
    `  .env:        ${
      dotenv.found ? `${dotenv.path} (${dotenv.count} values)` : `not found at ${dotenv.path}`
    }`,
  );
  if (!hasCredentials()) {
    console.log("");
    console.log("  No BINANCE_API_KEY / BINANCE_API_SECRET, so this is monitor-only.");
    console.log("  Run  npm run sweep:check  to test them on their own.");
  }
  console.log("  ctrl-c to stop");
  console.log("");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopExecutionLoop();
    stopEngine();
    server.close();
    // Positions are deliberately left open: their protection is the stop
    // resting on the exchange, which outlives this process.
    console.log("");
    console.log("  Stopped. Any open position is LEFT OPEN by design —");
    console.log("  its stop-loss is on Binance and keeps working while this is off.");
    console.log("  Restarting re-checks the position and replaces the stop if it is missing.");
    console.log("");
    process.exit(0);
  });
}

/* -------------------------------------------------------------------- gui */

function html(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sweep agent control</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--plane:#0d0d0d;--surface:#141413;--surface2:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;
--hair:rgba(255,255,255,.1);--good:#0ca30c;--warn:#fab219;--bad:#d03b3b;--liq:#3987e5;--forced:#d95926;--r:6px}
*{box-sizing:border-box}body{margin:0;background:var(--plane);color:var(--ink);
font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1200px;margin:0 auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:var(--surface);
border:1px solid var(--hair);border-radius:var(--r);padding:12px 16px}
.bar b{font-size:15px}
.mode{padding:3px 10px;border-radius:999px;font-size:11px;border:1px solid var(--hair);white-space:nowrap}
.mode.live{background:rgba(208,59,59,.15);border-color:var(--bad);color:#ff8a8a;font-weight:600}
.mode.testnet{background:rgba(57,135,229,.12);border-color:var(--liq);color:#8fc0ff}
.mode.none{color:var(--muted)}
.grid{display:grid;gap:12px;grid-template-columns:1fr}
@media(min-width:960px){.grid{grid-template-columns:1fr 1fr}}
.panel{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r);padding:12px 14px 14px}
.panel h2{margin:0 0 10px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink2)}
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--hair);
border:1px solid var(--hair);border-radius:var(--r);overflow:hidden}
.tile{background:var(--surface);padding:9px 11px;display:flex;flex-direction:column;gap:2px}
.k{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.v{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
.d{font-size:11px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.dot.ok{background:var(--good)}.dot.degraded{background:var(--warn)}.dot.blind{background:var(--bad)}
button{background:var(--surface2);color:var(--ink);border:1px solid var(--hair);border-radius:var(--r);
padding:7px 13px;font:inherit;cursor:pointer}
button:hover:not(:disabled){border-color:var(--liq)}
button:disabled{opacity:.4;cursor:not-allowed}
button.danger{border-color:var(--bad);color:#ff9c9c}
button.danger:hover:not(:disabled){background:rgba(208,59,59,.15)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:right;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);
font-weight:500;padding:4px 6px;border-bottom:1px solid #2c2c2a}
th:first-child,td:first-child{text-align:left}
td{text-align:right;padding:4px 6px;font-size:12px;border-bottom:1px solid rgba(255,255,255,.04)}
.sig{max-height:340px;overflow-y:auto}
.sig .item{padding:6px 4px;border-bottom:1px solid rgba(255,255,255,.05);display:flex;gap:8px;align-items:baseline}
.sev{font-size:10px;text-transform:uppercase;letter-spacing:.05em;flex:none;width:58px}
.sev.info{color:var(--muted)}.sev.warning{color:var(--warn)}.sev.critical{color:var(--bad)}
.muted{color:var(--muted)}
.note{font-size:11px;color:var(--muted);margin:8px 0 0}
label{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--muted)}
input{background:var(--plane);border:1px solid var(--hair);border-radius:4px;color:var(--ink);
padding:6px 8px;font:inherit;font-variant-numeric:tabular-nums;width:100%}
.banner{display:flex;gap:10px;padding:10px 12px;border-radius:var(--r);border:1px solid;align-items:flex-start}
.banner.bad{background:rgba(208,59,59,.1);border-color:rgba(208,59,59,.5)}
.banner.warn{background:rgba(250,178,25,.08);border-color:rgba(250,178,25,.45)}
</style></head><body><div class="wrap">

<div class="bar">
  <b>Sweep agent</b>
  <span id="mode" class="mode none">—</span>
  <span class="row" style="gap:6px"><i id="hdot" class="dot blind"></i><span id="health" class="muted">connecting…</span></span>
  <span class="muted" id="uptime"></span>
  <span style="flex:1"></span>
  <button id="btnStart">Start</button>
  <button id="btnStop">Stop</button>
  <button id="btnRefresh">Refresh account</button>
  <button id="btnKill" class="danger">Kill</button>
</div>

<div id="protNote"></div>
<div id="execNote"></div>

<div class="grid">
  <div class="panel">
    <h2>Market</h2>
    <div class="tiles">
      <div class="tile"><span class="k">Mid</span><span class="v" id="mid">—</span><span class="d" id="session">—</span></div>
      <div class="tile"><span class="k">Depth index</span><span class="v" id="lwi">—</span><span class="d" id="lwiSides">bid / ask</span></div>
      <div class="tile"><span class="k">Cascade ↓</span><span class="v" id="riskDown">—</span><span class="d" id="below">—</span></div>
      <div class="tile"><span class="k">Cascade ↑</span><span class="v" id="riskUp">—</span><span class="d" id="above">—</span></div>
    </div>
    <p class="note" id="healthNote"></p>
  </div>

  <div class="panel">
    <h2>Position &amp; risk</h2>
    <div class="tiles">
      <div class="tile"><span class="k">Available</span><span class="v" id="avail">—</span><span class="d">USDT</span></div>
      <div class="tile"><span class="k">Unrealised</span><span class="v" id="upnl">—</span><span class="d">open PnL</span></div>
      <div class="tile"><span class="k">Margin ratio</span><span class="v" id="mratio">—</span><span class="d">maint / balance</span></div>
      <div class="tile"><span class="k">Open</span><span class="v" id="npos">—</span><span class="d">positions</span></div>
    </div>
    <table style="margin-top:10px"><thead><tr><th>Symbol</th><th>Size</th><th>Entry</th><th>Liq.</th><th>PnL</th></tr></thead>
    <tbody id="positions"><tr><td colspan="5" class="muted">no account data</td></tr></tbody></table>
    <p class="note" id="acctNote"></p>
  </div>
</div>

<div class="panel">
  <h2>Diagnostics</h2>
  <div class="row" style="gap:12px;align-items:center">
    <button id="btnDiag">Run diagnostics</button>
    <span id="diagVerdict" class="muted"></span>
  </div>
  <div id="diagOut" style="margin-top:10px"></div>
  <p class="note">Checks everything between a signal firing and an order going out, and names the specific
  next action for anything in the way. Reads only — it places nothing and changes no setting.</p>
</div>

<div class="panel">
  <h2>Background runs</h2>
  <div class="tiles">
    <div class="tile"><span class="k">Evidence log</span><span class="v" id="rPaper">—</span><span class="d" id="rPaperD">npm run sweep:paper</span></div>
    <div class="tile"><span class="k">Shadow trades</span><span class="v" id="rShadow">—</span><span class="d" id="rShadowD">npm run sweep:shadow</span></div>
    <div class="tile"><span class="k">Shadow net P&amp;L</span><span class="v" id="rNet">—</span><span class="d" id="rNetD">after fees</span></div>
  </div>
  <table style="margin-top:10px"><thead><tr><th style="text-align:left">Time</th><th style="text-align:left">Trade</th><th style="text-align:left">Signal</th><th>Net</th><th style="text-align:left">Outcome</th></tr></thead>
  <tbody id="rTrades"><tr><td colspan="5" class="muted">nothing recorded yet</td></tr></tbody></table>
  <p class="note" id="rNote"></p>
</div>

<div class="panel">
  <h2>Activity</h2>
  <pre id="logBox" style="margin:0;max-height:280px;overflow:auto;background:var(--plane);border:1px solid var(--hair);border-radius:6px;padding:10px;font-size:11px;line-height:1.5;white-space:pre-wrap"></pre>
  <p class="note">Everything this server does, as it happens — orders going out, stops landing, and the sizer's
  reason whenever it declines a setup. Same lines as the terminal.</p>
</div>

<div class="panel">
  <h2>Funds</h2>
  <div class="tiles">
    <div class="tile"><span class="k">Futures wallet</span><span class="v" id="fFut">—</span><span class="d">what positions are sized against</span></div>
    <div class="tile"><span class="k">Spot wallet</span><span class="v" id="fSpot">—</span><span class="d" id="fSpotD">available to move in</span></div>
  </div>
  <div class="row" id="fRow" style="gap:12px;align-items:flex-end;margin-top:10px">
    <label style="width:150px">Amount (USDT)<input id="fAmount" type="number" min="1" step="10" value="100"></label>
    <button id="btnFundIn">Move into futures</button>
    <button id="btnFundOut">Move back to spot</button>
  </div>
  <p class="note" id="fNote"></p>
</div>

<div class="panel">
  <h2>Trading</h2>
  <div class="row" style="gap:12px;align-items:center">
    <button id="btnArm" style="font-size:14px;padding:10px 20px">Start trading</button>
    <span id="armState" class="muted"></span>
  </div>
  <div class="tiles" style="margin-top:10px">
    <div class="tile"><span class="k">Signals seen</span><span class="v" id="lSig">—</span><span class="d" id="lSigD">by the loop, since armed</span></div>
    <div class="tile"><span class="k">Orders placed</span><span class="v" id="lAcc">—</span><span class="d">accepted by every check</span></div>
    <div class="tile"><span class="k">No side called</span><span class="v" id="lDec">—</span><span class="d">bias saw no asymmetry worth trading</span></div>
    <div class="tile"><span class="k">Refused</span><span class="v" id="lRej">—</span><span class="d">a setup that failed a check</span></div>
  </div>
  <p class="note" id="lWhy"></p>
  <p class="note">Nothing is sent while this is off — Suggest and Preview keep working. Arming needs a max
  position and a max daily loss set below, because those are the only things bounding what it can do.
  <b>This always starts disarmed</b>, however it was left: a process that resumes placing orders on its own after
  a crash or a reboot is acting on a decision nobody was there to make. Any open position is unaffected —
  its stop lives <b>on Binance</b> and keeps working whether this is armed, running, or closed.</p>
</div>

<div class="panel">
  <h2>Risk limits</h2>
  <div class="row" style="gap:12px;align-items:flex-end">
    <label style="width:150px">Max position (USD)<input id="maxPositionUsd" type="number" min="0" step="10"></label>
    <label style="width:110px">Max leverage<input id="maxLeverage" type="number" min="1" max="10" step="1"></label>
    <label style="width:150px">Max daily loss (USD)<input id="maxDailyLossUsd" type="number" min="0" step="10"></label>
    <label style="width:130px">Max open positions<input id="maxOpenPositions" type="number" min="0" step="1"></label>
    <label style="width:140px">Stop-loss distance (%)<input id="stopLossPct" type="number" min="0.1" step="0.1"></label>
    <label style="width:140px">Risk per trade (%)<input id="riskPerTradePct" type="number" min="0.01" max="10" step="0.1"></label>
    <label style="width:150px">When Nasdaq is shut<select id="requireCashOpen" style="background:var(--plane);border:1px solid var(--hair);border-radius:4px;color:var(--ink);padding:6px 8px;font:inherit">
      <option value="false">trade, sized down</option><option value="true">do not trade</option></select></label>
    <label style="width:130px">Trading armed<select id="tradingEnabled" style="background:var(--plane);border:1px solid var(--hair);border-radius:4px;color:var(--ink);padding:6px 8px;font:inherit">
      <option value="false">disarmed</option><option value="true">armed</option></select></label>
    <button id="btnLimits">Save limits</button>
  </div>
  <p class="note">Stored on this machine and enforced on every order. <b>Armed means orders will be placed</b> when a setup
  passes every check — leave it disarmed to use Suggest and Preview without anything being sent.
  Every position gets a stop-loss placed <b>on Binance</b> — it keeps working when this program is closed.</p>
</div>

<div class="panel">
  <h2>Position preview — before anything is sent</h2>
  <div class="row" style="gap:12px;align-items:flex-end">
    <label style="width:110px">Side<select id="pvSide" style="background:var(--plane);border:1px solid var(--hair);border-radius:4px;color:var(--ink);padding:6px 8px;font:inherit">
      <option value="long">long</option><option value="short">short</option></select></label>
    <label style="width:150px">Size (USD)<input id="pvNotional" type="number" min="0" step="50" value="1000"></label>
    <label style="width:110px">Leverage<input id="pvLeverage" type="number" min="1" max="10" step="1" value="2"></label>
    <label style="width:150px">Entry (blank = mark)<input id="pvEntry" type="number" step="0.01" placeholder="mark"></label>
    <button id="btnPreview">Preview</button>
    <label style="width:120px">Stop (%)<input id="pvStopPct" type="number" min="0.1" step="0.1" value="3"></label>
    <button id="btnPlace" style="border-color:var(--warn);color:var(--warn)">Place this order</button>
    <button id="btnClose">Close position</button>
  </div>
  <div id="pvOut" style="margin-top:12px"><span class="muted">Enter a size and press Preview.</span></div>
  <p class="note"><b>Place this order</b> sends a real order now, bypassing the strategy, the bias and the sizer —
  it exists to exercise the order path, which the automatic loop rarely reaches on a quiet book because the
  nearest target is usually worth less than the round trip. Every safety interlock still applies: the position
  cap, the leverage ceiling, one position at a time, and a protective stop that is placed on Binance or the
  entry is unwound. Use it once on demo to confirm the stop appears, then close it.</p>
  <div class="row" style="margin-top:12px;gap:8px;align-items:center;border-top:1px solid var(--hair);padding-top:12px">
    <b style="font-size:12px">Suggest numbers</b>
    <select id="sgDir" style="background:var(--plane);border:1px solid var(--hair);border-radius:4px;color:var(--ink);padding:6px 8px;font:inherit">
      <option value="auto">let it decide</option><option value="up">upside</option><option value="down">downside</option></select>
    <button id="btnSuggest">Work out a setup</button>
    <span class="muted" style="font-size:11px">reads the live book and proposes size, stop and target — applies nothing</span>
  </div>
  <div id="sgOut" style="margin-top:10px"></div>
</div>

<div class="panel">
  <h2>Signals</h2>
  <div class="sig" id="signals"><div class="muted">none yet</div></div>
</div>

</div><script>
const TOKEN=${JSON.stringify(token)};
const api=(p,o={})=>fetch(p,{...o,headers:{"x-control-token":TOKEN,"content-type":"application/json"}}).then(r=>r.json());
const $=id=>document.getElementById(id);
const n=(v,d=2)=>v===null||v===undefined||!isFinite(v)?"—":Number(v).toFixed(d);
const usd=v=>v===null||v===undefined||!isFinite(v)?"—":(Math.abs(v)>=1e6?"$"+(v/1e6).toFixed(2)+"M":Math.abs(v)>=1e3?"$"+(v/1e3).toFixed(1)+"k":"$"+v.toFixed(2));

let limitsDirty=false;
for(const id of ["maxPositionUsd","maxLeverage","maxDailyLossUsd","maxOpenPositions","stopLossPct","riskPerTradePct"]) $(id).addEventListener("input",()=>limitsDirty=true);
$("tradingEnabled").addEventListener("change",()=>limitsDirty=true);
$("requireCashOpen").addEventListener("change",()=>limitsDirty=true);

function render(s){
  const armed=!!(s.limits&&s.limits.tradingEnabled);
  const btn=$("btnArm");
  btn.dataset.armed=String(armed);
  btn.textContent=armed?"Stop trading":"Start trading";
  btn.style.background=armed?"var(--bad)":"";
  btn.style.borderColor=armed?"var(--bad)":"";
  $("armState").style.color=armed?"var(--bad)":"var(--ink2)";
  $("armState").textContent=armed
    ?"ARMED — orders will be placed when a setup passes every check"
    :"disarmed — nothing will be sent";
  const L=s.loop||{};
  // The loop's own count, so seen = placed + no-side + refused exactly. The
  // engine-wide figure includes everything that fired before arming, which is
  // a different and less useful number.
  $("lSig").textContent=L.seen??"—";
  $("lSigD").textContent=(L.signalsSeen??0)>(L.seen??0)
    ? "by the loop · "+L.signalsSeen+" since the engine started"
    : "by the loop, since armed";
  $("lAcc").textContent=L.accepted??"—";
  $("lRej").textContent=L.rejected??"—";
  $("lDec").textContent=L.declined??"—";
  // Silence is the expected state, so say which kind of silence it is.
  let why="";
  if(armed&&!L.attached){
    why="<b style='color:var(--bad)'>Armed but the loop is not attached.</b> The engine has to be running "+
      "and credentials present. Check the terminal.";
  } else if(armed&&L.signalsSeen===0){
    why="No signal has fired yet. That is the normal state — the detectors only fire on a real event "+
      "(depth pulled without trading, a wall vanishing, cascade risk crossing a band, a liquidation burst). "+
      "Quiet stretches of an hour are ordinary.";
  } else if(armed&&L.accepted===0&&L.declined>0&&L.rejected===0&&L.lastRefusal){
    // The reason itself says which of the two happened, so let it: a sizer
    // refusal and a bias with no direction are different states and were being
    // described with the same sentence.
    const sizedOut=String(L.lastRefusal.reason).startsWith("sized out");
    why=(sizedOut
      ?"Signals are firing and the bias is calling a side, but the sizer refuses every setup so far. That is the "+
       "risk rules doing their job — the reason names which one. Most recent: <b>"
      :"Signals are firing and the loop is seeing them, but the bias has not called a side on any yet, so nothing "+
       "was proposed to size. That is the normal quiet state, not a fault. Most recent read: <b>")+
      String(L.lastRefusal.reason).replace(/</g,"&lt;")+"</b>";
  } else if(armed&&L.accepted===0&&L.lastRefusal){
    const mins=Math.round((Date.now()-L.lastRefusal.at)/60000);
    why="Signals are firing but none has become a trade. Most recent reason ("+mins+"m ago): <b>"+
      String(L.lastRefusal.reason).replace(/</g,"&lt;")+"</b>";
  }
  $("lWhy").innerHTML=why;
  $("mode").className="mode "+s.mode;
  $("mode").textContent=s.mode==="live"?"LIVE — real money":s.mode==="testnet"?"testnet":"no credentials";
  const h=s.health;
  $("hdot").className="dot "+(h?h.level:"blind");
  $("health").textContent=h?(h.tradeable?"tradeable":h.level):"stopped";
  $("healthNote").textContent=h?h.summary:"";
  $("uptime").textContent=s.engine.running?s.engine.uptimeSec+"s up · "+s.engine.symbol:"stopped";
  $("btnStart").disabled=s.engine.running; $("btnStop").disabled=!s.engine.running;

  const pr=s.protection;
  $("protNote").innerHTML =
    pr.error ? '<div class="banner warn"><b>Cannot check protection.</b><span>'+pr.error+'</span></div>'
    : pr.protected===false ? '<div class="banner bad"><b>OPEN POSITION WITH NO STOP-LOSS.</b><span>'+
        'Nothing will close this if price runs against you except liquidation. '+
        '<button id="btnProtect" style="margin-left:8px">Place stop now</button></span></div>'
    : pr.protected===true && pr.flat===false ? '<div class="banner warn"><span>Position protected — '+pr.reason+'</span></div>'
    : "";
  const bp=document.getElementById("btnProtect");
  if(bp) bp.onclick=async()=>render(await api("/api/protect",{method:"POST"}));

  $("execNote").innerHTML=s.execution.available?"":
    '<div class="banner warn"><b>Read-only.</b><span>'+s.execution.reason+'</span></div>';

  const m=s.market;
  $("mid").textContent=m?n(m.mid):"—";
  $("session").textContent=m?"Nasdaq "+m.session:"—";
  $("lwi").textContent=m?n(m.lwi,2):"—";
  $("lwiSides").textContent=m?(m.warm?"":"cold · ")+"bid "+n(m.lwiBid,2)+" / ask "+n(m.lwiAsk,2):"—";
  $("riskDown").textContent=m&&m.riskDown!==null?n(m.riskDown,0):"—";
  $("riskUp").textContent=m&&m.riskUp!==null?n(m.riskUp,0):"—";
  $("below").textContent=m&&m.nearestBelow?"→ "+n(m.nearestBelow):"no level below";
  $("above").textContent=m&&m.nearestAbove?"→ "+n(m.nearestAbove):"no level above";

  const a=s.account;
  $("avail").textContent=usd(a.availableBalance);
  $("upnl").textContent=usd(a.unrealizedPnl);
  $("mratio").textContent=a.marginRatio===null?"—":(a.marginRatio*100).toFixed(1)+"%";
  $("npos").textContent=a.positions.length;
  $("acctNote").textContent=a.error?("account: "+a.error):(a.at?"updated "+new Date(a.at).toLocaleTimeString():"");
  $("positions").innerHTML=a.positions.length?a.positions.map(p=>
    "<tr><td>"+p.symbol+"</td><td>"+n(p.amt,3)+"</td><td>"+n(p.entry)+"</td><td>"+n(p.liquidation)+"</td><td>"+usd(p.pnl)+"</td></tr>").join("")
    :'<tr><td colspan="5" class="muted">'+(a.error?"unavailable":"flat")+"</td></tr>";

  if(!limitsDirty){
    $("maxPositionUsd").value=s.limits.maxPositionUsd;
    $("maxLeverage").value=s.limits.maxLeverage;
    $("maxDailyLossUsd").value=s.limits.maxDailyLossUsd;
    $("maxOpenPositions").value=s.limits.maxOpenPositions;
    $("tradingEnabled").value=String(s.limits.tradingEnabled);
    $("requireCashOpen").value=String(s.limits.requireCashOpen);
    $("stopLossPct").value=s.limits.stopLossPct;
    $("riskPerTradePct").value=s.limits.riskPerTradePct;
  }
}

async function tick(){
  try{
    render(await api("/api/status"));
    const {signals}=await api("/api/signals?limit=40");
    $("signals").innerHTML=signals.length?signals.map(x=>
      '<div class="item"><span class="sev '+x.severity+'">'+x.severity+'</span>'+
      '<span class="muted" style="flex:none;width:64px">'+new Date(x.t).toLocaleTimeString()+'</span>'+
      "<span>"+x.detail.replace(/</g,"&lt;")+"</span></div>").join(""):'<div class="muted">none yet</div>';
  }catch(e){ $("health").textContent="control server unreachable"; }
}

$("btnStart").onclick=async()=>render(await api("/api/engine/start",{method:"POST"}));
$("btnStop").onclick=async()=>render(await api("/api/engine/stop",{method:"POST"}));
$("btnRefresh").onclick=async()=>render(await api("/api/account/refresh",{method:"POST"}));
$("btnKill").onclick=async()=>{ if(confirm("Stop the engine and disarm trading?")) render(await api("/api/kill",{method:"POST"})); };
$("btnLimits").onclick=async()=>{
  const body={maxPositionUsd:+$("maxPositionUsd").value,maxLeverage:+$("maxLeverage").value,
    maxDailyLossUsd:+$("maxDailyLossUsd").value,maxOpenPositions:+$("maxOpenPositions").value,
    tradingEnabled:$("tradingEnabled").value==="true",stopLossPct:+$("stopLossPct").value,
    requireCashOpen:$("requireCashOpen").value==="true",
    riskPerTradePct:+$("riskPerTradePct").value};
  limitsDirty=false; render(await api("/api/limits",{method:"POST",body:JSON.stringify(body)}));
};

$("btnPlace").onclick=async()=>{
  const side=$("pvSide").value, notionalUsd=+$("pvNotional").value, stopPct=+$("pvStopPct").value;
  const live=$("mode").textContent.indexOf("LIVE")===0;
  // Double-escaped on purpose: this whole script lives inside a template
  // literal, so a single backslash-n becomes a real newline in the emitted
  // page and breaks the JS string it sits in — which takes the entire script
  // down, not just this line.
  if(!confirm((live?"REAL MONEY.\\n\\n":"Demo trading.\\n\\n")+
    "Place a "+side+" of "+notionalUsd+" USDT now, with a "+stopPct+"% protective stop?\\n\\n"+
    "This bypasses the strategy and the sizer. Every safety interlock still applies."))return;
  $("btnPlace").disabled=true;
  const r=await api("/api/place",{method:"POST",body:JSON.stringify({side,notionalUsd,stopPct})});
  $("btnPlace").disabled=false;
  $("pvOut").innerHTML=r.error
    ?'<div class="banner bad"><b>Order refused.</b><span>'+String(r.error).replace(/</g,"&lt;")+"</span></div>"
    :'<div class="banner"><b>Filled.</b><span>'+r.quantity+" contracts at "+r.leverage+
      "x · protective stop resting on Binance at "+(r.stop&&r.stop.stopPrice)+
      ". Check it on the exchange, then use Close position.</span></div>";
  if(!r.error) render(r);
};
$("btnClose").onclick=async()=>{
  if(!confirm("Close the open position at market?"))return;
  const r=await api("/api/close",{method:"POST"});
  $("pvOut").innerHTML=r.error
    ?'<div class="banner bad"><span>'+String(r.error).replace(/</g,"&lt;")+"</span></div>"
    :'<div class="banner"><span>Position closed at market.</span></div>';
  if(!r.error) render(r);
};

$("btnPreview").onclick=async()=>{
  const body={side:$("pvSide").value,notionalUsd:+$("pvNotional").value,
    leverage:+$("pvLeverage").value,entryPrice:$("pvEntry").value?+$("pvEntry").value:undefined};
  const r=await api("/api/preview",{method:"POST",body:JSON.stringify(body)});
  if(r.error){ $("pvOut").innerHTML='<div class="banner warn"><span>'+r.error+"</span></div>"; return; }
  const p=r.preview, sev={info:"warn",warning:"warn",critical:"bad"};
  const banners=[
    ...(r.breaches||[]).map(b=>'<div class="banner bad"><b>Blocked by your limits.</b><span>'+b+"</span></div>"),
    ...p.warnings.map(w=>'<div class="banner '+sev[w.level]+'"><span>'+w.message+"</span></div>"),
  ].join("");
  $("pvOut").innerHTML=
    '<div class="tiles">'+
    '<div class="tile"><span class="k">Size</span><span class="v">'+n(p.qty,3)+'</span><span class="d">'+usd(p.notional)+" notional</span></div>"+
    '<div class="tile"><span class="k">Margin required</span><span class="v">'+usd(p.initialMargin)+'</span><span class="d">at '+p.leverage+"x</span></div>"+
    '<div class="tile"><span class="k">Liquidation</span><span class="v">'+n(p.liquidationPrice)+'</span><span class="d">'+n(p.liqDistancePct,2)+"% away · estimate</span></div>"+
    '<div class="tile"><span class="k">Round-trip fee</span><span class="v">'+usd(p.roundTripFeeTaker)+'</span><span class="d">needs +'+n(p.breakevenMovePct,3)+"% to break even</span></div>"+
    "</div>"+
    '<p class="note">Entry '+n(r.usedEntry)+" · balance after "+usd(p.balanceAfter)+
    (r.accountKnown?"":" · no account data, balance assumed 0")+
    " · maker entry would cost "+usd(p.entryFeeMaker)+" instead of "+usd(p.entryFeeTaker)+"</p>"+
    (banners?'<div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">'+banners+"</div>":"")+
    '<p class="note">Liquidation price is an estimate assuming isolated margin and a '+
    "modelled maintenance rate; Binance's own figure is authoritative and accounts for the notional tier, funding and cross-margin wallet.</p>";
};

$("btnSuggest").onclick=async()=>{
  const r=await api("/api/suggest",{method:"POST",body:JSON.stringify({direction:$("sgDir").value})});
  if(r.error){ $("sgOut").innerHTML='<div class="banner warn"><span>'+r.error+"</span></div>"; return; }
  const res=r.result;
  const b=r.bias;
  const biasHtml=b?('<div class="banner '+(b.direction?"warn":"")+'" style="margin-bottom:8px"><div>'+
    "<b>"+(b.direction?("Least resistance: "+(b.direction==="down"?"downward":"upward")+" · "+Math.round(b.conviction*100)+"% conviction"):"No clear side")+"</b>"+
    '<div class="sub" style="margin-top:3px">'+b.summary.replace(/</g,"&lt;")+"</div>"+
    '<div class="sub" style="margin-top:4px;opacity:.8">'+b.factors.map(f=>f.name+": "+f.detail).join(" · ").replace(/</g,"&lt;")+"</div>"+
    '<div class="sub" style="margin-top:4px;opacity:.7">'+b.caveat+"</div>"+
    "</div></div>"):"";
  const beh=r.participants?('<p class="note">Book behaviour: <b>'+r.participants.regime+"</b> ("+
    Math.round(r.participants.confidence*100)+"% confidence) — "+(r.participants.notes[0]||"")+
    " · recent movement "+n(r.volatilityPct,2)+"%/min</p>"):"";
  // Context that applies whether or not a setup came back, because the reasons
  // a setup was refused are usually sitting in one of these three.
  const ctx=[];
  if(r.markout&&r.markout.warm){
    ctx.push("Flow quality: <b>"+r.markout.regime+"</b> (toxicity "+n(r.markout.toxicity,2)+
      ", informed "+n(r.markout.informed,2)+") — "+(r.markout.notes[0]||""));
  }
  if(r.funding){
    ctx.push("Funding: "+(r.funding.notes[0]||"")+
      (r.funding.msToFunding?" · settles in "+Math.max(1,Math.round(r.funding.msToFunding/60000))+" min":""));
  }
  if(r.session){
    ctx.push("Session: <b>"+r.session.intraday+"</b> — size weight "+n(r.session.weights.sizeScale,2)+
      "x, depth normally "+n(r.session.weights.depthScale,2)+"x the regular session"+
      (r.session.transitioning?" · <b>just changed phase</b>, baselines still catching up":""));
  }
  if(r.events&&(r.events.blackout||r.events.sizeScale<1||r.events.needsConfirmation)){
    ctx.push("Calendar: "+((r.events.reason||r.events.notes[0]||"").replace(/</g,"&lt;")));
  }
  const ctxHtml=ctx.length?('<p class="note">'+ctx.join("<br>")+"</p>"):"";
  if(r.events&&r.events.blackout){
    $("sgOut").innerHTML='<div class="banner bad"><b>Blackout.</b><span>'+
      (r.events.reason||"").replace(/</g,"&lt;")+"</span></div>"+ctxHtml;
    return;
  }
  if(!res.ok){
    $("sgOut").innerHTML=biasHtml+'<div class="banner warn"><b>No setup worth taking.</b><span>'+
      res.reasons.join("; ")+"</span></div>"+beh+ctxHtml;
    return;
  }
  $("sgOut").innerHTML=biasHtml+beh+ctxHtml+
    '<div class="tiles" style="margin-top:8px">'+
    '<div class="tile"><span class="k">Suggested size</span><span class="v">'+usd(res.notionalUsd)+'</span><span class="d">'+n(res.quantity,3)+" contracts</span></div>"+
    '<div class="tile"><span class="k">Leverage</span><span class="v">'+res.leverage+'x</span><span class="d">'+usd(res.marginUsd)+" margin</span></div>"+
    '<div class="tile"><span class="k">Stop</span><span class="v">'+n(res.stopPrice)+'</span><span class="d">'+n(res.stopDistancePct,2)+"% · risks "+usd(res.riskUsd)+"</span></div>"+
    '<div class="tile"><span class="k">Target</span><span class="v">'+(res.targetPrice?n(res.targetPrice):"—")+'</span><span class="d">'+
      (res.rewardRisk?n(res.rewardRisk,2)+":1 reward:risk":"no level ahead")+"</span></div>"+
    '<div class="tile"><span class="k">Funding over the hold</span><span class="v">'+
      (res.carry.free?"none":(res.carry.costUsd>=0?"-":"+")+usd(Math.abs(res.carry.costUsd)))+'</span><span class="d">'+
      res.carry.note.replace(/</g,"&lt;")+"</span></div>"+
    '<div class="tile"><span class="k">Round-trip fees</span><span class="v">'+usd(res.fees.totalUsd)+'</span><span class="d">'+
      n(res.fees.bps,1)+"bp · "+res.fees.style.entry+" in, "+res.fees.style.exit+" out · needs +"+
      n(res.fees.breakevenPct,3)+"% to break even</span></div>"+
    '<div class="tile"><span class="k">Fees vs the target</span><span class="v">'+
      (res.rewardUsd?Math.round(100*res.fees.totalUsd/res.rewardUsd)+"%":"—")+
      '</span><span class="d">of gross reward goes to the venue'+
      (res.budget.share!==null?" · today "+Math.round(res.budget.share*100)+"% of gross so far":"")+"</span></div>"+
    "</div>"+
    '<p class="note"><b>Execution:</b> '+res.entryPostable.reason.replace(/</g,"&lt;")+"</p>"+
    '<p class="note"><b>Why:</b> '+res.reasoning.map(x=>x.replace(/</g,"&lt;")).join(" · ")+"</p>"+
    '<div class="row" style="margin-top:8px"><button id="btnCopy">Copy into preview</button>'+
    '<span class="muted" style="font-size:11px">nothing has been applied or ordered — these are numbers for you to judge</span></div>';
  document.getElementById("btnCopy").onclick=()=>{
    $("pvSide").value=res.side; $("pvNotional").value=Math.round(res.notionalUsd);
    $("pvLeverage").value=res.leverage; $("pvEntry").value=res.entryPrice.toFixed(2);
    $("btnPreview").click();
  };
};

async function funds(){
  const f=await api("/api/funds");
  if(f.error){ $("fNote").textContent=f.error; return; }
  $("fFut").textContent=f.futuresUsdt===null?"—":usd(f.futuresUsdt);
  const canMove=f.live&&f.transfersAllowed;
  $("fRow").style.display=canMove?"":"none";
  if(f.faucetUrl){
    $("fSpot").textContent="demo";
    $("fSpotD").textContent="funded from the faucet";
    $("fNote").innerHTML='Demo trading has no transfer API. Get play funds from the faucet on '+
      '<a href="'+f.faucetUrl+'" target="_blank" rel="noopener" style="color:var(--accent)">testnet.binancefuture.com</a>'+
      ' — it is on the same page as the API keys. The balance above updates within a few seconds.';
  } else if(!f.transfersAllowed){
    $("fSpot").textContent="—";
    $("fSpotD").textContent="transfers disabled";
    $("fNote").innerHTML="Moving funds needs <code>BINANCE_ALLOW_TRANSFER=1</code> in .env and the "+
      "<b>Universal Transfer</b> permission on the API key. Left off by default: a trading key does not need "+
      "to be able to move money, and the smaller key is the one worth leaving in a file. "+
      "Transfer in the Binance app instead — the balance above will pick it up.";
  } else {
    $("fSpot").textContent=f.spotUsdt===null?"—":usd(f.spotUsdt);
    $("fSpotD").textContent=f.spotError?f.spotError:"available to move in";
    $("fNote").textContent="Moves between your own wallets only. This cannot withdraw.";
  }
}
async function move(direction){
  const amount=+$("fAmount").value;
  if(!(amount>0)){ $("fNote").textContent="enter an amount"; return; }
  const r=await api("/api/transfer",{method:"POST",body:JSON.stringify({amount,direction})});
  $("fNote").textContent=r.error?r.error:"moved "+amount+" USDT — balance updates in a moment";
  funds();
}
$("btnFundIn").onclick=()=>move("spot-to-futures");
$("btnFundOut").onclick=()=>move("futures-to-spot");

async function arm(want){
  const r=await api("/api/arm",{method:"POST",body:JSON.stringify({armed:want})});
  if(r.error){ $("armState").textContent=r.error; $("armState").style.color="var(--bad)"; return; }
  render(r);
}
$("btnArm").onclick=()=>{
  const armed=$("btnArm").dataset.armed==="true";
  if(!armed&&!confirm("Start trading? Orders will be placed automatically when a setup passes every check."))return;
  arm(!armed);
};

let logSince=0;
async function pullLog(){
  const r=await api("/api/log?since="+logSince);
  if(!r.lines) return;
  const box=$("logBox");
  const atBottom=box.scrollHeight-box.scrollTop-box.clientHeight<40;
  for(const l of r.lines){
    logSince=Math.max(logSince,l.t);
    const time=new Date(l.t).toTimeString().slice(0,8);
    const div=document.createElement("div");
    // Colour the two lines that matter at a glance without reading them.
    const bad=/fail|error|rejected|cannot|FAILED/i.test(l.text);
    const good=/submitted|fill |ARMED|stop resting/i.test(l.text);
    div.style.color=bad?"var(--bad)":good?"var(--good)":"var(--ink2)";
    div.textContent=time+"  "+l.text;
    box.appendChild(div);
  }
  while(box.childNodes.length>400) box.removeChild(box.firstChild);
  if(atBottom) box.scrollTop=box.scrollHeight;
}

const ago=(t)=>{ if(!t) return "never"; const m=Math.round((Date.now()-t)/60000);
  return m<1?"just now":m<60?m+"m ago":Math.round(m/60)+"h ago"; };

async function runs(){
  const r=await api("/api/runs");
  if(!r.paper) return;
  // Liveness from the heartbeat; the counts from the file. A running process
  // with an empty file is the normal early state and must not read as stopped.
  const pb=r.paper.beat||{}, sb=r.shadow.beat||{};
  const state=(b,cmd)=>b.running?null:(b.stale?"stopped "+ago(b.at):cmd);
  const pOff=state(pb,"npm run sweep:paper"), sOff=state(sb,"npm run sweep:shadow");

  $("rPaper").textContent=pOff?"not running":(pb.stats&&pb.stats.rows!=null?Number(pb.stats.rows).toLocaleString():r.paper.rows.toLocaleString());
  $("rPaperD").textContent=pOff||("rows · feed "+(pb.stats?pb.stats.feed:"?")+" · "+(pb.stats?pb.stats.pending:0)+" pending");
  $("rPaper").style.color=pOff?"var(--ink2)":"";

  $("rShadow").textContent=sOff?"not running":(sb.stats?sb.stats.recorded:r.shadow.rows);
  $("rShadowD").textContent=sOff||(
    (sb.stats?sb.stats.open:0)+" open · "+(sb.stats?sb.stats.signalsSeen:0)+" signals · "+
    (sb.stats?sb.stats.noSideCalled:0)+" no side called");
  $("rShadow").style.color=sOff?"var(--ink2)":"";
  const n=r.shadow.netUsd;
  $("rNet").textContent=r.shadow.scored?((n>=0?"+":"")+n.toFixed(2)):"—";
  $("rNet").style.color=r.shadow.scored?(n>=0?"var(--good)":"var(--bad)"):"";
  $("rNetD").textContent=r.shadow.scored
    ?(r.shadow.wins+"/"+r.shadow.scored+" won · "+usd(r.shadow.feesUsd)+" of fees")
    :"after fees";

  const rows=r.shadow.recent||[];
  $("rTrades").innerHTML=rows.length?rows.map(t=>{
    const net=t.outcomes&&t.outcomes.t900?t.outcomes.t900.netUsd:null;
    const col=net===null||net===undefined?"var(--ink2)":net>=0?"var(--good)":"var(--bad)";
    return "<tr><td>"+new Date(t.at).toTimeString().slice(0,5)+"</td>"+
      "<td>"+t.side+" "+t.quantity+" @ "+(+t.entryPrice).toFixed(2)+" <span class='muted'>("+t.style.entry+")</span></td>"+
      "<td>"+t.signalKind+"</td>"+
      "<td style='text-align:right;color:"+col+"'>"+(net===null||net===undefined?"pending":(net>=0?"+":"")+net.toFixed(2))+"</td>"+
      "<td>"+(t.resolved||"open")+"</td></tr>";
  }).join(""):"<tr><td colspan='5' class='muted'>nothing recorded yet</td></tr>";

  $("rNote").textContent=r.shadow.scored<30
    ? "Shadow trades are recorded by a separate process against real prices, with no order placed. Fewer than 30 scored is not a result yet."
    : "Net is after the fees each trade would have paid. Run npm run sweep:shadow:report for the full breakdown.";
}

async function diagnose(){
  $("btnDiag").disabled=true; $("diagVerdict").textContent="checking…";
  const r=await api("/api/diagnose");
  $("btnDiag").disabled=false;
  if(!r.checks){ $("diagVerdict").textContent="diagnostics unavailable"; return; }
  const col=r.worst==="bad"?"var(--bad)":r.worst==="warn"?"var(--warn)":"var(--good)";
  $("diagVerdict").textContent=r.verdict; $("diagVerdict").style.color=col;
  $("diagOut").innerHTML=r.checks.map(c=>{
    const mark=c.severity==="ok"?"OK":c.severity==="warn"?"—":"!!";
    const cc=c.severity==="ok"?"var(--good)":c.severity==="warn"?"var(--warn)":"var(--bad)";
    return '<div style="display:grid;grid-template-columns:28px 190px 1fr;gap:8px;padding:5px 0;'+
      'border-bottom:1px solid var(--hair);font-size:12px;align-items:baseline">'+
      '<span style="color:'+cc+';font-weight:600">'+mark+'</span>'+
      '<span>'+c.name+'</span>'+
      '<span class="muted">'+String(c.detail).replace(/</g,"&lt;")+
      (c.fix&&c.severity!=="ok"?'<br><b style="color:var(--ink)">→ '+String(c.fix).replace(/</g,"&lt;")+'</b>':'')+
      '</span></div>';
  }).join("");
}
$("btnDiag").onclick=diagnose;

tick(); setInterval(tick,1000);
funds(); setInterval(funds,15000);
pullLog(); setInterval(pullLog,2000);
runs(); setInterval(runs,10000);
</script></body></html>`;
}
