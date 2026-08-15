/**
 * Settings survive an update, and no cap can take the system down.
 *
 * Both of these cost a live session. A migration rewrote values the operator had
 * typed, and a blank max-position field refused every order before the strategy
 * was consulted — so a single empty box read as "the agent stopped working".
 */
import { rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DIR = "/tmp/sweep-checks/persist";
let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

function boot(limits: Record<string, unknown>, port: number) {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const path = `${DIR}/limits.json`;
  writeFileSync(path, JSON.stringify(limits));
  /*
   * `timeout` in front of the command rather than execFileSync's own.
   *
   * execFileSync kills the whole invocation on its deadline, including a `npx`
   * that has not finished resolving under load — so the server never reached
   * the point where it writes the limits file, and the read failed as
   * "undefined" and read like the defaults being wrong. This gives the server
   * its own clock.
   */
  execFileSync("bash", ["-c", `timeout 16 npx tsx workers/sweep-control.ts >${DIR}/out.log 2>&1; true`],
    { cwd: "/home/user/oddz", timeout: 60_000, stdio: "pipe",
      env: { ...process.env, SWEEP_CONTROL_PORT: String(port), SWEEP_CONTROL_TOKEN: "tt",
        SWEEP_STATUS_DIR: DIR, SWEEP_NEWS: `${DIR}/news.json`, SWEEP_LIMITS: path,
        SWEEP_LEDGER: `${DIR}/ledger.json`,
        // Pointed at a path that does not exist, so the repository's own
        // control/limits.json cannot reach in and change what this is asserting.
        // It is a real instruction to a real install; a test booting a fresh
        // install would apply it exactly as the operator's machine will.
        SWEEP_DESIRED: `${DIR}/no-desired.json`,

        SWEEP_SNAPSHOT: `${DIR}/snapshot.json`,
        SWEEP_SYMBOLS_FILE: `${DIR}/symbols.json`,
        SWEEP_SYMBOLS: "BTCUSDT", BINANCE_API_KEY: "", BINANCE_API_SECRET: "" } });
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, number | boolean>;
}

console.log("\n## every value the operator set survives a restart");
// Deliberately unusual on purpose: none of these are any default, old or new.
const mine = {
  maxPositionUsd: 12345, maxLeverage: 7, maxDailyLossUsd: 0, maxOpenPositions: 2,
  stopLossPct: 0.37, maxTradesPerDay: 0, lossCooldownMin: 0, minRewardRisk: 1.2,
  maxHoldMinutes: 30, riskPerTradePct: 3.5, sizeDerateStrength: 0.25,
  breakEvenAtPct: 55, minRewardOverFees: 1.5, marginHeadroomPct: 9,
  trailArmsAtR: 0.8, scaleOutAtR: 1.3, scaleOutFraction: 33,
};
const after = boot(mine, 7941);
for (const [k, v] of Object.entries(mine)) {
  ok(`${k} kept at ${v}`, after[k] === v, `got ${after[k]}`);
}

console.log("\n## the old migration would have moved these two — it must not");
ok("minRewardRisk was NOT bumped to 2", after.minRewardRisk === 1.2, String(after.minRewardRisk));
ok("maxHoldMinutes was NOT bumped to 120", after.maxHoldMinutes === 30, String(after.maxHoldMinutes));

console.log("\n## a blank cap is a missing key, so the default fills it");
const sparse = boot({ stopLossPct: 0.42 }, 7942);
ok("the value that was set is kept", sparse.stopLossPct === 0.42, String(sparse.stopLossPct));
ok("an absent key takes the default", sparse.maxLeverage === 10, String(sparse.maxLeverage));

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
