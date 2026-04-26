/**
 * The single normalized shape every prediction-market venue must produce.
 * Adapters live behind this interface so app code never knows or cares
 * which venue served the data.
 */

export type VenueSlug = "polymarket" | "kalshi" | "manifold" | "metaculus";

export interface NormalizedMarket {
  venue: VenueSlug;
  externalId: string;
  slug: string;
  question: string;
  description?: string;
  category?: string;
  outcomes: string[];
  prices: number[];
  volume?: number;
  liquidity?: number;
  openInterest?: number;
  endsAt?: Date;
  closed: boolean;
  sourceUrl: string;
  fetchedAt: Date;
}

export interface FetchOptions {
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface FetchResult {
  markets: NormalizedMarket[];
  nextCursor?: string;
}

export interface MarketSource {
  readonly venue: VenueSlug;
  fetchPage(opts?: FetchOptions): Promise<FetchResult>;
}
