/** Verifies the interlocks in attachExecution with a hand-driven feed. */
import { attachExecution, createDryRunAdapter, intentId } from "../lib/sweep/agent/execution";
import type { SweepFeed } from "../lib/sweep/agent/feed";
import type { AgentState, Signal } from "../lib/sweep/agent/types";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; } else console.log(`ok   ${msg}`);
}

/** A feed whose signals we push by hand. */
function fakeFeed() {
  const listeners = new Set<(s: Signal, st: AgentState) => void>();
  /*
   * Deliberately partial: this exercises the signal plumbing, not the feed.
   * Cast rather than stubbed out in full, so the day a caller starts reading a
   * new feed method this fails at runtime where it matters instead of being
   * silently satisfied by an empty implementation.
   */
  const feed = {
    getState: () => ({}) as AgentState,
    recentSignals: () => [],
    onSignal(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    onState() { return () => {}; },
    close() { listeners.clear(); },
  } as unknown as SweepFeed;
  return {
    feed,
    emit(signal: Signal, state: AgentState) { for (const cb of listeners) cb(signal, state); },
  };
}

const sig = (id: string): Signal => ({
  id, kind: "withdrawal", t: Date.now(), severity: "warning",
  direction: "down", price: 100, detail: "test", data: {},
});

const state = (tradeable: boolean): AgentState =>
  ({ mid: 100, bestAsk: 100.01, nearestBelow: null, health: { tradeable, summary: tradeable ? "live" : "blind — socket down" } }) as AgentState;

// --- the gate ---------------------------------------------------------------
{
  const { feed, emit } = fakeFeed();
  const adapter = createDryRunAdapter();
  const rejects: string[] = [];
  const runner = attachExecution(feed, {
    adapter,
    strategy: (s, st) => ({
      id: intentId(s), t: Date.now(), side: "sell", signalId: s.id, signalKind: s.kind,
      reason: s.detail, confidence: 0.5,
      reference: { mid: st.mid!, trigger: null, invalidation: null },
    }),
    onRejected: (reason) => rejects.push(reason),
  });

  emit(sig("a"), state(false));
  assert(adapter.intents.length === 0, "an untradeable feed submits nothing");
  // Not a refusal. Nothing was proposed and nothing was turned down — the feed
  // was not fit to be asked, which at start-up is just the first thirty seconds
  // while the depth baseline establishes. Counting it as a refusal put a burst
  // of alarming lines in the log at every launch and inflated the one tally
  // that has to stay trustworthy.
  assert(rejects.length === 0, "a cold feed is not reported as a refusal");
  assert(runner.stats().notReady === 1, "...it is counted as not-ready");
  assert(runner.stats().rejected === 0, "...and not as rejected");

  emit(sig("b"), state(true));
  assert(adapter.intents.length === 1, "a tradeable feed submits");
}

// --- dedupe + cooldown + ceiling -------------------------------------------
{
  const { feed, emit } = fakeFeed();
  const adapter = createDryRunAdapter();
  const rejects: string[] = [];
  attachExecution(feed, {
    adapter,
    minIntervalMs: 0,
    maxPerHour: 2,
    // Deliberately constant id, to prove dedupe rather than the strategy.
    strategy: (s, st) => ({
      id: "constant-id", t: Date.now(), side: "buy", signalId: s.id, signalKind: s.kind,
      reason: s.detail, confidence: 1,
      reference: { mid: st.mid!, trigger: null, invalidation: null },
    }),
    onRejected: (reason) => rejects.push(reason),
  });

  emit(sig("c"), state(true));
  emit(sig("d"), state(true));
  assert(adapter.intents.length === 1, "the same intent id is delivered once");
  assert(rejects.some((r) => r.includes("duplicate")), "the duplicate is reported");
}

{
  const { feed, emit } = fakeFeed();
  const adapter = createDryRunAdapter();
  const rejects: string[] = [];
  let n = 0;
  attachExecution(feed, {
    adapter,
    minIntervalMs: 0,
    maxPerHour: 2,
    strategy: (s, st) => ({
      id: `unique-${n++}`, t: Date.now(), side: "buy", signalId: s.id, signalKind: s.kind,
      reason: s.detail, confidence: 1,
      reference: { mid: st.mid!, trigger: null, invalidation: null },
    }),
    onRejected: (reason) => rejects.push(reason),
  });

  for (let i = 0; i < 5; i++) emit(sig(`e${i}`), state(true));
  assert(adapter.intents.length === 2, `the hourly ceiling holds (got ${adapter.intents.length})`);
  assert(rejects.some((r) => r.includes("ceiling")), "the ceiling is reported");
}

// --- cooldown ---------------------------------------------------------------
{
  const { feed, emit } = fakeFeed();
  const adapter = createDryRunAdapter();
  let n = 0;
  attachExecution(feed, {
    adapter,
    minIntervalMs: 60_000,
    strategy: (s, st) => ({
      id: `cd-${n++}`, t: Date.now(), side: "buy", signalId: s.id, signalKind: s.kind,
      reason: s.detail, confidence: 1,
      reference: { mid: st.mid!, trigger: null, invalidation: null },
    }),
  });
  emit(sig("f0"), state(true));
  emit(sig("f1"), state(true));
  assert(adapter.intents.length === 1, "correlated signals inside the cooldown collapse to one");
}

// --- a throwing strategy must not break the feed ----------------------------
{
  const { feed, emit } = fakeFeed();
  const adapter = createDryRunAdapter();
  const rejects: string[] = [];
  const runner = attachExecution(feed, {
    adapter,
    minIntervalMs: 0,
    strategy: () => { throw new Error("boom"); },
    onRejected: (reason) => rejects.push(reason),
  });
  emit(sig("g"), state(true));
  assert(rejects.some((r) => r.includes("strategy threw")), "a throwing strategy is contained");
  assert(runner.stats().accepted === 0, "nothing is accepted from a throwing strategy");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
