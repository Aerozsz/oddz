/**
 * Convert a free-form question into a canonical key used to detect when
 * markets across venues describe the same event. This is intentionally
 * conservative — false negatives are fine, false positives are not.
 *
 * Strategy: lowercase, strip punctuation, drop stopwords, sort tokens,
 * then take a stable signature. A real cross-venue matcher will eventually
 * layer entity extraction on top, but a sorted-token bag wins on a lot of
 * real Polymarket↔Kalshi pairs already (e.g. "Trump wins 2028" vs
 * "Will Trump win the 2028 election").
 */

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "can",
  "could",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "from",
  "by",
  "with",
  "about",
  "against",
  "between",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "and",
  "or",
  "but",
  "if",
  "then",
  "than",
  "as",
  "so",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
]);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function canonicalKey(text: string): string {
  const t = tokens(text);
  if (t.length === 0) return "";
  return Array.from(new Set(t)).sort().join("-").slice(0, 240);
}

/** Jaccard similarity over canonical token bags, 0..1. */
export function similarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return intersection / (ta.size + tb.size - intersection);
}
