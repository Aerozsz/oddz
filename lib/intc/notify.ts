/**
 * INTC-specific push: format a classified foundry catalyst into a message and
 * fan it out via the shared channels (Telegram / ntfy / webhook). Channel
 * wire-details live in lib/notify/channels.ts; this file owns only the INTC
 * framing. With no channel configured, the catalyst is still logged + stored.
 */

import { dispatch, escapeHtml, type DispatchResult } from "../notify/channels";
import { log } from "../logger";
import type { ClassifiedNewsItem, Direction, Severity } from "./types";

const DIRECTION_EMOJI: Record<Direction, string> = {
  bullish: "🟢",
  bearish: "🔴",
  neutral: "⚪",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  critical: "CRITICAL",
};

function ntfyPriority(sev: Severity): number {
  return sev === "critical" ? 5 : sev === "high" ? 4 : 3;
}

export async function notify(item: ClassifiedNewsItem): Promise<DispatchResult> {
  const title = `INTC ${SEVERITY_LABEL[item.severity]} · ${item.direction} — foundry`;
  const tagLine = item.tags.length ? `\nSignals: ${item.tags.join(", ")}` : "";
  const body =
    `${DIRECTION_EMOJI[item.direction]} ${item.title}\n\n` +
    `${item.sourceLabel} · ${item.direction} · score ${item.score}${tagLine}`;
  const html =
    `${DIRECTION_EMOJI[item.direction]} <b>INTC · ${SEVERITY_LABEL[item.severity]} · ${item.direction}</b>\n` +
    `${escapeHtml(item.title)}\n\n<i>${escapeHtml(item.sourceLabel)}</i> · score ${item.score}` +
    (item.tags.length ? `\n${escapeHtml(item.tags.join(", "))}` : "");

  const result = await dispatch({
    title,
    body,
    html,
    url: item.url,
    priority: ntfyPriority(item.severity),
    tags:
      item.direction === "bullish"
        ? ["green_circle", "chart_with_upwards_trend"]
        : item.direction === "bearish"
          ? ["red_circle", "chart_with_downwards_trend"]
          : ["white_circle"],
    meta: {
      source: item.sourceLabel,
      severity: item.severity,
      direction: item.direction,
      score: item.score,
      tags: item.tags,
      publishedAt: item.publishedAt?.toISOString() ?? null,
    },
  });

  log.info("intc catalyst", {
    severity: item.severity,
    direction: item.direction,
    score: item.score,
    title: item.title,
    url: item.url,
    pushed: result.channels,
  });

  return result;
}
