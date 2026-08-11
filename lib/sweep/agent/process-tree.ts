/**
 * Kill a child process and everything it started.
 *
 * On Windows npm is a .cmd, so both supervisors here spawn through cmd.exe
 * (Node 20.12 refuses to launch a .cmd without a shell — CVE-2024-27980). That
 * makes the child a shell, and `child.kill()` kills the shell: the node process
 * underneath keeps running, keeps its port, and is now parented by nothing.
 *
 * Over a single session that is invisible. Over the weeks this run is meant to
 * last it is the failure that ends it — every restart leaves one more orphan
 * holding 8787, and the replacement control server exits immediately on a bind
 * error, which the supervisor reads as "died fast, back off" and eventually
 * stops trying. A supervisor that manufactures the outage it exists to prevent.
 *
 * `taskkill /T` walks the tree by parent PID and takes the whole thing.
 * Elsewhere a process group signal already does that, so `kill()` is correct as
 * it stands.
 */

import { execFileSync, type ChildProcess } from "node:child_process";

export function killTree(child: ChildProcess | null | undefined): void {
  if (!child) return;
  const pid = child.pid;

  if (process.platform === "win32" && pid) {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      /*
       * Already gone, or taskkill is not on PATH. Fall through to the ordinary
       * kill — it is worse, but a shutdown path must not throw.
       */
    }
  }

  try {
    child.kill();
  } catch {
    /* it exited between the check and the call */
  }
}
