/**
 * The supervisor must not become the outage.
 *
 * Two regressions this covers, both of which only appear on a run long enough
 * that nobody is watching it:
 *
 *  1. killTree must actually stop the child, and must not throw on a child that
 *     has already gone — a shutdown path that throws leaves the tree alive.
 *  2. loadEnv must report a value as present when the supervisor put it there,
 *     or the self-check reports `bad` on a healthy machine and the next
 *     unattended session spends its pass on a fault that does not exist.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killTree } from "../lib/sweep/agent/process-tree";
import { loadEnv } from "../workers/load-env";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`  ok — ${name}`);
  }
};

async function killsTheChild() {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 200));
  ok("a live child is running", child.exitCode === null);

  const gone = new Promise<void>((r) => child.on("exit", () => r()));
  killTree(child);
  const finished = await Promise.race([
    gone.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 5000)),
  ]);
  ok("killTree stops the child", finished === true, "it was still running 5s later");

  // Second call, on a corpse: a shutdown path must never throw.
  let threw = false;
  try {
    killTree(child);
    killTree(null);
    killTree(undefined);
  } catch {
    threw = true;
  }
  ok("killTree is safe on an already-dead or absent child", !threw);
}

function countsInheritedValues() {
  const dir = mkdtempSync(join(tmpdir(), "loadenv-"));
  const path = join(dir, ".env");
  writeFileSync(path, "SWEEP_TEST_A=one\nSWEEP_TEST_B=two\n# comment\n\n");

  delete process.env.SWEEP_TEST_A;
  delete process.env.SWEEP_TEST_B;

  const fresh = loadEnv(path);
  ok("a fresh load applies both", fresh.applied === 2 && fresh.count === 2, JSON.stringify(fresh));

  /*
   * The supervisor case: the values are already in the environment, so nothing
   * is applied — but they are unambiguously loaded, and the check reads `count`.
   */
  const inherited = loadEnv(path);
  ok(
    "an inherited environment still counts as loaded",
    inherited.count === 2 && inherited.applied === 0,
    JSON.stringify(inherited),
  );

  // An empty value is not a loaded value, whoever left it that way.
  process.env.SWEEP_TEST_B = "";
  const partial = loadEnv(path);
  ok("an empty inherited value does not count", partial.count === 1, JSON.stringify(partial));

  delete process.env.SWEEP_TEST_A;
  delete process.env.SWEEP_TEST_B;
}

async function main() {
  console.log("process tree + env inheritance");
  await killsTheChild();
  countsInheritedValues();
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nall good");
}

main();
