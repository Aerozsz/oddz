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
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnv } from "./load-env";

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

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
    note("stopping — the control server is being shut down with this");
    child?.kill();
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
