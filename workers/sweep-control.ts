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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { attachCalendar } from "../lib/sweep/metrics/event-store";
import { getEngine } from "../lib/sweep/engine";
import { createSweepFeed, type SweepFeed } from "../lib/sweep/agent";
import type { Signal } from "../lib/sweep/agent";
import {
  fetchAccountRisk,
  fetchSpotUsdt,
  fetchTradableSymbols,
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
import { DislocationTracker, EMPTY_DISLOCATION } from "../lib/sweep/metrics/dislocation";
import {
  cancelOrder,
  checkProtection,
  closePosition,
  placeProtectiveStop,
  ensureProtected,
  openProtectedPosition,
  setLeverage,
  testExitPath,
  type ProtectionState,
} from "../lib/sweep/exchange/orders";
import { fetchPosition } from "../lib/sweep/exchange/binance";
import { dayDrawdown, fetchDayActivity, type DayActivity } from "../lib/sweep/exchange/activity";
import { createBinanceAdapter, flatten, type ExecutionRecord } from "../lib/sweep/exchange/adapter";
import { attachExecution, intentId, type ExecutionRunner } from "../lib/sweep/agent";
import { CONFIG, SYMBOLS, isCalibrated } from "../lib/sweep/config";

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
   * Close any position open longer than this, in minutes. Zero disables it.
   *
   * Derived from a week of real trades: under 30 minutes won 68-71% and made
   * money, over 30 minutes won 33-54% and lost in every bucket.
   */
  maxHoldMinutes: number;
  /**
   * Percent of free collateral put at risk if the stop fills. This is the dial
   * that actually sets aggression — leverage only decides how much margin the
   * same position ties up, whereas this decides what a loss costs.
   */
  riskPerTradePct: number;
  /**
   * How hard the conditions are allowed to shrink a position, 0 to 1.
   *
   * The sizer derates for a thin session, for quotes being pulled, and for a
   * projected event. Each is a real reading and none of them is measured — they
   * are priors, and priors set to shrink every position are a decision about
   * expected return dressed as a decision about risk.
   *
   * This scales all of them toward 1: at 1 they apply in full, at 0.5 at half
   * strength, at 0 not at all. It does not touch the stop, the daily loss cap,
   * the trade count or the reward-to-risk floor — those bound what a loss
   * costs, which is a different question from how much conviction to size with.
   */
  sizeDerateStrength: number;
  /**
   * Move the stop to break-even once the position is this far to its target,
   * in percent of the distance. Zero disables it.
   *
   * 60 is not arbitrary. At a 1.2 reward-to-risk the target sits 1.2 stops away,
   * so 60% of the way there is 0.72 stops of open profit — comfortably past the
   * noise the stop was widened to sit outside of, and far enough that a reversal
   * from here is information rather than a wiggle. Lower and it scratches
   * healthy trades on ordinary retracement; higher and most winners never reach
   * it, which is the same as not having it.
   */
  breakEvenAtPct: number;
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
/*
 * Every number here is now derived from a week of real trading rather than
 * chosen, and the derivation matters more than the values.
 *
 * That week: 60 trades, 58% of them winners, and it still lost 8,873 — because
 * the average win was 583 and the average loss 1,172. Four trades worse than
 * -30% ROI cost 15,570 between them, which is more than the entire loss. The
 * hit rate was never the problem.
 *
 * Applying a hard stop and a time limit to the same trades, changing nothing
 * else, turns -8,873 into +3,263 across 33 trades at a 70% win rate.
 *
 * stopLossPct 0.5   A -10% ROI stop at 20x is a 0.5% move in price, which is
 *                   what the simulation used. Expressed in price rather than
 *                   ROI because that is what a stop order takes, and because it
 *                   then stays correct when leverage changes.
 *
 * maxLeverage 10    The original 5 came from the observation that 20x turned a
 *                   2.75% move into a 55% loss. True, and it was the wrong
 *                   lesson: that week had no enforced stop. With a 0.5% price
 *                   stop resting on the exchange, 10x costs 5% of margin when
 *                   it fires and 20x costs 10% — the stop bounds the loss, not
 *                   the leverage. Under fixed-fractional sizing leverage is a
 *                   consequence anyway; riskPerTradePct is the real dial, and
 *                   a low ceiling here only truncates positions the risk budget
 *                   had already sized correctly.
 *
 * riskPerTradePct 4 Quarter-Kelly at the *pessimistic* end of the measured
 *                   edge. The filtered week won 23 of 33, a 70% hit rate whose
 *                   95% interval runs 54–85%. Full Kelly at the 54% bound and
 *                   1.2 reward-to-risk is 16%; a quarter of that is 3.9%.
 *                   Sizing off the lower bound rather than the point estimate
 *                   is the whole reason it lands at 4 and not at 11.
 *                   Break-even hit rate at 1.2 reward-to-risk is 45%, so this
 *                   has 9 points of hit-rate margin before it stops making
 *                   money, and five consecutive losses cost 20% of the account.
 *
 * maxHoldMinutes 30 The clearest signal in the data. See enforceMaxHold.
 *
 * maxTradesPerDay 8 The filtered week averaged 4.7 a day; 8 leaves headroom
 *                   without permitting the 8.6-a-day pace that produced the
 *                   original result.
 */
const DEFAULT_LIMITS: Limits = {
  maxPositionUsd: 0,
  maxLeverage: 10,
  maxDailyLossUsd: 0,
  maxOpenPositions: 1,
  tradingEnabled: false,
  stopLossPct: 0.5,
  maxTradesPerDay: 8,
  lossCooldownMin: 15,
  requireCashOpen: false,
  minRewardRisk: 1.2,
  maxHoldMinutes: 30,
  riskPerTradePct: 4,
  sizeDerateStrength: 0.5,
  breakEvenAtPct: 60,
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
  return { ...stored, maxHoldMinutes: stored.maxHoldMinutes ?? DEFAULT_LIMITS.maxHoldMinutes, tradingEnabled: false };
}

function writeLimits(next: Limits) {
  mkdirSync(dirname(LIMITS_PATH), { recursive: true });
  writeFileSync(LIMITS_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * One desk per contract.
 *
 * Everything here is per-symbol because it has no cross-symbol meaning: a book,
 * a signal stream, a position and the stop resting against it all belong to one
 * contract. What is deliberately *not* in here is the risk budget — the daily
 * loss cap, the trade counter, the cooldown and the open-position ceiling live
 * at account level below, counted across every desk at once.
 *
 * That split is the whole point of running several. Three desks give three times
 * as many chances to find a setup while spending one budget between them, so the
 * frequency goes up and the exposure does not. If the caps were per-desk this
 * would just be three times the risk wearing a different name.
 */
interface Desk {
  readonly symbol: string;
  feed: SweepFeed | null;
  runner: ExecutionRunner | null;
  startedAt: number;
  signalsSeen: number;
  execHistory: ExecutionRecord[];
  lastRefusal: { at: number; reason: string } | null;
  refusalCounts: Map<string, number>;
  day: { activity: DayActivity | null; error: string | null; at: number };
  protection: { state: ProtectionState | null; error: string | null; at: number };
  /**
   * When this desk's position was first seen open.
   *
   * There is no open-time on a Binance position, so it is recorded the first
   * time one is observed and cleared when it goes flat. After a restart an
   * inherited position starts its clock again rather than being closed
   * immediately — the wrong direction to be wrong in is closing something the
   * moment the program comes back, not holding it a little longer.
   */
  positionOpenedAt: number;
  /**
   * The target from the most recent sizing, held until the execution record
   * that follows it arrives. The adapter reports what happened but not what was
   * intended, and the take-profit needs the second.
   */
  pendingTarget: number | null;
  /** When the stop was moved to break-even, so it happens at most once. */
  ratchetedAt: number;
}

function newDesk(symbol: string): Desk {
  return {
    symbol,
    feed: null,
    runner: null,
    startedAt: 0,
    signalsSeen: 0,
    execHistory: [],
    lastRefusal: null,
    refusalCounts: new Map(),
    day: { activity: null, error: null, at: 0 },
    protection: { state: null, error: null, at: 0 },
    positionOpenedAt: 0,
    pendingTarget: null,
    ratchetedAt: 0,
  };
}

const desks = new Map<string, Desk>(SYMBOLS.map((s) => [s, newDesk(s)]));
const allDesks = () => [...desks.values()];

/**
 * How each contract is moving relative to the others.
 *
 * The one reading that only exists because there is more than one desk, and the
 * measurable form of "find the discrepancies between these names". It is fed
 * from every desk's published mid and read back into the bias as one modestly
 * weighted factor — see lib/sweep/metrics/dislocation.ts for why it is weighted
 * that way and what it is careful not to claim.
 */
const dislocation = new DislocationTracker();

/** The read for a desk, or the empty one when only a single contract is watched. */
const dislocationFor = (symbol: string) =>
  desks.size > 1 ? dislocation.read(symbol) : EMPTY_DISLOCATION;

/**
 * The desk the detail panels describe.
 *
 * The summary strip shows every contract at once, but the suggestion panel, the
 * preview and the manual order buttons all act on exactly one — and which one
 * has to be an explicit choice rather than something inferred from whichever
 * desk last did something, because these are the controls that send orders.
 */
let focus = SYMBOLS[0];
const focused = () => desks.get(focus) ?? allDesks()[0];

/** Contract metadata from the exchange, once that desk's engine has fetched it. */
const metaFor = (symbol: string) => getEngine(symbol).getSnapshot().meta;
const meta = () => metaFor(focus);

let account: { risk: AccountRisk | null; error: string | null; at: number } = {
  risk: null,
  error: null,
  at: 0,
};
let limits = readLimits();
const fees = readFeeSchedule();

/**
 * What the order venue will accept, checked once at startup.
 *
 * `null` means the question has not been answered — either it has not been
 * asked yet or asking failed — and an unanswered question is reported as
 * unknown rather than as a pass. Claiming a symbol is tradeable because the
 * check errored is the one wrong answer here.
 */
let orderable: { symbols: Set<string> | null; error: string | null; venue: string } = {
  symbols: null,
  error: null,
  venue: "",
};

async function checkOrderVenue() {
  if (!hasCredentials()) {
    orderable = { symbols: null, error: "no credentials — order venue not checked", venue: "" };
    return;
  }
  const cfg = loadConfig();
  orderable.venue = cfg.baseUrl;
  try {
    orderable = { symbols: await fetchTradableSymbols(cfg), error: null, venue: cfg.baseUrl };
    const missing = SYMBOLS.filter((s) => !orderable.symbols!.has(s));
    if (missing.length === 0) {
      log(`order venue ${cfg.baseUrl} lists all ${SYMBOLS.length} configured contract(s)`);
      return;
    }
    /*
     * Loud, because this is the failure that looks like nothing being wrong.
     * The book, the signals and the sizer all come from production and will
     * work perfectly on a contract this account cannot send an order for.
     */
    log(
      `!! ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} NOT tradeable at ${cfg.baseUrl}. ` +
        `Market data comes from production and will look completely normal, but every order on ` +
        `${missing.length === 1 ? "it" : "them"} will be rejected. Demo lists far fewer contracts than production.`,
    );
  } catch (err) {
    orderable = {
      symbols: null,
      error: redact(err instanceof Error ? err.message : String(err)),
      venue: cfg.baseUrl,
    };
    log(`could not read the order venue's contract list: ${orderable.error}`);
  }
}

function startEngine() {
  for (const desk of allDesks()) {
    if (desk.feed) continue;
    desk.feed = createSweepFeed({ symbol: desk.symbol });
    attachCalendar(getEngine(desk.symbol));
    desk.feed.onSignal((s) => {
      if (s.kind !== "health") desk.signalsSeen++;
    });
    // Every published state feeds the cross-contract comparison. Bucketed
    // inside the tracker, so the four-a-second publish rate costs one sample
    // per five seconds and a slow desk is not drowned out by a fast one.
    desk.feed.onState((st) => {
      if (st.mid !== null) dislocation.record(desk.symbol, st.mid);
    });
    desk.startedAt = Date.now();
    log(`engine started — ${desk.symbol}`);
  }
}

function stopEngine() {
  for (const desk of allDesks()) {
    if (!desk.feed) continue;
    desk.feed.close();
    desk.feed = null;
    desk.startedAt = 0;
    // Otherwise a stopped desk keeps contributing a frozen price to the group
    // return, which reads as the whole sector standing still.
    dislocation.forget(desk.symbol);
    log(`engine stopped — ${desk.symbol}`);
  }
}

/* ------------------------------------------------------- position journal */

/**
 * What this process knew about a position, kept on disk so a restart does not
 * forget it.
 *
 * Everything that matters about an open position lives on the exchange — the
 * entry, the stop, the target — and that is deliberate, because orders survive
 * a crash and intentions do not. But three things never make it onto the
 * exchange: when the position was opened, what target the sizer had chosen, and
 * which reasoning produced it. Without them a restart re-protects the position
 * and then manages it wrongly: the thirty-minute time stop starts counting from
 * the restart rather than the entry, so a position already past its limit gets
 * a fresh half hour, and a target that was never placed as an order is simply
 * lost.
 *
 * Written when a position is first seen, cleared when it goes flat, and read
 * once at startup. Small enough that a torn write is the only real failure
 * mode, which the tmp-and-rename handles.
 */
interface JournalEntry {
  symbol: string;
  openedAt: number;
  side: "long" | "short";
  entryPrice: number;
  /** Where the sizer wanted to take profit. Null when it had no target. */
  targetPrice: number | null;
  stopPct: number;
  reason: string;
  updatedAt: number;
}

const JOURNAL_PATH = resolve(process.env.SWEEP_JOURNAL ?? "data/sweep-positions.json");

function readJournal(): Record<string, JournalEntry> {
  if (!existsSync(JOURNAL_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as Record<string, JournalEntry>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A corrupt journal must not stop the program: the exchange is still the
    // authority on what is open, and the journal only adds context to it.
    log("position journal unreadable — continuing without the remembered context");
    return {};
  }
}

function writeJournal(next: Record<string, JournalEntry>) {
  try {
    mkdirSync(dirname(JOURNAL_PATH), { recursive: true });
    const tmp = `${JOURNAL_PATH}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, JOURNAL_PATH);
  } catch (err) {
    log(`could not write the position journal: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let journal: Record<string, JournalEntry> = {};

/** Remember what the sizer intended, so a restart can carry on managing it. */
function journalOpen(symbol: string, entry: Omit<JournalEntry, "symbol" | "updatedAt">) {
  journal[symbol] = { ...entry, symbol, updatedAt: Date.now() };
  writeJournal(journal);
}

function journalClose(symbol: string) {
  if (!journal[symbol]) return;
  delete journal[symbol];
  writeJournal(journal);
}

/**
 * The target the loop last chose for a symbol, from memory or from disk.
 *
 * Used to re-place a take-profit that a restart would otherwise lose, and to
 * decide nothing when there was never a target — a position opened manually has
 * none, and inventing one would be worse than leaving it on the time stop.
 */
const journalTarget = (symbol: string): number | null => journal[symbol]?.targetPrice ?? null;

/* -------------------------------------------------- account-wide day counters */

/**
 * The day's activity summed across every desk.
 *
 * A loss on one contract has to count against the budget that governs the
 * others, or three desks quietly grant three daily loss caps. Summed rather
 * than fetched once because Binance's income ledger is queried per symbol.
 */
function dayTotals() {
  let realisedPnl = 0;
  let drawdown = 0;
  let trades = 0;
  let feesPaid = 0;
  let funding = 0;
  let lastLossAt = 0;
  let known = false;
  for (const d of allDesks()) {
    const a = d.day.activity;
    if (!a) continue;
    known = true;
    realisedPnl += a.realisedPnl;
    drawdown += dayDrawdown(a);
    trades += a.trades;
    feesPaid += a.fees;
    funding += a.funding;
    lastLossAt = Math.max(lastLossAt, a.lastLossAt);
  }
  return { realisedPnl, drawdown, trades, fees: feesPaid, funding, lastLossAt, known };
}

/** How many contracts the account is currently holding, from the exchange. */
function openPositionCount(): number {
  return account.risk?.openPositions.filter((p) => p.positionAmt !== 0).length ?? 0;
}

/**
 * Whether this desk may open something right now.
 *
 * Separate from the sizer because it is a portfolio question rather than a
 * per-trade one, and because the answer has to be the same for the automatic
 * loop and the manual button. Correlated names are the reason it exists: three
 * memory contracts held at once is one sector bet wearing three tickers, and
 * the stop on each would fire on the same tick.
 */
function concurrencyBlock(symbol: string): string | null {
  const open = account.risk?.openPositions.filter((p) => p.positionAmt !== 0) ?? [];
  if (open.some((p) => p.symbol === symbol)) return null; // already ours to manage
  if (limits.maxOpenPositions > 0 && open.length >= limits.maxOpenPositions) {
    return `already holding ${open.map((p) => p.symbol).join(", ")} — the account cap is ${limits.maxOpenPositions} position${limits.maxOpenPositions === 1 ? "" : "s"} at a time`;
  }
  return null;
}

/**
 * Close a position that has been open too long.
 *
 * The single clearest finding in a week of real trading: trades held under
 * thirty minutes won 68-71% of the time and made money, while every bucket past
 * thirty minutes won 33-54% and lost. Applying the cutoff alone turned a
 * -8,873 week into +1,882 without touching anything else.
 *
 * The mechanism is not mysterious. This strategy reads a book that is thin
 * right now; the reading decays in minutes. A position held for hours is no
 * longer the trade that was justified, it is a directional bet on a thesis that
 * has expired — and the losses show it, because a losing position is exactly
 * the one nobody wants to close.
 *
 * Zero disables it.
 */
/**
 * Keep every open position under a full bracket, and take the winners.
 *
 * Runs on the same sweep as the time stop, because the three failures it covers
 * all present the same way — a position that stays open when it should not.
 *
 *  - No target resting. The commonest and most expensive: the sizer picks a
 *    target, refuses setups whose target does not justify the risk, and until
 *    now nothing ever placed an order there. Winners rode to the time limit and
 *    were closed at whatever price had arrived, or round-tripped through entry
 *    and stopped out.
 *  - No stop resting. Covered on startup already; covered here too because a
 *    stop can be cancelled by hand, and the window between noticing and fixing
 *    it should be one sweep rather than one restart.
 *  - The give-back. A position that reaches most of the way to its target and
 *    then reverses to the stop turns a winner into a full loss. Once it has
 *    travelled far enough, the stop moves to break-even plus the round trip, so
 *    the worst case becomes a scratch instead.
 */
async function maintainBrackets() {
  if (!hasCredentials()) return;
  const cfg = loadConfig();
  for (const desk of allDesks()) {
    const state = desk.protection.state;
    const pos = state?.position;
    if (!pos || pos.positionAmt === 0) continue;

    const target = journalTarget(desk.symbol);
    const precision = metaFor(desk.symbol)?.pricePrecision ?? 2;

    // Re-place anything missing from the bracket.
    if (!state.protected || (target !== null && !state.takeProfit)) {
      try {
        const fixed = await ensureProtected(cfg, desk.symbol, pos, limits.stopLossPct, precision, target);
        desk.protection = { state: fixed, error: null, at: Date.now() };
        log(`bracket ${desk.symbol}: ${fixed.reason}`);
      } catch (err) {
        log(`bracket ${desk.symbol} FAILED: ${redact(err instanceof Error ? err.message : String(err))}`);
      }
      continue; // next sweep reads the repaired state before ratcheting on it
    }

    /*
     * The break-even ratchet.
     *
     * Only ever moves the stop toward the entry, never away from it, and only
     * once. Moving a stop further out is how a bounded loss becomes an
     * unbounded one, and it is the single most common way a disciplined exit
     * plan is abandoned in the moment — so the direction is enforced here
     * rather than trusted.
     *
     * The new level is entry plus the full round trip, not entry itself: a stop
     * exactly at entry still loses the fees both ways, which on this frequency
     * is most of what a scratch trade costs.
     */
    if (!limits.breakEvenAtPct || desk.ratchetedAt) continue;
    if (target === null) continue;

    const long = pos.positionAmt > 0;
    const entryPrice = pos.entryPrice;
    const totalMove = Math.abs(target - entryPrice);
    if (!(totalMove > 0)) continue;
    const travelled = long ? pos.markPrice - entryPrice : entryPrice - pos.markPrice;
    const progress = travelled / totalMove;
    if (progress < limits.breakEvenAtPct / 100) continue;

    // Round trip in price terms, so the scratch is genuinely flat after fees.
    const feePct = (fees.tiers[0]?.takerRate ?? 0.0005) * 2 * 100;
    const beStop = long ? entryPrice * (1 + feePct / 100) : entryPrice * (1 - feePct / 100);
    const current = state.stop?.stopPrice ?? 0;
    const improves = long ? beStop > current : beStop < current;
    if (!improves) {
      desk.ratchetedAt = Date.now();
      continue;
    }
    // Refuse to place a stop the wrong side of mark — it would fill instantly
    // at market, closing the position at whatever the book offers.
    if (long ? beStop >= pos.markPrice : beStop <= pos.markPrice) continue;

    try {
      if (state.stop) await cancelOrder(cfg, desk.symbol, state.stop.orderId, state.stop.isAlgo);
      const moved = await placeProtectiveStop(cfg, desk.symbol, pos, beStop, precision);
      desk.ratchetedAt = Date.now();
      log(
        `RATCHET ${desk.symbol}: ${(progress * 100).toFixed(0)}% of the way to target, ` +
          `stop moved to break-even + fees at ${moved.stopPrice} — this can no longer be a losing trade`,
      );
      await refreshAccount();
    } catch (err) {
      // The old stop may already be cancelled, so the next sweep's repair pass
      // is what covers this rather than a retry here.
      log(`ratchet ${desk.symbol} FAILED: ${redact(err instanceof Error ? err.message : String(err))}`);
    }
  }
}

async function enforceMaxHold() {
  if (!limits.maxHoldMinutes || !hasCredentials()) return;
  for (const desk of allDesks()) {
    const pos = desk.protection.state?.position;
    if (!pos || pos.positionAmt === 0) {
      if (desk.positionOpenedAt) journalClose(desk.symbol);
      desk.positionOpenedAt = 0;
      desk.ratchetedAt = 0;
      continue;
    }
    if (!desk.positionOpenedAt) {
      desk.positionOpenedAt = Date.now();
      continue;
    }
    const heldMin = (Date.now() - desk.positionOpenedAt) / 60_000;
    if (heldMin < limits.maxHoldMinutes) continue;

    try {
      await closePosition(loadConfig(), desk.symbol);
      log(
        `TIME STOP ${desk.symbol}: closed after ${Math.round(heldMin)} min (limit ${limits.maxHoldMinutes}). ` +
          `Held past the point where the book reading it was based on still means anything.`,
      );
      desk.positionOpenedAt = 0;
      await refreshAccount();
    } catch (err) {
      log(`time stop FAILED (${desk.symbol}): ${redact(err instanceof Error ? err.message : String(err))}`);
    }
  }
}

async function refreshAccount() {
  if (!hasCredentials()) {
    account = { risk: null, error: "no credentials configured", at: Date.now() };
    for (const desk of allDesks()) desk.protection = { state: null, error: null, at: Date.now() };
    return;
  }
  const cfg = loadConfig();
  try {
    account = { risk: await fetchAccountRisk(cfg), error: null, at: Date.now() };
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    account = { risk: null, error: message, at: Date.now() };
    for (const desk of allDesks()) desk.protection = { state: null, error: message, at: Date.now() };
    return;
  }

  /*
   * Per-desk reads are sequential and each is caught on its own.
   *
   * Sequential because this is three or four signed calls per desk against a
   * shared IP weight budget, and firing them all at once is how a 429 — and then
   * an IP ban — happens. Caught individually because one symbol erroring must
   * not blank the protection state of a desk that is holding something: a stop
   * reported as "unknown" reads like an unprotected position and invites a
   * manual flatten that was never needed.
   */
  for (const desk of allDesks()) {
    try {
      const position = await fetchPosition(cfg, desk.symbol);
      desk.protection = {
        state: await checkProtection(cfg, desk.symbol, position),
        error: null,
        at: Date.now(),
      };
      desk.day = { activity: await fetchDayActivity(cfg, desk.symbol), error: null, at: Date.now() };
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err));
      desk.protection = { state: null, error: message, at: Date.now() };
      desk.day = { ...desk.day, error: message, at: Date.now() };
    }
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
  const cfg = loadConfig();
  journal = readJournal();

  /*
   * Every position the account holds, not every desk configured.
   *
   * These are different sets and the difference is the dangerous part. A
   * position can outlive the configuration that opened it — SWEEP_SYMBOLS
   * edited between runs, a contract dropped, a manual order on something else
   * entirely — and a reconciliation that only walks the current desks leaves
   * exactly those positions unprotected and unmanaged, silently, because
   * nothing is looking at them. The exchange is asked what is open, and that
   * answer governs.
   */
  let held: string[] = [];
  try {
    const risk = await fetchAccountRisk(cfg);
    held = risk.openPositions.filter((p) => p.positionAmt !== 0).map((p) => p.symbol);
  } catch (err) {
    log(`startup: could not read the account — ${redact(err instanceof Error ? err.message : String(err))}`);
  }
  const symbols = [...new Set([...SYMBOLS, ...held, ...Object.keys(journal)])];

  for (const symbol of symbols) {
    const desk = desks.get(symbol) ?? null;
    try {
      const position = await fetchPosition(cfg, symbol);
      if (!position) {
        // A journal entry with no position means it closed while this was down.
        if (journal[symbol]) {
          log(`startup: ${symbol} closed while this was not running — clearing its journal entry`);
          journalClose(symbol);
        }
        if (desk) {
          desk.positionOpenedAt = 0;
          log(`startup: flat on ${symbol}, nothing to reconcile`);
        }
        continue;
      }

      const remembered = journal[symbol];
      if (!desk) {
        // Held, but nothing is watching it. Protect it and say so loudly —
        // the time stop and the loop only run for configured desks, so this
        // position will sit on its stop until someone acts.
        log(
          `!! startup: holding ${position.positionAmt} ${symbol}, which is NOT in SWEEP_SYMBOLS. ` +
            `It will be protected but not managed — no time stop, no target, no loop. ` +
            `Add it to SWEEP_SYMBOLS or close it.`,
        );
      } else {
        log(`startup: found an open position of ${position.positionAmt} ${symbol}`);
      }

      const before = await checkProtection(cfg, symbol, position);
      const target = remembered?.targetPrice ?? null;
      const needsWork = !before.protected || (target !== null && !before.takeProfit);
      const state = needsWork
        ? await ensureProtected(cfg, symbol, position, limits.stopLossPct, 2, target)
        : before;
      log(`startup: ${state.reason}`);
      if (desk) desk.protection = { state, error: null, at: Date.now() };

      /*
       * The hold clock continues from the original entry rather than restarting.
       *
       * The previous behaviour gave an inherited position a fresh clock, on the
       * argument that closing something the instant the program returns is the
       * wrong way to be wrong. That argument holds when nothing is known about
       * the position; it does not hold when the journal says exactly when it
       * opened. A position already past the time limit is the one the data says
       * loses money, and handing it another half hour because the process
       * restarted is the failure the limit exists to prevent.
       */
      if (desk) {
        if (remembered?.openedAt) {
          const heldMin = Math.round((Date.now() - remembered.openedAt) / 60_000);
          desk.positionOpenedAt = remembered.openedAt;
          log(
            `startup: ${symbol} has been open ${heldMin} min` +
              (limits.maxHoldMinutes && heldMin >= limits.maxHoldMinutes
                ? ` — past the ${limits.maxHoldMinutes} min limit, so it closes on the next sweep`
                : limits.maxHoldMinutes
                  ? ` of a ${limits.maxHoldMinutes} min limit`
                  : ""),
          );
        } else {
          // No journal entry: opened by hand, or by a build that predates this.
          // Starting the clock now is the only defensible choice, and it is
          // worth saying so rather than letting it look like a known age.
          desk.positionOpenedAt = Date.now();
          log(`startup: ${symbol} has no recorded open time — the time limit starts from now`);
        }
        journalOpen(symbol, {
          openedAt: desk.positionOpenedAt,
          side: position.positionAmt > 0 ? "long" : "short",
          entryPrice: position.entryPrice,
          targetPrice: target,
          stopPct: limits.stopLossPct,
          reason: remembered?.reason ?? "recovered at startup",
        });
      }
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err));
      log(`startup reconciliation FAILED (${symbol}): ${message}`);
      if (desk) desk.protection = { state: null, error: message, at: Date.now() };
    }
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
/**
 * How often each check turned a setup away, per desk.
 *
 * "Thousands of signals, no orders" is not a diagnosis, and chasing it took
 * several rounds each time. A tally by cause turns it into one: if every
 * refusal says reward-to-risk, the target rule is wrong; if they say fees, the
 * frequency is; if they say daily cap, nothing is wrong at all.
 *
 * Per desk rather than pooled because the answer is often symbol-specific — a
 * contract whose clusters sit inside the round-trip cost refuses everything for
 * a reason that says nothing about the others, and pooling them would hide that
 * one of three contracts is doing all the work.
 *
 * Keyed on the leading clause of the reason, which is stable enough to group on
 * and specific enough to act on.
 */
function tallyRefusal(desk: Desk, reason: string) {
  // Everything before the first number or bracket, which is the rule's name
  // rather than the particular figures it refused with.
  const key = reason
    .replace(/^sized out \([a-z]+\): /, "")
    .split(/[:—(]/)[0]
    .replace(/[0-9.,]+/g, "")
    .trim()
    .slice(0, 48) || "other";
  desk.refusalCounts.set(key, (desk.refusalCounts.get(key) ?? 0) + 1);
}

/** Refusal counts pooled across desks, for the headline list. */
function pooledRefusals() {
  const total = new Map<string, number>();
  for (const d of allDesks()) {
    for (const [k, v] of d.refusalCounts) total.set(k, (total.get(k) ?? 0) + v);
  }
  return [...total.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));
}

/**
 * The last entry the account accepted, on any desk.
 *
 * The per-runner minimum interval only paces one desk. Three desks each pacing
 * themselves is three times the pace, which would take the frequency gained
 * from watching more contracts and spend it on trading the same setup three
 * times over rather than on finding better ones. The gap is therefore enforced
 * across all of them, exactly as it was when there was one.
 */
let lastEntryAt = 0;

function armDesk(desk: Desk) {
  if (desk.runner) return;
  if (!desk.feed) {
    log(`cannot arm ${desk.symbol}: the engine is not running — start it first`);
    return;
  }
  if (!hasCredentials()) {
    log("cannot arm: no API credentials");
    return;
  }
  const feed = desk.feed;
  const cfg = loadConfig();
  const adapter = createBinanceAdapter({
    cfg,
    symbol: desk.symbol,
    limits: () => ({ ...limits }),
    // From the exchange, not hardcoded: 0/2 is right for INTCUSDT and wrong for
    // anything else — BTCUSDT quantities carry three decimals, and a quantity
    // rounded to the wrong precision is rejected outright. Read per desk, since
    // two equity perps at different prices do not share a precision either.
    quantityPrecision: metaFor(desk.symbol)?.quantityPrecision ?? 0,
    pricePrecision: metaFor(desk.symbol)?.pricePrecision ?? 2,
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
      const totals = dayTotals();
      const proposal = proposePosition({
        direction,
        state,
        equity: availableBalance,
        realisedLossToday: totals.drawdown,
        tradesToday: totals.trades,
        lastLossAt: totals.lastLossAt,
        feesPaidToday: totals.fees,
        grossProfitToday: totals.realisedPnl,
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
        costCurve: feed.getCostCurve(),
        clusters: feed.getClusters(),
        config: { riskFraction: limits.riskPerTradePct / 100, fees, canPostEntries: true, derateStrength: limits.sizeDerateStrength },
      });
      if (!proposal.ok) {
        desk.lastRefusal = { at: Date.now(), reason: proposal.reasons.join("; ") };
        for (const one of proposal.reasons) tallyRefusal(desk, one);
        log(`sizer declined (${desk.symbol}): ${proposal.reasons.join("; ")}`);
        return null;
      }
      desk.pendingTarget = proposal.targetPrice;
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
      const state = feed.getState();
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
      getEngine(desk.symbol).recordOwnFill(f);
      log(`fill ${desk.symbol} ${f.tag} ${f.side} ${f.notional.toFixed(0)} at ${f.price}`);
    },
    onRecord: (r) => {
      desk.execHistory = [r, ...desk.execHistory].slice(0, 200);
      // Remember the target the sizer chose. It is not on the exchange yet and
      // it is not derivable from the position, so if this is not written down
      // now a restart loses it and the position runs to the time stop instead.
      if (r.outcome === "submitted" && desk.pendingTarget !== null) {
        journalOpen(desk.symbol, {
          openedAt: Date.now(),
          side: r.entry?.side === "BUY" ? "long" : "short",
          entryPrice: r.entry?.avgPrice ?? 0,
          targetPrice: desk.pendingTarget,
          stopPct: limits.stopLossPct,
          reason: r.detail.slice(0, 200),
        });
        desk.positionOpenedAt = Date.now();
      }
      // The account-wide clock starts when an entry actually reached the
      // exchange, not when one was proposed — a refused or failed submission
      // has not spent anything and must not pace the other desks.
      if (r.outcome === "submitted") lastEntryAt = Date.now();
      log(`execution ${desk.symbol} ${r.outcome}: ${r.detail}`);
    },
  });

  desk.runner = attachExecution(feed, {
    adapter,
    minIntervalMs: Math.max(60_000, limits.lossCooldownMin * 60_000),
    maxPerHour: Math.max(1, limits.maxTradesPerDay),
    onRejected: (reason) => {
      desk.lastRefusal = { at: Date.now(), reason };
      tallyRefusal(desk, reason);
      log(`intent rejected (${desk.symbol}): ${reason}`);
    },
    // The commonest outcome by far, and previously invisible: a signal fired,
    // the bias looked at it and would not call a side, so nothing was proposed.
    // The reason comes from the evaluation that caused it, not a later one.
    onDeclined: (_signal, _state, reason) => {
      const r = reason ?? "the strategy passed on this signal";
      desk.lastRefusal = { at: Date.now(), reason: r };
      tallyRefusal(desk, r.startsWith("sized out") ? r : "bias called no side");
    },
    strategy: (signal, state) => {
      // Health signals describe the feed, not the market.
      if (signal.kind === "health") return null;

      // Portfolio gates first: both are account-wide, both are cheap, and both
      // would otherwise be re-derived by every desk independently.
      const blocked = concurrencyBlock(desk.symbol);
      if (blocked) {
        desk.runner?.noteDecline(blocked);
        return null;
      }
      const gapMs = Math.max(60_000, limits.lossCooldownMin * 60_000);
      const sinceEntry = Date.now() - lastEntryAt;
      if (lastEntryAt > 0 && sinceEntry < gapMs) {
        desk.runner?.noteDecline(
          `account-wide spacing: ${Math.ceil((gapMs - sinceEntry) / 60_000)} min until the next entry on any contract`,
        );
        return null;
      }

      const bias = directionalBias(state, { dislocation: dislocationFor(desk.symbol) });
      if (!bias.direction) {
        desk.runner?.noteDecline(bias.summary);
        return null;
      }

      const totals = dayTotals();
      const proposal = proposePosition({
        direction: bias.direction,
        state,
        equity: account.risk?.availableBalance ?? 0,
        // Summed across desks. From Binance's income ledger rather than from
        // anything this process remembers: a restart is exactly when a costly
        // run has just happened, and in-memory counters would clear the budget
        // at the moment it matters. REALIZED_PNL is booked before commission,
        // so it is the gross figure the fee share is measured against.
        realisedLossToday: totals.drawdown,
        tradesToday: totals.trades,
        lastLossAt: totals.lastLossAt,
        feesPaidToday: totals.fees,
        grossProfitToday: totals.realisedPnl,
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
        costCurve: feed.getCostCurve(),
        clusters: feed.getClusters(),
        config: { riskFraction: limits.riskPerTradePct / 100, fees, canPostEntries: true, derateStrength: limits.sizeDerateStrength },
      });
      if (!proposal.ok) {
        // Otherwise this surfaces as "the strategy passed on this signal",
        // above a GUI line asserting the bias called no side — which is the
        // opposite of what happened: it called a side and the sizer refused it.
        desk.runner?.noteDecline(`sized out (${bias.direction}): ${proposal.reasons.join("; ")}`);
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
  log(`execution loop attached — ${desk.symbol} (${adapter.name})`);
}

function startExecutionLoop() {
  for (const desk of allDesks()) armDesk(desk);
}

function stopExecutionLoop() {
  for (const desk of allDesks()) {
    desk.runner?.stop();
    desk.runner = null;
  }
}

/**
 * One line per contract, for the strip along the top of the page.
 *
 * Kept small on purpose: with several desks the interesting question is which
 * one is doing something, and that is answered by price, risk, whether it is
 * holding, and how many signals it has produced. Everything else is a click
 * away on whichever desk turns out to be the interesting one.
 */
function deskSummaries() {
  return allDesks().map((d) => {
    const st = d.feed?.getState() ?? null;
    const pos = d.protection.state?.position ?? null;
    const stats = d.runner?.stats();
    return {
      symbol: d.symbol,
      focused: d.symbol === focus,
      calibrated: isCalibrated(d.symbol),
      running: d.feed !== null,
      attached: d.runner !== null,
      tradeable: st?.health.tradeable ?? null,
      warm: st?.liquidity?.warm ?? null,
      mid: st?.mid ?? null,
      spreadBps: st?.liquidity?.spreadBps ?? null,
      riskUp: st?.cascadeUp?.risk ?? null,
      riskDown: st?.cascadeDown?.risk ?? null,
      signalsSeen: d.signalsSeen,
      accepted: stats?.accepted ?? 0,
      holding: pos ? pos.positionAmt : 0,
      pnl: pos?.unrealizedPnl ?? null,
      protected: d.protection.state?.protected ?? null,
      heldMin: d.positionOpenedAt ? Math.round((Date.now() - d.positionOpenedAt) / 60_000) : 0,
      lastRefusal: d.lastRefusal?.reason ?? null,
      dislocation: dislocationFor(d.symbol),
    };
  });
}

/**
 * Whether the focused desk would trade this instant, and what is stopping it.
 *
 * The refusal tally answers this too, but only after a signal has fired and
 * only for the signals that did. Silence is the normal state here, so "nothing
 * has happened" and "everything is being refused for a reason you could fix in
 * ten seconds" looked identical, and telling them apart has cost several rounds
 * of watch-change-watch every time.
 *
 * This runs the same sizer the loop runs, against the live book, on both sides,
 * every time the page polls. The day counters are zeroed — it is answering "is
 * the setup there", not "are you allowed another trade today", and the caps
 * have their own readouts. Pure computation, no network, no side effects.
 */
function wouldTrade() {
  const desk = focused();
  const state = desk.feed?.getState() ?? null;
  if (!state) return { known: false as const, reason: "the engine is not running" };

  const sides = (["up", "down"] as const).map((direction) => {
    const result = proposePosition({
      direction,
      state,
      equity: account.risk?.availableBalance ?? 0,
      realisedLossToday: 0,
      tradesToday: 0,
      lastLossAt: 0,
      feeTierTradeCount: dayTotals().trades,
      feesPaidToday: dayTotals().fees,
      grossProfitToday: dayTotals().realisedPnl,
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
      costCurve: desk.feed?.getCostCurve() ?? [],
      clusters: desk.feed?.getClusters() ?? [],
      config: { riskFraction: limits.riskPerTradePct / 100, fees, canPostEntries: true, derateStrength: limits.sizeDerateStrength },
    });
    return {
      direction,
      ok: result.ok,
      // The stop geometry, which is what the refusals are usually about: how
      // wide the stop ended up, and therefore how far a target has to be.
      stopPct: result.ok ? result.stopDistancePct : null,
      target: result.ok ? result.targetPrice : null,
      rewardRisk: result.ok ? result.rewardRisk : null,
      notionalUsd: result.ok ? result.notionalUsd : null,
      // Notional is the headline number and margin is the money. Showing only
      // the first is how a position reads as far larger than it is, and only
      // the second is how it reads as far smaller.
      marginUsd: result.ok ? result.marginUsd : null,
      leverage: result.ok ? result.leverage : null,
      riskUsd: result.ok ? result.riskUsd : null,
      // How much of the intended risk budget survived the conditions. The one
      // number that explains a position that looks inexplicably small.
      sizeRetained: result.ok ? result.sizeRetained : null,
      reasons: result.ok ? [] : result.reasons,
    };
  });

  const bias = directionalBias(state, { dislocation: dislocationFor(desk.symbol) });
  return {
    known: true as const,
    symbol: desk.symbol,
    biasDirection: bias.direction,
    biasSummary: bias.summary,
    sides,
    // The side the loop would actually act on, so this and the loop cannot
    // disagree: no side called means no trade regardless of what the sizer says.
    tradeable: bias.direction !== null && (sides.find((s) => s.direction === bias.direction)?.ok ?? false),
  };
}

function status() {
  const desk = focused();
  const state = desk.feed?.getState() ?? null;
  const creds = hasCredentials();
  let mode: "none" | "testnet" | "live" = "none";
  if (creds) mode = process.env.BINANCE_LIVE === "1" ? "live" : "testnet";

  // Aggregated across desks: the loop is one loop from the operator's side even
  // though it is several runners underneath, and a per-desk breakdown that
  // disagreed with the headline would be worse than either alone.
  const loopTotals = allDesks().reduce(
    (acc, d) => {
      const s = d.runner?.stats();
      if (!s) return acc;
      return {
        seen: acc.seen + s.seen,
        accepted: acc.accepted + s.accepted,
        rejected: acc.rejected + s.rejected,
        declined: acc.declined + s.declined,
        lastAcceptedAt: Math.max(acc.lastAcceptedAt, s.lastAcceptedAt),
      };
    },
    { seen: 0, accepted: 0, rejected: 0, declined: 0, lastAcceptedAt: 0 },
  );
  const anyAttached = allDesks().some((d) => d.runner !== null);
  const anyRunning = allDesks().some((d) => d.feed !== null);
  const newestRefusal = allDesks()
    .map((d) => d.lastRefusal)
    .filter((r): r is { at: number; reason: string } => r !== null)
    .sort((a, b) => b.at - a.at)[0] ?? null;
  const totals = dayTotals();

  return {
    desks: deskSummaries(),
    focus,
    wouldTrade: wouldTrade(),
    orderVenue: {
      url: orderable.venue,
      checked: orderable.symbols !== null,
      error: orderable.error,
      // Only what this run is configured for. The full list is thousands long
      // on production and the question here is about these contracts.
      untradeable: orderable.symbols ? SYMBOLS.filter((s) => !orderable.symbols!.has(s)) : [],
    },
    engine: {
      running: anyRunning,
      uptimeSec: desk.startedAt ? Math.round((Date.now() - desk.startedAt) / 1000) : 0,
      symbol: desk.symbol,
      symbols: SYMBOLS,
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
    // Summed across desks, because every cap it is checked against is.
    day: totals.known
      ? {
          at: Math.max(...allDesks().map((d) => d.day.at)),
          realisedPnl: totals.realisedPnl,
          drawdown: totals.drawdown,
          trades: totals.trades,
          fees: totals.fees,
          funding: totals.funding,
          lastLossAt: totals.lastLossAt,
          cooldownLeftMin:
            limits.lossCooldownMin > 0 && totals.lastLossAt > 0
              ? Math.max(0, limits.lossCooldownMin - (Date.now() - totals.lastLossAt) / 60_000)
              : 0,
        }
      : { at: desk.day.at, error: desk.day.error },
    // Top-level rather than nested under `execution`, which is where the GUI
    // reads it from. Nested, every tile rendered "—" and the "loop is not
    // attached" warning fired permanently — a false alarm about the one thing
    // it exists to report truthfully.
    loop: {
      attached: anyAttached,
      signalsSeen: allDesks().reduce((n, d) => n + d.signalsSeen, 0),
      ...loopTotals,
      lastRefusal: newestRefusal,
      // Sorted by how often each check bit, which is the order worth reading.
      refusals: pooledRefusals(),
    },
    execution: {
      available: hasCredentials() && limits.tradingEnabled,
      armed: limits.tradingEnabled,
      running: anyAttached,
      reason: !hasCredentials()
        ? "no exchange credentials configured — monitor only"
        : !limits.tradingEnabled
          ? "trading is disarmed; set your caps and arm it to allow orders"
          : "armed — orders will be placed when a setup passes every check",
      // Interleaved newest-first across desks: an execution is an account event
      // and reading three separate lists in parallel to reconstruct the order
      // they happened in is exactly the work this should be doing.
      history: allDesks()
        .flatMap((d) => d.execHistory.map((r) => ({ ...r, symbol: d.symbol })))
        .sort((a, b) => b.at - a.at)
        .slice(0, 20),
      stats: loopTotals,
    },
    protection: {
      at: desk.protection.at,
      error: desk.protection.error,
      flat: desk.protection.state ? desk.protection.state.position === null : null,
      protected: desk.protection.state?.protected ?? null,
      stopPrice: desk.protection.state?.stop?.stopPrice ?? null,
      stopDistancePct: desk.protection.state?.stopDistancePct ?? null,
      reason: desk.protection.state?.reason ?? null,
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

/**
 * Which desk a request is about.
 *
 * An explicit `symbol` wins; otherwise the focused desk. Unknown symbols fall
 * back to the focus rather than erroring, because the only way to get one is a
 * stale page open across a config change, and the honest recovery there is to
 * answer about a real contract rather than to break.
 */
function deskFor(value: unknown): Desk {
  const name = typeof value === "string" ? value.trim().toUpperCase() : "";
  return desks.get(name) ?? focused();
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
        const which = url.searchParams.get("symbol");
        // "all" interleaves every desk, which is what the signal panel wants by
        // default: the question is what just happened anywhere, not what
        // happened on the contract the order buttons are currently pointed at.
        if (which === "all") {
          const merged = allDesks()
            .flatMap((d) => (d.feed?.recentSignals(limit) ?? []).map((s) => ({ ...s, symbol: d.symbol })))
            .sort((a, b) => b.t - a.t)
            .slice(0, limit);
          send(res, 200, { signals: merged });
          return;
        }
        const d = deskFor(which);
        send(res, 200, { signals: (d.feed?.recentSignals(limit) ?? []).map((s) => ({ ...s, symbol: d.symbol })) });
        return;
      }

      case "POST /api/focus": {
        const body = await readJson(req);
        const next = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
        if (!desks.has(next)) {
          send(res, 200, { error: `${next || "(none)"} is not one of ${SYMBOLS.join(", ")}` });
          return;
        }
        focus = next;
        log(`focus: ${focus}`);
        send(res, 200, status());
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
          maxHoldMinutes: Math.max(0, Math.round(n("maxHoldMinutes", limits.maxHoldMinutes))),
          // Capped at 10%: past that a short losing run ends the account
          // regardless of how good the entries are.
          // Ceiling raised from 10: at 1.2 reward-to-risk, full Kelly on the
          // point estimate of the measured edge is 44%, so 10 was not a risk
          // limit, it was a cap below what the edge supports. 25 is still far
          // under full Kelly and far above anything sensible to run.
          riskPerTradePct: Math.min(25, Math.max(0.01, n("riskPerTradePct", limits.riskPerTradePct))),
          sizeDerateStrength: Math.min(1, Math.max(0, n("sizeDerateStrength", limits.sizeDerateStrength))),
          breakEvenAtPct: Math.min(100, Math.max(0, n("breakEvenAtPct", limits.breakEvenAtPct))),
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
        const desk = deskFor(body.symbol);
        const state = desk.feed?.getState() ?? null;
        if (!state) { send(res, 200, { error: "engine is not running" }); return; }
        const totals = dayTotals();
        const bias = directionalBias(state, { dislocation: dislocationFor(desk.symbol) });
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
          feeTierTradeCount: totals.trades,
          feesPaidToday: totals.fees,
          grossProfitToday: totals.realisedPnl,
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
          costCurve: desk.feed?.getCostCurve() ?? [],
          clusters: desk.feed?.getClusters() ?? [],
          config: { riskFraction: limits.riskPerTradePct / 100, fees, canPostEntries: true, derateStrength: limits.sizeDerateStrength },
        });
        send(res, 200, {
          symbol: desk.symbol,
          result,
          bias,
          participants: state.participants,
          volatilityPct: state.volatilityPct,
          markout: state.markout,
          funding: state.funding,
          events: state.events,
          dislocation: dislocationFor(desk.symbol),
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
        const desk = deskFor(body.symbol);
        const symbol = desk.symbol;

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
        // The same portfolio gate the automatic loop obeys. A manual order that
        // ignored it would be the one way to end up holding three correlated
        // contracts at once, which is precisely what the cap exists to stop.
        const blocked = concurrencyBlock(symbol);
        if (blocked) { send(res, 200, { error: blocked }); return; }

        const state = desk.feed?.getState() ?? null;
        const price = state?.mark ?? state?.mid ?? 0;
        if (!price) { send(res, 200, { error: "no price yet — start the engine and wait for the book" }); return; }

        try {
          const cfg2 = loadConfig();
          const existing = await fetchPosition(cfg2, symbol);
          if (existing) {
            send(res, 200, { error: `already holding ${existing.positionAmt} ${symbol} — close it first` });
            return;
          }
          const risk2 = await fetchAccountRisk(cfg2);
          const leverage = Math.min(limits.maxLeverage, Math.max(1, Math.ceil(notional / Math.max(risk2.availableBalance, 1e-9))));

          // Rounded to the contract's own step, not to whole units: BTCUSDT
          // trades in thousandths and 1 BTC is not a test order.
          const qtyPrecision = metaFor(symbol)?.quantityPrecision ?? 0;
          const qty = Number((notional / price).toFixed(qtyPrecision));
          if (!(qty > 0)) {
            const min = Number((10 ** -qtyPrecision * price).toFixed(2));
            send(res, 200, {
              error: `${notional} is below the smallest tradable size at ${price.toFixed(2)} — the minimum is about ${min}`,
            });
            return;
          }

          await setLeverage(cfg2, symbol, leverage);
          log(`MANUAL ORDER: ${side} ${qty} ${symbol} at market, ${leverage}x, stop ${stopPct}%`);
          const { entry, stop } = await openProtectedPosition(
            cfg2,
            symbol,
            side === "long" ? "BUY" : "SELL",
            String(qty),
            stopPct,
            metaFor(symbol)?.pricePrecision ?? 2,
          );
          log(`MANUAL ORDER filled — stop resting at ${stop.stopPrice}`);
          await refreshAccount();
          send(res, 200, { ok: true, symbol, entry, stop, leverage, quantity: qty, ...status() });
        } catch (err) {
          const message = err instanceof Error ? redact(err.message) : String(err);
          log(`MANUAL ORDER failed (${symbol}): ${message}`);
          send(res, 200, { error: message });
        }
        return;
      }

      case "POST /api/testexit": {
        /*
         * Prove the brackets fire, rather than assuming they do because they
         * were accepted.
         *
         * Every readout in this program reports a resting stop as protection.
         * None of them has ever observed one trigger. Those are different
         * claims, and the whole design — leaving positions open on shutdown
         * because the stop lives on the exchange — rests on the second one.
         *
         * This opens a small real position with both brackets unusually close
         * to mark so the market takes one within minutes, then reports which
         * fired and how far the fill landed from the trigger. Interlocks that
         * bound a mistake still apply; the ones that decide whether a setup is
         * worth taking do not, because this is not a setup.
         */
        const body = await readJson(req);
        if (!hasCredentials()) { send(res, 200, { error: "no API credentials" }); return; }
        const desk = deskFor(body.symbol);
        const symbol = desk.symbol;

        const notional = Math.max(0, Number(body.notionalUsd) || 0);
        const bracketPct = Math.min(2, Math.max(0.02, Number(body.bracketPct) || 0.1));
        if (notional <= 0) { send(res, 200, { error: "enter a size" }); return; }
        if (limits.maxPositionUsd > 0 && notional > limits.maxPositionUsd) {
          send(res, 200, { error: `${notional} exceeds the ${limits.maxPositionUsd} max position` });
          return;
        }
        const blocked = concurrencyBlock(symbol);
        if (blocked) { send(res, 200, { error: blocked }); return; }

        const st = desk.feed?.getState() ?? null;
        const price = st?.mark ?? st?.mid ?? 0;
        if (!price) { send(res, 200, { error: "no price yet — start the engine and wait for the book" }); return; }

        try {
          const cfg2 = loadConfig();
          if (await fetchPosition(cfg2, symbol)) {
            send(res, 200, { error: `already holding ${symbol} — close it first` });
            return;
          }
          const qp = metaFor(symbol)?.quantityPrecision ?? 0;
          const qty = Number((notional / price).toFixed(qp));
          if (!(qty > 0)) {
            send(res, 200, { error: `${notional} is below the smallest tradable size at ${price.toFixed(2)}` });
            return;
          }
          await setLeverage(cfg2, symbol, Math.min(limits.maxLeverage, 2));
          log(`EXIT TEST ${symbol}: ${qty} with brackets ${bracketPct}% either side — waiting for one to fire`);
          const result = await testExitPath(
            cfg2, symbol, body.side === "short" ? "SELL" : "BUY", String(qty),
            bracketPct, metaFor(symbol)?.pricePrecision ?? 2,
            Math.min(15, Math.max(1, Number(body.timeoutMin) || 5)) * 60_000,
          );
          for (const step of result.steps) log(`  exit test: ${step.text}`);
          log(
            result.ok
              ? `EXIT TEST PASSED — the ${result.closedBy} fired` +
                (result.slippageBps !== null ? `, filling ${result.slippageBps.toFixed(1)}bp from its trigger` : "")
              : `EXIT TEST INCONCLUSIVE — ${result.closedBy}`,
          );
          journalClose(symbol);
          await refreshAccount();
          send(res, 200, { ok: result.ok, result, ...status() });
        } catch (err) {
          const message = err instanceof Error ? redact(err.message) : String(err);
          log(`EXIT TEST failed (${symbol}): ${message}`);
          send(res, 200, { error: message });
        }
        return;
      }

      case "POST /api/close": {
        // Flatten without stopping the engine, which is what Kill does.
        if (!hasCredentials()) { send(res, 200, { error: "no API credentials" }); return; }
        const body = await readJson(req);
        const symbol = deskFor(body.symbol).symbol;
        try {
          const cfg2 = loadConfig();
          await closePosition(cfg2, symbol);
          log(`MANUAL CLOSE: ${symbol} flattened at market`);
          await refreshAccount();
          send(res, 200, { ok: true, ...status() });
        } catch (err) {
          const message = err instanceof Error ? redact(err.message) : String(err);
          log(`manual close failed (${symbol}): ${message}`);
          send(res, 200, { error: message });
        }
        return;
      }

      case "POST /api/preview": {
        const body = await readJson(req);
        const desk = deskFor(body.symbol);
        const state = desk.feed?.getState() ?? null;
        const entry = Number(body.entryPrice) || state?.mark || state?.mid || 0;
        if (!entry) {
          send(res, 200, { error: "no price available yet — start the engine and wait for the book" });
          return;
        }
        const raw = desk.feed?.getClusters() ?? [];
        const preview = previewPosition({
          side: body.side === "short" ? "short" : "long",
          notionalUsd: Math.max(0, Number(body.notionalUsd) || 0),
          leverage: Math.max(1, Number(body.leverage) || 1),
          entryPrice: entry,
          availableBalance: account.risk?.availableBalance ?? 0,
          maintMarginRate: Number(body.maintMarginRate) || CONFIG.maintenanceMarginRate,
          takerFeeRate: Number(body.takerFeeRate) || 0.0005,
          makerFeeRate: Number(body.makerFeeRate) || 0.0002,
          stepSize: metaFor(desk.symbol)?.stepSize ?? 0.001,
          pricePrecision: metaFor(desk.symbol)?.pricePrecision ?? 2,
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
        const body = await readJson(req);
        const cfg = loadConfig();
        // Every desk, not just the focused one: an unprotected position is an
        // emergency wherever it is, and making the operator find the right tab
        // first is the wrong thing to ask at that moment.
        const targets = body.symbol === "all" || body.symbol === undefined ? allDesks() : [deskFor(body.symbol)];
        for (const d of targets) {
          const position = await fetchPosition(cfg, d.symbol);
          if (!position && targets.length > 1) continue; // nothing to cover
          const state = await ensureProtected(cfg, d.symbol, position, limits.stopLossPct, 2);
          d.protection = { state, error: null, at: Date.now() };
          log(`manual protect ${d.symbol}: ${state.reason}`);
        }
        send(res, 200, status());
        return;
      }

      case "POST /api/flatten": {
        // The kill switch. Always every desk — a panic button that only
        // flattened one of three contracts would be worse than none, because it
        // would report success while leaving the account exposed.
        if (!hasCredentials()) { send(res, 200, { error: "no credentials configured" }); return; }
        const cfg = loadConfig();
        const results: string[] = [];
        for (const d of allDesks()) {
          try {
            const r = await flatten(cfg, d.symbol);
            results.push(`${d.symbol}: ${r}`);
            log(`FLATTEN ${d.symbol}: ${r}`);
          } catch (err) {
            const message = err instanceof Error ? redact(err.message) : String(err);
            results.push(`${d.symbol}: FAILED — ${message}`);
            log(`FLATTEN ${d.symbol} FAILED: ${message}`);
          }
        }
        await refreshAccount();
        send(res, 200, { ...status(), flattened: results.join(" · ") });
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

        /*
         * The check that catches a perfectly healthy monitor pointed at a
         * contract the account cannot trade. Placed directly after the
         * credential checks because when it fails, nothing below it matters.
         */
        if (orderable.symbols) {
          const missing = SYMBOLS.filter((s) => !orderable.symbols!.has(s));
          add("contracts tradeable here", missing.length === 0,
            missing.length === 0
              ? `${SYMBOLS.join(", ")} all listed at ${orderable.venue}`
              : `${missing.join(", ")} not listed at ${orderable.venue}`,
            missing.length === 0
              ? undefined
              : "Market data comes from production, so the book, the signals and the sizer will all look " +
                "completely normal — and every order on these will be rejected. Demo lists far fewer " +
                "contracts than production. Either drop them from SWEEP_SYMBOLS for demo testing, or test " +
                "the order path on a contract demo does list.");
        } else if (hasCredentials()) {
          add("contracts tradeable here", false,
            orderable.error ?? "not checked yet",
            "Without this, a symbol the demo account cannot trade is indistinguishable from a quiet market.",
            "warn");
        }

        const live = allDesks().filter((d) => d.feed !== null);
        add("engines running", live.length === desks.size,
          live.length === 0
            ? "all stopped"
            : `${live.length}/${desks.size} — ${live.map((d) => `${d.symbol} up ${Math.round((Date.now() - d.startedAt) / 1000)}s`).join(", ")}`,
          live.length === desks.size ? undefined : "Press Start at the top of this page.",
          live.length === 0 ? "bad" : live.length === desks.size ? "ok" : "warn");

        /*
         * Per contract, because "the feed is fine" is not one fact when there
         * are three of them. A contract that never warms up — the usual cause
         * being a ticker that does not exist, so the stream carries nothing —
         * looks identical to a quiet market from a pooled reading, and that was
         * exactly the failure this was added to catch.
         */
        for (const d of allDesks()) {
          const s = d.feed?.getState();
          const healthy = s?.health.tradeable === true;
          add(`feed: ${d.symbol}`, healthy,
            s ? `${s.health.level}${s.health.tradeable ? "" : " — " + s.health.summary}` : "no state",
            healthy ? undefined
              : "Depth baselines need about a minute. If it stays blind, either the WebSocket to Binance " +
                `is blocked or ${d.symbol} is not a listed contract — npm run sweep:symbols says which.`,
            healthy ? "ok" : s?.health.level === "degraded" ? "warn" : "bad");
        }

        const st = focused().feed?.getState();

        add("max position set", limits.maxPositionUsd > 0,
          limits.maxPositionUsd > 0 ? `${limits.maxPositionUsd} USD` : "not set — every setup is refused",
          "Set it in Risk limits and save.");

        /*
         * The stop and the reward-to-risk floor multiply into a demand for a
         * level a certain distance away, and the cluster model only maps a
         * fixed band around mark. Past that band the demand cannot be met by
         * any book in any market condition — it is arithmetic, not a market
         * judgement, and it is knowable the instant the setting is saved.
         *
         * This is here because it happened: a 50% stop, entered in the belief
         * that it meant "close at a 50% loss", asked for a level 60% away and
         * refused every setup silently and forever. The refusal reason was
         * true and useless; nothing said the configuration could never work.
         */
        {
          const need = limits.stopLossPct * (limits.minRewardRisk > 0 ? limits.minRewardRisk : 1.5);
          const mapped = CONFIG.clusterRangePct;
          const impossible = need > mapped;
          // A stop this wide is also almost certainly a unit mix-up rather than
          // a deliberate choice, so the two are worth separating.
          const implausible = !impossible && limits.stopLossPct > 5;
          add("stop distance is reachable", !impossible && !implausible,
            `${limits.stopLossPct}% stop × ${limits.minRewardRisk} reward-to-risk needs a level ` +
              `${need.toFixed(1)}% away; levels are mapped to ±${mapped}%` +
              (impossible ? " — nothing can ever satisfy this" : ""),
            impossible
              ? `Set the stop to about ${(mapped / 4 / Math.max(limits.minRewardRisk, 1)).toFixed(1)}% or less. ` +
                "This field is a price move, not a percentage of your money: 0.5% means price moving half a " +
                `percent against you, which at ${limits.maxLeverage}x is ` +
                `${(0.5 * limits.maxLeverage).toFixed(0)}% of the margin behind the position.`
              : implausible
                ? "That is a very wide stop for an intraday equity perp. It is a price move, not a share of " +
                  "your money — check it is the number you meant."
                : undefined,
            impossible ? "bad" : implausible ? "warn" : "ok");
        }

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

        const attached = allDesks().filter((d) => d.runner !== null);
        add("execution loop attached", attached.length === desks.size,
          attached.length === 0
            ? "not attached"
            : `${attached.length}/${desks.size} listening — ${attached.map((d) => d.symbol).join(", ")}`,
          attached.length === desks.size ? undefined : "Needs the engine running and credentials. Disarm and re-arm.",
          attached.length === desks.size ? "ok" : limits.tradingEnabled ? "bad" : "warn");

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

        const s2 = allDesks().reduce(
          (acc, d) => {
            const s = d.runner?.stats();
            return s
              ? {
                  any: true,
                  seen: acc.seen + s.seen,
                  accepted: acc.accepted + s.accepted,
                  rejected: acc.rejected + s.rejected,
                  declined: acc.declined + s.declined,
                }
              : acc;
          },
          { any: false, seen: 0, accepted: 0, rejected: 0, declined: 0 },
        );
        if (s2.any) {
          const explained = s2.accepted + s2.rejected + s2.declined;
          add("loop accounting", explained === s2.seen,
            `${s2.seen} seen = ${s2.accepted} placed + ${s2.declined} no side + ${s2.rejected} refused`,
            explained === s2.seen ? undefined : "Signals are going unaccounted — that is a bug, not a setting.",
            explained === s2.seen ? "ok" : "bad");
        }

        const uncalibrated = SYMBOLS.filter((s) => !isCalibrated(s));
        add("symbols", uncalibrated.length === 0,
          uncalibrated.length === 0
            ? `${SYMBOLS.join(", ")} — all equity perps the models are built for`
            : `${uncalibrated.join(", ")} — NOT calibrated (of ${SYMBOLS.join(", ")})`,
          uncalibrated.length === 0
            ? undefined
            : "Fine for testing that orders place. The leverage ladder, maintenance rate, session " +
              "weights and earnings calendar are all built for an equity perp on Nasdaq and mean " +
              "nothing on a crypto pair or a contract on another exchange's clock — do not read a " +
              "strategy result off those.",
          uncalibrated.length === 0 ? "ok" : "warn");

        /*
         * The multi-desk trap: every cap is account-wide, so adding contracts
         * raises how often a setup is *found* and not how much is at risk. That
         * is only true while the caps are actually set — with maxTradesPerDay at
         * zero or maxOpenPositions above one, more desks does mean more risk,
         * and that is worth saying out loud rather than leaving implied.
         */
        if (desks.size > 1) {
          const capped = limits.maxTradesPerDay > 0 && limits.maxOpenPositions <= 1;
          add("multi-contract risk", capped,
            capped
              ? `${desks.size} desks sharing one budget: ${limits.maxTradesPerDay} trades/day, ${limits.maxOpenPositions} position at a time`
              : `${desks.size} desks with ${limits.maxOpenPositions} concurrent positions allowed` +
                (limits.maxTradesPerDay > 0 ? "" : " and no daily trade cap"),
            capped
              ? undefined
              : "These are correlated names — holding several at once is one sector bet in three tickers, " +
                "and their stops fire on the same tick. Set max open positions to 1 and a daily trade cap.",
            capped ? "ok" : "warn");
        }

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
    // First, because it decides whether anything else can possibly work and
    // needs no credentials to answer.
    await checkOrderVenue();
    await reconcileOnStart();
    await refreshAccount();
    setInterval(() => {
      void (async () => {
        await refreshAccount();
        await maintainBrackets();
        await enforceMaxHold();
      })();
    }, 20_000).unref?.();
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
  console.log(
    `  contracts:   ${SYMBOLS.map((s) => (isCalibrated(s) ? s : `${s} (uncalibrated)`)).join(", ")}`,
  );
  if (SYMBOLS.some((s) => !isCalibrated(s))) {
    console.log("               uncalibrated = the order path works, the models do not apply.");
  }
  console.log("               npm run sweep:symbols lists what Binance actually has.");
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
.deskstrip{display:flex;gap:8px;flex-wrap:wrap}
.desk{flex:1 1 200px;min-width:180px;text-align:left;padding:9px 11px;border-radius:var(--r);
border:1px solid var(--hair);background:var(--plane);cursor:pointer;font:inherit;color:var(--ink)}
.desk:hover{border-color:var(--ink)}
.desk.on{border-color:var(--good);background:rgba(46,160,67,.07)}
.desk .sym{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px}
.desk .px{font-size:19px;font-variant-numeric:tabular-nums;margin:3px 0 1px}
.desk .sub{font-size:11px;color:var(--dim)}
.desk .hold{font-size:11px;margin-top:3px}
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

<div id="venueNote"></div>
<div id="protNote"></div>
<div id="execNote"></div>

<div class="panel" id="deskPanel" style="display:none">
  <h2>Contracts</h2>
  <div id="desks" class="deskstrip"></div>
  <p class="note" id="disNote"></p>
  <p class="note">Every contract is watched at once and they share one risk budget — the daily loss cap,
  the trade count, the cooldown and the one-position-at-a-time rule are counted across all of them.
  More contracts means more chances to find a setup, not more money at risk. Click one to point the
  suggestion, preview and manual order controls below at it.</p>
</div>

<div class="grid">
  <div class="panel">
    <h2>Market <span id="mktSym" class="muted" style="font-weight:400;font-size:11px"></span></h2>
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
  <div id="wouldBox" style="margin-top:12px"></div>
  <div id="lRefusals" style="margin-top:10px"></div>
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
    <label style="width:170px">Max position (USD notional)<input id="maxPositionUsd" type="number" min="0" step="10"></label>
    <label style="width:110px">Max leverage<input id="maxLeverage" type="number" min="1" max="20" step="1"></label>
    <label style="width:150px">Max daily loss (USD)<input id="maxDailyLossUsd" type="number" min="0" step="10"></label>
    <label style="width:130px">Max open positions<input id="maxOpenPositions" type="number" min="0" step="1"></label>
    <label style="width:180px">Stop distance (% price move)<input id="stopLossPct" type="number" min="0.1" step="0.1"></label>
    <label style="width:180px">Risk per trade (% of collateral)<input id="riskPerTradePct" type="number" min="0.01" max="25" step="0.5"></label>
    <label style="width:170px">Condition derates<select id="sizeDerateStrength" style="background:var(--plane);border:1px solid var(--hair);border-radius:4px;color:var(--ink);padding:6px 8px;font:inherit">
      <option value="1">full — size down hard</option><option value="0.5">half — balanced</option><option value="0">off — size on the setup only</option></select></label>
    <label style="width:150px">Max hold (minutes)<input id="maxHoldMinutes" type="number" min="0" step="5"></label>
    <label style="width:150px">When Nasdaq is shut<select id="requireCashOpen" style="background:var(--plane);border:1px solid var(--hair);border-radius:4px;color:var(--ink);padding:6px 8px;font:inherit">
      <option value="false">trade, sized down</option><option value="true">do not trade</option></select></label>
    <label style="width:130px">Trading armed<select id="tradingEnabled" style="background:var(--plane);border:1px solid var(--hair);border-radius:4px;color:var(--ink);padding:6px 8px;font:inherit">
      <option value="false">disarmed</option><option value="true">armed</option></select></label>
    <button id="btnLimits">Save limits</button>
  </div>
  <div id="limitsMean" style="margin-top:12px"></div>
  <p class="note"><b>These defaults are derived from your own week of trading, not chosen.</b> That week won 58% of
  60 trades and still lost 8,873, because four trades worse than -30% ROI cost 15,570 between them. A hard stop
  and a 30-minute limit applied to the same trades turn it into +3,263 at a 70% win rate. <b>Max hold</b> is the
  one that did the most work on its own — under 30 minutes won 68-71%, past it every bucket lost.
  <br>Stored on this machine and enforced on every order. <b>Armed means orders will be placed</b> when a setup
  passes every check — leave it disarmed to use Suggest and Preview without anything being sent.
  Every position gets a stop-loss placed <b>on Binance</b> — it keeps working when this program is closed.</p>
</div>

<div class="panel">
  <h2>Position preview — before anything is sent</h2>
  <div class="row" style="gap:12px;align-items:flex-end">
    <label style="width:110px">Side<select id="pvSide" style="background:var(--plane);border:1px solid var(--hair);border-radius:4px;color:var(--ink);padding:6px 8px;font:inherit">
      <option value="long">long</option><option value="short">short</option></select></label>
    <label style="width:170px">Size (USD notional)<input id="pvNotional" type="number" min="0" step="50" value="1000"></label>
    <label style="width:110px">Leverage<input id="pvLeverage" type="number" min="1" max="10" step="1" value="2"></label>
    <label style="width:150px">Entry (blank = mark)<input id="pvEntry" type="number" step="0.01" placeholder="mark"></label>
    <button id="btnPreview">Preview</button>
    <label style="width:120px">Stop (%)<input id="pvStopPct" type="number" min="0.1" step="0.1" value="3"></label>
    <button id="btnPlace" style="border-color:var(--warn);color:var(--warn)">Place this order</button>
    <button id="btnClose">Close position</button>
    <button id="btnExitTest" title="Opens a small position with tight brackets and waits for one to fire">Prove the exits fire</button>
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
/* Liquidation, with the distance that makes it readable.
   An unlevered position liquidates somewhere absurd — a BTC long at 1x shows a
   liquidation near zero — and that number looks alarming when it is the
   opposite. Far is good: it means the stop on the exchange decides the outcome
   rather than the liquidation engine. Near is the emergency. The bare price
   says neither, so the distance is shown with it. */
const liqCell=p=>{
  if(!p.liquidation||!isFinite(p.liquidation)||!p.entry) return '<span class="muted">none</span>';
  const away=Math.abs(p.liquidation-p.entry)/p.entry*100;
  const col=away<10?"var(--bad)":away<25?"var(--warn)":"var(--good)";
  return n(p.liquidation)+'<br><span style="font-size:10px;color:'+col+'">'+
    (away>=95?"unreachable":n(away,1)+"% away")+"</span>";
};

let limitsDirty=false;
/* The most recent status, so the settings explainer can redraw the instant a
   field is typed rather than waiting for the next poll. */
let lastStatus=null;
/* Which contract the order controls point at; the server is the authority and
   this mirrors it so a request can name it explicitly rather than relying on
   server-side state that another tab may have changed. */
let focusSymbol="";
for(const id of ["maxPositionUsd","maxLeverage","maxDailyLossUsd","maxOpenPositions","stopLossPct","riskPerTradePct","maxHoldMinutes"])
  $(id).addEventListener("input",()=>{limitsDirty=true; explainLimits(lastStatus);});
$("tradingEnabled").addEventListener("change",()=>limitsDirty=true);
$("requireCashOpen").addEventListener("change",()=>limitsDirty=true);
$("sizeDerateStrength").addEventListener("change",()=>{limitsDirty=true; explainLimits(lastStatus);});

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

  /* Would it trade right now, on the contract in focus.
     The tally below only fills once signals have fired; this answers the same
     question against the live book without waiting for one, which is the
     difference between "nothing is happening" and "one setting is refusing
     everything". */
  const W=s.wouldTrade;
  if(!W||!W.known){
    $("wouldBox").innerHTML=W?'<div class="banner warn"><span>'+W.reason+"</span></div>":"";
  } else {
    const side=W.sides.find(x=>x.direction===W.biasDirection)||null;
    const esc=t=>String(t).replace(/</g,"&lt;");
    const line=x=>'<div style="display:grid;grid-template-columns:56px 1fr;gap:8px;font-size:12px;padding:3px 0">'+
      '<span style="color:'+(x.ok?"var(--good)":"var(--dim)")+';font-weight:600">'+(x.direction==="up"?"long":"short")+"</span>"+
      "<span>"+(x.ok
        ? '<span style="color:var(--good)">would trade</span> — target '+n(x.target)+", stop "+n(x.stopPct,2)+
          "%, RR "+n(x.rewardRisk,2)+'<br><span class="muted">'+usd(x.notionalUsd)+" notional at "+
          x.leverage+"x = "+usd(x.marginUsd)+" of margin, risking "+usd(x.riskUsd)+" if the stop fills"+
          (x.sizeRetained!==null&&x.sizeRetained<0.99
            ? " · sized to "+n(x.sizeRetained*100,0)+"% of the budget by current conditions"
            : "")+"</span>"
        : '<span class="muted">'+x.reasons.map(esc).join("<br>")+"</span>")+"</span></div>";
    $("wouldBox").innerHTML=
      '<div class="banner '+(W.tradeable?"":"warn")+'" style="display:block">'+
      "<b>"+(W.tradeable
        ? "A setup is live on "+W.symbol+" right now."
        : W.biasDirection===null
          ? "Nothing would trade on "+W.symbol+" right now — the bias is not calling a side."
          : "Nothing would trade on "+W.symbol+" right now.")+"</b>"+
      '<div class="muted" style="font-size:11px;margin:4px 0 6px">'+esc(W.biasSummary)+"</div>"+
      W.sides.map(line).join("")+
      '<div class="muted" style="font-size:11px;margin-top:6px">Live against the current book, with the daily '+
      "caps ignored — it answers whether the setup is there, not whether you have trades left.</div></div>";
  }

  // Which rule is actually doing the blocking. Without this, "no orders" takes
  // a round trip to diagnose every time.
  const rs=L.refusals||[];
  $("lRefusals").innerHTML=rs.length
    ? '<div class="muted" style="font-size:11px;margin-bottom:4px">WHAT TURNED THEM AWAY</div>'+
      rs.map(r=>'<div style="display:grid;grid-template-columns:52px 1fr;gap:8px;font-size:12px;padding:2px 0">'+
        '<span class="num" style="text-align:right">'+r.count+'</span>'+
        '<span class="muted">'+String(r.reason).replace(/</g,"&lt;")+"</span></div>").join("")
    : "";
  $("mode").className="mode "+s.mode;
  $("mode").textContent=s.mode==="live"?"LIVE — real money":s.mode==="testnet"?"testnet":"no credentials";
  const h=s.health;
  $("hdot").className="dot "+(h?h.level:"blind");
  $("health").textContent=h?(h.tradeable?"tradeable":h.level):"stopped";
  $("healthNote").textContent=h?h.summary:"";
  $("uptime").textContent=s.engine.running?s.engine.uptimeSec+"s up · "+(s.engine.symbols||[]).length+" contract"+((s.engine.symbols||[]).length===1?"":"s"):"stopped";
  $("btnStart").disabled=s.engine.running; $("btnStop").disabled=!s.engine.running;

  // The contract strip. Shown only when there is more than one, so a
  // single-symbol run looks exactly as it did.
  const ds=s.desks||[];
  focusSymbol=s.focus||focusSymbol;
  $("deskPanel").style.display=ds.length>1?"":"none";
  $("mktSym").textContent=ds.length>1?("— "+s.focus):"";
  if(ds.length>1){
    $("desks").innerHTML=ds.map(d=>{
      const dot=d.holding?"good":d.tradeable?"ok":d.running?"degraded":"blind";
      const risk=(d.riskDown!==null&&d.riskUp!==null)?("cascade "+n(d.riskDown,0)+"↓ / "+n(d.riskUp,0)+"↑"):"warming up";
      // A position is the one thing that must be readable without clicking in.
      const hold=d.holding
        ? '<div class="hold" style="color:'+(d.pnl>=0?"var(--good)":"var(--bad)")+'">holding '+n(d.holding,3)+
          " · "+usd(d.pnl)+" · "+d.heldMin+"m"+(d.protected===false?' · <b style="color:var(--bad)">NO STOP</b>':"")+"</div>"
        : '<div class="hold muted">flat · '+d.signalsSeen+" signal"+(d.signalsSeen===1?"":"s")+
          (d.accepted?" · "+d.accepted+" placed":"")+"</div>";
      return '<button class="desk'+(d.focused?" on":"")+'" data-sym="'+d.symbol+'">'+
        '<div class="sym"><i class="dot '+dot+'"></i>'+d.symbol+
        (d.calibrated?"":'<span class="muted" style="font-weight:400">uncal.</span>')+"</div>"+
        '<div class="px">'+n(d.mid)+"</div>"+
        '<div class="sub">'+risk+"</div>"+hold+"</button>";
    }).join("");
    for(const b of document.querySelectorAll(".desk")){
      b.onclick=async()=>{ render(await api("/api/focus",{method:"POST",body:JSON.stringify({symbol:b.dataset.sym})})); };
    }

    // How the group is behaving as a group. Stated plainly because the number
    // that matters is the correlation: below the threshold the divergence
    // reading is switched off entirely, and it is better to see that than to
    // wonder why a factor never appears.
    const warm=ds.filter(d=>d.dislocation&&d.dislocation.warm);
    if(warm.length===0){
      $("disNote").textContent="Cross-contract comparison warming up — it needs about 20 minutes of history on each.";
    } else {
      const corr=warm[0].dislocation.correlation;
      const apart=warm.filter(d=>d.dislocation.coupled&&Math.abs(d.dislocation.z)>1)
        .sort((a,b)=>Math.abs(b.dislocation.z)-Math.abs(a.dislocation.z));
      $("disNote").innerHTML=(warm[0].dislocation.coupled
        ? "These names have been "+(corr*100).toFixed(0)+"% correlated over the last 20 minutes. "
        : "These names have only been "+(corr*100).toFixed(0)+"% correlated — too loose to read a divergence, so that factor is off. ")+
        (apart.length?"<b>"+String(apart[0].dislocation.note).replace(/</g,"&lt;")+"</b>":"Nothing is meaningfully out of line.");
    }
  }

  /* A contract this account cannot send an order for. Top of the page and red,
     because everything else on it will look completely healthy: the book, the
     signals and the sizer all come from production, and only the order does
     not. Nothing about the monitor would tell you. */
  const V=s.orderVenue;
  $("venueNote").innerHTML = V&&V.untradeable&&V.untradeable.length
    ? '<div class="banner bad"><b>'+V.untradeable.join(", ")+
      (V.untradeable.length===1?" cannot be traded":" cannot be traded")+' on this account.</b><span>'+
      V.url+" does not list "+(V.untradeable.length===1?"it":"them")+
      ". You will still see a live book, live signals and sized proposals — market data comes from "+
      "production regardless — and every order will be rejected. Demo lists far fewer contracts than "+
      "production. Run <b>npm run sweep:symbols</b> to see what this account can actually trade."+
      "</span></div>"
    : "";

  const pr=s.protection;
  $("protNote").innerHTML =
    pr.error ? '<div class="banner warn"><b>Cannot check protection.</b><span>'+pr.error+'</span></div>'
    : pr.protected===false ? '<div class="banner bad"><b>OPEN POSITION WITH NO STOP-LOSS.</b><span>'+
        'Nothing will close this if price runs against you except liquidation. '+
        '<button id="btnProtect" style="margin-left:8px">Place stop now</button></span></div>'
    : pr.protected===true && pr.flat===false ? '<div class="banner warn"><span>Position protected — '+pr.reason+'</span></div>'
    : "";
  const bp=document.getElementById("btnProtect");
  if(bp) bp.onclick=async()=>render(await api("/api/protect",{method:"POST",body:JSON.stringify({symbol:"all"})}));

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
    "<tr><td>"+p.symbol+"</td><td>"+n(p.amt,3)+"</td><td>"+n(p.entry)+"</td><td>"+liqCell(p)+"</td><td>"+usd(p.pnl)+"</td></tr>").join("")
    :'<tr><td colspan="5" class="muted">'+(a.error?"unavailable":"flat")+"</td></tr>";

  lastStatus=s;

  if(!limitsDirty){
    $("maxPositionUsd").value=s.limits.maxPositionUsd;
    $("maxLeverage").value=s.limits.maxLeverage;
    $("maxDailyLossUsd").value=s.limits.maxDailyLossUsd;
    $("maxOpenPositions").value=s.limits.maxOpenPositions;
    $("tradingEnabled").value=String(s.limits.tradingEnabled);
    $("requireCashOpen").value=String(s.limits.requireCashOpen);
    $("stopLossPct").value=s.limits.stopLossPct;
    $("riskPerTradePct").value=s.limits.riskPerTradePct;
    $("maxHoldMinutes").value=s.limits.maxHoldMinutes;
    $("sizeDerateStrength").value=String(s.limits.sizeDerateStrength);
  }

  // After the fields are populated, never before: this reads the form rather
  // than the status, so running it first explains the previous poll's numbers.
  explainLimits(s);
}

/*
 * What the numbers in the form actually mean, in money, live.
 *
 * Every USD field here is *notional* — the whole position, leverage included —
 * and the stop is a percentage of price, not of your money. Both are the
 * conventional meanings and neither is guessable from the label alone. One of
 * them has already cost a run: a 50% stop entered as "close me out at a 50%
 * loss" asked for a target 60% away and refused every setup, silently, forever.
 *
 * Reads from the live fields rather than the saved limits, so it updates as
 * the numbers are typed and before anything is committed.
 */
/*
 * What the risk-per-trade setting is worth at a range of hit rates.
 *
 * This exists so the aggression argument is settled by arithmetic rather than
 * by adjectives. Everything downstream of the risk dial is determined once a
 * hit rate and a reward-to-risk are assumed, and the only honest thing to do
 * with an assumption that dominates the answer is to show the answer across a
 * range of it.
 *
 * The reference points are the measured ones: the filtered week won 23 of 33,
 * a 70% hit rate whose 95% interval runs 54–85%. The lower bound is the one
 * worth sizing off, and it is the row in bold.
 */
function edgeTable(riskPct, s){
  const rr=(s.limits&&s.limits.minRewardRisk)||1.2;
  const trades=(s.limits&&s.limits.maxTradesPerDay)||8;
  const R=riskPct/100;
  const breakEven=1/(1+rr);
  const rows=[0.45,0.54,0.6,0.7].map(p=>{
    const ev=(p*rr-(1-p))*R;
    return '<tr><td'+(Math.abs(p-0.54)<1e-9?' style="font-weight:600"':'')+'>'+(p*100).toFixed(0)+'%</td>'+
      '<td>'+(ev*100).toFixed(2)+'%</td><td>'+(ev*trades*100).toFixed(1)+'%</td></tr>';
  }).join("");
  return '<div style="margin-top:6px">At <b>'+n(riskPct,2)+'% risk</b> and '+n(rr,2)+' reward-to-risk, '+
    'break-even is a <b>'+(breakEven*100).toFixed(0)+'% hit rate</b>. Five losses in a row costs <b>'+
    (5*R*100).toFixed(0)+'%</b> of the account.'+
    '<table style="margin-top:4px;font-size:11px"><thead><tr><th>hit rate</th><th>per trade</th><th>per day ('+
    trades+' trades)</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    '<span class="muted" style="font-size:10px">Your filtered week was 23 of 33 = 70%, 95% interval 54–85%. '+
    'The bold row is the lower bound — the one worth sizing off.</span></div>';
}

function explainLimits(s){
  const box=$("limitsMean"); if(!box||!s) return;
  const num=id=>{const v=Number(($(id)||{}).value); return isFinite(v)?v:0;};
  const stop=num("stopLossPct"), lev=Math.max(1,num("maxLeverage"));
  const riskPct=num("riskPerTradePct"), cap=num("maxPositionUsd");
  const equity=(s.account&&s.account.availableBalance)||0;
  if(!(stop>0)){ box.innerHTML=""; return; }

  // The same arithmetic the sizer does, so the two cannot disagree.
  const riskUsd=equity*riskPct/100;
  const wanted=riskUsd/(stop/100);
  const notional=cap>0?Math.min(wanted,cap):wanted;
  const margin=notional/lev;
  const need=stop*(s.limits?s.limits.minRewardRisk:1.2);
  // Levels are only mapped within a fixed band of mark; past it no target can
  // exist in any market, which is arithmetic rather than a market judgement.
  const impossible=need>12;

  box.innerHTML='<div class="banner '+(impossible?"bad":"")+'" style="display:block">'+
    "<b>"+(impossible
      ? "This stop can never produce a trade."
      : "What these settings mean in money")+"</b>"+
    '<div style="font-size:12px;margin-top:6px;line-height:1.7">'+
    "<b>"+n(stop,2)+"% stop</b> is a <b>price move</b>, not a share of your money — price moving "+
      n(stop,2)+"% against you. That is <b>"+n(stop*lev,1)+"% of the margin</b> behind the position at "+
      lev+"x."+
    "<br><b>Max position</b> and <b>Size</b> are <b>notional</b> — the whole position, leverage included. "+
      (equity>0
        ? "On your "+usd(equity)+": risking "+n(riskPct,2)+"% is <b>"+usd(riskUsd)+
          "</b> if the stop fills, which sizes a <b>"+usd(notional)+" notional</b> position tying up <b>"+
          usd(margin)+"</b> of margin at "+lev+"x."
        : "Connect an account to see this in your own numbers.")+
    "<br>"+edgeTable(riskPct, s)+
    "<br>A target must sit <b>"+n(need,2)+"% away</b> ("+n(stop,2)+"% × "+
      n(s.limits?s.limits.minRewardRisk:1.2,2)+" reward-to-risk). "+
      (impossible
        ? '<b style="color:var(--bad)">Levels are only mapped to ±12% of price, so nothing can ever satisfy that — '+
          "every setup will be refused, in any market. Set the stop to about "+
          n(12/4/Math.max(s.limits?s.limits.minRewardRisk:1.2,1),1)+"% or less.</b>"
        : "Levels are mapped to ±12%, so that is reachable.")+
    "</div></div>";
}

async function tick(){
  try{
    render(await api("/api/status"));
    const {signals}=await api("/api/signals?limit=40&symbol=all");
    // The ticker column only appears with more than one desk. With one it is a
    // constant repeated forty times, which is noise.
    const multi=(signals||[]).some(x=>x.symbol&&x.symbol!==(signals[0]||{}).symbol);
    $("signals").innerHTML=signals.length?signals.map(x=>
      '<div class="item"><span class="sev '+x.severity+'">'+x.severity+'</span>'+
      '<span class="muted" style="flex:none;width:64px">'+new Date(x.t).toLocaleTimeString()+'</span>'+
      (multi?'<span style="flex:none;width:78px;font-weight:600">'+(x.symbol||"")+'</span>':"")+
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
    riskPerTradePct:+$("riskPerTradePct").value,maxHoldMinutes:+$("maxHoldMinutes").value,
    sizeDerateStrength:+$("sizeDerateStrength").value};
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
    "Place a "+side+" of "+notionalUsd+" USDT on "+(focusSymbol||"the current contract")+" now, with a "+stopPct+"% protective stop?\\n\\n"+
    "This bypasses the strategy and the sizer. Every safety interlock still applies."))return;
  $("btnPlace").disabled=true;
  const r=await api("/api/place",{method:"POST",body:JSON.stringify({side,notionalUsd,stopPct,symbol:focusSymbol})});
  $("btnPlace").disabled=false;
  $("pvOut").innerHTML=r.error
    ?'<div class="banner bad"><b>Order refused.</b><span>'+String(r.error).replace(/</g,"&lt;")+"</span></div>"
    :'<div class="banner"><b>Filled.</b><span>'+r.quantity+" contracts at "+r.leverage+
      "x · protective stop resting on Binance at "+(r.stop&&r.stop.stopPrice)+
      ". Check it on the exchange, then use Close position.</span></div>";
  if(!r.error) render(r);
};
$("btnExitTest").onclick=async()=>{
  const notionalUsd=+$("pvNotional").value;
  if(!confirm("Open a REAL "+notionalUsd+" USDT position on "+(focusSymbol||"the current contract")+
    " with a stop and a target 0.1% either side, and wait up to 5 minutes for one to fire?\\n\\n"+
    "This proves the brackets actually trigger rather than merely rest. It costs the round trip "+
    "and whatever the move is. If neither fires it closes at market."))return;
  $("btnExitTest").disabled=true;
  $("pvOut").innerHTML='<div class="banner warn"><span>Running — this takes up to 5 minutes. '+
    "Watch the log below.</span></div>";
  const r=await api("/api/testexit",{method:"POST",body:JSON.stringify({notionalUsd,symbol:focusSymbol})});
  $("btnExitTest").disabled=false;
  if(r.error){ $("pvOut").innerHTML='<div class="banner bad"><b>Could not run.</b><span>'+
    String(r.error).replace(/</g,"&lt;")+"</span></div>"; return; }
  const x=r.result;
  $("pvOut").innerHTML='<div class="banner '+(x.ok?"":"warn")+'" style="display:block"><b>'+
    (x.ok?"The "+x.closedBy+" fired.":"Inconclusive — "+x.closedBy)+"</b>"+
    '<div style="font-size:12px;margin-top:6px">'+
    (x.exitPrice?"Filled at "+n(x.exitPrice)+", trigger was "+n(x.closedBy==="stop"?x.stopPrice:x.targetPrice)+
      (x.slippageBps!==null?" — "+n(x.slippageBps,1)+"bp of slippage":""):"No fill recorded.")+
    '</div><div class="muted" style="font-size:11px;margin-top:6px">'+
    x.steps.map(st=>new Date(st.at).toLocaleTimeString()+"  "+String(st.text).replace(/</g,"&lt;")).join("<br>")+
    "</div></div>";
  render(r);
};
$("btnClose").onclick=async()=>{
  if(!confirm("Close the open "+(focusSymbol||"")+" position at market?"))return;
  const r=await api("/api/close",{method:"POST",body:JSON.stringify({symbol:focusSymbol})});
  $("pvOut").innerHTML=r.error
    ?'<div class="banner bad"><span>'+String(r.error).replace(/</g,"&lt;")+"</span></div>"
    :'<div class="banner"><span>Position closed at market.</span></div>';
  if(!r.error) render(r);
};

$("btnPreview").onclick=async()=>{
  const body={side:$("pvSide").value,notionalUsd:+$("pvNotional").value,
    leverage:+$("pvLeverage").value,entryPrice:$("pvEntry").value?+$("pvEntry").value:undefined,symbol:focusSymbol};
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
  const r=await api("/api/suggest",{method:"POST",body:JSON.stringify({direction:$("sgDir").value,symbol:focusSymbol})});
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
