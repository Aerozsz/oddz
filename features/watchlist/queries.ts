import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/lib/db/client";
import { watchlistItems } from "@/lib/db/schema";

export async function getWid(): Promise<string | null> {
  const jar = await cookies();
  return jar.get("wid")?.value ?? null;
}

export async function getWatchedIds(wid: string | null): Promise<Set<string>> {
  if (!wid) return new Set();
  const rows = await db
    .select({ marketId: watchlistItems.marketId })
    .from(watchlistItems)
    .where(eq(watchlistItems.watcherId, wid));
  return new Set(rows.map((r) => r.marketId));
}
