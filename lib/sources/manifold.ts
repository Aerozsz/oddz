import { z } from "zod";
import { env } from "../env";
import { fetchJson } from "../http";
import type { FetchOptions, FetchResult, MarketSource, NormalizedMarket } from "./types";

const BASE = "https://api.manifold.markets/v0";

const ManifoldMarket = z.object({
  id: z.string(),
  slug: z.string(),
  question: z.string(),
  url: z.string().url(),
  outcomeType: z.string(),
  probability: z.number().optional(),
  pool: z.record(z.string(), z.number()).optional(),
  totalLiquidity: z.number().optional(),
  volume: z.number().optional(),
  volume24Hours: z.number().optional(),
  isResolved: z.boolean(),
  closeTime: z.number().optional(),
  groupSlugs: z.array(z.string()).optional(),
  textDescription: z.string().optional(),
});

const ManifoldResponse = z.array(ManifoldMarket);

export class ManifoldSource implements MarketSource {
  readonly venue = "manifold" as const;

  async fetchPage(opts: FetchOptions = {}): Promise<FetchResult> {
    const limit = Math.min(opts.limit ?? 500, 1000);
    const params = new URLSearchParams({ limit: String(limit), sort: "liquidity" });
    if (opts.cursor) params.set("before", opts.cursor);

    const apiKey = env().MANIFOLD_API_KEY;
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Key ${apiKey}`;

    const url = `${BASE}/markets?${params.toString()}`;
    const data = await fetchJson(url, {
      schema: ManifoldResponse,
      source: "manifold",
      headers,
      signal: opts.signal,
    });

    const fetchedAt = new Date();
    const markets: NormalizedMarket[] = data
      .filter((m) => m.outcomeType === "BINARY" && m.probability !== undefined)
      .map((m) => {
        const yes = m.probability ?? 0;
        return {
          venue: "manifold",
          externalId: m.id,
          slug: m.slug,
          question: m.question,
          description: m.textDescription,
          category: m.groupSlugs?.[0],
          outcomes: ["Yes", "No"],
          prices: [yes, 1 - yes],
          volume: m.volume24Hours ?? m.volume,
          liquidity: m.totalLiquidity,
          endsAt: m.closeTime ? new Date(m.closeTime) : undefined,
          closed: m.isResolved,
          sourceUrl: m.url,
          fetchedAt,
        };
      });

    const last = data.at(-1);
    return {
      markets,
      nextCursor: data.length === limit && last ? last.id : undefined,
    };
  }
}
