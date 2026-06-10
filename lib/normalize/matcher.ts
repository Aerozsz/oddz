import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db/client";
import { events, markets } from "../db/schema";
import { canonicalKey, isFuzzyMatch } from "./canonical";

/**
 * Cluster recently-seen markets into `event` rows in two passes:
 *
 * 1. Exact: identical canonical key (sorted token bag) joins/creates an
 *    event. Fast path, no false positives.
 * 2. Fuzzy: unlinked markets are compared against open events from OTHER
 *    venues with Jaccard >= 0.75 over token bags, gated on exact numeric
 *    agreement (years, price levels). "Will Trump win 2028?" matches
 *    "Trump wins the 2028 election" but never the 2024 variant.
 *
 * Fuzzy candidates are limited to events whose canonical key shares at
 * least one rare token with the market, so the pass stays roughly linear
 * instead of comparing every market to every event.
 */
export async function reconcileEvents(): Promise<{
  matched: number;
  fuzzyMatched: number;
  created: number;
}> {
  const unlinked = await db
    .select({
      id: markets.id,
      venueSlug: markets.venueSlug,
      question: markets.question,
      category: markets.category,
      endsAt: markets.endsAt,
    })
    .from(markets)
    .where(isNull(markets.eventId));

  let matched = 0;
  let fuzzyMatched = 0;
  let created = 0;

  for (const m of unlinked) {
    const key = canonicalKey(m.question);
    if (!key) continue;

    // Pass 1: exact canonical-key hit.
    const [exact] = await db.select().from(events).where(eq(events.canonicalKey, key)).limit(1);
    if (exact) {
      await link(m.id, exact.id);
      matched++;
      continue;
    }

    // Pass 2: fuzzy against events that already have a market on a
    // DIFFERENT venue (same-venue near-duplicates are usually distinct
    // markets, e.g. weekly series) and share a token with this question.
    const fuzzyEvent = await findFuzzyEvent(m.venueSlug, m.question, key);
    if (fuzzyEvent) {
      await link(m.id, fuzzyEvent);
      fuzzyMatched++;
      continue;
    }

    const id = `evt_${cryptoRandom()}`;
    await db.insert(events).values({
      id,
      canonicalKey: key,
      title: m.question,
      category: m.category ?? null,
      endsAt: m.endsAt ?? null,
    });
    await link(m.id, id);
    created++;
  }

  return { matched, fuzzyMatched, created };
}

async function link(marketId: string, eventId: string) {
  await db
    .update(markets)
    .set({ eventId })
    .where(and(eq(markets.id, marketId), isNull(markets.eventId)));
}

async function findFuzzyEvent(
  venueSlug: string,
  question: string,
  key: string,
): Promise<string | null> {
  // Longest tokens are the rarest; require the candidate's canonical key
  // to contain at least one of the top-3 to keep the candidate set small.
  const anchor = key
    .split("-")
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  if (anchor.length === 0) return null;

  const candidates = await db
    .selectDistinct({
      id: events.id,
      title: events.title,
    })
    .from(events)
    .innerJoin(markets, eq(markets.eventId, events.id))
    .where(
      and(
        ne(markets.venueSlug, venueSlug),
        eq(markets.closed, 0),
        sql`(${sql.join(
          anchor.map((t) => sql`${events.canonicalKey} LIKE ${"%" + t + "%"}`),
          sql` OR `,
        )})`,
      ),
    )
    .limit(50);

  for (const c of candidates) {
    if (isFuzzyMatch(question, c.title)) return c.id;
  }
  return null;
}

function cryptoRandom(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }
  return Math.random().toString(36).slice(2, 18);
}
