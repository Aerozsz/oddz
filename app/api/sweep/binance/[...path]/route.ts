import { NextResponse } from "next/server";

/**
 * REST fallback for browsers that cannot reach Binance directly.
 *
 * The live path does not go through here — depth diffs, prints, liquidations
 * and mark price all arrive on a WebSocket opened by the browser. This covers
 * only the handful of request/response endpoints (metadata, the book snapshot
 * used to seed the diff feed, klines, open interest) for visitors whose network
 * or region blocks fapi.binance.com.
 *
 * Limited to a fixed set of public read-only paths so it cannot be used as an
 * open proxy. The region matters as much as the allowlist: Binance answers US
 * IPs with 451, so vercel.json pins this route to fra1 — without that it runs
 * in the project default (iad1) and fails in exactly the case it exists for.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "fapi/v1/exchangeInfo",
  "fapi/v1/depth",
  "fapi/v1/klines",
  "fapi/v1/openInterest",
  "fapi/v1/ticker/24hr",
  "futures/data/globalLongShortAccountRatio",
  "futures/data/topLongShortPositionRatio",
  "futures/data/openInterestHist",
]);

export async function GET(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  const joined = path.join("/");
  if (!ALLOWED.has(joined)) {
    return NextResponse.json({ error: "path not allowed" }, { status: 404 });
  }

  const incoming = new URL(req.url);
  const target = new URL(`https://fapi.binance.com/${joined}`);
  for (const [k, v] of incoming.searchParams) target.searchParams.set(k, v);

  try {
    const res = await fetch(target, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
        // Short shared cache: several visitors seeding a book at once should
        // not each cost an upstream call, but the data must stay current.
        "cache-control": "public, max-age=0, s-maxage=2, stale-while-revalidate=5",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "upstream failed" },
      { status: 502 },
    );
  }
}
