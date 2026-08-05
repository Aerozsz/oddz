import { parseFeed } from "../../feeds/rss";
import { fetchText } from "../../feeds/net";
import { env } from "../../env";
import type { FetchGeoOptions, GeoSource, RawGeoItem } from "../types";

/**
 * Trump's Truth Social feed — the primary source, straight from the poster.
 * There's no stable public API, so this reads an RSS URL you point it at
 * (`TRUTH_SOCIAL_RSS_URL`) — a self-hosted bridge (e.g. rss-bridge / Nitter-
 * style mirror) or a hosted feed you trust. Unset → the source no-ops and the
 * wires (Google News) carry the load. Everything here is Trump-by-construction,
 * so the classifier's "is this Trump?" gate is skipped.
 */
export class TruthSocialSource implements GeoSource {
  readonly slug = "truth-social";
  readonly label = "Truth Social";
  readonly assumeActor = true;

  async fetch(opts: FetchGeoOptions = {}): Promise<RawGeoItem[]> {
    const feed = env().TRUTH_SOCIAL_RSS_URL;
    if (!feed) return [];

    const xml = await fetchText(feed, { signal: opts.signal });
    const out: RawGeoItem[] = [];
    for (const item of parseFeed(xml)) {
      if (opts.since && item.publishedAt && item.publishedAt < opts.since) continue;
      // A post's "title" is often the first line of its body; keep the body as
      // summary so the classifier sees the whole thing.
      out.push({
        externalId: item.guid ?? item.link,
        title: item.title,
        url: item.link,
        summary: item.summary,
        publishedAt: item.publishedAt,
        sourceLabel: this.label,
        assumeActor: true,
      });
    }
    return out;
  }
}
