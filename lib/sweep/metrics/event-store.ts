import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EventCertainty, MarketEvent } from "./events";

/**
 * A calendar an agent can write to.
 *
 * The events module refuses to trade through a confirmed earnings date, and
 * confirmed dates have to come from somewhere. Until now that somewhere was a
 * human looking up Intel's investor-relations page and hand-formatting JSON
 * into an environment variable — the only place in this system where a fact
 * has to be fetched by a person, and therefore the place most likely to be out
 * of date on the day it matters.
 *
 * Hermes ships with web search and content extraction, so it can do that
 * lookup. This is the store it writes into.
 *
 * The safety question is not "can the agent be trusted with the calendar", it
 * is "what is the worst thing a wrong entry does", and the two directions are
 * not symmetric:
 *
 *   A spurious event    blocks trading that should have happened. Annoying,
 *                       visible, and costs nothing but opportunity.
 *   A removed event     trades straight through an earnings release. That is
 *                       the failure the whole module exists to prevent.
 *
 * So this store is append-only. Nothing here deletes or edits, and a
 * superseding entry is added rather than overwriting — the resolver takes the
 * most recently recorded entry for a given key, so history stays readable and
 * a bad correction can be corrected again rather than having destroyed
 * something. Removing an event is a human editing the file.
 *
 * Every entry carries where it came from. An agent-supplied date with no source
 * URL is recorded as `projected` regardless of what the caller claimed, because
 * "confirmed" is a claim about evidence and an unsourced assertion is not
 * evidence.
 */

export interface StoredEvent extends MarketEvent {
  /** When this entry was written. */
  recordedAt: number;
  /** Who wrote it: an agent name, or "human". */
  recordedBy: string;
  /** Where the date came from. Required for a `confirmed` entry to stay confirmed. */
  sourceUrl: string | null;
  /** Free text from whoever recorded it. */
  note: string | null;
  /** Set when a later entry supersedes this one. Never deleted. */
  supersededBy?: string;
}

const DEFAULT_PATH = "data/sweep-events.json";

export function storePath(): string {
  return resolve(process.env.SWEEP_EVENT_STORE ?? DEFAULT_PATH);
}

export function readStore(path = storePath()): StoredEvent[] {
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as StoredEvent[]) : [];
  } catch {
    // A corrupt calendar must not stop the monitor. It falls back to the
    // projection, which is the conservative outcome: size derated, and a
    // standing prompt to confirm.
    return [];
  }
}

export interface RecordEventInput {
  label: string;
  /** ISO 8601, or epoch ms. The release instant, not the trading day. */
  at: string | number;
  certainty?: EventCertainty;
  kind?: MarketEvent["kind"];
  sourceUrl?: string | null;
  note?: string | null;
  recordedBy?: string;
  beforeH?: number;
  afterH?: number;
}

export interface RecordEventResult {
  ok: boolean;
  event?: StoredEvent;
  /** Set when the claimed certainty was reduced, and why. */
  downgraded?: string;
  error?: string;
}

/**
 * Add an entry. Never removes or edits one.
 *
 * A date in the past is rejected outright rather than stored: it cannot
 * black anything out, and the only thing it can do is make the calendar
 * harder to read.
 */
export function recordEvent(input: RecordEventInput, path = storePath()): RecordEventResult {
  const at = typeof input.at === "number" ? input.at : Date.parse(input.at);
  if (!Number.isFinite(at)) {
    return { ok: false, error: `could not read "${input.at}" as a date — use ISO 8601, e.g. 2026-10-22T20:05:00Z` };
  }
  if (at < Date.now() - 86_400_000) {
    return { ok: false, error: `${new Date(at).toISOString()} is in the past — nothing can be blacked out retrospectively` };
  }
  const label = String(input.label ?? "").trim();
  if (!label) return { ok: false, error: "label is required" };

  const sourceUrl = input.sourceUrl?.trim() || null;
  let certainty: EventCertainty = input.certainty === "projected" ? "projected" : "confirmed";
  let downgraded: string | undefined;

  // "Confirmed" is a claim about evidence. Without a source it is an assertion,
  // and an assertion that hard-blocks trading on a date nobody can check is
  // worse than a projection that merely derates size.
  if (certainty === "confirmed" && !sourceUrl) {
    certainty = "projected";
    downgraded =
      "recorded as projected rather than confirmed: a confirmed date needs a sourceUrl to check it against. " +
      "It will derate size rather than blacking out.";
  }

  const event: StoredEvent = {
    id: `rec-${at}-${Date.now().toString(36)}`,
    label,
    at,
    kind: input.kind ?? "earnings",
    certainty,
    uncertaintyDays: certainty === "projected" ? 7 : 0,
    beforeH: Number.isFinite(input.beforeH) ? (input.beforeH as number) : 4,
    afterH: Number.isFinite(input.afterH) ? (input.afterH as number) : 16,
    recordedAt: Date.now(),
    recordedBy: input.recordedBy ?? "agent",
    sourceUrl,
    note: input.note?.trim() || null,
  };

  const all = readStore(path);

  // A later entry for the same event supersedes the earlier one rather than
  // replacing it. Same kind within a fortnight is treated as the same event.
  for (const prior of all) {
    if (prior.supersededBy) continue;
    if (prior.kind === event.kind && Math.abs(prior.at - event.at) < 14 * 86_400_000) {
      prior.supersededBy = event.id;
    }
  }

  all.push(event);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);

  return { ok: true, event, downgraded };
}

/** The entries actually in force: newest per event, nothing superseded. */
export function activeEvents(path = storePath()): MarketEvent[] {
  return readStore(path)
    .filter((e) => !e.supersededBy)
    .map((e) => ({
      id: e.id,
      label: e.sourceUrl ? e.label : `${e.label} (unsourced)`,
      at: e.at,
      kind: e.kind,
      certainty: e.certainty,
      uncertaintyDays: e.uncertaintyDays,
      beforeH: e.beforeH,
      afterH: e.afterH,
    }));
}

/**
 * Keep a running engine's calendar in step with the file.
 *
 * Server-side only — this module reads `node:fs`, so importing it from anything
 * that reaches the browser bundle breaks the build. That is why the engine
 * takes the calendar through a setter instead of reading the file itself, and
 * why this helper lives here rather than there.
 *
 * Polled rather than watched: fs.watch is unreliable across platforms and
 * network drives, the file changes at most a few times a quarter, and a minute
 * of staleness on an earnings date announced weeks ahead costs nothing.
 */
export function attachCalendar(
  engine: { setCalendar(events: MarketEvent[]): void },
  intervalMs = 60_000,
): () => void {
  const apply = () => {
    try {
      engine.setCalendar(activeEvents());
    } catch {
      /* a bad calendar file leaves the previous one in place */
    }
  };
  apply();
  const timer = setInterval(apply, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
