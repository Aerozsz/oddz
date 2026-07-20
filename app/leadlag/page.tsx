import Link from "next/link";
import { PageHeader } from "@/features/layout/PageHeader";
import { listLeadLag, venueName } from "@/features/leadlag/queries";
import { EdgeFallback } from "@/features/markets/components/EdgeFallback";
import { NearMisses } from "@/features/markets/components/NearMisses";
import { VenueBadge } from "@/features/markets/components/VenueBadge";

export const dynamic = "force-dynamic";
export const revalidate = 120;

export const metadata = {
  title: "Lead / lag",
  description: "Which venue moves first on shared events — the front-running signal.",
};

export default async function LeadLagPage() {
  const rows = await listLeadLag(72, 0.35, 40);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Lead / lag"
        context={<>72h window · ρ ≥ 0.35</>}
        blurb={<>When the same event trades on two venues, one usually moves first. If the leader has
          already repriced, the laggard is where you get in before it catches up. Needs dense price
          history, so this fills in as data accumulates.</>}
      />

      {rows.length === 0 ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            No clear lead/lag relationships yet — this needs many snapshots of the same event on
            two venues, so it sharpens as history accumulates.
          </p>
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <NearMisses lead="Cross-venue pairs being tracked right now" />
            <EdgeFallback stacked />
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead className="bg-zinc-900/60 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left">Event</th>
                <th className="px-3 py-2 text-left">Leader → follower</th>
                <th className="px-3 py-2 text-right">Lag</th>
                <th className="px-3 py-2 text-right">Strength</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.eventId} className="border-t border-border-subtle hover:bg-[rgb(var(--c-surface-hover))]">
                  <td className="px-3 py-2">
                    <Link
                      href={`/events/${encodeURIComponent(r.eventId)}`}
                      className="block text-zinc-100 hover:text-white"
                    >
                      <span className="line-clamp-2">{r.title}</span>
                      {r.category && <span className="text-xs text-zinc-500">{r.category}</span>}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" />
                        <VenueBadge venue={r.leader} name={venueName(r.leader)} />
                      </span>
                      <span className="text-muted">→</span>
                      <VenueBadge venue={r.follower} name={venueName(r.follower)} />
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="font-mono text-sm font-semibold tabular-nums text-fg">
                      ~{r.lagMinutes}m
                    </span>
                    <div className="mt-0.5 text-[10px] text-muted">to catch up</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-2">
                      <span className="inline-flex h-1.5 w-14 overflow-hidden rounded-full bg-track">
                        <span
                          className="grow-x rounded-full bg-accent"
                          style={{ width: `${Math.round(r.correlation * 100)}%` }}
                        />
                      </span>
                      <span className="font-mono text-xs tabular-nums text-muted">
                        ρ {r.correlation.toFixed(2)}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
