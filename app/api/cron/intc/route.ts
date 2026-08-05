import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/api-auth";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { runMonitor } from "@/lib/intc/monitor";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * INTC foundry-catalyst monitor tick. Same auth as /api/cron/snapshot: a
 * Bearer CRON_SECRET header (preferred — the GitHub Action sends it) or a
 * `?key=` fallback for manual triggering. Driven every minute by
 * `.github/workflows/intc-monitor.yml`.
 */
function authorized(req: Request): boolean {
  const secret = env().CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (auth && safeEqual(auth, `Bearer ${secret}`)) return true;
  const key = new URL(req.url).searchParams.get("key");
  return key !== null && safeEqual(key, secret);
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runMonitor();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error("cron intc monitor failed", { error: String(err) });
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
