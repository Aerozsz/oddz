import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "./db/client";
import { apiKeys, apiUsage } from "./db/schema";

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
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    identifier = `ip:${ip}`;
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
