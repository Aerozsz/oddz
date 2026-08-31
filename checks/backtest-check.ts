/**
 * The replay has to recover an edge that is known to be there.
 *
 * This runs on the operator's machine and not on mine — the network policy here
 * blocks the archive — so there is no chance to debug it interactively when it
 * fails. It therefore gets tested against a synthetic archive built to the real
 * file format, carrying a planted signal: when the ask side is thin, price rises
 * over the next fifteen minutes. If the harness cannot find that, it cannot be
 * trusted to report the absence of a real one either, which is the outcome it
 * exists to produce.
 *
 * Also pins the zip reader, because every byte of evidence arrives through it.
 */

import { deflateRawSync } from "node:zlib";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { unzipEntries, csvRows, parseTs } from "../lib/sweep/backtest/zip";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`  ok — ${name}`);
  }
};

/* ------------------------------------------------------------- a real zip */

/** Build a spec-shaped single-entry zip, so the reader is tested, not mocked. */
function makeZip(name: string, content: string): Buffer {
  const nameBuf = Buffer.from(name, "latin1");
  const raw = Buffer.from(content, "utf8");
  const deflated = deflateRawSync(raw);
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const localOffset = 0;
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(8, 10);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(deflated.length, 20);
  cen.writeUInt32LE(raw.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt32LE(localOffset, 42);

  const cenStart = local.length + nameBuf.length + deflated.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cen.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cenStart, 16);

  return Buffer.concat([local, nameBuf, deflated, cen, nameBuf, eocd]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function zipReader() {
  const z = makeZip("BTCUSDT-bookDepth-2024-01-01.csv", "timestamp,percentage,depth,notional\n1704067200000,-1,5,1000\n");
  const entries = unzipEntries(z);
  ok("a zip round-trips", entries.length === 1 && /bookDepth/.test(entries[0].name));
  const rows = csvRows(entries[0].data);
  ok("the header is detected and dropped", rows.length === 1, JSON.stringify(rows));
  ok("and the row survives intact", rows[0][3] === "1000", JSON.stringify(rows[0]));

  ok("millisecond timestamps pass through", parseTs("1704067200000") === 1704067200000);
  ok("microsecond timestamps are scaled", parseTs("1704067200000000") === 1704067200000);
  ok("text timestamps parse as UTC", parseTs("2024-01-01 00:00:00") === 1704067200000);
}

/* --------------------------------------------------- a planted edge, end to end */

function plantedEdge() {
  const dir = mkdtempSync(join(tmpdir(), "bt-"));
  mkdirSync(join(dir, "bookDepth"), { recursive: true });
  mkdirSync(join(dir, "1m"), { recursive: true });

  const start = Date.UTC(2024, 0, 1);
  const MIN = 60_000;
  const N = 3000;

  /*
   * A graded plant, not a binary one.
   *
   * The first version starved the ask to a fixed third every twentieth minute,
   * which put every signal into a single band — so "strongest" and "weakest"
   * resolved to the same bucket and the comparison was a number against itself.
   * The real read is a monotonicity: does a thinner book precede a larger move?
   * That needs the plant to be graded, so the levels below run from a mild
   * starvation to a severe one and the subsequent move scales with it.
   */
  const depth: string[] = ["timestamp,percentage,depth,notional"];
  const bars: string[] = [];
  const price: number[] = [];
  let p = 60_000;
  const BASE = 9_000_000;
  /** Ask notional as a fraction of baseline, and the move it precedes in bp. */
  const LEVELS: [number, number][] = [[0.95, 2], [0.85, 8], [0.7, 20], [0.45, 45], [0.25, 80]];
  const thinAt = new Map<number, [number, number]>();
  for (let i = 0; i < N; i++) {
    if (i % 20 === 0 && i > 100 && i < N - 100) thinAt.set(i, LEVELS[(i / 20) % LEVELS.length]);
  }

  for (let i = 0; i < N; i++) {
    // The move begins at the thin minute and completes over the next fifteen.
    let drift = 0;
    for (let k = 1; k <= 15; k++) {
      const planted = thinAt.get(i - k);
      if (planted) drift += (60_000 * (planted[1] / 10_000)) / 15;
    }
    p += drift;
    price.push(p);
  }

  /*
   * The book stays thin while price travels through it.
   *
   * The first version starved the ask for a single minute. That is not how a
   * book behaves and it inverted the test: the EWMA baseline is dragged down by
   * the event itself, so the fifteen minutes *after* it read as thicker than
   * normal while price was still rising — and there are fifteen of those for
   * every one thin minute, so the aggregate correlation came out backwards.
   *
   * Worth keeping in view beyond this file, because the same contamination is
   * live: the baseline the agent compares against absorbs the very withdrawal
   * it is trying to detect, and that is a candidate explanation for the
   * significantly negative band the real backtest found at 0.25-0.50.
   */
  const thinDuring = new Map<number, number>();
  for (const [i, [level]] of thinAt) for (let k = 0; k < 15; k++) thinDuring.set(i + k, level);

  for (let i = 0; i < N; i++) {
    const ts = start + i * MIN;
    const planted = thinDuring.get(i);
    const askNotional = Math.round(BASE * (planted ?? 1));
    depth.push(`${ts},-1,100,${BASE}`);
    depth.push(`${ts},1,100,${askNotional}`);
    const c = price[i];
    bars.push(`${ts},${c},${c * 1.0005},${c * 0.9995},${c},10,${ts + MIN - 1},0,0,0,0,0`);
  }

  writeFileSync(join(dir, "bookDepth", "BTCUSDT-bookDepth-2024-01-01.zip"),
    makeZip("BTCUSDT-bookDepth-2024-01-01.csv", depth.join("\n")));
  writeFileSync(join(dir, "1m", "BTCUSDT-1m-2024-01-01.zip"),
    makeZip("BTCUSDT-1m-2024-01-01.csv", bars.join("\n")));

  const out = join(dir, "report.json");
  try {
    // --symbol is named rather than left to the worker's default. These fixtures
    // are BTCUSDT and that default is now the project's configured symbol, which
    // moves — a test leaning on it is testing the configuration, and it broke the
    // moment the configured symbol changed.
    execFileSync("npx", ["tsx", "workers/sweep-backtest.ts", "--symbol", "BTCUSDT", "--in", dir, "--out", out], {
      cwd: "/home/user/oddz", stdio: "pipe", timeout: 180_000,
    });
  } catch (err) {
    const e = err as { stderr?: Buffer; stdout?: Buffer };
    console.error(String(e.stderr ?? e.stdout ?? err).slice(-1500));
  }

  ok("the replay produced a report", existsSync(out));
  if (!existsSync(out)) return;
  const r = JSON.parse(readFileSync(out, "utf8"));

  ok("it scored the samples", r.samples > 500, String(r.samples));
  ok("it priced the multiplicity", r.multiplicity?.bonferroniSigma > 2, JSON.stringify(r.multiplicity));

  /*
   * The plant is a thinning ask followed by a rise, graded so that a thinner
   * book precedes a larger move. Three features describe that directly, and at
   * least one has to surface at the top of the ranking — if none does, the
   * search cannot find a signal that was put there on purpose and its silence
   * on real data would mean nothing.
   */
  const wanted = ["thinAskUp", "askWithdrawn", "sweepSignal"];
  const found = r.ranked.filter((x: { feature: string; survives: boolean }) =>
    wanted.includes(x.feature) && x.survives);
  ok("a planted feature clears the Bonferroni bar", found.length > 0,
    `top of ranking: ${r.ranked.slice(0, 3).map((x: { feature: string; sigma: number }) =>
      `${x.feature} ${x.sigma.toFixed(1)}σ`).join(", ")}`);
  ok("and it is oriented the right way",
    found.length > 0 && found[0].spreadBps > 0,
    found.length ? `${found[0].feature} ${found[0].spreadBps.toFixed(2)}bp` : "");

  /*
   * The excursion statistic is the reason this rewrite exists: a close-to-close
   * mean cannot see a run that retraces, and a bracket order lives on exactly
   * those. The top decile of a planted feature must show a larger favourable
   * excursion than the bottom one.
   */
  const key = `${found[0]?.feature}@${found[0]?.horizon}`;
  const deciles = r.deciles?.[key];
  ok("the deciles of a surviving feature are kept", Array.isArray(deciles) && deciles.length === 10,
    deciles ? String(deciles.length) : "missing");
  if (Array.isArray(deciles) && deciles.length === 10) {
    ok("the top decile has the larger favourable excursion",
      deciles[9].meanMfe > deciles[0].meanMfe,
      `${deciles[9].meanMfe.toFixed(2)} vs ${deciles[0].meanMfe.toFixed(2)}`);
    ok("and the tail probabilities are populated",
      deciles.every((d: { tail25: number }) => d.tail25 >= 0 && d.tail25 <= 1));
  }

  ok("the round-trip cost travels with the numbers", r.roundTripBps > 0, String(r.roundTripBps));
}

console.log("backtest harness");
zipReader();
plantedEdge();

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall good");

/* ------------------------------------------------- two symbols, one folder */

/**
 * A second instrument's files must not become a signal.
 *
 * They did. INTC klines at about $43 landed in the same directory as BTC at
 * about $65,000, the replay read every zip in the folder, and a third of all
 * samples came back with a -99.93% one-minute return — ranked as a
 * 271,000-sigma discovery with a 9,993bp decile spread. The arithmetic was
 * correct throughout; it described two price scales in one array, at enormous
 * confidence. That is how this class of error survives being looked at.
 */
function refusesMixedSymbols() {
  const dir = mkdtempSync(join(tmpdir(), "mix-"));
  mkdirSync(join(dir, "bookDepth"), { recursive: true });
  mkdirSync(join(dir, "1m"), { recursive: true });

  const start = Date.UTC(2024, 0, 1);
  const depth = ["timestamp,percentage,depth,notional"];
  const bars: string[] = [];
  for (let i = 0; i < 2500; i++) {
    const ts = start + i * 60_000;
    depth.push(`${ts},-1,100,9000000`);
    depth.push(`${ts},1,100,9000000`);
    // The second half is a different instrument's price scale entirely.
    const c = i < 1250 ? 65_000 : 43;
    bars.push(`${ts},${c},${c * 1.0005},${c * 0.9995},${c},10,${ts + 59_999},0,0,0,0,0`);
  }
  writeFileSync(join(dir, "bookDepth", "BTCUSDT-bookDepth-2024-01-01.zip"),
    makeZip("BTCUSDT-bookDepth-2024-01-01.csv", depth.join("\n")));
  writeFileSync(join(dir, "1m", "BTCUSDT-1m-2024-01-01.zip"),
    makeZip("BTCUSDT-1m-2024-01-01.csv", bars.join("\n")));

  const out = join(dir, "report.json");
  let stderr = "";
  let exited = false;
  try {
    execFileSync("npx", ["tsx", "workers/sweep-backtest.ts", "--symbol", "BTCUSDT", "--in", dir, "--out", out],
      { cwd: "/home/user/oddz", stdio: "pipe", timeout: 180_000 });
  } catch (err) {
    exited = true;
    const e = err as { stderr?: Buffer; stdout?: Buffer };
    stderr = String(e.stderr ?? "") + String(e.stdout ?? "");
  }
  ok("a mixed-scale series is refused rather than scored", exited && !existsSync(out),
    exited ? "" : "it produced a report from two instruments");
  ok("and the message names the cause", /more than one instrument/.test(stderr), stderr.slice(-200));
}

refusesMixedSymbols();
if (failures) {
  console.error(`\n${failures} failure(s) in the mixed-symbol guard`);
  process.exit(1);
}

/* ------------------------------------------- an empty directory is not data */

/**
 * `existsSync` on the symbol directory was the wrong question.
 *
 * Files moved to data/history/<symbol>/<kind>/ after two instruments were found
 * mixed in one folder. The fetcher creates those directories before it
 * downloads anything, so a partial or failed fetch leaves an empty tree that
 * exists — and the replay chose it over the populated old layout, refusing on
 * every symbol on every pass for days while the research loop logged "the
 * replay refused" and carried on.
 */
function prefersTheLayoutThatHasData() {
  const dir = mkdtempSync(join(tmpdir(), "layout-"));

  // The old flat layout, populated.
  mkdirSync(join(dir, "bookDepth"), { recursive: true });
  mkdirSync(join(dir, "1m"), { recursive: true });
  // And an empty nested layout beside it, exactly as a failed fetch leaves it.
  mkdirSync(join(dir, "BTCUSDT", "bookDepth"), { recursive: true });
  mkdirSync(join(dir, "BTCUSDT", "1m"), { recursive: true });

  const start = Date.UTC(2024, 0, 1);
  const depth = ["timestamp,percentage,depth,notional"];
  const bars: string[] = [];
  for (let i = 0; i < 2000; i++) {
    const ts = start + i * 60_000;
    depth.push(`${ts},-1,100,9000000`);
    depth.push(`${ts},1,100,${9_000_000 * (i % 20 === 0 ? 0.5 : 1)}`);
    const c = 65_000 + i;
    bars.push(`${ts},${c},${c * 1.0005},${c * 0.9995},${c},10,${ts + 59_999},0,0,0,0,0`);
  }
  writeFileSync(join(dir, "bookDepth", "BTCUSDT-bookDepth-2024-01-01.zip"),
    makeZip("BTCUSDT-bookDepth-2024-01-01.csv", depth.join("\n")));
  writeFileSync(join(dir, "1m", "BTCUSDT-1m-2024-01-01.zip"),
    makeZip("BTCUSDT-1m-2024-01-01.csv", bars.join("\n")));

  const out = join(dir, "report.json");
  let stderr = "";
  try {
    execFileSync("npx", ["tsx", "workers/sweep-backtest.ts", "--symbol", "BTCUSDT", "--in", dir, "--out", out],
      { cwd: "/home/user/oddz", stdio: "pipe", timeout: 180_000 });
  } catch (err) {
    const e = err as { stderr?: Buffer; stdout?: Buffer };
    stderr = String(e.stderr ?? "") + String(e.stdout ?? "");
  }
  ok("an empty symbol directory does not hide the populated one", existsSync(out),
    stderr.slice(-300));
  if (existsSync(out)) {
    const r = JSON.parse(readFileSync(out, "utf8"));
    ok("and the data is actually read", r.samples > 500, String(r.samples));
  }
}

prefersTheLayoutThatHasData();
if (failures) {
  console.error(`\n${failures} failure(s) in the layout selection`);
  process.exit(1);
}
