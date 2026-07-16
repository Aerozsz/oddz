import { NextResponse } from "next/server";
import { listConsensus } from "@/features/consensus/queries";
import { authenticateApi, rateLimitHeaders } from "@/lib/api-auth";
import { clampInt } from "@/lib/utils";

export const runtime = "nodejs";
export const revalidate = 30;

export async function GET(req: Request) {
  const auth = await authenticateApi(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status ?? 429, headers: rateLimitHeaders(auth) },
    );
  }

  const url = new URL(req.url);
  const rawMin = Number(url.searchParams.get("minEdge") ?? "0.02");
  const minEdge = Number.isFinite(rawMin) ? Math.min(Math.max(rawMin, 0), 1) : 0.02;
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);

  const rows = await listConsensus(minEdge, limit);

  return NextResponse.json(
    { count: rows.length, minEdge, events: rows },
    {
      headers: {
        "cache-control": "public, s-maxage=30, stale-while-revalidate=60",
        "access-control-allow-origin": "*",
        ...rateLimitHeaders(auth),
      },
    },
  );
}
