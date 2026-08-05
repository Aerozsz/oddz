/**
 * Geo push: format a classified peace/war signal and fan it out via the shared
 * channels. Escalation buzzes red/risk-off, de-escalation green/risk-on. Only
 * called for signals that clear GEO_MIN_INTENSITY.
 */

import { dispatch, escapeHtml, type DispatchResult } from "../notify/channels";
import { log } from "../logger";
import { THEATER_LABEL, type ClassifiedGeoItem, type Intensity, type Side } from "./types";

const SIDE_EMOJI: Record<Side, string> = {
  escalation: "🔴",
  deescalation: "🟢",
  neutral: "⚪",
};

const SIDE_LABEL: Record<Side, string> = {
  escalation: "ESCALATION",
  deescalation: "DE-ESCALATION",
  neutral: "MIXED",
};

function priority(i: Intensity): number {
  return i === "critical" ? 5 : i === "high" ? 4 : 3;
}

export async function notifyGeo(item: ClassifiedGeoItem): Promise<DispatchResult> {
  const theater = THEATER_LABEL[item.theater as keyof typeof THEATER_LABEL] ?? item.theater;
  const lean = item.marketLean === "risk_off" ? "risk-off" : item.marketLean === "risk_on" ? "risk-on" : "mixed";
  const title = `TRUMP ${SIDE_LABEL[item.side]} · ${theater} · ${lean}`;
  const tagLine = item.tags.length ? `\n${item.tags.join(", ")}` : "";
  const body = `${SIDE_EMOJI[item.side]} ${item.title}\n\n${item.sourceLabel} · ${theater} · ${lean}${tagLine}`;
  const html =
    `${SIDE_EMOJI[item.side]} <b>Trump · ${SIDE_LABEL[item.side]} · ${escapeHtml(theater)}</b>\n` +
    `${escapeHtml(item.title)}\n\n<i>${escapeHtml(item.sourceLabel)}</i> · ${lean}` +
    (item.tags.length ? `\n${escapeHtml(item.tags.join(", "))}` : "");

  const result = await dispatch({
    title,
    body,
    html,
    url: item.url,
    priority: priority(item.intensity),
    tags:
      item.side === "escalation"
        ? ["red_circle", "warning"]
        : item.side === "deescalation"
          ? ["green_circle", "dove"]
          : ["white_circle"],
    meta: {
      source: item.sourceLabel,
      side: item.side,
      theater: item.theater,
      intensity: item.intensity,
      marketLean: item.marketLean,
      score: item.score,
      tags: item.tags,
      publishedAt: item.publishedAt?.toISOString() ?? null,
    },
  });

  log.info("geo signal", {
    side: item.side,
    theater: item.theater,
    intensity: item.intensity,
    title: item.title,
    url: item.url,
    pushed: result.channels,
  });

  return result;
}
