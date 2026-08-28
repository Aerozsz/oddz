/**
 * The whole trading loop, live, without an order.
 *
 *   npm run sweep:shadow
 *   npm run sweep:shadow -- --equity 5000 --out data/sweep-shadow.jsonl
 *   SWEEP_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT npm run sweep:shadow
 *
 * Watches every contract in SWEEP_SYMBOLS at once, in one process. That is not
 * a convenience: evidence is the binding constraint on this whole project, it
 * scales linearly with the number of contracts watched, and running one process
 * per symbol would mean N sets of streams, N heartbeats writing over each
 * other, and N output files to reconcile. Rows carry their symbol, so one file
 * stays correct.
 *
 * Real feed, real book, real signals, real sizing, real fee arithmetic. Every
 * intent is recorded with exactly what would have been sent, then scored later
 * against what price actually did — net of the round trip it would have paid.
 *
 * This is the test that matters before real money, and it is not the same test
 * as demo trading. Demo exercises signing and order types against a synthetic
 * book; it cannot tell you anything about a strategy that reads microstructure,
 * because a demo venue has none. This exercises the strategy against the real
 * one and only skips the last step.
 *
 * Needs no credentials and cannot place anything. The adapter it uses has no
 * code path to an order.
 */

import { beat } from "./heartbeat";
import { loadEnv } from "./load-env";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { attachCalendar } from "../lib/sweep/metrics/event-store";
import { getEngine } from "../lib/sweep/engine";
import { attachExecution, createSweepFeed, intentId } from "../lib/sweep/agent";
import { attachNews } from "../lib/sweep/agent/feed";
import { livePressure } from "../lib/sweep/agent/pressure";
import { directionalBias } from "../lib/sweep/agent/bias";
import { canPostEntry, DEFAULT_FEES, parseFeeTiers, type FeeSchedule } from "../lib/sweep/metrics/fees";
import {
  createShadowAdapter,
  resolveShadow,
  scoreShadow,
  type ShadowTrade,
} from "../lib/sweep/exchange/shadow";
import type { AgentState, Signal, TradeIntent } from "../lib/sweep/agent";
import { SYMBOLS } from "../lib/sweep/config";

loadEnv();

// The tape, the crowd and the wires reach the sizer through this. Shared with
// the control server so a shadow trade and a live one are scored against the
// same reading of the outside world.
attachNews(livePressure);

const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 22) {
  console.error(`\n  This needs Node 22 or newer. You are on ${process.versions.node}.\n`);
  process.exit(1);
}

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const OUT = resolve(arg("out", "data/sweep-shadow.jsonl"));
const EQUITY = Number(arg("equity", "5000"));
mkdirSync(dirname(OUT), { recursive: true });

/** Scored at the same horizons the paper log uses, so the two are comparable. */
/*
 * Out to the hold limit, not to fifteen minutes.
 *
 * The window stopped at 900s while the live agent holds up to `maxHoldMinutes`
 * — 120 by default. The consequence was not a rounding error: across 7,276
 * recorded decisions, `resolved` was "open" on **every single one**. Not one
 * trade in the entire shadow history ever reached its stop or its target inside
 * the window it was scored in, so `resolveShadow` was dead code and every
 * "net at 15m" was fifteen-minute drift rather than the outcome of a bracket.
 *
 * The shadow run was measuring a different strategy from the one that trades,
 * and every conclusion drawn from it — including the negative verdicts — was
 * drawn about that different strategy.
 *
 * The short horizons stay, because they answer a separate and useful question
 * (does the mechanism act quickly, as it claims). 1800 and 7200 are the ones
 * that make the record comparable to a live trade.
 */
const HORIZONS = [60, 300, 900, 1800, 7200] as const;

const fees: FeeSchedule = {
  ...DEFAULT_FEES,
  discount: Number(process.env.SWEEP_FEE_DISCOUNT) || DEFAULT_FEES.discount,
  tiers: parseFeeTiers(process.env.SWEEP_FEE_TIERS).tiers,
};

/*
 * One desk per contract, each with its own feed, adapter and execution loop.
 *
 * Deliberately mirrors the control server's shape rather than inventing a
 * second one: the whole value of a shadow run is that it exercises the code
 * that would really trade, and a runner structured differently from the live
 * path would be measuring something else.
 */
interface Desk {
  readonly symbol: string;
  feed: ReturnType<typeof createSweepFeed>;
  runner: ReturnType<typeof attachExecution>;
  pending: Map<string, { trade: ShadowTrade; remaining: number; high: number; low: number }>;
  written: number;
  refused: number;
}

const desks: Desk[] = [];
const totalWritten = () => desks.reduce((a, d) => a + d.written, 0);
const totalPending = () => desks.reduce((a, d) => a + d.pending.size, 0);
const totalRefused = () => desks.reduce((a, d) => a + d.refused, 0);

function startDesk(symbol: string): Desk {
  const feed = createSweepFeed({ symbol });
  attachCalendar(getEngine(symbol));

  const pending = new Map<string, { trade: ShadowTrade; remaining: number; high: number; low: number }>();
  const desk = { symbol, feed, pending, written: 0, refused: 0 } as Desk;

  const adapter = createShadowAdapter({
    symbol,
    equity: EQUITY,
    fees,
    limits: () => ({
      // Deliberately permissive on the money caps and strict on the discipline
      // ones. A shadow run is asking what the signals are worth, and a position
      // cap that refuses most of them answers a different question — but a run
      // that ignores cooldowns and reward-to-risk would be measuring a strategy
      // nobody would actually run.
      maxPositionUsd: EQUITY,
      maxLeverage: 8,
      maxDailyLossUsd: 0,
      stopLossPct: 3,
      maxTradesPerDay: 0,
      lossCooldownMin: 0,
      requireCashOpen: false,
      minRewardRisk: 1.2,
    }),
    sizingConfig: () => ({ riskFraction: 0.02, canPostEntries: true }),
    getCostCurve: () => feed.getCostCurve(),
    getClusters: () => feed.getClusters(),
    // The same test the live path uses, so a shadow fill is priced the way a
    // real one would have been rather than optimistically.
    entryStyle: (state) => ({
      entry: canPostEntry(state.markout).ok ? "maker" : "taker",
      exit: "taker",
    }),
    onRefused: () => { desk.refused++; },
    onTrade: (trade) => {
      console.error(
        `[shadow] ${symbol} ${trade.side} ${trade.quantity} @ ${trade.entryPrice.toFixed(2)} ` +
          `(${trade.style.entry} in) stop ${trade.stopPrice.toFixed(2)} ` +
          `target ${trade.targetPrice?.toFixed(2) ?? "—"} · ` +
          `fees ${trade.feeUsd.toFixed(2)} (${trade.feeBps.toFixed(1)}bp) · ${trade.signalKind}`,
      );

      const key = trade.intentId;
      pending.set(key, { trade, remaining: HORIZONS.length, high: trade.entryPrice, low: trade.entryPrice });

      for (const horizon of HORIZONS) {
        const takenAt = Date.now();
        setTimeout(() => {
          const entry = pending.get(key);
          if (!entry) return;
          const state = feed.getState();
          // Same wall-clock guard as the paper log: a timer that fired late
          // because the machine slept measures the wrong interval.
          const late = (Date.now() - takenAt) / 1000 > horizon + Math.max(10, horizon * 0.1);
          scoreShadow(entry.trade, `t${horizon}`, !late && state.health.tradeable ? state.mid : null);
          entry.remaining--;
          if (entry.remaining === 0) {
            entry.trade.resolved = resolveShadow(entry.trade, entry.high, entry.low);
            pending.delete(key);
            flush(desk, entry.trade);
          }
        }, horizon * 1000).unref?.();
      }
    },
  });

  /*
   * The running high and low since each entry, so a stop or target that would
   * have been hit *inside* the window is detected. Scoring only on the price at
   * the horizon would count a trade that went 3% against and came back as flat,
   * when in reality the stop would have closed it at a loss.
   */
  feed.onState((state) => {
    const mid = state.mid;
    if (mid === null) return;
    for (const entry of pending.values()) {
      if (mid > entry.high) entry.high = mid;
      if (mid < entry.low) entry.low = mid;
    }
  });

  let lastLevel = "";
  feed.onState((st) => {
    if (st.health.level !== lastLevel) {
      lastLevel = st.health.level;
      console.error(`[shadow] ${symbol} feed ${st.health.level}${st.health.tradeable ? "" : ` — ${st.health.summary}`}`);
    }
  });

  desk.runner = attachExecution(feed, {
    adapter,
    // The same strategy the control server runs, so this measures the thing
    // that would actually trade rather than a simplified stand-in.
    strategy: (signal: Signal, state: AgentState): TradeIntent | null => {
      if (signal.kind === "health") return null;
      const bias = directionalBias(state);
      if (!bias.direction) return null;
      return {
        id: intentId(signal),
        t: Date.now(),
        side: bias.direction === "up" ? "buy" : "sell",
        signalId: signal.id,
        signalKind: signal.kind,
        reason: `${signal.detail} · ${bias.summary}`,
        confidence: bias.conviction,
        // Carried whole, not reduced to the letter it produced. The side is the
        // only thing this read decides and it was the only thing not recorded.
        bias: { composite: bias.composite, conviction: bias.conviction, factors: bias.factors },
        reference: { mid: state.mid ?? 0, trigger: signal.price, invalidation: null },
      };
    },
    /*
     * Per-desk pacing, unlike the live path's account-wide guard.
     *
     * Nothing is at risk here, so the reason to space trades is that a burst of
     * near-identical entries on one contract is one observation recorded twelve
     * times — which would inflate every count the analysis rests on without
     * adding any evidence. Across contracts there is no such duplication, so
     * the desks do not throttle each other.
     */
    minIntervalMs: 60_000,
    maxPerHour: 12,
  });

  desks.push(desk);
  return desk;
}

function flush(desk: Desk, trade: ShadowTrade) {
  appendFileSync(OUT, `${JSON.stringify(trade)}\n`);
  desk.written++;
  /*
   * The longest horizon that actually scored, not a hard-coded one.
   *
   * This read `t900` while the label beside it said something else, and after
   * the window was extended it would have gone on quoting the fifteen-minute
   * figure for a two-hour trade. A readout naming a horizon it is not showing
   * is how a wrong number survives being looked at every minute.
   */
  const longest = [...HORIZONS].reverse().find((h) => typeof trade.outcomes[`t${h}`]?.netUsd === "number");
  const net = longest ? trade.outcomes[`t${longest}`].netUsd : null;
  console.error(
    `[shadow] ${desk.symbol} closed ${trade.intentId} — would have ${trade.resolved} · ` +
      `net at ${longest ? (longest >= 3600 ? `${longest / 3600}h` : `${longest / 60}m`) : "?"} ` +
      `${net === null || net === undefined ? "?" : `${net >= 0 ? "+" : ""}${net.toFixed(2)}`} · ` +
      `${totalWritten()} recorded`,
  );
}

/* ------------------------------------------------------------------ runner */

for (const symbol of SYMBOLS) startDesk(symbol);

setInterval(() => {
  const lines = desks.map((d) => {
    const st = d.runner.stats();
    return `${d.symbol} ${d.written}rec/${d.pending.size}open/${d.refused}sized-out/${st.rejected}filtered`;
  });
  console.error(`[shadow] alive — ${lines.join(" · ")}`);
}, 15 * 60_000).unref?.();

process.on("unhandledRejection", (r) => console.error(`[shadow] unhandled rejection: ${r}`));

// So the GUI can tell "running and waiting for a setup" from "not started".
// The output file cannot answer that: nothing is written until a trade has
// been open for the full fifteen minutes.
let stopBeat: () => void = () => {};
stopBeat = beat("sweep-shadow", () => {
  const stats = desks.map((d) => d.runner.stats());
  const worst = desks
    .map((d) => d.feed.getState().health.level)
    .sort((a, b) => (a === "blind" ? -1 : b === "blind" ? 1 : a === "degraded" ? -1 : 1))[0];
  return {
    recorded: totalWritten(),
    open: totalPending(),
    sizedOut: totalRefused(),
    signalsSeen: stats.reduce((a, x) => a + x.seen, 0),
    noSideCalled: stats.reduce((a, x) => a + x.declined, 0),
    // The worst feed across the desks, so one blind contract cannot hide behind
    // the others reporting healthy.
    feed: worst ?? "unknown",
    symbols: desks.map((d) => d.symbol).join(","),
    out: OUT,
  };
});

function shutdown() {
  stopBeat();
  // Open trades are flushed with whatever horizons have scored so far. A
  // partially-scored row is still evidence; discarding it would silently drop
  // the most recent trades every time the process is restarted, which is
  // exactly the set most likely to reflect a change just made.
  for (const desk of desks) {
    for (const { trade } of desk.pending.values()) flush(desk, trade);
    desk.pending.clear();
    desk.runner.stop();
    desk.feed.close();
  }
  console.error(`[shadow] stopped — ${totalWritten()} trades recorded in ${OUT}`);
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, shutdown);

console.error("");
console.error(`[shadow] watching ${SYMBOLS.join(", ")}`);
console.error(`[shadow] recording to ${OUT}`);
console.error(`[shadow] sizing against ${EQUITY} USDT at 2% risk per trade`);
console.error("[shadow] no credentials are read and no order can be placed — the adapter has no path to one");
console.error(`[shadow] each trade is scored at ${HORIZONS.join("s, ")}s, net of the fees it would have paid`);
console.error("[shadow] ctrl-c to stop; open trades are flushed on exit");
console.error("");
