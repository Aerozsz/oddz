import { NextResponse } from "next/server";
import { newsFor } from "@/lib/sweep/metrics/news-store";
import { SYMBOL } from "@/lib/sweep/config";

/**
 * The news feed the monitor reads.
 *
 * Server-side because the store is a file on the machine the agent writes to,
 * and the monitor is a browser page. Read-only on purpose: recording goes
 * through the MCP interface, which is authenticated by being a local process,
 * and an HTTP write path here would be an unauthenticated way to put arbitrary
 * text in front of someone making trading decisions.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") ?? SYMBOL;
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 25));
  try {
    return NextResponse.json({ symbol, items: newsFor(symbol, limit) });
  } catch {
    // The page must render without this. An empty feed is a fine degradation;
    // a 500 that takes the monitor down over decoration is not.
    return NextResponse.json({ symbol, items: [] });
  }
}
