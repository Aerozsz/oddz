// The engine has to construct and publish a complete snapshot outside a
// browser, since the workers all run headless. Nothing here touches the
// network — the point is that the new reads have safe empty shapes.
import { emptySnapshot } from "@/lib/sweep/engine";
import { assessHealth } from "@/lib/sweep/agent/health";
import { SignalEngine } from "@/lib/sweep/agent/signals";

const snap = emptySnapshot();
const checks: [string, boolean][] = [
  ["markout present and cold", snap.markout !== undefined && snap.markout.warm === false],
  ["funding present and empty", snap.funding !== undefined && snap.funding.rate === 0],
  ["events present and clear", snap.events !== undefined && snap.events.blackout === false],
  ["session carries weights", snap.session.weights.depthScale > 0],
  ["session carries an intraday phase", typeof snap.session.intraday === "string"],
];

// Detectors must survive an empty snapshot without throwing.
const eng = new SignalEngine();
const health = assessHealth(snap, Date.now());
let threw: string | null = null;
try {
  eng.detect(snap, health, Date.now());
  eng.detect(snap, health, Date.now() + 1000);
} catch (err) {
  threw = err instanceof Error ? err.message : String(err);
}
checks.push(["detectors survive an empty snapshot", threw === null]);
if (threw) console.log("  threw:", threw);

let fails = 0;
for (const [name, pass] of checks) {
  if (!pass) fails++;
  console.log(`${pass ? "  ok " : "FAIL "} ${name}`);
}
console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails ? 1 : 0);
