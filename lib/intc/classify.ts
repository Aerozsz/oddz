/**
 * The foundry-catalyst classifier. Given a headline (and any summary), it
 * answers three questions:
 *
 *   1. Is this actually about Intel's foundry? (relevance gate)
 *   2. How badly should it wake you? (severity)
 *   3. Which way does it lean for the stock? (direction)
 *
 * The taxonomy below is the thesis made executable. It is deliberately biased
 * toward the *rare repricing-up* catalysts (a named external customer at
 * volume, a strategic anchor) and the *frequent repricing-down* ones
 * (execution slips, capex, foundry P&L, separation), because those are the
 * only things that move INTC — quarterly beats do not.
 *
 * Tuning is a matter of editing this one table. Every weight and pattern is
 * here, not scattered across sources.
 */

import type { Classification, Direction, RawNewsItem, Severity } from "./types";

interface SignalGroup {
  id: string;
  label: string;
  direction: Direction;
  weight: number;
  patterns: RegExp[];
}

// Intel-identity gate. At least one must match unless the source is
// Intel-by-construction (SEC filings, Intel newsroom).
const ENTITY: RegExp[] = [
  /\bintel\b/i,
  /\bintc\b/i,
  /\bpat\s+gelsinger\b/i, // former CEO, still tagged in legacy coverage
  /\blip[-\s]?bu\s+tan\b/i, // CEO
  /\bintel\s+foundry\b/i,
];

// Foundry-relevance gate. Without one of these, an Intel headline is just
// noise (a laptop launch, a gaming GPU) — not a foundry catalyst.
const FOUNDRY_RELEVANCE: RegExp[] = [
  /\bfoundr(?:y|ies)\b/i,
  /\bifs\b/i,
  /\bintel\s+foundry\s+services\b/i,
  /\bexternal\s+(?:customer|revenue|foundry)\b/i,
  /\b(?:18a|14a|20a|10a)\b/i,
  /\bribbonfet\b/i,
  /\bpowervia\b/i,
  /\bhigh[-\s]?na\b/i,
  /\b(?:euv|lithograph)/i,
  /\btape[-\s]?out\b/i,
  /\bwafer\b/i,
  /\bfab(?:s|rication|ricat)?\b/i,
  /\bprocess\s+node\b/i,
  /\bgate[-\s]?all[-\s]?around\b/i,
  /\bfoveros\b/i,
  /\badvanced\s+packaging\b/i,
  /\byield/i,
  /\bhvm\b/i,
  /\bhigh[-\s]?volume\s+manufacturing\b/i,
];

const GROUPS: SignalGroup[] = [
  // ---- Repricing UP: the rare, high-conviction catalysts --------------
  {
    id: "external_customer",
    label: "External customer win",
    direction: "bullish",
    weight: 5,
    patterns: [
      /\bexternal\s+customer/i,
      /\banchor\s+customer/i,
      /\bnamed\s+customer/i,
      /\bcustomer\s+(?:win|commit|agreement|deal)/i,
      /\bwins?\s+(?:a\s+)?(?:major\s+)?(?:customer|order|deal)/i,
      /\bcapacity\s+reservation/i,
      /\bwafer\s+(?:supply\s+)?agreement/i,
      /\bprepay(?:ment)?\b/i,
      /\bcommit(?:s|ted|ment)?\s+to\s+(?:volume|18a|14a)/i,
      /\bsigns?\s+(?:up|on)\b/i,
    ],
  },
  {
    id: "marquee_customer_named",
    label: "Marquee customer named",
    direction: "bullish",
    weight: 4,
    patterns: [
      // The names that would signal real external volume for IFS.
      /\bmicrosoft\b/i,
      /\bamazon\b|\baws\b/i,
      /\bqualcomm\b/i,
      /\bnvidia\b/i,
      /\bapple\b/i,
      /\bbroadcom\b/i,
      /\bmediatek\b/i,
      /\bcisco\b/i,
      /\bgoogle\b|\balphabet\b/i,
      /\bfujitsu\b/i,
      /\bmicrochip\b/i,
    ],
  },
  {
    id: "govt_strategic",
    label: "Government / strategic anchor",
    direction: "bullish",
    weight: 4,
    patterns: [
      /\bchips\s+(?:act|and\s+science)/i,
      /\bgovernment\s+(?:stake|equity|grant|subsid)/i,
      /\bequity\s+stake/i,
      /\b(?:u\.?s\.?\s+)?(?:government|treasury)\s+(?:takes?|acquires?|buys?)/i,
      /\bdepartment\s+of\s+defense\b|\bdod\b|\bpentagon\b/i,
      /\bsecure\s+enclave\b/i,
      /\btrusted\s+foundry\b/i,
      /\bnational\s+security\b/i,
    ],
  },
  {
    id: "node_milestone_up",
    label: "Node milestone / progress",
    direction: "bullish",
    weight: 3,
    patterns: [
      /\bon\s+track\b/i,
      /\bahead\s+of\s+schedule\b/i,
      /\btape[-\s]?out\b/i,
      /\brisk\s+production\b/i,
      /\bpdk\b/i,
      /\byield.{0,20}(?:improv|ahead|record|good|strong|on\s+track)/i,
      /\bpowered\s+on\b/i,
      /\bfirst\s+(?:silicon|chip|wafer)/i,
      /\bramp(?:s|ing|ed)?\s+(?:up|to\s+volume)/i,
    ],
  },

  // ---- Repricing DOWN: the frequent knocks ----------------------------
  {
    id: "delay_slip",
    label: "Execution slip / delay",
    direction: "bearish",
    weight: 5,
    patterns: [
      /\bdelay(?:s|ed|ing)?\b/i,
      /\bpush(?:ed|es)?\s+(?:back|to\b|out)/i,
      /\bslip(?:s|ped|ping)?\b/i,
      /\bbehind\s+schedule\b/i,
      /\bmiss(?:es|ed)?\s+(?:its\s+)?(?:target|timeline|deadline)/i,
      /\bset\s?back\b/i,
      /\bhalt(?:s|ed)?\b/i,
      /\bpause(?:s|d)?\b/i,
    ],
  },
  {
    id: "customer_loss",
    label: "Customer loss / no demand",
    direction: "bearish",
    weight: 5,
    patterns: [
      /\blos(?:es|t|ing)\s+(?:a\s+)?(?:customer|order|client)/i,
      /\bno\s+external\s+(?:customer|demand)/i,
      /\bwalk(?:s|ed)?\s+away/i,
      /\bcancel(?:s|led|lation)?\b/i,
      /\bscrap(?:s|ped|ping)?\b/i,
      /\bpulls?\s+out\b/i,
      /\bfew(?:er)?\s+(?:customers|takers)/i,
    ],
  },
  {
    id: "capex_finance",
    label: "Capex / foundry P&L",
    direction: "bearish",
    weight: 4,
    patterns: [
      /\bcapex\b/i,
      /\bcapital\s+(?:expenditure|spending)/i,
      /\boperating\s+loss\b/i,
      /\bfoundry\s+loss\b/i,
      /\bwrite[-\s]?down\b|\bwriteoff\b|\bimpairment\b/i,
      /\bcash\s+burn\b/i,
      /\bcuts?\s+(?:its\s+)?(?:spending|capex|guidance|dividend)/i,
      /\bslash(?:es|ed)?\b/i,
    ],
  },
  {
    id: "separation",
    label: "Separation / divestiture",
    direction: "bearish",
    weight: 4,
    patterns: [
      /\bspin[-\s]?off\b/i,
      /\bspin(?:s|ning|ned)?\s+off/i, // "spins off", "spinning off", "spun off"
      /\bspun\s+off/i,
      /\bseparat(?:e|es|ion|ing)\b/i,
      /\bdivest(?:s|ed|iture|ment)?\b/i,
      /\bcarve[-\s]?out\b/i,
      /\bsells?\s+(?:a\s+)?(?:majority\s+)?stake/i,
      /\bbreak(?:s|ing)?\s+up\b/i,
    ],
  },
  {
    id: "yield_defect",
    label: "Yield / defect problem",
    direction: "bearish",
    weight: 4,
    patterns: [
      /\blow\s+yield/i,
      /\byield\s+(?:issue|problem|trouble|miss|shortfall)/i,
      /\bdefect(?:s|ive)?\b/i,
      /\bstruggl(?:e|es|ing)\b/i,
      /\bsetback\b/i,
    ],
  },
  {
    id: "layoff_restructure",
    label: "Layoffs / restructuring",
    direction: "bearish",
    weight: 2,
    patterns: [
      /\blay(?:s|ing)?\s?off/i,
      /\blayoffs?\b/i,
      /\bjob\s+cuts?\b/i,
      /\brestructur(?:e|es|ing)\b/i,
      /\bexit(?:s|ed|ing)?\s+(?:the\s+)?foundry/i,
    ],
  },

  // ---- Node names as amplifiers (either direction) --------------------
  {
    id: "node_14a",
    label: "14A node",
    direction: "neutral",
    weight: 3,
    patterns: [/\b14a\b/i],
  },
  {
    id: "node_18a",
    label: "18A node",
    direction: "neutral",
    weight: 2,
    patterns: [/\b18a\b/i],
  },
  {
    id: "analyst_rating",
    label: "Analyst rating change",
    direction: "neutral",
    weight: 2,
    patterns: [
      /\b(?:upgrade|downgrade)(?:s|d)?\b/i,
      /\bprice\s+target\b/i,
      /\braise(?:s|d)?\s+to\s+(?:buy|overweight)/i,
      /\bcut(?:s)?\s+to\s+(?:sell|underweight)/i,
      /\binitiate(?:s|d)?\s+(?:coverage|at)/i,
    ],
  },
];

function anyMatch(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

function severityFromScore(score: number, tags: Set<string>): Severity {
  // A named external customer or a strategic/government anchor is, on its
  // own, the kind of thing this monitor exists to catch — floor it high.
  const marquee =
    tags.has("external_customer") || tags.has("govt_strategic") || tags.has("customer_loss");
  if (score >= 9 || (marquee && score >= 7)) return "critical";
  if (score >= 6 || marquee) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function directionFromGroups(matched: SignalGroup[]): Direction {
  let up = 0;
  let down = 0;
  for (const g of matched) {
    if (g.direction === "bullish") up += g.weight;
    else if (g.direction === "bearish") down += g.weight;
  }
  if (up === 0 && down === 0) return "neutral";
  if (up > down * 1.2) return "bullish";
  if (down > up * 1.2) return "bearish";
  return "neutral"; // genuinely mixed — surface it, don't guess a side
}

export function classify(item: Pick<RawNewsItem, "title" | "summary" | "assumeEntity">): Classification {
  const text = `${item.title} ${item.summary ?? ""}`;

  const isIntel = item.assumeEntity || anyMatch(ENTITY, text);
  const isFoundry = anyMatch(FOUNDRY_RELEVANCE, text);
  // Intel-by-construction sources (SEC, newsroom) still must clear the
  // foundry gate — an Intel 8-K about a board change is not our beat.
  if (!isIntel || !isFoundry) {
    return { relevant: false, score: 0, severity: "low", direction: "neutral", tags: [] };
  }

  const matched = GROUPS.filter((g) => anyMatch(g.patterns, text));
  const score = matched.reduce((s, g) => s + g.weight, 0);
  const tags = new Set(matched.map((g) => g.id));

  // Foundry-relevant but no catalyst group fired: still worth a low-severity
  // note (roadmap reiteration, generic coverage), never a push.
  const severity = matched.length === 0 ? "low" : severityFromScore(score, tags);

  return {
    relevant: true,
    score,
    severity,
    direction: directionFromGroups(matched),
    tags: matched.map((g) => g.label),
  };
}
