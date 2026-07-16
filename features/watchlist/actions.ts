"use server";

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { watchlistItems } from "@/lib/db/schema";

const WID_COOKIE = "wid";
const MAX_ITEMS = 100;

async function ensureWid(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(WID_COOKIE)?.value;
  if (existing) return existing;
  const wid = randomUUID();
  jar.set(WID_COOKIE, wid, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  return wid;
}

export interface ToggleResult {
  watched: boolean;
  error?: string;
}

export async function toggleWatch(marketId: string): Promise<ToggleResult> {
  const wid = await ensureWid();

  const [existing] = await db
    .select({ marketId: watchlistItems.marketId })
    .from(watchlistItems)
    .where(and(eq(watchlistItems.watcherId, wid), eq(watchlistItems.marketId, marketId)))
    .limit(1);

  if (existing) {
    await db
      .delete(watchlistItems)
      .where(and(eq(watchlistItems.watcherId, wid), eq(watchlistItems.marketId, marketId)));
    revalidatePath("/watchlist");
    return { watched: false };
  }

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(watchlistItems)
    .where(eq(watchlistItems.watcherId, wid));
  if (n >= MAX_ITEMS) {
    return { watched: false, error: `Watchlist is capped at ${MAX_ITEMS} markets.` };
  }

  await db.insert(watchlistItems).values({ watcherId: wid, marketId }).onConflictDoNothing();
  revalidatePath("/watchlist");
  return { watched: true };
}
