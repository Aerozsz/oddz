/**
 * Low-level push channels, shared by every monitor (INTC foundry, geopolitics,
 * …). Each sender takes a generic message and returns:
 *   true  — delivered
 *   false — configured but the send failed
 *   null  — channel not configured (skip silently)
 *
 * Callers format their own domain-specific title/body and priority; the wire
 * details (Telegram HTML, ntfy headers, Slack/Discord webhook shape) live here
 * once.
 */

import { env } from "../env";
import { log } from "../logger";

export interface PushMessage {
  /** Short subject line (ntfy Title, webhook lead). */
  title: string;
  /** Plaintext body (ntfy/webhook). */
  body: string;
  /** Optional HTML body for Telegram; falls back to `body`. */
  html?: string;
  url: string;
  /** ntfy priority 1..5; 5 buzzes through a silenced phone. */
  priority?: number;
  /** ntfy tag/emoji shortcodes, e.g. ["red_circle"]. */
  tags?: string[];
  /** Extra structured fields for the generic webhook payload. */
  meta?: Record<string, unknown>;
}

async function post(url: string, init: RequestInit, channel: string, timeoutMs = 8000): Promise<boolean> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      log.warn("notify channel failed", { channel, status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    log.warn("notify channel error", { channel, error: String(err) });
    return false;
  }
}

export async function sendTelegram(m: PushMessage): Promise<boolean | null> {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = env();
  if (!token || !chat) return null;
  const text = `${m.html ?? escapeHtml(m.body)}\n\n<a href="${escapeHtml(m.url)}">Open source →</a>`;
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

export async function sendNtfy(m: PushMessage): Promise<boolean | null> {
  const { NTFY_TOPIC: topic, NTFY_SERVER: server } = env();
  if (!topic) return null;
  const headers: Record<string, string> = {
    Title: m.title,
    Priority: String(m.priority ?? 3),
    Click: m.url,
  };
  if (m.tags?.length) headers.Tags = m.tags.join(",");
  return post(`${server.replace(/\/$/, "")}/${topic}`, { method: "POST", headers, body: `${m.body}\n${m.url}` }, "ntfy");
}

export async function sendWebhook(m: PushMessage): Promise<boolean | null> {
  const url = env().INTC_WEBHOOK_URL;
  if (!url) return null;
  const message = `${m.title}\n${m.body}\n${m.url}`;
  // `text` satisfies Slack, `content` satisfies Discord; `data` is structured.
  const payload = { text: message, content: message, data: { title: m.title, url: m.url, ...m.meta } };
  return post(
    url,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
    "webhook",
  );
}

export interface DispatchResult {
  channels: string[];
  attempted: number;
}

/** Fan a message out to every configured channel, independently. */
export async function dispatch(m: PushMessage): Promise<DispatchResult> {
  const senders: Array<[string, Promise<boolean | null>]> = [
    ["telegram", sendTelegram(m)],
    ["ntfy", sendNtfy(m)],
    ["webhook", sendWebhook(m)],
  ];
  const results = await Promise.all(senders.map(([, p]) => p));
  const channels: string[] = [];
  let attempted = 0;
  results.forEach((ok, i) => {
    if (ok === null) return;
    attempted++;
    if (ok) channels.push(senders[i][0]);
  });
  return { channels, attempted };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
