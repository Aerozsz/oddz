import Link from "next/link";
import { MarketTable } from "@/features/markets/components/MarketTable";
import { getSparklines, listMarkets } from "@/features/markets/queries";
import { getOverview } from "@/features/overview/queries";
import { getWatchedIds, getWid } from "@/features/watchlist/queries";
import { formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const name = decodeURIComponent(slug);
  return { title: name.charAt(0).toUpperCase() + name.slice(1) };
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const category = decodeURIComponent(slug).toLowerCase();

  const [overview, rows] = await Promise.all([
    getOverview(),
    listMarkets({ category, sort: "volume", limit: 60 }),
  ]);
  const stat = overview.categories.find((c) => c.category === category);
  const sparklines = await getSparklines(rows.map((r) => r.id), 24);
  const watchedIds = await getWid().then(getWatchedIds);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold capitalize tracking-tight">{category}</h1>
        <p className="text-sm text-zinc-500">Every market in {category}, across all venues.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
        <Stat label="Volume" value={formatUSD(stat?.volume ?? 0)} />
        <Stat label="Markets" value={String(stat?.markets ?? rows.length)} />
      </div>

      <MarketTable rows={rows} sparklines={sparklines} watchedIds={watchedIds} />

      <Link href="/overview" className="text-xs text-emerald-400 hover:text-emerald-300">
        ← All categories
      </Link>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-xl text-zinc-100">{value}</div>
    </div>
  );
}
