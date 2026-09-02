import { trackerConfig } from "@/lib/holders/config";
import { serialize } from "@/lib/holders/serialize";
import { getTracker } from "@/lib/holders/tracker";
import { clampInt } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-sent events: the tracker pushes a new snapshot as blocks land.
 *
 * SSE rather than polling because the refresh cost is per-server, not
 * per-client: one indexer advances the ledger and fans the result out to every
 * connected tab. Ten open tabs cost the same RPC traffic as one.
 *
 * SSE rather than WebSockets because the data only flows one way and SSE
 * reconnects on its own.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const pair = url.searchParams.get("pair");
  const topN = clampInt(url.searchParams.get("top"), 100, 10, 500);
  const intervalMs = clampInt(url.searchParams.get("interval"), 4_000, 1_000, 60_000);

  const cfg = trackerConfig({
    ...(token && /^0x[0-9a-fA-F]{40}$/.test(token) ? { token: token.toLowerCase() } : {}),
    ...(pair && /^0x[0-9a-fA-F]{40}$/.test(pair) ? { pair: pair.toLowerCase() } : {}),
    topN,
  });
  const tracker = getTracker(cfg);

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const tick = async () => {
        if (closed) return;
        try {
          const snapshot = await tracker.refresh(6_000);
          send("snapshot", serialize(snapshot));
        } catch (err) {
          send("error", { message: String(err).slice(0, 300) });
        }
        if (!closed) timer = setTimeout(tick, intervalMs);
      };

      send("open", { ok: true, interval: intervalMs });

      // Abort fires when the tab closes or navigates away.
      req.signal.addEventListener("abort", () => {
        closed = true;
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the runtime; nothing to do.
        }
      });

      await tick();
    },
    cancel() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      // Nginx and friends buffer streamed responses by default, which turns
      // an SSE feed into one long silence followed by a burst.
      "x-accel-buffering": "no",
    },
  });
}
