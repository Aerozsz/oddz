"use server";

import { and, eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { alertRules } from "@/lib/db/schema";

const MAX_RULES = 20;

async function requireWid(): Promise<string | null> {
  const jar = await cookies();
  return jar.get("wid")?.value ?? null;
}

export interface AlertActionResult {
  ok: boolean;
  error?: string;
}

export async function createAlert(
  marketId: string,
  kind: "price_above" | "price_below" | "move_24h",
  thresholdPct: number,
): Promise<AlertActionResult> {
  const wid = await requireWid();
  if (!wid) return { ok: false, error: "Star a market first to create alerts." };

  if (!["price_above", "price_below", "move_24h"].includes(kind)) {
    return { ok: false, error: "Unknown rule type." };
  }
  const pct = Number(thresholdPct);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
    return { ok: false, error: "Threshold must be between 0 and 100." };
  }

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(alertRules)
    .where(eq(alertRules.watcherId, wid));
  if (n >= MAX_RULES) return { ok: false, error: `Capped at ${MAX_RULES} rules.` };

  await db.insert(alertRules).values({
    watcherId: wid,
    marketId,
    kind,
    threshold: pct / 100,
  });
  revalidatePath("/watchlist");
  return { ok: true };
}

export async function deleteAlert(id: number): Promise<AlertActionResult> {
  const wid = await requireWid();
  if (!wid) return { ok: false };
  await db
    .delete(alertRules)
    .where(and(eq(alertRules.id, id), eq(alertRules.watcherId, wid)));
  revalidatePath("/watchlist");
  return { ok: true };
}

/** Re-arm a triggered rule so it can fire again. */
export async function resetAlert(id: number): Promise<AlertActionResult> {
  const wid = await requireWid();
  if (!wid) return { ok: false };
  await db
    .update(alertRules)
    .set({ triggeredAt: null, triggeredValue: null })
    .where(and(eq(alertRules.id, id), eq(alertRules.watcherId, wid)));
  revalidatePath("/watchlist");
  return { ok: true };
}
