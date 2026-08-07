/**
 * The whole trading loop, live, without an order.
 *
 *   npm run sweep:shadow
 *   npm run sweep:shadow -- --equity 5000 --out data/sweep-shadow.jsonl
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

import { loadEnv } from "./load-env";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { attachCalendar } from "../lib/sweep/metrics/event-store";
import { getEngine } from "../lib/sweep/engine";
import { attachExecution, createSweepFeed, intentId } from "../lib/sweep/agent";
import { directionalBias } from "../lib/sweep/agent/bias";
import { canPostEntry, DEFAULT_FEES, parseFeeTiers, type FeeSchedule } from "../lib/sweep/metrics/fees";
import {
  createShadowAdapter,
  resolveShadow,
  scoreShadow,
  type ShadowTrade,
} from "../lib/sweep/exchange/shadow";
import type { AgentState, Signal, TradeIntent } from "../lib/sweep/agent";
import { SYMBOL } from "../lib/sweep/config";

loadEnv();

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
const HORIZONS = [60, 300, 900] as const;

const fees: FeeSchedule = {
  ...DEFAULT_FEES,
  discount: Number(process.env.SWEEP_FEE_DISCOUNT) || DEFAULT_FEES.discount,
  tiers: parseFeeTiers(process.env.SWEEP_FEE_TIERS).tiers,
};

const feed = createSweepFeed();
attachCalendar(getEngine());

let written = 0;
let refused = 0;
const pending = new Map<string, { trade: ShadowTrade; remaining: number; high: number; low: number }>();

const adapter = createShadowAdapter({
  symbol: SYMBOL,
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
  // The same test the live path uses, so a shadow fill is priced the way a real
  // one would have been rather than optimistically.
  entryStyle: (state) => ({
    entry: canPostEntry(state.markout).ok ? "maker" : "taker",
    exit: "taker",
  }),
  onRefused: () => {
    refused++;
  },
  onTrade: (trade) => {
    console.error(
      `[shadow] ${trade.side} ${trade.quantity} @ ${trade.entryPrice.toFixed(2)} ` +
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
          flush(entry.trade);
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

function flush(trade: ShadowTrade) {
  appendFileSync(OUT, `${JSON.stringify(trade)}\n`);
  written++;
  const net = trade.outcomes.t900?.netUsd;
  console.error(
    `[shadow] closed ${trade.intentId} — would have ${trade.resolved} · ` +
      `net at 15m ${net === null || net === undefined ? "?" : `${net >= 0 ? "+" : ""}${net.toFixed(2)}`} · ` +
      `${written} recorded`,
  );
}

/* ------------------------------------------------------------------ runner */

const runner = attachExecution(feed, {
  adapter,
  // The same strategy the control server runs, so this measures the thing that
  // would actually trade rather than a simplified stand-in.
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
      reference: {
        mid: state.mid ?? 0,
        trigger: signal.price,
        invalidation: null,
      },
    };
  },
  minIntervalMs: 60_000,
  maxPerHour: 12,
});

let lastLevel = "";
feed.onState((s) => {
  if (s.health.level !== lastLevel) {
    lastLevel = s.health.level;
    console.error(`[shadow] feed ${s.health.level}${s.health.tradeable ? "" : ` — ${s.health.summary}`}`);
  }
});

setInterval(() => {
  const stats = runner.stats();
  console.error(
    `[shadow] alive — ${written} recorded, ${pending.size} open, ` +
      `${refused} sized-out, ${stats.rejected} filtered before sizing`,
  );
}, 15 * 60_000).unref?.();

process.on("unhandledRejection", (r) => console.error(`[shadow] unhandled rejection: ${r}`));

function shutdown() {
  for (const { trade } of pending.values()) flush(trade);
  pending.clear();
  runner.stop();
  feed.close();
  console.error(`[shadow] stopped — ${written} trades recorded in ${OUT}`);
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, shutdown);

console.error("");
console.error(`[shadow] recording to ${OUT}`);
console.error(`[shadow] sizing against ${EQUITY} USDT at 2% risk per trade`);
console.error("[shadow] no credentials are read and no order can be placed — the adapter has no path to one");
console.error(`[shadow] each trade is scored at ${HORIZONS.join("s, ")}s, net of the fees it would have paid`);
console.error("[shadow] ctrl-c to stop; open trades are flushed on exit");
console.error("");
