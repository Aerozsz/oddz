/**
 * Channel-agnostic push. The monitor hands us a classified catalyst; we fan
 * it out to whichever channels the operator configured (Telegram, ntfy, a
 * generic JSON webhook for Slack/Discord/Zapier). Each channel is optional and
 * fired independently — an unconfigured or failing channel never blocks the
 * others, and never fails the monitor run.
 *
 * "Informs me directly, immediately": ntfy is the zero-account path (pick a
 * topic, install the app, subscribe); Telegram is the richest; the webhook
 * covers everything else. Configure one, all, or none — with none set, the
 * catalyst is still logged and stored, just not pushed.
 */

import { env } from "../env";
import { log } from "../logger";
import type { ClassifiedNewsItem, Direction, Severity } from "./types";

export interface NotifyResult {
  channels: string[]; // channels that accepted the push
  attempted: number;
}

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

function ntfyPriority(sev: Severity): string {
  // ntfy priority 1..5; map so critical buzzes through a silenced phone.
  return sev === "critical" ? "5" : sev === "high" ? "4" : "3";
}

function subject(item: ClassifiedNewsItem): string {
  return `INTC ${SEVERITY_LABEL[item.severity]} · ${item.direction} — foundry`;
}

function plainBody(item: ClassifiedNewsItem): string {
  const tags = item.tags.length ? `\nSignals: ${item.tags.join(", ")}` : "";
  const when = item.publishedAt ? `\n${item.publishedAt.toISOString()}` : "";
  return `${DIRECTION_EMOJI[item.direction]} ${item.title}\n\n${item.sourceLabel} · ${item.direction} · score ${item.score}${tags}${when}\n${item.url}`;
}

async function post(
  url: string,
  init: RequestInit,
  channel: string,
  timeoutMs = 8000,
): Promise<boolean> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      log.warn("intc notify channel failed", { channel, status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    log.warn("intc notify channel error", { channel, error: String(err) });
    return false;
  }
}

async function telegram(item: ClassifiedNewsItem): Promise<boolean | null> {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = env();
  if (!token || !chat) return null;
  const text =
    `${DIRECTION_EMOJI[item.direction]} <b>INTC · ${SEVERITY_LABEL[item.severity]} · ${item.direction}</b>\n` +
    `${escapeHtml(item.title)}\n\n` +
    `<i>${escapeHtml(item.sourceLabel)}</i> · score ${item.score}` +
    (item.tags.length ? `\n${escapeHtml(item.tags.join(", "))}` : "") +
    `\n\n<a href="${escapeHtml(item.url)}">Open source →</a>`;
  return post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: false }),
    },
    "telegram",
  );
}

async function ntfy(item: ClassifiedNewsItem): Promise<boolean | null> {
  const { NTFY_TOPIC: topic, NTFY_SERVER: server } = env();
  if (!topic) return null;
  return post(
    `${server.replace(/\/$/, "")}/${topic}`,
    {
      method: "POST",
      headers: {
        Title: subject(item),
        Priority: ntfyPriority(item.severity),
        Tags: item.direction === "bullish" ? "green_circle,chart_with_upwards_trend" : item.direction === "bearish" ? "red_circle,chart_with_downwards_trend" : "white_circle",
        Click: item.url,
      },
      body: plainBody(item),
    },
    "ntfy",
  );
}

async function webhook(item: ClassifiedNewsItem): Promise<boolean | null> {
  const url = env().INTC_WEBHOOK_URL;
  if (!url) return null;
  const message = `${subject(item)}\n${item.title}\n${item.url}`;
  // `text` satisfies Slack, `content` satisfies Discord; `intc` carries the
  // structured payload for a custom endpoint / Zapier.
  const payload = {
    text: message,
    content: message,
    intc: {
      title: item.title,
      url: item.url,
      source: item.sourceLabel,
      severity: item.severity,
      direction: item.direction,
      score: item.score,
      tags: item.tags,
      publishedAt: item.publishedAt?.toISOString() ?? null,
    },
  };
  return post(
    url,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
    "webhook",
  );
}

export async function notify(item: ClassifiedNewsItem): Promise<NotifyResult> {
  const results = await Promise.all([telegram(item), ntfy(item), webhook(item)]);
  const names = ["telegram", "ntfy", "webhook"];
  const channels: string[] = [];
  let attempted = 0;
  results.forEach((ok, i) => {
    if (ok === null) return; // channel not configured
    attempted++;
    if (ok) channels.push(names[i]);
  });

  // Always leave a durable trace, even when no channel is wired up — the
  // catalyst is in the DB and the log regardless.
  log.info("intc catalyst", {
    severity: item.severity,
    direction: item.direction,
    score: item.score,
    title: item.title,
    url: item.url,
    pushed: channels,
  });

  return { channels, attempted };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
