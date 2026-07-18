import Link from "next/link";
import { listLeadLag, venueName } from "@/features/leadlag/queries";
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Lead / lag</h1>
        <p className="max-w-2xl text-sm text-zinc-500">
          When the same event trades on two venues, one usually moves first. If the leader has
          already repriced, the laggard is where you get in before it catches up. Needs dense price
          history, so this fills in as data accumulates.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-border bg-surface p-6 text-sm text-muted">
            No clear lead/lag relationships yet — this needs many snapshots of the same event on
            two venues, so it sharpens as history accumulates.
          </div>
          <NearMisses lead="Cross-venue pairs being tracked right now" />
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
                      <VenueBadge venue={r.leader} name={venueName(r.leader)} />
                      <span className="text-zinc-600">→</span>
                      <VenueBadge venue={r.follower} name={venueName(r.follower)} />
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-300">~{r.lagMinutes}m</td>
                  <td className="px-3 py-2 text-right font-mono text-emerald-300">
                    {(r.correlation * 100).toFixed(0)}%
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
