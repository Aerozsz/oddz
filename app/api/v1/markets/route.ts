import { NextResponse } from "next/server";
import { listMarkets } from "@/features/markets/queries";
import { authenticateApi, rateLimitHeaders } from "@/lib/api-auth";
import type { VenueSlug } from "@/lib/sources";
import { clampInt } from "@/lib/utils";

export const runtime = "nodejs";
export const revalidate = 30;

const VENUES: VenueSlug[] = ["polymarket", "kalshi", "manifold", "metaculus"];

function isVenue(s: string | null): s is VenueSlug {
  return !!s && (VENUES as string[]).includes(s);
}

export async function GET(req: Request) {
  const auth = await authenticateApi(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status ?? 429, headers: rateLimitHeaders(auth) },
    );
  }

  const url = new URL(req.url);
  const venueParam = url.searchParams.get("venue");
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 500);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const q = url.searchParams.get("q") ?? undefined;

  const rows = await listMarkets({
    q,
    venue: isVenue(venueParam) ? venueParam : undefined,
    limit,
    offset,
  });

  return NextResponse.json(
    { count: rows.length, limit, offset, markets: rows },
    {
      headers: {
        "cache-control": "public, s-maxage=30, stale-while-revalidate=60",
        "access-control-allow-origin": "*",
        ...rateLimitHeaders(auth),
      },
    },
  );
}
