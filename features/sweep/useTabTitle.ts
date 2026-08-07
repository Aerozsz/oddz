"use client";

import { useEffect } from "react";
import type { Snapshot } from "@/lib/sweep/types";

/**
 * Put the price in the browser tab.
 *
 * The tab title is read peripherally — glanced at from another window, or
 * recognised as a shape while switching — which drives every decision here and
 * makes it a different problem from the display on the page.
 *
 * Price first, because tabs truncate from the right. A title of
 * "Liquidity sweep monitor — INTC 30.42" is, at the width a browser actually
 * gives a background tab, "Liquidity sweep m…", which is the one arrangement
 * that shows nothing worth having.
 *
 * And when the feed is not live the price is dropped rather than frozen. A
 * number glanced at in a tab is assumed to be current — that is the entire
 * reason to put it there — so a stale one is worse than none, and the failure
 * is silent in a way the page itself is not: the dashboard shows a red
 * connection dot next to its price, and the tab has no room for the dot.
 */
export function useTabTitle(snap: Snapshot, symbol: string, base: string) {
  const precision = snap.meta?.pricePrecision ?? 2;
  const shown = snap.last ?? snap.mid;
  const conn = snap.connection;

  /*
   * A far more forgiving silence window than the page uses.
   *
   * The top bar calls the feed stalled after five seconds, which is right for
   * a number someone is watching. Applied to the tab it would flicker between
   * a price and "no data" all through a quiet overnight session on a thin
   * book — and a title that changes twice a minute is noise in the corner of
   * the eye whichever state it lands on. Thirty seconds is long enough that
   * only a real outage reaches it.
   */
  const silentMs = conn.lastMessageAt > 0 ? snap.ts - conn.lastMessageAt : 0;
  const live = conn.socket === "open" && conn.bookSynced && silentMs < 30_000;

  // "INTCUSDT" is four characters of quote currency that never change, spent
  // in the one place where characters are scarcest.
  // Preferring the exchange's own answer over the configured one, so a symbol
  // overridden at run time is not labelled with the default.
  const full = snap.meta?.symbol ?? symbol;
  const ticker = full.replace(/USDT$|USDC$/, "") || full;

  const title =
    live && shown !== null && shown > 0
      ? `${shown.toFixed(precision)} ${ticker}`
      : `${ticker} — no data`;

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = title;
  }, [title]);

  // Restore on unmount so navigating away does not leave a stale price in the
  // tab of whatever page comes next. Separate from the effect above so it runs
  // once rather than on every tick.
  useEffect(() => {
    return () => {
      if (typeof document !== "undefined") document.title = base;
    };
  }, [base]);
}
