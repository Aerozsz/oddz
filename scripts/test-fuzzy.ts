import { db } from "../lib/db/client";
import { markets, priceSnapshots } from "../lib/db/schema";
import { reconcileEvents } from "../lib/normalize/matcher";

async function main() {
  // Paraphrased versions of existing demo questions, on venues that
  // don't already host them. Different word tokens, same numbers.
  const now = new Date();
  const fuzz = [
    {
      id: "metaculus:99001",
      venueSlug: "metaculus",
      externalId: "99001",
      slug: "trump-2028-win",
      question: "Donald Trump wins the 2028 US presidential election",
      category: "Politics",
      outcomes: ["Yes", "No"],
      sourceUrl: "https://example.com/metaculus/trump-2028-win",
      closed: 0,
      lastSeenAt: now,
    },
    {
      id: "manifold:mf_btc100",
      venueSlug: "manifold",
      externalId: "mf_btc100",
      slug: "bitcoin-100k-eoy",
      question: "Bitcoin reaches 100k by end of the year",
      category: "crypto",
      outcomes: ["Yes", "No"],
      sourceUrl: "https://example.com/manifold/bitcoin-100k-eoy",
      closed: 0,
      lastSeenAt: now,
    },
    {
      // Numeric guard: same words as Trump 2028 but a different year —
      // must NOT fuzzy-match.
      id: "manifold:mf_trump2032",
      venueSlug: "manifold",
      externalId: "mf_trump2032",
      slug: "trump-2032",
      question: "Will Donald Trump win the 2032 US presidential election?",
      category: "politics",
      outcomes: ["Yes", "No"],
      sourceUrl: "https://example.com/manifold/trump-2032",
      closed: 0,
      lastSeenAt: now,
    },
  ];
  await db.insert(markets).values(fuzz).onConflictDoNothing();
  await db
    .insert(priceSnapshots)
    .values(
      fuzz.map((f) => ({
        marketId: f.id,
        takenAt: now,
        prices: [0.4, 0.6],
        volume: 1000,
        liquidity: null,
        openInterest: null,
      })),
    )
    .onConflictDoNothing();

  const r = await reconcileEvents();
  console.log("reconcile result:", r);

  const rows = await db.query.markets.findMany({
    columns: { id: true, eventId: true, question: true },
  });
  for (const m of rows) console.log(m.eventId, "<-", m.id, "|", m.question.slice(0, 60));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
