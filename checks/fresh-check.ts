/**
 * Starting the figures again keeps the evidence and the settings.
 *
 * The trade log measured bugs rather than the strategy, so it must stop feeding
 * the post-mortem and the auto-tuner. It must not be deleted — the record of
 * what was wrong is worth keeping — and it must not take the shadow log, the
 * evidence log, the tuning audit or the risk settings with it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const DIR = "/tmp/sweep-checks/freshtest";
let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

rmSync(DIR, { recursive: true, force: true });
mkdirSync(`${DIR}/data`, { recursive: true });
const f = (n: string) => `${DIR}/data/${n}`;
writeFileSync(f("sweep-trades.jsonl"), Array.from({ length: 59 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n");
writeFileSync(f("sweep-positions.json"), JSON.stringify({ BTCUSDT: { openedAt: 1 } }));
writeFileSync(f("sweep-shadow.jsonl"), Array.from({ length: 120 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n");
writeFileSync(f("sweep-paper.jsonl"), "{}\n{}\n");
writeFileSync(f("sweep-tuning.jsonl"), Array.from({ length: 9 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n");
writeFileSync(f("sweep-limits.json"), JSON.stringify({ maxPositionUsd: 32845, maxTradesPerDay: 0, lossCooldownMin: 0 }));
writeFileSync(f("sweep-symbols.json"), JSON.stringify({ symbols: ["BTCUSDT"] }));

const env = { ...process.env,
  SWEEP_TRADE_LOG: f("sweep-trades.jsonl"), SWEEP_JOURNAL: f("sweep-positions.json"),
  SWEEP_SHADOW_OUT: f("sweep-shadow.jsonl"), SWEEP_PAPER_OUT: f("sweep-paper.jsonl"),
  SWEEP_TUNE_LOG: f("sweep-tuning.jsonl"), SWEEP_LIMITS: f("sweep-limits.json"),
  SWEEP_SYMBOLS_FILE: f("sweep-symbols.json"), SWEEP_LEDGER: f("ledger.json") };
const run = (...a: string[]) =>
  execFileSync("npx", ["tsx", "workers/sweep-fresh.ts", ...a],
    { cwd: "/home/user/oddz", env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

console.log("\n## without --yes it changes nothing");
run();
ok("the trade log is still there", existsSync(f("sweep-trades.jsonl")));
ok("no ledger was written", !existsSync(f("ledger.json")));

console.log("\n## with --yes");
run("--yes");
ok("the trade log is gone from where anything reads it", !existsSync(f("sweep-trades.jsonl")));
const archived = existsSync(`${DIR}/data/archive`) ? readdirSync(`${DIR}/data/archive`) : [];
ok("...but archived, not deleted", archived.some((x) => x.startsWith("sweep-trades-")), archived.join(","));
ok("all 59 rows survived the move",
  archived.length > 0 &&
  readFileSync(`${DIR}/data/archive/${archived.find((x) => x.startsWith("sweep-trades-"))}`, "utf8")
    .split("\n").filter((l) => l.trim()).length === 59);
ok("the position journal is archived too", archived.some((x) => x.startsWith("sweep-positions-")), archived.join(","));

console.log("\n## everything worth keeping is untouched");
ok("shadow log intact", readFileSync(f("sweep-shadow.jsonl"), "utf8").split("\n").filter((l) => l.trim()).length === 120);
ok("evidence log intact", existsSync(f("sweep-paper.jsonl")));
ok("tuning audit intact", readFileSync(f("sweep-tuning.jsonl"), "utf8").split("\n").filter((l) => l.trim()).length === 9);
ok("contracts intact", existsSync(f("sweep-symbols.json")));

console.log("\n## risk settings are never touched");
const lim = JSON.parse(readFileSync(f("sweep-limits.json"), "utf8"));
ok("max position kept", lim.maxPositionUsd === 32845, String(lim.maxPositionUsd));
ok("the caps you switched off stay off", lim.maxTradesPerDay === 0 && lim.lossCooldownMin === 0,
  `${lim.maxTradesPerDay} / ${lim.lossCooldownMin}`);

console.log("\n## today's counters restart");
const led = JSON.parse(readFileSync(f("ledger.json"), "utf8"));
ok("the ledger epoch moved to now", Date.now() - led.epoch < 60_000, new Date(led.epoch).toISOString());
ok("...and says what moved it", /sweep:fresh/.test(led.reason), led.reason);

console.log("\n## running it twice is safe");
run("--yes");
ok("no crash on an already-clean tree", true);
ok("the archive still holds the original", readdirSync(`${DIR}/data/archive`).length >= 2,
  readdirSync(`${DIR}/data/archive`).join(","));

rmSync(DIR, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
