/**
 * Run the research loop on the machine that has the data, forever.
 *
 *   npm run sweep:research            # once
 *   npm run sweep:research -- --watch # every 6 hours, until stopped
 *
 * ## Why this exists
 *
 * The analysis does not run where the network is. Binance is reachable from the
 * operator's machine and not from where the reasoning happens, and the gap was
 * being bridged by the operator: run the fetch, run the replay, paste the
 * output, wait for a fix, run it again. Days went that way, and every round trip
 * was a task a timer could have done.
 *
 * So the timer does it. This fetches whatever history is missing, replays it,
 * and writes the ranking into `evidence/` — which the share worker already
 * pushes every two minutes. The result arrives on its own, and nobody has to be
 * awake for it.
 *
 * ## What it will not do
 *
 * Nothing here places an order, reads a credential, or touches the trading path.
 * It downloads public files and does arithmetic on them. It is deliberately a
 * separate process from the control server for the same reason sharing is: a
 * process that can trade should not also be the process doing bulk downloads,
 * and stopping the research must never stop the agent.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { loadEnv } from "./load-env";

loadEnv();

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};

const watch = process.argv.includes("--watch");
const everyHours = Number(arg("every", "6"));
const days = arg("days", "365");
/*
 * Tick data, on its own much shorter window.
 *
 * aggTrades is about a gigabyte a month, so it is fetched for a handful of
 * recent days rather than the full year — enough to answer whether the
 * mechanism exists below one minute, which is the resolution the sweep thesis
 * actually claims and the only one never measured. Everything so far tested a
 * seconds-scale hypothesis on one-minute bars.
 *
 * Off by default so a fresh install does not silently pull gigabytes; the
 * control server turns it on, because on that machine it is the next
 * experiment and waiting for someone to remember to pass a flag is how it went
 * two days without running.
 */
const tickDays = arg("tick-days", process.env.SWEEP_TICK_DAYS ?? "7");
const wantTicks = process.argv.includes("--ticks") || Number(tickDays) > 0;
const symbols = (process.env.SWEEP_SYMBOLS ?? "BTCUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const note = (text: string) => console.error(`[research] ${text}`);

/**
 * One npm script, to completion, never throwing.
 *
 * A failure in one symbol's fetch must not stop the others or end the loop —
 * this runs unattended for weeks, and the commonest reason a step fails is a
 * date the archive has not published yet, which fixes itself tomorrow.
 */
function run(script: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const child = spawn(isWindows ? "npm.cmd" : "npm", ["run", script, "--", ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
      // npm is a .cmd on Windows and Node 20.12 refuses to spawn one without a
      // shell (CVE-2024-27980). Every argument here is ours, not a user's.
      shell: isWindows,
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", (err) => {
      note(`could not start ${script}: ${err.message}`);
      resolve(false);
    });
  });
}

async function pass() {
  for (const symbol of symbols) {
    note(`${symbol}: fetching up to ${days} days`);
    /*
     * Cached files are skipped, so a repeat pass only pulls what is new. That
     * is what makes a six-hourly loop cheap enough to leave running: the first
     * pass is a download and every one after it is a day or two.
     */
    await run("sweep:history", ["--symbol", symbol, "--days", days]);
    if (wantTicks) {
      note(`${symbol}: fetching ${tickDays} days of ticks`);
      await run("sweep:history", ["--symbol", symbol, "--days", tickDays, "--ticks"]);
    }
    note(`${symbol}: replaying`);
    const ok = await run("sweep:backtest", ["--symbol", symbol]);
    note(
      ok
        ? `${symbol}: ranking written to evidence/backtest-${symbol}.json`
        : `${symbol}: the replay refused — see its message above; nothing was written`,
    );
  }
}

async function main() {
  console.error("");
  note(`symbols: ${symbols.join(", ")}`);
  note(`history:  ${days} days, incremental`);
  note("output:   evidence/backtest-<symbol>.json, which the share worker pushes");
  note("this never places an order and never reads a credential");
  console.error("");

  await pass();
  if (!watch) return;

  const everyMs = Math.max(1, everyHours) * 3_600_000;
  note(`watching — another pass every ${everyHours}h. Ctrl-C to stop.`);
  for (;;) {
    await sleep(everyMs);
    await pass().catch((err) => note(`pass failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

main().catch((err) => {
  note(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
