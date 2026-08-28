import type { AgentState } from "./types";

/**
 * What every trade looked like, so the losses can be interrogated later.
 *
 * The honest framing first, because "self-learning" invites two claims this
 * cannot support and one it can.
 *
 * It cannot put a name to the account on the other side. Nothing in public
 * market data identifies a sender, and a record that claimed to would be a
 * fiction fitted confidently.
 *
 * It can learn the participants as behaviour, which is the useful half and is
 * recorded in full below. A desk working a parent order leaves uniform slices
 * at a steady cadence; a market maker replaces consumed depth in under a
 * second and quotes far more often than it trades; an iceberg refills the same
 * price repeatedly; a human picks round prices and round sizes. Those are
 * fingerprints of conduct rather than identity, they are already measured by
 * the participant tracker, and — this is the point of freezing them here — they
 * are the readings the entry was actually betting on. The whole thesis is that
 * a book thin *because the quoting machine stepped away* behaves differently
 * from one thin *because a desk is absorbing*, and until these fields sat in
 * the trade record there was no way to check whether that distinction earns
 * anything.
 *
 * It cannot learn the impact of external factors from a handful of headlines.
 * News is recorded alongside each trade as a covariate, so a human reading a
 * post-mortem can see what was in the air. Twenty items and forty trades cannot
 * establish that any of it caused anything, and nothing here will pretend they
 * did.
 *
 * What it can do is the thing that actually matters: record the complete state
 * at entry, the worst and best the position ever got to, and how it ended —
 * then let the losses be grouped by the conditions present at entry and asked
 * whether any of those conditions separates the losers from the winners. That
 * is measurement rather than modelling, and at forty trades measurement is the
 * only one of the two that is not self-deception.
 *
 * The excursion pair is the part with the most information per byte. Realised
 * PnL says a trade lost; MAE and MFE say whether it was *ever* right. A loser
 * that never went a basis point in favour was a bad entry. A loser that reached
 * 80% of its target and came back was a bad exit. Those need opposite fixes,
 * and the closing price alone cannot tell them apart.
 */

export interface TradeRecord {
  id: string;
  symbol: string;
  /**
   * Where this record came from, and therefore what it may be used to decide.
   *
   * "live" is an order that really executed. "shadow" is an intent the strategy
   * produced and priced but never sent — a real decision, read off a real book,
   * scored against what price really did, with the fill modelled rather than
   * observed.
   *
   * The distinction is load-bearing rather than informational, and the rule it
   * enforces is in `admissible()`: shadow evidence is valid for anything
   * derived from *price* and invalid for anything derived from *fills*. Whether
   * a thin ask predicted an upward move is a question about the market, and a
   * shadow row answers it as well as a live one. Whether the strategy makes
   * money is a question about execution — queue position, slippage, partial
   * fills — and a shadow row answers it with an assumption dressed as a
   * measurement. Merging the two pools without this tag is how a system talks
   * itself into believing an edge it has never actually collected.
   */
  source: "live" | "shadow";
  side: "long" | "short";
  openedAt: number;
  closedAt: number;
  heldMs: number;

  entryPrice: number;
  exitPrice: number;
  stopPrice: number | null;
  targetPrice: number | null;
  notionalUsd: number;
  leverage: number;

  /** Net of fees and funding, as the exchange reported it. */
  realisedPnlUsd: number | null;
  feesUsd: number | null;
  /** Return on the margin actually committed, in percent. */
  roiPct: number | null;
  outcome: "win" | "loss" | "scratch";

  /**
   * Maximum adverse and favourable excursion, in percent of entry.
   *
   * The two numbers that separate a bad entry from a bad exit, which is the
   * distinction every other field here is blind to.
   */
  maePct: number;
  mfePct: number;
  /** How far it got toward the target at its best, 0..1+. */
  peakProgress: number;
  /**
   * Whether the excursion covers the whole life of the position.
   *
   * False when the process restarted while it was open, so the tracker only
   * watched part of it. The asymmetry matters and the analyser relies on it: a
   * high MFE on a partial window is still a fact — the price did reach there —
   * but a low one may only mean nobody was looking. So "it reached 80% and gave
   * it back" survives a restart and "it never moved" does not.
   */
  excursionComplete: boolean;

  /** Why it closed: the stop, the target, the hold policy, or by hand. */
  exitReason: string;

  /** Everything the entry was justified by, frozen at the moment it was taken. */
  entryConditions: EntryConditions;

  /** Headlines live at the time, as context for a human. Not a cause. */
  news: { headline: string; impact: string; at: number }[];
}

/**
 * The readings present when the position was opened.
 *
 * Deliberately flat and numeric: every field here is something the analyser can
 * bucket and count. Anything that needs a paragraph to interpret belongs in the
 * reasoning strings, not here, because a field nobody can group by is a field
 * that never gets examined.
 */
export interface EntryConditions {
  /** Depth on the side the trade would have to move through, over baseline. */
  lwiAdj: number | null;
  /** The other side, so one-sidedness is recoverable. */
  lwiOtherAdj: number | null;
  spreadBps: number | null;
  /** Share of removed depth that left by cancellation rather than trading. */
  cancelShare: number | null;

  cascadeRisk: number | null;
  seedNotional: number | null;
  /** Distance to the cluster the trade was aimed at, percent. */
  targetDistPct: number | null;
  /** Distance to the nearest cluster the other way, percent. */
  adverseDistPct: number | null;

  markoutWarm: boolean;
  markoutInformed: number | null;
  markoutToxicity: number | null;

  volatilityPct: number | null;
  fundingRate: number | null;
  minutesToFunding: number | null;

  session: string;
  cashOpen: boolean;
  /** Hour of the day in UTC, for a crude time-of-day grouping. */
  utcHour: number;

  biasConviction: number | null;
  /**
   * The signed composite that chose the side, and each factor behind it.
   *
   * `biasConviction` is a magnitude: it says how sure, never of what. Both live
   * and shadow rows carried it and neither could answer why the book came out
   * 3:1 long, because the sign and the decomposition were discarded at the one
   * point they existed.
   *
   * The factor map is keyed by name, so a run that adds or drops a factor stays
   * readable rather than shifting a positional array. Null when the caller did
   * not supply the read, which is a different statement from a composite of
   * zero and has to stay distinguishable from it.
   */
  biasComposite: number | null;
  biasFactors: Record<string, number> | null;
  /** Which signal kind opened it. */
  signalKind: string | null;
  /** Size retained after the condition derates, 0..1. */
  sizeRetained: number | null;

  /* ------------------------------------------------- what was in the air */

  /**
   * Headlines live when the entry was taken, as numbers rather than prose.
   *
   * These exist so the news store stops being decoration. It was being written
   * by an agent and attached to each record as text for a human to read, which
   * meant no amount of diligent news capture could ever change a decision. As
   * three bucketable fields the analyser can ask the only question worth
   * asking: do entries taken in the minutes after a significant headline behave
   * differently from the rest?
   *
   * Still a covariate and still not a cause. A split on these says trades near
   * news performed differently, never that the news did it.
   */
  /** 3 for a high-impact item live at entry, 2 medium, 1 low, 0 for none. */
  newsImpactMax: number;
  /** Minutes since the most recent item. Null when there was none. */
  minutesSinceNews: number | null;
  /** How many items were live in the preceding six hours. */
  newsCount6h: number;
  /**
   * What the tape itself said at entry: 0 nothing, 3 severe.
   *
   * Recorded separately from the headline fields because it is a different
   * instrument answering the same question, and the whole argument for building
   * it was that it is the one that fires first. Leaving it out would have meant
   * the fastest reading in the system was the one thing the post-mortem could
   * never split on — every "was this a normal market" question answered by a
   * source that is minutes late by construction.
   */
  shockLevel: number;
  /** Mentions across forums and social against baseline. 1 is normal. */
  chatterVelocity: number;

  /* --------------------------------------------------- who was standing there */

  /**
   * What the resting side was behaving like.
   *
   * "liquidity-present", "liquidity-withdrawing", "worked-order", "hidden-size".
   * The single most important grouping in this whole record, because it is the
   * distinction the strategy is built on: a book thin because the quoting
   * machine stepped away is a different trade from one thin because a desk is
   * absorbing, and until now the record could not tell them apart afterwards.
   */
  participantRegime: string | null;
  /** How much evidence that call rested on, 0..1. A low-confidence regime is not a regime. */
  participantConfidence: number | null;
  /** Seconds for consumed depth to be replaced. Sub-second means a machine is quoting. */
  replenishSec: number | null;
  /** Levels emptied and restored repeatedly — the iceberg signature. */
  refillLevels: number | null;
  /** Book updates per second that produced no trade. Quote churn. */
  flickerPerSec: number | null;
  /** How alike the trade sizes are — an algorithm slicing a parent order. */
  sliceUniformity: number | null;
  /** 0..1, whether the flow looks computed rather than decided. */
  mechanical: number | null;

  /* ------------------------------------------- who was crossing the spread */

  /**
   * Share of aggressive volume that arrived in orders large enough to walk more
   * than one level.
   *
   * The taker-side counterpart to the fields above, and the one that answers
   * whether price was being *taken* or merely drifting. A cluster is reached
   * because somebody crossed hard enough to reach it, so an entry taken into a
   * drip and an entry taken into a sweep are different bets with the same
   * price on the screen.
   */
  sweepShare: number | null;
  /** The largest single instant order seen in the window, in notional. */
  largestBurstUsd: number | null;
  /** How many price levels that order ate through. */
  largestBurstLevels: number | null;
  /** Signed −1..1 — aggressive buying against aggressive selling. */
  aggressorImbalance: number | null;
  /** Aggressive notional per second. */
  takerIntensity: number | null;
  /** How concentrated the aggression was in its largest orders, 0..1. */
  aggressorConcentration: number | null;
}

/** Freeze the readings that justified an entry. */
export function captureConditions(
  state: AgentState,
  side: "long" | "short",
  extra: {
    targetPrice: number | null;
    biasConviction?: number | null;
    /** The whole directional read, when the caller has it. */
    bias?: {
      composite: number;
      conviction: number;
      factors: { name: string; score: number; weight: number }[];
    } | null;
    signalKind?: string | null;
    sizeRetained?: number | null;
    /**
     * Headlines live at entry, newest first, supplied by the caller.
     *
     * Passed in rather than read here so this module stays free of file access
     * and can be called from the browser, the shadow runner and the control
     * server alike.
     */
    news?: { at: number; impact: string }[];
  },
): EntryConditions {
  const long = side === "long";
  const liq = state.liquidity;
  const p = state.participants;
  const agg = p?.aggressor ?? null;
  const entry = state.mid ?? state.mark ?? 0;

  const withdrawn = liq ? liq.withdrawnBid + liq.withdrawnAsk : 0;
  const consumed = liq ? liq.consumedBid + liq.consumedAsk : 0;
  const removed = withdrawn + consumed;

  const adverse = long ? state.nearestBelow : state.nearestAbove;
  const cascade = long ? state.cascadeUp : state.cascadeDown;

  return {
    // The side a move in our favour has to eat through, not the average of both:
    // an average hides exactly the one-sidedness the entry was reading.
    lwiAdj: liq ? (long ? liq.lwiAskAdj : liq.lwiBidAdj) : null,
    lwiOtherAdj: liq ? (long ? liq.lwiBidAdj : liq.lwiAskAdj) : null,
    spreadBps: liq?.spreadBps ?? null,
    cancelShare: removed > 0 ? withdrawn / removed : null,

    cascadeRisk: cascade?.risk ?? null,
    seedNotional: cascade?.seedNotional ?? null,
    targetDistPct:
      extra.targetPrice !== null && entry > 0
        ? (Math.abs(extra.targetPrice - entry) / entry) * 100
        : null,
    adverseDistPct: adverse && entry > 0 ? (Math.abs(adverse.price - entry) / entry) * 100 : null,

    markoutWarm: state.markout.warm,
    markoutInformed: state.markout.warm ? state.markout.informed : null,
    markoutToxicity: state.markout.warm ? state.markout.toxicity : null,

    volatilityPct: state.volatilityPct,
    fundingRate: state.funding.rate,
    minutesToFunding: state.funding.msToFunding ? state.funding.msToFunding / 60_000 : null,

    session: state.session.intraday,
    cashOpen: state.session.cashOpen,
    utcHour: new Date().getUTCHours(),

    biasConviction: extra.biasConviction ?? extra.bias?.conviction ?? null,
    biasComposite: extra.bias?.composite ?? null,
    biasFactors: extra.bias
      ? Object.fromEntries(extra.bias.factors.map((f) => [f.name, f.score]))
      : null,
    signalKind: extra.signalKind ?? null,
    sizeRetained: extra.sizeRetained ?? null,

    ...newsFields(extra.news ?? [], Date.now()),
    // From the live reading rather than the store: the store holds headlines,
    // and neither of these is one.
    shockLevel: state.news.shockLevel,
    chatterVelocity: state.news.chatterVelocity,

    /*
     * The participant read, only when it is confident enough to mean something.
     *
     * A regime called on forty seconds of a quiet tape is a label, not an
     * observation, and recording it as though it were the second is how a
     * grouping fills up with noise that looks like signal. Below the threshold
     * these are null, which the analyser drops from that field's comparison
     * rather than treating as a category of its own.
     */
    participantRegime: p && p.confidence >= 0.3 ? p.regime : null,
    participantConfidence: p?.confidence ?? null,
    replenishSec: p?.replenishSec ?? null,
    refillLevels: p?.refillLevels ?? null,
    flickerPerSec: p?.flickerPerSec ?? null,
    sliceUniformity: p?.sliceUniformity ?? null,
    mechanical: p?.character.mechanical ?? null,

    sweepShare: agg?.sweepShare ?? null,
    largestBurstUsd: agg?.largestBurstUsd ?? null,
    largestBurstLevels: agg?.largestBurstLevels ?? null,
    // Signed from the trade's own point of view, so the field means the same
    // thing on a long and a short: positive is aggression pushing the way the
    // position needs price to go. Left raw and it would average to nothing the
    // moment the sample contains both sides.
    aggressorImbalance: agg ? (long ? agg.aggressorImbalance : -agg.aggressorImbalance) : null,
    takerIntensity: agg?.takerIntensity ?? null,
    aggressorConcentration: agg?.concentration ?? null,
  };
}

/** Reduce the live headlines to three numbers the analyser can group by. */
function newsFields(news: { at: number; impact: string }[], now: number) {
  const SIX_HOURS = 6 * 3_600_000;
  const recent = news.filter((n) => now - n.at <= SIX_HOURS && n.at <= now);
  const weight = (i: string) => (i === "high" ? 3 : i === "medium" ? 2 : i === "low" ? 1 : 0);
  const newest = recent.reduce<number | null>((a, n) => (a === null || n.at > a ? n.at : a), null);
  return {
    newsImpactMax: recent.reduce((a, n) => Math.max(a, weight(n.impact)), 0),
    minutesSinceNews: newest === null ? null : (now - newest) / 60_000,
    newsCount6h: recent.length,
  };
}

/**
 * Tracks how far a position ever ran, in both directions.
 *
 * Kept as a running pair rather than reconstructed from klines afterwards,
 * because a one-minute bar hides an excursion that lasted eight seconds — and
 * on a strategy whose whole thesis is that moves happen in seconds, that is
 * precisely the excursion that matters.
 */
export class Excursion {
  private worst = 0;
  private best = 0;

  constructor(
    private readonly entryPrice: number,
    private readonly long: boolean,
  ) {}

  mark(price: number) {
    if (!(price > 0) || !(this.entryPrice > 0)) return;
    const move = ((price - this.entryPrice) / this.entryPrice) * 100 * (this.long ? 1 : -1);
    if (move < this.worst) this.worst = move;
    if (move > this.best) this.best = move;
  }

  /**
   * The best price the position ever saw, for the trailing stop to follow.
   *
   * The excursion is stored as a percentage because that is what the
   * post-mortem compares across trades, but a trail has to be placed at a
   * price. Recomputing it from the entry keeps one source of truth for "the
   * best this ever was" — a separately-tracked high-water mark would be a
   * second copy able to disagree with the record written at the close.
   */
  peakPrice(): number {
    if (!(this.entryPrice > 0)) return 0;
    const move = this.entryPrice * (this.best / 100);
    return this.long ? this.entryPrice + move : this.entryPrice - move;
  }

  read(targetPrice: number | null) {
    const distance =
      targetPrice !== null && this.entryPrice > 0
        ? (Math.abs(targetPrice - this.entryPrice) / this.entryPrice) * 100
        : 0;
    return {
      maePct: this.worst,
      mfePct: this.best,
      peakProgress: distance > 0 ? this.best / distance : 0,
    };
  }
}
