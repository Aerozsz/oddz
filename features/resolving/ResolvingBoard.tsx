"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { cn, formatPct } from "@/lib/utils";

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
  kalshi: "Exchange settlement",
  manifold: "Creator resolution",
  metaculus: "Community resolution",
};

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

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
  return (
    <span className="font-mono text-sm font-semibold tabular-nums text-neg">
      {pad(h)}:{pad(m)}:{pad(s)}
    </span>
  );
}

function OddsBar({ yes }: { yes: number }) {
  const pct = Math.round(yes * 100);
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-track">
      <div style={{ width: `${pct}%`, backgroundColor: "rgb(var(--c-accent))" }} />
      <div style={{ width: `${100 - pct}%`, backgroundColor: "rgb(var(--c-neg))" }} />
    </div>
  );
}

function Row({ item, showCountdown }: { item: ResolvingItem; showCountdown: boolean }) {
  const target = new Date(item.endsAt).getTime();
  const when = new Date(item.endsAt);
  return (
    <Link
      href={`/markets/${encodeURIComponent(item.id)}`}
      className="flex flex-col gap-2 px-3 py-3 hover:bg-[rgb(var(--c-surface-hover))]"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="line-clamp-2 text-sm text-fg">{item.question}</span>
        {showCountdown ? (
          <Countdown target={target} />
        ) : (
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
            {when.toLocaleDateString([], { month: "short", day: "numeric" })}{" "}
            {when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
      {item.yes !== null && <OddsBar yes={item.yes} />}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <VenueBadge venue={item.venue} name={item.venueName} />
          {item.yes !== null && (
            <span className="font-mono text-xs tabular-nums text-muted">
              YES {formatPct(item.yes)}
            </span>
          )}
        </div>
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
          {RESOLUTION_SOURCE[item.venue] ?? "Venue settled"}
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
    <section>
      <h2 className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
        {showCountdown && <span className="h-1.5 w-1.5 rounded-full bg-neg" />}
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
    <div className={cn("grid items-start gap-4 lg:grid-cols-3")}>
      <Group label="Resolving today" items={today} showCountdown />
      <Group label="This week" items={week} showCountdown={false} />
      <Group label="Later" items={later} showCountdown={false} />
    </div>
  );
}
