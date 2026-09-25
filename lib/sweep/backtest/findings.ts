/**
 * The current verdict on every hypothesis, regenerated from the evidence.
 *
 * The drag this removes is the largest one left. An unattended pass starts with
 * no memory and spends most of its budget rebuilding context: reading a journal
 * that is now thousands of words, re-reading a snapshot, re-deriving conclusions
 * that were already reached and paid for. Fourteen days of scheduled firings
 * produced six journal entries, every one of them written by an interactive
 * session rather than an unattended one.
 *
 * So the loop writes down what is known, in one small file, every pass. A cold
 * session reads it and is current.
 *
 * ## Why it is generated and not maintained
 *
 * A hand-maintained status document is a document that drifts. Everything here
 * is derived from the artefacts the loop already produces — the feature ranking,
 * the carry buckets, the shadow summary — so it cannot claim something the
 * evidence does not, and it cannot go stale while the evidence moves.
 *
 * The one thing carried by hand is the rejected list, because "we tested this
 * and it failed" is not recoverable from a file that only holds the latest run.
 * Those entries name their evidence and their sample size so a later pass can
 * disagree with them on the numbers rather than on a feeling.
 */

export interface Verdict {
  id: string;
  /** open = untested, rejected = measured and failed, live = in production. */
  status: "open" | "rejected" | "live" | "testing";
  claim: string;
  /** What was measured, in the units that decide it. */
  evidence: string;
  /** Sample size behind the evidence, so a later pass can judge disagreeing. */
  n?: number;
}

/**
 * What has already been settled, and must not be re-derived from scratch.
 *
 * Every entry cost real time to establish. A pass that re-runs one of these is
 * a pass that produced nothing, and that has happened enough to be worth
 * writing down rather than remembering.
 */
export const SETTLED: Verdict[] = [
  {
    id: "sweep-direction",
    status: "rejected",
    claim: "A thin book on the side price must travel through predicts the direction of the next move.",
    evidence:
      "513,000 one-minute samples over 365 days, 25 features, 5 horizons. 21 findings cleared a 3.40 sigma " +
      "Bonferroni bar; none cleared the 7bp round trip. Largest decile spread anywhere 1.74bp. MFE is " +
      "approximately -MAE in every bucket of every feature, so the walk is symmetric conditioned on anything measured.",
    n: 513_000,
  },
  {
    id: "dead-tape",
    status: "testing",
    claim:
      "The aggTrade stream reaches no consumer, so 45% of the directional read has never fired and the maker path was never gated.",
    evidence:
      "Confirmed by two independent counters on the live production feed after 241 seconds of healthy uptime on " +
      "BTCUSDT: the mark-out tracker reports tradesSeen 0, and state.flow reads {buy: 0, sell: 0}. Both are " +
      "written inside the same case \"aggTrade\" block, so the block does not execute. Depth is fine — the book " +
      "syncs and the feed check reads ok — which is why this survived weeks of a health panel that was green. " +
      "What it silently disables: mark-out entirely, and with it canPostEntry, which refuses on its first line " +
      "when mark-out is cold and therefore never once consulted the toxicity threshold; the bias factor 'who " +
      "has been right' (weight 0.25), which the module calls the only input scored against realised outcomes " +
      "rather than against the state of the book; the bias factor 'aggressive flow' (weight 0.20); the " +
      "participant model; the shock tape; and the large-trade tape. The composite renormalises over present " +
      "factors, so it is not shrunk toward zero — but every side this project has ever called was decided " +
      "without 0.45 of the intended weight, and the 2.20:1 long skew has to be re-examined against that. " +
      "Does not overturn the 513,000-sample historical result, which computed its own flow features from the " +
      "archive; it does mean the 23,880 live shadow decisions were taken by a crippled version of the read. " +
      "FIXED 2026-08-28 by polling the tape over REST, the way klines already came — which is exactly why " +
      "volatility survived a dead kline stream and the tape did not. Mark-out is warm for the first time in " +
      "this project (309 horizons resolved). Not a fix to the socket: five separate connections to fstream " +
      "with the subscription acknowledged on all of them and one delivering is not something this process can " +
      "repair, and the per-stream rescue sockets all reported open and silent. The tape is sampled rather " +
      "than complete — a four-second poll cannot resolve the one-second mark-out horizon precisely, though " +
      "the five-second one the toxicity read uses is fine — and connection.tapeVia reports which path is " +
      "live so nobody reads a sampled bucket as if it came off the wire. Every conclusion drawn from the " +
      "24,061 existing shadow rows describes the crippled version and should be re-derived, not reused.",
  },
  {
    id: "cost-reduction",
    status: "rejected",
    claim:
      "The loss is cost, so cutting the cost fixes it — resting the entry saves about $4.87 of a $7.60 round trip.",
    evidence:
      "The first half is true and the conclusion does not follow. Across 23,820 scored decisions the round trip " +
      "costs $0.5826 each and the gross price contribution is $0.0223 each: fees are 26x gross, and removing " +
      "them entirely leaves $0.0223 a decision. At 300 decisions a day that is $6.68; reaching $300 a day would " +
      "need 13,477 decisions daily, one every 6.4 seconds, with zero fees. Gross rises with the horizon " +
      "($0.0036 at t60, $0.0223 at t900, $0.7441 at t7200) and t7200 is the one that would pay — 403 decisions " +
      "a day for $300 — but that is exactly the horizon already shown to be drift. Split by side there: longs " +
      "+0.2470% at 18.7 sigma, shorts -0.2476% at -11.0 sigma, on a book that is 3:1 long. Equal-weighted the " +
      "mean is -0.00033%, so the honest gross at two hours is -$0.0020 a decision. The only horizon whose gross " +
      "could cover the costs is the one whose gross is the long book in a rising sample. No fee schedule fixes " +
      "an edge of two cents, and the maker path is worth pursuing as market-making, not as a discount on this.",
    n: 23_820,
  },
  {
    id: "depth-inverted",
    status: "rejected",
    claim:
      "The depth signal is real but backwards — thin books do worse, so the fix is free: same gate, opposite side.",
    evidence:
      "Worth testing because the pooled fifteen-minute bands ran monotonically the wrong way and thinnest-minus-" +
      "thickest was 9.2bp, wider than the 7bp round trip — the first thing in this project to clear it. It does " +
      "not survive. Crossed against side at every horizon: t60 long +0.78 sigma and short +0.20, t300 long -0.84 " +
      "and short +0.45, t900 long -3.14 and short -0.56, t1800 long -2.36 and short -1.58, t7200 long -0.28 and " +
      "short -1.08. Absent at one and five minutes, where there is no drift to explain anything away; present " +
      "only at fifteen and thirty, carried mostly by longs; gone again at two hours. A microstructure effect is " +
      "strongest where the mechanism acts and decays with time — this is the opposite shape, and it is what noise " +
      "looks like across fifteen cells. Even taking the best cell at face value it is 5.97bp, still under the " +
      "round trip. The 9.2bp came from the extreme 532-row bucket, which is the widest and noisiest slice available.",
    n: 23_876,
  },
  {
    id: "sweep-live-shadow",
    status: "rejected",
    claim: "The same signal, measured on live decisions rather than history, does better.",
    evidence:
      "20,000+ shadow decisions on the real book with modelled fills — the optimistic case, no queue, no " +
      "slippage. Negative at every horizon out to 15 minutes. Gross price contribution across 7,248 scored " +
      "decisions was -$128 against $3,857 of fees: the loss is cost, not being wrong.",
    n: 20_000,
  },
  {
    id: "hold-longer",
    status: "rejected",
    claim: "The signal works but is cut too early; holding two hours turns the loss into a profit.",
    evidence:
      "On the same 10,739 matched trades the mean runs -0.0004, -0.0005, +0.0059, +0.0423, +0.1510 percent " +
      "at 1, 5, 15, 30 and 120 minutes — monotonic, 10.7 sigma. Split by side it is beta: longs +0.2750 " +
      "(17.7 sigma), shorts -0.2926 (-9.5 sigma), and the book is 78% long. Equal-weighted the mean is " +
      "-0.0088 percent, which is nothing.",
    n: 10_739,
  },
  {
    id: "magnitude",
    status: "open",
    claim: "Direction is unpredictable but magnitude is not, which is a market-making mandate.",
    evidence:
      "volatility's top decile has a 49.0% chance of a favourable excursion over 50bp against 2.6% in the " +
      "bottom — an 18.8x lift on 51,000 samples per bucket. Symmetric direction with predictable step size " +
      "is the shape of a spread-earning strategy rather than a directional one.",
    n: 513_000,
  },
  {
    id: "maker-path",
    status: "open",
    claim: "Resting the entry earns the spread instead of paying it, worth about 4.87 dollars a round trip.",
    evidence:
      "Zero fills in 23,876 shadow decisions, gated behind canPostEntry on mark-out toxicity. Was carried as " +
      "'the largest unexplored lever', which assumed the gate opens and the fills do not happen; that was never " +
      "checked. Three situations produce the same zero and point opposite ways — a mark-out that never warms " +
      "(defect), one that warms above the threshold (a market answer, and the lever does not exist), or an open " +
      "gate with every entry still priced taker (plumbing). The summary now separates them from rows already " +
      "written. Note that cost-reduction is settled against this being a rescue for the current signal: a two " +
      "cent gross edge survives no fee schedule. It is worth pursuing only as the entry side of market-making, " +
      "where the spread is the revenue rather than a discount.",
  },
  {
    id: "sub-minute",
    status: "open",
    claim: "The mechanism acts in seconds, so one-minute bars average it away.",
    evidence:
      "Never tested. The archive fetch takes --ticks and the research loop pulls a window each pass; no " +
      "replay reads it. Everything measured so far has been on bars, testing a seconds-scale claim at " +
      "minute resolution.",
  },
  {
    id: "carry",
    status: "testing",
    claim: "Funding pays the unpopular side, and that payment needs no view on direction.",
    evidence:
      "Scored on every research pass as of this build, bucketed by basis decile and oriented to the " +
      "collector. Reports the price move, the carry and the sum separately, because the payment is small " +
      "and certain while the move against it is large and uncertain.",
  },
  {
    id: "long-bias",
    status: "rejected",
    claim: "The entry gate is long-biased, which is a defect rather than a market fact.",
    evidence:
      "16,425 longs against 7,455 shorts across the whole file — 2.20:1. The 3.6:1 figure repeated until now " +
      "was the matched two-hour subset (8,396 against 2,343), which is an older and smaller sample; both are " +
      "real and they are not the same number, and the larger one should not be the one that gets quoted. " +
      "A microstructure signal meant to be symmetric should not take two longs for every short, and this skew " +
      "is what made the two-hour result look spectacular before the side split. It was undiagnosable by " +
      "construction until now: the bias " +
      "read returns a signed composite and its factors, the strategy collapsed it to buy or sell, and the " +
      "shadow row set biasConviction to a hardcoded null — so the only input that picks the side was the " +
      "only input never recorded. Intents now carry the decomposition and the summary averages each factor " +
      "over every decision that recorded it, sorted by distance from zero. A factor comparing two sides of " +
      "a book should average near zero over thousands of decisions; whichever does not is either reading a " +
      "real persistent asymmetry or is signed wrong. ANSWERED 2026-08-28: it was the dead tape. With the tape " +
      "restored the gate is balanced — 92 longs against 101 shorts on the rows written since, which is -0.65 " +
      "sigma from an even book and -6.25 sigma from the old ratio. The skew did not drift, it ended. Two of six " +
      "factors were absent, including 'who has been right', the only input scored against realised outcomes; " +
      "take a quarter of the evidence from a directional read and the survivors lean. Rejected as a claim about " +
      "the signal: it was never a market fact and never a property of the entry. It is also the explanation for " +
      "the other three false positives here — hold-longer, depth-inverted and the two-hour gross were all killed " +
      "by the same side split, all of them really the long book in a rising sample, and the long book was this. " +
      "Separately kills the suspicion of a disabled dead zone: minAbsComposite came back 0.1202 against a " +
      "threshold of 0.12, so the gate applies exactly as written.",
    n: 10_739,
  },
];

export interface RunSummary {
  symbol: string;
  samples: number;
  spanDays: number;
  bonferroniSigma: number;
  roundTripBps: number;
  /**
   * How the cost bar was arrived at.
   *
   * Reported because "beats the round trip" means nothing without it. The bar
   * was a constant borrowed from a contract whose spread rounds to zero, and a
   * reader had no way to tell a measured bar from an inherited one.
   */
  cost?: {
    feesBps: number;
    rollBps: number | null;
    bounceBps: number | null;
    /** The spread observed on the tape, when the tick measurement ran. */
    tickBps?: number | null;
    basis: string;
    note: string;
  };
  /** Features that cleared the bar, with their spread. */
  survivors: {
    feature: string;
    horizon: string;
    sigma: number;
    spreadBps: number;
    /**
     * The same finding refitted on each half of the window.
     *
     * The Bonferroni bar controls for how many questions were asked, not for
     * the sample being one window of one contract — which is where a spurious
     * answer most likely comes from. Two halves of a real effect point the same
     * way and are each individually visible.
     */
    halves?: { aSigma: number; aBps: number; bSigma: number; bBps: number; agree: boolean } | null;
  }[];
  /** Extreme carry buckets, if the premium index was present. */
  carry?: { basisBps: number; collectorBps: number; seBps: number; carryBps: number; totalBps: number }[];
  carryNote?: string;
  /**
   * The best survivor priced against the depth curve, size by size.
   *
   * `roundTripBps` above is the bar at an infinitesimal order — fees plus one
   * tick — and on this contract that is almost the whole of it, which is
   * exactly why it is misleading. The spread is 0.243bp and the book is thin,
   * so what a real order pays is the walk down it, and that is a function of
   * size rather than a constant. Without this table "beats the round trip" is
   * a claim that holds at every size and is actionable at none.
   */
  sizing?: {
    feature: string;
    horizon: string;
    edgeBps: number;
    /**
     * The same feature entered at the decision bar's close rather than one bar
     * later, when the table is built on the delayed variant.
     *
     * Carried so the artefact stays visible. On LITUSDT the immediate `t5`
     * reads 26.63bp and the delayed `t5d` reads 16.06bp; the difference is the
     * entry price sitting on the side of the book the signal fired from, and
     * sizing an order against the larger number would quote dollars per trade
     * on a figure that is 40% bounce.
     */
    immediateBps?: number;
    rows: {
      usd: number;
      totalBps: number | null;
      stressTotalBps: number | null;
      netBps: number | null;
      netUsd: number | null;
      stressNetBps: number | null;
      tradesPerDay: number;
      refused?: string;
    }[];
    /**
     * The same edge against the two bounds measured on executed sweeps.
     *
     * The modelled curve prices resting depth and so runs cheap; the full move
     * a real sweep made runs dear, because part of it is the information that
     * sweep carried and a mechanical signal carries none. The reverting part
     * sits between. Quoting one number without the bracket is what made the
     * earlier tables read more confident than the evidence.
     */
    bounds?: { usd: number; pessimisticNetBps: number | null; revertingNetBps: number | null }[];
    /** The size that earns most per round trip: the knee, in dollars. */
    best?: { usd: number; netBps: number; netUsd: number; tradesPerDay: number } | null;
    /** The same, priced at the ninetieth-percentile minute rather than the median. */
    bestStress?: { usd: number; netBps: number; netUsd: number; tradesPerDay: number } | null;
  };
}

/**
 * One page a cold session can read instead of rebuilding.
 *
 * Deliberately short. A status document nobody finishes reading is a status
 * document that does not work, and the failure it exists to prevent is a pass
 * spending its whole budget on orientation.
 */
export function renderFindings(runs: RunSummary[], at = Date.now()): string {
  const lines: string[] = [];
  lines.push("# Findings");
  lines.push("");
  lines.push(`Generated ${new Date(at).toISOString()} by the research loop. Do not edit — it is`);
  lines.push("rewritten every pass. Read this before the journal; the journal carries intent and");
  lines.push("this carries what is currently true.");
  lines.push("");

  lines.push("## Settled");
  lines.push("");
  lines.push("Each of these cost real time to establish. Re-deriving one is a wasted pass.");
  lines.push("");
  for (const v of SETTLED.filter((x) => x.status === "rejected")) {
    lines.push(`- **${v.id}** — REJECTED. ${v.claim}`);
    lines.push(`  ${v.evidence}${v.n ? ` (n=${v.n.toLocaleString()})` : ""}`);
  }
  lines.push("");

  lines.push("## Open");
  lines.push("");
  for (const v of SETTLED.filter((x) => x.status !== "rejected")) {
    lines.push(`- **${v.id}** — ${v.status.toUpperCase()}. ${v.claim}`);
    lines.push(`  ${v.evidence}${v.n ? ` (n=${v.n.toLocaleString()})` : ""}`);
  }
  lines.push("");

  lines.push("## Latest run");
  lines.push("");
  if (runs.length === 0) {
    lines.push("No replay produced a result this pass. That is a fault, not a null result —");
    lines.push("check that the history directory holds this symbol's files.");
    lines.push("");
  }
  for (const r of runs) {
    lines.push(`### ${r.symbol}`);
    lines.push("");
    lines.push(
      `${r.samples.toLocaleString()} samples over ${r.spanDays} days. Bar ${r.bonferroniSigma.toFixed(2)} sigma, ` +
        `round trip ${typeof r.roundTripBps === "number" ? r.roundTripBps.toFixed(2) : r.roundTripBps}bp.`,
    );
    if (r.cost) {
      lines.push("");
      lines.push(
        `Cost bar: fees ${r.cost.feesBps}bp + spread — ` +
          // The tape first, when it ran: it is the only one of the three that
          // observed the spread instead of inferring it from a price path.
          (typeof r.cost.tickBps === "number"
            ? `**tape ${r.cost.tickBps.toFixed(3)}bp**, `
            : "") +
          `Roll ${r.cost.rollBps === null ? "n/a" : r.cost.rollBps.toFixed(2) + "bp"}, ` +
          `delayed-entry ${r.cost.bounceBps === null ? "n/a" : r.cost.bounceBps.toFixed(2) + "bp"} ` +
          `(${r.cost.basis}). ${r.cost.note}`,
      );
    }
    lines.push("");
    if (r.survivors.length === 0) {
      lines.push("No feature cleared the bar.");
    } else {
      const paying = r.survivors.filter((s) => Math.abs(s.spreadBps) > r.roundTripBps);
      lines.push(
        `${r.survivors.length} cleared the bar; **${paying.length} also beat the round trip** ` +
          `at an infinitesimal order` +
          (paying.length ? " — see the sizing table for what that is worth at a real one." : " — so none is tradeable as a directional signal."),
      );
      lines.push("");
      for (const s of r.survivors.slice(0, 8)) {
        const h = s.halves;
        lines.push(
          `- \`${s.feature}\` @ ${s.horizon}: ${s.sigma.toFixed(1)} sigma, ${s.spreadBps.toFixed(2)}bp` +
            (Math.abs(s.spreadBps) > r.roundTripBps ? " — **beats fees**" : "") +
            // The halves matter more than the headline: a finding that lives in
            // one half of the window is a property of a fortnight.
            (h
              ? ` · halves ${h.aSigma.toFixed(1)}/${h.bSigma.toFixed(1)} sigma, ` +
                `${h.aBps.toFixed(1)}/${h.bBps.toFixed(1)}bp — ` +
                (h.agree ? "**holds in both**" : "DOES NOT HOLD IN BOTH")
              : ""),
        );
      }
    }
    lines.push("");

    /*
     * The sizing table, which is the part worth acting on.
     *
     * Everything above this line is a claim about basis points and everything
     * below is a claim about dollars. The conversion is the depth curve, and
     * it is where the project's largest finding either becomes a business or
     * stops: at $1,000 the edge is nearly intact and earns under a dollar a
     * trade, at $50,000 the impact has eaten all of it. A table rather than a
     * verdict, because the size is the operator's decision and hiding it
     * behind one recommended number would be the same mistake as the constant
     * cost bar.
     */
    if (r.sizing) {
      const z = r.sizing;
      lines.push(
        `#### Sizing — \`${z.feature}\` @ ${z.horizon}, edge ${Math.abs(z.edgeBps).toFixed(2)}bp`,
      );
      lines.push("");
      if (typeof z.immediateBps === "number") {
        lines.push(
          `Priced on the delayed entry. The same feature entered at the decision close reads ` +
            `${Math.abs(z.immediateBps).toFixed(2)}bp, and the ` +
            `${(Math.abs(z.immediateBps) - Math.abs(z.edgeBps)).toFixed(2)}bp between them is the entry ` +
            `price sitting on the side of the book the signal fired from, not edge.`,
        );
        lines.push("");
      }
      lines.push("| size | cost RT | net | $/trade | trades/day for $300 | p90 net |");
      lines.push("| --- | --- | --- | --- | --- | --- |");
      const refusals: string[] = [];
      for (const row of z.rows) {
        if (row.totalBps === null) {
          // The reason goes under the table, not into a column headed "p90 net".
          refusals.push(`$${row.usd.toLocaleString()}: ${row.refused ?? "unpriceable"}`);
          lines.push(`| $${row.usd.toLocaleString()} | — | — | — | never | — |`);
          continue;
        }
        const net = row.netBps as number;
        lines.push(
          `| $${row.usd.toLocaleString()} | ${row.totalBps.toFixed(2)}bp | ` +
            `${net > 0 ? "**+" : ""}${net.toFixed(2)}${net > 0 ? "**" : ""}bp | ` +
            `$${(row.netUsd as number).toFixed(2)} | ` +
            `${Number.isFinite(row.tradesPerDay) ? Math.ceil(row.tradesPerDay).toLocaleString() : "never"} | ` +
            `${row.stressNetBps === null ? "n/a" : row.stressNetBps.toFixed(2) + "bp"} |`,
        );
      }
      lines.push("");
      if (z.bounds && z.bounds.some((b) => b.pessimisticNetBps !== null)) {
        lines.push(
          "Against impact measured on executed sweeps rather than modelled from resting depth — " +
            "the full move a real order of this size made, and the part of it that reverted within " +
            "a minute:",
        );
        lines.push("");
        lines.push("| size | net if it pays the whole move | net if it pays only the revert |");
        lines.push("| --- | --- | --- |");
        for (const b of z.bounds) {
          if (b.pessimisticNetBps === null && b.revertingNetBps === null) continue;
          const f = (x: number | null) =>
            x === null ? "—" : `${x > 0 ? "**+" : ""}${x.toFixed(2)}${x > 0 ? "**" : ""}bp`;
          lines.push(`| $${b.usd.toLocaleString()} | ${f(b.pessimisticNetBps)} | ${f(b.revertingNetBps)} |`);
        }
        lines.push("");
        lines.push(
          "The truth is between the two columns. A mechanical signal carries no private " +
            "information, so it should not pay the whole move; it does arrive alongside informed " +
            "flow, so it will not pay only the revert either.",
        );
        lines.push("");
      }
      for (const r of refusals) lines.push(`- ${r}`);
      if (refusals.length) lines.push("");
      if (z.best) {
        lines.push(
          `Best size $${z.best.usd.toLocaleString()}: **$${z.best.netUsd.toFixed(2)} a round trip**, ` +
            `so ${Math.ceil(z.best.tradesPerDay).toLocaleString()} of them a day for $300.` +
            (z.bestStress
              ? ` At the ninetieth-percentile minute it is $${z.bestStress.netUsd.toFixed(2)} ` +
                `at $${z.bestStress.usd.toLocaleString()}.`
              : " It does not survive the ninetieth-percentile minute at any measured size."),
        );
      } else {
        lines.push(
          "**No measured size pays.** The edge is smaller than the cost of the smallest order the " +
            "depth curve can price, which is a verdict about this finding and not a missing number.",
        );
      }
      lines.push("");
      lines.push(
        "The first table prices *resting* depth. That was assumed to be optimistic — quotes are pulled " +
          "as an order arrives — but 380,411 executed sweeps say otherwise above $5,000: real sweeps " +
          "meet a book that refreshes, so the modelled curve runs dearer than the reverting cost, not " +
          "cheaper. It is optimistic only at the smallest sizes. Read the bracket, not this table alone.",
      );
      lines.push("");
    }

    if (r.carryNote) {
      lines.push(`Carry: ${r.carryNote}`);
    } else if (r.carry && r.carry.length) {
      lines.push("Carry at 8h, the two most crowded deciles, oriented to the side that collects:");
      lines.push("");
      for (const c of r.carry) {
        lines.push(
          `- basis ${c.basisBps.toFixed(1)}bp: price ${c.collectorBps.toFixed(2)}bp ±${c.seBps.toFixed(2)}, ` +
            `carry +${c.carryBps.toFixed(2)}bp, **total ${c.totalBps.toFixed(2)}bp**`,
        );
      }
    }
    lines.push("");
  }

  lines.push("## What a pass should do");
  lines.push("");
  lines.push("In order, stopping at the first that is not already done:");
  lines.push("");
  lines.push("1. Anything in `errors` or a `bad` in `diagnose` from `evidence/snapshot.json`.");
  lines.push("2. Write the tick replay. The fetch exists; nothing reads it.");
  lines.push("3. Measure why `canPostEntry` has never allowed a maker fill.");
  lines.push("4. Find why the entry gate is 3.6:1 long-biased.");
  lines.push("");
  lines.push("Do not arm trading. That is the operator's, and every measurement says the");
  lines.push("current signal loses money.");
  lines.push("");
  return lines.join("\n");
}
