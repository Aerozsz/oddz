import type { ShadowTrade } from "../exchange/shadow";
import type { EntryConditions, TradeRecord } from "./postmortem";

/**
 * One pool of evidence, and the rule about what each kind of it may decide.
 *
 * Before this, the system had two producers writing to two files, and only one
 * of them was connected to anything. The control server wrote post-mortems that
 * the analyser read and the tuner acted on — a closed loop. The shadow runner
 * wrote a parallel log that nothing read, which meant the one collector capable
 * of gathering evidence faster than the trade rate contributed nothing to the
 * learning it existed to accelerate. Running it was advice to fill a bucket
 * with no outlet.
 *
 * Joining them is not simply a matter of concatenating two files, because the
 * two rows do not mean the same thing, and the difference is precisely located:
 *
 *   A shadow row is a **real decision** — the same signal, the same bias, the
 *   same sizer, reading the same live book — whose **fill is modelled**. What
 *   happened to the price afterwards is observed. What would have happened to
 *   our order is assumed.
 *
 * So the admissible use follows from where the number came from, not from how
 * confident anyone feels about it:
 *
 *   **Derived from price → shadow counts.** Did a thin ask precede an upward
 *   move? Did trades entered on a sweeping book reach their targets more often?
 *   How far did price run against the entry before it worked? Every one of
 *   these is a question about the market, and a shadow row answers it exactly
 *   as well as a live one, because the market did not know the order was
 *   hypothetical.
 *
 *   **Derived from fills → shadow is inadmissible.** Expectancy, realised
 *   return, whether to size up. A shadow row prices its entry at the sizer's
 *   intended price with a modelled fee and no queue, no slippage, no partial
 *   fill and no rejection. Counting those toward "is this profitable" measures
 *   the model's opinion of itself.
 *
 * That rule is enforced here rather than documented and remembered, because the
 * failure it prevents is silent: nothing would break if expectancy quietly
 * included shadow rows, the number would simply be wrong and optimistic, and
 * the first symptom would be sizing up into an edge that had never been
 * collected.
 */

/** What a body of evidence is being asked to decide. */
export type Question =
  /** Which entry conditions separate winners from losers. */
  | "entry-quality"
  /** How losses fail — never worked, gave it back, stopped mid-move. */
  | "loss-anatomy"
  /** Where the stop and the ratchet belong. */
  | "exit-geometry"
  /** Whether the strategy makes money, and how much to risk. */
  | "expectancy"
  /** What the venue accepts. */
  | "execution";

/**
 * Whether a record may be used to answer a question.
 *
 * The whole rule, in one table, so a reader can check it at a glance and a
 * caller cannot get it subtly wrong.
 */
export function admissible(record: Partial<Pick<TradeRecord, "source">>, question: Question): boolean {
  /*
   * Absent means live, deliberately.
   *
   * Every record written before this field existed is a real fill, so treating
   * an unlabelled row as live is not a lenient default — it is the correct
   * reading of the history already on disk. Only a row that positively declares
   * itself modelled is restricted, which also means a future producer has to
   * opt into the restriction rather than remember to.
   */
  if (record.source !== "shadow") return true;
  switch (question) {
    // Answered by what price did, which a shadow row observed for real.
    case "entry-quality":
    case "loss-anatomy":
    case "exit-geometry":
      return true;
    // Answered by what our order did, which a shadow row assumed.
    case "expectancy":
    case "execution":
      return false;
  }
}

/** Filter a pool to what may legitimately answer a question. */
export function evidenceFor<T extends Partial<Pick<TradeRecord, "source">>>(records: T[], question: Question): T[] {
  return records.filter((r) => admissible(r, question));
}

/**
 * Turn a scored shadow trade into a trade record.
 *
 * Returns null for a trade that has not finished scoring. A row whose outcomes
 * are still filling in would enter the pool with a fabricated result, and there
 * is no version of that which is better than waiting.
 */
export function shadowToRecord(t: ShadowTrade, conditions: EntryConditions): TradeRecord | null {
  // The longest horizon is the one the outcome is taken from; without it the
  // trade has no ending.
  const final = t.outcomes.t900 ?? t.outcomes.t300 ?? t.outcomes.t60;
  if (!final || final.pct === null || final.netUsd === null) return null;

  const entry = t.entryPrice;
  const long = t.side === "long";

  /*
   * The excursion, from the high and low the runner tracked while the trade
   * was open.
   *
   * Sampled from the same live feed the control server's excursion tracker
   * uses, so these are the same measurement taken by a different process — not
   * an approximation of it. That is what lets loss anatomy treat shadow and
   * live rows identically.
   */
  const highPct = ((t.high ?? entry) - entry) / entry * 100;
  const lowPct = ((t.low ?? entry) - entry) / entry * 100;
  const mfePct = long ? Math.max(0, highPct) : Math.max(0, -lowPct);
  const maePct = long ? Math.min(0, lowPct) : Math.min(0, -highPct);

  const distance = t.targetPrice !== null && entry > 0 ? Math.abs(t.targetPrice - entry) / entry * 100 : 0;

  /*
   * Win, loss or scratch on the same net-of-fees basis the live path uses, so
   * a row from either producer means the same thing.
   */
  const net = final.netUsd;
  const scratchBand = t.feeUsd;
  const outcome: TradeRecord["outcome"] =
    Math.abs(net) <= scratchBand ? "scratch" : net > 0 ? "win" : "loss";

  const exitReason =
    t.resolved === "stop" ? "the stop would have filled"
      : t.resolved === "target" ? "the target would have filled"
        : "still open when the scoring window ended";

  return {
    id: `shadow-${t.intentId}`,
    symbol: t.symbol,
    source: "shadow",
    side: t.side,
    openedAt: t.at,
    // Shadow trades end when their scoring window does, not when a bracket
    // fires, so the held time is the window rather than a managed exit.
    closedAt: t.at + 900_000,
    heldMs: 900_000,
    entryPrice: entry,
    exitPrice: final.mid ?? entry,
    stopPrice: t.stopPrice,
    targetPrice: t.targetPrice,
    notionalUsd: t.notionalUsd,
    leverage: t.leverage,
    realisedPnlUsd: net,
    feesUsd: t.feeUsd + t.fundingUsd,
    roiPct: t.riskUsd > 0 ? (net / (t.notionalUsd / Math.max(1, t.leverage))) * 100 : null,
    outcome,
    maePct,
    mfePct,
    peakProgress: distance > 0 ? mfePct / distance : 0,
    // The runner watches from entry to the end of the window without a gap.
    excursionComplete: true,
    exitReason,
    entryConditions: conditions,
    news: [],
  };
}
