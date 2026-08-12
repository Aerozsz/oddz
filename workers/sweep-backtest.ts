/**
 * Search a year of real book and tape for anything that predicts, and rank it.
 *
 *   npm run sweep:history -- --days 365
 *   npm run sweep:backtest
 *
 * ## What changed, and why
 *
 * The first version tested one hypothesis with one statistic, and both were
 * wrong in the same direction.
 *
 * It tested only the incumbent signal — thin book, price travels that way —
 * because that is what the agent already trades. On 780,000 minutes the answer
 * came back mixed in a way that condemned the formula rather than the idea:
 * a genuinely thin travel side predicted at 3.5-4.4 sigma across every horizon,
 * while the traded band at 0.25-0.50 predicted *negatively* at 3 sigma. The
 * signal multiplies thinness by asymmetry, and those two point opposite ways.
 * That is only visible if the components are scored separately, so now they are,
 * alongside every other candidate the same files can produce.
 *
 * It also measured close-to-close means, which is a drift statistic. This is an
 * event strategy: the claim is that a condition raises the odds of a large fast
 * move, not that the average minute afterwards drifts. A run of +80bp that
 * retraces reads as zero in a close-to-close mean while a resting target would
 * have filled. So the primary measurements here are excursions — the best and
 * worst reached inside the window — and the probability of clearing 25, 50 and
 * 100bp, which is the shape a bracket order actually harvests.
 *
 * ## Multiplicity is paid for, not ignored
 *
 * Fourteen features across five horizons is seventy comparisons, and at the
 * conventional threshold three or four come back "significant" on pure noise
 * every time, guaranteed by arithmetic rather than by the market. The ranking
 * reports the Bonferroni bar it has to clear and marks each row against it. A
 * feature that does not clear it is not a finding, however good the story.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { unzipEntries, csvRows, parseTs } from "../lib/sweep/backtest/zip";
import {
  emptyRoll, featuresFor, scoreFeature, edge,
  type Minute, type Sample, type Score,
} from "../lib/sweep/backtest/features";
import { familyZ } from "../lib/sweep/agent/learn";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};

const symbol = arg("symbol", "BTCUSDT").toUpperCase();
const histDir = resolve(arg("in", "data/history"));
const outPath = resolve(arg("out", `evidence/backtest-${symbol}.json`));
const HORIZONS = [1, 5, 15, 30, 60];

/* ------------------------------------------------------------------ input */

function eachZip(dir: string, onRows: (rows: string[][]) => void) {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".zip")).sort()) {
    try {
      for (const e of unzipEntries(readFileSync(join(dir, file)))) onRows(csvRows(e.data));
    } catch (err) {
      console.error(`[backtest] skipping ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function loadMinutes(): Minute[] {
  const depth = new Map<number, { bid: number; ask: number }>();
  eachZip(join(histDir, "bookDepth"), (rows) => {
    for (const r of rows) {
      const ts = parseTs(r[0] ?? "");
      const pct = Number(r[1]);
      const notional = Number(r[3]);
      // The 1% band only: the entry rule is about depth immediately in front of
      // price, and the wider bands are dominated by size nobody intends to defend.
      if (!Number.isFinite(ts) || Math.abs(pct) !== 1 || !Number.isFinite(notional)) continue;
      const slot = Math.floor(ts / 60_000) * 60_000;
      const cur = depth.get(slot) ?? { bid: 0, ask: 0 };
      if (pct < 0) cur.bid += notional;
      else cur.ask += notional;
      depth.set(slot, cur);
    }
  });

  /*
   * Positioning, on the metrics file's own five-minute grid.
   *
   * Written every five minutes rather than every one, so each row is carried
   * forward to the minutes after it. Forward-fill and never backward: a value
   * stamped 12:05 was not knowable at 12:03, and filling it backwards would
   * hand the replay information the live agent could not have had. That is the
   * single easiest way to manufacture an edge that evaporates in production.
   */
  const metrics = new Map<number, { oi: number; topPos: number; account: number; taker: number }>();
  eachZip(join(histDir, "metrics"), (rows) => {
    for (const r of rows) {
      // create_time,symbol,sum_open_interest,sum_open_interest_value,
      // count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,
      // count_long_short_ratio,sum_taker_long_short_vol_ratio
      const ts = parseTs(r[0] ?? "");
      if (!Number.isFinite(ts)) continue;
      metrics.set(Math.floor(ts / 60_000) * 60_000, {
        oi: Number(r[2]) || 0,
        topPos: Number(r[5]) || 0,
        account: Number(r[6]) || 0,
        taker: Number(r[7]) || 0,
      });
    }
  });

  /** Perp premium over the index, in basis points, per minute. */
  const basis = new Map<number, number>();
  eachZip(join(histDir, "premiumIndexKlines"), (rows) => {
    for (const r of rows) {
      const ts = parseTs(r[0] ?? "");
      const close = Number(r[4]);
      if (!Number.isFinite(ts) || !Number.isFinite(close)) continue;
      basis.set(Math.floor(ts / 60_000) * 60_000, close * 10_000);
    }
  });

  const out: Minute[] = [];
  eachZip(join(histDir, "1m"), (rows) => {
    for (const r of rows) {
      const ts = parseTs(r[0] ?? "");
      if (!Number.isFinite(ts)) continue;
      const slot = Math.floor(ts / 60_000) * 60_000;
      const d = depth.get(slot);
      if (!d) continue;
      const close = Number(r[4]);
      if (!(close > 0)) continue;
      out.push({
        ts: slot,
        bid1: d.bid,
        ask1: d.ask,
        close,
        high: Number(r[2]) || close,
        low: Number(r[3]) || close,
        volume: Number(r[5]) || 0,
        trades: Number(r[8]) || 0,
        // Column 9 is taker_buy_base_asset_volume — the aggressive buying that
        // makes order-flow imbalance computable with no extra download.
        takerBuy: Number(r[9]) || 0,
        basisBps: basis.get(slot),
      });
    }
  });
  out.sort((a, b) => a.ts - b.ts);

  /*
   * Carry the last positioning reading forward, and only forward.
   *
   * Anything older than fifteen minutes is dropped rather than stretched: a
   * stale open-interest number is not a current one, and letting it persist
   * across a gap in the archive would quietly turn missing data into a
   * confident feature value.
   */
  let last: { at: number; v: NonNullable<ReturnType<typeof metrics.get>> } | null = null;
  for (const m of out) {
    const fresh = metrics.get(m.ts);
    if (fresh) last = { at: m.ts, v: fresh };
    if (last && m.ts - last.at <= 15 * 60_000) {
      m.oi = last.v.oi;
      m.topPosRatio = last.v.topPos;
      m.accountRatio = last.v.account;
      m.takerRatio = last.v.taker;
    }
  }

  const withPositioning = out.filter((m) => typeof m.oi === "number").length;
  const withBasis = out.filter((m) => typeof m.basisBps === "number").length;
  console.error(
    `[backtest] positioning on ${withPositioning} minutes · basis on ${withBasis} · ` +
      `depth+price on ${out.length}`,
  );
  return out;
}

/* ------------------------------------------------------------------- main */

function main() {
  const minutes = loadMinutes();
  console.error("");
  console.error(`[backtest] ${symbol} · ${minutes.length} minutes with both depth and price`);
  if (minutes.length < 1000) {
    console.error("[backtest] not enough overlap — run npm run sweep:history first");
    process.exit(1);
  }

  const byTs = new Map(minutes.map((m) => [m.ts, m]));
  const roll = emptyRoll();
  const history: Minute[] = [];
  const samples: Sample[] = [];

  for (const m of minutes) {
    const prev = history[history.length - 1] ?? null;
    const f = featuresFor(m, prev, roll, history);
    history.push(m);
    if (history.length > 120) history.shift();
    if (!f) continue;

    /*
     * Excursions from the highs and lows inside the window, not from the close.
     *
     * A resting target fills on the high; a resting stop fills on the low.
     * Close-to-close cannot see either, which makes it the wrong instrument for
     * a strategy whose whole expression is a bracket.
     */
    const mfe: Record<string, number> = {};
    const mae: Record<string, number> = {};
    const ret: Record<string, number> = {};
    let usable = false;
    for (const h of HORIZONS) {
      let hi = -Infinity;
      let lo = Infinity;
      let last: Minute | null = null;
      for (let k = 1; k <= h; k++) {
        const b = byTs.get(m.ts + k * 60_000);
        if (!b) continue;
        hi = Math.max(hi, b.high);
        lo = Math.min(lo, b.low);
        last = b;
      }
      if (!last || !Number.isFinite(hi)) continue;
      const key = `t${h}`;
      mfe[key] = ((hi - m.close) / m.close) * 10_000;
      mae[key] = ((lo - m.close) / m.close) * 10_000;
      ret[key] = ((last.close - m.close) / m.close) * 10_000;
      usable = true;
    }
    if (usable) samples.push({ ts: m.ts, features: f, mfe, mae, ret });
  }

  console.error(`[backtest] ${samples.length} scored samples`);
  if (samples.length < 1000) {
    console.error("[backtest] too few to say anything — check the manifest dates overlap");
    process.exit(1);
  }

  const names = Object.keys(samples[0].features);
  const tests = names.length * HORIZONS.length;
  const bar = familyZ(tests);
  console.error(`[backtest] ${names.length} features × ${HORIZONS.length} horizons = ${tests} tests`);
  console.error(`[backtest] a finding must clear ${bar.toFixed(2)} sigma to survive that many looks`);

  interface Ranked {
    feature: string;
    horizon: string;
    sigma: number;
    spreadBps: number;
    tailLift: number;
    survives: boolean;
    top: Score;
    bottom: Score;
  }
  const ranked: Ranked[] = [];
  const detail: Record<string, Score[]> = {};

  for (const name of names) {
    for (const h of HORIZONS) {
      const key = `t${h}`;
      const scores = scoreFeature(samples, name, key);
      if (scores.length < 2) continue;
      const e = edge(scores);
      ranked.push({
        feature: name,
        horizon: key,
        sigma: e.sigma,
        spreadBps: e.spreadBps,
        tailLift: e.tailLift,
        survives: Math.abs(e.sigma) >= bar,
        top: scores[scores.length - 1],
        bottom: scores[0],
      });
      // Only the deciles of things worth looking at, or the file is unreadable.
      if (Math.abs(e.sigma) >= bar) detail[`${name}@${key}`] = scores;
    }
  }
  ranked.sort((a, b) => Math.abs(b.sigma) - Math.abs(a.sigma));

  /*
   * The cost line, stated in the same units as the edge.
   *
   * Everything above is gross. A round trip on this account has been running
   * around 7bp of notional, so a decile spread under that is a finding about the
   * market and not a strategy. Printing it beside the spread is the difference
   * between "we found something" and "we found something we can trade".
   */
  const ROUND_TRIP_BPS = 7;

  const report = {
    at: Date.now(),
    symbol,
    samples: samples.length,
    spanDays: Math.round((minutes[minutes.length - 1].ts - minutes[0].ts) / 86_400_000),
    horizons: HORIZONS,
    method:
      "Every feature bucketed into deciles; each decile scored on close-to-close return, on best and " +
      "worst excursion inside the window, and on the probability of clearing 25/50/100bp. Ranked by the " +
      "separation between the top and bottom deciles in standard errors of the difference.",
    multiplicity: { tests, bonferroniSigma: bar },
    roundTripBps: ROUND_TRIP_BPS,
    ranked: ranked.slice(0, 40),
    deciles: detail,
  };

  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.error("");
  console.error("  feature            horizon      σ    spread bp   tail50 lift   clears bar");
  for (const r of ranked.slice(0, 18)) {
    console.error(
      `  ${r.feature.padEnd(18)} ${r.horizon.padEnd(7)} ${r.sigma.toFixed(1).padStart(6)}  ` +
        `${r.spreadBps.toFixed(2).padStart(9)}  ${(Number.isFinite(r.tailLift) ? r.tailLift.toFixed(2) : "inf").padStart(11)}   ` +
        `${r.survives ? (Math.abs(r.spreadBps) > ROUND_TRIP_BPS ? "yes, and beats fees" : "yes, but under fees") : "no"}`,
    );
  }
  console.error("");
  console.error(`[backtest] written to ${outPath} — it rides the next snapshot push`);
  console.error("");
}

main();
