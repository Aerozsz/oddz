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

import { maxOf, minOf } from "../lib/sweep/numeric";
import { SYMBOL } from "../lib/sweep/config";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { unzipEntries, csvRows, parseTs } from "../lib/sweep/backtest/zip";
import {
  emptyRoll, featuresFor, scoreFeature, edge,
  type Minute, type Sample, type Score,
} from "../lib/sweep/backtest/features";
import { familyZ } from "../lib/sweep/agent/learn";
import { scoreFunding, type FundingPoint } from "../lib/sweep/backtest/funding";
import { renderFindings, type RunSummary } from "../lib/sweep/backtest/findings";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};

/*
 * Falls back to the configured symbol, not to a name written here.
 *
 * This defaulted to a hardcoded "BTCUSDT" while the rest of the project was
 * pointed at something else, so a run that did not pass --symbol replayed a
 * contract nobody had asked for and reported "0 minutes with both depth and
 * price · not enough overlap". That reads as missing history. It was the wrong
 * symbol, and the history it wanted had just been downloaded successfully — 120
 * files, 18 MB, zero failures — for a different one.
 *
 * A default that silently disagrees with the configured symbol is worse than no
 * default: the run does not fail, it answers a question nobody asked.
 */
const symbol = arg("symbol", process.env.SWEEP_SYMBOL?.trim() || SYMBOL).toUpperCase();
/*
 * The symbol's own directory, and only its own files.
 *
 * Both halves matter. Reading data/history/<kind>/ mixed two instruments into
 * one series the moment a second symbol was fetched, and the prefix check below
 * means an old flat layout, or a stray file, cannot do it again quietly.
 */
const histRoot = resolve(arg("in", "data/history"));

/**
 * The layout that actually holds this symbol's files.
 *
 * `existsSync` on the symbol directory is not the question, and asking it that
 * way cost days. Files moved to `data/history/<symbol>/<kind>/` after two
 * instruments were found mixed in one folder; the fetcher creates those
 * directories with `mkdirSync` before it downloads anything, so a partial or
 * failed fetch leaves an empty tree that exists. The replay then chose the empty
 * new layout over the populated old one and refused on every symbol, every pass,
 * while the research loop reported "the replay refused" and moved on.
 *
 * So the test is whether a directory contains this symbol's data, not whether
 * something is there.
 */
function zipsUnder(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const kind of readdirSync(dir, { withFileTypes: true })) {
    if (!kind.isDirectory()) continue;
    n += readdirSync(join(dir, kind.name)).filter(
      (f) => f.endsWith(".zip") && f.startsWith(`${symbol}-`),
    ).length;
  }
  return n;
}

const nested = join(histRoot, symbol);
const histDir = zipsUnder(nested) > 0 ? nested : histRoot;
const outPath = resolve(arg("out", `evidence/backtest-${symbol}.json`));
const HORIZONS = [1, 5, 15, 30, 60];

/* ------------------------------------------------------------------ input */

function eachZip(dir: string, onRows: (rows: string[][]) => void) {
  if (!existsSync(dir)) return;
  const all = readdirSync(dir).filter((f) => f.endsWith(".zip"));
  const mine = all.filter((f) => f.startsWith(`${symbol}-`));
  if (mine.length < all.length) {
    console.error(
      `[backtest] ignoring ${all.length - mine.length} file(s) in ${dir} belonging to another symbol`,
    );
  }
  for (const file of mine.sort()) {
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

  /*
   * Refuse a series whose prices are not all the same instrument.
   *
   * This is the check that would have caught the symbol mixing whatever its
   * cause, and it is cheap. A third of the samples came back with a -99.93%
   * one-minute return, ranked as a 271,000-sigma discovery, because two price
   * scales were in one array. Nothing about the statistics was wrong — they
   * faithfully described nonsense, at enormous confidence, which is exactly how
   * this class of error survives review.
   *
   * Twenty-fold is far outside anything a single contract does in a year and
   * far inside the fifteen-hundred-fold gap between two different ones.
   */
  const closes = minutes.map((m) => m.close);
  // Not Math.min(...closes): spreading every bar in the window throws
  // RangeError once the window is large, which is precisely when a replay
  // matters. This was refusing every research pass.
  const lo = minOf(closes) ?? 0;
  const hi = maxOf(closes) ?? 0;
  if (lo > 0 && hi / lo > 20) {
    console.error(
      `[backtest] refusing: prices span ${lo.toFixed(4)} to ${hi.toFixed(2)}, a ${(hi / lo).toFixed(0)}x range. ` +
        `That is more than one instrument in one series — check ${histDir} for files from another symbol.`,
    );
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

      /*
       * The same horizon, entered one bar later.
       *
       * `m.close` is the decision minute's last trade. If a feature correlates
       * with which side that trade hit — and a taker-ratio feature correlates
       * with exactly that by construction — then the entry price is biased by
       * half the spread and the forward return reverts mechanically. That is
       * bid-ask bounce. It produces a large, highly significant decile spread
       * that is completely untradeable, because a real entry pays the same
       * spread it appears to earn.
       *
       * It was invisible on BTCUSDT, where the spread ran about 0.012bp and
       * half of nothing is nothing. On a small-cap contract it is the first
       * explanation to rule out, and the first LITUSDT run produced twelve
       * findings that beat a fees-only cost bar with takerRatioFade at the top.
       *
       * Entering one bar later breaks the conditioning: the next bar's close is
       * not the trade the feature was computed from. A real signal survives the
       * delay and weakens; a bounce artefact largely disappears. Reported
       * beside the immediate figure rather than replacing it, because the
       * *difference between the two* is the measurement.
       */
      const entry = byTs.get(m.ts + 60_000);
      const lastD = byTs.get(m.ts + (h + 1) * 60_000);
      if (entry && lastD) {
        ret[`${key}d`] = ((lastD.close - entry.close) / entry.close) * 10_000;
      }
    }
    if (usable) samples.push({ ts: m.ts, features: f, mfe, mae, ret });
  }

  console.error(`[backtest] ${samples.length} scored samples`);
  if (samples.length < 1000) {
    console.error("[backtest] too few to say anything — check the manifest dates overlap");
    process.exit(1);
  }

  const names = Object.keys(samples[0].features);
  /*
   * Delayed variants are real tests and are counted as such. Hiding them from
   * the multiplicity would lower the bar by pretending fewer looks were taken.
   */
  const HORIZON_KEYS = HORIZONS.flatMap((h) => [`t${h}`, `t${h}d`]);
  const tests = names.length * HORIZON_KEYS.length;
  const bar = familyZ(tests);
  console.error(`[backtest] ${names.length} features × ${HORIZON_KEYS.length} horizon keys = ${tests} tests`);
  console.error("[backtest] keys ending 'd' enter one bar later — the difference is the bid-ask bounce test");
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
    for (const key of HORIZON_KEYS) {
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
  /*
   * Fees only. This is not the cost of trading.
   *
   * Two taker fills at the tier this account pays, and nothing else — no
   * spread, no slippage, no queue. That was defensible on BTCUSDT, where the
   * spread ran about 0.012bp and rounding it away changed nothing. It is not
   * defensible on a small-cap contract, where crossing the spread twice can
   * cost several times the fees, and a finding "beating the round trip" here is
   * beating a bar built for a different instrument.
   *
   * Overridable so the real number can be used once it is measured, and named
   * feesOnly so nothing downstream reads it as the whole cost.
   */
  const ROUND_TRIP_BPS = Number(process.env.SWEEP_ROUND_TRIP_BPS) > 0
    ? Number(process.env.SWEEP_ROUND_TRIP_BPS)
    : 7;

  /*
   * Carry, scored alongside the directional search rather than instead of it.
   *
   * Every feature above tries to predict direction, and four separate
   * measurements have said that is not available here. Funding is the one cash
   * flow on this instrument that requires no view on direction at all, it is
   * published in advance, and it has been sitting in premiumIndexKlines
   * unexamined. It costs nothing to score it on the same pass.
   */
  const fundingPoints: FundingPoint[] = minutes
    .filter((m) => typeof m.basisBps === "number")
    .map((m) => ({ ts: m.ts, basisBps: m.basisBps as number, close: m.close }));
  const funding = {
    minutes: fundingPoints.length,
    byHorizon: Object.fromEntries(
      [60, 480, 1440].map((h) => [`m${h}`, scoreFunding(fundingPoints, h)]),
    ),
    note:
      fundingPoints.length === 0
        ? "no premium index data — the carry question cannot be asked, this is missing data and not a null result"
        : undefined,
  };

  const report = {
    at: Date.now(),
    symbol,
    funding,
    samples: samples.length,
    spanDays: Math.round((minutes[minutes.length - 1].ts - minutes[0].ts) / 86_400_000),
    horizons: HORIZON_KEYS,
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

  /*
   * A one-page verdict beside the raw report.
   *
   * The report is complete and unreadable; it exists to be queried. This exists
   * to be read cold, by a session that has no memory and will otherwise spend
   * its whole budget rebuilding context from a journal that is now thousands of
   * words long. Fourteen days of scheduled firings produced no work at all, and
   * orientation cost was a large part of why.
   */
  const eight = funding.byHorizon.m480 ?? [];
  const run: RunSummary = {
    symbol,
    samples: samples.length,
    spanDays: report.spanDays,
    bonferroniSigma: bar,
    roundTripBps: ROUND_TRIP_BPS,
    survivors: ranked
      .filter((r) => r.survives)
      .slice(0, 12)
      .map((r) => ({ feature: r.feature, horizon: r.horizon, sigma: r.sigma, spreadBps: r.spreadBps })),
    carry: eight.length
      ? [eight[0], eight[eight.length - 1]].map((b) => ({
          basisBps: b.meanBasisBps,
          collectorBps: b.meanCollectorBps,
          seBps: b.seBps,
          carryBps: b.meanCarryBps,
          totalBps: b.meanTotalBps,
        }))
      : undefined,
    carryNote: funding.note,
  };
  try {
    writeFileSync(resolve("evidence", "FINDINGS.md"), renderFindings([run]));
  } catch (err) {
    console.error(`[backtest] could not write FINDINGS.md: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.error("");
  if (fundingPoints.length === 0) {
    console.error("[backtest] no premium index data, so carry was not scored");
  } else {
    const eight = funding.byHorizon.m480 ?? [];
    if (eight.length) {
      const top = eight[eight.length - 1];
      const bot = eight[0];
      console.error("  carry at 8h, most crowded deciles (collector = the paid side):");
      for (const b of [bot, top]) {
        console.error(
          `    basis ${b.meanBasisBps.toFixed(1).padStart(7)}bp  n ${String(b.n).padStart(6)}  ` +
            `price ${b.meanCollectorBps.toFixed(2).padStart(8)}bp ±${b.seBps.toFixed(2)}  ` +
            `carry +${b.meanCarryBps.toFixed(2)}bp  total ${b.meanTotalBps.toFixed(2)}bp`,
        );
      }
    }
  }
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
