import { MarketTable } from "@/features/markets/components/MarketTable";
import { getSparklines, listNewMarkets } from "@/features/markets/queries";
import { getWatchedIds, getWid } from "@/features/watchlist/queries";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "New markets",
  description: "The most recently listed prediction markets across every venue — early positioning.",
};

export default async function NewMarketsPage() {
  const rows = await listNewMarkets(80);
  const [sparklines, watchedIds] = await Promise.all([
    getSparklines(rows.map((r) => r.id), 24),
    getWid().then(getWatchedIds),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New markets</h1>
        <p className="text-sm text-zinc-500">
          Freshly listed across every venue — get positioned before the liquidity arrives.
        </p>
      </div>
      <MarketTable rows={rows} sparklines={sparklines} watchedIds={watchedIds} />
    </div>
  );
}
