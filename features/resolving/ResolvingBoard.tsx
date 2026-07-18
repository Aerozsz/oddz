"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { cn } from "@/lib/utils";

export interface ResolvingItem {
  id: string;
  question: string;
  category: string | null;
  venue: string;
  venueName: string;
  yes: number | null;
  endsAt: string; // ISO
}

/** Venue → the mechanism that settles it. Honest, venue-derived (not per-market). */
const RESOLUTION_SOURCE: Record<string, string> = {
  polymarket: "UMA Oracle",
  kalshi: "Exchange",
  manifold: "Creator",
  metaculus: "Community",
};

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/**
 * Urgency-coded countdown: red + pulse under 1h (act now), normal text under
 * 24h, muted beyond. A wall of identical red timers tells you nothing.
 */
function Countdown({ target }: { target: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const ms = Math.max(0, target - now);
  const h = Math.floor(ms / HOUR);
  const m = Math.floor((ms % HOUR) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const urgent = ms < HOUR;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-xs font-semibold tabular-nums",
        urgent ? "text-neg" : "text-fg-dim",
      )}
    >
      {urgent && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-neg" />}
      {pad(h)}:{pad(m)}:{pad(s)}
    </span>
  );
}

/** Compact inline odds glyph — fixed width, sits next to the number it explains. */
function OddsGlyph({ yes }: { yes: number }) {
  const pct = Math.round(yes * 100);
  return (
    <span className="inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-track" aria-hidden>
      <span style={{ width: `${pct}%` }} className="bg-accent" />
      <span style={{ width: `${100 - pct}%` }} className="bg-neg/60" />
    </span>
  );
}

function Row({ item, showCountdown }: { item: ResolvingItem; showCountdown: boolean }) {
  const target = new Date(item.endsAt).getTime();
  const when = new Date(item.endsAt);
  const pct = item.yes !== null ? Math.round(item.yes * 100) : null;

  return (
    <Link
      href={`/markets/${encodeURIComponent(item.id)}`}
      className="tap flex flex-col gap-2 px-3 py-2.5 hover:bg-[rgb(var(--c-surface-hover))]"
    >
      {/* meta line: when + category | venue */}
      <div className="flex items-center justify-between gap-2">
        {showCountdown ? (
          <Countdown target={target} />
        ) : (
          <span className="font-mono text-[11px] tabular-nums text-muted">
            {when.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
            {" · "}
            {when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        <VenueBadge venue={item.venue} />
      </div>

      <span className="line-clamp-2 text-sm leading-snug text-fg">{item.question}</span>

      {/* data line: the price is the hero */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-baseline gap-2">
          {pct !== null ? (
            <>
              <span className="font-mono text-lg font-semibold tabular-nums text-fg">{pct}%</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                yes
              </span>
              <OddsGlyph yes={item.yes!} />
            </>
          ) : (
            <span className="font-mono text-xs text-muted">no price</span>
          )}
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
          <span className="h-1 w-1 rounded-full bg-muted/60" />
          {item.category ? `${item.category} · ` : ""}
          {RESOLUTION_SOURCE[item.venue] ?? "Venue"}
        </span>
      </div>
    </Link>
  );
}

function Group({
  label,
  items,
  showCountdown,
}: {
  label: string;
  items: ResolvingItem[];
  showCountdown: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section className="min-w-0">
      <h2 className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
        {showCountdown && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-neg" />}
        {label}
        <span className="text-muted/60">({items.length})</span>
      </h2>
      <div className="stagger flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-surface">
        {items.map((it) => (
          <Row key={it.id} item={it} showCountdown={showCountdown} />
        ))}
      </div>
    </section>
  );
}

export function ResolvingBoard({ items }: { items: ResolvingItem[] }) {
  // Bucket once on mount by the same clock the countdowns use.
  const [now] = useState(() => Date.now());
  const today: ResolvingItem[] = [];
  const week: ResolvingItem[] = [];
  const later: ResolvingItem[] = [];
  for (const it of items) {
    const dt = new Date(it.endsAt).getTime() - now;
    if (dt <= DAY) today.push(it);
    else if (dt <= 7 * DAY) week.push(it);
    else later.push(it);
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
        Nothing scheduled to resolve yet.
      </div>
    );
  }

  return (
    <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
      <Group label="Resolving today" items={today} showCountdown />
      <Group label="This week" items={week} showCountdown={false} />
      <Group label="Later" items={later} showCountdown={false} />
    </div>
  );
}
