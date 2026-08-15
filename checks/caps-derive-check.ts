/**
 * Which caps get filled in, and which are left alone.
 *
 * The regression this pins: capsDerivedAt did not exist before, so every
 * upgrading install read it as 0 — "fresh, derive everything" — and the first
 * boot put a daily loss budget back onto an account that had deliberately
 * switched it off to collect data, then halted trading three stop-outs later.
 */
import { rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DIR = "/tmp/sweep-checks/capsderive";
let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

/** Boot the control server against a limits file and return what it wrote. */
function boot(limits: Record<string, unknown> | null, port: number) {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const path = `${DIR}/limits.json`;
  if (limits) writeFileSync(path, JSON.stringify(limits));
  try {
    execFileSync("npx", ["tsx", "workers/sweep-control.ts"], {
      cwd: "/home/user/oddz",
      timeout: 22_000,
      env: { ...process.env,
        SWEEP_CONTROL_PORT: String(port), SWEEP_CONTROL_TOKEN: "tt",
        SWEEP_STATUS_DIR: DIR, SWEEP_NEWS: `${DIR}/news.json`, SWEEP_LIMITS: path,
        SWEEP_LEDGER: `${DIR}/ledger.json`,
    // Kept out of the repository: the default path is evidence/snapshot.json,
    // and a test server writing there overwrites the operator\'s real state.
        // Pointed at a path that does not exist, so the repository's own
        // control/limits.json cannot reach in and change what this is asserting.
        // It is a real instruction to a real install; a test booting a fresh
        // install would apply it exactly as the operator's machine will.
        SWEEP_DESIRED: `${DIR}/no-desired.json`,

    SWEEP_SNAPSHOT: `${DIR}/snapshot.json`, SWEEP_SYMBOLS_FILE: `${DIR}/symbols.json`,
        SWEEP_SYMBOLS: "BTCUSDT",
        // No credentials, so the balance is unreadable and nothing can be
        // derived — which is exactly the case that must not corrupt anything.
        BINANCE_API_KEY: "", BINANCE_API_SECRET: "" },
      stdio: "pipe",
    });
  } catch { /* the timeout is how it stops */ }
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
}

console.log("\n## an existing install whose loss budget was switched off on purpose");
const upgraded = boot({ maxPositionUsd: 33000, maxDailyLossUsd: 0, maxTradesPerDay: 0,
  lossCooldownMin: 0, riskPerTradePct: 4, maxLeverage: 10, stopLossPct: 0.5 }, 7931);
ok("the daily loss budget stays off", upgraded.maxDailyLossUsd === 0, String(upgraded.maxDailyLossUsd));
ok("the trade cap stays off", upgraded.maxTradesPerDay === 0, String(upgraded.maxTradesPerDay));
ok("the cooldown stays off", upgraded.lossCooldownMin === 0, String(upgraded.lossCooldownMin));
ok("the position cap is untouched", upgraded.maxPositionUsd === 33000, String(upgraded.maxPositionUsd));
ok("it is marked as pre-existing rather than freshly derived",
  upgraded.capsDerivedAt === 1, String(upgraded.capsDerivedAt));

console.log("\n## the same install, but the position cap is the thing that is empty");
const broken = boot({ maxPositionUsd: 0, maxDailyLossUsd: 0, maxTradesPerDay: 0,
  riskPerTradePct: 4, maxLeverage: 10, stopLossPct: 0.5 }, 7932);
ok("the loss budget is still left off", broken.maxDailyLossUsd === 0, String(broken.maxDailyLossUsd));
// No credentials here, so it cannot actually derive — the point is that it does
// not silently fill in the one that must never be filled in.
ok("nothing was invented from an unreadable balance", broken.maxPositionUsd === 0, String(broken.maxPositionUsd));

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
