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

/**
 * Light suffix stemmer so "reaches"/"reach", "wins"/"win" collide.
 * Deliberately minimal — a full Porter stemmer overcorrects on proper
 * nouns ("Texas" -> "Texa") which matter a lot in market titles.
 */
function stem(t: string): string {
  if (t.length > 4 && t.endsWith("es")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
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

/**
 * Numeric tokens (years, price levels, counts) carry the event identity:
 * "Trump wins 2024" and "Trump wins 2028" share every word token but are
 * different events. Two questions are only fuzzy-matchable when their
 * numeric token sets agree exactly.
 */
export function numericTokens(text: string): Set<string> {
  return new Set(tokens(text).filter((t) => /^\d+(k|m|bn)?$/.test(t)));
}

export function numbersAgree(a: string, b: string): boolean {
  const na = numericTokens(a);
  const nb = numericTokens(b);
  if (na.size !== nb.size) return false;
  for (const t of na) if (!nb.has(t)) return false;
  return true;
}

/**
 * Combined fuzzy-match decision. Conservative on purpose — a false
 * divergence row is worse than a missing one.
 */
export const FUZZY_THRESHOLD = 0.75;

export function isFuzzyMatch(a: string, b: string): boolean {
  if (!numbersAgree(a, b)) return false;
  return similarity(a, b) >= FUZZY_THRESHOLD;
}
