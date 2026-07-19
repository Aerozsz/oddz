import Link from "next/link";
import { LiveDot, PageHeader } from "@/features/layout/PageHeader";
import { listResolvingSoon } from "@/features/markets/queries";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { formatPct, formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 300;

export const metadata = {
  title: "Resolution calendar",
  description:
    "The economic calendar of prediction markets: settlement dates weighted by the money at stake.",
};

interface DayGroup {
  key: string;
  date: Date;
  volume: number;
  count: number;
  top: Awaited<ReturnType<typeof listResolvingSoon>>;
}

export default async function CalendarPage() {
  const rows = await listResolvingSoon(400);

  // Group by UTC day, keep each day's top-3 by volume.
  const days = new Map<string, DayGroup>();
  for (const r of rows) {
    if (!r.endsAt) continue;
    const d = new Date(r.endsAt);
    const key = d.toISOString().slice(0, 10);
    const g = days.get(key) ?? { key, date: d, volume: 0, count: 0, top: [] };
    g.volume += r.volume ?? 0;
    g.count += 1;
    g.top.push(r);
    days.set(key, g);
  }
  const groups = [...days.values()]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, 21);
  for (const g of groups) {
    g.top.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
    g.top = g.top.slice(0, 3);
  }
  const maxVolume = Math.max(...groups.map((g) => g.volume), 1);
  const totalAtStake = groups.reduce((a, g) => a + g.volume, 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Calendar"
        context={
          <>
            <LiveDot /> {formatUSD(totalAtStake)} settles in this window ·{" "}
            <a href="/api/calendar" className="link normal-case text-accent">
              .ics feed
            </a>
          </>
        }
        blurb={<>The economic calendar of prediction markets: when money settles, day by day. Bar
          length = volume at stake. Subscribe to the .ics feed to get your watchlist&apos;s
          resolution dates in your own calendar.</>}
      />

      {groups.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
          No dated settlements on the books yet.
        </div>
      ) : (
        <div className="stagger flex flex-col gap-2">
          {groups.map((g) => {
            const d = g.date;
            const isToday = g.key === new Date().toISOString().slice(0, 10);
            return (
              <div
                key={g.key}
                className="grid grid-cols-[92px_1fr] items-start gap-4 rounded-lg border border-border bg-surface p-3 sm:grid-cols-[110px_180px_1fr]"
              >
                <div className="flex flex-col">
                  <span className="font-mono text-sm font-semibold tabular-nums text-fg">
                    {d.toLocaleDateString([], { month: "short", day: "numeric" })}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                    {isToday ? (
                      <span className="text-neg">today</span>
                    ) : (
                      d.toLocaleDateString([], { weekday: "long" })
                    )}
                  </span>
                  <span className="mt-1 font-mono text-[11px] tabular-nums text-muted">
                    {g.count} market{g.count === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="hidden flex-col justify-center gap-1 sm:flex">
                  <span className="font-mono text-sm font-semibold tabular-nums text-fg">
                    {formatUSD(g.volume)}
                  </span>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-track">
                    <div
                      className="grow-x h-full rounded-full bg-accent"
                      style={{ width: `${Math.max(3, (g.volume / maxVolume) * 100)}%` }}
                    />
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                    at stake
                  </span>
                </div>
                <div className="flex min-w-0 flex-col divide-y divide-border-subtle">
                  {g.top.map((m) => (
                    <Link
                      key={m.id}
                      href={`/markets/${encodeURIComponent(m.id)}`}
                      className="tap flex items-center justify-between gap-3 py-1.5 hover:text-white"
                    >
                      <span className="line-clamp-1 text-[13px] text-fg">{m.question}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <VenueBadge venue={m.venue} />
                        {m.prices?.[0] !== undefined && (
                          <span className="font-mono text-xs font-semibold tabular-nums text-fg">
                            {formatPct(m.prices[0])}
                          </span>
                        )}
                        <span className="w-16 text-right font-mono text-[11px] tabular-nums text-muted">
                          {formatUSD(m.volume)}
                        </span>
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-muted">
        Volume is each market&apos;s latest reported figure — a size proxy, not guaranteed settled
        amount. The .ics feed covers your watchlist when you have one, otherwise the biggest books.
      </p>
    </div>
  );
}
