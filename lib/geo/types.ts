/**
 * Geopolitics / "peace ↔ war" monitor. Tracks Trump's market-moving
 * announcements on a single bipolar axis — escalation (war, risk-off) vs
 * de-escalation (peace, risk-on) — because that headline flip-flop has become
 * a repeatable, market-moving pattern, and the edge is in reading the *current
 * tilt* at a glance, not any one post.
 *
 * The shape mirrors lib/intc: a normalized item + a classifier verdict, with
 * sources behind a common interface.
 */

/** The bipolar axis. `neutral` = a Trump geopolitics headline with no clear lean. */
export type Side = "escalation" | "deescalation" | "neutral";

/** How hard the market should care. */
export type Intensity = "low" | "medium" | "high" | "critical";

export const INTENSITY_RANK: Record<Intensity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** The conflict/theater a headline is about. Drives the per-theater tilts. */
export type Theater =
  | "russia-ukraine"
  | "middle-east"
  | "china-taiwan"
  | "north-korea"
  | "trade"
  | "other";

export const THEATER_LABEL: Record<Theater, string> = {
  "russia-ukraine": "Russia–Ukraine",
  "middle-east": "Middle East",
  "china-taiwan": "China–Taiwan",
  "north-korea": "North Korea",
  trade: "Trade / Tariffs",
  other: "Other",
};

/** Which way the market typically reacts. */
export type MarketLean = "risk_on" | "risk_off" | "mixed";

export interface RawGeoItem {
  externalId: string;
  title: string;
  url: string;
  summary?: string;
  publishedAt?: Date;
  sourceLabel: string;
  /** Truth Social is Trump-by-construction — skip the "is this Trump?" gate. */
  assumeActor?: boolean;
}

export interface GeoClassification {
  relevant: boolean;
  side: Side;
  theater: Theater;
  intensity: Intensity;
  marketLean: MarketLean;
  score: number;
  /** Matched signal-group labels, for display. */
  tags: string[];
}

export interface ClassifiedGeoItem extends RawGeoItem, GeoClassification {
  id: string;
  sourceSlug: string;
}

export interface FetchGeoOptions {
  signal?: AbortSignal;
  since?: Date;
}

export interface GeoSource {
  readonly slug: string;
  readonly label: string;
  readonly assumeActor?: boolean;
  fetch(opts?: FetchGeoOptions): Promise<RawGeoItem[]>;
}
