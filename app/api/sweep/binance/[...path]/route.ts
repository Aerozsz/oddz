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

/**
 * Allowlisted paths, each with how long the edge may serve a cached copy.
 *
 * Every visitor on the fallback route shares this function's single egress IP,
 * so they also share one Binance rate-limit budget. Caching per path is what
 * keeps that budget survivable: N visitors seeding a book within the same
 * couple of seconds should cost one upstream call, not N. The TTLs are set by
 * how fast each figure actually changes — contract metadata is near-static,
 * a book snapshot is stale almost immediately.
 */
const ALLOWED = new Map<string, number>([
  ["fapi/v1/exchangeInfo", 300],
  ["fapi/v1/depth", 2],
  ["fapi/v1/klines", 15],
  ["fapi/v1/openInterest", 10],
  ["fapi/v1/ticker/24hr", 10],
  ["futures/data/globalLongShortAccountRatio", 120],
  ["futures/data/topLongShortPositionRatio", 120],
  ["futures/data/openInterestHist", 120],
]);

export async function GET(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  const joined = path.join("/");
  const ttl = ALLOWED.get(joined);
  if (ttl === undefined) {
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
    const contentType = res.headers.get("content-type") ?? "application/json";

    // 429, then 418 — an IP ban that lengthens each time it is ignored. Pass
    // the signal through so the browser can back off, and let the edge hold the
    // refusal briefly: while we are throttled, every request the CDN absorbs is
    // one that is not making the ban worse.
    if (res.status === 429 || res.status === 418) {
      const retryAfter = res.headers.get("retry-after") ?? "60";
      return new NextResponse(body, {
        status: res.status,
        headers: {
          "content-type": contentType,
          "retry-after": retryAfter,
          "cache-control": "public, max-age=0, s-maxage=10",
        },
      });
    }

    // Never cache an upstream failure at the TTL meant for good data; a cached
    // 5xx would outlive the incident that caused it.
    if (!res.ok) {
      return new NextResponse(body, {
        status: res.status,
        headers: { "content-type": contentType, "cache-control": "no-store" },
      });
    }

    return new NextResponse(body, {
      status: res.status,
      headers: {
        "content-type": contentType,
        "cache-control": `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}`,
      },
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return NextResponse.json(
      { error: timedOut ? "upstream timed out" : err instanceof Error ? err.message : "upstream failed" },
      { status: timedOut ? 504 : 502, headers: { "cache-control": "no-store" } },
    );
  }
}
