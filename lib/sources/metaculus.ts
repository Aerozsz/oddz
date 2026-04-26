import { z } from "zod";
import { env } from "../env";
import { fetchJson } from "../http";
import type { FetchOptions, FetchResult, MarketSource, NormalizedMarket } from "./types";

const BASE = "https://www.metaculus.com/api2";

const MetaculusQuestion = z.object({
  id: z.number(),
  title: z.string(),
  slug: z.string().optional(),
  page_url: z.string().optional(),
  url: z.string().optional(),
  type: z.string().optional(),
  possibilities: z.unknown().optional(),
  community_prediction: z
    .object({
      full: z.object({ q1: z.number().optional(), q2: z.number().optional(), q3: z.number().optional() }).optional(),
    })
    .nullish(),
  number_of_predictions: z.number().optional(),
  prediction_count: z.number().optional(),
  close_time: z.string().optional(),
  resolve_time: z.string().optional(),
  active_state: z.string().optional(),
  status: z.string().optional(),
  categories: z.array(z.object({ short_name: z.string().optional(), name: z.string().optional() })).optional(),
});

const MetaculusResponse = z.object({
  results: z.array(MetaculusQuestion),
  next: z.string().nullish(),
});

export class MetaculusSource implements MarketSource {
  readonly venue = "metaculus" as const;

  async fetchPage(opts: FetchOptions = {}): Promise<FetchResult> {
    const limit = Math.min(opts.limit ?? 100, 100);
    const offset = opts.cursor ? Number(opts.cursor) : 0;
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      status: "open",
      type: "forecast",
      forecast_type: "binary",
      order_by: "-prediction_count",
    });

    const apiKey = env().METACULUS_API_KEY;
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Token ${apiKey}`;

    const url = `${BASE}/questions/?${params.toString()}`;
    const data = await fetchJson(url, {
      schema: MetaculusResponse,
      source: "metaculus",
      headers,
      signal: opts.signal,
    });

    const fetchedAt = new Date();
    const markets: NormalizedMarket[] = data.results
      .map((q): NormalizedMarket | null => {
        const yes = q.community_prediction?.full?.q2;
        if (yes === undefined) return null;
        const slug = q.slug ?? String(q.id);
        const url = q.page_url ?? q.url ?? `https://www.metaculus.com/questions/${q.id}/`;
        return {
          venue: "metaculus",
          externalId: String(q.id),
          slug,
          question: q.title,
          category: q.categories?.[0]?.short_name ?? q.categories?.[0]?.name,
          outcomes: ["Yes", "No"],
          prices: [yes, 1 - yes],
          volume: q.prediction_count ?? q.number_of_predictions,
          endsAt: q.close_time ? new Date(q.close_time) : undefined,
          closed: q.status === "closed" || q.status === "resolved",
          sourceUrl: url.startsWith("http") ? url : `https://www.metaculus.com${url}`,
          fetchedAt,
        };
      })
      .filter((m): m is NormalizedMarket => m !== null);

    return {
      markets,
      nextCursor: data.next ? String(offset + limit) : undefined,
    };
  }
}
