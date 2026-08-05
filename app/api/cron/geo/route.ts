import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/api-auth";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { runGeoMonitor } from "@/lib/geo/monitor";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Geopolitics / peace↔war monitor tick. Same Bearer CRON_SECRET auth as the
 * other crons; driven every minute by .github/workflows/geo-monitor.yml.
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
    const result = await runGeoMonitor();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error("cron geo monitor failed", { error: String(err) });
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
