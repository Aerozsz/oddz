import { MarketTable } from "@/features/markets/components/MarketTable";
import { getSparklines, listResolvingSoon } from "@/features/markets/queries";
import { getWatchedIds, getWid } from "@/features/watchlist/queries";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "Resolving soon",
  description: "Prediction markets closest to resolution, across every venue.",
};

export default async function ResolvingPage() {
  const rows = await listResolvingSoon(80);
  const [sparklines, watchedIds] = await Promise.all([
    getSparklines(rows.map((r) => r.id), 24),
    getWid().then(getWatchedIds),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Resolving soon</h1>
        <p className="text-sm text-zinc-500">
          Markets closest to settlement — where the clock creates the edge.
        </p>
      </div>
      <MarketTable rows={rows} sparklines={sparklines} watchedIds={watchedIds} />
    </div>
  );
}
