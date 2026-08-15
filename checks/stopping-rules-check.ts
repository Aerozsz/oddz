/**
 * The three rules that stop the day, and who owns them.
 *
 * maxDailyLossUsd, maxTradesPerDay and lossCooldownMin were all switched off
 * deliberately to collect data. Reset put them back, eight trades happened, and
 * the trade cap then blocked 510 of the next 747 signals while the page went on
 * reporting "armed" and "tradeable". Nothing here may re-enable them.
 */
import { rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DIR = "/tmp/sweep-checks/stoprules";
let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

function boot(limits: Record<string, unknown> | null, port: number, post?: string) {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const path = `${DIR}/limits.json`;
  if (limits) writeFileSync(path, JSON.stringify(limits));
  const env = { ...process.env, SWEEP_CONTROL_PORT: String(port), SWEEP_CONTROL_TOKEN: "tt",
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
    SWEEP_SYMBOLS: "BTCUSDT", BINANCE_API_KEY: "", BINANCE_API_SECRET: "" };
  // Waits for the server to be up rather than sleeping a guessed interval —
  // under load the fixed sleep expired before it had written anything, which
  // fails as ENOENT and looks like a bug in the thing being tested.
  /*
   * `timeout` in front rather than a background job and a kill.
   *
   * The backgrounded form raced: the server wrote its news heartbeat and was
   * killed before it wrote the limits file, so the read failed as ENOENT and
   * looked like the defaults being wrong rather than the harness being early.
   */
  const script = post
    ? `(sleep 12; curl -s -X POST "http://127.0.0.1:${port}${post}?token=tt" -H 'content-type: application/json' -d '{}' >/dev/null) & ` +
      `timeout 18 npx tsx workers/sweep-control.ts >${DIR}/out.log 2>&1; true`
    : `timeout 14 npx tsx workers/sweep-control.ts >${DIR}/out.log 2>&1; true`;
  execFileSync("bash", ["-c", script], { cwd: "/home/user/oddz", env, timeout: 90_000, stdio: "pipe" });
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, number | boolean>;
}

console.log("\n## a fresh install");
const fresh = boot(null, 7981);
ok("no daily loss cap by default", fresh.maxDailyLossUsd === 0, String(fresh.maxDailyLossUsd));
ok("no trade ceiling by default", fresh.maxTradesPerDay === 0, String(fresh.maxTradesPerDay));
ok("no cooldown by default", fresh.lossCooldownMin === 0, String(fresh.lossCooldownMin));

console.log("\n## Reset must not turn them back on");
const afterReset = boot(
  { maxPositionUsd: 32845, maxDailyLossUsd: 0, maxTradesPerDay: 0, lossCooldownMin: 0 },
  7982, "/api/limits/reset");
ok("the daily loss cap stays off through a reset", afterReset.maxDailyLossUsd === 0, String(afterReset.maxDailyLossUsd));
ok("the trade ceiling stays off through a reset", afterReset.maxTradesPerDay === 0, String(afterReset.maxTradesPerDay));
ok("the cooldown stays off through a reset", afterReset.lossCooldownMin === 0, String(afterReset.lossCooldownMin));

console.log("\n## an operator who wants them keeps them");
const wanted = boot({ maxDailyLossUsd: 500, maxTradesPerDay: 12, lossCooldownMin: 30 }, 7983);
ok("a chosen loss cap is kept", wanted.maxDailyLossUsd === 500, String(wanted.maxDailyLossUsd));
ok("a chosen trade ceiling is kept", wanted.maxTradesPerDay === 12, String(wanted.maxTradesPerDay));
ok("a chosen cooldown is kept", wanted.lossCooldownMin === 30, String(wanted.lossCooldownMin));

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
