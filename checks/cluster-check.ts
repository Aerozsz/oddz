import { assessHealth } from "../lib/sweep/agent/health";
import { SignalEngine } from "../lib/sweep/agent/signals";
import { emptySnapshot } from "../lib/sweep/engine";
import type { Cluster, Snapshot } from "../lib/sweep/types";

let fail = 0;
const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL: " + m); fail++; } else console.log("ok   " + m); };

const NOW = 1_800_000_000_000;
const snap = (clusters: Cluster[]): Snapshot => {
  const s = emptySnapshot();
  return { ...s, ts: NOW,
    meta: { symbol: "INTCUSDT", tickSize: .01, stepSize: .01, pricePrecision: 2, quantityPrecision: 2, status: "TRADING", contractType: "PERPETUAL" },
    connection: { ...s.connection, socket: "open", bookSynced: true, lastMessageAt: NOW - 100 },
    mid: 100, bestBid: 99.99, bestAsk: 100.01,
    openInterest: { qty: 1e3, notional: 1e5, t: NOW, fetchedAt: NOW - 1000 },
    liquidity: { bands: [], primary: { bps: 25, bidNotional: 5e5, askNotional: 5e5 } as never, costCurve: [], walls: [],
      lwi: 1, lwiBid: 1, lwiAsk: 1, warm: true, baselineNotional: 1e6, fastNotional: 1e6,
      decomp: { windowSec: 10, consumedBid: 0, consumedAsk: 0, withdrawnBid: 0, withdrawnAsk: 0, addedBid: 0, addedAsk: 0 },
      imbalance: 0, spreadBps: 2 },
    clusters } as Snapshot;
};

// Mirrors buildClusters: an observed cluster of 5M gross ends up notional=1M, spent=5M.
const observed: Cluster = { price: 99.8, effect: "amplifying", pushes: "down",
  notional: 1_000_000, confidence: .95, sources: ["observed"], spent: 5_000_000, distPct: -.2 };

const det = new SignalEngine();
const base = snap([]);
det.detect(base, assessHealth(base, NOW), NOW);

const s = snap([observed]);
const sigs = det.detect(s, assessHealth(s, NOW + 1000), NOW + 1000);
const approach = sigs.filter((x) => x.kind === "cluster-approach");
assert(approach.length === 1, `an observed cluster near mid emits cluster-approach (got ${approach.length})`);
assert(approach[0]?.data.notional === 1_000_000, `it reports the net notional (got ${approach[0]?.data.notional})`);
assert(approach[0]?.price === 99.8, "anchored to the cluster price");

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exitCode = fail ? 1 : 0;
