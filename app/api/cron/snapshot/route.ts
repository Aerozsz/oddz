import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/api-auth";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { pruneSnapshots } from "@/workers/retention";
import { runSnapshot } from "@/workers/snapshot";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Auth: either `Authorization: Bearer <CRON_SECRET>` (Vercel injects
 * this automatically when CRON_SECRET is a dashboard env var) or a
 * `?key=<CRON_SECRET>` query param (for cron paths configured directly
 * in vercel.json, and for manual triggering).
 */
function authorized(req: Request): boolean {
  const secret = env().CRON_SECRET;
  // Preferred: Authorization header (Vercel cron injects it; the GitHub
  // Action sends it) — keeps the secret out of URLs and access logs.
  const auth = req.headers.get("authorization");
  if (auth && safeEqual(auth, `Bearer ${secret}`)) return true;
  // Fallback: ?key= for manual/emergency triggering only. This DOES land in
  // access logs, so avoid it in automation.
  const key = new URL(req.url).searchParams.get("key");
  return key !== null && safeEqual(key, secret);
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await runSnapshot();

    // Daily retention rollup piggybacked on the 04:0x UTC firing so we
    // don't need a second cron entry.
    const now = new Date();
    let pruned: { deleted: number } | undefined;
    if (now.getUTCHours() === 4 && now.getUTCMinutes() < 5) {
      pruned = await pruneSnapshots().catch((err) => {
        log.error("retention prune failed", { error: String(err) });
        return { deleted: 0 };
      });
    }

    return NextResponse.json({ ok: true, ...result, pruned });
  } catch (err) {
    log.error("cron snapshot failed", { error: String(err) });
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
