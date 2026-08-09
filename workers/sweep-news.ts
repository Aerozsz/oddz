/**
 * Collect headlines and crowd chatter on a timer, standalone.
 *
 *   npm run sweep:news
 *
 * You almost certainly do not need this. `npm run sweep:control` runs the same
 * collection loop in-process, so the single command that starts the agent also
 * starts its feeds — an operator who has to remember a second terminal is an
 * operator who will eventually forget it, and a forgotten feed does not raise an
 * error, it produces an agent trading with no awareness of the outside world.
 *
 * This exists for the two cases where a separate process is genuinely better:
 * collecting on a machine that is not running the control server, and watching
 * the feed's own output while debugging a source. When it is running, the
 * control server notices and stands down, so the two never double up.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { beat } from "./heartbeat";
import { loadEnv } from "./load-env";
import { newsPath } from "../lib/sweep/metrics/news-store";
import { startNewsPoller } from "../lib/sweep/metrics/news-poller";
import { available, unavailable } from "../lib/sweep/metrics/sources";

loadEnv();

console.error("");
console.error(`[news] ${available().length} sources live, polling continuously:`);
for (const s of available()) console.error(`         ${s.label} every ${s.everySec}s (${s.kind})`);
for (const s of unavailable()) console.error(`  [off]  ${s.label} — ${s.unavailable ?? "not configured"}`);
console.error(`[news] writing to ${newsPath()}`);
console.error("[news] forums and social drive mention velocity only — never recorded as headlines");
console.error("[news] impact never implies a direction");
console.error("");

const poller = startNewsPoller({
  onLine: (line) => console.error(`[news] ${line}`),
  onHigh: (headline, source) => console.error(`[news] HIGH  ${source}: ${headline.slice(0, 100)}`),
});

const stopBeat = beat("sweep-news", () => ({ ...poller.status(), out: newsPath() }));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    poller.stop();
    stopBeat();
    console.error(`[news] stopped — ${poller.status().recorded} items recorded to ${newsPath()}`);
    process.exit(0);
  });
}

// The poller's timer is unref'd so it can never hold a process open on its own.
// This one is what keeps the standalone worker running.
for (;;) await sleep(60_000);
