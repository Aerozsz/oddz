/**
 * Where the funding payment is largest, across every contract the venue lists.
 *
 * Everything this project has measured says the same thing about LITUSDT:
 * direction is not available, and the only quantity that survived every test is
 * the funding payment itself — arithmetic on a published number rather than a
 * statistic about price. At the widest decile it is 11.99bp per eight hours,
 * about 36bp of notional a day, which on this account is $36 a day at $10,000.
 *
 * That is a fact about one contract, chosen months ago for reasons that had
 * nothing to do with carry. The payment is not a constant of the venue: it is set
 * by how badly one side wants exposure, so it varies enormously between
 * contracts and it is largest exactly where the perpetual is hardest to arbitrage
 * — which is also where the impact measurements say it is most expensive to
 * trade. Both of those are measurable from the archive, and neither needs an
 * account, a socket or anyone's permission.
 *
 * So this surveys the whole listing rather than arguing from one instrument.
 *
 * ## What it measures, and why those two things together
 *
 * The payment, from `fundingRate`: the mean absolute rate per settlement, and
 * how one-sided it is. A contract whose funding alternates sign pays nothing to
 * a held position however large each payment looks; one that pays the same side
 * for weeks is a carry.
 *
 * The size that can take it, from `bookDepth`: notional resting within 1% of
 * mid. A 60bp-a-day payment on a book that absorbs $2,000 is not a business, and
 * ranking on the rate alone would put exactly those contracts at the top — the
 * payment is large *because* nobody can arbitrage it.
 *
 * The ranking is therefore the daily payment multiplied by what the book can
 * absorb: dollars a day rather than basis points, because dollars is the unit
 * the target is written in.
 *
 * ## What it deliberately does not claim
 *
 * Collecting funding means holding a position, and this project has measured the
 * price term that comes with one: on LITUSDT it runs plus or minus 50 to 100bp
 * per eight hours and does not survive a refit on halves. So nothing here is a
 * strategy. It is the answer to a single question the operator has to decide on —
 * if a hedged basis trade were possible, where would it be worth doing — and the
 * answer is a ranked list with numbers rather than a recommendation.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { unzipEntries, csvRows, parseTs } from "../lib/sweep/backtest/zip";
import { SYMBOL } from "../lib/sweep/config";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};

const outPath = resolve(arg("out", "evidence/funding-survey.json"));
const months = Math.max(1, Number(arg("months", "2")));
/*
 * Every symbol by default.
 *
 * The first run surveyed 400 of 952 and the list is sorted, so it covered
 * roughly A through I — and the ranking that came out was almost entirely
 * B-to-G symbols, which is what an alphabetical truncation looks like when it is
 * mistaken for a result. LITUSDT, the contract this whole project trades, was
 * not even in the surveyed set.
 *
 * A limit is still accepted for a quick pass, but it now samples across the
 * alphabet rather than taking a prefix, so a partial survey is partial in a way
 * that does not correlate with the answer.
 */
const limit = Math.max(1, Number(arg("limit", "0")) || Number.MAX_SAFE_INTEGER);
/** Requests in flight. The archive is fine with this and it turns 15 minutes into 2. */
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "8")));
/*
 * Symbols always reported, whatever they rank.
 *
 * The report keeps the top sixty rows, and I read the configured contract's
 * absence from that slice as evidence it had been dropped from the survey
 * entirely — it had not, it simply did not rank. A survey of the venue that
 * cannot answer "and what about the one we trade" makes that mistake easy, so
 * the contract in the config and the control are pinned into the output
 * regardless of where they land.
 */
const ALWAYS = [...new Set([SYMBOL.toUpperCase(), "BTCUSDT"])];
const BASE = "https://data.binance.vision/data/futures/um";
const LIST = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";

/**
 * Every symbol with a published funding series.
 *
 * A delimiter listing returns prefixes rather than keys, so this is one request
 * per page of symbols rather than per file. It is also the method that has given
 * two wrong answers before in this repository — a 1000-key cap, and a per-symbol
 * prefix query that reported BTCUSDT absent — so the result is checked against a
 * control and against a plausible count before anything is built on it.
 */
async function symbols(): Promise<string[]> {
  const out: string[] = [];
  let token: string | null = null;
  for (let page = 0; page < 20; page++) {
    /*
     * Annotated because `token` is assigned at the bottom of the loop from a
     * value derived from this request, and TypeScript follows that cycle back
     * into the initializer rather than settling on `string`.
     */
    const url: string =
      `${LIST}?list-type=2&delimiter=/&prefix=data/futures/um/monthly/fundingRate/` +
      (token ? `&continuation-token=${encodeURIComponent(token)}` : "");
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[survey] listing HTTP ${res.status}`);
      break;
    }
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

interface Funding {
  symbol: string;
  settlements: number;
  /** Mean absolute rate per settlement, in bps. */
  meanAbsBps: number;
  /** Mean signed rate, in bps — what a held position on the paid side collects. */
  meanSignedBps: number;
  /** Share of settlements paying the same side as the mean. */
  oneSidedShare: number;
  /** meanSignedBps at three settlements a day, in bps of notional. */
  dailyBps: number;
  /** Notional needed to make $300 a day at this rate. */
  notionalForTargetUsd: number | null;
}

async function fundingFor(symbol: string, dates: string[]): Promise<Funding | null> {
  const rates: number[] = [];
  for (const ym of dates) {
    const url = `${BASE}/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${ym}.zip`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    for (const entry of unzipEntries(buf)) {
      for (const row of csvRows(entry.data)) {
        // calc_time,funding_interval_hours,last_funding_rate
        if (row.length < 3) continue;
        const ts = parseTs(row[0] ?? "");
        const rate = Number(row[2]);
        if (!Number.isFinite(ts) || !Number.isFinite(rate)) continue;
        rates.push(rate * 10_000);
      }
    }
  }
  /*
   * Two months is about 180 settlements. Under thirty is a contract that listed
   * mid-window, and its mean is about a fortnight of one regime.
   */
  if (rates.length < 30) return null;

  const n = rates.length;
  const meanSigned = rates.reduce((a, b) => a + b, 0) / n;
  const meanAbs = rates.reduce((a, b) => a + Math.abs(b), 0) / n;
  /*
   * One-sidedness is what separates a carry from a coin flip. A contract paying
   * +30bp and -30bp alternately has a large mean absolute rate and pays a held
   * position nothing.
   */
  const sign = Math.sign(meanSigned) || 1;
  const oneSided = rates.filter((r) => Math.sign(r) === sign).length / n;

  return {
    symbol,
    settlements: n,
    meanAbsBps: meanAbs,
    meanSignedBps: meanSigned,
    oneSidedShare: oneSided,
    dailyBps: Math.abs(meanSigned) * 3,
    /*
     * The notional a position must hold to make $300 a day at this rate.
     *
     * This is the number the operator's decision actually turns on, and the
     * dollars-on-full-depth ranking does not answer it: nobody trades the entire
     * resting book. A rate of 1.9bp a day is a fine carry and still needs a
     * million and a half dollars behind it.
     */
    notionalForTargetUsd: Math.abs(meanSigned) * 3 > 0 ? 300 / ((Math.abs(meanSigned) * 3) / 10_000) : null,
  };
}

/** Notional resting within 1% of mid, median over the day, both sides summed. */
async function depthFor(symbol: string, date: string): Promise<number | null> {
  const url = `${BASE}/daily/bookDepth/${symbol}/${symbol}-bookDepth-${date}.zip`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const byMinute = new Map<number, number>();
  for (const entry of unzipEntries(buf)) {
    for (const r of csvRows(entry.data)) {
      if (r.length < 4) continue;
      const ts = parseTs(r[0] ?? "");
      const pct = Number(r[1]);
      const notional = Number(r[3]);
      if (!Number.isFinite(ts) || Math.abs(pct) !== 1 || !Number.isFinite(notional)) continue;
      const slot = Math.floor(ts / 60_000);
      byMinute.set(slot, (byMinute.get(slot) ?? 0) + notional);
    }
  }
  const vals = [...byMinute.values()].sort((a, b) => a - b);
  if (vals.length < 100) return null;
  return vals[Math.floor(vals.length / 2)];
}

async function main() {
  const now = new Date();
  const ym: string[] = [];
  for (let i = 1; i <= months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    ym.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  const depthDate = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  console.error(`[survey] funding months ${ym.join(", ")} · depth ${depthDate}`);

  const all = await symbols();
  console.error(`[survey] ${all.length} symbols listed`);
  /*
   * The control that caught a broken listing method twice before. If the venue's
   * largest contract is missing, the listing is wrong and every ranking built on
   * it is worthless — better to stop than to publish a survey of whatever
   * happened to come back.
   */
  if (!all.includes("BTCUSDT")) {
    console.error("[survey] BTCUSDT absent from the listing — the method is broken, not the venue");
    process.exit(1);
  }
  if (all.length < 50) {
    console.error(`[survey] only ${all.length} symbols — implausibly few, refusing to rank`);
    process.exit(1);
  }

  /*
   * Sampled across the alphabet when limited, never a prefix. A stride keeps the
   * subset spread over the whole listing, so a partial survey is partial in a way
   * that does not correlate with the symbol name.
   */
  const picked =
    limit >= all.length ? all : all.filter((_, i) => i % Math.ceil(all.length / limit) === 0);
  const rows: (Funding & { depthUsd: number | null; dailyUsd: number | null })[] = [];

  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= picked.length) return;
      const sym = picked[i];
      const f = await fundingFor(sym, ym);
      done++;
      if (done % 100 === 0) console.error(`[survey] ${done}/${picked.length} · kept ${rows.length}`);
      if (!f) continue;
      const depthUsd = await depthFor(sym, depthDate);
      rows.push({
        ...f,
        depthUsd,
        /*
         * What a day pays on the size the book can absorb — a ranking quantity,
         * because a large rate on a book nobody can trade is not an opportunity.
         * Null when depth is unknown rather than assumed, since assuming it is
         * the error that would put untradeable contracts on top.
         */
        dailyUsd: depthUsd === null ? null : (f.dailyBps / 10_000) * depthUsd,
      });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  rows.sort((a, b) => (b.dailyUsd ?? -1) - (a.dailyUsd ?? -1));

  const report = {
    at: Date.now(),
    months: ym,
    depthDate,
    listed: all.length,
    surveyed: picked.length,
    kept: rows.length,
    rows: rows.slice(0, 60),
    /** The configured contract and the control, wherever they ranked. */
    pinned: ALWAYS.map((sym) => {
      const hit = rows.find((r) => r.symbol === sym);
      const rank = rows.findIndex((r) => r.symbol === sym);
      return hit
        ? { ...hit, rank: rank + 1, of: rows.length }
        : { symbol: sym, absent: true, reason: "no funding series with at least 30 settlements in the window" };
    }),
    note:
      "Ranked by what one day of funding pays on the notional resting within 1% of mid, which is " +
      "dollars rather than basis points because the target is. oneSidedShare is the quantity that " +
      "separates a carry from a coin flip: a contract paying +30bp and -30bp alternately has a " +
      "large mean absolute rate and pays a held position nothing. NOT a strategy — collecting " +
      "funding means holding a position, and the price term that comes with one runs plus or minus " +
      "50 to 100bp per eight hours on LITUSDT and does not survive a refit on halves. This answers " +
      "only where a hedged basis trade would be worth doing if one were possible.",
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.error(`[survey] top by daily payment on absorbable size:`);
  for (const r of rows.slice(0, 15)) {
    console.error(
      `  ${r.symbol.padEnd(14)} ${r.dailyBps.toFixed(1).padStart(6)}bp/day  ` +
        `one-sided ${(r.oneSidedShare * 100).toFixed(0).padStart(3)}%  ` +
        `depth ${r.depthUsd === null ? "unknown" : "$" + Math.round(r.depthUsd).toLocaleString()}  ` +
        `$300/day needs ${r.notionalForTargetUsd === null ? "n/a" : "$" + Math.round(r.notionalForTargetUsd).toLocaleString()}`,
    );
  }
  for (const sym of ALWAYS) {
    const hit = rows.find((r) => r.symbol === sym);
    const rank = rows.findIndex((r) => r.symbol === sym) + 1;
    console.error(
      hit
        ? `[survey] ${sym}: ${hit.dailyBps.toFixed(1)}bp/day, one-sided ` +
          `${(hit.oneSidedShare * 100).toFixed(0)}%, rank ${rank} of ${rows.length}, ` +
          `$300/day needs ${hit.notionalForTargetUsd === null ? "n/a" : "$" + Math.round(hit.notionalForTargetUsd).toLocaleString()}`
        : `[survey] ${sym}: no funding series with 30+ settlements in the window`,
    );
  }
  console.error(`[survey] -> ${outPath}`);
}

void main();
