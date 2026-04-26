import { KalshiSource } from "./kalshi";
import { ManifoldSource } from "./manifold";
import { MetaculusSource } from "./metaculus";
import { PolymarketSource } from "./polymarket";
import type { MarketSource, VenueSlug } from "./types";

export const sources: Record<VenueSlug, MarketSource> = {
  polymarket: new PolymarketSource(),
  kalshi: new KalshiSource(),
  manifold: new ManifoldSource(),
  metaculus: new MetaculusSource(),
};

export const allSources = Object.values(sources);

export type { MarketSource, NormalizedMarket, VenueSlug } from "./types";
