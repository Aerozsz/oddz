/** Venue → settlement mechanism. Venue-level facts, not per-market claims. */
const SETTLEMENT: Record<string, string> = {
  polymarket: "UMA optimistic oracle",
  kalshi: "Kalshi exchange settlement (CFTC-regulated)",
  manifold: "Resolved by the market's creator",
  metaculus: "Metaculus community/admin resolution",
};

/**
 * Verbatim leading excerpt of a text, cut at a sentence boundary near
 * `target` chars. Pure truncation — never paraphrases or reorders.
 */
function verbatimExcerpt(text: string, target = 300): { excerpt: string; truncated: boolean } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= target + 60) return { excerpt: clean, truncated: clean !== text.trim() && false };
  const slice = clean.slice(0, target + 60);
  // Last sentence end inside the window; fall back to last word boundary.
  const endMatch = slice.match(/^[\s\S]*?[.!?](?=\s|$)(?![\s\S]*[.!?](?=\s|$))/);
  const cut = endMatch ? endMatch[0] : slice.slice(0, slice.lastIndexOf(" ", target)) + "…";
  return { excerpt: cut, truncated: true };
}

/**
 * The market TLDR: only facts we actually store (dates, outcomes, status,
 * venue settlement model) plus the venue's own rules text, quoted verbatim.
 * Nothing here is generated or interpreted.
 */
export interface MarketFactsInput {
  venue: string;
  description: string | null;
  outcomes: string[];
  endsAt: Date | null;
  createdAt?: Date | null;
  closed?: number;
}

export function MarketFacts({ market }: { market: MarketFactsInput }) {
  const facts: { label: string; value: string }[] = [];

  if (market.endsAt) {
    facts.push({
      label: "Resolves by",
      value: new Date(market.endsAt).toLocaleDateString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    });
  }
  if (market.closed !== undefined) {
    facts.push({ label: "Status", value: market.closed ? "Closed" : "Open" });
  }
  if (SETTLEMENT[market.venue]) {
    facts.push({ label: "Settlement", value: SETTLEMENT[market.venue] });
  }
  facts.push({
    label: "Outcomes",
    value:
      market.outcomes.length <= 3
        ? market.outcomes.join(" / ")
        : `${market.outcomes.length} outcomes`,
  });
  if (market.createdAt) {
    facts.push({
      label: "Listed",
      value: new Date(market.createdAt).toLocaleDateString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    });
  }

  const rules = market.description?.trim();
  const cut = rules ? verbatimExcerpt(rules) : null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <h2 className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted">
        TLDR
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
        {facts.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
              {f.label}
            </dt>
            <dd className="mt-0.5 truncate text-sm text-fg" title={f.value}>
              {f.value}
            </dd>
          </div>
        ))}
      </dl>

      {rules && cut && (
        <div className="border-t border-border-subtle pt-3 text-sm text-fg-dim">
          <p>{cut.excerpt}</p>
          {(cut.truncated || rules.length > cut.excerpt.length + 10) && (
            <details className="mt-2">
              <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-[0.1em] text-muted hover:text-fg">
                Full rules — verbatim from the venue
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">
                {rules}
              </p>
            </details>
          )}
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted/70">
            Rules text is the venue&apos;s own, unedited.
          </p>
        </div>
      )}
    </div>
  );
}
