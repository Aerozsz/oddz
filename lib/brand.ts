/**
 * Single source of truth for the product's identity. Rename the whole
 * app by editing ONLY this file — every title, wordmark, OG card, and
 * user-agent reads from here.
 *
 * `NEXT_PUBLIC_SITE_NAME` / `NEXT_PUBLIC_SITE_URL` env vars override the
 * defaults at build time, so the name can even change without a code edit.
 */
export const brand = {
  /** Lowercase wordmark, e.g. shown in the header logo. */
  wordmark: process.env.NEXT_PUBLIC_SITE_NAME?.toLowerCase() ?? "oddz",
  /** Title-case name for page titles and prose. */
  name: process.env.NEXT_PUBLIC_SITE_NAME ?? "Oddz",
  tagline: "Every prediction market. One screen.",
  description:
    "Live odds across Polymarket, Kalshi, Manifold and Metaculus. Spot relative value across venues before the rest of the market does.",
  shortDescription: "Prediction market odds aggregator",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  /** Used in the outbound API client User-Agent. Kept generic on purpose. */
  userAgent: `${(process.env.NEXT_PUBLIC_SITE_NAME ?? "oddz").toLowerCase()}/0.1`,
  /** Social / support handles — fill in when they exist. */
  social: {
    twitter: "",
    github: "aerozsz/oddz",
  },
} as const;

/** `"<Page> — Oddz"` title helper. */
export function pageTitle(page?: string): string {
  return page ? `${page} — ${brand.name}` : `${brand.name} — ${brand.shortDescription}`;
}
