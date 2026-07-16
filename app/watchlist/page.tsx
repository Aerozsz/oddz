import Link from "next/link";
import { MarketTable } from "@/features/markets/components/MarketTable";
import { getSparklines, listMarkets } from "@/features/markets/queries";
import { getWatchedIds, getWid } from "@/features/watchlist/queries";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Watchlist",
};

export default async function WatchlistPage() {
  const wid = await getWid();
  const watchedIds = await getWatchedIds(wid);
  const rows = await listMarkets({ ids: Array.from(watchedIds), limit: 100 });
  const sparklines = await getSparklines(
    rows.map((r) => r.id),
    24,
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Watchlist</h1>
        <p className="text-sm text-zinc-500">
          {rows.length === 0
            ? "Your pinned markets, all venues, one screen."
            : `${rows.length} market${rows.length === 1 ? "" : "s"} watched`}
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded border border-zinc-800 bg-zinc-900/40 p-12 text-center">
          <span className="text-3xl">☆</span>
          <p className="max-w-sm text-sm text-zinc-400">
            Star any market to track it here — current price, trend, and volume for everything you
            care about, on one page.
          </p>
          <Link
            href="/markets"
            className="rounded bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400"
          >
            Browse markets
          </Link>
        </div>
      ) : (
        <MarketTable rows={rows} sparklines={sparklines} watchedIds={watchedIds} />
      )}
    </div>
  );
}
