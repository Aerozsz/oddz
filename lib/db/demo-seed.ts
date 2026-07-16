import { db } from "./client";
import { markets, priceSnapshots, venues } from "./schema";
import { reconcileEvents } from "../normalize/matcher";

/**
 * Seed realistic-looking data so the UI is testable without hitting
 * live APIs. Shapes mirror what the real adapters produce. Useful for
 * screenshots, demos, and CI smoke tests.
 */

const DEMO_MARKETS: Array<{
  venue: "polymarket" | "kalshi" | "manifold" | "metaculus";
  externalId: string;
  slug: string;
  question: string;
  category: string;
  yesPrice: number;
  volume: number;
  liquidity?: number;
}> = [
  // Same canonical event across three venues -> divergence row
  {
    venue: "polymarket",
    externalId: "0xabc1",
    slug: "trump-wins-2028",
    question: "Will Donald Trump win the 2028 US presidential election?",
    category: "Politics",
    yesPrice: 0.42,
    volume: 8_400_000,
    liquidity: 1_200_000,
  },
  {
    venue: "kalshi",
    externalId: "PRES28-DJT",
    slug: "pres28-djt",
    question: "Will Donald Trump win the 2028 US presidential election?",
    category: "Politics",
    yesPrice: 0.39,
    volume: 1_800_000,
    liquidity: 410_000,
  },
  {
    venue: "manifold",
    externalId: "mf_trump28",
    slug: "trump-2028",
    question: "Will Donald Trump win the 2028 US presidential election?",
    category: "politics",
    yesPrice: 0.45,
    volume: 12_000,
    liquidity: 4_500,
  },
  // Same canonical event in two venues
  {
    venue: "polymarket",
    externalId: "0xbtc100k",
    slug: "btc-100k-by-eoy",
    question: "Will Bitcoin reach 100k by end of year?",
    category: "Crypto",
    yesPrice: 0.71,
    volume: 5_400_000,
    liquidity: 880_000,
  },
  {
    venue: "kalshi",
    externalId: "BTCEOY-100K",
    slug: "btceoy-100k",
    question: "Will Bitcoin reach 100k by end of year?",
    category: "Crypto",
    yesPrice: 0.66,
    volume: 920_000,
    liquidity: 220_000,
  },
  // Single-venue markets
  {
    venue: "polymarket",
    externalId: "0xfedrate",
    slug: "fed-cuts-rates-may",
    question: "Will the Fed cut rates at the May FOMC meeting?",
    category: "Economics",
    yesPrice: 0.58,
    volume: 2_100_000,
    liquidity: 480_000,
  },
  {
    venue: "manifold",
    externalId: "mf_agi",
    slug: "agi-by-2027",
    question: "Will an AGI be declared by end of 2027?",
    category: "ai",
    yesPrice: 0.18,
    volume: 24_000,
    liquidity: 9_200,
  },
  {
    venue: "metaculus",
    externalId: "11234",
    slug: "uk-recession-2026",
    question: "Will the UK enter a technical recession in 2026?",
    category: "Economy",
    yesPrice: 0.34,
    volume: 850,
  },
  {
    venue: "kalshi",
    externalId: "OSCAR-BESTPIC",
    slug: "oscar-bestpic",
    question: "Best Picture winner at the next Academy Awards",
    category: "Entertainment",
    yesPrice: 0.27,
    volume: 340_000,
    liquidity: 92_000,
  },
];

// Multi-outcome market exercised separately (outcomes.length > 2 paths).
const MULTI_MARKET = {
  venue: "polymarket" as const,
  externalId: "0xgopnominee",
  slug: "gop-nominee-2028",
  question: "Who will be the 2028 Republican presidential nominee?",
  category: "Politics",
  outcomes: ["Vance", "DeSantis", "Haley", "Other"],
  prices: [0.44, 0.21, 0.12, 0.23],
  volume: 3_100_000,
  liquidity: 640_000,
};

export async function demoSeed() {
  await db
    .insert(venues)
    .values([
      { slug: "polymarket", name: "Polymarket", homepage: "https://polymarket.com" },
      { slug: "kalshi", name: "Kalshi", homepage: "https://kalshi.com" },
      { slug: "manifold", name: "Manifold", homepage: "https://manifold.markets" },
      { slug: "metaculus", name: "Metaculus", homepage: "https://www.metaculus.com" },
    ])
    .onConflictDoNothing();

  const now = Date.now();

  await db
    .insert(markets)
    .values([
      ...DEMO_MARKETS.map((m) => ({
        id: `${m.venue}:${m.externalId}`,
        venueSlug: m.venue,
        externalId: m.externalId,
        slug: m.slug,
        question: m.question,
        category: m.category,
        outcomes: ["Yes", "No"],
        sourceUrl: `https://example.com/${m.venue}/${m.slug}`,
        endsAt: new Date(now + 60 * 24 * 60 * 60 * 1000),
        closed: 0,
        lastSeenAt: new Date(now),
      })),
      {
        id: `${MULTI_MARKET.venue}:${MULTI_MARKET.externalId}`,
        venueSlug: MULTI_MARKET.venue,
        externalId: MULTI_MARKET.externalId,
        slug: MULTI_MARKET.slug,
        question: MULTI_MARKET.question,
        category: MULTI_MARKET.category,
        outcomes: MULTI_MARKET.outcomes,
        sourceUrl: `https://example.com/${MULTI_MARKET.venue}/${MULTI_MARKET.slug}`,
        endsAt: new Date(now + 60 * 24 * 60 * 60 * 1000),
        closed: 0,
        lastSeenAt: new Date(now),
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(priceSnapshots)
    .values({
      marketId: `${MULTI_MARKET.venue}:${MULTI_MARKET.externalId}`,
      takenAt: new Date(now),
      prices: MULTI_MARKET.prices,
      volume: MULTI_MARKET.volume,
      liquidity: MULTI_MARKET.liquidity,
      openInterest: null,
    })
    .onConflictDoNothing();

  // 24 hourly snapshots per market with a mild random walk anchored to
  // the listed current price.
  const rows = DEMO_MARKETS.flatMap((m) => {
    let p = m.yesPrice;
    return Array.from({ length: 24 }, (_, i) => {
      p += (Math.random() - 0.5) * 0.02;
      p = Math.max(0.02, Math.min(0.98, p));
      const taken = new Date(now - (23 - i) * 60 * 60 * 1000);
      return {
        marketId: `${m.venue}:${m.externalId}`,
        takenAt: taken,
        prices: i === 23 ? [m.yesPrice, 1 - m.yesPrice] : [p, 1 - p],
        volume: m.volume * (0.95 + Math.random() * 0.1),
        liquidity: m.liquidity ?? null,
        openInterest: null,
      };
    });
  });

  await db.insert(priceSnapshots).values(rows).onConflictDoNothing();

  const reconciled = await reconcileEvents();
  return { markets: DEMO_MARKETS.length, snapshots: rows.length, reconciled };
}

if (require.main === module) {
  demoSeed()
    .then((r) => {
      console.log("demo seeded", r);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
