import { db } from "./client";
import { venues } from "./schema";

const SEED_VENUES = [
  {
    slug: "polymarket",
    name: "Polymarket",
    homepage: "https://polymarket.com",
    affiliateUrlTemplate: null,
  },
  {
    slug: "kalshi",
    name: "Kalshi",
    homepage: "https://kalshi.com",
    affiliateUrlTemplate: null,
  },
  {
    slug: "manifold",
    name: "Manifold",
    homepage: "https://manifold.markets",
    affiliateUrlTemplate: null,
  },
  {
    slug: "metaculus",
    name: "Metaculus",
    homepage: "https://www.metaculus.com",
    affiliateUrlTemplate: null,
  },
];

export async function seedVenues() {
  await db.insert(venues).values(SEED_VENUES).onConflictDoNothing();
}

if (require.main === module) {
  seedVenues()
    .then(() => {
      console.log("seeded venues");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
