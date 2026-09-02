import { trackerConfig } from "@/lib/holders/config";
import { serialize } from "@/lib/holders/serialize";
import { getTracker } from "@/lib/holders/tracker";
import { clampInt } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One holder snapshot.
 *
 * Runs server-side for two reasons that are not stylistic: the RPC endpoint
 * and any keys stay off the client, and neither DexScreener nor GeckoTerminal
 * sends permissive CORS headers, so a browser cannot call them directly. This
 * route is the thing that makes the client-side tracker possible at all.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const pair = url.searchParams.get("pair");
  const topN = clampInt(url.searchParams.get("top"), 100, 10, 500);

  const cfg = trackerConfig({
    ...(token && /^0x[0-9a-fA-F]{40}$/.test(token) ? { token: token.toLowerCase() } : {}),
    ...(pair && /^0x[0-9a-fA-F]{40}$/.test(pair) ? { pair: pair.toLowerCase() } : {}),
    topN,
  });

  const tracker = getTracker(cfg);
  const snapshot = await tracker.refresh(8_000);
  const wire = serialize(snapshot);

  return Response.json(wire, {
    headers: {
      // The data is live; a cached holder table is a wrong holder table.
      "cache-control": "no-store, max-age=0",
    },
  });
}
