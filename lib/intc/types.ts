/**
 * INTC foundry monitor — the normalized shape every news source produces,
 * plus the classifier's verdict. Adapters live behind `NewsSource` so the
 * monitor never knows or cares whether an item came from a wire, an RSS
 * feed, or an SEC filing.
 *
 * Why this module exists (the thesis, in code):
 *   Intel's stock no longer trades off quarterly results — it trades off the
 *   foundry (IFS). The rare thing that reprices INTC *up* is a named external
 *   customer committing to volume on a leading node (18A/14A) or a strategic
 *   anchor (government stake, capacity reservation). The frequent things that
 *   knock it *down* are execution slips, capex blowouts, foundry P&L, yield
 *   problems, and separation/divestiture headlines. This monitor watches for
 *   exactly those catalysts and pushes them the moment they land.
 */

export type Severity = "low" | "medium" | "high" | "critical";

/** Which way a catalyst leans for the equity, per the foundry thesis. */
export type Direction = "bullish" | "bearish" | "neutral";

export const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** A raw news/filing item as pulled from a source, before classification. */
export interface RawNewsItem {
  /** Stable per-source identifier (guid, filing accession, or the URL). */
  externalId: string;
  title: string;
  url: string;
  summary?: string;
  publishedAt?: Date;
  /** Human label of the origin, e.g. "Google News", "SEC EDGAR". */
  sourceLabel: string;
  /**
   * SEC filings and Intel's own newsroom are Intel-by-construction, so the
   * classifier can skip the "is this even about Intel?" gate for them.
   */
  assumeEntity?: boolean;
  /**
   * Source-level override: surface this item even if the headline text
   * doesn't trip the foundry gate. Used for Intel 8-K filings — a material
   * agreement in this era is worth a look on its own, and the foundry angle
   * often lives in the filing body, not the one-line metadata.
   */
  forceRelevant?: boolean;
  /** Minimum severity the source vouches for, regardless of keyword score. */
  floorSeverity?: Severity;
}

/** The classifier's verdict for one item. */
export interface Classification {
  relevant: boolean;
  score: number;
  severity: Severity;
  direction: Direction;
  /** Signal-group labels that fired, for display and debugging. */
  tags: string[];
}

/** A fully classified item, ready to persist and (maybe) notify. */
export interface ClassifiedNewsItem extends RawNewsItem, Classification {
  /** Deterministic hash used as the dedupe primary key. */
  id: string;
  sourceSlug: string;
}

export interface FetchNewsOptions {
  signal?: AbortSignal;
  /** Only return items published at or after this instant, when known. */
  since?: Date;
}

export interface NewsSource {
  readonly slug: string;
  readonly label: string;
  /** Set when every item from this source is Intel-by-construction. */
  readonly assumeEntity?: boolean;
  fetch(opts?: FetchNewsOptions): Promise<RawNewsItem[]>;
}
