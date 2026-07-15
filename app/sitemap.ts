import type { MetadataRoute } from "next";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { markets } from "@/lib/db/schema";
import { env } from "@/lib/env";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = env().NEXT_PUBLIC_SITE_URL;

  const staticPages: MetadataRoute.Sitemap = [
    { url: base, changeFrequency: "hourly", priority: 1 },
    { url: `${base}/markets`, changeFrequency: "always", priority: 0.9 },
    { url: `${base}/divergence`, changeFrequency: "always", priority: 0.9 },
  ];

  const rows = await db
    .select({ id: markets.id, lastSeenAt: markets.lastSeenAt })
    .from(markets)
    .where(eq(markets.closed, 0))
    .orderBy(desc(markets.lastSeenAt))
    .limit(1000)
    .catch(() => []);

  const marketPages: MetadataRoute.Sitemap = rows.map((m) => ({
    url: `${base}/markets/${encodeURIComponent(m.id)}`,
    lastModified: m.lastSeenAt,
    changeFrequency: "hourly",
    priority: 0.7,
  }));

  return [...staticPages, ...marketPages];
}
