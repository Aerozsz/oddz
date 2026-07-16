"use client";

import { useState } from "react";
import { cn, formatUSD } from "@/lib/utils";

export interface VenueQuote {
  venue: string;
  venueName: string;
  yes: number; // 0..1
  sourceUrl: string;
}

/**
 * The "what you'd win" flow. Binary outcome: buying a side at price p for
 * stake S yields S/p shares, each worth $1 if it hits — payout S/p, profit
 * S/p - S. Because we aggregate, we show the SAME bet across every venue
 * and highlight the one that pays most (cheapest price for your side).
 * This is the thing Polymarket structurally can't show you.
 */
export function PayoutCalculator({
  quotes,
  outcomes,
}: {
  quotes: VenueQuote[];
  outcomes: string[];
}) {
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [stake, setStake] = useState(100);

  const yesLabel = outcomes[0] ?? "YES";
  const noLabel = outcomes[1] ?? "NO";

  const priced = quotes
    .filter((q) => q.yes > 0 && q.yes < 1)
    .map((q) => {
      const price = side === "yes" ? q.yes : 1 - q.yes;
      const shares = stake / price;
      const payout = shares; // $1 per share on resolution
      return { ...q, price, payout, profit: payout - stake };
    })
    .sort((a, b) => b.payout - a.payout); // best payout first

  const best = priced[0];

  return (
    <div className="flex flex-col gap-4 rounded border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded border border-zinc-700">
          <button
            onClick={() => setSide("yes")}
            className={cn(
              "px-3 py-1.5 text-sm font-medium transition-colors",
              side === "yes" ? "bg-emerald-500 text-zinc-950" : "text-zinc-300 hover:bg-zinc-800",
            )}
          >
            {yesLabel}
          </button>
          <button
            onClick={() => setSide("no")}
            className={cn(
              "px-3 py-1.5 text-sm font-medium transition-colors",
              side === "no" ? "bg-red-500 text-zinc-950" : "text-zinc-300 hover:bg-zinc-800",
            )}
          >
            {noLabel}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-400">Stake</span>
          <div className="flex items-center rounded border border-zinc-700 bg-zinc-900 px-2">
            <span className="text-zinc-500">$</span>
            <input
              type="number"
              min={1}
              value={stake}
              onChange={(e) => setStake(Math.max(0, Number(e.target.value)))}
              className="w-24 bg-transparent px-1 py-1.5 text-sm text-zinc-100 focus:outline-none"
            />
          </div>
          {[50, 100, 500, 1000].map((v) => (
            <button
              key={v}
              onClick={() => setStake(v)}
              className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:border-zinc-600"
            >
              ${v}
            </button>
          ))}
        </div>
      </div>

      {best ? (
        <>
          <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-3">
            <div className="text-xs text-emerald-300/80">
              Best payout — {side === "yes" ? yesLabel : noLabel} on {best.venueName}
            </div>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="font-mono text-3xl font-semibold text-emerald-300">
                {formatUSD(best.payout)}
              </span>
              <span className="text-sm text-zinc-400">
                if it hits · <span className="text-emerald-400">+{formatUSD(best.profit)}</span>{" "}
                profit ({((best.profit / stake) * 100).toFixed(0)}%)
              </span>
            </div>
          </div>

          {priced.length > 1 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[380px] border-collapse text-sm">
                <thead className="text-xs uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="py-1 text-left">Venue</th>
                    <th className="py-1 text-right">Price</th>
                    <th className="py-1 text-right">Payout</th>
                    <th className="py-1 text-right">vs best</th>
                  </tr>
                </thead>
                <tbody>
                  {priced.map((q) => (
                    <tr key={q.venue} className="border-t border-zinc-800/70">
                      <td className="py-1.5">
                        <a
                          href={q.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-zinc-300 hover:text-white"
                        >
                          {q.venueName}
                        </a>
                      </td>
                      <td className="py-1.5 text-right font-mono text-zinc-400">
                        {(q.price * 100).toFixed(1)}%
                      </td>
                      <td className="py-1.5 text-right font-mono text-zinc-200">
                        {formatUSD(q.payout)}
                      </td>
                      <td className="py-1.5 text-right font-mono text-zinc-500">
                        {q.venue === best.venue ? "—" : `-${formatUSD(best.payout - q.payout)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-zinc-500">
            Payout is gross of venue fees and assumes fills at the shown price. Shares pay $1 each on
            a winning resolution.
          </p>
        </>
      ) : (
        <p className="text-sm text-zinc-500">No priced venues for this market yet.</p>
      )}
    </div>
  );
}
