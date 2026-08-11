/**
 * Keep the agent running for weeks without anyone watching it.
 *
 *   npm run sweep:keepalive          # supervise, restarting on exit
 *   npm run sweep:keepalive -- --install   # also survive a reboot (Windows)
 *
 * The control server supervises its own sharing, so trading and observability
 * can no longer die separately. That leaves one hole, and over a horizon of
 * weeks it is the one that matters: nothing restarts the control server. A
 * crash, an OS update, a power cut, a machine reboot at 04:00 — and the run is
 * over until a person notices, which on an unattended run means whenever they
 * next happen to look.
 *
 * This is the outermost loop. It does nothing except make sure the thing below
 * it is alive.
 *
 * ## What it deliberately does not do
 *
 * It never arms trading. The control server always boots disarmed, by design,
 * and this does not change that — a process that resumes placing orders on its
 * own after a crash is acting on a decision nobody was present to make. An
 * automatic restart brings back the monitor, the bridge and the analysis; the
 * operator brings back the trading.
 *
 * That distinction is the whole reason this is safe to run unattended. Any open
 * position keeps its stop on Binance throughout, which is why the position
 * survives the gap without supervision.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnv } from "./load-env";
import { killTree } from "../lib/sweep/agent/process-tree";
import { snapshotPath } from "../lib/sweep/metrics/snapshot";

loadEnv();

const install = process.argv.includes("--install");
const logPath = resolve(process.env.SWEEP_KEEPALIVE_LOG ?? "data/keepalive.log");

function note(text: string) {
  const line = `${new Date().toISOString()} ${text}`;
  console.error(`[keepalive] ${text}`);
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${line}\n`);
  } catch {
    /* a supervisor must never die of its own bookkeeping */
  }
}

/* ------------------------------------------------------------- reboot */

/**
 * Register a scheduled task so a reboot does not end the run.
 *
 * Windows only, because that is what the operator runs. Uses ONLOGON rather
 * than ONSTART: the task inherits the user session, which is where the
 * credentials in .env and the git identity live.
 */
function installAutoStart() {
  if (process.platform !== "win32") {
    note(`--install is Windows-only; on ${process.platform} use a systemd unit or launchd plist`);
    return;
  }
  const cwd = process.cwd();

  /*
   * A script file rather than an inline command.
   *
   * schtasks /TR takes one string, and a command containing `&&`, spaces and a
   * drive-qualified path needs nested quoting that differs between cmd.exe,
   * PowerShell and schtasks' own parser. Every layer gets a chance to mangle
   * it. A .cmd file has none of those problems: the task launches one path and
   * the file holds whatever it likes.
   */
  const script = resolve(cwd, "data", "sweep-start.cmd");
  try {
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(
      script,
      ["@echo off", `cd /d "${cwd}"`, "npm run sweep:keepalive", ""].join("\r\n"),
    );
  } catch (err) {
    note(`could not write ${script}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    execFileSync("schtasks", [
      "/Create", "/F",
      "/TN", "SweepAgentKeepalive",
      "/SC", "ONLOGON",
      "/RL", "LIMITED",
      "/TR", `"${script}"`,
    ], { stdio: "pipe" });
    note("registered scheduled task SweepAgentKeepalive — it starts on logon");
    note("remove it with:  schtasks /Delete /TN SweepAgentKeepalive /F");
  } catch (err) {
    note(`could not register the scheduled task: ${err instanceof Error ? err.message : String(err)}`);
    note("run this shell as Administrator, or start keepalive by hand after a reboot");
  }
}

/* ---------------------------------------------------------- supervision */

let child: ChildProcess | null = null;
let restarts = 0;
let startedAt = 0;
let stopping = false;

function start() {
  if (stopping || child) return;
  startedAt = Date.now();
  /*
   * `shell` on Windows, because npm is a .cmd there.
   *
   * Node 20.12 hardened spawn against the .bat/.cmd argument-injection class
   * (CVE-2024-27980) by refusing to launch them without a shell — so
   * `spawn("npm.cmd", ...)` now throws EINVAL rather than running. Every
   * argument here is a compile-time constant, so routing through cmd.exe costs
   * nothing and is the documented way to launch a .cmd.
   */
  const isWindows = process.platform === "win32";
  child = spawn(isWindows ? "npm.cmd" : "npm", ["run", "sweep:control"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
    shell: isWindows,
  });

  child.on("exit", (code, signal) => {
    const ranMs = Date.now() - startedAt;
    child = null;
    if (stopping) return;

    /*
     * A run that lasted a while is a crash; one that died immediately is a
     * configuration error, and retrying it fast just fills the log.
     *
     * The distinction matters over weeks: the first should come back in
     * seconds, and the second should back off until someone fixes it, while
     * still retrying — a missing .env at 03:00 might be a disk that has not
     * finished mounting.
     */
    const healthy = ranMs > 60_000;
    if (healthy) restarts = 0;
    else restarts++;
    const waitMs = healthy ? 5_000 : Math.min(300_000, 10_000 * 2 ** Math.min(restarts, 5));

    note(
      `control exited (${signal ?? code}) after ${Math.round(ranMs / 1000)}s — ` +
        `restarting in ${Math.round(waitMs / 1000)}s` +
        (healthy ? "" : ` (attempt ${restarts}; it did not stay up, so backing off)`),
    );
    setTimeout(start, waitMs);
  });

  child.on("error", (err) => {
    child = null;
    restarts++;
    note(`could not start control: ${err.message}`);
    setTimeout(start, Math.min(300_000, 10_000 * 2 ** Math.min(restarts, 5)));
  });
}

/* ------------------------------------------------------------- wedged */

/**
 * Restart a control server that is up but no longer doing anything.
 *
 * Everything above keys off the child exiting, and the failure that actually
 * ends a long run does not exit. A blocked event loop, a WebSocket that stopped
 * delivering without closing, a filesystem that went read-only — the process
 * stays in the table, the supervisor stays satisfied, and nothing has traded
 * since Tuesday.
 *
 * The snapshot is the liveness signal, because it is the one artefact the
 * server rewrites on a fixed 30-second timer regardless of what the market is
 * doing. Quiet markets do not stop it; only the server stopping stops it.
 *
 * The threshold is deliberately far above that timer. A restart is not free —
 * it drops the WebSocket and re-reads the account — so this must never fire on
 * a slow disk or a long GC pause. Ten minutes is twenty missed writes.
 */
const STALL_MS = 10 * 60_000;
/** Long enough for a cold start to have written its first snapshot. */
const GRACE_MS = 3 * 60_000;
let lastStallKillAt = 0;

function checkForStall() {
  if (stopping || !child || !startedAt) return;
  if (Date.now() - startedAt < GRACE_MS) return;
  // One restart per stall, not one per tick while the replacement warms up.
  if (Date.now() - lastStallKillAt < GRACE_MS + STALL_MS) return;

  let wroteAt = 0;
  try {
    wroteAt = statSync(snapshotPath()).mtimeMs;
  } catch {
    // No snapshot at all, well past the grace period, is itself the symptom.
  }

  const staleFor = Date.now() - Math.max(wroteAt, startedAt);
  if (staleFor < STALL_MS) return;

  lastStallKillAt = Date.now();
  note(
    `control is up but has not written a snapshot for ${Math.round(staleFor / 60_000)}m — ` +
      "killing it so it comes back. The process was alive, which is why nothing else caught this.",
  );
  // Any open position keeps its stop on Binance across the gap.
  killTree(child);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
    note("stopping — the control server is being shut down with this");
    /*
     * The whole tree, not the shell. On Windows the child is cmd.exe and node
     * lives underneath it; killing only the shell leaves a server holding 8787,
     * and the next start fails to bind, exits fast, and gets backed off as a
     * configuration error. The supervisor would then be the outage.
     */
    killTree(child);
    // Positions are unaffected: their stops rest on Binance and keep working.
    setTimeout(() => process.exit(0), 1500);
  });
}

if (install) installAutoStart();

note("");
note("supervising npm run sweep:control — it will be restarted if it exits");
note("trading is NOT re-armed automatically after a restart, by design:");
note("  an agent that resumes placing orders on its own is acting on a decision");
note("  nobody was there to make. Any open position keeps its stop on Binance.");
note(`log: ${logPath}`);
start();
// Deliberately referenced: this timer is also what guarantees the supervisor
// itself never runs out of work and exits while a child is being restarted.
setInterval(checkForStall, 60_000);
