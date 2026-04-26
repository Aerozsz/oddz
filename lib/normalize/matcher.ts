import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { events, markets } from "../db/schema";
import { canonicalKey } from "./canonical";

/**
 * Cluster recently-seen markets that share a canonical key into the same
 * `event` row. v1 keeps it simple: exact canonical-key collisions across
 * venues create or join an event. Fuzzy matching (Jaccard ≥ 0.6) is a
 * follow-up — runs as a periodic reconciliation job, not on the hot path.
 */
export async function reconcileEvents(): Promise<{ matched: number; created: number }> {
  const unlinked = await db
    .select({
      id: markets.id,
      question: markets.question,
      category: markets.category,
      endsAt: markets.endsAt,
    })
    .from(markets)
    .where(isNull(markets.eventId));

  let matched = 0;
  let created = 0;

  for (const m of unlinked) {
    const key = canonicalKey(m.question);
    if (!key) continue;

    const [existing] = await db.select().from(events).where(eq(events.canonicalKey, key)).limit(1);

    let eventId: string;
    if (existing) {
      eventId = existing.id;
      matched++;
    } else {
      const id = `evt_${cryptoRandom()}`;
      await db.insert(events).values({
        id,
        canonicalKey: key,
        title: m.question,
        category: m.category ?? null,
        endsAt: m.endsAt ?? null,
      });
      eventId = id;
      created++;
    }

    await db.update(markets).set({ eventId }).where(and(eq(markets.id, m.id), isNull(markets.eventId)));
  }

  return { matched, created };
}

function cryptoRandom(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }
  return Math.random().toString(36).slice(2, 18);
}
