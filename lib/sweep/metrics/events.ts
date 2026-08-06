/**
 * Scheduled events, and getting out of the way of them.
 *
 * Everything else in this tool reads the order book. An earnings release does
 * not go through the order book — it arrives at 16:05 ET as a number on a press
 * release, and the perp gaps to wherever the number says. A stop placed 3%
 * away, sized against a book that no longer exists, is not a stop; it is a
 * market order that fills wherever the first bid happens to be. Cascade
 * modelling has nothing to say about a gap, because a gap is precisely the case
 * where the intervening levels never trade.
 *
 * So this module's job is to refuse, not to predict. It says nothing about
 * which way a release will go.
 *
 * The dates problem, stated honestly: Intel announces its reporting date a few
 * weeks ahead, and this repository has no live feed to read it from. Projected
 * dates below come from the reporting pattern and carry a week of uncertainty.
 * A week-wide hard blackout would take the tool offline for a third of every
 * quarter, which is not a safety measure, it is a way of guaranteeing the
 * safety measure gets switched off. So the two cases are treated differently:
 *
 *   confirmed  → hard refusal through the window. Nothing trades.
 *   projected  → size derated on a ramp, and a standing prompt to confirm.
 *
 * Confirmed dates are entered by hand or through SWEEP_EVENTS. That is a real
 * operational dependency and it is meant to be visible rather than buried.
 */

export type EventKind = "earnings" | "macro" | "custom";
export type EventCertainty = "confirmed" | "projected";

export interface MarketEvent {
  id: string;
  label: string;
  /** Epoch ms of the release. */
  at: number;
  kind: EventKind;
  certainty: EventCertainty;
  /** Days of slack either side when the date is projected rather than known. */
  uncertaintyDays: number;
  /** Hours before the release that the window opens. */
  beforeH: number;
  /** Hours after the release that it closes. */
  afterH: number;
}

export interface EventRisk {
  next: MarketEvent | null;
  msToNext: number | null;
  /** True only for a confirmed event inside its window. Execution must refuse. */
  blackout: boolean;
  /** 0..1 multiplier applied to position size. */
  sizeScale: number;
  /** Set when something is being refused or derated. */
  reason: string | null;
  /** True when the only thing ahead is a guess, so the operator should confirm. */
  needsConfirmation: boolean;
  notes: string[];
}

export const NO_EVENT_RISK: EventRisk = {
  next: null,
  msToNext: null,
  blackout: false,
  sizeScale: 1,
  reason: null,
  needsConfirmation: false,
  notes: [],
};

/**
 * Confirmed dates. Empty by design.
 *
 * Filling this with dates recalled rather than checked would be worse than
 * leaving it empty: a wrong confirmed date creates a hard blackout on an
 * ordinary day and, far worse, an ordinary day on an earnings date. Add entries
 * from Intel's investor-relations announcement, or set SWEEP_EVENTS.
 *
 *   { id: "intc-q3-2026", label: "Intel Q3 2026 earnings",
 *     at: Date.parse("2026-10-22T20:05:00Z"), kind: "earnings",
 *     certainty: "confirmed", uncertaintyDays: 0, beforeH: 4, afterH: 16 }
 */
export const CONFIRMED_EVENTS: MarketEvent[] = [];

/** Hours either side of a confirmed release that trading is refused. */
const EARNINGS_BEFORE_H = 4;
const EARNINGS_AFTER_H = 16;

/**
 * Intel reports quarterly, after the close, on a Thursday, in the back half of
 * the month following each quarter end. The projection places it on the Thursday
 * of the week containing the 24th, at 16:05 ET.
 *
 * That is a pattern, not a schedule. It has been wrong by a week before and
 * will be again, which is why nothing derived from it is allowed to hard-refuse.
 */
function projectedEarnings(from: number, count = 4): MarketEvent[] {
  const out: MarketEvent[] = [];
  const start = new Date(from);
  let year = start.getUTCFullYear();
  const reportMonths = [0, 3, 6, 9]; // Jan, Apr, Jul, Oct

  for (let guard = 0; out.length < count && guard < 12; guard++) {
    for (const month of reportMonths) {
      // The Thursday of the week containing the 24th.
      const anchor = new Date(Date.UTC(year, month, 24, 20, 5, 0));
      const dow = anchor.getUTCDay(); // 4 = Thursday
      const shift = 4 - dow;
      anchor.setUTCDate(anchor.getUTCDate() + shift);
      const at = anchor.getTime();
      if (at <= from) continue;
      const quarter = ((month + 9) % 12) / 3 + 1; // Jan reports Q4 of the prior year
      out.push({
        id: `intc-proj-${year}-${month}`,
        label: `Intel Q${Math.round(quarter)} earnings (projected)`,
        at,
        kind: "earnings",
        certainty: "projected",
        uncertaintyDays: 7,
        beforeH: EARNINGS_BEFORE_H,
        afterH: EARNINGS_AFTER_H,
      });
      if (out.length >= count) break;
    }
    year++;
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Extra events supplied out of band, as JSON in SWEEP_EVENTS.
 *
 *   SWEEP_EVENTS='[{"label":"Intel Q3","at":"2026-10-22T20:05:00Z","certainty":"confirmed"}]'
 *
 * Anything malformed is dropped with a note rather than throwing: a bad
 * environment variable must not be able to take the monitor down, and a missing
 * event is visible in the panel.
 */
export function parseEnvEvents(raw: string | undefined): { events: MarketEvent[]; error: string | null } {
  if (!raw?.trim()) return { events: [], error: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { events: [], error: "SWEEP_EVENTS is not a JSON array" };
    const events: MarketEvent[] = [];
    parsed.forEach((row, i) => {
      if (typeof row !== "object" || row === null) return;
      const r = row as Record<string, unknown>;
      const at = typeof r.at === "number" ? r.at : Date.parse(String(r.at ?? ""));
      if (!Number.isFinite(at)) return;
      const certainty: EventCertainty = r.certainty === "projected" ? "projected" : "confirmed";
      events.push({
        id: String(r.id ?? `env-${i}-${at}`),
        label: String(r.label ?? "scheduled event"),
        at,
        kind: (r.kind === "macro" || r.kind === "custom" ? r.kind : "earnings") as EventKind,
        certainty,
        uncertaintyDays: Number(r.uncertaintyDays ?? (certainty === "projected" ? 7 : 0)),
        beforeH: Number(r.beforeH ?? EARNINGS_BEFORE_H),
        afterH: Number(r.afterH ?? EARNINGS_AFTER_H),
      });
    });
    return { events, error: null };
  } catch (err) {
    return { events: [], error: `SWEEP_EVENTS could not be parsed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Everything on the calendar, ahead of `now`, soonest first. */
export function calendar(now = Date.now(), extra: MarketEvent[] = []): MarketEvent[] {
  const confirmed = [...CONFIRMED_EVENTS, ...extra].filter((e) => e.at + e.afterH * 3_600_000 > now);
  // A confirmed date supersedes the projection for the same quarter, so drop any
  // projection that lands inside a confirmed event's uncertainty range.
  const projected = projectedEarnings(now).filter(
    (p) => !confirmed.some((c) => c.kind === "earnings" && Math.abs(c.at - p.at) < 21 * 86_400_000),
  );
  return [...confirmed, ...projected].sort((a, b) => a.at - b.at);
}

/**
 * How much of an event is in the way right now.
 *
 * The derate for a projected event ramps rather than switching, over the
 * uncertainty band plus the window. Half size two days out and a quarter the
 * evening before is a plan; full size until an arbitrary cutoff and then
 * nothing is a cliff that will be sitting in the wrong place.
 */
export function eventRisk(now = Date.now(), extra: MarketEvent[] = []): EventRisk {
  const upcoming = calendar(now, extra);
  const next = upcoming[0] ?? null;
  if (!next) {
    return { ...NO_EVENT_RISK, notes: ["nothing on the calendar"] };
  }

  const msToNext = next.at - now;
  const notes: string[] = [];
  const days = msToNext / 86_400_000;

  // Confirmed: a hard window, and nothing trades inside it.
  if (next.certainty === "confirmed") {
    const opens = next.at - next.beforeH * 3_600_000;
    const closes = next.at + next.afterH * 3_600_000;
    if (now >= opens && now <= closes) {
      return {
        next,
        msToNext,
        blackout: true,
        sizeScale: 0,
        reason:
          `${next.label} at ${new Date(next.at).toISOString()} — inside the blackout window. ` +
          `A release gaps the price past every level in the model, so nothing here applies to it.`,
        needsConfirmation: false,
        notes: [`blackout until ${new Date(closes).toISOString()}`],
      };
    }
    // Approaching a known date: taper over the last day.
    if (days > 0 && days < 1) {
      const scale = Math.max(0.25, days);
      return {
        next,
        msToNext,
        blackout: false,
        sizeScale: scale,
        reason: `${next.label} in ${hours(msToNext)} — size scaled to ${(scale * 100).toFixed(0)}%`,
        needsConfirmation: false,
        notes,
      };
    }
    return { next, msToNext, blackout: false, sizeScale: 1, reason: null, needsConfirmation: false, notes: [`next: ${next.label} in ${Math.round(days)}d`] };
  }

  /* -------------------------------------------------------------- projected */

  const band = next.uncertaintyDays;
  notes.push(
    `${next.label} is estimated for ${new Date(next.at).toDateString()} ±${band}d — ` +
      `this is derived from the reporting pattern, not from an announcement`,
  );

  // Outside the uncertainty band entirely: no effect.
  if (days > band) {
    return {
      next,
      msToNext,
      blackout: false,
      sizeScale: 1,
      reason: null,
      needsConfirmation: days < band * 3,
      notes,
    };
  }

  // Inside it: ramp down as the estimate is approached, floor at a quarter.
  // Never zero — a guess should not be able to halt trading outright.
  const proximity = Math.max(0, Math.min(1, (band - Math.abs(days)) / band));
  const scale = Math.max(0.25, 1 - 0.75 * proximity);
  return {
    next,
    msToNext,
    blackout: false,
    sizeScale: scale,
    reason:
      `inside the estimated earnings window for ${next.label} — size scaled to ${(scale * 100).toFixed(0)}%. ` +
      `Confirm the date and add it to SWEEP_EVENTS to get a proper blackout instead of this hedge.`,
    needsConfirmation: true,
    notes,
  };
}

function hours(ms: number): string {
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.round(ms / 60_000)} min` : `${h.toFixed(1)}h`;
}
