/**
 * The peace ↔ war classifier. For a Trump headline it answers:
 *
 *   1. Is this a Trump geopolitics/market announcement? (relevance gate)
 *   2. Which side of the axis — escalation or de-escalation? (side)
 *   3. Which conflict? (theater)
 *   4. How hard should the market care? (intensity)
 *   5. Which way do markets usually react? (market lean)
 *
 * The whole point of the product is the *tilt*: escalation headlines are
 * risk-off (equities down, oil/gold/defense up), de-escalation is risk-on. The
 * two sides are scored independently and the dominant one wins, so a headline
 * that mixes both ("agrees to talks but warns of strikes") lands neutral and
 * gets surfaced rather than mislabeled.
 */

import type { GeoClassification, MarketLean, RawGeoItem, Side, Theater } from "./types";

// Is this even a Trump statement/announcement? Skipped for Truth Social.
const ACTOR: RegExp[] = [
  /\btrump\b/i,
  /\bdonald\s+trump\b/i,
  /\bpresident\s+trump\b/i,
  /\bwhite\s+house\b/i,
  /\btrump\s+administration\b/i,
  /\bpotus\b/i,
];

interface Group {
  id: string;
  label: string;
  weight: number;
  patterns: RegExp[];
}

// ---- De-escalation (PEACE, risk-on) -----------------------------------
const DEESCALATION: Group[] = [
  {
    id: "ceasefire",
    label: "Ceasefire / truce",
    weight: 5,
    patterns: [
      /\bcease[-\s]?fire\b/i,
      /\btruce\b/i,
      /\bstop\s+(?:the\s+)?(?:fighting|war)/i,
      /\bpause\s+(?:in\s+)?(?:the\s+)?(?:fighting|hostilities)/i,
      /\bhostilities\s+(?:end|ended|halt)/i,
    ],
  },
  {
    id: "peace_deal",
    label: "Peace deal / agreement",
    weight: 5,
    patterns: [
      /\bpeace\s+(?:deal|plan|agreement|accord|framework)/i,
      /\bdeal\s+(?:reached|signed|struck|agreed)/i,
      /\bsigns?\s+(?:a\s+)?(?:peace|agreement|accord)/i,
      /\bend(?:s|ing)?\s+(?:the\s+)?war/i,
      /\bnormaliz(?:e|es|ation)\b/i,
    ],
  },
  {
    id: "talks",
    label: "Talks / diplomacy",
    weight: 3,
    patterns: [
      /\bpeace\s+talks\b/i,
      /\bnegotiat(?:e|es|ing|ions?)\b/i,
      /\bdiploma(?:cy|tic)\b/i,
      /\bsummit\b/i,
      /\bmeet(?:s|ing|ings)?\s+with\b/i,
      /\bsit\s+down\s+with\b/i,
      /\bde[-\s]?escalat/i,
    ],
  },
  {
    id: "relief",
    label: "Sanctions relief / release",
    weight: 3,
    patterns: [
      /\bsanctions?\s+(?:relief|lifted|eased|removed)/i,
      /\blift(?:s|ing|ed)?\s+sanctions/i,
      /\bhostages?\s+(?:freed|released)/i,
      /\bprisoner\s+(?:swap|exchange)/i,
      /\bwithdraw(?:s|al|ing)?\s+troops/i,
    ],
  },
];

// ---- Escalation (WAR, risk-off) ---------------------------------------
const ESCALATION: Group[] = [
  {
    id: "strike",
    label: "Strike / military action",
    weight: 6,
    patterns: [
      /\bstrike(?:s|d)?\b/i,
      /\bair[-\s]?strikes?\b/i,
      /\bbomb(?:s|ed|ing)?\b/i,
      /\bmissile(?:s)?\b/i,
      /\battack(?:s|ed|ing)?\b/i,
      /\bmilitary\s+(?:action|force|strike|operation)/i,
      /\binvad(?:e|es|ion)\b|\binvasion\b/i,
      /\bboots\s+on\s+the\s+ground\b/i,
    ],
  },
  {
    id: "threat",
    label: "Threat / ultimatum",
    weight: 4,
    patterns: [
      /\bthreaten(?:s|ed|ing)?\b/i,
      /\bultimatum\b/i,
      /\bdeadline\b/i,
      /\ball\s+options?\s+(?:are\s+)?on\s+the\s+table\b/i,
      /\bwill\s+not\s+(?:tolerate|allow|hesitate)/i,
      /\bor\s+else\b/i,
      /\bmaximum\s+pressure\b/i,
      /\bconsequences\b/i,
    ],
  },
  {
    id: "mobilize",
    label: "Troops / deployment",
    weight: 4,
    patterns: [
      /\bdeploy(?:s|ed|ment|ing)?\b/i,
      /\btroops?\b/i,
      /\bwarships?\b|\bcarrier\s+(?:group|strike)/i,
      /\bmobiliz(?:e|es|ation|ing)\b/i,
      /\bmilitary\s+buildup\b/i,
      /\breinforce(?:s|ments)?\b/i,
    ],
  },
  {
    id: "new_sanctions",
    label: "New sanctions / pressure",
    weight: 3,
    patterns: [
      /\bnew\s+sanctions\b/i,
      /\bimpos(?:e|es|ing)\s+sanctions/i,
      /\bsanction(?:s|ed|ing)?\b/i,
      /\bblacklist(?:s|ed)?\b/i,
      /\bembargo\b/i,
    ],
  },
  {
    id: "nuclear",
    label: "Nuclear",
    weight: 5,
    patterns: [/\bnuclear\b/i, /\bnukes?\b/i, /\benrich(?:ment|ed)?\b/i],
  },
];

// Trade / tariffs — a distinct escalation flavor Trump uses constantly.
const TRADE_ESCALATION: Group[] = [
  {
    id: "tariff_up",
    label: "New / higher tariffs",
    weight: 4,
    patterns: [
      /\btariffs?\b/i,
      /\btrade\s+war\b/i,
      /\bimpos(?:e|es|ing)\s+(?:a\s+)?(?:\d+%\s+)?(?:tariff|duty|duties|levy)/i,
      /\bhike(?:s|d)?\s+(?:tariffs|duties)/i,
      /\bexport\s+(?:ban|control|restriction)/i,
    ],
  },
];
const TRADE_DEESCALATION: Group[] = [
  {
    id: "tariff_down",
    label: "Tariff pause / trade deal",
    weight: 4,
    patterns: [
      /\btrade\s+deal\b/i,
      /\btariff\s+(?:pause|truce|deal|rollback|exemption|reprieve)/i,
      /\b(?:pause|delay|suspend|cut|lower|drop)(?:s|ed|ing)?\s+(?:the\s+)?tariffs/i,
      /\btrade\s+(?:truce|agreement)\b/i,
    ],
  },
];

// ---- Theaters ---------------------------------------------------------
const THEATERS: Array<{ theater: Theater; patterns: RegExp[] }> = [
  {
    theater: "russia-ukraine",
    patterns: [/\brussia\b/i, /\bukrain/i, /\bputin\b/i, /\bzelensk/i, /\bmoscow\b/i, /\bkyiv\b/i, /\bkremlin\b/i],
  },
  {
    theater: "middle-east",
    patterns: [
      /\biran\b/i,
      /\bisrael\b/i,
      /\bgaza\b/i,
      /\bhamas\b/i,
      /\bhezbollah\b/i,
      /\bnetanyahu\b/i,
      /\bhouthi/i,
      /\btehran\b/i,
      /\bmiddle\s+east\b/i,
      /\bsyria\b/i,
      /\blebanon\b/i,
    ],
  },
  {
    theater: "china-taiwan",
    patterns: [/\bchina\b/i, /\btaiwan\b/i, /\bxi\s+jinping\b/i, /\bbeijing\b/i, /\bsouth\s+china\s+sea\b/i],
  },
  {
    theater: "north-korea",
    patterns: [/\bnorth\s+korea\b/i, /\bpyongyang\b/i, /\bkim\s+jong/i, /\bdprk\b/i],
  },
];

function anyMatch(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

function fireGroups(groups: Group[], text: string): { score: number; labels: string[] } {
  let score = 0;
  const labels: string[] = [];
  for (const g of groups) {
    if (anyMatch(g.patterns, text)) {
      score += g.weight;
      labels.push(g.label);
    }
  }
  return { score, labels };
}

function detectTheater(text: string): Theater {
  for (const { theater, patterns } of THEATERS) {
    if (anyMatch(patterns, text)) return theater;
  }
  if (anyMatch(TRADE_ESCALATION[0].patterns, text) || anyMatch(TRADE_DEESCALATION[0].patterns, text)) {
    return "trade";
  }
  return "other";
}

function intensityFromScore(score: number): GeoClassification["intensity"] {
  if (score >= 9) return "critical";
  if (score >= 6) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function marketLean(side: Side, theater: Theater): MarketLean {
  if (side === "neutral") return "mixed";
  // Trade and shooting-war escalation are both risk-off; de-escalation risk-on.
  return side === "escalation" ? "risk_off" : "risk_on";
}

export function classify(item: Pick<RawGeoItem, "title" | "summary" | "assumeActor">): GeoClassification {
  const text = `${item.title} ${item.summary ?? ""}`;

  const isActor = item.assumeActor || anyMatch(ACTOR, text);
  if (!isActor) {
    return notRelevant("other");
  }

  const up = fireGroups([...DEESCALATION, ...TRADE_DEESCALATION], text); // peace
  const down = fireGroups([...ESCALATION, ...TRADE_ESCALATION], text); // war

  // No conflict signal at all → not a peace/war headline we track.
  if (up.score === 0 && down.score === 0) {
    return notRelevant(detectTheater(text));
  }

  // Dominant side wins; a near-tie is genuinely mixed → neutral (still shown).
  let side: Side;
  if (down.score > up.score * 1.2) side = "escalation";
  else if (up.score > down.score * 1.2) side = "deescalation";
  else side = "neutral";

  const score = Math.max(up.score, down.score);
  const theater = detectTheater(text);
  const labels = [...new Set([...(side === "deescalation" ? up.labels : side === "escalation" ? down.labels : [...up.labels, ...down.labels])])];

  return {
    relevant: true,
    side,
    theater,
    intensity: intensityFromScore(score),
    marketLean: marketLean(side, theater),
    score,
    tags: labels,
  };
}

function notRelevant(theater: Theater): GeoClassification {
  return {
    relevant: false,
    side: "neutral",
    theater,
    intensity: "low",
    marketLean: "mixed",
    score: 0,
    tags: [],
  };
}
