import { createHash, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "./db/client";
import { apiKeys, apiUsage } from "./db/schema";

/**
 * Constant-time secret comparison. Both sides are SHA-256'd first so the
 * lengths are always equal (timingSafeEqual throws otherwise) and neither
 * the length nor the content of the secret leaks through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Trustworthy client IP on Vercel. `x-real-ip` is set by the platform edge
 * and cannot be forged by the client; the leftmost `x-forwarded-for` value
 * IS client-controllable (Vercel only appends), so it must not be trusted
 * for rate-limit identity — spoofing it would mint unlimited fresh buckets.
 */
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  return xff || "unknown";
}

/**
 * Lightweight fixed-window IP rate limit for unauthenticated internal
 * endpoints (e.g. typeahead search) — caps abuse / DB-cost exhaustion
 * without the full API-key machinery. Namespaced so it can't collide with
 * the public API's per-IP buckets.
 */
export async function ipRateLimit(
  req: Request,
  namespace: string,
  limit: number,
): Promise<{ ok: boolean; remaining: number }> {
  const identifier = `${namespace}:ip:${clientIp(req)}`;
  const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const [row] = await db
    .insert(apiUsage)
    .values({ identifier, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [apiUsage.identifier, apiUsage.windowStart],
      set: { count: sql`${apiUsage.count} + 1` },
    })
    .returning({ count: apiUsage.count });
  const used = row?.count ?? 1;
  return { ok: used <= limit, remaining: Math.max(0, limit - used) };
}

const LIMITS: Record<string, number> = {
  anonymous: 30, // per hour, by IP
  free: 60,
  pro: 3600,
};

export interface ApiAuthResult {
  ok: boolean;
  tier: string;
  limit: number;
  remaining: number;
  status?: number;
  error?: string;
}

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Authenticate + fixed-window rate limit (per hour, stored in Postgres —
 * no Redis dependency at this scale). Anonymous callers are limited by
 * IP; keyed callers by tier.
 */
export async function authenticateApi(req: Request): Promise<ApiAuthResult> {
  const auth = req.headers.get("authorization");
  let identifier: string;
  let tier = "anonymous";

  if (auth?.startsWith("Bearer ")) {
    const keyHash = hashKey(auth.slice(7).trim());
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
    if (!key) {
      return { ok: false, tier: "invalid", limit: 0, remaining: 0, status: 401, error: "invalid API key" };
    }
    identifier = keyHash;
    tier = key.tier;
    // Fire-and-forget freshness stamp; a failed update must not break reads.
    db.update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.keyHash, keyHash))
      .catch(() => {});
  } else {
    identifier = `ip:${clientIp(req)}`;
  }

  const limit = LIMITS[tier] ?? LIMITS.anonymous;
  const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);

  const [row] = await db
    .insert(apiUsage)
    .values({ identifier, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [apiUsage.identifier, apiUsage.windowStart],
      set: { count: sql`${apiUsage.count} + 1` },
    })
    .returning({ count: apiUsage.count });

  const used = row?.count ?? 1;
  if (used > limit) {
    return { ok: false, tier, limit, remaining: 0, status: 429, error: "rate limit exceeded" };
  }
  return { ok: true, tier, limit, remaining: limit - used };
}

export function rateLimitHeaders(a: ApiAuthResult): Record<string, string> {
  return {
    "x-ratelimit-limit": String(a.limit),
    "x-ratelimit-remaining": String(Math.max(0, a.remaining)),
  };
}
