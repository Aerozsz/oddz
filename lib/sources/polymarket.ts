import { z } from "zod";
import { fetchJson } from "../http";
import type { FetchOptions, FetchResult, MarketSource, NormalizedMarket } from "./types";

const BASE = "https://gamma-api.polymarket.com";

const PolymarketMarket = z.object({
  id: z.union([z.string(), z.number()]),
  conditionId: z.string().optional(),
  question: z.string(),
  description: z.string().optional(),
  slug: z.string(),
  category: z.string().optional(),
  active: z.boolean().optional(),
  closed: z.boolean().optional(),
  endDate: z.string().optional(),
  outcomes: z.union([z.string(), z.array(z.string())]).optional(),
  outcomePrices: z.union([z.string(), z.array(z.string())]).optional(),
  volume: z.union([z.string(), z.number()]).optional(),
  liquidity: z.union([z.string(), z.number()]).optional(),
});

const PolymarketResponse = z.array(PolymarketMarket);

function parseStringOrArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toNumber(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : undefined;
}

export class PolymarketSource implements MarketSource {
  readonly venue = "polymarket" as const;

  async fetchPage(opts: FetchOptions = {}): Promise<FetchResult> {
    const limit = Math.min(opts.limit ?? 100, 500);
    const offset = opts.cursor ? Number(opts.cursor) : 0;
    const params = new URLSearchParams({
      active: "true",
      closed: "false",
      limit: String(limit),
      offset: String(offset),
      order: "volume",
      ascending: "false",
    });

    const url = `${BASE}/markets?${params.toString()}`;
    const data = await fetchJson(url, {
      schema: PolymarketResponse,
      source: "polymarket",
      signal: opts.signal,
    });

    const fetchedAt = new Date();
    const markets: NormalizedMarket[] = data.map((m) => {
      const outcomes = parseStringOrArray(m.outcomes);
      const priceStrings = parseStringOrArray(m.outcomePrices);
      const prices = priceStrings.map((s) => Number(s)).filter((n) => Number.isFinite(n));
      return {
        venue: "polymarket",
        externalId: m.conditionId ?? String(m.id),
        slug: m.slug,
        question: m.question,
        description: m.description,
        category: m.category,
        outcomes: outcomes.length ? outcomes : prices.map((_, i) => `Outcome ${i + 1}`),
        prices,
        volume: toNumber(m.volume),
        liquidity: toNumber(m.liquidity),
        endsAt: m.endDate ? new Date(m.endDate) : undefined,
        closed: m.closed === true,
        sourceUrl: `https://polymarket.com/event/${m.slug}`,
        fetchedAt,
      };
    });

    return {
      markets,
      nextCursor: markets.length === limit ? String(offset + limit) : undefined,
    };
  }
}
