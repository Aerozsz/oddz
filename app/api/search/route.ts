import { NextResponse } from "next/server";
import { listMarkets } from "@/features/markets/queries";
import { ipRateLimit } from "@/lib/api-auth";
import { clampInt } from "@/lib/utils";

export const runtime = "nodejs";
export const revalidate = 15;

/**
 * Internal typeahead search — not the public rate-limited v1 API, so the
 * command palette can query on every keystroke. Returns just enough to
 * render a result row.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ results: [] });

  // Unauthenticated + hits the DB per call, so cap per-IP to stop hammering
  // (Neon compute is metered — this is a cost/availability guard).
  const rl = await ipRateLimit(req, "search", 200);
  if (!rl.ok) {
    return NextResponse.json({ results: [], error: "rate limited" }, { status: 429 });
  }

  const limit = clampInt(url.searchParams.get("limit"), 8, 1, 20);
  const rows = await listMarkets({ q, sort: "volume", limit });

  const results = rows.map((r) => ({
    id: r.id,
    question: r.question,
    venue: r.venue,
    venueName: r.venueName,
    category: r.category,
    yes: r.prices?.[0] ?? null,
    volume: r.volume,
  }));

  return NextResponse.json(
    { results },
    { headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=30" } },
  );
}
