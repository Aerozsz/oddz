import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { alertRules } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/** Tiny personal summary for the nav badge: how many alert rules have fired. */
export async function GET() {
  const jar = await cookies();
  const wid = jar.get("wid")?.value;
  if (!wid) return NextResponse.json({ fired: 0 });

  const [row] = await db
    .select({ fired: sql<number>`count(*)::int` })
    .from(alertRules)
    .where(and(eq(alertRules.watcherId, wid), isNotNull(alertRules.triggeredAt)));

  return NextResponse.json({ fired: row?.fired ?? 0 });
}
