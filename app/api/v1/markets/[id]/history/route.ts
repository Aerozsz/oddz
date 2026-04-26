import { NextResponse } from "next/server";
import { getMarket, getMarketHistory } from "@/features/markets/queries";

export const runtime = "nodejs";
export const revalidate = 30;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const hours = Math.min(Math.max(Number(url.searchParams.get("hours") ?? "168"), 1), 24 * 90);

  const decoded = decodeURIComponent(id);
  const market = await getMarket(decoded);
  if (!market) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const rows = await getMarketHistory(decoded, hours);
  const points = rows.map((r) => ({
    t: r.takenAt.toISOString(),
    p: r.prices,
    v: r.volume,
  }));

  return NextResponse.json(
    {
      market: {
        id: market.id,
        venue: market.venue,
        slug: market.slug,
        question: market.question,
        outcomes: market.outcomes,
      },
      hours,
      count: points.length,
      points,
    },
    {
      headers: {
        "cache-control": "public, s-maxage=30, stale-while-revalidate=60",
        "access-control-allow-origin": "*",
      },
    },
  );
}
