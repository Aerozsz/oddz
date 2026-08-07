/**
 * Evidence log. Records every signal with the market state at the moment it
 * fired, then comes back later and records what price actually did.
 *
 *   npm run sweep:paper            # append to data/sweep-paper.jsonl
 *   npm run sweep:paper -- --out /some/path.jsonl
 *
 * Deliberately not a strategy. There is no entry rule here and nothing is
 * scored as a win or a loss, because inventing a rule before there is any
 * evidence would only produce a backtest of a guess.
 *
 * It samples on a clock rather than only when a signal fires. Recording only
 * signals would mean the file can never answer a question about any threshold
 * except the ones already hard-coded — and those are guesses. A row every few
 * seconds, whether or not anything tripped, gives thousands of observations a
 * day and lets a threshold be chosen from the data afterwards instead of
 * assumed in advance. Rows that coincided with a signal are flagged, so the
 * narrower question is still answerable from the same file.
 *
 * Needs no exchange account and no credentials — it reads the same public
 * market data the dashboard does, and places nothing.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createSweepFeed } from "../lib/sweep/agent";
import { directionalBias } from "../lib/sweep/agent/bias";
import type { AgentState, Signal } from "../lib/sweep/agent";

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

/** When to look back and see what happened, in seconds after each sample. */
const HORIZONS = [60, 300, 900] as const;

/** How often to record, in seconds. ~5,700 rows a day at 15s. */
const SAMPLE_SEC = Number(process.env.SWEEP_SAMPLE_SEC ?? 15);

const argOut = process.argv.indexOf("--out");
const OUT = resolve(argOut > -1 ? process.argv[argOut + 1] : "data/sweep-paper.jsonl");
mkdirSync(dirname(OUT), { recursive: true });

interface Record {
  id: string;
  kind: Signal["kind"];
  severity: Signal["severity"];
  direction: Signal["direction"];
  t: number;
  iso: string;
  detail: string;
  /** Mid at the instant the signal fired — the reference every horizon uses. */
  midAtSignal: number | null;
  health: string;
  /** Context worth having when reading the row back months later. */
  lwi: number | null;
  /** Session-corrected depth index — see LiquidityState.lwiAdj. */
  lwiAdj: number | null;
  warm: boolean | null;
  imbalance: number | null;
  spreadBps: number | null;
  riskUp: number | null;
  riskDown: number | null;
  nearestAbove: number | null;
  nearestBelow: number | null;
  session: string;
  /**
   * The finer phase, and its multipliers. Logged because the per-phase weights
   * in metrics/session.ts are priors rather than measurements — these columns
   * are what will eventually replace them with fitted numbers.
   */
  intraday: string;
  sessionTransitioning: boolean;
  /** Mark-out at the moment of the sample. The one input with a track record. */
  markoutInformed: number | null;
  markoutToxicity: number | null;
  markoutWarm: boolean;
  markout5sBps: number | null;
  /** Funding: the rate, and whether it was stretched enough to mean anything. */
  fundingRate: number | null;
  fundingStretched: boolean;
  fundingCrowded: string | null;
  msToFunding: number | null;
  /** Whether a scheduled release was in the way. */
  eventBlackout: boolean;
  eventSizeScale: number;
  /** Signal kinds that fired within a few seconds of this sample, if any. */
  signals: string[];
  /** Behavioural read at the time: mechanical, human, mixed or unclear. */
  flowCharacter: string;
  /** Direction of least resistance, when one was called. */
  biasDirection: string | null;
  biasConviction: number | null;
  /** Filled in later: mid at +60s, +300s, +900s, and the move in percent. */
  outcomes: Partial<Record_Outcomes>;
  /**
   * True when at least one horizon resolved materially later than it should
   * have — the machine slept, or the process was starved. Those outcomes are
   * null rather than wrong.
   */
  lateResolve?: boolean;
}

type Record_Outcomes = { [K in `t${(typeof HORIZONS)[number]}`]: { mid: number | null; pct: number | null } };

const feed = createSweepFeed();
const pending = new Map<string, { record: Record; remaining: number }>();
let written = 0;

function snapshotOf(state: AgentState, firedSignals: Signal[], id: string): Record {
  const bias = directionalBias(state);
  return {
    id,
    kind: (firedSignals[0]?.kind ?? "sample") as Record["kind"],
    severity: (firedSignals[0]?.severity ?? "info") as Record["severity"],
    direction: firedSignals[0]?.direction ?? null,
    t: Date.now(),
    iso: new Date().toISOString(),
    detail: firedSignals.map((s) => s.detail).join(" | ") || "periodic sample",
    signals: firedSignals.map((s) => s.kind),
    flowCharacter: state.participants?.character.label ?? "unclear",
    biasDirection: bias.direction,
    biasConviction: bias.direction ? Number(bias.conviction.toFixed(3)) : null,
    midAtSignal: state.mid,
    health: state.health.level,
    lwi: state.liquidity?.lwi ?? null,
    lwiAdj: state.liquidity?.lwiAdj ?? null,
    warm: state.liquidity?.warm ?? null,
    imbalance: state.liquidity?.imbalance ?? null,
    spreadBps: state.liquidity?.spreadBps ?? null,
    riskUp: state.cascadeUp?.risk ?? null,
    riskDown: state.cascadeDown?.risk ?? null,
    nearestAbove: state.nearestAbove?.price ?? null,
    nearestBelow: state.nearestBelow?.price ?? null,
    session: state.session.phase,
    intraday: state.session.intraday,
    sessionTransitioning: state.session.transitioning,
    markoutInformed: state.markout.warm ? Number(state.markout.informed.toFixed(4)) : null,
    markoutToxicity: state.markout.warm ? Number(state.markout.toxicity.toFixed(4)) : null,
    markoutWarm: state.markout.warm,
    markout5sBps: state.markout.horizons[1]?.costToMakerBps ?? null,
    fundingRate: state.funding.rate,
    fundingStretched: state.funding.stretched,
    fundingCrowded: state.funding.crowded,
    msToFunding: state.funding.msToFunding || null,
    eventBlackout: state.events.blackout,
    eventSizeScale: state.events.sizeScale,
    outcomes: {},
  };
}

function flush(record: Record) {
  appendFileSync(OUT, `${JSON.stringify(record)}\n`);
  written++;
  if (written % 20 === 0 || record.signals.length > 0) console.error(
    `[paper] ${record.signals.length ? record.signals.join("+") : "sample"} @ ${record.midAtSignal ?? "?"} ` +
      `(${Object.entries(record.outcomes)
        .map(([k, v]) => `${k}:${v.pct === null ? "?" : `${v.pct > 0 ? "+" : ""}${v.pct.toFixed(2)}%`}`)
        .join(" ")}) — ${written} rows in ${OUT}`,
  );
}

// Signals seen since the last sample, so a row can be tagged with what tripped.
let recentSignals: Signal[] = [];
feed.onSignal((signal) => {
  if (signal.kind === "health") return;
  recentSignals.push(signal);
});

let seq = 0;
function take() {
  const state = feed.getState();
  // A sample taken while the feed is untrustworthy is not evidence.
  if (!state.health.tradeable) {
    recentSignals = [];
    return;
  }

  const id = `s${Date.now().toString(36)}${(seq++).toString(36)}`;
  const record = snapshotOf(state, recentSignals, id);
  recentSignals = [];
  const takenAt = Date.now();
  pending.set(id, { record, remaining: HORIZONS.length });

  for (const horizon of HORIZONS) {
    setTimeout(() => {
      const entry = pending.get(id);
      if (!entry) return;
      const now = feed.getState();

      /*
       * Resolve by the wall clock, not by the fact that the timer fired.
       *
       * A setTimeout does not run during suspend — it runs when the machine
       * wakes, however much later that is. On a laptop that sleeps overnight
       * the 900s timer fires eight hours late, and taking the mid at that
       * moment records an eight-hour move in a column labelled fifteen
       * minutes. That is not a missing observation, it is a wrong one, and the
       * analyser has no way to tell it apart from a real one — a handful of
       * them would dominate every mean in the file.
       *
       * So a late resolution is recorded as null and flagged, which the
       * analyser already filters out.
       */
      const elapsedSec = (Date.now() - takenAt) / 1000;
      const late = elapsedSec > horizon + Math.max(10, horizon * 0.1);
      const mid = !late && now.health.tradeable ? now.mid : null;
      const base = entry.record.midAtSignal;
      if (late) entry.record.lateResolve = true;

      entry.record.outcomes[`t${horizon}` as keyof Record_Outcomes] = {
        mid,
        pct: mid !== null && base !== null && base > 0 ? ((mid - base) / base) * 100 : null,
      };
      entry.remaining--;
      if (entry.remaining === 0) {
        pending.delete(id);
        flush(entry.record);
      }
    }, horizon * 1000).unref?.();
  }
}

setInterval(take, SAMPLE_SEC * 1000);

let lastLevel = "";
feed.onState((s) => {
  if (s.health.level !== lastLevel) {
    lastLevel = s.health.level;
    console.error(`[paper] feed ${s.health.level}${s.health.tradeable ? "" : ` — ${s.health.summary}`}`);
  }
});

function shutdown(code = 0) {
  // Anything still waiting on a horizon is written with the outcomes it has,
  // so a run that is stopped early still yields usable rows.
  for (const { record } of pending.values()) flush(record);
  pending.clear();
  feed.close();
  console.error(`[paper] stopped — ${written} rows total in ${OUT}`);
  process.exit(code);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => shutdown(0));

/*
 * This is meant to run unattended for days, and the whole plan depends on it.
 * Node's default for an unhandled rejection is to kill the process — so one
 * transient fetch failure inside a listener could end a two-day recording,
 * lose every row still waiting on a horizon, and leave a window that looks
 * like it is still working because nothing further is printed.
 *
 * A single throw is not a reason to stop recording, so these log loudly and
 * carry on. Only a genuinely fatal error takes the process down, and it
 * flushes what it has on the way out.
 */
let recentFaults = 0;
setInterval(() => (recentFaults = 0), 60_000).unref?.();

process.on("unhandledRejection", (reason) => {
  recentFaults++;
  console.error(`[paper] unhandled rejection (${recentFaults} this minute): ${reason}`);
  // A steady stream of them means something is broken rather than flaky, and
  // continuing would fill the file with rows taken from a feed in that state.
  if (recentFaults > 30) {
    console.error("[paper] too many failures — stopping and flushing what is recorded");
    shutdown(1);
  }
});

process.on("uncaughtException", (err) => {
  console.error(`[paper] uncaught exception: ${err.stack ?? err.message}`);
  shutdown(1);
});

/*
 * A heartbeat, because silence is ambiguous. Nothing is printed while the feed
 * is healthy and no signal fires, which looks identical to a process that has
 * quietly stopped sampling.
 */
setInterval(() => {
  const s = feed.getState();
  console.error(
    `[paper] alive — ${written} rows written, ${pending.size} awaiting outcomes, ` +
      `feed ${s.health.level}${s.mid ? ` @ ${s.mid}` : ""}`,
  );
}, 15 * 60_000).unref?.();

console.error(`[paper] recording to ${OUT}`);
console.error(`[paper] sampling every ${SAMPLE_SEC}s — about ${Math.round(86400 / SAMPLE_SEC)} rows a day`);
console.error(`[paper] each row is scored at ${HORIZONS.map((h) => `${h}s`).join(", ")}, so the first lands ~15min in`);
console.error("[paper] ctrl-c to stop; partial rows are flushed on exit");
