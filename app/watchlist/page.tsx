import Link from "next/link";
import { AlertPanel } from "@/features/alerts/AlertPanel";
import { listAndEvaluateAlerts } from "@/features/alerts/queries";
import { getSparklines, listMarkets } from "@/features/markets/queries";
import { WatchCard } from "@/features/watchlist/WatchCard";
import { getWatchedIds, getWid } from "@/features/watchlist/queries";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Watchlist",
};

export default async function WatchlistPage() {
  const wid = await getWid();
  const watchedIds = await getWatchedIds(wid);
  const [rows, alerts] = await Promise.all([
    listMarkets({ ids: Array.from(watchedIds), limit: 100 }),
    listAndEvaluateAlerts(wid),
  ]);
  const sparklines = await getSparklines(
    rows.map((r) => r.id),
    24,
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Watchlist</h1>
        <p className="text-sm text-muted">
          {rows.length === 0
            ? "Your pinned markets, all venues, one screen."
            : `${rows.length} market${rows.length === 1 ? "" : "s"} watched`}
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface p-12 text-center">
          <span className="text-3xl">☆</span>
          <p className="max-w-sm text-sm text-muted">
            Star any market to track it here — current price, trend, and volume for everything you
            care about, on one page.
          </p>
          <Link
            href="/markets"
            className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-bg transition-transform hover:bg-accent-hover hover:scale-[1.03]"
          >
            Browse markets
          </Link>
        </div>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[1fr_280px]">
          <div className="stagger grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((r) => (
              <WatchCard key={r.id} row={r} spark={sparklines.get(r.id) ?? []} />
            ))}
          </div>
          <AlertPanel
            rules={alerts}
            markets={rows.map((r) => ({ id: r.id, question: r.question }))}
          />
        </div>
      )}
    </div>
  );
}
