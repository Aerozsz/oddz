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

import { beat, readHeartbeat } from "./heartbeat";
import { loadEnv } from "./load-env";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { attachCalendar } from "../lib/sweep/metrics/event-store";
import { dropEngine, getEngine } from "../lib/sweep/engine";
import { attachNews } from "../lib/sweep/agent/feed";
import { createSweepFeed, type SweepFeed } from "../lib/sweep/agent";
import type { Signal } from "../lib/sweep/agent";
import {
  fetchAccountRisk,
  fetchSpotUsdt,
  fetchTradableSymbols,
  hasCredentials,
  loadConfig,
  explainError,
  redact,
  transferUsdt,
  transfersAllowed,
  type AccountRisk,
  syncClock,
  clockState,
} from "../lib/sweep/exchange/binance";
import { previewPosition } from "../lib/sweep/exchange/preview";
import { proposePosition } from "../lib/sweep/agent/sizing";
import { holdDecision, type HoldDecision } from "../lib/sweep/agent/hold";
import { profitDecision, type ProfitDecision } from "../lib/sweep/agent/profit";
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
  placeTakeProfit,
  reducePosition,
  setLeverage,
  testExitPath,
  type ProtectionState,
} from "../lib/sweep/exchange/orders";
import { fetchPosition } from "../lib/sweep/exchange/binance";
import { dayDrawdown, fetchDayActivity, fetchSettlement, type DayActivity } from "../lib/sweep/exchange/activity";
import { readEpoch, rebaseNow, reconcileLedger, type LedgerEpoch } from "../lib/sweep/exchange/ledger";
import { snapshotPath, writeSnapshot } from "../lib/sweep/metrics/snapshot";
import { killTree } from "../lib/sweep/agent/process-tree";
import { summariseShadow, type ShadowRowLike } from "../lib/sweep/agent/shadow-summary";
import { desiredPath, planDesired, readDesired } from "../lib/sweep/agent/desired";
import { appendNote, outbox, repliesPath, thread } from "../lib/sweep/agent/messages";
import { startOfDayUtc } from "../lib/sweep/exchange/activity";
import { Excursion, captureConditions, type EntryConditions, type TradeRecord } from "../lib/sweep/agent/postmortem";
import { appendTrade, loadTrades } from "../lib/sweep/metrics/trade-log";
import { analyse, classifyLoss, recommendations } from "../lib/sweep/agent/learn";
import { BOUNDS, proposeTuning, type TuneChange, type TuneEntry, type Tunable } from "../lib/sweep/agent/autotune";
import { appendTune, appendTuneChecked, loadTuning } from "../lib/sweep/metrics/tune-log";
import {
  ConstraintMemory, classifyConstraint,
  type ConstraintEvent, type ConstraintKind,
} from "../lib/sweep/exchange/constraints";
import { newsFor, newsPath } from "../lib/sweep/metrics/news-store";
import { startNewsPoller, type NewsPoller } from "../lib/sweep/metrics/news-poller";
import { available as newsSources, unavailable as newsOff } from "../lib/sweep/metrics/sources";
import { livePressure } from "../lib/sweep/agent/pressure";
import { createBinanceAdapter, flatten, type ExecutionRecord } from "../lib/sweep/exchange/adapter";
import { closePositionAtLimit } from "../lib/sweep/exchange/orders";
import { attachExecution, intentId, type ExecutionRunner } from "../lib/sweep/agent";
import { CONFIG, SYMBOLS, isCalibrated } from "../lib/sweep/config";
import { MAX_SYMBOLS, normalise, readSymbols, symbolsPath, writeSymbols } from "../lib/sweep/metrics/symbol-store";
import { findContract, loadCatalog, searchCatalog } from "../lib/sweep/metrics/symbol-catalog";

/*
 * Node 22 or newer. The engine uses the global WebSocket, which older releases
 * do not provide — without this check that surfaces as "WebSocket is not
 * defined" deep inside a stream callback, which is a miserable first
 * experience for something that is really just a version mismatch.
 */
// The tape, the crowd and the wires reach the sizer through this. Shared with
// the shadow run so a shadow trade and a live one are scored against the same
// reading of the outside world.
attachNews(livePressure);

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

/**
 * Failures, kept apart from the ordinary log.
 *
 * The log ring holds 200 lines and a busy minute fills it, so an exception at
 * 09:15 is gone by 09:20 — which is exactly when someone starts asking what
 * happened. These are kept separately and never rotate out for ordinary
 * chatter, because the question "did anything throw" should not depend on how
 * talkative the rest of the process was.
 */
interface ErrorLine { t: number; where: string; text: string; stack?: string }
const errorLines: ErrorLine[] = [];

function noteError(where: string, err: unknown) {
  const text = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack.split("\n").slice(0, 6).join("\n") : undefined;
  errorLines.push({ t: Date.now(), where, text: redact(text), stack: stack ? redact(stack) : undefined });
  if (errorLines.length > 60) errorLines.shift();
}

/*
 * Nothing else catches these.
 *
 * An unhandled rejection in a background sweep previously vanished: no log
 * line, no crash, just a loop that stopped doing something. Recorded here so it
 * reaches the snapshot, and deliberately not rethrown — a trading process with
 * an open position should not exit because a status fetch rejected.
 */
process.on("unhandledRejection", (reason) => {
  noteError("unhandled rejection", reason);
  console.error("[control] unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  noteError("uncaught exception", err);
  console.error("[control] uncaught exception:", err);
});

/**
 * Collapse a line that is repeating.
 *
 * A rejection that recurs once a second is one fact, not four hundred, and
 * printing it four hundred times does not make it more true — it buries the
 * line that mattered. That happened: a loop rejecting every signal on a
 * mistaken fifteen-minute cooldown filled the log so completely that the
 * execution record explaining what the *first* trade actually did was pushed
 * out of the ring entirely.
 *
 * Consecutive identical lines become one entry with a count. Anything
 * different flushes it, so ordering is preserved and nothing is lost — only
 * repetition is compressed.
 */
let repeat: { text: string; count: number; first: number } | null = null;

const log = (...a: unknown[]) => {
  const text = a.map((x) => (typeof x === "string" ? redact(x) : JSON.stringify(x))).join(" ");

  if (repeat && repeat.text === text) {
    repeat.count++;
    const line = logLines[logLines.length - 1];
    if (line) line.text = `${text}  (×${repeat.count} since ${new Date(repeat.first).toLocaleTimeString()})`;
    // Printed on a cadence rather than every time, so a terminal stays readable
    // without the repetition becoming invisible.
    if (repeat.count === 5 || repeat.count % 50 === 0) {
      console.log("[control]", `${text}  (×${repeat.count})`);
    }
    return;
  }

  repeat = { text, count: 1, first: Date.now() };
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
  /**
   * `at` of the last remote configuration applied, so it is applied once ever.
   *
   * Persisted rather than held in memory: a configuration file living in the
   * repository would otherwise be reimposed on every restart, overriding the
   * operator indefinitely.
   */
  desiredAppliedAt: number;
  /**
   * Enforced gap between entries across all desks, in seconds. Zero disables it.
   *
   * A guard against one burst of correlated signals opening everything at once.
   * It was a constant, which made it invisible and unmovable; on a testnet run
   * whose purpose is collecting samples it is pure throughput loss.
   */
  burstGuardSec: number;
  /**
   * Conviction below which the bias calls no side. Zero calls every one.
   *
   * The number that refused 1,717 of 1,816 signals, and which a year of history
   * says was not selecting for anything.
   */
  biasDeadZone: number;
  /**
   * When the balance-derived caps were filled in, or 0 if they never were.
   *
   * Exists so that a cap of zero can mean one thing instead of two. It used to
   * mean both "never configured" and "deliberately switched off", and the
   * deriver could not tell them apart — so it kept recomputing a daily loss
   * budget that had been set to zero on purpose. After the first derivation a
   * zero is the operator's decision and is left alone.
   */
  capsDerivedAt: number;
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
  /**
   * Whether the learning loop may move the caps on its own.
   *
   * Off by default, because a fresh install has no trades to learn from and
   * turning it on before there are any means the first handful of closes get to
   * set the dials for everything after them.
   *
   * When on, it can only touch the five settings in TunableLimits, only inside
   * hard bounds, only one at a time, and never the daily loss cap, the cooldown
   * or the trade ceiling — those stay where the operator put them.
   */
  autoTune: boolean;
  /**
   * Share of free collateral held back rather than committed, in percent.
   *
   * Answers "-2019 Margin is insufficient" at its cause. Sizing used the whole
   * available balance, so `notional = equity × leverage` was exactly the most
   * the account could fund and the opening commission pushed every maximum-size
   * order over. Held back, the same risk arithmetic produces an order that
   * actually fits.
   *
   * The right value is account-specific — fee tier, leverage brackets,
   * unrealised PnL moving the free balance between the read and the order — so
   * the constraint loop raises it when the venue keeps saying it is not enough,
   * and lowers it again after a long clean run.
   */
  marginHeadroomPct: number;
  /**
   * Multiples of risk before the trailing stop arms. 0 disables the trail.
   *
   * Below this the break-even ratchet governs alone. Trailing earlier would put
   * the stop inside the noise band the original stop was widened to clear.
   */
  trailArmsAtR: number;
  /** Multiples of risk at which part of the position is taken. 0 disables. */
  scaleOutAtR: number;
  /** How much of the original position that takes, in percent. */
  scaleOutFraction: number;
  /**
   * How many times the round trip a target must be worth.
   *
   * The dial that decides whether small, fast moves are tradeable at all. See
   * the note in sizing.ts: set to 3 it refused four consecutive real winners.
   */
  minRewardOverFees: number;
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
  /*
   * The three stopping rules default to off, and Reset leaves them off.
   *
   * They were 394 USD, 8 trades and 15 minutes, and every one of them was
   * switched off deliberately to collect data — then Reset put them back,
   * eight trades happened, and the cap blocked 510 of the next 747 signals
   * while the page reported "armed" and "tradeable". A control the operator
   * has explicitly disabled must not come back because a button labelled
   * "reset to agreed" disagrees with what was agreed.
   *
   * Zero means no limit, consistently with every other cap here. Turning them
   * back on is one edit away and is the operator's call to make.
   */
  maxDailyLossUsd: 0,
  maxOpenPositions: 1,
  tradingEnabled: false,
  stopLossPct: 0.5,
  maxTradesPerDay: 0,
  lossCooldownMin: 0,
  requireCashOpen: false,
  minRewardRisk: 2,
  maxHoldMinutes: 120,
  riskPerTradePct: 4,
  sizeDerateStrength: 0.5,
  breakEvenAtPct: 60,
  minRewardOverFees: 2,
  autoTune: false,
  // Enough to cover a taker commission on both legs plus the exchange's own
  // initial-margin rounding, which is what the boundary case was short of.
  marginHeadroomPct: 5,
  burstGuardSec: 60,
  biasDeadZone: 0.12,
  desiredAppliedAt: 0,
  capsDerivedAt: 0,
  trailArmsAtR: 1,
  scaleOutAtR: 1.5,
  scaleOutFraction: 40,
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

/**
 * The limits file is operator input. Nothing here rewrites a value in it.
 *
 * There was a migration in this spot that moved settings whose default had been
 * judged wrong — and it was wrong to have written it, for a reason worth keeping
 * on record. An operator who types a number into a box and comes back to find
 * the program has changed it cannot trust any other number on the page either,
 * and they now have to re-check the entire configuration after every update.
 * That cost is far larger than any default being two points off.
 *
 * So: a key absent from the file takes the default, which is what a default is
 * for. A key present in the file wins, always, including when it is the same
 * value a default used to have and including when a later version disagrees.
 * The only writer of a value here is the operator, through the form, and the
 * auto-tuner, which keeps its own audit log of every change it makes.
 */
function readLimits(): Limits {
  const raw = (() => {
    if (!existsSync(LIMITS_PATH)) return null;
    try {
      return JSON.parse(readFileSync(LIMITS_PATH, "utf8")) as Partial<Limits>;
    } catch {
      return null;
    }
  })();

  const stored = raw ? { ...DEFAULT_LIMITS, ...raw } : { ...DEFAULT_LIMITS };

  /*
   * An existing file means an operator has been running this, so their zeros are
   * decisions and not gaps.
   *
   * capsDerivedAt did not exist before, so every upgrading install reads it as 0
   * — "fresh, derive everything" — and the first boot after the upgrade would
   * put a daily loss budget back onto an account that had deliberately switched
   * it off. The file's existence is the evidence that it was configured; the
   * sentinel records that without claiming a date nobody measured.
   */
  if (raw && !(Number(raw.capsDerivedAt) > 0)) {
    stored.capsDerivedAt = 1;
    /*
     * Written back, not only held in memory.
     *
     * Recomputing it on every boot gives the right answer for as long as this
     * branch exists, which makes a decision the operator made — those zeros are
     * deliberate — depend on a few lines nobody is looking at. Persisting it
     * turns the inference into a recorded fact, and the file becomes the thing
     * that remembers rather than the code.
     *
     * Exactly the one field, so nothing else in the file is disturbed, and it
     * fires once: the next read sees the sentinel and skips this. A failure
     * here is ignored on purpose — a read-only disk must not stop the agent
     * booting, and the in-memory value is already correct.
     */
    try {
      writeLimits({ ...(raw as unknown as Limits), capsDerivedAt: 1 });
    } catch {
      /* the value above still applies for this run */
    }
  }


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
  /** Side-specific depth at the moment of sizing, for the same reason. */
  pendingEntryLwi: number | null;
  /** When the stop was moved to break-even, so it happens at most once. */
  ratchetedAt: number;
  /** The most recent hold decision, so the page can show why it is still open. */
  hold: HoldDecision | null;
  /**
   * Consecutive failures placing the take-profit for the current position.
   *
   * The repair pass runs every twenty seconds, so a target the exchange will
   * never accept — a rejected trigger, an order type it wants shaped
   * differently — retries forever and says so every time. That is the same
   * failure that just buried a log: a real problem, reported truthfully, at a
   * rate that hides everything else including itself.
   */
  targetFailures: number;
  /**
   * How far the open position has run in each direction.
   *
   * Kept live rather than reconstructed after the fact. The exchange will
   * happily report a one-minute kline afterwards, and a one-minute bar hides an
   * excursion that lasted eight seconds — which on a strategy whose whole
   * premise is that the move happens in seconds is the only excursion there is.
   */
  excursion: Excursion | null;
  /**
   * Fraction of the original position already taken off at a profit.
   *
   * Held per desk rather than derived from the position size, because the
   * exchange reports only what is left — a position reduced from 10 to 6 looks
   * identical to one opened at 6, and without this the scale-out would fire
   * again on every sweep until the position was gone.
   */
  scaledOut: number;
  /**
   * How many times this position's target has been moved further out.
   *
   * Per position, and the reason the counter exists at all: without it the
   * target retreated every time price came near, so a winning position could
   * never reach a target and never closed in profit.
   */
  targetRolls: number;
  /** The most recent profit-management decision, for the page to show. */
  profit: ProfitDecision | null;
  /**
   * Whether that tracker has been running since the position was opened.
   *
   * False for a position inherited at startup, where it only covers the part
   * after the process came back. The distinction is load-bearing: "it never
   * moved in favour" and "nobody was watching while it moved" produce identical
   * numbers and opposite conclusions, so the analyser is told which it has.
   */
  excursionFromOpen: boolean;
  /**
   * The reason the loop closed this position, held until the close is observed.
   *
   * Written when the exit is sent and read when the position is next seen flat,
   * because those are two different sweeps. Without it the post-mortem cannot
   * tell an exit this program chose from one the exchange's stop delivered, and
   * those two have opposite fixes.
   */
  exitIntent: { reason: string; at: number } | null;
  /** Conditions captured at sizing, held until the execution record arrives. */
  pendingConditions: EntryConditions | null;
  /**
   * The rest of what the sizer chose, held for the same window.
   *
   * The exchange reports the position but not the intent behind it, and the
   * post-mortem needs the intent: the result has to be expressed as a multiple
   * of the risk that was actually taken, or a $300 winner on a small position
   * and a $300 winner on a large one get averaged together as the same event.
   */
  pendingStopPrice: number | null;
  pendingNotional: number | null;
  pendingLeverage: number | null;
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
    pendingEntryLwi: null,
    ratchetedAt: 0,
    targetFailures: 0,
    hold: null,
    excursion: null,
    scaledOut: 0,
    targetRolls: 0,
    profit: null,
    excursionFromOpen: false,
    exitIntent: null,
    pendingConditions: null,
    pendingStopPrice: null,
    pendingNotional: null,
    pendingLeverage: null,
  };
}

/*
 * Seeded from the store, which is the file if one exists and the environment if
 * not. Desks are added and removed at runtime from here on, so this is only the
 * starting set — see addDesk/removeDesk.
 */
const desks = new Map<string, Desk>(readSymbols().map((s) => [s, newDesk(s)]));

/*
 * Where today's counting starts. Moved forward when the wallet stops agreeing
 * with the ledger — see exchange/ledger.ts.
 */
let ledgerEpoch: LedgerEpoch = readEpoch();

/** So the "caps still unset" warning is said once, not every twenty seconds. */
let capsWarned = false;
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
let focus = allDesks()[0]?.symbol ?? SYMBOLS[0];
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

/* ---------------------------------------------------------------- symbols */

/**
 * Adding and dropping a contract while the server runs.
 *
 * This used to be an environment variable, so changing it meant a restart — and
 * a restart is not free here. The withdrawal metrics, the mark-out and the shock
 * detector are all EWMAs over minutes of history, so bouncing the process to add
 * a fourth contract blinds the three already running for as long as they take to
 * warm back up. Adding a desk in place costs the new desk its warm-up and costs
 * the others nothing, which is the only version of this that is safe to do
 * during a session.
 */
export interface SymbolChange {
  ok: boolean;
  symbols: string[];
  note: string;
}

async function addDesk(raw: string): Promise<SymbolChange> {
  const symbol = normalise(raw);
  const current = allDesks().map((d) => d.symbol);
  if (!symbol) return { ok: false, symbols: current, note: "no symbol given" };
  if (desks.has(symbol)) return { ok: false, symbols: current, note: `${symbol} is already being watched` };
  if (desks.size >= MAX_SYMBOLS) {
    return {
      ok: false,
      symbols: current,
      note:
        `${MAX_SYMBOLS} contracts is the ceiling — each one is a WebSocket and a share of the same ` +
        `rate limit, and past this the book updates start arriving late on all of them. Remove one first.`,
    };
  }

  /*
   * Checked against the exchange before anything is started.
   *
   * A ticker that does not exist is the silent failure this whole picker was
   * built to remove: the engine connects, subscribes to a stream nobody
   * publishes, and reports itself healthy forever. Refusing here is the
   * difference between a typo costing a second and a typo costing an afternoon.
   */
  const catalog = await loadCatalog();
  const contract = findContract(catalog, symbol);
  if (!contract) {
    if (catalog.error && catalog.entries.length === 0) {
      return { ok: false, symbols: current, note: `could not reach the exchange to check ${symbol}: ${catalog.error}` };
    }
    return { ok: false, symbols: current, note: `Binance does not list a perpetual called ${symbol}` };
  }

  desks.set(symbol, newDesk(symbol));
  // Idempotent: it skips every desk that already has a feed, so this starts
  // exactly the new one.
  startEngine();
  const saved = writeSymbols(allDesks().map((d) => d.symbol));

  const warnings: string[] = [];
  if (contract.orderable === false) {
    warnings.push(
      `your order venue does not list it, so this desk can watch but never trade — ` +
        `it is real on production and absent from ${catalog.orderVenue ?? "the venue orders go to"}`,
    );
  }
  if (!isCalibrated(symbol)) {
    warnings.push(
      "uncalibrated: the order path works, but the leverage ladder, maintenance rate, session weights " +
        "and earnings calendar are built for a US equity perp and mean nothing here",
    );
  }
  if (contract.volumeUsd > 0 && contract.volumeUsd < 5_000_000) {
    warnings.push(
      `thin — $${Math.round(contract.volumeUsd / 1e6 * 10) / 10}M of 24h volume. The premise here is that ` +
        `withdrawn depth is informative, and on a book this quiet there is little to withdraw`,
    );
  }

  const note = `watching ${symbol}${warnings.length ? ` — ${warnings.join("; ")}` : ""}`;
  log(`symbols: added ${symbol}${warnings.length ? ` (${warnings.join("; ")})` : ""}`);
  return { ok: true, symbols: saved, note };
}

function removeDesk(raw: string): SymbolChange {
  const symbol = normalise(raw);
  const current = allDesks().map((d) => d.symbol);
  const desk = desks.get(symbol);
  if (!desk) return { ok: false, symbols: current, note: `${symbol} is not being watched` };
  if (desks.size <= 1) {
    return { ok: false, symbols: current, note: "this is the only contract — add another before removing it" };
  }

  /*
   * Never while it is holding.
   *
   * Removing the desk does not close the position; it removes the only thing
   * managing it. The stop stays on the exchange, so the money is not
   * unprotected — but the time stop, the target, the trailing logic and the
   * post-mortem all live in this loop, so the position would sit on its stop
   * until a human noticed. That is precisely the orphan state the startup
   * reconciler shouts about, and there is no reason to create one on purpose.
   */
  const position = desk.protection.state?.position;
  if (position && position.positionAmt !== 0) {
    return {
      ok: false,
      symbols: current,
      note:
        `${symbol} is holding ${position.positionAmt} — removing it would leave the position on its stop ` +
        `with nothing managing the target or the time stop. Close it first.`,
    };
  }

  // Disarmed before the feed goes, so the execution loop cannot fire into a
  // desk that is being torn down.
  desk.runner?.stop();
  desk.runner = null;
  desk.feed?.close();
  desk.feed = null;
  dislocation.forget(symbol);
  desks.delete(symbol);
  // The feed only unsubscribes; the engine underneath keeps its socket, its
  // timers and its baselines. Without this every add/remove cycle would leave
  // another live stream running against the same rate limit.
  dropEngine(symbol);

  if (focus === symbol) focus = allDesks()[0]?.symbol ?? focus;
  const saved = writeSymbols(allDesks().map((d) => d.symbol));
  log(`symbols: removed ${symbol}`);
  return { ok: true, symbols: saved, note: `stopped watching ${symbol}` };
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
  /**
   * Depth on the side that mattered, at the moment of entry.
   *
   * The trade was justified by this being low. Without it, "the book has
   * refilled" is unanswerable after a restart — and that is the fastest of the
   * exits, so losing it costs more than losing the target would.
   */
  entryLwi: number | null;
  /**
   * Everything the entry was justified by, frozen at the moment it was taken.
   *
   * On disk rather than in memory only, because the post-mortem is written when
   * the position closes and a position can outlive the process that opened it.
   * A trade whose record survives but whose conditions do not is worse than no
   * record: it still counts in every total while contributing nothing to the
   * question of what separates the losers.
   */
  conditions?: EntryConditions | null;
  /** What was actually committed, so the result can be expressed in R. */
  notionalUsd?: number;
  leverage?: number;
  /** Where the stop rested, for the same reason. */
  stopPrice?: number | null;
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
/** Attempts at the take-profit before leaving the position on its stop. */
const MAX_TARGET_ATTEMPTS = 3;

async function maintainBrackets() {
  if (!hasCredentials()) return;
  const cfg = loadConfig();
  for (const desk of allDesks()) {
    const state = desk.protection.state;
    const pos = state?.position;
    if (!pos || pos.positionAmt === 0) continue;

    const target = journalTarget(desk.symbol);
    const precision = metaFor(desk.symbol)?.pricePrecision ?? 2;

    /*
     * Re-place anything missing from the bracket.
     *
     * A missing stop is always retried: the position is uncovered and there is
     * no number of failures that makes giving up correct. A missing target is
     * given a few attempts and then left alone, because a target the exchange
     * keeps refusing is a defect to be read about once rather than a condition
     * to retry every twenty seconds for the life of the position. The position
     * still exits on its stop and its time limit, which is where it was before
     * targets existed.
     */
    const wantTarget = target !== null && !state.takeProfit && desk.targetFailures < MAX_TARGET_ATTEMPTS;
    if (!state.protected || wantTarget) {
      try {
        const before = state.takeProfit;
        const fixed = await ensureProtected(cfg, desk.symbol, pos, limits.stopLossPct, precision, target);
        desk.protection = { state: fixed, error: null, at: Date.now() };
        if (target !== null && !before && !fixed.takeProfit) {
          desk.targetFailures++;
          if (desk.targetFailures >= MAX_TARGET_ATTEMPTS) {
            log(
              `bracket ${desk.symbol}: the exchange refused the target ${desk.targetFailures} times — ` +
                `no longer retrying. The stop and the ${limits.maxHoldMinutes} min time limit still govern ` +
                `this position. ${fixed.reason}`,
            );
          } else {
            log(`bracket ${desk.symbol}: ${fixed.reason}`);
          }
        } else {
          desk.targetFailures = 0;
          log(`bracket ${desk.symbol}: ${fixed.reason}`);
        }
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
    const long = pos.positionAmt > 0;
    const entryPrice = pos.entryPrice;
    const feePct = (fees.tiers[0]?.takerRate ?? 0.0005) * 2 * 100;

    /*
     * Break-even first, then the trail.
     *
     * The break-even ratchet stays as the first rung: it fires on progress
     * toward the target and only once, which is the right rule while the trade
     * is still short of a full R and the trail has not armed. Above that the
     * profit engine governs, and the two never fight because both only ever
     * move the stop toward the position — whichever asks for more protection
     * wins, and neither can ask for less.
     */
    let wantStop: number | null = null;
    let rolledTarget: number | null = null;
    let wantScaleOut = 0;
    let why = "";

    const totalMove = target !== null ? Math.abs(target - entryPrice) : 0;
    const travelled = long ? pos.markPrice - entryPrice : entryPrice - pos.markPrice;
    if (limits.breakEvenAtPct && !desk.ratchetedAt && totalMove > 0 &&
        travelled / totalMove >= limits.breakEvenAtPct / 100) {
      // Entry plus the full round trip, not entry itself: a stop exactly at
      // entry still loses the fees both ways, which on this frequency is most
      // of what a scratch trade costs.
      wantStop = long ? entryPrice * (1 + feePct / 100) : entryPrice * (1 - feePct / 100);
      why = `${((travelled / totalMove) * 100).toFixed(0)}% of the way to target — stop to break-even plus fees`;
    }

    /*
     * The profit side proper: trail, scale out, extend.
     *
     * Needs the live feed, because every one of its decisions reads the book —
     * the high-water mark from the excursion tracker, the cluster beyond the
     * target, and the thesis health that decides whether extending is analysis
     * or hope. With no feed the break-even rung above is the whole of the
     * profit management, which is where this was before.
     */
    const feedState = desk.feed?.getState();
    if (feedState && desk.excursion) {
      const remembered = journal[desk.symbol];
      const hold = holdDecision({
        state: feedState,
        side: long ? "long" : "short",
        entryPrice,
        targetPrice: target,
        heldMs: desk.positionOpenedAt ? Date.now() - desk.positionOpenedAt : 0,
        entryLwi: remembered?.entryLwi ?? null,
        config: { baseMinutes: limits.maxHoldMinutes },
      });
      const decision = profitDecision({
        state: feedState,
        side: long ? "long" : "short",
        entryPrice,
        stopPrice: state.stop?.stopPrice ?? null,
        initialStopPct: remembered?.stopPct ?? limits.stopLossPct,
        targetPrice: target,
        highWaterPrice: desk.excursion.peakPrice(),
        scaledOut: desk.scaledOut,
        targetRolls: desk.targetRolls,
        feePct,
        thesisHealth: hold.thesisHealth,
        config: {
          trailArmsAtR: limits.trailArmsAtR,
          scaleOutAtR: limits.scaleOutAtR,
          scaleOutFraction: limits.scaleOutFraction / 100,
        },
      });
      desk.profit = decision;

      // Whichever protects more wins. Both are monotone toward the position, so
      // taking the better of the two can never loosen anything.
      if (decision.stopPrice !== null) {
        const better = wantStop === null ||
          (long ? decision.stopPrice > wantStop : decision.stopPrice < wantStop);
        if (better) { wantStop = decision.stopPrice; why = decision.notes[0] ?? decision.reason; }
      }
      rolledTarget = decision.targetPrice;
      wantScaleOut = decision.scaleOutFraction;
    }

    /* ------------------------------------------------------- scale out */

    if (wantScaleOut > 0) {
      try {
        const taken = await reducePosition(
          cfg, desk.symbol, wantScaleOut, metaFor(desk.symbol)?.quantityPrecision ?? 0,
        );
        if (taken.quantity > 0) {
          // Recorded before anything else can fail, so a partial that filled is
          // never taken twice by the next sweep.
          desk.scaledOut = wantScaleOut;
          log(`SCALE OUT ${desk.symbol}: ${taken.reason} — ${desk.profit?.notes[0] ?? ""}`);
          await refreshAccount();
        } else {
          // Recorded as done anyway: the refusal is structural — the remainder
          // would be untradeable — and retrying every twenty seconds would log
          // the same impossibility for the life of the position.
          desk.scaledOut = wantScaleOut;
          log(`scale out ${desk.symbol} declined: ${taken.reason}`);
        }
      } catch (err) {
        log(`scale out ${desk.symbol} FAILED: ${redact(err instanceof Error ? err.message : String(err))}`);
      }
      continue; // next sweep re-reads the smaller position before touching the bracket
    }

    /* ---------------------------------------------------- roll the target */

    if (rolledTarget !== null && target !== null) {
      try {
        const moved = await placeTakeProfit(cfg, desk.symbol, pos, rolledTarget, precision);
        if (state.takeProfit) {
          await cancelOrder(cfg, desk.symbol, state.takeProfit.orderId, state.takeProfit.isAlgo)
            .catch(() => { /* two targets is harmless: the nearer one fills first */ });
        }
        const j = journal[desk.symbol];
        journalOpen(desk.symbol, { ...j, openedAt: j?.openedAt ?? desk.positionOpenedAt, targetPrice: rolledTarget } as Parameters<typeof journalOpen>[1]);
        // Counted only once the exchange accepted the new target, so a refused
        // roll does not consume one of the position's two chances.
        desk.targetRolls++;
        log(`TARGET ROLLED ${desk.symbol} (${desk.targetRolls}/2): ${target} → ${moved.stopPrice} — ${desk.profit?.notes[0] ?? ""}`);
      } catch (err) {
        log(`target roll ${desk.symbol} declined: ${redact(err instanceof Error ? err.message : String(err))}`);
      }
    }

    if (wantStop === null) continue;
    const beStop = wantStop;
    const current = state.stop?.stopPrice ?? 0;
    const improves = long ? beStop > current : beStop < current;
    if (!improves) {
      // The break-even rung is a one-shot, so mark it done. The trail is not —
      // it re-evaluates every sweep and simply has nothing better to offer yet.
      desk.ratchetedAt = Date.now();
      continue;
    }
    // Refuse to place a stop the wrong side of mark — it would fill instantly
    // at market, closing the position at whatever the book offers.
    if (long ? beStop >= pos.markPrice : beStop <= pos.markPrice) continue;

    /*
     * New stop first, old stop second.
     *
     * The obvious order is cancel-then-place, and it is wrong: if the placement
     * fails — a rejected trigger, a rate limit, a dropped connection — the
     * position is naked until the next sweep repairs it twenty seconds later.
     * That is precisely the state this whole module exists to prevent, created
     * deliberately, in pursuit of an improvement the position did not need.
     *
     * Placing first fails the safe way instead. If the exchange refuses a
     * second protective order the original is still resting and nothing has
     * been lost; if it accepts, there are briefly two, and since both are
     * closePosition orders whichever triggers first closes the position and
     * Binance cancels the other. The transient cost of two stops is nothing;
     * the transient cost of zero is the account.
     */
    try {
      const moved = await placeProtectiveStop(cfg, desk.symbol, pos, beStop, precision);
      desk.ratchetedAt = Date.now();
      if (state.stop) {
        try {
          await cancelOrder(cfg, desk.symbol, state.stop.orderId, state.stop.isAlgo);
        } catch (err) {
          // Two stops resting is survivable and self-correcting: the wider one
          // is now unreachable without the nearer one firing first. Worth
          // saying, not worth unwinding.
          log(
            `ratchet ${desk.symbol}: the old stop at ${state.stop.stopPrice} could not be cancelled ` +
              `(${redact(err instanceof Error ? err.message : String(err))}) — both are resting, the nearer one governs`,
          );
        }
      }
      log(`STOP RAISED ${desk.symbol} to ${moved.stopPrice} — ${why || "protecting open profit"}`);
      await refreshAccount();
    } catch (err) {
      // The original stop was never touched, so the position is still covered
      // and the next sweep will try again.
      log(
        `ratchet ${desk.symbol} declined, original stop still resting: ` +
          `${redact(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }
}

async function enforceMaxHold() {
  if (!limits.maxHoldMinutes || !hasCredentials()) return;
  for (const desk of allDesks()) {
    const pos = desk.protection.state?.position;
    if (!pos || pos.positionAmt === 0) {
      // The post-mortem is written before the journal entry is dropped, because
      // the journal holds the only copy of what the entry was justified by.
      if (desk.positionOpenedAt) {
        await recordClosedTrade(desk);
        journalClose(desk.symbol);
      }
      desk.positionOpenedAt = 0;
      desk.ratchetedAt = 0;
      desk.targetFailures = 0;
      desk.hold = null;
      desk.excursion = null;
      desk.excursionFromOpen = false;
      desk.exitIntent = null;
      desk.scaledOut = 0;
      desk.targetRolls = 0;
      desk.profit = null;
      continue;
    }
    if (!desk.positionOpenedAt) {
      desk.positionOpenedAt = Date.now();
      continue;
    }

    const state = desk.feed?.getState();
    const remembered = journal[desk.symbol];
    const heldMs = Date.now() - desk.positionOpenedAt;

    /*
     * Take the exchange's entry price onto the journal, every sweep.
     *
     * A market order's immediate response carries avgPrice 0 — the fill is
     * reported asynchronously — so the journal recorded 0 for the entry on
     * every taker entry, which is all of them. The excursion tracker already
     * worked around this by falling back to the mark; the post-mortem did not,
     * and the comment claiming the real price is "reconciled onto the record at
     * close time" described something that was never implemented.
     *
     * The consequence was silent and reached everything downstream. `rMultiple`
     * requires `entryPrice > 0`, so expectancy was computed from 2 of 27
     * trades. `stopDistPct` has the same guard, so `classifyLoss` could not
     * reach its `never-worked` or `stopped-mid-move` branches and filed 21 of
     * 23 losses as `cut-on-time` — whose prescription is "a patience problem",
     * which would have had the hold limit raised on trades that were dying at
     * entry.
     *
     * `pos.entryPrice` is Binance's own average fill price for the open
     * position and is already trusted three lines below to decide when to
     * close. Writing it here costs one journal write per position, because
     * after the first pass the two agree.
     */
    if (remembered && pos.entryPrice > 0 && remembered.entryPrice !== pos.entryPrice) {
      journal[desk.symbol] = { ...remembered, entryPrice: pos.entryPrice, updatedAt: Date.now() };
      writeJournal(journal);
    }

    /*
     * The adaptive decision when there is enough to make one, the flat limit
     * when there is not.
     *
     * The fallback matters as much as the logic: with no state the exits that
     * read the book cannot fire, and a position with no supervision at all is
     * worse than one supervised by a clock. So the clock stays underneath.
     */
    if (!state) {
      if (heldMs < limits.maxHoldMinutes * 60_000) continue;
      await closeFor(desk, `held ${Math.round(heldMs / 60_000)} min with no live reading to judge it by`);
      continue;
    }

    const decision = holdDecision({
      state,
      side: pos.positionAmt > 0 ? "long" : "short",
      entryPrice: pos.entryPrice,
      targetPrice: remembered?.targetPrice ?? null,
      heldMs,
      entryLwi: remembered?.entryLwi ?? null,
      config: { baseMinutes: limits.maxHoldMinutes },
    });
    desk.hold = decision;

    if (!decision.close) continue;
    await closeFor(desk, decision.reason);
  }
}

/** Close a desk's position and say why, in one place. */
async function closeFor(desk: Desk, reason: string) {
  try {
    // Recorded before the call, not after: if the request succeeds and the
    // response is lost, the position is closed and this process never learns it
    // chose to close it — and the post-mortem then files a deliberate exit as
    // one the exchange delivered.
    desk.exitIntent = { reason, at: Date.now() };
    await closePosition(loadConfig(), desk.symbol);
    log(`EXIT ${desk.symbol}: ${reason}`);
    // Deliberately not cleared here. The flat position is observed on the next
    // sweep, and that is where the post-mortem is written from — clearing the
    // open time now would make it look like there was never a position.
    desk.hold = null;
    await refreshAccount();
  } catch (err) {
    desk.exitIntent = null;
    log(`exit FAILED (${desk.symbol}): ${redact(err instanceof Error ? err.message : String(err))}`);
  }
}

/* ----------------------------------------------------------- the post-mortem */

/**
 * Write down what just happened, in full, while the context still exists.
 *
 * Called the first sweep after a position is seen flat and before the journal
 * entry is dropped, because the journal holds the only copy of the readings the
 * entry was justified by. Miss this window and the trade is still in Binance's
 * ledger as a number, which is exactly the record that cannot answer why.
 *
 * Everything here is best-effort and nothing throws. A failure to record is a
 * gap in the analysis; a throw would propagate into the sweep that keeps stops
 * resting, and trading a position without a stop in order to protect a log
 * entry has the priorities backwards.
 */
async function recordClosedTrade(desk: Desk) {
  const remembered = journal[desk.symbol];
  if (!remembered || !remembered.conditions) {
    // Opened by hand, or by a build that predates this. Recording it with
    // invented conditions would put a row in the evidence file that the
    // analyser cannot distinguish from a real one.
    if (remembered) log(`no post-mortem for ${desk.symbol}: it was opened without a recorded set of conditions`);
    return;
  }

  const closedAt = Date.now();
  const openedAt = remembered.openedAt || desk.positionOpenedAt || closedAt;

  let settled: Awaited<ReturnType<typeof fetchSettlement>> | null = null;
  try {
    // A small tail past the close: the fill and the ledger row it produces are
    // not written in the same instant, and a window that ends exactly at the
    // observation misses the row that settled the trade.
    settled = await fetchSettlement(loadConfig(), desk.symbol, openedAt - 1_000, closedAt + 30_000);
  } catch (err) {
    log(`post-mortem ${desk.symbol}: could not read the settlement — ${redact(err instanceof Error ? err.message : String(err))}`);
  }

  const entryPrice = remembered.entryPrice;
  const exitPrice = settled?.exitPrice ?? desk.feed?.getState().mark ?? 0;
  const excursion = desk.excursion?.read(remembered.targetPrice) ?? null;

  const net = settled ? settled.realisedPnl - settled.fees - settled.funding : null;
  const marginUsd =
    remembered.notionalUsd && remembered.leverage ? remembered.notionalUsd / remembered.leverage : null;

  /*
   * Win, loss, or scratch — net of everything.
   *
   * A trade that made $4 gross and paid $6 in commission is a loss, and calling
   * it a win because the price went the right way is how a strategy convinces
   * itself it has an edge while the balance falls. The scratch band is the
   * round trip itself: inside it the result is fees, not skill in either
   * direction, and counting those as wins inflates the hit rate that every
   * sizing decision downstream is derived from.
   */
  /*
   * Net decides it, and net is already net of everything.
   *
   * The previous band was a full round trip of the notional — $32 on a $32k
   * position — which double-counted fees, because `net` has already had
   * commission and funding taken out. The effect was not cosmetic: over one
   * weekend it filed 40 real losses totalling $1,037 as "scratch", so they
   * dropped out of the loss anatomy and the tuner saw 14 of 54 losses. The
   * learning loop was reasoning about a quarter of the evidence and had no way
   * to know it.
   *
   * A scratch is now only a trade that moved the balance by less than a cent —
   * float noise, not a category. If money left the account it is a loss, which
   * is also what the account statement says.
   */
  const outcome: TradeRecord["outcome"] =
    net === null ? "scratch" : Math.abs(net) < 0.01 ? "scratch" : net > 0 ? "win" : "loss";

  const record: TradeRecord = {
    id: `${desk.symbol}-${openedAt}`,
    symbol: desk.symbol,
    // A real fill, so every question may be answered from it. See evidence.ts.
    source: "live",
    side: remembered.side,
    openedAt,
    closedAt,
    heldMs: closedAt - openedAt,
    entryPrice,
    exitPrice,
    stopPrice: remembered.stopPrice ?? null,
    targetPrice: remembered.targetPrice,
    notionalUsd: remembered.notionalUsd ?? 0,
    leverage: remembered.leverage ?? 0,
    realisedPnlUsd: net,
    feesUsd: settled ? settled.fees + settled.funding : null,
    roiPct: net !== null && marginUsd ? (net / marginUsd) * 100 : null,
    outcome,
    maePct: excursion?.maePct ?? 0,
    mfePct: excursion?.mfePct ?? 0,
    peakProgress: excursion?.peakProgress ?? 0,
    excursionComplete: !!desk.excursion && desk.excursionFromOpen,
    exitReason:
      desk.exitIntent?.reason ??
      inferExit(remembered, exitPrice) ??
      "closed without this process asking for it",
    entryConditions: remembered.conditions,
    // Context for a human reading the record, never an input to any inference.
    news: newsFor(desk.symbol, 5)
      .filter((n) => n.at >= openedAt - 6 * 3_600_000 && n.at <= closedAt)
      .map((n) => ({ headline: n.headline, impact: n.impact, at: n.at })),
  };

  appendTrade(record);
  // New evidence exists, so this is the moment to ask whether it changes
  // anything. Awaited rather than fired off: it writes the limits file, and two
  // closes landing together must not race each other into it.
  await runAutoTune().catch((err) =>
    log(`auto-tune pass failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  log(
    `POST-MORTEM ${desk.symbol} ${outcome} ${net === null ? "(settlement unavailable)" : usdShort(net)} · ` +
      `held ${Math.round(record.heldMs / 60_000)} min · best +${record.mfePct.toFixed(3)}% ` +
      `(${(record.peakProgress * 100).toFixed(0)}% of target) · worst ${record.maePct.toFixed(3)}% · ` +
      `${record.exitReason}`,
  );
}

const usdShort = (x: number) => `${x < 0 ? "-" : "+"}$${Math.abs(x).toFixed(2)}`;

/* ----------------------------------------------------- venue constraints */

/**
 * Rejections seen lately, and the contracts the venue has closed to us.
 *
 * Separate from the trade log on purpose. A rejection is not a trade — nothing
 * was risked and nothing was learned about the market — but it is the clearest
 * possible evidence about the *account*, and mixing the two would let a run of
 * refused orders look like a run of losses in every statistic downstream.
 */
const constraints = new ConstraintMemory();

/**
 * Contracts and, at worst, the whole account, stopped by the venue.
 *
 * Held in memory rather than written to the limits file, because every one of
 * these clears when something outside this process is fixed — an agreement
 * signed, a clock synced, a ban expired — and a halt that survived a restart
 * would keep the agent down long after the cause was gone, with no obvious way
 * to tell why.
 */
const halted = new Map<string, { at: number; reason: string; scope: "symbol" | "all" }>();

/**
 * Orders accepted since the last venue rejection.
 *
 * The evidence that a tightened dial is no longer needed. Counted in accepted
 * orders rather than elapsed time because a quiet week proves nothing — the
 * constraint was never tested — while twenty accepted orders is twenty chances
 * for it to have fired.
 */
let acceptedSinceRejection = 0;
const HALT_ALL = "*";

function haltFor(scope: "halt-symbol" | "halt-all", symbol: string, reason: string) {
  const key = scope === "halt-all" ? HALT_ALL : symbol;
  if (halted.has(key)) return;
  halted.set(key, { at: Date.now(), reason, scope: scope === "halt-all" ? "all" : "symbol" });

  if (scope === "halt-all") {
    /*
     * Disarm, rather than merely stopping the loops.
     *
     * A halt-all means a key, a clock or a ban — every signed request will fail
     * identically until a person fixes it. Leaving the agent armed would have
     * it re-attempt on the next signal, and against a rate-limit ban that
     * escalates the ban itself. Disarming also makes the state visible: the
     * button says disarmed, which is true, instead of the agent looking live
     * while nothing it sends can succeed.
     */
    limits = { ...limits, tradingEnabled: false };
    writeLimits(limits);
    stopExecutionLoop();
    log(`!! HALTED — trading disarmed. ${reason}`);
  } else {
    desks.get(symbol)?.runner?.stop();
    if (desks.get(symbol)) desks.get(symbol)!.runner = null;
    log(`!! ${symbol} halted — the venue will not accept orders on it. ${reason}`);
  }
}

const haltReason = (symbol: string) => halted.get(HALT_ALL) ?? halted.get(symbol) ?? null;

/**
 * Persistent adaptation to a constraint that keeps recurring.
 *
 * Distinct from the outcome tuner in what it treats as evidence. A rejection is
 * a fact about the account rather than a sample from a distribution, so this
 * needs no confidence interval and no spacing in trades — but it does need a
 * repeat count, because one margin rejection during a funding settlement is
 * noise and five in six hours is a miscalibration.
 *
 * It writes through the same log and the same bounded-change machinery as the
 * outcome tuner, so there is one audit trail, one history table and one undo
 * button rather than two systems changing the same numbers by different rules.
 */
async function applyConstraintAdaptation(e: ConstraintEvent) {
  const c = classifyConstraint(new Error(`{"code":${e.code}}`));
  if (c.adaptAfter === null) return;
  const seen = constraints.count(e.kind, undefined);
  if (seen < c.adaptAfter) return;
  if (!limits.autoTune) {
    log(
      `${e.kind} has happened ${seen} times — auto-tune is off, so nothing was changed. ` +
        `Turn it on, or adjust the caps by hand.`,
    );
    return;
  }

  const change = constraintChange(e.kind, seen, limits);
  if (!change) return;

  const entry: TuneEntry = { ...change, at: Date.now(), by: "auto", tradesAt: loadTrades().records.length };
  if (!appendTuneChecked(entry)) {
    log(`constraint adaptation declined: could not record the change to ${change.setting}`);
    return;
  }
  limits = { ...limits, [change.setting]: change.to };
  writeLimits(limits);
  // Cleared so the next adaptation needs a fresh run of rejections rather than
  // re-counting the ones this change was meant to fix. Without this the same
  // history would trip the threshold again on the very next rejection and walk
  // the dial to its bound in a handful of orders.
  constraints.clear(e.kind);
  log(`ADAPTED ${change.setting}: ${change.from} → ${change.to} — ${change.reason}`);
}

/** The specific cap that answers each recurring constraint. */
function constraintChange(kind: ConstraintKind, seen: number, now: Limits): TuneChange | null {
  switch (kind) {
    case "margin-short": {
      /*
       * More headroom, not less risk.
       *
       * The tempting answer is to cut riskPerTradePct, and it is the wrong one:
       * the account is not taking too much risk, it is committing too much of
       * its collateral as margin. Cutting risk shrinks the edge to fix an
       * arithmetic problem, and it would have to keep cutting, because the
       * boundary being hit is the *fraction of balance* rather than any
       * absolute size. Raising the headroom moves the boundary and leaves the
       * risk budget alone.
       */
      const to = Math.min(40, Math.round((now.marginHeadroomPct + 5) * 10) / 10);
      if (to <= now.marginHeadroomPct) return null;
      return {
        setting: "marginHeadroomPct" as Tunable,
        from: now.marginHeadroomPct,
        to,
        direction: "safer",
        reason:
          `${seen} margin rejections — ${now.marginHeadroomPct}% of free collateral held back was not ` +
          `enough to cover the opening commission and the venue's margin rounding. At ${to}% the same risk ` +
          `budget produces an order the account can actually fund; the risk per trade is untouched.`,
      };
    }
    case "position-limit":
    case "leverage-bracket": {
      // Binance's brackets cap position size as leverage rises, so the durable
      // fix is the leverage ceiling rather than a one-off smaller order.
      const to = Math.max(3, Math.floor(now.maxLeverage * 0.7));
      if (to >= now.maxLeverage) return null;
      return {
        setting: "maxLeverage" as Tunable,
        from: now.maxLeverage,
        to,
        direction: "safer",
        reason:
          `${seen} rejections for exceeding what Binance allows at ${now.maxLeverage}x. Their brackets ` +
          `tighten the maximum position as leverage rises, so the ceiling comes down to ${to}x — which is ` +
          `where this account's positions were actually being capped anyway.`,
      };
    }
    case "rate-limited": {
      const to = Math.max(2, Math.floor(now.maxTradesPerDay * 0.7));
      if (to >= now.maxTradesPerDay) return null;
      return {
        setting: "maxTradesPerDay" as Tunable,
        from: now.maxTradesPerDay,
        to,
        direction: "safer",
        reason:
          `${seen} rate-limit rejections. The next step after ignoring these is an IP ban that escalates ` +
          `from minutes to days, so the daily order ceiling comes down to ${to}.`,
      };
    }
    case "order-limit": {
      const to = Math.max(1, now.maxOpenPositions - 1);
      if (to >= now.maxOpenPositions) return null;
      return {
        setting: "maxOpenPositions" as Tunable,
        from: now.maxOpenPositions,
        to,
        direction: "safer",
        reason:
          `${seen} rejections for hitting the account's ceiling on resting stop orders. Fewer concurrent ` +
          `positions means fewer brackets, so the ceiling on open positions comes down to ${to}.`,
      };
    }
    /*
     * Everything else is deliberately absent. A notional floor, a precision
     * fault, an unsigned agreement and a drifted clock are all real problems
     * that no cap change repairs, and moving a number in response would hide
     * the cause while leaving the agent quietly smaller for good.
     */
    default:
      return null;
  }
}

/**
 * Relax the headroom again after a long clean run.
 *
 * Adaptation that only ever tightens is a ratchet, and a ratchet driven by
 * transient conditions ends at its bound. A fee-tier change, a larger balance
 * or a symbol switch can all make yesterday's headroom unnecessary, and without
 * this the account would keep committing 40% less collateral than it can afford
 * for the rest of its life because of one bad afternoon.
 *
 * Deliberately slower to loosen than to tighten: five points up on evidence,
 * one point down on the absence of it.
 */
function relaxHeadroom(acceptedSinceLastRejection: number) {
  if (!limits.autoTune) return;
  if (limits.marginHeadroomPct <= DEFAULT_LIMITS.marginHeadroomPct) return;
  if (acceptedSinceLastRejection < 20) return;
  if (constraints.count("margin-short") > 0) return;
  const to = Math.max(DEFAULT_LIMITS.marginHeadroomPct, Math.round((limits.marginHeadroomPct - 1) * 10) / 10);
  const entry: TuneEntry = {
    setting: "marginHeadroomPct" as Tunable,
    from: limits.marginHeadroomPct,
    to,
    direction: "riskier",
    reason: `${acceptedSinceLastRejection} orders accepted with no margin rejection — headroom relaxed to ${to}%`,
    at: Date.now(),
    by: "auto",
    tradesAt: loadTrades().records.length,
  };
  if (!appendTuneChecked(entry)) return;
  limits = { ...limits, marginHeadroomPct: to };
  writeLimits(limits);
  log(`ADAPTED marginHeadroomPct: ${entry.from} → ${to} — ${entry.reason}`);
}

/* --------------------------------------------------------- the tuning loop */

/**
 * The last pass's reasoning, so the page can show why nothing moved.
 *
 * "Nothing changed" is the tuner's normal state and the one an operator is most
 * likely to misread as it being broken. The held-back reasons are the answer,
 * and they are worth as much as the changes.
 */
let lastTuning: { at: number; changes: TuneChange[]; held: string[]; trades: number } = {
  at: 0, changes: [], held: [], trades: 0,
};

/**
 * Re-read the evidence and move at most one cap.
 *
 * Runs on a close rather than on a timer, because a close is the only event
 * that adds evidence. A timer would re-examine the same trades and, with any
 * threshold expressed in wall clock, eventually talk itself into acting on
 * them twice.
 */
async function runAutoTune(apply = true) {
  const { records } = loadTrades();
  const report = analyse(records);
  const { entries } = loadTuning();

  const result = proposeTuning({
    report,
    trades: records,
    limits: {
      breakEvenAtPct: limits.breakEvenAtPct,
      stopLossPct: limits.stopLossPct,
      maxHoldMinutes: limits.maxHoldMinutes,
      riskPerTradePct: limits.riskPerTradePct,
      minRewardRisk: limits.minRewardRisk,
    },
    history: entries,
  });
  lastTuning = { at: Date.now(), changes: result.changes, held: result.held, trades: records.length };

  /*
   * A restart is not new evidence.
   *
   * Startup computes the analysis so the panel has something to show — without
   * it the section is blank until the next close, which on a quiet day is
   * hours — but it does not act. The trades behind any pending change were
   * already on the books before the process went down, and a machine rebooting
   * overnight is not a reason to move a cap that yesterday's evidence did not
   * move. Applying only on a close keeps the rule simple: one change, one
   * batch of new trades that justified it.
   */
  if (!apply || !limits.autoTune) {
    if (result.changes.length > 0) {
      const c = result.changes[0];
      log(
        `tuning would move ${c.setting} ${c.from} → ${c.to} — ` +
          (limits.autoTune ? "held until the next close" : "auto-tune is off, so it is only a suggestion"),
      );
    }
    return;
  }

  for (const change of result.changes) {
    /*
     * The audit entry is written before the value moves.
     *
     * If the log write fails and the change is applied anyway, the next pass
     * sees no history for that setting — no spacing, no hysteresis, no record
     * that a human had touched it — and is free to move it again immediately.
     * A tuner that loses its memory does not become cautious, it becomes
     * unbounded, so a failure to record is a reason not to act.
     */
    const entry: TuneEntry = {
      ...change,
      at: Date.now(),
      by: "auto",
      tradesAt: records.length,
    };
    if (!appendTuneChecked(entry)) {
      log(`tuning declined: could not record the change to ${change.setting}, so it was not applied`);
      continue;
    }
    limits = { ...limits, [change.setting]: change.to };
    writeLimits(limits);
    log(
      `TUNED ${change.setting}: ${change.from} → ${change.to} (${change.direction}) — ${change.reason}`,
    );
  }
}

/**
 * Record an operator edit so the tuner defers to it.
 *
 * Only the settings the tuner can reach are worth recording, and only when the
 * value actually changed — writing an entry for every form submission would
 * make an operator who saves the page without editing anything look like one
 * who just overrode the tuner.
 */
function noteOperatorEdits(before: Limits, after: Limits, tradeCount: number) {
  const watched: Tunable[] = ["breakEvenAtPct", "stopLossPct", "maxHoldMinutes", "riskPerTradePct", "minRewardRisk"];
  for (const setting of watched) {
    const from = before[setting];
    const to = after[setting];
    if (from === to) continue;
    appendTune({
      setting, from, to, at: Date.now(), by: "operator", tradesAt: tradeCount,
      direction: "neutral",
      reason: "set by hand from the control page",
    });
  }
}

/**
 * Sample every open position's excursion from the live feed.
 *
 * Reads the feed's mark rather than the account sweep's, which is a twenty-
 * second-old copy of the same number. Nothing here can throw or block: it is on
 * a one-second timer and a failure would repeat every second forever.
 */
function markExcursions() {
  for (const desk of allDesks()) {
    if (!desk.excursion || !desk.positionOpenedAt) continue;
    const state = desk.feed?.getState();
    const price = state?.mark ?? state?.mid ?? null;
    if (price !== null) desk.excursion.mark(price);
  }
}

/**
 * Which resting order took the position out, from where it ended up.
 *
 * Only used when this process did not ask for the close, which means the
 * bracket did — and the two arms of a bracket need opposite responses, so
 * "closed by something" is not a usable answer. Compared with a tolerance
 * because the trigger price and the fill price are different numbers.
 */
function inferExit(entry: JournalEntry, exitPrice: number): string | null {
  if (!(exitPrice > 0)) return null;
  const near = (a: number, b: number) => Math.abs(a - b) / b < 0.0015;
  if (entry.targetPrice !== null && near(exitPrice, entry.targetPrice)) return "the target filled";
  if (entry.stopPrice != null && near(exitPrice, entry.stopPrice)) return "the stop filled";
  const long = entry.side === "long";
  const moved = long ? exitPrice - entry.entryPrice : entry.entryPrice - exitPrice;
  return moved >= 0 ? "closed in profit by a resting order" : "closed at a loss by a resting order";
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
  /*
   * Does the balance still agree with the ledger the day's caps are read from?
   *
   * A testnet reset puts the wallet back to its starting figure and leaves every
   * income row that came before it in place, so the ledger goes on reporting
   * trades whose money no longer exists. Every cap measured against the day is
   * then wrong in the same direction. Checked here, once per sweep, before
   * anything reads the day.
   */
  const wallet = account.risk?.walletBalance ?? 0;
  if (wallet > 0) {
    try {
      const rec = await reconcileLedger(cfg, wallet);
      ledgerEpoch = rec.epoch;
      if (rec.reset) {
        log(
          `!! account balance no longer matches the ledger — expected ${usdShort(rec.reset.expected)}, ` +
            `wallet says ${usdShort(rec.reset.actual)}. Day counting restarted from now; ` +
            `trades before this are excluded from today's totals.`,
        );
      }
    } catch { /* an unreachable ledger must not stop the account sweep */ }
  }

  for (const desk of allDesks()) {
    try {
      const position = await fetchPosition(cfg, desk.symbol);
      desk.protection = {
        state: await checkProtection(cfg, desk.symbol, position),
        error: null,
        at: Date.now(),
      };
      desk.day = {
        activity: await fetchDayActivity(cfg, desk.symbol, Date.now(), ledgerEpoch.epoch),
        error: null, at: Date.now(),
      };
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
/**
 * Fill in the caps that have no sensible default, once the balance is known.
 *
 * maxPositionUsd and maxDailyLossUsd ship as 0, and 0 max position is a hard
 * refusal on every setup — the safest possible default and a terrible first
 * experience, because the system boots looking healthy and declines everything
 * for a reason that appears nowhere until diagnostics are run. They cannot have
 * static defaults either: the right number is a share of an account whose size
 * is not known until the exchange answers.
 *
 * So they are derived here, once, from the balance and the risk settings that
 * are already in force, and only when they are still unset. Anything the
 * operator has actually chosen is never overwritten — a cap someone set to 500
 * on purpose stays 500 forever, including when the balance grows.
 */
async function deriveUnsetCaps(): Promise<string | null> {
  /*
   * Already done, so a zero from here on is a decision rather than a gap.
   *
   * This is the distinction that was missing, and it cost a live session. A cap
   * of zero meant two different things — "never configured" and "deliberately
   * switched off" — and the deriver could not tell them apart, so every pass
   * re-derived a daily loss budget the operator had deliberately set to zero to
   * collect data. Recording that derivation has happened separates the two: the
   * first pass fills what was never set, and nothing overwrites a choice after.
   */
  /*
   * Two caps, two different meanings of zero, and only one of them is a choice.
   *
   * `maxPositionUsd` at zero is never a valid configuration: the adapter refuses
   * every order before it is sized, so nothing can trade. It is always filled in.
   *
   * `maxDailyLossUsd` at zero is a legitimate and deliberate setting — running
   * without a daily loss budget is how this account is collecting data — so it
   * is only ever derived on a genuinely fresh install. Treating both the same
   * way is what put a $396 loss budget back onto an account that had switched it
   * off on purpose, and then halted trading three stop-outs later.
   */
  const freshInstall = limits.capsDerivedAt === 0;
  const needPosition = !(limits.maxPositionUsd > 0);
  if (!freshInstall && !needPosition) return null;

  /*
   * Wallet balance as the fallback, not only free collateral.
   *
   * availableBalance is what is left after margin, so a position open at the
   * moment this runs makes it small and an account fully committed makes it
   * zero — and a zero here used to mean the caps were silently left at zero,
   * which refuses every subsequent order. The cap being derived is a structural
   * ceiling on the account, so the account's size is the right input.
   */
  const equity = Math.max(account.risk?.availableBalance ?? 0, account.risk?.walletBalance ?? 0);
  if (!(equity > 0)) {
    /*
     * Said out loud, and retried.
     *
     * This returned silently, once, at boot. If the balance was not yet known —
     * a slow first account read, an exchange hiccup, an account reset in
     * progress — the caps stayed at zero, the adapter refused every order with
     * "max position size is not set", and nothing ever tried again or explained
     * why. Trading was over until someone restarted the process.
     */
    return account.risk
      ? `balance reads ${equity} — caps cannot be derived from it yet`
      : `no account data yet (${account.error ?? "not fetched"}) — caps cannot be derived`;
  }

  const next = { ...limits };
  const notes: string[] = [];

  if (needPosition) {
    /*
     * The structural ceiling rather than a second opinion on size.
     *
     * The risk budget already decides how big a position is: at 4% risk and a
     * 0.5% stop it asks for eight times the collateral in notional. This cap
     * sits just above that, at the most the leverage ceiling could fund, so it
     * backstops a sizing bug without quietly becoming the thing that sets size.
     * A cap below the risk budget would truncate every position and make the
     * risk dial mean nothing.
     */
    next.maxPositionUsd = Math.round(equity * limits.maxLeverage);
    notes.push(
      `max position ${next.maxPositionUsd} (${limits.maxLeverage}x the ${equity.toFixed(2)} balance — ` +
        `the ceiling, not the target; the ${limits.riskPerTradePct}% risk budget sizes below it)`,
    );
  }

  /*
   * The daily loss budget is never derived, on any install.
   *
   * It sits alongside the cooldown and the trade ceiling as a rule the operator
   * owns outright, and deriving it is how a 394 USD cap appeared on an account
   * that had switched it off. A cap nobody asked for that silently halts the
   * day is worse than no cap.
   */
  if (false && freshInstall && !(limits.maxDailyLossUsd > 0)) {
    // Three full stop-outs ends the day. At 4% risk that is 12% of the
    // account: past a third of the way to the five-loss run that costs 20%,
    // and early enough that the day can be reviewed rather than salvaged.
    const perTrade = equity * (limits.riskPerTradePct / 100);
    next.maxDailyLossUsd = Math.round(perTrade * 3);
    notes.push(
      `max daily loss ${next.maxDailyLossUsd} (three full stop-outs at ${limits.riskPerTradePct}% each)`,
    );
  }

  next.capsDerivedAt = Date.now();
  limits = next;
  writeLimits(limits);
  if (notes.length === 0) return null;
  log(`caps were unset, so they were derived from the balance: ${notes.join("; ")}`);
  log("change them in Risk limits — from here on a zero is treated as your decision, not a gap.");
  return null;
}

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
          entryLwi: remembered?.entryLwi ?? null,
          reason: remembered?.reason ?? "recovered at startup",
          // Carried forward, never re-derived. The conditions belong to the
          // moment of entry, and the book now is a different book — filling
          // these in from the current state would produce a record that reads
          // as evidence and is fabrication.
          conditions: remembered?.conditions ?? null,
          notionalUsd: remembered?.notionalUsd,
          leverage: remembered?.leverage,
          stopPrice: remembered?.stopPrice ?? state.stop?.stopPrice ?? null,
        });
        /*
         * Resume the excursion from here, flagged as partial.
         *
         * Measured against the original entry so the numbers stay comparable,
         * but marked incomplete: what happened while this process was down is
         * unobserved, and an unobserved stretch is indistinguishable from a
         * motionless one. The analyser is told which it has rather than left to
         * assume.
         */
        desk.excursion = position.entryPrice > 0 ? new Excursion(position.entryPrice, position.positionAmt > 0) : null;
        desk.excursionFromOpen = false;
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
 * The shortest gap between two entries, on any desk.
 *
 * This is a burst guard and nothing more. One market event fires several
 * correlated signals inside a second — a withdrawal, a cluster approach and a
 * liquidation burst are three views of the same thing, not three opportunities
 * — and without a floor the loop would take all three as separate trades.
 *
 * It was previously set to the *loss* cooldown, which was a straight mistake:
 * that rule means "wait after a losing trade", the sizer already enforces it
 * from the exchange's own ledger, and reusing it here applied a loss penalty
 * after every entry including the winners. The visible symptom was a loop that
 * took one trade and then rejected every signal for fifteen minutes while
 * saying so once a second.
 */
const burstGuardMs = () => Math.max(0, limits.burstGuardSec) * 1000;

/**
 * When any desk last accepted an entry.
 *
 * Read from the runners rather than tracked separately. An earlier version kept
 * its own timestamp updated on submission while the runners updated theirs on
 * acceptance, so the two disagreed exactly when an order was accepted and then
 * failed at the exchange — the account-wide gate stayed open while every
 * per-desk gate was shut, which is the worst of both.
 */
function lastAcceptedAnywhere(): number {
  return allDesks().reduce((newest, d) => Math.max(newest, d.runner?.stats().lastAcceptedAt ?? 0), 0);
}

function armDesk(desk: Desk) {
  if (desk.runner) return;
  /*
   * A halted contract is not armed, however the arming was triggered.
   *
   * Checked here rather than only at the call sites because arming happens from
   * several places — the button, a limits save, a restart — and a halt that
   * only one of them respected would come back the first time any other ran.
   */
  const halt = haltReason(desk.symbol);
  if (halt) {
    log(`cannot arm ${desk.symbol}: ${halt.reason}`);
    return;
  }
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
        config: { riskFraction: limits.riskPerTradePct / 100, fees, canPostEntries: true, derateStrength: limits.sizeDerateStrength, minRewardOverFees: limits.minRewardOverFees },
      });
      if (!proposal.ok) {
        desk.lastRefusal = { at: Date.now(), reason: proposal.reasons.join("; ") };
        for (const one of proposal.reasons) tallyRefusal(desk, one);
        log(`sizer declined (${desk.symbol}): ${proposal.reasons.join("; ")}`);
        return null;
      }
      desk.pendingTarget = proposal.targetPrice;
      // The depth that justified the entry, kept so "has the book refilled"
      // can be answered later against the reading that actually mattered.
      desk.pendingEntryLwi =
        _intent.side === "buy" ? (state.liquidity?.lwiAskAdj ?? null) : (state.liquidity?.lwiBidAdj ?? null);
      /*
       * Freeze the whole reading, not just the two fields the exits need.
       *
       * Captured here rather than when the fill lands because this is the state
       * the decision was made against, and by the time the order is
       * acknowledged the book has already moved on. Recording the post-fill
       * state would be recording the consequence of the trade and filing it as
       * the reason for it — an error that gets more convincing the faster the
       * strategy is, which is exactly backwards.
       */
      desk.pendingConditions = captureConditions(state, proposal.side, {
        news: newsFor(desk.symbol, 20).map((n) => ({ at: n.at, impact: n.impact })),
        targetPrice: proposal.targetPrice,
        biasConviction: _intent.confidence,
        signalKind: _intent.signalKind,
        sizeRetained: proposal.sizeRetained,
      });
      desk.pendingStopPrice = proposal.stopPrice;
      desk.pendingNotional = proposal.notionalUsd;
      desk.pendingLeverage = proposal.leverage;
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
        const long = r.entry?.side === "BUY";
        /*
         * The same fallback the excursion below already uses, applied to the
         * journal itself.
         *
         * `avgPrice` is 0 on the immediate response to a market order, so the
         * journal recorded 0 as the entry price of every taker entry. That is
         * the field `rMultiple` and `stopDistPct` both refuse to work without,
         * which is why expectancy ran on 2 of 27 trades and why every loss was
         * filed as a patience problem. The mark is within a spread of the truth
         * and is replaced by Binance's own average fill price on the next
         * position sweep; 0 is replaced by nothing and poisons everything
         * derived from it.
         */
        const markAtOpen = desk.feed?.getState().mark ?? desk.feed?.getState().mid ?? 0;
        const entryPrice = r.entry?.avgPrice || markAtOpen;
        journalOpen(desk.symbol, {
          openedAt: Date.now(),
          side: long ? "long" : "short",
          entryPrice,
          targetPrice: desk.pendingTarget,
          stopPct: limits.stopLossPct,
          entryLwi: desk.pendingEntryLwi,
          reason: r.detail.slice(0, 200),
          conditions: desk.pendingConditions,
          notionalUsd: desk.pendingNotional ?? undefined,
          leverage: desk.pendingLeverage ?? undefined,
          stopPrice: desk.pendingStopPrice,
        });
        desk.positionOpenedAt = Date.now();
        /*
         * The fill price when there is one, the live mark when there is not.
         *
         * Measuring against the price actually paid is right, and depending on
         * it being present was wrong. A market order's immediate response
         * carries avgPrice 0 — the fill is reported asynchronously — so this
         * condition was false on every taker entry and the tracker was never
         * created. The consequence was silent and total: MAE and MFE were
         * written as 0 on all 55 trades of a weekend, `excursionComplete` was
         * false on all of them, and the loss anatomy classified 100% of losses
         * as "unclassified" because the two numbers it reasons from were
         * fabricated zeros.
         *
         * Falling back to the mark costs at most the spread in accuracy and
         * buys the entire excursion. Binance's own average fill price replaces
         * it on the next position sweep — which is now true of the journal as
         * well, rather than only of this tracker.
         */
        desk.excursion = entryPrice > 0 ? new Excursion(entryPrice, !!long) : null;
        desk.excursionFromOpen = !!desk.excursion;
        if (!desk.excursion) {
          log(`!! ${desk.symbol}: no price to track the excursion from — MAE/MFE will be blank for this trade`);
        }
        desk.exitIntent = null;
        desk.scaledOut = 0;
        desk.targetRolls = 0;
        desk.profit = null;
        acceptedSinceRejection++;
        relaxHeadroom(acceptedSinceRejection);
      }
      log(`execution ${desk.symbol} ${r.outcome}: ${explainError(r.detail, desk.symbol)}`);
    },
    onConstraint: (e) => {
      constraints.record(e);
      acceptedSinceRejection = 0;
      // Counted first, then acted on: the adaptation reads the count, so a
      // rejection has to be on the books before it can be the one that tips a
      // threshold.
      void applyConstraintAdaptation(e);
    },
    onHalt: (scope, symbol, reason) => haltFor(scope, symbol, reason),
  });

  desk.runner = attachExecution(feed, {
    adapter,
    minIntervalMs: burstGuardMs(),
    /*
     * A burst ceiling, not the daily cap.
     *
     * The daily cap is enforced by the sizer against Binance's own ledger of
     * closed trades, which survives a restart; this only stops one unusual hour
     * spending the whole day's budget before the ledger catches up. A third of
     * the day, floored at two so a small cap does not become a one-trade-per-
     * hour rule.
     */
    /*
     * Derived from the daily cap, and off when the daily cap is off.
     *
     * This was `Math.max(2, ceil(maxTradesPerDay / 3))`, so switching the daily
     * cap off — which this account did deliberately, to collect data — floored
     * the hourly ceiling at 2. Turning one limit off made a different limit
     * maximally tight, and it refused 5,280 of 6,855 signals in a single
     * session while every diagnostic reported the agent as healthy.
     */
    maxPerHour: limits.maxTradesPerDay > 0 ? Math.max(2, Math.ceil(limits.maxTradesPerDay / 3)) : 0,
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
      const lastEntry = lastAcceptedAnywhere();
      const sinceEntry = Date.now() - lastEntry;
      if (burstGuardMs() > 0 && lastEntry > 0 && sinceEntry < burstGuardMs()) {
        desk.runner?.noteDecline(
          `another contract just entered — ${Math.ceil((burstGuardMs() - sinceEntry) / 1000)}s of burst guard left`,
        );
        return null;
      }

      const bias = directionalBias(state, { dislocation: dislocationFor(desk.symbol), deadZone: limits.biasDeadZone });
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
        config: { riskFraction: limits.riskPerTradePct / 100, fees, canPostEntries: true, derateStrength: limits.sizeDerateStrength, minRewardOverFees: limits.minRewardOverFees },
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
        // So a live row and a shadow row carry the same decomposition of the
        // one reading that picks the side.
        bias: { composite: bias.composite, conviction: bias.conviction, factors: bias.factors },
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
      config: { riskFraction: limits.riskPerTradePct / 100, fees, canPostEntries: true, derateStrength: limits.sizeDerateStrength, minRewardOverFees: limits.minRewardOverFees },
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

/**
 * Whether pressing Start trading would actually do anything.
 *
 * Every one of these is reported somewhere already, and that was the problem:
 * spread across a diagnostics panel, a health dot and a refusal tally, none of
 * which answers the only question being asked before arming. The failure this
 * prevents is arming a system that looks healthy and then declines every setup
 * for a reason that was knowable beforehand.
 *
 * Ordered by what has to be true first, so the first blocker listed is the one
 * to fix — a cold depth baseline behind missing credentials is not worth
 * mentioning yet.
 */
function readiness() {
  const blockers: string[] = [];
  const waiting: string[] = [];

  if (!hasCredentials()) {
    blockers.push("no API credentials — this is monitor-only until BINANCE_API_KEY and BINANCE_API_SECRET are set");
  } else {
    if (account.risk === null) {
      blockers.push(`the exchange is not answering${account.error ? ` — ${account.error}` : ""}`);
    }
    if (orderable.symbols) {
      const missing = SYMBOLS.filter((x) => !orderable.symbols!.has(x));
      if (missing.length) blockers.push(`${missing.join(", ")} cannot be traded at ${orderable.venue}`);
    }
    if (!(limits.maxPositionUsd > 0)) blockers.push("max position is 0, which refuses every setup");
  }

  // The structural check that produced a silent, permanent zero once already.
  const need = limits.stopLossPct * (limits.minRewardRisk > 0 ? limits.minRewardRisk : 1.5);
  if (need > CONFIG.clusterRangePct) {
    blockers.push(
      `a ${limits.stopLossPct}% stop at ${limits.minRewardRisk} reward-to-risk needs a level ` +
        `${need.toFixed(1)}% away, and levels are only mapped to ±${CONFIG.clusterRangePct}% — nothing can ever qualify`,
    );
  } else {
    const roundTripPct = (fees.tiers[0]?.takerRate ?? 0.0005) * 2 * 100;
    if (need < roundTripPct * limits.minRewardOverFees) {
      blockers.push(
        `a ${limits.stopLossPct}% stop asks for a ${need.toFixed(2)}% move, but the round trip costs about ` +
          `${roundTripPct.toFixed(2)}% — the reward cannot clear the fees, so every setup is refused. ` +
          `The stop needs to be at least ${((roundTripPct * limits.minRewardOverFees) / Math.max(limits.minRewardRisk, 0.1)).toFixed(2)}%.`,
      );
    }
  }

  for (const d of allDesks()) {
    if (!d.feed) { waiting.push(`${d.symbol}: engine stopped`); continue; }
    const st = d.feed.getState();
    if (!st.health.tradeable) waiting.push(`${d.symbol}: ${st.health.summary}`);
    else if (st.liquidity && !st.liquidity.warm) waiting.push(`${d.symbol}: depth baseline still warming (about 10 min)`);
  }

  const ready = blockers.length === 0 && waiting.length === 0;
  return {
    ready,
    armed: limits.tradingEnabled,
    blockers,
    waiting,
    summary: blockers.length
      ? blockers[0]
      : waiting.length
        ? waiting[0]
        : limits.tradingEnabled
          ? "armed — orders go out when a setup passes every check"
          : "ready — press Start trading",
  };
}

function status() {
  const desk = focused();
  const state = desk.feed?.getState() ?? null;
  const creds = hasCredentials();
  let mode: "none" | "testnet" | "live" = "none";
  if (creds) mode = process.env.BINANCE_LIVE === "1" ? "live" : "testnet";

  /*
   * Where every number on this page came from.
   *
   * Added after a session spent looking at a balance that did not match the
   * wallet on screen and a ticker that was not the one being tested. Both had
   * the same shape: the page showed a value without showing which account or
   * which contract produced it, so there was no way to tell a wrong number from
   * a right number about something else. A figure whose provenance is invisible
   * cannot be checked, and one that cannot be checked will eventually be
   * trusted when it should not be.
   *
   * `venue` is the actual host being signed against rather than a label derived
   * from it, so switching BINANCE_LIVE can never leave the two disagreeing.
   * `wallet` names which balance this is, because the USDⓈ-M futures wallet and
   * the spot wallet are different money and the demo site shows both.
   * `staleFor` exists so a frozen number reads as frozen instead of current.
   */
  const cfgNow = creds ? (() => { try { return loadConfig(); } catch { return null; } })() : null;
  const provenance = {
    venue: cfgNow?.baseUrl ?? "not configured",
    live: cfgNow?.live ?? false,
    wallet: "USDⓈ-M futures",
    // Milliseconds since the account was last read successfully. The account
    // sweep runs every 20s, so anything past a minute means reads are failing.
    staleForMs: account.at > 0 ? Date.now() - account.at : null,
    /*
     * What is actually being watched, not what the environment once said.
     *
     * These read the env-derived SYMBOLS constant, which stopped being the
     * source of truth when the contract picker started writing the watched list
     * to disk. The page ended up warning "no symbol was set, so this defaulted
     * to INTCUSDT" and "configured INTCUSDT but running BTCUSDT" on a server
     * that was watching exactly the contract it had been told to — two alarming
     * banners describing a problem that did not exist, on the page whose whole
     * job is to be trustworthy about what it is doing.
     */
    symbolsConfigured: allDesks().map((d) => d.symbol),
    symbolsRunning: allDesks().filter((d) => d.feed).map((d) => d.symbol),
    focus,
    /** Only when nothing chose them: no picker file, no environment variable. */
    symbolsAreDefault:
      !existsSync(symbolsPath()) &&
      !process.env.SWEEP_SYMBOLS?.trim() &&
      !process.env.SWEEP_SYMBOL?.trim(),
  };

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
        notReady: acc.notReady + s.notReady,
        lastAcceptedAt: Math.max(acc.lastAcceptedAt, s.lastAcceptedAt),
      };
    },
    { seen: 0, accepted: 0, rejected: 0, declined: 0, notReady: 0, lastAcceptedAt: 0 },
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
    readiness: readiness(),
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
    provenance,
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
          /*
           * Where the count starts, so "today" is never silently something
           * other than today. After a reset it is hours into the day, and a
           * P&L figure covering a different window than its label claims is
           * the kind of wrong that gets believed.
           */
          countingFrom: ledgerEpoch.epoch,
          rebased: ledgerEpoch.epoch > startOfDayUtc(),
          rebaseReason: ledgerEpoch.reason,
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
      targetPrice: desk.protection.state?.takeProfit?.stopPrice ?? null,
      targetDistancePct: desk.protection.state?.targetDistancePct ?? null,
      entryPrice: desk.protection.state?.position?.entryPrice ?? null,
      markPrice: desk.protection.state?.position?.markPrice ?? null,
      side: desk.protection.state?.position
        ? desk.protection.state.position.positionAmt > 0 ? "long" : "short"
        : null,
      heldMin: desk.positionOpenedAt ? Math.round((Date.now() - desk.positionOpenedAt) / 60_000) : 0,
      ratcheted: desk.ratchetedAt > 0,
      hold: desk.hold,
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

  /*
   * The command reference, on its own page.
   *
   * Separate rather than another panel because it is the one thing here that is
   * read when nothing is running — a panel on the dashboard is invisible
   * exactly when it is needed, since the dashboard is what you have open only
   * once the server is already up.
   */
  if (url.pathname === "/commands") {
    send(res, 200, commandsPage(TOKEN), "text/html; charset=utf-8");
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

      /*
       * The watched list, and the exchange's own catalogue to pick from.
       *
       * Both in one response because the page needs them together: a chip row
       * of what is running, and a search that can only offer contracts that
       * actually exist. Splitting them would let the two disagree, which is how
       * a picker offers a symbol the adder then refuses.
       */
      case "GET /api/symbols": {
        const q = url.searchParams.get("q") ?? "";
        const catalog = await loadCatalog();
        const watched = allDesks().map((d) => {
          const entry = findContract(catalog, d.symbol);
          const pos = d.protection.state?.position;
          return {
            symbol: d.symbol,
            calibrated: isCalibrated(d.symbol),
            running: d.feed !== null,
            armed: d.runner !== null,
            focused: d.symbol === focus,
            holding: pos ? pos.positionAmt : 0,
            orderable: entry?.orderable ?? null,
            volumeUsd: entry?.volumeUsd ?? null,
            listed: entry !== null,
          };
        });
        send(res, 200, {
          watched,
          max: MAX_SYMBOLS,
          path: symbolsPath(),
          orderVenue: catalog.orderVenue,
          catalogError: catalog.error,
          catalogSize: catalog.entries.length,
          // Only when asked for. The full list is ~500 contracts and the page
          // polls this endpoint for the chip row on a timer.
          results: q
            ? searchCatalog(catalog, q, 18).map((e) => ({
                symbol: e.symbol,
                baseAsset: e.baseAsset,
                kind: e.kind,
                lastPrice: e.lastPrice,
                changePct: e.changePct,
                volumeUsd: e.volumeUsd,
                orderable: e.orderable,
                calibrated: isCalibrated(e.symbol),
                watched: desks.has(e.symbol),
              }))
            : [],
        });
        return;
      }

      case "POST /api/ledger/rebase": {
        // The automatic check catches a reset within one account sweep, but a
        // deposit or withdrawal the operator made deliberately is *explained* by
        // a ledger row and correctly leaves the epoch alone. This is for the
        // case where they know the history is meaningless and the arithmetic
        // does not.
        const wallet = account.risk?.walletBalance ?? 0;
        ledgerEpoch = rebaseNow(wallet);
        log(`day counting restarted by hand at a wallet balance of ${usdShort(wallet)}`);
        await refreshAccount();
        send(res, 200, { ok: true, epoch: ledgerEpoch });
        return;
      }

      /*
       * The thread, merged from both directions.
       *
       * Read on a timer by the page, so a reply that arrived over git shows up
       * without anyone refreshing anything.
       */
      case "GET /api/messages":
        send(res, 200, { thread: thread(60), repliesFrom: repliesPath() });
        return;

      case "POST /api/messages": {
        const body = await readJson(req);
        const desk2 = focused();
        const st = desk2?.feed?.getState();
        const pos = desk2?.protection.state?.position;
        // The state at the moment of writing, because a note saying "this looked
        // wrong" is close to useless a day later without it.
        const r = appendNote(typeof body.text === "string" ? body.text : "", {
          symbol: desk2?.symbol ?? null,
          mid: st?.mid ?? null,
          armed: limits.tradingEnabled,
          holding: pos ? pos.positionAmt : 0,
        });
        if (r.ok) log(`note from you: ${String(body.text).slice(0, 160)}`);
        send(res, 200, { ...r, thread: thread(60) });
        return;
      }

      case "POST /api/symbols/add": {
        const body = await readJson(req);
        const result = await addDesk(typeof body.symbol === "string" ? body.symbol : "");
        send(res, 200, result);
        return;
      }

      case "POST /api/symbols/remove": {
        const body = await readJson(req);
        send(res, 200, removeDesk(typeof body.symbol === "string" ? body.symbol : ""));
        return;
      }

      case "POST /api/focus": {
        const body = await readJson(req);
        const next = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
        if (!desks.has(next)) {
          send(res, 200, { error: `${next || "(none)"} is not being watched` });
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
        const before = limits;
        limits = {
          /*
           * Saving the form marks the caps derived, whatever is in it.
           *
           * The operator has now looked at these numbers and pressed save, so a
           * zero in the field is a decision. Without this the deriver would put
           * a daily loss budget back the moment it saw a zero, which is exactly
           * the setting most likely to be zeroed on purpose.
           */
          capsDerivedAt: limits.capsDerivedAt || Date.now(),
          desiredAppliedAt: limits.desiredAppliedAt,
          burstGuardSec: n("burstGuardSec", limits.burstGuardSec),
          biasDeadZone: n("biasDeadZone", limits.biasDeadZone),
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
          // Floored at 1.2: below that the venue takes most of the move and the
          // break-even hit rate climbs past anything this has ever measured.
          minRewardOverFees: Math.min(10, Math.max(1.2, n("minRewardOverFees", limits.minRewardOverFees))),
          autoTune: typeof body.autoTune === "boolean" ? body.autoTune : limits.autoTune,
          marginHeadroomPct: Math.min(50, Math.max(0, n("marginHeadroomPct", limits.marginHeadroomPct))),
          trailArmsAtR: Math.min(10, Math.max(0, n("trailArmsAtR", limits.trailArmsAtR))),
          scaleOutAtR: Math.min(10, Math.max(0, n("scaleOutAtR", limits.scaleOutAtR))),
          scaleOutFraction: Math.min(90, Math.max(0, n("scaleOutFraction", limits.scaleOutFraction))),
        };
        writeLimits(limits);
        // Written to the tuning log so the tuner sees a human touched these and
        // leaves them alone for a while. Without it, a value set by hand can be
        // overridden by the next close, which teaches an operator that changing
        // anything here is pointless.
        noteOperatorEdits(before, limits, loadTrades().records.length);
        // Same reason as the revert: the pending change was computed against
        // the old numbers and is stale the moment they move.
        await runAutoTune(false).catch(() => {});
        log(`limits updated: ${JSON.stringify(limits)}`);
        // Arming and disarming take effect immediately rather than at restart.
        if (limits.tradingEnabled) startExecutionLoop();
        else stopExecutionLoop();
        send(res, 200, status());
        return;
      }

      case "POST /api/bracket": {
        /*
         * Move the stop or the target on a position that is already open.
         *
         * The brackets are placed and maintained automatically, and that is the
         * right default — the whole point is not having to watch. But automatic
         * is not the same as unchangeable, and an operator looking at a level
         * the model cannot see should be able to act on it in one place rather
         * than switching to Binance's own interface, which is where mistakes
         * with position sizes get made.
         *
         * Every interlock that makes the automatic path safe applies here.
         * New order first, old one second, so a rejected move leaves the
         * original resting rather than uncovering the position. A stop on the
         * wrong side of mark is refused outright instead of filling instantly
         * at market. And a moved target is written to the journal, so the
         * maintenance sweep and the break-even ratchet both measure against the
         * level actually resting rather than the one the sizer chose.
         */
        if (!hasCredentials()) { send(res, 200, { error: "no API credentials" }); return; }
        const body = await readJson(req);
        const desk = deskFor(body.symbol);
        const symbol = desk.symbol;
        const cfg2 = loadConfig();
        const precision = metaFor(symbol)?.pricePrecision ?? 2;

        try {
          const pos = await fetchPosition(cfg2, symbol);
          if (!pos) { send(res, 200, { error: `flat on ${symbol} — nothing to adjust` }); return; }
          const current = await checkProtection(cfg2, symbol, pos);
          const long = pos.positionAmt > 0;
          const done: string[] = [];

          const wantStop = Number(body.stopPrice);
          if (Number.isFinite(wantStop) && wantStop > 0) {
            if (long ? wantStop >= pos.markPrice : wantStop <= pos.markPrice) {
              send(res, 200, {
                error: `a ${long ? "long" : "short"} stop must sit ${long ? "below" : "above"} the mark ` +
                  `(${pos.markPrice}) — at ${wantStop} it would fill immediately at market`,
              });
              return;
            }
            const placed = await placeProtectiveStop(cfg2, symbol, pos, wantStop, precision);
            if (current.stop) {
              await cancelOrder(cfg2, symbol, current.stop.orderId, current.stop.isAlgo).catch(() => {});
            }
            // Cancels the ratchet: the operator has made this decision by hand,
            // and having the machine move the stop back underneath them is the
            // opposite of an override.
            desk.ratchetedAt = Date.now();
            done.push(`stop moved to ${placed.stopPrice}`);
          }

          const wantTarget = Number(body.targetPrice);
          if (Number.isFinite(wantTarget) && wantTarget > 0) {
            if (long ? wantTarget <= pos.markPrice : wantTarget >= pos.markPrice) {
              send(res, 200, {
                error: `a ${long ? "long" : "short"} target must sit ${long ? "above" : "below"} the mark ` +
                  `(${pos.markPrice}) — at ${wantTarget} it would fill immediately at market`,
              });
              return;
            }
            const placed = await placeTakeProfit(cfg2, symbol, pos, wantTarget, precision);
            if (current.takeProfit) {
              await cancelOrder(cfg2, symbol, current.takeProfit.orderId, current.takeProfit.isAlgo).catch(() => {});
            }
            const j = journal[symbol];
            journalOpen(symbol, {
              openedAt: j?.openedAt ?? desk.positionOpenedAt ?? Date.now(),
              side: long ? "long" : "short",
              entryPrice: pos.entryPrice,
              targetPrice: wantTarget,
              stopPct: limits.stopLossPct,
              entryLwi: j?.entryLwi ?? null,
              reason: `${j?.reason ?? "manual"} · target moved by hand`,
            });
            desk.targetFailures = 0;
            done.push(`target moved to ${placed.stopPrice}`);
          }

          if (done.length === 0) { send(res, 200, { error: "nothing to change" }); return; }
          log(`MANUAL BRACKET ${symbol}: ${done.join("; ")}`);
          await refreshAccount();
          send(res, 200, { ok: true, moved: done.join("; "), ...status() });
        } catch (err) {
          const message = explainError(err instanceof Error ? redact(err.message) : String(err), symbol);
          log(`manual bracket ${symbol} FAILED: ${message}`);
          send(res, 200, { error: message });
        }
        return;
      }

      case "POST /api/limits/reset": {
        /*
         * Back to the values that were derived rather than chosen.
         *
         * Every one came out of the same week of real trades, and any of them
         * can be edited afterwards — the point is that a known state exists to
         * return to. Without one, a session of tired edits leaves a
         * configuration nobody can reconstruct, producing a failure that looks
         * like a quiet market rather than like a setting.
         *
         * Deliberately disarms. This changes what every future order looks
         * like, and resuming trading on a configuration nobody has read yet is
         * exactly the decision this program refuses to make on its own.
         */
        limits = {
          ...DEFAULT_LIMITS,
          // The account's numbers rather than the strategy's, so they are
          // recomputed from the live balance instead of reset to a zero that
          // would refuse everything.
          maxPositionUsd: 0,
          maxDailyLossUsd: 0,
          // Cleared so the derivation runs again — this is the one path that is
          // *supposed* to overwrite whatever is there.
          capsDerivedAt: 0,
          tradingEnabled: false,
        };
        writeLimits(limits);
        stopExecutionLoop();
        /*
         * Reported rather than assumed.
         *
         * This used to call the deriver and send back a status regardless of
         * whether it had done anything. When the balance was unavailable the
         * deriver returned silently, the caps stayed at zero, and the page
         * showed a successful reset with empty caps and no trading — which is
         * what "reset isn't working" looked like from the outside.
         */
        const problem = await deriveUnsetCaps();
        if (problem) log(`reset: caps could not be derived — ${problem}`);
        log(`limits reset to the derived defaults: ${JSON.stringify(limits)}`);
        // The problem is handed back so the page can say why the caps are still
        // empty rather than reporting a successful reset that changed nothing.
        send(res, 200, { ...status(), capsProblem: problem });
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
        const bias = directionalBias(state, { dislocation: dislocationFor(desk.symbol), deadZone: limits.biasDeadZone });
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
          config: { riskFraction: limits.riskPerTradePct / 100, fees, canPostEntries: true, derateStrength: limits.sizeDerateStrength, minRewardOverFees: limits.minRewardOverFees },
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
          const explained = explainError(message, symbol);
          log(`MANUAL ORDER failed (${symbol}): ${explained}`);
          send(res, 200, { error: explained });
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
          const explained = explainError(message, symbol);
          log(`EXIT TEST failed (${symbol}): ${explained}`);
          send(res, 200, { error: explained });
        }
        return;
      }

      case "POST /api/close-limit": {
        if (!hasCredentials()) { send(res, 200, { error: "no API credentials" }); return; }
        const body = await readJson(req);
        const desk2 = deskFor(body.symbol);
        const price = Number(body.price);
        if (!(price > 0)) { send(res, 200, { error: "a limit price above zero is required" }); return; }
        try {
          const m = metaFor(desk2.symbol);
          const out = await closePositionAtLimit(
            loadConfig(), desk2.symbol, price,
            m?.quantityPrecision ?? 0, m?.pricePrecision ?? 2,
          );
          log(`MANUAL CLOSE (limit): ${desk2.symbol} ${out.reason}`);
          await refreshAccount();
          send(res, 200, { ok: true, ...out, ...status() });
        } catch (err) {
          const message = err instanceof Error ? redact(err.message) : String(err);
          log(`limit close failed (${desk2.symbol}): ${message}`);
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
        /*
         * Zero means no limit, the same as everywhere else in this file.
         *
         * The fourth instance of this bug, and the most expensive: with the cap
         * at 0 and no position open, `0 >= 0` is true, so the account read as
         * permanently at its maximum. The execution loop never attached, the
         * self-check reported "not attached" with no cause, and 413 signals
         * were seen with 0 accepted while the agent looked armed and healthy.
         * The guard eleven hundred lines above already reads it correctly.
         */
        if (limits.maxOpenPositions > 0 && (account.risk?.openPositions.length ?? 0) >= limits.maxOpenPositions) {
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

      case "GET /api/diagnose":
        send(res, 200, diagnose());
        return;

      case "GET /api/log": {
        const since = Number(new URL(req.url ?? "", "http://x").searchParams.get("since") ?? 0);
        send(res, 200, { lines: logLines.filter((l) => l.t > since).slice(-200), now: Date.now() });
        return;
      }

      case "GET /api/learn": {
        /*
         * The post-mortem, computed on demand rather than kept in memory.
         *
         * Reading the whole log every poll is deliberate: it is a few hundred
         * lines, the alternative is a cached summary that can silently disagree
         * with the file, and a learning surface that shows something other than
         * what is on disk is worse than no learning surface.
         */
        const { records, skipped, path } = loadTrades();
        const only = url.searchParams.get("symbol");
        const trades = only && only !== "all" ? records.filter((t) => t.symbol === only) : records;
        const report = analyse(trades);
        send(res, 200, {
          path,
          skipped,
          total: records.length,
          report: {
            n: report.n,
            wins: report.wins,
            winRate: report.winRate,
            winLo: report.winLo,
            winHi: report.winHi,
            expectancyR: report.expectancyR,
            netUsd: report.netUsd,
            anatomy: report.anatomy,
            // Only the ones with something to show; the full list is on the CLI.
            splits: report.splits.slice(0, 10),
            caveats: report.caveats,
          },
          recommendations: recommendations(report, {
            breakEvenAtPct: limits.breakEvenAtPct,
            stopLossPct: limits.stopLossPct,
            maxHoldMinutes: limits.maxHoldMinutes,
            riskPerTradePct: limits.riskPerTradePct,
          }),
          recent: trades.slice(-12).reverse().map((t) => ({
            at: t.closedAt,
            symbol: t.symbol,
            side: t.side,
            outcome: t.outcome,
            pnl: t.realisedPnlUsd,
            heldMin: Math.round(t.heldMs / 60_000),
            mfePct: t.mfePct,
            maePct: t.maePct,
            peakProgress: t.peakProgress,
            regime: t.entryConditions.participantRegime,
            sweepShare: t.entryConditions.sweepShare,
            exitReason: t.exitReason,
            kind: t.outcome === "loss" ? classifyLoss(t).kind : null,
          })),
        });
        return;
      }

      case "GET /api/constraints": {
        send(res, 200, {
          headroomPct: limits.marginHeadroomPct,
          summary: constraints.summary(),
          recent: constraints.recent(15),
          halted: [...halted.entries()].map(([key, v]) => ({
            symbol: key === HALT_ALL ? "all contracts" : key,
            ...v,
          })),
          acceptedSince: acceptedSinceRejection,
        });
        return;
      }

      case "POST /api/constraints/clear": {
        /*
         * Resume after the cause has been fixed outside this process.
         *
         * Every halt here is waiting on something a person does elsewhere — a
         * signature, a clock, a ban expiring — so the agent cannot know when it
         * is over and must not guess. Without this the only way back is a
         * restart, which also throws away the trade context and the excursion
         * trackers of anything still open.
         *
         * The rejection history is cleared with it: keeping counts accumulated
         * before the fix would have the next stray rejection trip a threshold
         * that the fix already answered.
         */
        const body = await readJson(req);
        const which = String(body.symbol ?? "").toUpperCase();
        if (which === "ALL" || which === "") {
          halted.clear();
          constraints.clear();
          log("halts cleared by hand — re-arm when ready");
        } else {
          halted.delete(which);
          log(`halt cleared for ${which} — re-arm when ready`);
        }
        send(res, 200, status());
        return;
      }

      case "GET /api/tuning": {
        const { entries, path } = loadTuning();
        send(res, 200, {
          enabled: limits.autoTune,
          path,
          at: lastTuning.at,
          trades: lastTuning.trades,
          // What it would do right now, whether or not it is allowed to.
          pending: lastTuning.changes,
          held: lastTuning.held,
          bounds: BOUNDS,
          history: entries.slice(-25).reverse(),
        });
        return;
      }

      case "POST /api/tuning/enable": {
        /*
         * Its own endpoint, for exactly the reason arming has one.
         *
         * POST /api/limits reads `tradingEnabled` as `body.tradingEnabled ===
         * true`, so a partial body disarms trading as a side effect. Toggling
         * auto-tune through that form would therefore stop the agent every time
         * — a switch whose label says one thing and whose effect includes
         * another. Same class of bug as the requireCashOpen one this codebase
         * already carries a note about.
         */
        const body = await readJson(req);
        limits = { ...limits, autoTune: body.enabled === true };
        writeLimits(limits);
        log(`auto-tune ${limits.autoTune ? "ON — the next close can move a cap" : "off — changes are only suggested"}`);
        if (limits.autoTune) await runAutoTune().catch(() => {});
        send(res, 200, status());
        return;
      }

      case "POST /api/tuning/revert": {
        /*
         * Put one setting back where it was before the tuner last moved it.
         *
         * The undo has to exist for the automation to be acceptable at all: the
         * operator needs a way to disagree that is as fast as the tuner's way of
         * acting. Only auto changes are reverted — an operator entry in the log
         * is a decision, not something to be rolled back by a button.
         *
         * Recorded as an operator change rather than silently, which also
         * triggers the deference window: reverting says "not this", and the
         * tuner immediately re-applying it would be the worst possible answer.
         */
        const body = await readJson(req);
        const setting = String(body.setting ?? "") as Tunable;
        if (!(setting in BOUNDS)) {
          send(res, 400, { error: `${setting || "that setting"} is not one the tuner can change` });
          return;
        }
        const { entries } = loadTuning();
        const last = entries.filter((e) => e.setting === setting && e.by === "auto").pop();
        if (!last) {
          send(res, 400, { error: `the tuner has not changed ${setting}, so there is nothing to undo` });
          return;
        }
        const current = (limits as unknown as Record<string, number>)[setting];
        appendTune({
          setting, from: current, to: last.from, at: Date.now(), by: "operator",
          tradesAt: loadTrades().records.length, direction: "neutral",
          reason: `reverted by hand — the tuner had moved it ${last.from} → ${last.to}`,
        });
        limits = { ...limits, [setting]: last.from };
        writeLimits(limits);
        log(`REVERTED ${setting}: ${current} → ${last.from} (undoing an auto-tune)`);
        // Recompute, or the panel keeps showing the change that was just undone
        // as still pending — which reads as the tuner announcing it will do the
        // same thing again the moment you disagreed with it.
        await runAutoTune(false).catch(() => {});
        send(res, 200, status());
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

        const newsStat = newsPoller?.status();
        const newsBeat = readHeartbeat("sweep-news");
        send(res, 200, {
          news: {
            // Whoever owns it: this process, or a standalone poller.
            collecting: Boolean(newsStat) || externalNewsRunning(),
            inProcess: Boolean(newsStat),
            sources: newsStat?.sources ?? Number(newsBeat.stats.sources ?? 0),
            recorded: newsStat?.recorded ?? Number(newsBeat.stats.recorded ?? 0),
            errors: String(newsStat?.errors ?? newsBeat.stats.errors ?? ""),
            velocity: String(newsStat?.velocity ?? newsBeat.stats.velocity ?? ""),
            unavailable: String(newsStat?.unavailable ?? newsBeat.stats.unavailable ?? ""),
            latest: newsFor(SYMBOLS[0] ?? "BTCUSDT", 6).map((n) => ({
              at: n.at, headline: n.headline, impact: n.impact, source: n.source,
            })),
          },
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

/**
 * A port already in use, said in English.
 *
 * Node's default is an unhandled 'error' event and a stack trace, which is a
 * poor way to tell someone the thing they wanted is already running. It is also
 * the single most likely first-run failure: this program is left open in a
 * terminal for hours, and the natural way to pick up new code is to start it
 * again in a second window.
 *
 * Starting anyway on another port would be worse than failing. Two control
 * servers against one account both reconcile the same position, both maintain
 * its bracket, both enforce the time limit and both ratchet the stop — placing
 * and cancelling each other's orders on a twenty-second cycle. Refusing is
 * correct; the message is what has to be good.
 */
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") {
    console.error(`\n  Could not start: ${err.message}\n`);
    process.exit(1);
  }
  console.error("");
  console.error(`  Port ${PORT} is already in use — this is almost certainly an older copy of`);
  console.error("  this program still running in another window.");
  console.error("");
  console.error("  Stop the old one first. It will not close any position: every stop and");
  console.error("  target rests on Binance and keeps working while nothing is running here.");
  console.error("");
  console.error("    Ctrl-C in the window that is already running it, or:");
  console.error("");
  if (process.platform === "win32") {
    console.error(`      netstat -ano | findstr :${PORT}`);
    console.error("      taskkill /PID <the number in the last column> /F");
  } else {
    console.error(`      lsof -ti tcp:${PORT} | xargs kill`);
  }
  console.error("");
  console.error(`  Or run this one somewhere else:  SWEEP_CONTROL_PORT=${PORT + 1} npm run sweep:control`);
  console.error("  — but note that two of these against one account will fight over the same");
  console.error("  position, so only do that to watch a different one.");
  console.error("");
  process.exit(1);
});

/* ------------------------------------------------------------------- news */

/**
 * The outside world, collected by this process.
 *
 * It used to be a second command in a second terminal. That is a setup step
 * dressed as a feature: an operator who has to remember `npm run sweep:news`
 * after every reboot will eventually not, and forgetting it raises no error —
 * it produces an agent trading with no awareness of anything outside its own
 * order book, which looks exactly like a quiet week. The feeds are not optional
 * to how this thing decides, so they are not optional to start.
 *
 * A standalone poller still wins if one is running. Deferring to it rather than
 * refusing to start means the operator who *does* want a separate process — on
 * another machine, or to watch a source misbehave — gets it without a flag, and
 * the store never sees two collectors competing for the same rate limits.
 */
let newsPoller: NewsPoller | null = null;
let stopNewsBeat: (() => void) | null = null;

/**
 * Somebody else is collecting.
 *
 * The pid check is what makes this safe: this process beats on `sweep-news`'s
 * behalf while it owns the poller, so without it the server would read its own
 * heartbeat, conclude a standalone collector exists, and shut down the poller it
 * had just started — every sixty seconds, forever.
 */
function externalNewsRunning(): boolean {
  const hb = readHeartbeat("sweep-news");
  return hb.running && hb.pid !== process.pid;
}

function superviseNews() {
  const external = externalNewsRunning();

  if (external && newsPoller) {
    newsPoller.stop();
    newsPoller = null;
    stopNewsBeat?.();
    stopNewsBeat = null;
    log("news: standalone sweep:news is running — handing collection over to it");
    return;
  }
  if (external || newsPoller) return;

  newsPoller = startNewsPoller({
    recordedBy: "sweep:control",
    onHigh: (headline, source) => log(`news: HIGH ${source} — ${headline.slice(0, 140)}`),
  });
  stopNewsBeat = beat("sweep-news", () => ({
    ...(newsPoller?.status() ?? { recorded: 0, cycles: 0, sources: 0, unavailable: "", errors: "", velocity: "", lastPollAt: 0 }),
    host: "sweep-control",
    out: newsPath(),
  }));

  const off = newsOff();
  log(
    `news: collecting from ${newsSources().length} sources in-process` +
      (off.length ? ` (${off.length} unavailable: ${off.map((s) => s.id).join(", ")})` : ""),
  );
}

/* ---------------------------------------------------------- desired state */

/**
 * Risk settings written elsewhere and applied here.
 *
 * The operator's position is that they start and pause trading and open and
 * close positions, and that everything else should not require them to click
 * anything. The snapshot made this process readable from outside; this makes it
 * configurable from outside, which is the half that was missing.
 *
 * What it cannot do is arm, disarm, or touch a position — those are reserved,
 * and rejected explicitly rather than ignored. Nor can it set the three stopping
 * rules that were deliberately switched off. Everything else is clamped to the
 * same bounds the auto-tuner works inside, so a wrong file can only move a
 * setting somewhere the tuner could have moved it anyway.
 *
 * Every applied change goes through the same audit log as a hand edit, so the
 * record of who changed what does not depend on which channel was used.
 */
/*
 * The last remote configuration applied, remembered across restarts.
 *
 * This was in memory only, so a file committed to the repository was reapplied
 * on every single boot — permanently overriding whatever the operator had since
 * set through the dashboard, forever, with no way to countermand it except
 * deleting the file. Exactly the failure mode of the migration that overwrote
 * their settings once already.
 *
 * A desired state carries a timestamp so it can be applied once. Storing that
 * timestamp beside the limits it changed is what makes "once" mean once, rather
 * than once per process lifetime.
 */
let desiredAppliedAt = Number((limits as unknown as Record<string, unknown>).desiredAppliedAt) || 0;

/** Fields held as booleans but carried over the wire as 0 and 1. */
const BOOLEAN_LIMITS = new Set(["requireCashOpen", "autoTune", "tradingEnabled"]);

function applyDesired() {
  const file = readDesired();
  if (!file) return;
  // An unchanged file is not reapplied: the watcher pulls on a timer and the
  // same content arriving again is the normal case, not an instruction.
  if (!(Number(file.at) > desiredAppliedAt)) return;

  const plan = planDesired(limits as unknown as Record<string, number | boolean>, file);
  desiredAppliedAt = Number(file.at);
  /*
   * Recorded even when nothing changes, and before anything is applied.
   *
   * A file whose values already match produces no changes, and if the marker
   * only moved on a successful change the same file would be reconsidered on
   * every boot forever. The question this answers is "have I seen this
   * instruction", not "did it do anything".
   */
  try {
    writeLimits({ ...limits, desiredAppliedAt } as unknown as Limits);
  } catch {
    /* the in-memory marker still stops it repeating within this process */
  }

  for (const r of plan.rejected) {
    log(`config: refused ${r.key} — ${r.why}`);
  }
  if (plan.changes.length === 0) {
    if (plan.rejected.length === 0) log("config: nothing to change");
    return;
  }

  const next = { ...limits } as Record<string, unknown>;
  const applied: string[] = [];
  for (const c of plan.changes) {
    /*
     * Written to the audit before it takes effect, and skipped if that write
     * fails — the same rule the auto-tuner follows. A change nobody can see
     * afterwards is worse than a change that did not happen.
     */
    const ok = appendTuneChecked({
      at: Date.now(),
      setting: c.key as Tunable,
      from: c.from,
      to: c.to,
      /*
       * Recorded as an operator change, because that is what it is.
       *
       * The tuner defers to operator edits for twelve closes. A setting changed
       * through this channel should get the same protection — otherwise the
       * tuner would start moving it back on the next close, and the two would
       * fight over the same dial.
       */
      by: "operator",
      tradesAt: loadTrades().records.length,
      direction: "neutral",
      reason: `applied from ${desiredPath()}${plan.reason ? `: ${plan.reason}` : ""}` +
        (c.clamped ? " (clamped to its permitted range)" : ""),
    });
    if (!ok) {
      log(`config: could not record ${c.key} in the audit, so it was not applied`);
      continue;
    }
    /*
     * Booleans arrive as 0 and 1 and are converted here, at the edge.
     *
     * The parser accepts numbers only, on purpose — `Number(null)`, `Number("")`
     * and `Number(false)` are all 0, and a coerced null once set the stop
     * distance to its floor without anybody writing a value. Rather than widen
     * that parser to admit booleans, the two flags travel as numbers and are
     * turned back into flags at the one place that knows which fields they are.
     */
    next[c.key] = BOOLEAN_LIMITS.has(c.key) ? c.to !== 0 : c.to;
    applied.push(`${c.key} ${c.from} → ${c.to}${c.clamped ? " (clamped)" : ""}`);
  }

  if (applied.length === 0) return;
  limits = next as unknown as Limits;
  writeLimits(limits);
  log(`config: applied ${applied.join(", ")}${plan.reason ? ` — ${plan.reason}` : ""}`);
  // Re-arm the desks against the new numbers rather than waiting for a restart.
  for (const desk of allDesks()) if (desk.runner) armDesk(desk);
}

/* -------------------------------------------------------------- diagnose */

/**
 * What is wrong right now, and the specific next action for each thing.
 *
 * Extracted from the endpoint so the snapshot can carry it. That is the whole
 * point: this is the one place that already knows why nothing is happening, and
 * for a whole session it was reachable only by a human clicking a button on the
 * machine the agent runs on — so every remote diagnosis reconstructed by hand
 * what this computes directly, and got it wrong more than once.
 */
function diagnose() {
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
          dotenv.found
            ? `${dotenv.path} — ${dotenv.count} values` +
              (dotenv.applied < dotenv.count ? " (inherited from the supervisor)" : "")
            : `not found at ${dotenv.path}`,
          dotenv.found ? "Check the key names are exactly BINANCE_API_KEY and BINANCE_API_SECRET."
            : "On Windows, Notepad saves it as .env.txt unless you set Save as type to All Files.",
        );

        /*
         * Drift, named and bounded.
         *
         * Warned at half the receive window and failed at the window itself,
         * because at that point every signed request is already being rejected.
         */
        const clock = clockState();
        const recvWindow = Number(process.env.BINANCE_RECV_WINDOW ?? 5_000);
        const drift = Math.abs(clock.offsetMs);
        add(
          "clock in sync with Binance",
          drift < recvWindow / 2,
          clock.syncedAt === 0
            ? "not checked yet"
            : `${clock.offsetMs > 0 ? "behind" : "ahead"} by ${drift}ms ` +
              `(round trip ${clock.roundTripMs}ms, window ${recvWindow}ms, corrected on every request)`,
          drift < recvWindow / 2
            ? undefined
            : "Every signed request is corrected by this offset, so orders still place — but drift this " +
              "large means the host clock is wrong. Resync NTP.",
          drift < recvWindow / 2 ? "ok" : drift < recvWindow ? "warn" : "bad",
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

        /*
         * Mark-out warm-up, named by which gate is shut.
         *
         * `canPostEntry` refuses on its first line when mark-out is cold, so a
         * tracker that never warms silently disables the entire maker path —
         * and reports it as toxicity, which is a market condition rather than a
         * defect. That is what happened: 23,880 shadow decisions and every live
         * record came back cold, the toxicity test ran zero times, and the maker
         * path was carried for weeks as "gated on toxicity, worth $4.87 a round
         * trip, unexplored". It was not gated on toxicity. It was never reached.
         *
         * Warm-up is an AND of three conditions reported as one boolean, so this
         * says which one is unmet rather than that one is.
         */
        for (const d of allDesks()) {
          const mk = d.feed?.getState()?.markout;
          if (!mk) continue;
          const w = mk.warmth;
          const why = mk.warm
            ? `resolved ${w.resolved}, weight ${w.mainWeight.toFixed(0)}`
            : w.tradesSeen === 0
              ? "no trade has reached the tracker at all — the aggTrade stream is not wired to it"
              : w.resolved < w.resolvedNeeded
                ? `only ${w.resolved} of ${w.resolvedNeeded} one-second horizons resolved from ${w.tradesSeen} trades`
                : w.sinceFirstTradeMs !== null && w.sinceFirstTradeMs < 60_000
                  ? `first trade was ${Math.round(w.sinceFirstTradeMs / 1000)}s ago and 60s is needed`
                  : `the five-second horizon carries no weight (${w.mainWeight})`;
          add(`mark-out warm: ${d.symbol}`, mk.warm, why,
            mk.warm ? undefined
              : "Until this warms, canPostEntry refuses every maker entry on its first line and the " +
                "toxicity threshold is never consulted. Cold is a defect here, not a market reading.",
            mk.warm ? "ok" : "bad");
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
          /*
           * The same failure from the other end.
           *
           * A stop can be too tight as surely as too wide, and it is less
           * obvious: the target it implies gets smaller with it, and once that
           * target is worth less than a multiple of the round trip, every
           * setup is refused for a reward that was never going to clear its own
           * costs. A 0.1% stop at 1.2 reward-to-risk asks for a 0.12% move
           * against a round trip near 0.10% — structurally unpayable, and it
           * presents as a quiet market rather than as a setting.
           */
          const roundTripPct = (fees.tiers[0]?.takerRate ?? 0.0005) * 2 * 100;
          const feeFloor = roundTripPct * limits.minRewardOverFees;
          const tooTight = !impossible && need < feeFloor;
          // A stop this wide is also almost certainly a unit mix-up rather than
          // a deliberate choice, so the two are worth separating.
          const implausible = !impossible && limits.stopLossPct > 5;
          add("stop distance is reachable", !impossible && !implausible && !tooTight,
            `${limits.stopLossPct}% stop × ${limits.minRewardRisk} reward-to-risk needs a level ` +
              `${need.toFixed(1)}% away; levels are mapped to ±${mapped}%` +
              (impossible ? " — nothing can ever satisfy this" : ""),
            tooTight
              ? `A ${limits.stopLossPct}% stop asks for a ${need.toFixed(2)}% move, and the round trip costs ` +
                `about ${roundTripPct.toFixed(2)}% — the reward is smaller than the fee hurdle, so every setup ` +
                `is refused. Set the stop to at least ${(feeFloor / Math.max(limits.minRewardRisk, 0.1)).toFixed(2)}%.`
              : impossible
              ? `Set the stop to about ${(mapped / 4 / Math.max(limits.minRewardRisk, 1)).toFixed(1)}% or less. ` +
                "This field is a price move, not a percentage of your money: 0.5% means price moving half a " +
                `percent against you, which at ${limits.maxLeverage}x is ` +
                `${(0.5 * limits.maxLeverage).toFixed(0)}% of the margin behind the position.`
              : implausible
                ? "That is a very wide stop for an intraday equity perp. It is a price move, not a share of " +
                  "your money — check it is the number you meant."
                : undefined,
            impossible || tooTight ? "bad" : implausible ? "warn" : "ok");
        }

        add("max daily loss set", true,
          limits.maxDailyLossUsd > 0 ? `${limits.maxDailyLossUsd} USD` : "off — no daily stop, by choice",
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

        /*
         * The feeds, checked separately because they are not a worker any more.
         *
         * This process collects them itself, so "not running" here does not mean
         * the operator forgot a command — it means something inside this server
         * failed, which is a different problem with a different fix. Erroring
         * sources are reported but not treated as broken: a rate-limited public
         * RSSHub or a 4chan outage degrades the feed and does not stop it, and a
         * check that goes red every time one of thirteen sources hiccups trains
         * the operator to ignore it.
         */
        {
          const st = newsPoller?.status();
          const external = externalNewsRunning();
          const hb = readHeartbeat("sweep-news");
          const collecting = Boolean(st) || external;
          const errs = String(st?.errors ?? hb.stats.errors ?? "");
          const nErr = errs ? errs.split(" | ").length : 0;
          const total = st?.sources ?? Number(hb.stats.sources ?? 0);
          add("news + social feeds", collecting,
            !collecting
              ? "not collecting"
              : `${total - nErr}/${total} sources live${external ? " (standalone sweep:news)" : " (in this process)"}` +
                `, ${st?.recorded ?? hb.stats.recorded ?? 0} headlines recorded` +
                (nErr ? ` · ${nErr} erroring: ${errs.slice(0, 160)}` : ""),
            collecting
              ? undefined
              : "This server starts the collector itself, so this should never be off. Restart it.",
            collecting ? "ok" : "bad");
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
                  notReady: acc.notReady + s.notReady,
                }
              : acc;
          },
          { any: false, seen: 0, accepted: 0, rejected: 0, declined: 0, notReady: 0 },
        );
        if (s2.any) {
          const explained = s2.accepted + s2.rejected + s2.declined + s2.notReady;
          add("loop accounting", explained === s2.seen,
            `${s2.seen} seen = ${s2.accepted} placed + ${s2.declined} no side + ${s2.rejected} refused` +
              (s2.notReady ? ` + ${s2.notReady} while the feed was warming` : ""),
            explained === s2.seen ? undefined : "Signals are going unaccounted — that is a bug, not a setting.",
            explained === s2.seen ? "ok" : "bad");
        }

        /*
         * A zero max-position refuses every order, and did so silently.
         *
         * The adapter throws "max position size is not set" per attempt, which
         * lands in the execution log where it reads as one rejected trade
         * rather than as a dead session. Stated here as what it is: nothing can
         * trade until this is a number.
         */
        add("position cap", limits.maxPositionUsd > 0,
          limits.maxPositionUsd > 0
            ? `max position ${usdShort(limits.maxPositionUsd)}` +
              (limits.capsDerivedAt ? "" : " (not yet marked derived)")
            : "max position is 0 — every order is refused before it is sized",
          limits.maxPositionUsd > 0
            ? undefined
            : "It is derived from the balance at startup and retried every 20s. If it is still zero, the " +
              "account balance is not readable — check credentials and that the venue is reachable. " +
              "Setting it by hand in Risk limits also works.",
          limits.maxPositionUsd > 0 ? "ok" : "bad");

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
        return {
          checks,
          verdict: bad.length
            ? `${bad.length} thing${bad.length === 1 ? "" : "s"} broken`
            : warn.length
              ? `nothing broken; ${warn.length} thing${warn.length === 1 ? "" : "s"} would stop a trade`
              : "everything checks out — quiet means no setup has qualified yet",
          worst: bad.length ? "bad" : warn.length ? "warn" : "ok",
        };
}

/* ------------------------------------------------------------ the bridge */

/**
 * The sharing process, owned by this one.
 *
 * It used to be a second command in a second window, and the failure that
 * produced was the worst possible shape: trading carried on for nine hours while
 * the thing that reports on it was dead, so the run looked healthy from inside
 * and was invisible from outside. Nobody noticed, because the only symptom was
 * an absence.
 *
 * Tying the lifecycles together removes that asymmetry. If the agent is
 * trading, it is observable; if it stops being observable, it is because the
 * whole thing stopped, which is a state the operator notices immediately.
 *
 * The trading code still never calls git. It spawns a worker whose only git
 * operation is pathspec'd to evidence/ — the point of that separation was to
 * make an accidental `git add -A` from this process impossible, and a child
 * process that cannot express one preserves it.
 *
 * Set SWEEP_NO_SHARE=1 to run without it.
 */
let shareChild: ChildProcess | null = null;
let shareRestarts = 0;
let shareStoppedAt = 0;

function superviseShare() {
  if (process.env.SWEEP_NO_SHARE === "1" || shareChild) return;

  /*
   * Backed off, so a permanently broken share — no remote, no credentials, a
   * detached HEAD — does not spawn a process every second forever.
   */
  const waitMs = Math.min(300_000, 5_000 * 2 ** Math.min(shareRestarts, 6));
  if (shareStoppedAt && Date.now() - shareStoppedAt < waitMs) return;

  /*
   * `shell` on Windows: npm is a .cmd there, and Node 20.12 refuses to spawn
   * .bat/.cmd without one (CVE-2024-27980). Without this the share worker
   * throws EINVAL on every attempt and the bridge silently never starts —
   * which is the exact failure this supervision exists to prevent.
   */
  const isWindows = process.platform === "win32";
  const child = spawn(isWindows ? "npm.cmd" : "npm", ["run", "sweep:share", "--", "--watch"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    shell: isWindows,
  });
  shareChild = child;

  const relay = (buf: Buffer) => {
    for (const line of String(buf).split("\n")) {
      const t = line.trim();
      // Only the lines that say something changed or broke. The share worker is
      // chatty by design when watched directly, and this is not that window.
      if (t && !/no change since the last one/.test(t)) log(t.replace(/^\[share\]\s*/, "share: "));
    }
  };
  child.stdout?.on("data", relay);
  child.stderr?.on("data", relay);

  child.on("exit", (code) => {
    shareChild = null;
    shareStoppedAt = Date.now();
    shareRestarts++;
    log(`share: exited (${code ?? "signal"}) — restarting, attempt ${shareRestarts}`);
  });
  child.on("error", (err) => {
    shareChild = null;
    shareStoppedAt = Date.now();
    shareRestarts++;
    log(`share: could not start — ${err.message}`);
  });
}

/**
 * The research loop, supervised like the share worker.
 *
 * It fetches public history and replays it, writing rankings into evidence/
 * which sharing already pushes. Nothing in it places an order or reads a
 * credential. It lives here because the alternative was the operator running it
 * by hand and pasting the output back, which is not autonomy.
 *
 * Set SWEEP_NO_RESEARCH=1 to run without it.
 */
let researchChild: ChildProcess | null = null;
let researchStoppedAt = 0;

function superviseResearch() {
  if (process.env.SWEEP_NO_RESEARCH === "1" || researchChild) return;
  /*
   * Never from a test harness.
   *
   * The suites boot a real control server, and a research child would start
   * pulling a year of archive from a public endpoint every time one runs. A
   * redirected snapshot path is the marker those harnesses already set to keep
   * out of the operator's real state, so it serves here too.
   */
  if (process.env.SWEEP_SNAPSHOT) return;
  // Slow retry: a broken research pass is not urgent, and a tight loop here
  // would hammer a public archive.
  if (researchStoppedAt && Date.now() - researchStoppedAt < 30 * 60_000) return;

  const isWindows = process.platform === "win32";
  const child = spawn(isWindows ? "npm.cmd" : "npm", ["run", "sweep:research", "--", "--watch"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    shell: isWindows,
  });
  researchChild = child;
  /*
   * Only the lines that conclude something.
   *
   * The research worker prints a banner and a progress line per file, and the
   * share worker relays npm's own output too — together they filled the
   * 200-line ring within seconds and pushed out the log that says why arming
   * failed. Observability was destroyed by the process added to improve it, and
   * the failure it hid took three passes to find because the evidence for it
   * was being overwritten every snapshot.
   */
  const KEEP = /(ranking written|replay refused|could not|refus|error|!!|span \d+ days)/i;
  const relay = (buf: Buffer) => {
    for (const line of String(buf).split("\n")) {
      const t = line.trim();
      if (t && KEEP.test(t)) log(t.replace(/^\[research\]\s*/, "research: ").slice(0, 200));
    }
  };
  child.stdout?.on("data", relay);
  child.stderr?.on("data", relay);
  child.on("exit", () => { researchChild = null; researchStoppedAt = Date.now(); });
  child.on("error", (err) => {
    researchChild = null;
    researchStoppedAt = Date.now();
    log(`research: could not start — ${err.message}`);
  });
}

/**
 * Make the desks match what the limits say, continuously.
 *
 * `tradingEnabled` is a flag; arming is an action, and nothing kept them in
 * step. `resumeAfterUpdate` set the flag after a self-restart and never called
 * `armDesk`, so the agent reported armed — the button, the panel and the
 * self-check all agreed — while no execution loop was attached to anything. It
 * saw 444 signals and accepted none, with no refusal recorded, because there
 * was nothing there to refuse them.
 *
 * A reconciler rather than another call at the one site that was missing it.
 * Arming already happens from the button, a limits save, a restart and now a
 * resume, and the next path added will forget too. This asks the only question
 * that matters — does the world match the intent — and fixes it if not.
 */
function reconcileArming() {
  for (const desk of allDesks()) {
    if (limits.tradingEnabled && desk.feed && !desk.runner) {
      log(`arming ${desk.symbol}: the limits say trading is on and no loop was attached`);
      armDesk(desk);
    }
    if (!limits.tradingEnabled && desk.runner) {
      log(`disarming ${desk.symbol}: the limits say trading is off`);
      desk.runner.stop?.();
      desk.runner = null;
    }
  }
}

/**
 * The shadow run, supervised like everything else.
 *
 * It was the one long-lived process nobody owned: started by hand, never
 * restarted, and therefore permanently pinned to whatever build was current the
 * day it was launched. That is not a theoretical hazard — a fix to make shadow
 * rows carry their entry conditions was deployed, the control server took it and
 * restarted, and 240 more rows were written without conditions because the
 * process actually writing them had not changed. The defect was reported as
 * fixed while it was still producing bad data.
 *
 * Supervising it means it restarts when the control server does, which is when
 * the branch moves — so a fix to the shadow path now reaches the shadow path.
 *
 * Set SWEEP_NO_SHADOW=1 to run without it.
 */
let shadowChild: ChildProcess | null = null;
let shadowStoppedAt = 0;

function superviseShadow() {
  if (process.env.SWEEP_NO_SHADOW === "1" || shadowChild) return;
  // Never from a test harness; a redirected snapshot is the marker they set.
  if (process.env.SWEEP_SNAPSHOT) return;
  if (shadowStoppedAt && Date.now() - shadowStoppedAt < 60_000) return;

  const isWindows = process.platform === "win32";
  const child = spawn(isWindows ? "npm.cmd" : "npm", ["run", "sweep:shadow"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    shell: isWindows,
  });
  shadowChild = child;
  // Only conclusions, for the reason the research relay learned: a chatty child
  // empties the log ring and takes the diagnosis of the next fault with it.
  const KEEP = /(recorded|refus|could not|error|!!)/i;
  const relay = (buf: Buffer) => {
    for (const line of String(buf).split("\n")) {
      const t = line.trim();
      if (t && KEEP.test(t)) log(t.replace(/^\[shadow\]\s*/, "shadow: ").slice(0, 200));
    }
  };
  child.stdout?.on("data", relay);
  child.stderr?.on("data", relay);
  child.on("exit", () => { shadowChild = null; shadowStoppedAt = Date.now(); });
  child.on("error", (err) => {
    shadowChild = null;
    shadowStoppedAt = Date.now();
    log(`shadow: could not start — ${err.message}`);
  });
}

/* ----------------------------------------------------------- self-update */

/**
 * Restart into new code when the branch moves, without anybody being present.
 *
 * The share worker pulls the branch every two minutes, so a fix reaches the
 * disk on its own — and then sits there, because a running Node process does
 * not reload its own source. Every deployment so far has therefore required a
 * person to notice, stop the window and start it again, which is exactly the
 * hand-off that is not allowed to exist.
 *
 * Exiting is the whole mechanism: keepalive restarts what it supervises, so a
 * clean exit is a redeploy.
 */
const bootRevision = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
})();

/** When this process last restarted itself, so a loop cannot go unbounded. */
let updatesLately: number[] = (() => {
  try {
    const m = JSON.parse(readFileSync(resolve("data/sweep-restart-log.json"), "utf8")) as number[];
    return Array.isArray(m) ? m.filter((t) => Date.now() - t < 10 * 60_000) : [];
  } catch {
    return [];
  }
})();

/** Marks a restart this process chose, so arming can survive it. */
const restartMarker = () => resolve("data/sweep-restart.json");

/**
 * Paths whose movement is not new code.
 *
 * The share worker commits a state snapshot every two minutes and pushes it, so
 * HEAD moves continuously on a healthy machine. Comparing revisions alone made
 * every one of those commits look like a deployment: the server exited,
 * keepalive restarted it, the next snapshot landed two minutes later and it
 * exited again. A restart loop, caused by the mechanism meant to remove restarts
 * from the operator's hands.
 *
 * So the question is not "has HEAD moved" but "has anything that changes
 * behaviour moved".
 */
const GENERATED = /^(evidence|data|control)\//;

function checkForUpdate() {
  if (!bootRevision) return;
  let head = "";
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return;
  }
  if (!head || head === bootRevision) return;

  /*
   * What actually changed between the two revisions.
   *
   * `control/` is excluded along with the generated directories: configuration
   * arriving through that file is applied live within twenty seconds and has
   * never needed a restart, so treating it as a deployment would restart the
   * agent every time a setting was tuned.
   */
  let changed: string[] = [];
  try {
    changed = execFileSync("git", ["diff", "--name-only", bootRevision, head], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((x) => !GENERATED.test(x));
  } catch {
    // Cannot tell what moved, so assume nothing did. A missed deployment costs
    // one cycle; a wrong one costs a restart loop.
    return;
  }
  if (changed.length === 0) return;

  /*
   * A circuit breaker on the mechanism itself.
   *
   * If self-updating ever starts a restart loop again — for any reason, not
   * only the one already fixed — it must stop on its own rather than cycle the
   * agent until somebody notices. Two updates inside ten minutes is not a
   * deployment pattern, it is a fault, and the correct response to a fault in
   * the redeploy mechanism is to stop redeploying and keep trading.
   */
  updatesLately = updatesLately.filter((t) => Date.now() - t < 10 * 60_000);
  if (updatesLately.length >= 2) {
    log(
      `refusing to restart for ${head.slice(0, 7)}: ${updatesLately.length} updates in the last ten minutes. ` +
        `Self-update is off until this process is restarted by hand — the agent keeps running.`,
    );
    return;
  }

  /*
   * Not while holding something.
   *
   * The position keeps its exchange stop across a restart, so this is not about
   * safety — it is about the excursion tracker, which cannot observe what
   * happened while the process was down and marks the trade incomplete.
   */
  const holding = allDesks().some((d) => (d.protection.state?.position?.positionAmt ?? 0) !== 0);
  if (holding) {
    log(`update ${head.slice(0, 7)} is waiting for the open position to close`);
    return;
  }

  /*
   * Arming survives an update, and only an update.
   *
   * Booting disarmed stays exactly as it was for a crash, a power cut or a
   * reboot: those must never resume placing orders on a decision nobody was
   * present to make. A restart this process chose, seconds ago, having been
   * armed, is a different event. The marker is timestamped and honoured for
   * five minutes so it cannot outlive the restart it describes.
   */
  try {
    writeFileSync(restartMarker(), JSON.stringify({ at: Date.now(), wasArmed: limits.tradingEnabled, to: head }));
  } catch { /* the restart still happens; it just comes back disarmed */ }

  // Written before exiting, and read back at boot: the counter has to survive
  // the very restart it is counting, or it can never see a loop.
  try {
    updatesLately.push(Date.now());
    writeFileSync(resolve("data/sweep-restart-log.json"), JSON.stringify(updatesLately));
  } catch { /* the breaker degrades to off, which is the previous behaviour */ }

  log(
    `new code on the branch (${changed.slice(0, 4).join(", ")}${changed.length > 4 ? `, +${changed.length - 4} more` : ""}) ` +
      `— restarting into it`,
  );
  killTree(shareChild);
  killTree(researchChild);
  killTree(shadowChild);
  server.close();
  process.exit(0);
}

/** Re-arm if the last stop was this process updating itself, moments ago. */
function resumeAfterUpdate() {
  const path = restartMarker();
  if (!existsSync(path)) return;
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as { at: number; wasArmed: boolean };
    rmSync(path, { force: true });
    if (m.wasArmed && Date.now() - m.at < 5 * 60_000) {
      limits = { ...limits, tradingEnabled: true };
      writeLimits(limits);
      log("resumed armed: this process restarted itself to take an update, and was armed before it did");
    }
  } catch {
    try { rmSync(path, { force: true }); } catch { /* nothing to clean up */ }
  }
}

/**
 * Put the dashboard one double-click away.
 *
 * The URL carries a token, and the token is regenerated on every start unless
 * SWEEP_CONTROL_TOKEN is set — so a bookmark saved once is stale by the next
 * session, and the only current copy of the address is a line of terminal
 * output that scrolls away behind the log. That is a poor place to keep the
 * only control surface of something holding a position.
 *
 * A shortcut rewritten at every boot always points at the session that is
 * actually running. Written to the desktop where it can be found, and to a file
 * beside the code as a fallback for when the desktop cannot be located.
 *
 * Never throws: this is a convenience, and a convenience that can stop a
 * trading process from starting is a defect. Every failure is swallowed and
 * noted.
 */
function writeShortcut(url: string) {
  /*
   * A .url file rather than a .lnk.
   *
   * The shortcut format Explorer uses for the Start Menu is a binary blob that
   * needs COM to write. A .url is three lines of text, opens in the default
   * browser on a double-click, and works the same whether it is on the desktop
   * or anywhere else.
   */
  const body = ["[InternetShortcut]", `URL=${url}`, "IconIndex=0", ""].join("\r\n");
  const targets: string[] = [resolve("data", "Sweep dashboard.url")];

  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) {
    targets.push(join(home, "Desktop", "Sweep dashboard.url"));
    // OneDrive redirects the desktop on many Windows installs, and writing only
    // to the real path puts the shortcut somewhere the operator never looks.
    if (process.env.OneDrive) targets.push(join(process.env.OneDrive, "Desktop", "Sweep dashboard.url"));
  }

  const written: string[] = [];
  for (const target of targets) {
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
      written.push(target);
    } catch {
      /* a desktop that does not exist is not an error worth reporting twice */
    }
  }
  if (written.length) log(`dashboard shortcut: ${written.join(" · ")}`);
  else log("could not write a dashboard shortcut anywhere — the address is in the banner above");

  // Also as plain text, so anything scripted can read the current address
  // without parsing terminal output.
  try {
    writeFileSync(resolve("data", "sweep-url.txt"), `${url}\n`);
  } catch { /* the shortcut above is the one that matters */ }
}

/* --------------------------------------------------------------- snapshot */

/**
 * Everything the page shows, written to a file on a timer.
 *
 * The point is that a diagnosis should never again start with a guess about
 * state this process already holds. It writes the same objects the API serves,
 * so a reader has the limits, the desks, the day, the refusal tally, the recent
 * log and the self-check without having to ask for any of them.
 *
 * Redaction happens in writeSnapshot, over the finished string rather than over
 * chosen fields — a secret that reaches this file will do so inside a log line
 * or an error message, not in a field anyone thought to name.
 */
/**
 * Read and condense the shadow log, tolerating everything a live file does.
 *
 * Never throws: this runs inside the snapshot writer, and a summary that can
 * fail is a summary that takes the whole state file down with it — including
 * the parts that say why. A half-written final line is the normal state of a
 * file being appended to, not an error.
 */
function shadowSummary(): ReturnType<typeof summariseShadow> | { error: string } {
  try {
    const path = resolve(process.env.SWEEP_SHADOW_OUT ?? "data/sweep-shadow.jsonl");
    if (!existsSync(path)) return { error: "no shadow log yet — npm run sweep:shadow collects it" };
    const rows: ShadowRowLike[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line) as ShadowRowLike); } catch { /* partial last line */ }
    }
    return summariseShadow(rows);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function writeStateSnapshot() {
  try {
    const { records } = loadTrades();
    const report = analyse(records);
    writeSnapshot({
      meta: {
        at: Date.now(),
        node: process.version,
        platform: process.platform,
        symbols: allDesks().map((d) => d.symbol),
      },
      status: status(),
      // What the last remotely-applied configuration was, so a reader can tell
      // whether the file they wrote has landed.
      desired: { path: desiredPath(), appliedAt: desiredAppliedAt },
      /*
       * The self-check, which is the thing that actually answers "what is
       * broken". Computed here rather than left behind a button on the
       * operator's machine — that gap is why a trade cap was diagnosed as a
       * target gate and a render throw as lost settings.
       */
      diagnose: diagnose(),
      /** Anything that threw, kept out of the log ring so it does not rotate away. */
      errors: errorLines,
      /*
       * Notes typed on the page, carried with the state they refer to.
       *
       * This is the whole reason they are in the snapshot rather than in a chat
       * window: "that one looked wrong" is only answerable next to the limits,
       * the refusals and the log for that exact minute.
       */
      notes: outbox(40),
      // The tally that answers "why did nothing trade", which took a round trip
      // to obtain every previous time it was needed.
      refusals: pooledRefusals(),
      limits,
      ledger: ledgerEpoch,
      learn: {
        n: report.n,
        wins: report.wins,
        winRate: report.winRate,
        expectancyR: report.expectancyR,
        netUsd: report.netUsd,
        anatomy: report.anatomy,
        splits: report.splits.filter((x) => x.decisive).slice(0, 6),
      },
      /*
       * The trade records themselves, not only what was concluded from them.
       *
       * The summary above is a set of conclusions, and a conclusion cannot be
       * audited from outside. `expectancyR` reported n=2 while `learn.n` said
       * 23 — a fact about the records, invisible in every aggregate, and
       * unanswerable from here because `data/` is not shared and the analysis
       * runs on a different machine. Shipping the rows means a question about
       * why a field is empty is answered by looking rather than by asking the
       * operator to look.
       *
       * Thirty is roughly two days of trading and about 60KB. `news` is dropped
       * — it is prose for a human, it is the largest field, and nothing infers
       * from it. Everything else stays, `entryConditions` especially, because
       * that is the only thing that can explain a losing entry.
       */
      trades: records.slice(-30).map(({ news: _news, ...t }) => t),
      /*
       * What the shadow run has already learned, which is twenty times what the
       * account has paid to learn.
       *
       * These rows were being generated, scored and then read by nobody: the
       * file lives under `data/`, which is not shared, so the cheapest evidence
       * in the project was the only evidence invisible from where the analysis
       * happens. Meanwhile the same question was being put to the live account
       * at $7.60 a round trip.
       */
      shadow: shadowSummary(),
      // Newest last, matching how they read in a terminal.
      log: logLines.slice(-200),
      news: {
        sources: newsSources().length,
        unavailable: newsOff().map((x) => x.id),
        poller: newsPoller?.status() ?? null,
      },
    });
  } catch (err) {
    // A snapshot that fails must never be able to affect trading.
    log(`snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

server.listen(PORT, HOST, () => {
  // The file may still say armed from the last session; readLimits() has
  // already overridden it, and writing it back keeps the two in step.
  writeLimits(limits);
  startEngine();
  superviseNews();
  // Re-checked rather than decided once, so starting or stopping a standalone
  // poller mid-session hands collection over either way without a restart.
  setInterval(superviseNews, 60_000).unref?.();
  resumeAfterUpdate();
  writeStateSnapshot();
  setInterval(writeStateSnapshot, 30_000).unref?.();
  applyDesired();
  setInterval(applyDesired, 20_000).unref?.();
  superviseShare();
  setInterval(superviseShare, 15_000).unref?.();
  superviseResearch();
  setInterval(superviseResearch, 60_000).unref?.();
  superviseShadow();
  setInterval(superviseShadow, 60_000).unref?.();
  setInterval(reconcileArming, 20_000).unref?.();
  setInterval(checkForUpdate, 5 * 60_000).unref?.();
  console.log(`  snapshot:    ${snapshotPath()} (refreshed every 30s — npm run sweep:share to send it)`);
  console.log(`  config in:   ${desiredPath()} (applied within 20s; cannot arm, disarm or touch a position)`);
  console.log(
    process.env.SWEEP_NO_SHARE === "1"
      ? "  sharing:     off (SWEEP_NO_SHARE=1)"
      : "  sharing:     on, in this process — no second window to keep open",
  );
  void (async () => {
    // First, because it decides whether anything else can possibly work and
    // needs no credentials to answer.
    /*
     * Before anything signed, and then on a timer.
     *
     * A drifted clock rejects every order with -1021 while the agent reports
     * armed, healthy and warm — the rejection happens below the strategy, so
     * nothing is tallied as a refusal and the signal count keeps climbing. It
     * is indistinguishable from a quiet market unless the offset is measured.
     */
    await syncClock(loadConfig());
    setInterval(() => { void syncClock(loadConfig()); }, 15 * 60_000).unref?.();
    await checkOrderVenue();
    await reconcileOnStart();
    await refreshAccount();
    // After the balance is known, because that is what they are derived from.
    const capsProblem = await deriveUnsetCaps();
    if (capsProblem) log(`caps not derived yet — ${capsProblem}. Will retry on each account sweep.`);
    // Analysis only — see runAutoTune. This fills the panel at boot instead of
    // leaving it blank until the next position closes.
    await runAutoTune(false).catch(() => {});
    setInterval(() => {
      void (async () => {
        await refreshAccount();
        /*
         * Retried, because the first attempt can legitimately fail.
         *
         * The balance is not always known at boot — a slow first account read,
         * an exchange hiccup, an account reset in progress — and a cap of zero
         * refuses every order the adapter is handed. Running this once meant a
         * transient failure at startup killed trading for the whole session
         * with nothing in the log to say why. It is a no-op once the caps are
         * marked derived, so this costs nothing in the normal case.
         */
        const problem = await deriveUnsetCaps();
        if (problem && !capsWarned) {
          capsWarned = true;
          log(`!! caps are still unset and no order can be sized — ${problem}`);
        }
        await maintainBrackets();
        await enforceMaxHold();
      })();
    }, 20_000).unref?.();
    /*
     * The excursion, sampled far faster than the account sweep.
     *
     * At twenty seconds this would miss the thing it exists to measure. The
     * whole thesis is that the move happens in seconds — a spike that reaches
     * the target and comes back inside one sweep would be recorded as a
     * position that never moved, and the post-mortem would file a bad exit as a
     * bad entry. Costs nothing: it reads state this process already holds in
     * memory and sends no requests.
     */
    setInterval(markExcursions, 1_000).unref?.();
  })();
  const url = `http://${HOST}:${PORT}/?token=${TOKEN}`;
  writeShortcut(url);
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
    newsPoller?.stop();
    // Killed with this process, so the two can never be alive separately —
    // which is the whole reason it is a child rather than a second window.
    // The tree, not the shell: on Windows this child is cmd.exe with node under
    // it, and killing the shell alone leaves a share worker running git against
    // the branch with no server left to describe.
    killTree(shareChild);
    /*
     * And the other two, which this handler never touched.
     *
     * Research and shadow were spawned here and orphaned on Ctrl-C, so stopping
     * the server left a downloader and a recorder running against a repository
     * with nothing left to describe. Over a few restarts that is several of
     * each, all writing the same files.
     */
    killTree(researchChild);
    killTree(shadowChild);
    // Marks the heartbeat stopped rather than leaving it to go stale, so the
    // panel reads "not running" immediately instead of ninety seconds late.
    stopNewsBeat?.();
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

/**
 * Every command this project has, on one page.
 *
 * Written as data rather than markup so the two things that matter about a
 * command list stay true: each entry carries whether it can place an order,
 * and nothing can appear here without answering that question. A reference
 * that lists `sweep:pairs` next to `sweep:learn` without saying which one
 * spends money is worse than no reference.
 *
 * Deliberately static. It describes what to type in a terminal, so nothing on
 * it needs polling, and a page that cannot go stale cannot mislead.
 */
interface Cmd {
  cmd: string;
  what: string;
  /** "safe" reads only. "orders" can send. "arm" needs an explicit switch first. */
  risk: "safe" | "arm" | "orders";
  note?: string;
}

const COMMAND_GROUPS: { title: string; blurb: string; items: Cmd[] }[] = [
  {
    title: "Running",
    blurb: "Long-lived processes. Leave them up.",
    items: [
      { cmd: "npm run sweep:control", risk: "arm",
        what: "This server and its dashboard. Places orders only once armed here.",
        note: "The token is printed at startup." },
      { cmd: "SWEEP_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT npm run sweep:shadow", risk: "safe",
        what: "Real feed, real book, real sizing, real fees — and no order. Scores every intent against what price actually did.",
        note: "The fastest way to collect evidence: unthrottled by trade caps, so it gathers 5-20x faster than live trading. Needs no credentials." },
      { cmd: "npm run sweep:paper", risk: "safe",
        what: "Evidence log. Samples market state on a clock and comes back later to record what price did.",
        note: "This is the 'Evidence log' tile on the dashboard." },
      { cmd: "npm run sweep:pairs", risk: "safe",
        what: "Market-neutral pairs across correlated perpetuals. Paper by default — prints what it would do." },
      { cmd: "SWEEP_PAIRS_ARM=1 npm run sweep:pairs", risk: "orders",
        what: "The same loop, sending real orders." },
      { cmd: "npm run sweep:news", risk: "safe",
        what: "Collects exchange announcements, Reddit, 4chan /biz/, Hacker News, X and the wires on a continuous staggered clock. Forums and social drive mention velocity only — never recorded as headlines.",
        note: "You do not need this. sweep:control runs the same collector in-process, and stands down automatically if it sees this one running. Use it only to collect on a machine that is not running the server, or to watch a source misbehave." },
      { cmd: "npm run sweep:mcp", risk: "safe",
        what: "MCP server so an agent can read live market state and record news or events.",
        note: "Still single-symbol — it only sees the first contract." },
    ],
  },
  {
    title: "Reading",
    blurb: "Analysis. These start nothing and change nothing.",
    items: [
      { cmd: "npm run sweep:learn", risk: "safe",
        what: "The post-mortem: how the losses failed, which entry conditions separate winners, what to change." },
      { cmd: "npm run sweep:learn -- --trades", risk: "safe", what: "...plus every trade, one line each." },
      { cmd: "npm run sweep:learn -- --symbol=INTCUSDT", risk: "safe", what: "...for one contract." },
      { cmd: "npm run sweep:shadow:report", risk: "safe",
        what: "What the shadow run would have made, net of the fees it would have paid." },
      { cmd: "npm run sweep:analyse", risk: "safe",
        what: "Reads the paper log and says which readings actually predict anything." },
      { cmd: "npm run sweep:analyse -- --in data/sweep-paper.jsonl --horizon 300", risk: "safe",
        what: "...at a chosen horizon." },
      { cmd: "npm run sweep:bundle", risk: "safe",
        what: "Packages every log plus the post-mortem into one redacted, truncated file in evidence/.",
        note: "The way to hand the collected data to someone who is not on this machine. Credentials are stripped; large logs are trimmed and say how many rows were dropped." },
      { cmd: "npm run sweep:bundle -- --rows 500", risk: "safe",
        what: "...smaller, when the full bundle is unwieldy." },
    ],
  },
  {
    title: "When something is wrong",
    blurb: "Diagnostics.",
    items: [
      { cmd: "npm run sweep:check", risk: "safe",
        what: "Is the key valid, pointed at the right venue, and is this IP allowed? One round trip, no orders.",
        note: "Run this first for any authentication error — it tells the three apart." },
      { cmd: "npm run sweep:symbols", risk: "safe", what: "What Binance actually lists, and what it costs to trade." },
      { cmd: "npm run sweep:symbols --all", risk: "safe", what: "...the whole contract list, crypto included." },
      { cmd: "npm run sweep:equity", risk: "safe", what: "How much capital this needs to trade a symbol at all." },
      { cmd: "npm run sweep:equity -- --price 100 --risk 2 --stop 3", risk: "safe", what: "...for given numbers." },
      { cmd: "npm run sweep:guicheck", risk: "safe", what: "Checks the dashboard script parses. Run after any GUI edit." },
      { cmd: "npx tsc --noEmit", risk: "safe", what: "Typecheck the whole project." },
    ],
  },
];

const ENV_VARS: { name: string; what: string; danger?: boolean }[] = [
  { name: "SWEEP_SYMBOLS=BTCUSDT,ETHUSDT", what: "Starting contracts. Still how sweep:shadow is pointed, and the fallback for sweep:control on a fresh install — but once you add or remove one from the Contracts panel, data/sweep-symbols.json wins and this is ignored." },
  { name: "SWEEP_SYMBOL=BTCUSDT", what: "Single contract, for mcp and paper." },
  { name: "BINANCE_LIVE=1", what: "Orders go to production instead of demo. Real money.", danger: true },
  { name: "SWEEP_CONTROL_PORT=8899", what: "Port for this server." },
  { name: "SWEEP_TRADE_LOG=data/sweep-trades.jsonl", what: "Where post-mortems are written." },
  { name: "SWEEP_TUNE_LOG=data/sweep-tuning.jsonl", what: "Audit trail of every cap change." },
  { name: "SWEEP_LIMITS=data/sweep-limits.json", what: "The risk limits file." },
  { name: "SWEEP_JOURNAL=data/sweep-positions.json", what: "What this process remembers about open positions." },
  { name: "SWEEP_FEE_DISCOUNT=0.9", what: "Set if BNB fee payment is enabled on the account." },
];

function commandsPage(token: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const badge = (r: Cmd["risk"]) =>
    r === "orders"
      ? `<span class="tag bad">sends orders</span>`
      : r === "arm"
        ? `<span class="tag warn">can send once armed</span>`
        : `<span class="tag ok">read only</span>`;

  const groups = COMMAND_GROUPS.map((g) => `
    <div class="panel">
      <h2>${esc(g.title)}</h2>
      <p class="note" style="margin-top:0">${esc(g.blurb)}</p>
      ${g.items.map((c) => `
        <div class="cmd">
          <div class="cmdline">
            <code>${esc(c.cmd)}</code>
            <button class="copy" data-cmd="${esc(c.cmd)}">copy</button>
            ${badge(c.risk)}
          </div>
          <div class="muted what">${esc(c.what)}</div>
          ${c.note ? `<div class="muted hint">${esc(c.note)}</div>` : ""}
        </div>`).join("")}
    </div>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Commands — Sweep agent</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--plane:#0a0f1c;--surface:#101728;--surface2:#182136;
--ink:#eef2fa;--ink2:#a9b6cf;--muted:#6f7d99;
--hair:rgba(140,170,220,.14);--hair2:rgba(140,170,220,.26);
--good:#3ddc97;--good-dim:rgba(61,220,151,.13);
--bad:#ff6b81;--bad-dim:rgba(255,107,129,.13);
--warn:#ffc75a;--warn-dim:rgba(255,199,90,.12);--r:8px}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
font:13px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.bar{display:flex;gap:12px;align-items:center;background:var(--surface);
border-bottom:1px solid var(--hair);padding:12px 16px;position:sticky;top:0;z-index:5}
.wrap{max-width:860px;margin:0 auto;padding:16px}
.panel{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r);
padding:12px 14px 14px;margin-bottom:14px}
.panel h2{margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.04em;
text-transform:uppercase;color:var(--ink2)}
.note{font-size:11px;color:var(--muted);line-height:1.6}
.cmd{padding:9px 0;border-bottom:1px solid var(--hair)}
.cmd:last-child{border-bottom:0}
.cmdline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
code{background:var(--plane);border:1px solid var(--hair2);border-radius:5px;
padding:4px 8px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
color:var(--ink);word-break:break-all}
.what{font-size:12px;margin-top:5px;line-height:1.55}
.hint{font-size:11px;margin-top:3px;font-style:italic}
.muted{color:var(--muted)}
.tag{font-size:10px;text-transform:uppercase;letter-spacing:.05em;
padding:2px 7px;border-radius:999px;white-space:nowrap}
.tag.ok{background:var(--good-dim);color:var(--good)}
.tag.warn{background:var(--warn-dim);color:var(--warn)}
.tag.bad{background:var(--bad-dim);color:var(--bad);font-weight:600}
button{background:var(--surface2);color:var(--ink);border:1px solid var(--hair);
border-radius:5px;padding:3px 9px;font-size:11px;cursor:pointer}
button:hover{border-color:var(--hair2)}
a{color:var(--ink2)}
table{width:100%;border-collapse:collapse;margin-top:6px}
td{padding:5px 6px;font-size:12px;border-bottom:1px solid var(--hair);vertical-align:top}
td:first-child{white-space:nowrap;width:1%}
</style></head><body>
<div class="bar">
  <b>Sweep agent</b><span class="muted">commands</span>
  <span style="flex:1"></span>
  <a href="/?token=${token}" style="font-size:12px;text-decoration:none;padding:5px 10px;border:1px solid var(--hair);border-radius:6px">Back to dashboard</a>
</div>
<div class="wrap">
  <div class="panel" style="border-color:var(--hair2)">
    <h2>Start here</h2>
    <p class="note" style="margin-top:0">Two processes cover normal use: <code>sweep:control</code> for the
    dashboard, and <code>sweep:shadow</code> alongside it to collect evidence against the real market. Then
    <code>sweep:learn</code> to read what it found. Everything else is diagnostics.</p>
    <p class="note">Only two commands on this page can spend money, and both are marked. Shadow reads no
    credentials and has no code path to an order.</p>
  </div>
  ${groups}
  <div class="panel">
    <h2>Environment</h2>
    <table><tbody>
      ${ENV_VARS.map((v) => `<tr><td><code>${esc(v.name)}</code></td><td class="muted">${esc(v.what)}${
        v.danger ? ` <span class="tag bad">real money</span>` : ""}</td></tr>`).join("")}
    </tbody></table>
  </div>
  <div class="panel">
    <h2>Where the data lives</h2>
    <table><tbody>
      <tr><td><code>data/sweep-trades.jsonl</code></td><td class="muted">Post-mortem of every closed trade.</td></tr>
      <tr><td><code>data/sweep-shadow.jsonl</code></td><td class="muted">Shadow trades, scored at 60s / 300s / 900s.</td></tr>
      <tr><td><code>data/sweep-paper.jsonl</code></td><td class="muted">The evidence log's samples.</td></tr>
      <tr><td><code>data/sweep-tuning.jsonl</code></td><td class="muted">Every cap change, who made it and why. Append-only.</td></tr>
      <tr><td><code>data/sweep-positions.json</code></td><td class="muted">What this process remembers about open positions.</td></tr>
      <tr><td><code>data/sweep-limits.json</code></td><td class="muted">The risk limits, as edited on the dashboard.</td></tr>
      <tr><td><code>data/sweep-symbols.json</code></td><td class="muted">Contracts being watched, as picked on the dashboard. Overrides SWEEP_SYMBOLS once written.</td></tr>
      <tr><td><code>data/sweep-news.json</code></td><td class="muted">Headlines collected by the control server. Forums and social are counted, never stored.</td></tr>
    </tbody></table>
  </div>
</div>
<script>
for (const b of document.querySelectorAll(".copy")) {
  b.onclick = async () => {
    // navigator.clipboard needs a secure context, which http://127.0.0.1 is —
    // but a tunnelled or LAN-bound origin is not, so fall back rather than
    // leaving a button that silently does nothing.
    const text = b.dataset.cmd;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } finally { ta.remove(); }
    }
    b.textContent = "copied"; setTimeout(() => { b.textContent = "copy"; }, 1200);
  };
}
</script>
</body></html>`;
}

function html(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sweep agent control</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{
/* Navy rather than neutral grey. The hue is carried through the surfaces so the
   page reads as one material with depth, instead of flat panels floating on
   black — and it leaves green and red doing nothing but signalling money. */
--plane:#0a0f1c;--surface:#101728;--surface2:#182136;--raised:#1e2942;
--ink:#eef2fa;--ink2:#a9b6cf;--muted:#6f7d99;
--hair:rgba(140,170,220,.14);--hair2:rgba(140,170,220,.26);
/* Money colours, tuned against navy: the default greens go muddy on a blue
   ground, so both are pushed toward the cyan/rose end to stay legible. */
--good:#3ddc97;--good-dim:rgba(61,220,151,.13);
--bad:#ff6b81;--bad-dim:rgba(255,107,129,.13);
--warn:#ffc75a;--warn-dim:rgba(255,199,90,.12);
--liq:#5b9dff;--forced:#ff8a5c;--accent:#5b9dff;--accent-ink:#04101f;--r:8px}
*{box-sizing:border-box}body{margin:0;color:var(--ink);
background:var(--plane);
background-image:radial-gradient(1200px 600px at 50% -10%,rgba(91,157,255,.07),transparent 60%);
background-attachment:fixed;
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
.closebar{display:flex;gap:10px;align-items:center;margin-bottom:12px}
.thread{max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:4px}
.msg{padding:8px 10px;border-radius:var(--r);border:1px solid var(--hair);font-size:12.5px;line-height:1.45}
.msg.you{background:var(--plane);margin-left:18%}
.msg.claude{background:rgba(79,143,247,.07);border-color:rgba(79,143,247,.3);margin-right:18%}
.msg .who{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);margin-bottom:3px}
.msg .ctx{font-size:10.5px;color:var(--dim);margin-top:4px;font-variant-numeric:tabular-nums}
button.danger{background:var(--bad);border-color:var(--bad);color:#fff;font-weight:600}
button.danger:hover:not(:disabled){filter:brightness(1.12)}
button.danger:disabled{opacity:.4}
.symbar{display:flex;gap:8px;align-items:center;margin-top:12px}
.symq{flex:1 1 auto}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.chip{display:inline-flex;align-items:center;gap:7px;padding:5px 9px;border-radius:999px;
border:1px solid var(--hair);background:var(--plane);font-size:12px;color:var(--ink);
font-variant-numeric:tabular-nums}
.chip.warn{border-color:rgba(255,199,90,.55)}
.chip.bad{border-color:rgba(208,59,59,.5)}
.chip .x{cursor:pointer;color:var(--dim);font-weight:700;line-height:1;padding:0 1px}
.chip .x:hover{color:var(--bad)}
.chip .meta{color:var(--dim);font-size:11px}
/* A result is a button because clicking it does something; a watched chip is
   not, because only its × does. Making both buttons invited the click that
   removes a desk to land on the whole chip. */
button.chip{cursor:pointer}
button.chip:hover:not(:disabled){border-color:var(--accent)}
button.chip:disabled{opacity:.45;cursor:default}
.desk{flex:1 1 200px;min-width:180px;text-align:left;padding:9px 11px;border-radius:var(--r);
border:1px solid var(--hair);background:var(--plane);cursor:pointer;font:inherit;color:var(--ink)}
.desk:hover{border-color:var(--ink)}
.desk.on{border-color:var(--good);background:rgba(46,160,67,.07)}
.desk .sym{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px}
.desk .px{font-size:19px;font-variant-numeric:tabular-nums;margin:3px 0 1px}
.desk .sub{font-size:11px;color:var(--dim)}
.desk .hold{font-size:11px;margin-top:3px}

/* Grouped inputs. The flat row gave a stop distance and a daily loss cap the
   same visual weight, which is how a form of fifteen numbers stops being read
   at all. Each group answers one question. */
.fieldset{border:1px solid var(--hair);border-radius:var(--r);padding:14px 14px 12px;margin-top:12px;position:relative;background:var(--plane)}
.fieldset+.fieldset{margin-top:14px}
.legend{position:absolute;top:-8px;left:12px;background:var(--surface);padding:0 7px;font-size:10px;
letter-spacing:.08em;text-transform:uppercase;color:var(--ink2);font-weight:600}
.fields{display:grid;gap:10px 14px;grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}
.fields label{gap:4px}
/* The unit belongs with the label, not in the operator's head. A stop that is a
   price move and a cap that is dollars looked identical without it. */
label i{font-style:normal;color:var(--muted);font-size:10px;display:block;line-height:1.3;min-height:1.3em}
input,select{background:var(--surface2);border:1px solid var(--hair);border-radius:5px;color:var(--ink);
padding:7px 9px;font:inherit;font-variant-numeric:tabular-nums;width:100%}
input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px rgba(79,143,247,.18)}
button{transition:border-color .12s,background .12s}
button.primary{background:var(--accent);border-color:var(--accent);color:#06131f;font-weight:600}
button.primary:hover:not(:disabled){background:#6ba1f8;border-color:#6ba1f8}
.panel h2{display:flex;align-items:center;gap:8px}
.tile{transition:background .12s}
.banner{line-height:1.5}
.banner:not(.bad):not(.warn){background:rgba(255,255,255,.03);border-color:var(--hair)}

/* --- money reads as money -------------------------------------------------
   Green and red are reserved for profit and loss and for the two states that
   are genuinely urgent. Everything else stays in the navy scale, so a red on
   this page always means the same thing. */
.pos{color:var(--good)}
.neg{color:var(--bad)}
.flat{color:var(--muted)}
.chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;
font-size:11px;font-weight:600;border:1px solid transparent}
.chip.pos{background:var(--good-dim);border-color:rgba(61,220,151,.3)}
.chip.neg{background:var(--bad-dim);border-color:rgba(255,107,129,.32)}
.chip.warnc{background:var(--warn-dim);border-color:rgba(255,199,90,.3);color:var(--warn)}
td.money{font-variant-numeric:tabular-nums;font-weight:600}
.tile.hi{background:linear-gradient(180deg,var(--raised),var(--surface))}
.panel{box-shadow:0 1px 0 rgba(255,255,255,.03) inset}
.bar{background:linear-gradient(180deg,var(--surface2),var(--surface))}
.dot.ok{box-shadow:0 0 0 3px var(--good-dim)}
.dot.degraded{box-shadow:0 0 0 3px var(--warn-dim)}
.dot.blind{box-shadow:0 0 0 3px var(--bad-dim)}
.fieldset{background:rgba(10,15,28,.55)}
</style></head><body><div class="wrap">

<div class="bar">
  <b>Sweep agent</b>
  <span id="mode" class="mode none">—</span>
  <span class="row" style="gap:6px"><i id="hdot" class="dot blind"></i><span id="health" class="muted">connecting…</span></span>
  <span class="muted" id="uptime"></span>
  <span style="flex:1"></span>
  <a href="/commands?token=${token}" style="color:var(--ink2);font-size:12px;text-decoration:none;padding:5px 10px;border:1px solid var(--hair);border-radius:6px">Commands</a>
  <button id="btnStart">Start</button>
  <button id="btnStop">Stop</button>
  <button id="btnRefresh">Refresh account</button>
  <button id="btnKill" class="danger">Kill</button>
</div>
<div id="provBanner"></div>

<div id="venueNote"></div>
<div id="protNote"></div>
<div id="execNote"></div>
<div class="panel" id="livePanel" style="display:none">
  <h2>Open position <span id="liveSym" class="muted" style="font-weight:400;font-size:11px"></span></h2>
  <!-- Top of the panel and outside the bracket fieldset. This is the control an
       operator reaches for when something is going wrong, and it was previously
       three clicks down inside a group labelled "Move a bracket". -->
  <div class="closebar">
    <button id="btnCloseNow" class="danger" type="button">Close at market</button>
    <input id="closeLimitPx" type="number" step="0.01" placeholder="or a price to close at"
      style="max-width:200px">
    <button id="btnCloseLimit" type="button">Close at limit</button>
    <span id="closeNowWhat" class="muted"></span>
  </div>
  <div id="liveTiles" class="tiles"></div>
  <div id="holdNote" style="margin-top:10px"></div>
  <div class="fieldset" style="margin-top:12px">
    <div class="legend">Move a bracket</div>
    <div class="fields" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
      <label>Stop price <i id="liveStopHint">&nbsp;</i><input id="liveStop" type="number" step="0.01"></label>
      <label>Target price <i id="liveTargetHint">&nbsp;</i><input id="liveTarget" type="number" step="0.01"></label>
      <label>&nbsp;<button id="btnMoveBracket" class="primary">Move</button></label>
    </div>
  </div>
  <p class="note">Both are placed and maintained automatically — this is only for overriding them. A moved stop
  cancels the break-even ratchet for this position, because having the machine move it back under you is the
  opposite of an override. Blank means leave that one alone.</p>
  <div id="liveOut" style="margin-top:8px"></div>
</div>

<div id="renderErr" style="display:none;margin-bottom:12px"></div>

<div class="panel" id="deskPanel">
  <h2>Contracts <span id="symCount" class="muted" style="font-weight:400;font-size:11px"></span></h2>
  <div id="desks" class="deskstrip"></div>
  <p class="note" id="disNote"></p>

  <div class="symbar">
    <input id="symQ" class="symq" type="text" autocomplete="off" spellcheck="false"
      placeholder="Add a contract — type a ticker or a name (INTC, BTC, NVDA)">
    <button id="symClear" class="ghost" type="button">clear</button>
  </div>
  <div id="symWatched" class="chips"></div>
  <div id="symResults" class="chips"></div>
  <p class="note" id="symNote"></p>

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
    <!-- What the day has actually done. Absent until now, which is a strange
         gap in a program whose whole purpose is to make money: every number on
         the page described what might happen next and none described what had
         already happened. -->
    <div class="tiles" id="dayTiles" style="margin-top:10px"></div>
    <p class="note" id="dayScope"></p>
    <p class="note" id="acctNote"></p>
    <!-- The automatic check catches a reset within one account sweep. This is
         for the case where the operator knows the history is meaningless and
         the arithmetic does not — a deposit is explained by a ledger row and
         correctly leaves the window alone. -->
    <button id="btnRebase" class="ghost" type="button" style="margin-top:8px">Restart day counting from now</button>
  </div>
</div>

<div class="panel">
  <h2>What the venue refused</h2>
  <div id="cxHalt"></div>
  <div class="tiles">
    <div class="tile"><span class="k">Margin headroom</span><span class="v" id="cxHead">—</span><span class="d">of free collateral kept uncommitted</span></div>
    <div class="tile"><span class="k">Clean streak</span><span class="v" id="cxClean">—</span><span class="d">orders accepted since the last rejection</span></div>
  </div>
  <div id="cxSummary" style="margin-top:10px"></div>
  <table style="margin-top:10px"><thead><tr><th style="text-align:left">When</th><th style="text-align:left">Contract</th><th style="text-align:left">What</th><th style="text-align:left">Detail</th></tr></thead>
  <tbody id="cxRecent"><tr><td colspan="4" class="muted">nothing refused yet</td></tr></tbody></table>
  <p class="note">Rejections are answered immediately where a retry can help, and repeats move the cap that
  actually governs them. A clock, a key, an unsigned agreement or a ban are never answered by trading smaller —
  they stop the agent instead, because no size works until they are fixed.</p>
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
  <h2>What the losses have in common</h2>
  <div class="tiles">
    <div class="tile"><span class="k">Closed trades</span><span class="v" id="lnN">—</span><span class="d" id="lnND">recorded with full conditions</span></div>
    <div class="tile"><span class="k">Win rate</span><span class="v" id="lnWin">—</span><span class="d" id="lnWinD">95% interval</span></div>
    <div class="tile"><span class="k">Expectancy</span><span class="v" id="lnExp">—</span><span class="d" id="lnExpD">per trade, in multiples of risk</span></div>
    <div class="tile"><span class="k">Net</span><span class="v" id="lnNet">—</span><span class="d">after fees and funding</span></div>
  </div>
  <div id="lnAnatomy" style="margin-top:12px"></div>
  <div id="lnRecs" style="margin-top:12px"></div>
  <div id="lnSplits" style="margin-top:12px"></div>

  <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--hair)">
    <div class="row" style="gap:12px;align-items:center">
      <label style="display:flex;gap:7px;align-items:center;font-size:12px;cursor:pointer">
        <input type="checkbox" id="tuneOn" style="width:auto;margin:0"> Let it move the caps on its own
      </label>
      <span id="tuneState" class="muted" style="font-size:11px"></span>
    </div>
    <div id="tunePending" style="margin-top:10px"></div>
    <div id="tuneHeld" style="margin-top:8px"></div>
    <div id="tuneHistory" style="margin-top:10px"></div>
    <p class="note">One setting at a time, inside hard bounds, and never the daily loss cap, the cooldown or the
    trade ceiling — those stay where you put them. A setting you edit by hand is left alone for 12 closes.</p>
  </div>
  <table style="margin-top:10px"><thead><tr><th style="text-align:left">Closed</th><th style="text-align:left">Trade</th><th>Net</th><th>Held</th><th style="text-align:left">Best / worst</th><th style="text-align:left">Book</th><th style="text-align:left">Why it ended</th></tr></thead>
  <tbody id="lnTrades"><tr><td colspan="7" class="muted">no closed trades recorded yet</td></tr></tbody></table>
  <p class="note" id="lnNote"></p>
</div>

<div class="panel">
  <h2>Background runs</h2>
  <div class="tiles">
    <div class="tile"><span class="k">Evidence log</span><span class="v" id="rPaper">—</span><span class="d" id="rPaperD">npm run sweep:paper</span></div>
    <div class="tile"><span class="k">Shadow trades</span><span class="v" id="rShadow">—</span><span class="d" id="rShadowD">npm run sweep:shadow</span></div>
    <div class="tile"><span class="k">Shadow net P&amp;L</span><span class="v" id="rNet">—</span><span class="d" id="rNetD">after fees</span></div>
    <div class="tile"><span class="k">News + social</span><span class="v" id="rNews">—</span><span class="d" id="rNewsD">sources live</span></div>
  </div>
  <table style="margin-top:10px"><thead><tr><th style="text-align:left">Time</th><th style="text-align:left">Headline</th><th style="text-align:left">Source</th><th style="text-align:left">Impact</th></tr></thead>
  <tbody id="rNewsRows"><tr><td colspan="4" class="muted">nothing collected yet</td></tr></tbody></table>
  <p class="note" id="rNewsNote"></p>
  <table style="margin-top:10px"><thead><tr><th style="text-align:left">Time</th><th style="text-align:left">Trade</th><th style="text-align:left">Signal</th><th>Net</th><th style="text-align:left">Outcome</th></tr></thead>
  <tbody id="rTrades"><tr><td colspan="5" class="muted">nothing recorded yet</td></tr></tbody></table>
  <p class="note" id="rNote"></p>
</div>

<div class="panel">
  <h2>Notes to Claude <span id="msgCount" class="muted" style="font-weight:400;font-size:11px"></span></h2>
  <div id="msgThread" class="thread"></div>
  <div class="symbar">
    <input id="msgText" class="symq" type="text" autocomplete="off"
      placeholder="Something look wrong? Type it here — it goes out with the state at this exact minute.">
    <button id="msgSend" class="primary" type="button">Send</button>
  </div>
  <p class="note" id="msgNote">Replies are not instant. This is not a chat window — a note is attached to the
  run and answered next time the analysis reads it, alongside the limits, refusals and log for the minute you
  wrote it. That context is the point; it is what a message in a chat window loses.</p>
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
  <div id="readyBox" style="margin-top:10px"></div>
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
  <!-- Grouped by what each rule governs rather than by when it was added.
       Flat, the form was fifteen numbers in a row with no indication that a
       stop distance and a daily loss cap answer completely different
       questions — and four of the rules had no field at all, so they could
       not be reached from here regardless. -->
  <div class="fieldset">
    <div class="legend">Every trade</div>
    <div class="fields">
      <label>Stop distance <i>% price move</i><input id="stopLossPct" type="number" min="0.05" step="0.05"></label>
      <label>Risk per trade <i>% of collateral</i><input id="riskPerTradePct" type="number" min="0.01" max="25" step="0.5"></label>
      <label>Minimum reward-to-risk <i>target ÷ stop</i><input id="minRewardRisk" type="number" min="0.1" max="10" step="0.1"></label>
      <label>Minimum reward vs fees <i>× the round trip</i><input id="minRewardOverFees" type="number" min="1.2" max="10" step="0.1"></label>
      <label>Move stop to break-even <i>% of the way to target · 0 = never</i><input id="breakEvenAtPct" type="number" min="0" max="100" step="5"></label>
      <label>Trail arms at <i>multiples of risk · 0 = no trail</i><input id="trailArmsAtR" type="number" min="0" max="10" step="0.5"></label>
      <label>Take part off at <i>multiples of risk · 0 = never</i><input id="scaleOutAtR" type="number" min="0" max="10" step="0.5"></label>
      <label>...how much <i>% of the position</i><input id="scaleOutFraction" type="number" min="0" max="90" step="10"></label>
      <label>Margin headroom <i>% of collateral kept free</i><input id="marginHeadroomPct" type="number" min="0" max="50" step="1"></label>
      <label>Max hold <i>minutes · 0 = no limit</i><input id="maxHoldMinutes" type="number" min="0" step="5"></label>
    </div>
  </div>

  <div class="fieldset">
    <div class="legend">Exposure</div>
    <div class="fields">
      <label>Max position <i>USD notional</i><input id="maxPositionUsd" type="number" min="0" step="10"></label>
      <label>Max leverage <i>ceiling; size is derived</i><input id="maxLeverage" type="number" min="1" max="20" step="1"></label>
      <label>Max open positions <i>at once, across contracts</i><input id="maxOpenPositions" type="number" min="0" step="1"></label>
      <label>Condition derates <i>thin book, session, events</i><select id="sizeDerateStrength">
        <option value="1">full — size down hard</option><option value="0.5">half — balanced</option><option value="0">off — size on the setup only</option></select></label>
    </div>
  </div>

  <div class="fieldset">
    <div class="legend">Stopping for the day</div>
    <div class="fields">
      <label>Max daily loss <i>USD, net of fees</i><input id="maxDailyLossUsd" type="number" min="0" step="10"></label>
      <label>Max trades per day <i>closed round trips</i><input id="maxTradesPerDay" type="number" min="0" step="1"></label>
      <label>Cooldown after a loss <i>minutes</i><input id="lossCooldownMin" type="number" min="0" step="5"></label>
      <label>When Nasdaq is shut<select id="requireCashOpen">
        <option value="false">trade, sized down</option><option value="true">do not trade</option></select></label>
    </div>
  </div>

  <div class="row" style="gap:10px;align-items:center;margin-top:12px">
    <label style="width:130px">Trading armed<select id="tradingEnabled">
      <option value="false">disarmed</option><option value="true">armed</option></select></label>
    <button id="btnLimits" class="primary">Save limits</button>
    <button id="btnReset" title="Restore the values derived from your own trade history">Reset to agreed</button>
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
/* One rule for every figure that represents money: green ahead, red behind,
   muted at zero. Applied through a class rather than an inline colour so the
   palette stays in one place. */
const sign=v=>v===null||v===undefined||!isFinite(v)?"flat":v>0?"pos":v<0?"neg":"flat";
const money=(v,d)=>'<span class="'+sign(v)+'">'+usd(v)+"</span>";
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
/* Set while a bracket price is being typed, so the poll does not overwrite it. */
let liveDirty=false;
/* Which contract the order controls point at; the server is the authority and
   this mirrors it so a request can name it explicitly rather than relying on
   server-side state that another tab may have changed. */
let focusSymbol="";
for(const id of ["maxPositionUsd","maxLeverage","maxDailyLossUsd","maxOpenPositions","stopLossPct",
  "riskPerTradePct","maxHoldMinutes","minRewardRisk","breakEvenAtPct","maxTradesPerDay","lossCooldownMin",
  "trailArmsAtR","scaleOutAtR","scaleOutFraction","marginHeadroomPct",
  "minRewardOverFees"])
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
  $("lAcc").innerHTML=L.accepted?'<span class="pos">'+L.accepted+"</span>":"0";
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

  /* Can this be armed at all, and if not, what is in the way.
     Everything here is reported somewhere else already — that was the problem.
     Spread across diagnostics, a health dot and a refusal tally, none of which
     answers the one question asked immediately before arming. */
  const R=s.readiness;
  if(R){
    const esc=t=>String(t).replace(/</g,"&lt;");
    const list=(items,label)=>items.length
      ? '<div style="margin-top:4px"><span class="muted" style="font-size:11px">'+label+"</span>"+
        items.map(x=>'<div style="font-size:12px">· '+esc(x)+"</div>").join("")+"</div>"
      : "";
    $("readyBox").innerHTML= R.ready&&R.armed
      ? '<div class="banner"><b>Armed.</b><span>Orders go out when a setup passes every check.</span></div>'
      : R.ready
        ? '<div class="banner"><b>Ready.</b><span>Nothing is in the way — press Start trading.</span></div>'
        : '<div class="banner '+(R.blockers.length?"bad":"warn")+'" style="display:block"><b>'+
          (R.blockers.length?"Not ready to arm.":"Nearly ready — still warming up.")+"</b>"+
          list(R.blockers,"HAS TO BE FIXED")+list(R.waiting,"WAITING ON")+"</div>";
  }

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
  // Always shown now: the panel hosts the contract picker, so hiding it on a
  // single desk hid the only way to add a second one.
  $("mktSym").textContent=ds.length>1?("— "+s.focus):"";
  {
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
      b.onclick=async()=>{ safeRender(await api("/api/focus",{method:"POST",body:JSON.stringify({symbol:b.dataset.sym})})); };
    }

    // How the group is behaving as a group. Stated plainly because the number
    // that matters is the correlation: below the threshold the divergence
    // reading is switched off entirely, and it is better to see that than to
    // wonder why a factor never appears.
    const warm=ds.filter(d=>d.dislocation&&d.dislocation.warm);
    if(ds.length<2){
      $("disNote").textContent="One contract. The cross-contract comparison needs at least two, and the "+
        "binding constraint here is how often a setup appears — adding a second roughly doubles that at unchanged risk.";
    } else if(warm.length===0){
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

  /* The open position, with its brackets editable in place.
     Hidden when flat, so the page does not carry a dead panel most of the day.
     The inputs are only refreshed while untouched — overwriting a half-typed
     price once a second makes the field unusable. */
  const pr=s.protection;
  const holding=pr.flat===false&&pr.side;
  $("livePanel").style.display=holding?"":"none";
  if(holding){
    $("liveSym").textContent="— "+(s.focus||"")+" "+pr.side;
    const pnlPct=pr.entryPrice&&pr.markPrice
      ? ((pr.markPrice-pr.entryPrice)/pr.entryPrice*100)*(pr.side==="long"?1:-1) : null;
    const tile=(k,v,d,col)=>'<div class="tile"><span class="k">'+k+'</span><span class="v"'+
      (col?' style="color:'+col+'"':"")+">"+v+'</span><span class="d">'+d+"</span></div>";
    $("liveTiles").innerHTML=
      tile("Entry",n(pr.entryPrice),"held "+pr.heldMin+" min"+(s.limits.maxHoldMinutes?" of "+s.limits.maxHoldMinutes:""))+
      tile("Mark",n(pr.markPrice),pnlPct===null?"—":n(pnlPct,2)+"% "+(pnlPct>=0?"ahead":"behind"),
        pnlPct===null?null:pnlPct>=0?"var(--good)":"var(--bad)")+
      tile("Stop",pr.stopPrice?n(pr.stopPrice):"NONE",
        pr.stopPrice?n(pr.stopDistancePct,2)+"% away"+(pr.ratcheted?" · at break-even":""):"unprotected",
        pr.stopPrice?(pr.ratcheted?"var(--good)":null):"var(--bad)")+
      tile("Target",pr.targetPrice?n(pr.targetPrice):"none",
        pr.targetPrice?n(pr.targetDistancePct,2)+"% away":"closes on the stop or the time limit",
        pr.targetPrice?null:"var(--warn)");

    /* Why it is still open, and how long it has earned.
       The deadline moves with the trade rather than the trade being moved by
       the deadline, so a static "30 min" would be actively misleading here. */
    const H=pr.hold;
    $("holdNote").innerHTML = H
      ? '<div class="banner" style="display:block"><b>'+
        (H.progress>=0.55?"Working — the limit has been extended.":
         H.thesisHealth<0.5?"The reasoning behind this is fading.":"Holding.")+"</b>"+
        '<div style="font-size:12px;margin-top:5px">'+
        '<span class="'+(H.progress>0?"pos":H.progress<0?"neg":"flat")+'">'+n(H.progress*100,0)+
        "% to target</span> · thesis "+n(H.thesisHealth*100,0)+"% intact · limit now "+
        n(H.deadlineMs/60000,0)+" min"+
        (H.notes&&H.notes.length
          ? '<div class="muted" style="font-size:11px;margin-top:4px">'+
            H.notes.map(x=>"· "+String(x).replace(/</g,"&lt;")).join("<br>")+"</div>"
          : "")+
        "</div></div>"
      : "";
    if(document.activeElement!==$("liveStop")&&!liveDirty) $("liveStop").value=pr.stopPrice??"";
    if(document.activeElement!==$("liveTarget")&&!liveDirty) $("liveTarget").value=pr.targetPrice??"";
    $("liveStopHint").textContent=pr.side==="long"?"must be below "+n(pr.markPrice):"must be above "+n(pr.markPrice);
    $("liveTargetHint").textContent=pr.side==="long"?"must be above "+n(pr.markPrice):"must be below "+n(pr.markPrice);
  } else { liveDirty=false; }

  $("protNote").innerHTML =
    pr.error ? '<div class="banner warn"><b>Cannot check protection.</b><span>'+pr.error+'</span></div>'
    : pr.protected===false ? '<div class="banner bad"><b>OPEN POSITION WITH NO STOP-LOSS.</b><span>'+
        'Nothing will close this if price runs against you except liquidation. '+
        '<button id="btnProtect" style="margin-left:8px">Place stop now</button></span></div>'
    : pr.protected===true && pr.flat===false ? '<div class="banner warn"><span>Position protected — '+pr.reason+'</span></div>'
    : "";
  const bp=document.getElementById("btnProtect");
  if(bp) bp.onclick=async()=>safeRender(await api("/api/protect",{method:"POST",body:JSON.stringify({symbol:"all"})}));

  $("execNote").innerHTML=s.execution.available?"":
    '<div class="banner warn"><b>Read-only.</b><span>'+s.execution.reason+'</span></div>';

  /*
   * Provenance, above everything.
   *
   * Two failures this exists to make impossible: a balance from the wrong
   * wallet or a stale read looking current, and a contract that is the default
   * rather than the one being tested. Both were invisible before because the
   * page showed values without showing where they came from.
   */
  const pv=s.provenance;
  if(pv){
    const warn=[];
    if(pv.symbolsAreDefault){
      warn.push("<b>No contract was chosen</b>, so this defaulted to "+pv.symbolsConfigured.join(", ")+
        ". Pick one in Contracts above — it takes effect immediately, no restart.");
    }
    const running=pv.symbolsRunning.join(",");
    if(running && running!==pv.symbolsConfigured.join(",")){
      warn.push("<b>Configured "+pv.symbolsConfigured.join(", ")+" but running "+running+".</b>");
    }
    // A minute is three missed sweeps. Past that the number on screen is not
    // what the account holds, and saying "stale" beats showing it plainly.
    if(pv.staleForMs!==null&&pv.staleForMs>60000){
      warn.push("<b>The account has not been read for "+Math.round(pv.staleForMs/1000)+"s</b> — "+
        "the balance and positions below are stale."+(s.account.error?" "+String(s.account.error).replace(/</g,"&lt;"):""));
    }
    if(pv.staleForMs===null&&s.hasCredentials){
      warn.push("<b>The account has never been read.</b>"+(s.account.error?" "+String(s.account.error).replace(/</g,"&lt;"):""));
    }
    // split rather than a regex: this string is inside a template literal, and
    // an escaped slash there resolves to a bare slash, which closes the regex.
    const host=String(pv.venue).split("//").pop();
    $("provBanner").innerHTML=
      '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;padding:7px 12px;margin-bottom:12px;'+
      'background:var(--surface);border:1px solid '+(pv.live?"var(--bad)":"var(--hair)")+';border-radius:var(--r);font-size:11px">'+
        '<span class="muted">signing against</span> <b style="color:'+(pv.live?"var(--bad)":"var(--ink)")+'">'+host+
          (pv.live?" — REAL MONEY":"")+'</b>'+
        '<span class="muted">balance is the</span> <b>'+pv.wallet+'</b> <span class="muted">wallet</span>'+
        '<span class="muted">watching</span> <b>'+(running||pv.symbolsConfigured.join(", "))+'</b>'+
        '<span class="muted">read '+(pv.staleForMs===null?"never":Math.round(pv.staleForMs/1000)+"s ago")+'</span>'+
      '</div>'+
      warn.map(w=>'<div class="banner warn" style="margin-bottom:10px"><span class="icon" style="color:var(--warn)">!</span><div>'+w+'</div></div>').join("");
  }

  const m=s.market;
  $("mid").textContent=n(m?m.mid:null);
  $("session").textContent=m?"Nasdaq "+m.session:"—";
  $("lwi").textContent=m?n(m.lwi,2):"—";
  $("lwiSides").textContent=m?(m.warm?"":"cold · ")+"bid "+n(m.lwiBid,2)+" / ask "+n(m.lwiAsk,2):"—";
  $("riskDown").textContent=m&&m.riskDown!==null?n(m.riskDown,0):"—";
  $("riskUp").textContent=m&&m.riskUp!==null?n(m.riskUp,0):"—";
  $("below").textContent=m&&m.nearestBelow?"→ "+n(m.nearestBelow):"no level below";
  $("above").textContent=m&&m.nearestAbove?"→ "+n(m.nearestAbove):"no level above";

  /*
   * The focused contract's price, in the browser tab.
   *
   * Price first because tabs truncate from the right, and the four characters
   * of "USDT" dropped because they never change and characters are scarcer
   * here than anywhere else on the page.
   *
   * When the feed is not tradeable the price is dropped rather than frozen. A
   * number in a tab is read as current — that is the whole reason to put one
   * there — and this tab belongs to the window that places orders, so a stale
   * price glanced at here is the one that gets acted on. The page itself can
   * afford to show a last-known value beside a red health dot; the tab has no
   * room for the dot.
   *
   * An armed session says so, because "is it running" is the question this tab
   * gets glanced at to answer more than any other.
   */
  const tick_=s.focus?String(s.focus).replace(/USDT$|USDC$/,""):"sweep";
  const liveMid=s.health&&s.health.tradeable&&m&&m.mid?n(m.mid):null;
  document.title=(armed?"● ":"")+(liveMid?liveMid+" "+tick_:tick_+" — no data");

  const a=s.account;
  $("avail").textContent=usd(a.availableBalance);
  $("upnl").innerHTML=money(a.unrealizedPnl);
  // Margin ratio is the one non-PnL number that earns a colour: past 50% a
  // adverse move starts threatening the whole account rather than the position.
  $("mratio").innerHTML=a.marginRatio===null?"—"
    :'<span class="'+(a.marginRatio>0.5?"neg":a.marginRatio>0.25?"warnc":"flat")+'">'+
      (a.marginRatio*100).toFixed(1)+"%</span>";
  $("npos").textContent=a.positions.length;
  $("acctNote").textContent=a.error?("account: "+a.error):(a.at?"updated "+new Date(a.at).toLocaleTimeString():"");

  /* Today, netted. The realised figure is gross of costs, so fees and funding
     are shown beside it rather than folded in — a day that looks flat and paid
     forty dollars in commission is not flat, and that distinction is the whole
     reason the fee budget exists. */
  const D=s.day;
  if(D&&D.trades!==undefined){
    const net=(D.realisedPnl||0)-(D.fees||0)-(D.funding||0);
    const capLeft=s.limits.maxDailyLossUsd>0?s.limits.maxDailyLossUsd-(D.drawdown||0):null;
    const tile=(k,inner,d)=>'<div class="tile"><span class="k">'+k+'</span><span class="v">'+inner+
      '</span><span class="d">'+d+"</span></div>";
    $("dayTiles").innerHTML=
      tile("Today, net",money(net),"after "+usd(D.fees||0)+" fees"+((D.funding||0)?" and "+usd(D.funding)+" funding":""))+
      tile("Trades",String(D.trades||0),
        s.limits.maxTradesPerDay>0?"of "+s.limits.maxTradesPerDay+" allowed":"no cap set")+
      tile("Loss budget left",capLeft===null?"—":'<span class="'+(capLeft<=0?"neg":capLeft<(s.limits.maxDailyLossUsd*0.34)?"warnc":"pos")+'">'+usd(Math.max(0,capLeft))+"</span>",
        capLeft===null?"no cap set":"of "+usd(s.limits.maxDailyLossUsd))+
      tile("Cooldown",D.cooldownLeftMin>0?'<span class="warnc">'+Math.ceil(D.cooldownLeftMin)+"m</span>":"none",
        D.lastLossAt?"since the last loss":"no loss yet today");
    /*
     * Say when "today" stopped meaning midnight.
     *
     * A P&L figure covering a different window than its label claims is the
     * kind of wrong that gets believed, and after an account reset that is
     * exactly what it is.
     */
    $("dayScope").innerHTML=D.rebased
      ? '<span class="warnc">Counting from '+new Date(D.countingFrom).toLocaleTimeString()+
        ', not midnight</span> — '+String(D.rebaseReason||"").replace(/</g,"&lt;")
      : "";
  } else {
    $("dayTiles").innerHTML="";
    $("dayScope").textContent="";
  }
  $("positions").innerHTML=a.positions.length?a.positions.map(p=>
    "<tr><td>"+p.symbol+'</td><td class="'+(p.amt>0?"pos":"neg")+'">'+n(p.amt,3)+"</td><td>"+n(p.entry)+
    "</td><td>"+liqCell(p)+'</td><td class="money">'+money(p.pnl)+"</td></tr>").join("")
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
    $("minRewardRisk").value=s.limits.minRewardRisk;
    $("minRewardOverFees").value=s.limits.minRewardOverFees;
    $("breakEvenAtPct").value=s.limits.breakEvenAtPct;
    $("trailArmsAtR").value=s.limits.trailArmsAtR;
    $("scaleOutAtR").value=s.limits.scaleOutAtR;
    $("scaleOutFraction").value=s.limits.scaleOutFraction;
    $("marginHeadroomPct").value=s.limits.marginHeadroomPct;
    $("maxTradesPerDay").value=s.limits.maxTradesPerDay;
    $("lossCooldownMin").value=s.limits.lossCooldownMin;
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
  // Two ways the stop makes trading arithmetically impossible. Too wide: the
  // target it demands sits outside the mapped band, so no level can qualify.
  // Too tight: the target is worth less than the round trip, so no level is
  // worth taking. Both present as a quiet market rather than as a setting.
  const impossible=need>12;
  const roundTripPct=0.10;              // VIP-0 taker in and out
  const overFees=(s.limits&&s.limits.minRewardOverFees)||2;
  const tooTight=!impossible&&need<roundTripPct*overFees;

  box.innerHTML='<div class="banner '+(impossible||tooTight?"bad":"")+'" style="display:block">'+
    "<b>"+(impossible||tooTight
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
        : tooTight
        ? '<b style="color:var(--bad)">The round trip costs about '+n(roundTripPct,2)+
          "%, so a "+n(need,2)+"% target is worth less than the fees needed to reach it — every setup "+
          "will be refused for a reward that could never clear its own costs. Set the stop to at least "+
          n(roundTripPct*overFees/Math.max(s.limits?s.limits.minRewardRisk:1.2,0.1),2)+"%.</b>"
        : "Levels are mapped to ±12%, so that is reachable.")+
    "</div></div>";
}

/*
 * A render that throws must not leave the page looking wiped.
 *
 * render() populates the form fields near its end, so a ReferenceError anywhere
 * above them leaves every setting blank with no error visible — which reads as
 * "the update deleted my configuration" rather than as a bug on one line. It
 * happened, on a branch that only executes after an account reset, so no test
 * that did not simulate one could have caught it.
 */
function safeRender(s){
  try { render(s); }
  catch(err){
    console.error("render failed", err);
    const el=$("renderErr");
    if(el){
      el.style.display="";
      el.innerHTML='<div class="banner bad"><span><b>The page failed to draw.</b> '+
        'Your settings are safe on disk — this is a display bug, not lost configuration. '+
        String(err&&err.message||err).replace(/</g,"&lt;")+"</span></div>";
    }
  }
}

async function tick(){
  try{
    safeRender(await api("/api/status"));
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

$("btnStart").onclick=async()=>safeRender(await api("/api/engine/start",{method:"POST"}));
$("btnStop").onclick=async()=>safeRender(await api("/api/engine/stop",{method:"POST"}));
$("btnRefresh").onclick=async()=>safeRender(await api("/api/account/refresh",{method:"POST"}));
$("btnKill").onclick=async()=>{ if(confirm("Stop the engine and disarm trading?")) safeRender(await api("/api/kill",{method:"POST"})); };
$("btnLimits").onclick=async()=>{
  const body={maxPositionUsd:+$("maxPositionUsd").value,maxLeverage:+$("maxLeverage").value,
    maxDailyLossUsd:+$("maxDailyLossUsd").value,maxOpenPositions:+$("maxOpenPositions").value,
    tradingEnabled:$("tradingEnabled").value==="true",stopLossPct:+$("stopLossPct").value,
    requireCashOpen:$("requireCashOpen").value==="true",
    riskPerTradePct:+$("riskPerTradePct").value,maxHoldMinutes:+$("maxHoldMinutes").value,
    sizeDerateStrength:+$("sizeDerateStrength").value,minRewardRisk:+$("minRewardRisk").value,minRewardOverFees:+$("minRewardOverFees").value,
    breakEvenAtPct:+$("breakEvenAtPct").value,maxTradesPerDay:+$("maxTradesPerDay").value,
    trailArmsAtR:+$("trailArmsAtR").value,scaleOutAtR:+$("scaleOutAtR").value,
    scaleOutFraction:+$("scaleOutFraction").value,marginHeadroomPct:+$("marginHeadroomPct").value,
    lossCooldownMin:+$("lossCooldownMin").value};
  limitsDirty=false; safeRender(await api("/api/limits",{method:"POST",body:JSON.stringify(body)}));
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
  if(!r.error) safeRender(r);
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
  safeRender(r);
};
$("btnClose").onclick=async()=>{
  if(!confirm("Close the open "+(focusSymbol||"")+" position at market?"))return;
  const r=await api("/api/close",{method:"POST",body:JSON.stringify({symbol:focusSymbol})});
  $("pvOut").innerHTML=r.error
    ?'<div class="banner bad"><span>'+String(r.error).replace(/</g,"&lt;")+"</span></div>"
    :'<div class="banner"><span>Position closed at market.</span></div>';
  if(!r.error) safeRender(r);
};

for(const id of ["liveStop","liveTarget"]) $(id).addEventListener("input",()=>liveDirty=true);
$("btnMoveBracket").onclick=async()=>{
  const stopPrice=$("liveStop").value?+$("liveStop").value:undefined;
  const targetPrice=$("liveTarget").value?+$("liveTarget").value:undefined;
  if(stopPrice===undefined&&targetPrice===undefined){
    $("liveOut").innerHTML='<div class="banner warn"><span>Enter a stop or a target.</span></div>'; return; }
  $("btnMoveBracket").disabled=true;
  const r=await api("/api/bracket",{method:"POST",body:JSON.stringify({symbol:focusSymbol,stopPrice,targetPrice})});
  $("btnMoveBracket").disabled=false;
  liveDirty=false;
  $("liveOut").innerHTML=r.error
    ?'<div class="banner bad"><b>Refused.</b><span>'+String(r.error).replace(/</g,"&lt;")+"</span></div>"
    :'<div class="banner"><span>'+String(r.moved).replace(/</g,"&lt;")+"</span></div>";
  if(!r.error) safeRender(r);
};
/*
 * Rests reduce-only, so it can sit next to the automatic stop without the two
 * of them being able to close the position twice.
 */
$("btnCloseLimit").onclick=async()=>{
  const px=Number($("closeLimitPx").value);
  if(!(px>0)){ $("closeNowWhat").textContent="Enter a price first."; return; }
  if(!confirm("Rest an order to close the open "+(focusSymbol||"")+" position at "+px+"?"))return;
  $("btnCloseLimit").disabled=true;
  try{
    const r=await api("/api/close-limit",{method:"POST",body:JSON.stringify({symbol:focusSymbol,price:px})});
    if(r.error){
      $("liveOut").innerHTML='<div class="banner bad"><span>'+String(r.error).replace(/</g,"&lt;")+"</span></div>";
    } else {
      // Says which side of the book it landed on. "I set a limit" and "I paid
      // the spread" are different actions and the price decides which happened.
      $("liveOut").innerHTML='<div class="banner'+(r.marketable?" bad":"")+'"><span>'+
        String(r.reason).replace(/</g,"&lt;")+"</span></div>";
      $("closeLimitPx").value="";
      safeRender(r);
    }
  } finally { $("btnCloseLimit").disabled=false; }
};

$("btnCloseNow").onclick=async()=>{
  if(!confirm("Close the open "+(focusSymbol||"")+" position at market right now?"))return;
  $("btnCloseNow").disabled=true;
  try{
    const r=await api("/api/close",{method:"POST",body:JSON.stringify({symbol:focusSymbol})});
    $("liveOut").innerHTML=r.error
      ?'<div class="banner bad"><span>'+String(r.error).replace(/</g,"&lt;")+"</span></div>"
      :'<div class="banner"><span>Closed at market.</span></div>';
    if(!r.error) safeRender(r);
  } finally { $("btnCloseNow").disabled=false; }
};
$("btnReset").onclick=async()=>{
  if(!confirm("Put every risk setting back to the values derived from your trade history?\\n\\n"+
    "0.5% stop · 4% risk · 10x max leverage · 120 min max hold · 1 position at a time · "+
    "8 trades a day · 15 min loss cooldown · derates at half.\\n\\n"+
    "Max position and max daily loss are recalculated from your balance. Trading is disarmed."))return;
  limitsDirty=false;
  const rr=await api("/api/limits/reset",{method:"POST"});
  safeRender(rr);
  if(rr.capsProblem){
    alert("Settings were reset, but the caps could not be derived. "+rr.capsProblem+
      " — nothing can be sized until max position is a number. It retries every 20 seconds, "+
      "or set it by hand in Risk limits.");
  }
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
  safeRender(r);
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

  const nw=r.news||{};
  const esc=(s)=>String(s).replace(/</g,"&lt;");
  const nErr=nw.errors?nw.errors.split(" | ").length:0;
  $("rNews").textContent=nw.collecting?((nw.sources-nErr)+"/"+nw.sources):"off";
  $("rNews").style.color=nw.collecting?(nErr?"var(--warn)":"var(--good)"):"var(--bad)";
  $("rNewsD").textContent=nw.collecting
    ?("sources live · "+nw.recorded+" recorded"+(nw.inProcess?"":" (standalone)"))
    :"not collecting";
  const nrows=nw.latest||[];
  $("rNewsRows").innerHTML=nrows.length?nrows.map(n=>
    "<tr><td>"+new Date(n.at).toTimeString().slice(0,5)+"</td>"+
    "<td>"+esc(String(n.headline).slice(0,110))+"</td>"+
    "<td class='muted'>"+esc(n.source||"—")+"</td>"+
    "<td style='color:"+(n.impact==="high"?"var(--bad)":n.impact==="medium"?"var(--warn)":"var(--ink2)")+"'>"+n.impact+"</td></tr>"
  ).join(""):"<tr><td colspan='4' class='muted'>nothing collected yet — the first pass takes about a minute</td></tr>";
  // Velocity is the only thing the forums contribute, so it is the only thing
  // worth showing from them. The posts themselves are never recorded.
  $("rNewsNote").textContent=
    "Forums and social drive mention velocity only, never headlines."+
    (nw.velocity?"  Chatter now: "+nw.velocity+" (1x is normal).":"")+
    (nErr?"  Erroring: "+nw.errors.slice(0,200):"")+
    (nw.unavailable?"  Off: "+nw.unavailable:"");
}

const LOSS_LABEL={
  "never-worked":"never worked",
  "gave-it-back":"gave it back",
  "stopped-mid-move":"stopped mid-move",
  "cut-on-time":"cut by the hold engine",
  "unclassified":"unclassified"
};

async function learn(){
  const r=await api("/api/learn?symbol=all");
  if(!r.report) return;
  const rp=r.report, esc=(s)=>String(s).replace(/</g,"&lt;");

  $("lnN").textContent=rp.n;
  $("lnND").textContent=r.total===rp.n?"recorded with full conditions":rp.n+" of "+r.total+" shown";

  if(rp.n===0){
    // Cleared rather than left alone. This is reachable after trades exist —
    // filtering to a symbol that has none — and a stale win rate sitting above
    // an empty table reads as that symbol's record.
    $("lnWin").textContent="—"; $("lnWin").style.color="";
    $("lnWinD").textContent="95% interval";
    $("lnExp").textContent="—"; $("lnExp").style.color="";
    $("lnExpD").textContent="per trade, in multiples of risk";
  } else {
    $("lnWin").textContent=(rp.winRate*100).toFixed(0)+"%";
    // Coloured by the interval, not the point estimate. A 60% win rate whose
    // interval runs from 30% to 85% is not a good win rate, it is an unknown
    // one, and painting it green is the single easiest way for this panel to
    // mislead the person reading it.
    $("lnWin").style.color=rp.winLo>0.5?"var(--good)":rp.winHi<0.5?"var(--bad)":"var(--ink)";
    $("lnWinD").textContent=(rp.winLo*100).toFixed(0)+"–"+(rp.winHi*100).toFixed(0)+"% at 95%";
  }

  if(rp.n>0&&rp.expectancyR&&rp.expectancyR.n>=2){
    const e=rp.expectancyR;
    $("lnExp").textContent=(e.mean>=0?"+":"")+e.mean.toFixed(2)+"R";
    const spansZero=e.lo<0&&e.hi>0;
    $("lnExp").style.color=spansZero?"var(--warn)":e.mean>0?"var(--good)":"var(--bad)";
    $("lnExpD").textContent=spansZero
      ?"interval spans zero — not yet distinguishable from flat"
      :e.lo.toFixed(2)+" to "+e.hi.toFixed(2)+" per trade";
  }

  $("lnNet").textContent=(rp.netUsd>=0?"+":"")+"$"+Math.abs(rp.netUsd).toFixed(2);
  $("lnNet").style.color=rp.netUsd>=0?"var(--good)":"var(--bad)";

  $("lnAnatomy").innerHTML=rp.anatomy.length?rp.anatomy.map(a=>
    '<div style="border-left:3px solid var(--bad);background:var(--bad-dim);padding:8px 10px;margin-bottom:8px;border-radius:0 4px 4px 0">'+
      '<div style="font-size:12px;font-weight:600">'+(LOSS_LABEL[a.kind]||a.kind)+
        ' <span class="muted" style="font-weight:400">· '+a.count+' trade'+(a.count===1?"":"s")+
        ' · '+(a.share*100).toFixed(0)+'% of losses · -$'+a.costUsd.toFixed(2)+'</span></div>'+
      '<div class="muted" style="font-size:11px;margin-top:4px;line-height:1.5">'+esc(a.prescription)+'</div>'+
    '</div>').join(""):'<p class="note">No losing trades recorded yet.</p>';

  $("lnRecs").innerHTML=r.recommendations.length?r.recommendations.map(x=>
    '<div style="border-left:3px solid var(--warn);background:var(--warn-dim);padding:8px 10px;margin-bottom:8px;border-radius:0 4px 4px 0">'+
      '<div style="font-size:12px;font-weight:600">'+esc(x.setting)+
        (x.suggested!==null&&x.current!==null?' <span style="color:var(--warn)">'+x.current+' → '+x.suggested+'</span>':'')+
        ' <span class="muted" style="font-weight:400">['+x.support+']</span></div>'+
      '<div class="muted" style="font-size:11px;margin-top:4px;line-height:1.5">'+esc(x.why)+'</div>'+
    '</div>').join(""):"";

  // Only the splits the counts support get the accent. The rest are shown flat
  // and labelled undecided, because a ranked list with no visual difference
  // between "measured" and "suggestive" gets read top-down as findings.
  $("lnSplits").innerHTML=rp.splits.length?rp.splits.slice(0,6).map(s=>{
    const on=s.decisive;
    return '<div style="border-left:3px solid '+(on?"var(--good)":"var(--hair2)")+';padding:6px 10px;margin-bottom:6px;'+
      (on?'background:var(--good-dim);':'')+'border-radius:0 4px 4px 0">'+
      '<div style="font-size:12px">'+esc(s.label)+(on?' <span style="color:var(--good)">← worth acting on</span>':'')+'</div>'+
      '<div style="font-size:11px;margin-top:3px">'+s.arms.map(a=>
        '<span class="muted" style="margin-right:14px">'+esc(a.label)+' <b style="color:var(--ink)">n='+a.n+'</b> '+
        (a.n?(a.winRate*100).toFixed(0)+'% won':'')+
        (a.r&&a.r.n>=2?' · '+(a.r.mean>=0?"+":"")+a.r.mean.toFixed(2)+'R':'')+'</span>').join("")+'</div>'+
      '<div class="muted" style="font-size:11px;margin-top:3px;line-height:1.5">'+esc(s.note)+'</div>'+
    '</div>';
  }).join(""):'<p class="note">Not enough trades on both sides of any condition to compare yet.</p>';

  const rows=r.recent||[];
  $("lnTrades").innerHTML=rows.length?rows.map(t=>{
    const col=t.pnl===null?"var(--ink2)":t.pnl>=0?"var(--good)":"var(--bad)";
    return "<tr><td>"+new Date(t.at).toTimeString().slice(0,5)+"</td>"+
      "<td>"+t.symbol+" "+t.side+(t.kind?" <span class='muted'>("+(LOSS_LABEL[t.kind]||t.kind)+")</span>":"")+"</td>"+
      "<td style='text-align:right;color:"+col+"'>"+(t.pnl===null?"—":(t.pnl>=0?"+":"")+t.pnl.toFixed(2))+"</td>"+
      "<td style='text-align:right'>"+t.heldMin+"m</td>"+
      "<td><span style='color:var(--good)'>+"+t.mfePct.toFixed(2)+"%</span> / <span style='color:var(--bad)'>"+t.maePct.toFixed(2)+"%</span>"+
        " <span class='muted'>("+(t.peakProgress*100).toFixed(0)+"% of target)</span></td>"+
      "<td class='muted'>"+(t.regime||"—")+(t.sweepShare!==null&&t.sweepShare!==undefined?" · "+(t.sweepShare*100).toFixed(0)+"% swept":"")+"</td>"+
      "<td class='muted'>"+esc(t.exitReason)+"</td></tr>";
  }).join(""):"<tr><td colspan='7' class='muted'>no closed trades recorded yet</td></tr>";

  $("lnNote").textContent=(rp.caveats&&rp.caveats[0]?rp.caveats[0]+" ":"")+
    "Every close is recorded to "+r.path+". Run npm run sweep:learn for the full breakdown.";
}

async function tuning(){
  const t=await api("/api/tuning");
  if(!t.bounds) return;
  const esc=(s)=>String(s).replace(/</g,"&lt;");

  $("tuneOn").checked=!!t.enabled;
  $("tuneState").textContent=t.enabled
    ?"on — the next close can move a cap"
    :"off — changes are shown but not applied";
  $("tuneState").style.color=t.enabled?"var(--warn)":"var(--muted)";

  // What it would do next, shown whether or not it is allowed to. With the
  // toggle off this is the whole point of the section; with it on it is the
  // warning that something is about to move.
  $("tunePending").innerHTML=(t.pending||[]).map(c=>{
    const col=c.direction==="riskier"?"var(--bad)":c.direction==="safer"?"var(--good)":"var(--warn)";
    return '<div style="border-left:3px solid '+col+';padding:8px 10px;margin-bottom:8px;border-radius:0 4px 4px 0;background:var(--surface2)">'+
      '<div style="font-size:12px;font-weight:600">'+esc(c.setting)+
        ' <span style="color:'+col+'">'+c.from+' → '+c.to+'</span>'+
        ' <span class="muted" style="font-weight:400">'+c.direction+(t.enabled?"":" · not applied, auto-tune is off")+'</span></div>'+
      '<div class="muted" style="font-size:11px;margin-top:4px;line-height:1.5">'+esc(c.reason)+'</div>'+
    '</div>';
  }).join("")||'<p class="note" style="margin:0">Nothing to change on the evidence so far.</p>';

  // The reasons it declined. This is the tuner's usual output and the thing
  // most likely to be misread as it being broken, so it is never hidden.
  $("tuneHeld").innerHTML=(t.held||[]).length
    ?'<div class="muted" style="font-size:11px;line-height:1.6">'+
      t.held.map(h=>"· "+esc(h)).join("<br>")+'</div>'
    :"";

  const h=t.history||[];
  $("tuneHistory").innerHTML=h.length
    ?'<table style="margin-top:4px"><thead><tr><th style="text-align:left">When</th><th style="text-align:left">Setting</th>'+
      '<th>Change</th><th style="text-align:left">By</th><th style="text-align:left">Why</th><th></th></tr></thead><tbody>'+
      h.map(e=>{
        const col=e.direction==="riskier"?"var(--bad)":e.direction==="safer"?"var(--good)":"var(--ink2)";
        const undo=e.by==="auto"
          ?'<button data-undo="'+esc(e.setting)+'" style="padding:2px 8px;font-size:11px">undo</button>':"";
        return "<tr><td>"+new Date(e.at).toTimeString().slice(0,5)+"</td>"+
          "<td>"+esc(e.setting)+"</td>"+
          "<td style='text-align:right;color:"+col+"'>"+e.from+" → "+e.to+"</td>"+
          "<td>"+e.by+"</td>"+
          "<td class='muted'>"+esc(e.reason).slice(0,110)+"</td>"+
          "<td>"+undo+"</td></tr>";
      }).join("")+"</tbody></table>"
    :'<p class="note" style="margin:0">No cap has been changed yet.</p>';

  for(const b of document.querySelectorAll("[data-undo]")){
    b.onclick=async()=>{
      if(!confirm("Put "+b.dataset.undo+" back to what it was before the tuner moved it?")) return;
      const r=await api("/api/tuning/revert",{method:"POST",body:JSON.stringify({setting:b.dataset.undo})});
      if(r.error) alert(r.error); else render(r);
      tuning();
    };
  }
}

$("tuneOn").onchange=async()=>{
  /* Its own endpoint, not the limits form. Posting a partial body there reads
     as tradingEnabled:false and would disarm the agent every time this box was
     ticked — the switch would do something its label does not mention. */
  safeRender(await api("/api/tuning/enable",{method:"POST",body:JSON.stringify({enabled:$("tuneOn").checked})}));
  tuning();
};

const CX_LABEL={
  "margin-short":"not enough margin",
  "notional-floor":"order below the venue minimum",
  "precision":"badly formed order",
  "leverage-bracket":"leverage not allowed at this size",
  "position-limit":"position over the venue cap",
  "order-limit":"too many resting stop orders",
  "trigger-side":"stop or target the wrong side of mark",
  "post-only-rejected":"resting entry would have crossed",
  "reduce-only":"reduce-only rejected — already flat",
  "rate-limited":"rate limited",
  "banned":"IP banned",
  "not-permitted":"contract not permitted on this account",
  "auth":"key rejected",
  "clock":"clock drift",
  "price-band":"price outside the venue band",
  "wrong-endpoint":"order sent to a retired endpoint",
  "unknown":"unrecognised rejection"
};

async function constraintsPanel(){
  const c=await api("/api/constraints");
  if(!c.summary) return;
  const esc=(s)=>String(s).replace(/</g,"&lt;");

  $("cxHead").textContent=c.headroomPct+"%";
  // Amber once it has been raised above the default: not a fault, but it means
  // the account is committing less than it could and somebody should know why.
  $("cxHead").style.color=c.headroomPct>5?"var(--warn)":"var(--ink)";
  $("cxClean").textContent=c.acceptedSince;
  $("cxClean").style.color=c.acceptedSince>=20?"var(--good)":"var(--ink)";

  $("cxHalt").innerHTML=(c.halted||[]).map(h=>
    '<div class="banner critical" style="margin-bottom:8px">'+
      '<span class="icon" style="color:var(--bad)">!!</span>'+
      '<div><strong>'+esc(h.symbol)+' is halted.</strong>'+
      '<div class="sub" style="margin-top:2px">'+esc(h.reason)+'</div>'+
      '<button data-clearhalt="'+esc(h.symbol==="all contracts"?"all":h.symbol)+'" style="margin-top:8px;padding:3px 10px;font-size:11px">Fixed — clear it</button>'+
      '</div></div>').join("");

  $("cxSummary").innerHTML=(c.summary||[]).map(s=>{
    // Red for the ones that stop everything, amber for the ones that adapt.
    const bad=["auth","clock","banned","not-permitted"].includes(s.kind);
    const col=bad?"var(--bad)":"var(--warn)";
    return '<div style="display:grid;grid-template-columns:40px 1fr;gap:8px;padding:4px 0;font-size:12px;align-items:baseline">'+
      '<span style="color:'+col+';font-weight:600;text-align:right">'+s.count+'x</span>'+
      '<span>'+esc(CX_LABEL[s.kind]||s.kind)+' <span class="muted">· last '+ago(s.last)+'</span></span></div>';
  }).join("")||'<p class="note" style="margin:0">No rejections in the last six hours.</p>';

  const rows=c.recent||[];
  $("cxRecent").innerHTML=rows.length?rows.map(e=>
    "<tr><td>"+new Date(e.at).toTimeString().slice(0,8)+"</td>"+
    "<td>"+esc(e.symbol)+"</td>"+
    "<td>"+esc(CX_LABEL[e.kind]||e.kind)+"</td>"+
    "<td class='muted'>"+esc(e.detail).slice(0,90)+"</td></tr>"
  ).join(""):"<tr><td colspan='4' class='muted'>nothing refused yet</td></tr>";

  for(const b of document.querySelectorAll("[data-clearhalt]")){
    b.onclick=async()=>{
      if(!confirm("Clear the halt on "+b.dataset.clearhalt+"? Only do this once the cause is actually fixed.")) return;
      safeRender(await api("/api/constraints/clear",{method:"POST",body:JSON.stringify({symbol:b.dataset.clearhalt})}));
      constraintsPanel();
    };
  }
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

/* ---------------------------------------------------------------- notes */

async function messages(){
  const r=await api("/api/messages");
  if(!r.thread) return;
  const esc=(t)=>String(t).replace(/</g,"&lt;");
  const el=$("msgThread");
  // Only redraw when something changed, so the box does not fight the scroll
  // position of someone reading back through it.
  const sig=r.thread.map(m=>m.at).join(",");
  if(el.dataset.sig===sig) return;
  const wasAtBottom=el.scrollTop+el.clientHeight>=el.scrollHeight-24;
  el.dataset.sig=sig;

  $("msgCount").textContent=r.thread.length?("— "+r.thread.length+" message"+(r.thread.length===1?"":"s")):"";
  el.innerHTML=r.thread.length?r.thread.map(m=>{
    const when=new Date(m.at).toLocaleString(undefined,{month:"short",day:"numeric",
      hour:"2-digit",minute:"2-digit"});
    const ctx=m.context
      ? '<div class="ctx">'+esc(m.context.symbol||"")+
        (m.context.mid?" @ "+(+m.context.mid).toFixed(2):"")+
        (m.context.armed?" · armed":" · disarmed")+
        (m.context.holding?" · holding "+m.context.holding:" · flat")+"</div>"
      : "";
    return '<div class="msg '+(m.from==="claude"?"claude":"you")+'">'+
      '<div class="who">'+(m.from==="claude"?"Claude":"You")+" · "+when+"</div>"+
      esc(m.text)+ctx+"</div>";
  }).join(""):'<div class="muted" style="font-size:12px">Nothing yet.</div>';
  if(wasAtBottom) el.scrollTop=el.scrollHeight;
}

async function sendNote(){
  const t=$("msgText").value.trim();
  if(!t) return;
  $("msgSend").disabled=true;
  try{
    const r=await api("/api/messages",{method:"POST",body:JSON.stringify({text:t})});
    $("msgNote").textContent=r.note||"";
    if(r.ok){ $("msgText").value=""; $("msgThread").dataset.sig=""; await messages();
      $("msgThread").scrollTop=$("msgThread").scrollHeight; }
  } finally { $("msgSend").disabled=false; }
}
$("msgSend").onclick=sendNote;
$("msgText").onkeydown=(e)=>{ if(e.key==="Enter") sendNote(); };

$("btnRebase").onclick=async()=>{
  if(!confirm("Start today's P&L, trade count and cooldown again from right now? Use this after a testnet reset: the exchange wipes the balance but keeps the income rows, so the day totals go on counting trades whose money no longer exists.")) return;
  $("btnRebase").disabled=true;
  try { safeRender(await api("/api/status")); await api("/api/ledger/rebase",{method:"POST",body:"{}"});
        safeRender(await api("/api/status")); }
  finally { $("btnRebase").disabled=false; }
};

/* ------------------------------------------------------- contract picker */

const bigUsd=(v)=>{
  const x=Number(v)||0;
  if(x>=1e9) return "$"+(x/1e9).toFixed(1)+"B";
  if(x>=1e6) return "$"+Math.round(x/1e6)+"M";
  if(x>=1e3) return "$"+Math.round(x/1e3)+"k";
  return "$"+Math.round(x);
};

let symTimer=null, symBusy=false;

async function symbols(query){
  const q=query===undefined?$("symQ").value.trim():query;
  const s=await api("/api/symbols"+(q?"?q="+encodeURIComponent(q):""));
  if(!s.watched) return;
  const esc=(t)=>String(t).replace(/</g,"&lt;");

  $("symCount").textContent="— "+s.watched.length+" of "+s.max+
    (s.orderVenue?" · orders to "+esc(String(s.orderVenue).split("//").pop()):"");

  /*
   * Watched first, with everything that would stop a trade shown on the chip.
   *
   * A contract can be listed, liquid and completely untradeable by this account
   * — production lists far more than demo does — and discovering that after an
   * hour of watching is the failure this panel exists to prevent. So orderable,
   * calibrated and holding all appear here rather than behind a click.
   */
  $("symWatched").innerHTML=s.watched.map(d=>{
    const bits=[];
    if(d.holding) bits.push("holding "+d.holding);
    if(d.armed) bits.push("armed");
    if(!d.calibrated) bits.push("uncal.");
    if(d.orderable===false) bits.push("not orderable");
    if(!d.listed) bits.push("NOT LISTED");
    const cls=(!d.listed||d.orderable===false)?" bad":(!d.calibrated?" warn":"");
    // The × is withheld rather than shown-and-refused while holding: the server
    // refuses it too, but a button that is always rejected is a worse answer
    // than a button that is visibly unavailable.
    const x=d.holding?'<span class="meta" title="close the position first">held</span>'
      :'<span class="x" data-rm="'+d.symbol+'" title="stop watching '+d.symbol+'">×</span>';
    return '<span class="chip'+cls+'">'+esc(d.symbol)+
      (bits.length?'<span class="meta">'+esc(bits.join(" · "))+'</span>':'')+x+'</span>';
  }).join("");

  for(const el of document.querySelectorAll("[data-rm]")){
    el.onclick=async()=>{
      const r=await api("/api/symbols/remove",{method:"POST",body:JSON.stringify({symbol:el.dataset.rm})});
      $("symNote").textContent=r.note||"";
      $("symNote").style.color=r.ok?"var(--dim)":"var(--bad)";
      await symbols(); safeRender(await api("/api/status"));
    };
  }

  const full=s.watched.length>=s.max;
  $("symResults").innerHTML=(s.results||[]).map(r=>{
    const why=[];
    if(r.watched) why.push("already watching");
    else if(full) why.push("at the "+s.max+"-contract ceiling");
    if(r.orderable===false) why.push("not orderable here");
    if(!r.calibrated) why.push("uncalibrated");
    const cls=r.orderable===false?" bad":(!r.calibrated?" warn":"");
    return '<button class="chip'+cls+'" data-add="'+r.symbol+'"'+
      ((r.watched||full)?" disabled":"")+' title="'+esc(why.join(" · ")||"add this contract")+'">'+
      esc(r.symbol)+'<span class="meta">'+bigUsd(r.volumeUsd)+" 24h"+
      (r.kind==="equity"?" · equity":"")+(why.length?" · "+esc(why[0]):"")+"</span></button>";
  }).join("");

  for(const b of document.querySelectorAll("[data-add]")){
    b.onclick=async()=>{
      if(symBusy) return;
      symBusy=true; b.disabled=true;
      try{
        const r=await api("/api/symbols/add",{method:"POST",body:JSON.stringify({symbol:b.dataset.add})});
        $("symNote").textContent=r.note||"";
        $("symNote").style.color=r.ok?"var(--dim)":"var(--bad)";
        if(r.ok){ $("symQ").value=""; }
        await symbols(); safeRender(await api("/api/status"));
      } finally { symBusy=false; }
    };
  }

  if(!$("symNote").textContent){
    $("symNote").textContent=s.catalogError
      ? "Could not refresh the contract list: "+esc(s.catalogError)+(s.catalogSize?" (showing the last good one)":"")
      : (q?"":"Adding a contract starts its engine immediately — no restart, and the desks already running keep their warm baselines.");
  }
}

// Debounced: the catalogue is cached server-side, but a request per keystroke
// still means twenty round trips to type a ticker.
$("symQ").oninput=()=>{ clearTimeout(symTimer); symTimer=setTimeout(()=>symbols(),180); };
$("symQ").onkeydown=(e)=>{
  if(e.key!=="Enter") return;
  // Enter adds the top result, which is what typing a full ticker and hitting
  // return is obviously asking for.
  const first=document.querySelector("[data-add]:not([disabled])");
  if(first) first.click();
};
$("symClear").onclick=()=>{ $("symQ").value=""; $("symNote").textContent=""; symbols(""); };

tick(); setInterval(tick,1000);
symbols(""); setInterval(()=>{ if(!$("symQ").value.trim()) symbols(""); },15000);
// Ten seconds, so a reply that arrived over git appears without a refresh.
messages(); setInterval(messages,10000);
funds(); setInterval(funds,15000);
pullLog(); setInterval(pullLog,2000);
runs(); setInterval(runs,10000);
// Slower than the rest: it re-reads the whole trade log, and nothing in it
// changes between position closes.
learn(); setInterval(learn,30000);
tuning(); setInterval(tuning,30000);
constraintsPanel(); setInterval(constraintsPanel,10000);
</script></body></html>`;
}
