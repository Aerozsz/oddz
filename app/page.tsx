import Link from "next/link";
import { sql } from "drizzle-orm";
import { SubscribeForm } from "@/features/subscribe/SubscribeForm";
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

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Daily markets-to-watch digest</h2>
        <p className="max-w-2xl text-sm text-zinc-400">
          The biggest odds moves and cross-venue divergences, in your inbox before the market
          reacts. Free while in beta.
        </p>
        <SubscribeForm />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold tracking-tight">Pricing</h2>
        <div className="grid gap-6 sm:grid-cols-3">
          <PriceCard
            name="Free"
            price="$0"
            features={["Full market aggregation", "Divergence view", "7-day price history", "API: 60 req/hour"]}
          />
          <PriceCard
            name="Trader"
            price="$29/mo"
            badge="Coming soon"
            features={["Everything in Free", "Odds-move alerts", "90-day history", "Watchlists"]}
          />
          <PriceCard
            name="API"
            price="$99/mo"
            badge="Coming soon"
            features={["Everything in Trader", "API: 3,600 req/hour", "Bulk history export", "Priority support"]}
          />
        </div>
      </section>
    </div>
  );
}

function PriceCard({
  name,
  price,
  features,
  badge,
}: {
  name: string;
  price: string;
  features: string[];
  badge?: string;
}) {
  return (
    <div className="flex flex-col gap-3 rounded border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">{name}</h3>
        {badge && (
          <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{badge}</span>
        )}
      </div>
      <div className="font-mono text-2xl text-zinc-100">{price}</div>
      <ul className="flex flex-col gap-1 text-sm text-zinc-400">
        {features.map((f) => (
          <li key={f}>· {f}</li>
        ))}
      </ul>
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
