import { NextResponse } from "next/server";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * TEMPORARY diagnostic: fetch the real Polymarket Gamma API server-side
 * (Vercel can reach it; the dev sandbox cannot) and surface the exact
 * URL-relevant fields so we can build the correct public market URL.
 * Guarded by the cron secret. Delete once the URL construction is fixed.
 */
export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key");
  if (key !== env().CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const out: Record<string, unknown> = {};

  try {
    const mRes = await fetch(
      "https://gamma-api.polymarket.com/markets?closed=false&limit=3&order=volume&ascending=false",
      { headers: { accept: "application/json" } },
    );
    const markets = (await mRes.json()) as Array<Record<string, unknown>>;
    out.markets = markets.map((m) => ({
      question: m.question,
      slug: m.slug,
      // What keys exist? Which relate to events?
      topLevelKeys: Object.keys(m),
      events: Array.isArray(m.events)
        ? (m.events as Array<Record<string, unknown>>).map((e) => ({ slug: e.slug, ticker: e.ticker, title: e.title }))
        : m.events ?? null,
    }));
  } catch (e) {
    out.marketsError = String(e);
  }

  try {
    const eRes = await fetch(
      "https://gamma-api.polymarket.com/events?closed=false&limit=2&order=volume24hr&ascending=false",
      { headers: { accept: "application/json" } },
    );
    const events = (await eRes.json()) as Array<Record<string, unknown>>;
    out.events = events.map((e) => ({
      slug: e.slug,
      title: e.title,
      marketSlugs: Array.isArray(e.markets)
        ? (e.markets as Array<Record<string, unknown>>).slice(0, 3).map((m) => m.slug)
        : null,
    }));
  } catch (e) {
    out.eventsError = String(e);
  }

  return NextResponse.json(out, { headers: { "cache-control": "no-store" } });
}
