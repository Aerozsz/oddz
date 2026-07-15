import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { markets, priceSnapshots } from "@/lib/db/schema";

export const dynamic = "force-dynamic";
export const revalidate = 60;

async function stats() {
  try {
    const [[m], [s]] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(markets)
        .where(sql`${markets.closed} = 0`),
      db.select({ n: sql<number>`count(*)::int` }).from(priceSnapshots),
    ]);
    return { markets: m?.n ?? 0, snapshots: s?.n ?? 0 };
  } catch {
    return { markets: 0, snapshots: 0 };
  }
}

export default async function HomePage() {
  const { markets: marketCount, snapshots } = await stats();
  return (
    <div className="flex flex-col gap-10 py-10">
      <section className="flex flex-col gap-4">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Every prediction market.<br />One screen.
        </h1>
        <p className="max-w-2xl text-lg text-zinc-400">
          Live odds across Polymarket, Kalshi, Manifold and Metaculus. Spot
          relative value before the rest of the market does.
        </p>
        <div className="flex gap-3">
          <Link
            href="/markets"
            className="rounded bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400"
          >
            Browse markets
          </Link>
          <Link
            href="/divergence"
            className="rounded border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-500"
          >
            See divergences
          </Link>
        </div>
      </section>

      {marketCount > 0 && (
        <section className="flex flex-wrap gap-6 text-sm text-zinc-400">
          <div>
            <span className="font-mono text-2xl text-zinc-100">{marketCount.toLocaleString()}</span>{" "}
            live markets
          </div>
          <div>
            <span className="font-mono text-2xl text-zinc-100">4</span> venues
          </div>
          <div>
            <span className="font-mono text-2xl text-zinc-100">{snapshots.toLocaleString()}</span>{" "}
            price snapshots stored
          </div>
        </section>
      )}

      <section className="grid gap-6 sm:grid-cols-3">
        <Card title="Aggregated">
          Hundreds of live markets across four venues, one search box, sorted by volume.
        </Card>
        <Card title="Divergence">
          When the same event trades on Polymarket and Kalshi at different prices, that's the trade.
        </Card>
        <Card title="History">
          Every snapshot stored. Odds drift over time, fully queryable. Public JSON API.
        </Card>
      </section>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="mb-2 text-sm font-medium text-zinc-200">{title}</h3>
      <p className="text-sm text-zinc-400">{children}</p>
    </div>
  );
}
