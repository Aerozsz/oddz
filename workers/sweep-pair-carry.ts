/**
 * The one structure left that this account could actually trade.
 *
 * Everything directional is closed: five measurements, and the last three found
 * my own errors rather than edge. What survived is the funding payment, and
 * collecting it unhedged means holding a price term that runs plus or minus 50 to
 * 100bp per eight hours and does not survive a refit on halves. Hedging that with
 * spot would fix it, and this account has no spot.
 *
 * But the venue lists the same underlying with different margin assets —
 * BTCUSDT, BTCUSDC and BTCUSD1 are three perpetuals on one price — and they fund
 * independently. The survey shows the rates differ by a lot relative to their own
 * size: BTC pays 1.91, 1.80 and 2.29bp a day across the three, ZEC pays 1.96 on
 * USDT against 0.84 on USDC, XRP 0.89 against 1.70.
 *
 * Long the one that pays more and short the one that pays less, in equal
 * notional, and the price exposure very nearly cancels — same underlying — while
 * the funding differential does not. Two futures legs, no spot, no directional
 * view. That is the trade this account can place and nobody has measured it.
 *
 * ## What decides whether it is real
 *
 * **The differential, not the rates.** A pair where both legs pay the same side
 * loses most of the carry to the hedge; what is collected is the gap. It is
 * smaller than either leg by construction, so the capital needed is larger, and
 * pretending otherwise would be the same arithmetic error as quoting a decile
 * spread as a per-trade return.
 *
 * **Its sign persistence.** A differential that flips pays nothing to a held
 * spread however wide it looks on average. This is the same one-sidedness test
 * the venue survey needed, applied to the difference rather than the level.
 *
 * **The residual price risk.** "Very nearly cancels" is a claim, and it is
 * measurable: the two contracts track the same index but not identically, and
 * what is left is the basis between them. If that residual moves more per eight
 * hours than the differential pays, the trade is a coin flip with a carry
 * attached, which is what the unhedged version already is.
 *
 * All three come out of files the archive publishes, and none of them needs an
 * account, a socket, or anyone's permission.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { unzipEntries, csvRows, parseTs } from "../lib/sweep/backtest/zip";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};

const outPath = resolve(arg("out", "evidence/pair-carry.json"));
const months = Math.max(1, Number(arg("months", "2")));
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "6")));
const BASE = "https://data.binance.vision/data/futures/um";
const LIST = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";

/** Margin assets that share an underlying, longest suffix first so USD1 wins over USD. */
const QUOTES = ["USDT", "USDC", "USD1"];

function split(symbol: string): { base: string; quote: string } | null {
  for (const q of QUOTES) {
    if (symbol.endsWith(q) && symbol.length > q.length) {
      return { base: symbol.slice(0, -q.length), quote: q };
    }
  }
  return null;
}

async function symbols(): Promise<string[]> {
  const out: string[] = [];
  let token: string | null = null;
  for (let page = 0; page < 20; page++) {
    const url: string =
      `${LIST}?list-type=2&delimiter=/&prefix=data/futures/um/monthly/fundingRate/` +
      (token ? `&continuation-token=${encodeURIComponent(token)}` : "");
    const res = await fetch(url);
    if (!res.ok) break;
    const xml = await res.text();
    for (const m of xml.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)) {
      const parts = m[1].split("/").filter(Boolean);
      const sym = parts[parts.length - 1];
      if (sym && sym !== "fundingRate") out.push(sym);
    }
    const more = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const t = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!more || !t) break;
    token = t[1];
  }
  return [...new Set(out)].sort();
}

/** Signed funding rate in bps, by settlement time. */
async function rates(symbol: string, ym: string[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const m of ym) {
    const res = await fetch(`${BASE}/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${m}.zip`);
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    for (const entry of unzipEntries(buf)) {
      for (const row of csvRows(entry.data)) {
        if (row.length < 3) continue;
        const ts = parseTs(row[0] ?? "");
        const rate = Number(row[2]);
        if (!Number.isFinite(ts) || !Number.isFinite(rate)) continue;
        /*
         * Settlements land within a second or two of the hour, and the two
         * contracts are not stamped identically. Rounding to the hour is what
         * lets them be paired at all; without it the intersection is empty and
         * the pair reads as having no overlapping history.
         */
        out.set(Math.round(ts / 3_600_000) * 3_600_000, rate * 10_000);
      }
    }
  }
  return out;
}

/** Closes by minute, for measuring what the hedge leaves behind. */
async function closes(symbol: string, dates: string[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const d of dates) {
    const res = await fetch(`${BASE}/daily/klines/${symbol}/1m/${symbol}-1m-${d}.zip`);
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    for (const entry of unzipEntries(buf)) {
      for (const row of csvRows(entry.data)) {
        const ts = parseTs(row[0] ?? "");
        const close = Number(row[4]);
        if (!Number.isFinite(ts) || !(close > 0)) continue;
        out.set(Math.floor(ts / 60_000) * 60_000, close);
      }
    }
  }
  return out;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

export interface Pair {
  base: string;
  long: string;
  short: string;
  settlements: number;
  /** Mean differential per settlement, in bps, oriented so positive is collected. */
  meanDiffBps: number;
  /** Share of settlements where the differential kept the same sign. */
  oneSidedShare: number;
  /** Three settlements a day. */
  dailyBps: number;
  notionalForTargetUsd: number | null;
  /**
   * What the hedge leaves behind: the standard deviation of the change in the
   * two contracts' price ratio over one funding interval, in bps.
   *
   * This is the number that decides it. If the residual moves more per interval
   * than the differential pays, the position is a coin flip with a carry attached.
   */
  residualSdBps: number | null;
  /** Differential per interval over that residual: carry per unit of risk taken. */
  carryOverRisk: number | null;
}

/**
 * The spread between two contracts on one underlying.
 *
 * Oriented so the reported differential is positive: whichever leg pays the
 * holder more is the one to be long when funding is negative and short when it is
 * positive. Getting that orientation from the data rather than from the symbol
 * order is what keeps the sign meaningful across pairs.
 */
export function pairUp(
  base: string,
  a: { symbol: string; rates: Map<number, number> },
  b: { symbol: string; rates: Map<number, number> },
  residualSdBps: number | null,
): Pair | null {
  const shared: number[] = [];
  for (const ts of a.rates.keys()) if (b.rates.has(ts)) shared.push(ts);
  if (shared.length < 30) return null;

  /*
   * A short pays the funding rate when it is positive and receives it when
   * negative, so the holder of a short collects `-rate`. The spread is short one
   * contract and long the other; collected per settlement is the difference of
   * the two rates, and which way round depends on which rate is larger.
   */
  const raw = shared.map((ts) => (a.rates.get(ts) as number) - (b.rates.get(ts) as number));
  const m = mean(raw);
  /* Orient so the reported number is what a correctly-sided spread collects. */
  const sign = m >= 0 ? 1 : -1;
  const diff = raw.map((x) => x * sign);
  const md = mean(diff);
  const oneSided = diff.filter((x) => x > 0).length / diff.length;
  const daily = md * 3;

  return {
    base,
    /* Short the leg paying more, long the leg paying less. */
    long: sign > 0 ? b.symbol : a.symbol,
    short: sign > 0 ? a.symbol : b.symbol,
    settlements: diff.length,
    meanDiffBps: md,
    oneSidedShare: oneSided,
    dailyBps: daily,
    notionalForTargetUsd: daily > 0 ? 300 / (daily / 10_000) : null,
    residualSdBps,
    carryOverRisk: residualSdBps !== null && residualSdBps > 0 ? md / residualSdBps : null,
  };
}

/** Standard deviation of the eight-hour change in the two contracts' price ratio. */
export function residual(a: Map<number, number>, b: Map<number, number>): number | null {
  const ratios: { ts: number; r: number }[] = [];
  for (const [ts, pa] of a) {
    const pb = b.get(ts);
    if (pb === undefined || !(pa > 0) || !(pb > 0)) continue;
    ratios.push({ ts, r: Math.log(pa / pb) });
  }
  if (ratios.length < 500) return null;
  ratios.sort((x, y) => x.ts - y.ts);
  const byTs = new Map(ratios.map((x) => [x.ts, x.r]));
  const changes: number[] = [];
  for (const { ts, r } of ratios) {
    const later = byTs.get(ts + 8 * 3_600_000);
    if (later === undefined) continue;
    changes.push((later - r) * 10_000);
  }
  if (changes.length < 100) return null;
  return sd(changes);
}

async function main() {
  const now = new Date();
  const ym: string[] = [];
  for (let i = 1; i <= months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    ym.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  const days: string[] = [];
  for (let i = 2; i < 12; i++) days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));

  const all = await symbols();
  if (!all.includes("BTCUSDT")) {
    console.error("[pair] BTCUSDT absent from the listing — the method is broken, not the venue");
    process.exit(1);
  }

  /* Underlyings listed against more than one margin asset. */
  const groups = new Map<string, string[]>();
  for (const sym of all) {
    const p = split(sym);
    if (!p) continue;
    const list = groups.get(p.base) ?? [];
    list.push(sym);
    groups.set(p.base, list);
  }
  const multi = [...groups.entries()].filter(([, v]) => v.length > 1);
  console.error(`[pair] ${all.length} symbols · ${multi.length} underlyings with more than one margin asset`);

  const out: Pair[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= multi.length) return;
      const [base, syms] = multi[i];
      const loaded = [];
      for (const s of syms) loaded.push({ symbol: s, rates: await rates(s, ym) });
      for (let x = 0; x < loaded.length; x++) {
        for (let y = x + 1; y < loaded.length; y++) {
          /*
           * Prices are only fetched once a pair has enough overlapping
           * settlements to be worth pricing. Ten days of two kline series per
           * pair is the expensive part of this worker, and most pairs do not
           * survive the settlement count.
           */
          const probe = pairUp(base, loaded[x], loaded[y], null);
          if (!probe) continue;
          const [ca, cb] = [await closes(loaded[x].symbol, days), await closes(loaded[y].symbol, days)];
          const res = residual(ca, cb);
          const full = pairUp(base, loaded[x], loaded[y], res);
          if (full) out.push(full);
        }
      }
      if ((i + 1) % 10 === 0) console.error(`[pair] ${i + 1}/${multi.length} · kept ${out.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  out.sort((a, b) => (b.carryOverRisk ?? -1) - (a.carryOverRisk ?? -1));

  const report = {
    at: Date.now(),
    months: ym,
    priceDays: days,
    underlyingsWithPairs: multi.length,
    pairs: out.length,
    rows: out,
    note:
      "Two perpetuals on one underlying with different margin assets. Long the leg that pays the " +
      "holder more, short the other, equal notional: the price exposure very nearly cancels and the " +
      "funding differential does not. No spot, no directional view, two futures legs — which is what " +
      "this account can place. Ranked by the differential per interval divided by the residual, " +
      "because 'very nearly cancels' is a claim and residualSdBps is the measurement of it: if the " +
      "residual moves more per interval than the differential pays, the position is a coin flip with " +
      "a carry attached. The differential is smaller than either leg's rate by construction, so the " +
      "capital needed is larger, and quoting a leg's rate here would be the same error as quoting a " +
      "decile spread as a per-trade return.",
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.error(`[pair] ${out.length} pairs, by carry per unit of residual risk:`);
  for (const r of out.slice(0, 15)) {
    console.error(
      `  ${(r.short + " / " + r.long).padEnd(26)} ${r.dailyBps.toFixed(2).padStart(6)}bp/day  ` +
        `one-sided ${(r.oneSidedShare * 100).toFixed(0).padStart(3)}%  ` +
        `residual ${r.residualSdBps === null ? "  n/a" : r.residualSdBps.toFixed(1).padStart(6) + "bp"}  ` +
        `carry/risk ${r.carryOverRisk === null ? "n/a" : r.carryOverRisk.toFixed(3)}  ` +
        `$300/day needs ${r.notionalForTargetUsd === null ? "n/a" : "$" + Math.round(r.notionalForTargetUsd).toLocaleString()}`,
    );
  }
  console.error(`[pair] -> ${outPath}`);
}

/*
 * Only when run as a program, never on import.
 *
 * `void main()` at module scope means a check that imports `pairUp` to test it
 * also starts a live survey of the venue and overwrites this worker's report
 * with whatever that truncated run produced. It did exactly that on the first
 * run of the check beside this file, and it is the same defect as the hardcoded
 * FINDINGS path fixed a day earlier: a module doing work as a side effect of
 * being read.
 */
if (process.argv[1] && process.argv[1].includes("sweep-pair-carry")) void main();
