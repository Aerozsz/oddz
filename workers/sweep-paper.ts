/**
 * Evidence log. Records every signal with the market state at the moment it
 * fired, then comes back later and records what price actually did.
 *
 *   npm run sweep:paper            # append to data/sweep-paper.jsonl
 *   npm run sweep:paper -- --out /some/path.jsonl
 *
 * Deliberately not a strategy. There is no entry rule here and nothing is
 * scored as a win or a loss, because inventing a rule before there is any
 * evidence would only produce a backtest of a guess. What this answers is the
 * question that has to come first: when a signal fires, what does price do
 * next? Until that has a few hundred rows behind it, any strategy built on
 * these signals is decoration.
 *
 * Needs no exchange account and no credentials — it reads the same public
 * market data the dashboard does, and places nothing.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createSweepFeed } from "../lib/sweep/agent";
import type { AgentState, Signal } from "../lib/sweep/agent";

/** When to look back and see what happened, in seconds after the signal. */
const HORIZONS = [60, 300, 900] as const;

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
  warm: boolean | null;
  imbalance: number | null;
  spreadBps: number | null;
  riskUp: number | null;
  riskDown: number | null;
  nearestAbove: number | null;
  nearestBelow: number | null;
  session: string;
  /** Filled in later: mid at +60s, +300s, +900s, and the move in percent. */
  outcomes: Partial<Record_Outcomes>;
}

type Record_Outcomes = { [K in `t${(typeof HORIZONS)[number]}`]: { mid: number | null; pct: number | null } };

const feed = createSweepFeed();
const pending = new Map<string, { record: Record; remaining: number }>();
let written = 0;

function snapshotOf(signal: Signal, state: AgentState): Record {
  return {
    id: signal.id,
    kind: signal.kind,
    severity: signal.severity,
    direction: signal.direction,
    t: signal.t,
    iso: new Date(signal.t).toISOString(),
    detail: signal.detail,
    midAtSignal: state.mid,
    health: state.health.level,
    lwi: state.liquidity?.lwi ?? null,
    warm: state.liquidity?.warm ?? null,
    imbalance: state.liquidity?.imbalance ?? null,
    spreadBps: state.liquidity?.spreadBps ?? null,
    riskUp: state.cascadeUp?.risk ?? null,
    riskDown: state.cascadeDown?.risk ?? null,
    nearestAbove: state.nearestAbove?.price ?? null,
    nearestBelow: state.nearestBelow?.price ?? null,
    session: state.session.phase,
    outcomes: {},
  };
}

function flush(record: Record) {
  appendFileSync(OUT, `${JSON.stringify(record)}\n`);
  written++;
  console.error(
    `[paper] wrote ${record.kind} @ ${record.midAtSignal ?? "?"} ` +
      `(${Object.entries(record.outcomes)
        .map(([k, v]) => `${k}:${v.pct === null ? "?" : `${v.pct > 0 ? "+" : ""}${v.pct.toFixed(2)}%`}`)
        .join(" ")}) — ${written} rows in ${OUT}`,
  );
}

feed.onSignal((signal, state) => {
  // Health transitions describe the feed, not the market; logging them as
  // observations would pollute the very set this exists to build.
  if (signal.kind === "health") return;
  // A signal raised while the feed is not trustworthy is not evidence either.
  if (!state.health.tradeable) return;

  const record = snapshotOf(signal, state);
  pending.set(signal.id, { record, remaining: HORIZONS.length });

  for (const horizon of HORIZONS) {
    setTimeout(() => {
      const entry = pending.get(signal.id);
      if (!entry) return;
      const now = feed.getState();
      const mid = now.health.tradeable ? now.mid : null;
      const base = entry.record.midAtSignal;
      entry.record.outcomes[`t${horizon}` as keyof Record_Outcomes] = {
        mid,
        pct: mid !== null && base !== null && base > 0 ? ((mid - base) / base) * 100 : null,
      };
      entry.remaining--;
      if (entry.remaining === 0) {
        pending.delete(signal.id);
        flush(entry.record);
      }
    }, horizon * 1000).unref?.();
  }
});

let lastLevel = "";
feed.onState((s) => {
  if (s.health.level !== lastLevel) {
    lastLevel = s.health.level;
    console.error(`[paper] feed ${s.health.level}${s.health.tradeable ? "" : ` — ${s.health.summary}`}`);
  }
});

function shutdown() {
  // Anything still waiting on a horizon is written with the outcomes it has,
  // so a run that is stopped early still yields usable rows.
  for (const { record } of pending.values()) flush(record);
  pending.clear();
  feed.close();
  console.error(`[paper] stopped — ${written} rows total in ${OUT}`);
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, shutdown);

console.error(`[paper] recording to ${OUT}`);
console.error(`[paper] horizons: ${HORIZONS.map((h) => `${h}s`).join(", ")} — first rows land ~15min after the first signal`);
console.error("[paper] ctrl-c to stop; partial rows are flushed on exit");
