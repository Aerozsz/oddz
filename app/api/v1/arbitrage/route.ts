import { NextResponse } from "next/server";
import { listArbitrage } from "@/features/arbitrage/queries";
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
  const minEdge = Math.min(Math.max(Number(url.searchParams.get("minEdge") ?? "0.005"), 0), 1);
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);

  const arbs = await listArbitrage(Number.isFinite(minEdge) ? minEdge : 0.005, limit);

  return NextResponse.json(
    { count: arbs.length, minEdge, arbs },
    {
      headers: {
        "cache-control": "public, s-maxage=30, stale-while-revalidate=60",
        "access-control-allow-origin": "*",
        ...rateLimitHeaders(auth),
      },
    },
  );
}
