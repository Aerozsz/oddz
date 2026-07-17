import { z } from "zod";
import { env } from "../env";
import { fetchJson } from "../http";
import type { FetchOptions, FetchResult, MarketSource, NormalizedMarket } from "./types";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";

const KalshiMarket = z.object({
  ticker: z.string(),
  event_ticker: z.string().optional(),
  title: z.string(),
  subtitle: z.string().optional(),
  category: z.string().optional(),
  status: z.string(),
  yes_bid: z.number().optional(),
  yes_ask: z.number().optional(),
  no_bid: z.number().optional(),
  no_ask: z.number().optional(),
  last_price: z.number().optional(),
  previous_yes_bid: z.number().optional(),
  volume: z.number().optional(),
  volume_24h: z.number().optional(),
  liquidity: z.number().optional(),
  open_interest: z.number().optional(),
  close_time: z.string().optional(),
  expiration_time: z.string().optional(),
  rules_primary: z.string().optional(),
});

const KalshiResponse = z.object({
  markets: z.array(KalshiMarket),
  cursor: z.string().optional(),
});

export class KalshiSource implements MarketSource {
  readonly venue = "kalshi" as const;

  async fetchPage(opts: FetchOptions = {}): Promise<FetchResult> {
    const limit = Math.min(opts.limit ?? 200, 1000);
    const params = new URLSearchParams({ status: "open", limit: String(limit) });
    if (opts.cursor) params.set("cursor", opts.cursor);

    const apiKey = env().KALSHI_API_KEY;
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const url = `${BASE}/markets?${params.toString()}`;
    const data = await fetchJson(url, {
      schema: KalshiResponse,
      source: "kalshi",
      headers,
      signal: opts.signal,
    });

    const fetchedAt = new Date();
    const markets: NormalizedMarket[] = data.markets.map((m) => {
      // Kalshi quotes in cents (0–100). We track yes-side mid as the price.
      const yesMid =
        m.yes_bid !== undefined && m.yes_ask !== undefined
          ? (m.yes_bid + m.yes_ask) / 2 / 100
          : m.last_price !== undefined
            ? m.last_price / 100
            : undefined;
      const noMid = yesMid !== undefined ? 1 - yesMid : undefined;
      const prices = yesMid !== undefined && noMid !== undefined ? [yesMid, noMid] : [];
      // Kalshi hierarchy is Series → Event → Market. Public pages live at
      // kalshi.com/markets/{series}/{event}, NOT the raw market ticker.
      // Series ticker = prefix of the event ticker before the first "-".
      const eventTicker = m.event_ticker ?? m.ticker;
      const series = eventTicker.split("-")[0];
      const sourceUrl = `https://kalshi.com/markets/${series.toLowerCase()}/${eventTicker.toLowerCase()}`;
      return {
        venue: "kalshi",
        externalId: m.ticker,
        slug: m.ticker.toLowerCase(),
        question: m.title,
        description: m.subtitle ?? m.rules_primary,
        category: m.category,
        outcomes: ["Yes", "No"],
        prices,
        volume: m.volume_24h ?? m.volume,
        liquidity: m.liquidity,
        openInterest: m.open_interest,
        endsAt: m.close_time ? new Date(m.close_time) : undefined,
        closed: m.status !== "open" && m.status !== "active",
        sourceUrl,
        fetchedAt,
      };
    });

    return { markets, nextCursor: data.cursor || undefined };
  }
}
