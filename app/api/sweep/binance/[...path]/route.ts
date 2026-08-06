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
interface Allowed {
  /** Seconds the edge may serve a cached copy. */
  ttl: number;
  /** Query parameters forwarded upstream. Everything else is dropped. */
  params: string[];
}

const ALLOWED = new Map<string, Allowed>([
  ["fapi/v1/exchangeInfo", { ttl: 300, params: [] }],
  ["fapi/v1/depth", { ttl: 2, params: ["symbol", "limit"] }],
  ["fapi/v1/klines", { ttl: 15, params: ["symbol", "interval", "limit"] }],
  ["fapi/v1/openInterest", { ttl: 10, params: ["symbol"] }],
  ["fapi/v1/ticker/24hr", { ttl: 10, params: ["symbol"] }],
  // Settled rates only — the *next* rate arrives on the mark-price stream, so
  // this is history and can be cached hard.
  ["fapi/v1/fundingRate", { ttl: 600, params: ["symbol", "limit"] }],
  ["futures/data/globalLongShortAccountRatio", { ttl: 120, params: ["symbol", "period", "limit"] }],
  ["futures/data/topLongShortPositionRatio", { ttl: 120, params: ["symbol", "period", "limit"] }],
  ["futures/data/openInterestHist", { ttl: 120, params: ["symbol", "period", "limit"] }],
]);

/** Upper bounds for numeric parameters, so nobody can inflate request weight. */
const MAX_LIMIT = 1000;

/**
 * Only known parameters are forwarded, and only within known bounds.
 *
 * Forwarding the query string verbatim made this trivially abusable in two
 * ways. Any unrecognised parameter — `?_=1`, `?_=2` — is a distinct edge cache
 * key, so an attacker could bypass the cache entirely and turn every request
 * into an upstream call against the one IP every fallback visitor shares, until
 * Binance bans it. And `limit` drives request weight, so an inflated value
 * spends the shared budget faster than the cache can defend it.
 *
 * Dropping unknown parameters also keeps the cache dense: one canonical URL per
 * distinct question rather than one per caller.
 */
function sanitize(allowed: Allowed, incoming: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const name of allowed.params) {
    const raw = incoming.get(name);
    if (raw === null) continue;
    if (name === "limit") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) continue;
      out.set(name, String(Math.min(n, MAX_LIMIT)));
    } else {
      // Binance symbols, intervals and periods are all short alphanumerics.
      if (!/^[A-Za-z0-9_]{1,24}$/.test(raw)) continue;
      out.set(name, raw);
    }
  }
  return out;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  const joined = path.join("/");
  const allowed = ALLOWED.get(joined);
  if (allowed === undefined) {
    return NextResponse.json({ error: "path not allowed" }, { status: 404 });
  }
  const ttl = allowed.ttl;

  const incoming = new URL(req.url);
  const target = new URL(`https://fapi.binance.com/${joined}`);
  // Sorted, so that two callers asking the same question produce the same URL
  // and therefore the same cache entry.
  const clean = sanitize(allowed, incoming.searchParams);
  for (const [k, v] of [...clean].sort(([a], [b]) => a.localeCompare(b))) {
    target.searchParams.set(k, v);
  }

  try {
    // Cached on the *upstream* call, not just at the edge, and this is the part
    // that actually protects the shared IP. Vercel's CDN keys on the full
    // request URL, so ?_=1 and ?_=2 are separate edge entries and both reach
    // this function however carefully the query string is canonicalised below.
    // Caching here instead means every one of those invocations collapses onto
    // one cached upstream response per canonical URL per TTL, so Binance sees a
    // fixed request rate no matter how many distinct URLs are thrown at us.
    // Capped: this window applies to whatever came back, including a failure,
    // so a five-minute metadata TTL must not be able to pin a bad response for
    // five minutes. A minute still collapses abusive traffic by orders of
    // magnitude, and the edge keeps serving the longer TTL to honest callers.
    const upstreamTtl = Math.min(ttl, 60);
    const res = await fetch(target, {
      headers: { accept: "application/json" },
      next: { revalidate: upstreamTtl },
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
