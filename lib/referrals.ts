import type { VenueSlug } from "./sources";

/**
 * Per-venue affiliate templates. `{slug}` and `{externalId}` get
 * substituted from the market row at render time. Empty template
 * means we just link to the source URL with no referral bolt-on.
 *
 * Set `NEXT_PUBLIC_REF_<VENUE>` to flip live without redeploying
 * adapter code — affiliate IDs change.
 */
const TEMPLATES: Record<VenueSlug, string> = {
  polymarket: process.env.NEXT_PUBLIC_REF_POLYMARKET ?? "",
  kalshi: process.env.NEXT_PUBLIC_REF_KALSHI ?? "",
  manifold: process.env.NEXT_PUBLIC_REF_MANIFOLD ?? "",
  metaculus: process.env.NEXT_PUBLIC_REF_METACULUS ?? "",
};

export function buildReferralUrl(input: {
  venue: VenueSlug;
  slug: string;
  externalId: string;
  sourceUrl: string;
}): string {
  const tmpl = TEMPLATES[input.venue];
  if (!tmpl) return input.sourceUrl;
  return tmpl
    .replaceAll("{slug}", encodeURIComponent(input.slug))
    .replaceAll("{externalId}", encodeURIComponent(input.externalId));
}

export function hasReferral(venue: VenueSlug): boolean {
  return Boolean(TEMPLATES[venue]);
}
