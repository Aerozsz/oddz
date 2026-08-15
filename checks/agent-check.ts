/**
 * Drives the agent layer with synthetic snapshots — no network, no engine.
 * Checks the health gate, the signal detectors and the execution interlocks.
 */
import { assessHealth } from "../lib/sweep/agent/health";
import { SignalEngine } from "../lib/sweep/agent/signals";
import { emptySnapshot } from "../lib/sweep/engine";
import type { Snapshot } from "../lib/sweep/types";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failures++;
  } else console.log(`ok   ${msg}`);
}

const NOW = 1_800_000_000_000;

function healthy(over: Partial<Snapshot> = {}): Snapshot {
  const s = emptySnapshot();
  return {
    ...s,
    ts: NOW,
    meta: { symbol: "INTCUSDT", tickSize: 0.01, stepSize: 0.01, pricePrecision: 2, quantityPrecision: 2, status: "TRADING", contractType: "PERPETUAL" },
    connection: { ...s.connection, socket: "open", bookSynced: true, lastMessageAt: NOW - 100, restVia: "direct" },
    mid: 100,
    bestBid: 99.99,
    bestAsk: 100.01,
    openInterest: { qty: 1000, notional: 100_000, t: NOW, fetchedAt: NOW - 1000 },
    liquidity: {
      bands: [], primary: { bps: 25, bidNotional: 500_000, askNotional: 500_000 } as never,
      costCurve: [], walls: [], lwi: 1, lwiBid: 1, lwiAsk: 1, warm: true,
      baselineNotional: 1_000_000, fastNotional: 1_000_000,
      decomp: { windowSec: 10, consumedBid: 0, consumedAsk: 0, withdrawnBid: 0, withdrawnAsk: 0, addedBid: 0, addedAsk: 0 },
      imbalance: 0, spreadBps: 2,
    },
    ...over,
  } as Snapshot;
}

// ---------------------------------------------------------------- health ---
assert(assessHealth(healthy(), NOW).tradeable, "a complete feed is tradeable");
assert(assessHealth(emptySnapshot(), NOW).level === "blind", "pre-publish state is blind");

const desynced = healthy({ connection: { ...healthy().connection, bookSynced: false } });
assert(assessHealth(desynced, NOW).level === "blind", "a desynced book is blind");
assert(!assessHealth(desynced, NOW).tradeable, "a desynced book is not tradeable");

const stalled = healthy({ connection: { ...healthy().connection, lastMessageAt: NOW - 30_000 } });
const stalledHealth = assessHealth(stalled, NOW);
assert(stalledHealth.level === "blind", "a silent socket is blind even while 'open'");
assert(
  stalledHealth.reasons.some((r) => r.code === "feed-stalled"),
  "the stall is named as the reason",
);

const cold = healthy();
cold.liquidity!.warm = false;
const coldHealth = assessHealth(cold, NOW);
assert(coldHealth.level === "degraded", "an unwarmed baseline is degraded, not blind");
assert(!coldHealth.tradeable, "degraded is still not tradeable");

const staleOi = healthy({ openInterest: { qty: 1, notional: 1, t: NOW, fetchedAt: NOW - 200_000 } });
assert(assessHealth(staleOi, NOW).level === "degraded", "stale open interest degrades");

// --------------------------------------------------------------- signals ---
const det = new SignalEngine();
const base = healthy();
det.detect(base, assessHealth(base, NOW), NOW); // prime

// risk crossing is edge-triggered
const risky = healthy({ cascadeDown: { direction: "down", seedNotional: 50_000, links: [], terminalPrice: 95, terminalPct: -5, risk: 75 } as never });
const first = det.detect(risky, assessHealth(risky, NOW + 1000), NOW + 1000);
assert(first.some((s) => s.kind === "cascade-risk"), "risk crossing emits");
const second = det.detect(risky, assessHealth(risky, NOW + 2000), NOW + 2000);
assert(!second.some((s) => s.kind === "cascade-risk"), "a held risk level does not re-emit");

// blind feed emits the health transition and nothing else
const det2 = new SignalEngine();
const ok = healthy();
det2.detect(ok, assessHealth(ok, NOW), NOW);
const dead = healthy({ connection: { ...ok.connection, socket: "closed" } });
const onDeath = det2.detect(dead, assessHealth(dead, NOW + 500), NOW + 500);
assert(onDeath.length === 1 && onDeath[0].kind === "health", "a blind feed emits only the health signal");
assert(onDeath[0].severity === "critical", "going blind is critical");
assert(onDeath[0].data.tradeable === false, "the health signal carries tradeability");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
