import { freshnessByVenue, recentRuns, snapshotCount, venueCounts } from "@/features/status/queries";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 30;

export default async function StatusPage() {
  const [runs, counts, snaps, freshness] = await Promise.all([
    recentRuns(10),
    venueCounts(),
    snapshotCount(),
    freshnessByVenue(),
  ]);

  const freshnessByVenueMap = new Map(freshness.map((f) => [f.venue, f.latestSnapshot]));
  const totalMarkets = counts.reduce((acc, c) => acc + c.total, 0);

  // Venues failing in >=3 consecutive recent runs get a visible alert.
  const failing: string[] = [];
  const venueSlugs = new Set(runs.flatMap((r) => Object.keys(r.stats)));
  for (const venue of venueSlugs) {
    let consecutive = 0;
    for (const r of runs) {
      const s = r.stats[venue];
      if (s?.error) consecutive++;
      else break;
    }
    if (consecutive >= 3) failing.push(venue);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">System status</h1>
        <p className="text-sm text-zinc-500">
          {totalMarkets.toLocaleString()} markets · {snaps.toLocaleString()} snapshots stored
        </p>
      </div>

      {failing.length > 0 && (
        <div className="rounded border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <strong className="font-medium">Ingestion degraded:</strong>{" "}
          {failing.join(", ")} failing for 3+ consecutive runs. Check the error
          chips below — most often an upstream API change or rate limit.
        </div>
      )}

      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
          Per-venue freshness
        </h2>
        <div className="overflow-hidden rounded border border-zinc-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left">Venue</th>
                <th className="px-3 py-2 text-right">Markets</th>
                <th className="px-3 py-2 text-right">Open</th>
                <th className="px-3 py-2 text-right">Latest market</th>
                <th className="px-3 py-2 text-right">Latest snapshot</th>
              </tr>
            </thead>
            <tbody>
              {counts.map((c) => (
                <tr key={c.venue} className="border-t border-zinc-800">
                  <td className="px-3 py-2">
                    <VenueBadge venue={c.venue} />
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-300">{c.total}</td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-300">{c.open}</td>
                  <td className="px-3 py-2 text-right text-xs text-zinc-500">
                    {c.latestSeen ? timeAgo(c.latestSeen) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-zinc-500">
                    {(() => {
                      const t = freshnessByVenueMap.get(c.venue);
                      return t ? timeAgo(t) : "—";
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
          Last 10 snapshot runs
        </h2>
        <div className="overflow-hidden rounded border border-zinc-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left">Run</th>
                <th className="px-3 py-2 text-left">Started</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Per-venue (fetched / written)</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-sm text-zinc-500">
                    No runs yet. Trigger one with{" "}
                    <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs">
                      npm run snapshot:once
                    </code>
                    .
                  </td>
                </tr>
              ) : (
                runs.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-800 align-top">
                    <td className="px-3 py-2 font-mono text-xs text-zinc-400">#{r.id}</td>
                    <td className="px-3 py-2 text-xs text-zinc-500">{timeAgo(r.startedAt)}</td>
                    <td className="px-3 py-2">
                      <StatusPill status={r.status} />
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(r.stats).map(([venue, s]) => (
                          <span
                            key={venue}
                            className={
                              s.error
                                ? "rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-red-300"
                                : "rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-zinc-300"
                            }
                            title={s.error ?? (s.truncated ? "coverage truncated — more markets available" : "")}
                          >
                            {venue}: {s.fetched}/{s.written}
                            {s.truncated && <span className="text-amber-300"> ⚠</span>}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "ok"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : status === "running"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
        : "border-red-500/40 bg-red-500/10 text-red-300";
  return (
    <span className={`inline-flex rounded border px-2 py-0.5 text-xs ${cls}`}>{status}</span>
  );
}
