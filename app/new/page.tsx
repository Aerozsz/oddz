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
        <ol className="relative flex flex-col">
          {rows.map((r) => (
            <li key={r.id} className="relative flex gap-4 pb-5 pl-1 last:pb-0">
              {/* timeline rail: green dot + connector */}
              <div className="relative flex w-3 shrink-0 justify-center">
                <span className="absolute top-1 h-2.5 w-2.5 rounded-full bg-accent ring-4 ring-[rgb(var(--c-bg))]" />
                <span className="absolute top-3 h-full w-px bg-border-subtle" />
              </div>
              <Link
                href={`/markets/${encodeURIComponent(r.id)}`}
                className="group flex flex-1 flex-col gap-2 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-[rgb(var(--c-accent))]/40 hover:bg-[rgb(var(--c-surface-hover))]"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="line-clamp-2 text-sm text-fg">{r.question}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted">
                    {r.createdAt ? timeAgo(r.createdAt) : "—"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted">
                  <VenueBadge venue={r.venue} name={r.venueName} />
                  {r.category && <span>{r.category}</span>}
                  {r.prices?.[0] !== undefined && (
                    <span>
                      <span className="text-muted/70">odds </span>
                      <span className="text-accent">{formatPct(r.prices[0])}</span>
                    </span>
                  )}
                  {r.liquidity != null && (
                    <span>
                      <span className="text-muted/70">liquidity </span>
                      <span className="text-fg">{formatUSD(r.liquidity)}</span>
                    </span>
                  )}
                  {r.volume != null && (
                    <span>
                      <span className="text-muted/70">volume </span>
                      <span className="text-fg">{formatUSD(r.volume)}</span>
                    </span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
