import Link from "next/link";
import { listNewMarkets } from "@/features/markets/queries";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { formatPct, formatUSD, timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "New markets",
  description: "The most recently listed prediction markets across every venue — early positioning.",
};

export default async function NewMarketsPage() {
  const rows = await listNewMarkets(80);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New markets</h1>
        <p className="text-sm text-muted">
          Freshly listed across every venue — get positioned before the liquidity arrives.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
          No new markets yet.
        </div>
      ) : (
        <ol className="stagger grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <li key={r.id} className="relative flex gap-3 pl-1">
              {/* timeline marker: green dot */}
              <div className="relative flex w-3 shrink-0 justify-center pt-4">
                <span className="h-2.5 w-2.5 rounded-full bg-accent ring-4 ring-[rgb(var(--c-bg))]" />
              </div>
              <Link
                href={`/markets/${encodeURIComponent(r.id)}`}
                className="lift group flex flex-1 flex-col gap-2 rounded-lg border border-border bg-surface p-3 hover:border-[rgb(var(--c-accent))]/40"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="line-clamp-2 text-sm text-fg">{r.question}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted">
                    {r.createdAt ? timeAgo(r.createdAt) : "—"}
                  </span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
                  <VenueBadge venue={r.venue} name={r.venueName} />
                  {r.category && <span className="truncate">{r.category}</span>}
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  {r.prices?.[0] !== undefined ? (
                    <span className="flex items-baseline gap-1.5">
                      <span className="font-mono text-lg font-semibold tabular-nums text-fg">
                        {formatPct(r.prices[0])}
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                        yes
                      </span>
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-muted">no price yet</span>
                  )}
                  <span className="font-mono text-[11px] tabular-nums text-muted">
                    {r.liquidity != null && <>{formatUSD(r.liquidity)} liq</>}
                    {r.liquidity != null && r.volume != null && " · "}
                    {r.volume != null && <>{formatUSD(r.volume)} vol</>}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
