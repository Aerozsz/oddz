"use client";

import { useEffect, useState } from "react";
import type { NewsItem } from "@/lib/sweep/metrics/news-store";

/**
 * What is being said, next to what the book is doing.
 *
 * This is the only panel here not derived from market data, and the reason it
 * earns a place is narrow: an identical depth withdrawal means two different
 * things depending on whether something happened. One mean-reverts and the
 * other does not, and nothing in the order book tells them apart. The operator
 * can make that call in a second given the headline and cannot make it at all
 * without one.
 *
 * What it deliberately does not do is feed anything. No signal, no sizing, no
 * bias factor reads this. Prose does not have a timestamp you can trust or a
 * magnitude you can measure, and wiring it into a model would import both
 * problems into the part of the system that is currently checkable.
 */
export default function NewsPanel({ symbol }: { symbol: string }) {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/sweep/news?symbol=${encodeURIComponent(symbol)}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { items: NewsItem[] };
        if (!live) return;
        setItems(data.items ?? []);
        setFailed(false);
      } catch {
        if (live) setFailed(true);
      }
    };
    void load();
    // A minute is the right cadence: the store is written by an agent on its
    // own schedule, and polling faster only spends requests to see the same
    // list again.
    const timer = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [symbol]);

  return (
    <section className="panel news-panel">
      <header>
        <h2>What is being said</h2>
        <span className="sub">context for the book, not an input to it</span>
      </header>

      {failed && items === null ? (
        <p className="empty">Feed unavailable. Everything else on this page is unaffected.</p>
      ) : items === null ? (
        <p className="empty">Loading…</p>
      ) : items.length === 0 ? (
        <p className="empty">
          Nothing recorded for {symbol}. Items arrive when the agent finds and records them —
          an empty feed means nothing has been collected, not that nothing has happened.
        </p>
      ) : (
        <ul className="news-list">
          {items.map((item) => (
            <NewsRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ago(t: number): string {
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function NewsRow({ item }: { item: NewsItem }) {
  const impactVar =
    item.impact === "high" ? "var(--critical)" : item.impact === "medium" ? "var(--warning)" : "var(--ink-2)";

  return (
    <li className={`news-item ${item.impact}`}>
      <div className="news-head">
        <span className="news-impact" style={{ color: impactVar }}>
          {item.impact}
        </span>
        <span className="sub">{ago(item.at)}</span>
        {item.direction && (
          <span className="sub" style={{ color: item.direction === "up" ? "var(--good)" : "var(--bad)" }}>
            reads {item.direction}
          </span>
        )}
        {item.symbols.length > 0 && <span className="sub">{item.symbols.join(", ")}</span>}
        {/* An unattributable headline is a rumour and reads as one. */}
        {!item.sourceUrl && <span className="sub news-unsourced">unsourced</span>}
      </div>
      <div className="news-headline">
        {item.sourceUrl ? (
          <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
            {item.headline}
          </a>
        ) : (
          item.headline
        )}
      </div>
      {item.summary && <div className="sub news-summary">{item.summary}</div>}
    </li>
  );
}
