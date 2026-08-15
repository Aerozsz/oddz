import { beat, readHeartbeat, STALE_MS } from "../workers/heartbeat";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const ROOT = "/tmp/sweep-checks/hbtest";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const DIR = `${ROOT}/status`;
process.env.SWEEP_STATUS_DIR = DIR;

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("\n## heartbeat (audit findings 1, 2, 6)");

  ok("absent means never started", !readHeartbeat("w1").running && !readHeartbeat("w1").stale);

  const stop = beat("w1", () => ({ rows: 5 }), 50);
  await sleep(20);
  let hb = readHeartbeat("w1");
  ok("a beating worker reads as running", hb.running && !hb.stale);
  ok("...and carries its stats", hb.stats.rows === 5);

  // FINDING 1: the stop write re-stamped `at`, so a Ctrl-C'd worker read as
  // alive for the next 90s — the confusion this file exists to remove.
  stop();
  hb = readHeartbeat("w1");
  ok("a cleanly stopped worker reads as stopped at once", !hb.running, `running=${hb.running}`);
  ok("...as stale rather than never-started", hb.stale);

  // FINDING 6: a plain write is not atomic, so a reader on its own cycle
  // eventually lands mid-write and sees the empty record — a live worker
  // reading as never-started.
  const stop2 = beat("w2", () => ({ n: Date.now(), pad: "x".repeat(4000) }), 2);
  let torn = 0;
  for (let i = 0; i < 400; i++) {
    const r = readHeartbeat("w2");
    if (!r.running && !r.stale) torn++;
    if (i % 25 === 0) await sleep(1);
  }
  stop2();
  ok("no torn reads across 400 reads against a 2ms beat", torn === 0, `${torn} torn`);

  // FINDING 2: mkdirSync sat outside the guard and stats() was evaluated
  // outside it, so the monitor could kill the worker it monitors.
  writeFileSync(`${ROOT}/notadir`, "");
  process.env.SWEEP_STATUS_DIR = `${ROOT}/notadir/sub`;
  let threw: string | null = null;
  try {
    beat("w3", () => ({ ok: true }), 50)();
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  ok("an unwritable status dir is survived", threw === null, threw ?? "");

  process.env.SWEEP_STATUS_DIR = DIR;
  threw = null;
  try {
    beat("w4", () => { throw new Error("stats blew up"); }, 50)();
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  ok("a stats() that throws is survived", threw === null, threw ?? "");

  // A stale beat with no stopped flag reads as gone.
  writeFileSync(`${DIR}/w5.status.json`, JSON.stringify({
    name: "w5", pid: 1, startedAt: 0, at: Date.now() - STALE_MS - 1000, stats: {},
  }));
  hb = readHeartbeat("w5");
  ok("an old beat reads as stale, not running", !hb.running && hb.stale);

  writeFileSync(`${DIR}/w6.status.json`, "{not json");
  ok("a corrupt status file falls back to absent", !readHeartbeat("w6").running);

  rmSync(ROOT, { recursive: true, force: true });
  console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
  process.exit(fails ? 1 : 0);
}
void main();
