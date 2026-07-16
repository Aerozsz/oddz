import { NextResponse } from "next/server";
import { listMovers } from "@/features/markets/queries";
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
  const hours = clampInt(url.searchParams.get("hours"), 24, 1, 24 * 30);
  const limit = clampInt(url.searchParams.get("limit"), 30, 1, 200);

  const movers = await listMovers(hours, limit);

  return NextResponse.json(
    { count: movers.length, hours, movers },
    {
      headers: {
        "cache-control": "public, s-maxage=30, stale-while-revalidate=60",
        "access-control-allow-origin": "*",
        ...rateLimitHeaders(auth),
      },
    },
  );
}
