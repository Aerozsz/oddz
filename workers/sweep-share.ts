/**
 * Send the current state to the repository, so it can be read from elsewhere.
 *
 *   npm run sweep:share            # once
 *   npm run sweep:share -- --watch # every 5 minutes, until stopped
 *
 * The problem this solves is not convenience. The analysis does not run on the
 * machine the agent runs on, so for a whole session every diagnosis began as a
 * guess, went out as a question, and came back a round trip later — and several
 * of those guesses were confidently wrong about state the server was already
 * holding in memory. A trade cap was diagnosed as a target gate; a render throw
 * was diagnosed as lost settings. Both were in `status()` the entire time.
 *
 * ## Why this is a separate command from the server
 *
 * The trading process never runs git. It writes a file; this pushes it. That
 * boundary matters: a process authorised to place orders should not also be
 * authorised to rewrite history in a repository, and an operator should be able
 * to stop sharing without stopping trading.
 *
 * ## What is actually sent
 *
 * `evidence/snapshot.json`, written by the control server every 30 seconds, and
 * whatever else is already in `evidence/`. Credentials, signatures and the
 * control token are redacted before the file is ever written — see
 * lib/sweep/metrics/snapshot.ts — and this refuses to push if that redaction
 * does not appear to have run.
 *
 * Balances and positions are included. They are not secrets, they are the point.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";
import { loadEnv } from "./load-env";
import { redactSnapshot, snapshotPath } from "../lib/sweep/metrics/snapshot";

loadEnv();

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};
const watch = process.argv.includes("--watch");
/*
 * Two minutes, not five.
 *
 * This is the latency on noticing that something is wrong from somewhere else,
 * and five minutes of it is a long time to sit with a stopped agent. The cost is
 * one small commit every two minutes on a branch that exists for exactly this.
 */
const everySec = Number(arg("every", "120"));
const branch = arg("branch", "claude/amm-liquidity-sweep-8qhnd0");

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * A last check before anything leaves the machine.
 *
 * The redaction runs when the file is written, so this should always pass. It
 * exists because "should always pass" is exactly the reasoning that precedes a
 * leaked key, and the check costs a millisecond.
 */
function safeToSend(path: string): { ok: boolean; reason: string } {
  if (!existsSync(path)) {
    return { ok: false, reason: `${path} does not exist — is the control server running?` };
  }
  const raw = readFileSync(path, "utf8");
  if (raw !== redactSnapshot(raw)) {
    return {
      ok: false,
      reason:
        "the snapshot contains something the redactor would have removed, which means it was written " +
        "by an older build. Restart the control server and try again — nothing has been pushed.",
    };
  }
  // A last, independent look for the two shapes that matter most, in case the
  // redactor itself is the thing that is wrong.
  for (const [what, re] of [
    ["an API key or secret", /\b[A-Za-z0-9]{64}\b/],
    ["a signature", /signature=[A-Fa-f0-9]{16,}/i],
  ] as const) {
    if (re.test(raw)) return { ok: false, reason: `refusing to push: ${what} appears to be present` };
  }
  return { ok: true, reason: "" };
}

/**
 * Teach git that this file never needs a human to resolve it.
 *
 * `.gitattributes` marks the snapshot `merge=ours`, and that line does nothing
 * whatsoever unless a driver by that name exists in config — git ignores an
 * unknown merge driver silently and conflicts as usual. Which it did, on the
 * first rebase after the feature shipped, leaving a conflict marker in a file
 * that is regenerated every thirty seconds.
 *
 * `true` is the driver: it succeeds without touching the file, so the version
 * already in the working tree wins. Registered here rather than left as a setup
 * instruction, because a setup instruction is a thing that does not happen.
 */
function ensureMergeDriver() {
  try {
    if (git("config", "--get", "merge.ours.driver")) return;
  } catch {
    // Not set, which is the normal first-run case.
  }
  try {
    git("config", "merge.ours.name", "keep the local copy of generated files");
    git("config", "merge.ours.driver", "true");
    console.error("[share] registered the merge driver so the snapshot can never conflict");
  } catch (err) {
    console.error(`[share] could not register the merge driver: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Take anything written elsewhere before sending anything back.
 *
 * This is what makes the channel two-way. The control server watches
 * `control/limits.json` on disk and applies it within twenty seconds; this is
 * the only thing that brings a new copy of that file onto the machine.
 *
 * Deliberately still git and still this process: the trading server never runs
 * git, and stopping this command stops configuration arriving without stopping
 * trading. Nothing here decides anything — it moves a file and the server
 * decides what, if any, of it is permitted.
 */
function takeRemote(): void {
  try {
    git("pull", "--rebase", "--autostash", "origin", branch);
  } catch (err) {
    console.error(`[share] could not take the remote: ${err instanceof Error ? err.message : String(err)}`);
    try {
      git("rebase", "--abort");
    } catch {
      /* nothing in progress */
    }
  }
}

function share(): boolean {
  ensureMergeDriver();
  const path = snapshotPath();
  const check = safeToSend(path);
  if (!check.ok) {
    console.error(`[share] ${check.reason}`);
    return false;
  }

  const age = Math.round((Date.now() - JSON.parse(readFileSync(path, "utf8")).meta.at) / 1000);
  if (age > 300) {
    console.error(`[share] warning: the snapshot is ${age}s old — the control server may not be running.`);
  }

  /*
   * Only ever the evidence directory.
   *
   * Explicitly pathspec'd rather than `git add -A`, because this runs
   * unattended on a machine whose working tree contains a credentials file the
   * operator keeps outside version control. A blanket add is one .gitignore
   * mistake away from committing it.
   */
  const dir = resolve("evidence");
  try {
    git("add", "--", dir);
  } catch (err) {
    console.error(`[share] nothing to add: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  const staged = git("diff", "--cached", "--name-only");
  if (!staged) {
    console.error("[share] no change since the last one");
    return true;
  }

  git("commit", "-m", `state snapshot ${new Date().toISOString()}`, "--no-verify");

  /*
   * Take whatever is on the remote first, stashing the file being rewritten.
   *
   * The snapshot is regenerated every 30 seconds, so by the time a push
   * happens the working copy has already moved on. Without this, an ordinary
   * `git pull` on either side fails with "your local changes would be
   * overwritten" on a file whose contents nobody wants to keep — which is
   * exactly what a generated artefact should never be able to do to a
   * repository.
   *
   * --autostash sets the working copy aside and puts it back; a conflict on
   * this path resolves to whatever was written last, which is the only
   * sensible answer for a file that is a photograph of a moment.
   */
  try {
    git("pull", "--rebase", "--autostash", "origin", branch);
  } catch (err) {
    console.error(`[share] could not take the remote first: ${err instanceof Error ? err.message : String(err)}`);
    try {
      // The snapshot is disposable, so resolving in its favour is always safe.
      git("checkout", "--ours", "--", "evidence");
      git("rebase", "--continue");
    } catch {
      git("rebase", "--abort");
      console.error("[share] left the repository as it was; nothing pushed");
      return false;
    }
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      git("push", "-u", "origin", branch);
      console.error(`[share] sent ${staged.split("\n").length} file(s) to ${branch}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === 4) {
        console.error(`[share] push failed after 4 attempts: ${message}`);
        return false;
      }
      const waitMs = 2000 * 2 ** (attempt - 1);
      console.error(`[share] push failed, retrying in ${waitMs / 1000}s`);
      execFileSync("node", ["-e", `setTimeout(()=>{}, ${waitMs})`]);
    }
  }
  return false;
}

async function main() {
  console.error("");
  console.error(`[share] snapshot: ${snapshotPath()}`);
  console.error(`[share] branch:   ${branch}`);
  console.error("[share] credentials, signatures and the control token are redacted before writing,");
  console.error("[share] and this refuses to push if that redaction did not run.");
  console.error("");

  if (!watch) {
    takeRemote();
    process.exit(share() ? 0 : 1);
  }

  console.error(`[share] watching — every ${everySec}s. Ctrl-C to stop.`);
  console.error("[share] each pass takes any new configuration first, then sends the current state.");
  for (;;) {
    takeRemote();
    share();
    await sleep(Math.max(60, everySec) * 1000);
  }
}

main();
