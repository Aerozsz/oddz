import { CONFIG } from "../config";
import type { BookLevel, CascadeLink, CascadePath, Cluster, Direction } from "../types";
import { tailDensity } from "./depth";

/**
 * The sequence, run forward on live data.
 *
 * A seed order walks the book until it reaches the nearest amplifying cluster.
 * That cluster discharges forced flow in the same direction, which walks the
 * book further; if it reaches the next cluster, that one discharges too. The
 * chain ends when flow runs out before the next level, or when there are no
 * levels left in that direction.
 *
 * Two things make this reflexive rather than additive. Each discharge is spent
 * from a book that the previous discharge already thinned, so the same notional
 * travels further each time. And the book being walked is the live one — when
 * depth is withdrawn, every link in the chain gets cheaper at once, which is
 * why the seed size shown here moves so much faster than price does.
 *
 * Absorbing liquidity needs no separate term: resting bids are what a downward
 * walk consumes, so walls are already priced in by walking the real book.
 * Past the last posted level nothing is observable, so the walk switches to a
 * decaying density estimate and the portion that came from it is reported.
 */

interface Cumulative {
  prices: number[];
  cums: number[];
  total: number;
  edge: number;
  density: number;
}

function cumulative(levels: BookLevel[], mid: number, side: "bid" | "ask"): Cumulative {
  const prices: number[] = [];
  const cums: number[] = [];
  let run = 0;
  for (const l of levels) {
    run += l.price * l.qty;
    prices.push(l.price);
    cums.push(run);
  }
  return {
    prices,
    cums,
    total: run,
    edge: prices.length ? prices[prices.length - 1] : mid,
    density: tailDensity(levels, mid, side),
  };
}

function bpsBetween(from: number, to: number) {
  return Math.abs((to - from) / from) * 10_000;
}

/** Notional needed to walk from `from` to `to`, split into posted and modelled. */
function costBetween(
  c: Cumulative,
  from: number,
  to: number,
  dir: Direction,
  thinness: number,
): { posted: number; modelled: number } {
  const at = (price: number) => {
    let i = 0;
    while (
      i < c.prices.length &&
      (dir === "down" ? c.prices[i] >= price : c.prices[i] <= price)
    ) {
      i++;
    }
    return i > 0 ? c.cums[i - 1] : 0;
  };

  const beyondEdge = dir === "down" ? to < c.edge : to > c.edge;
  const fromCum = at(from);
  if (!beyondEdge) {
    return { posted: Math.max(0, at(to) - fromCum), modelled: 0 };
  }
  const posted = Math.max(0, c.total - fromCum);
  const modelled = costOfBps(bpsBetween(c.edge, to), c.density * thinness);
  return { posted, modelled };
}

/** Cost of travelling `bps` past the end of the book, at a decaying density. */
function costOfBps(bps: number, density: number): number {
  if (density <= 0) return Number.POSITIVE_INFINITY;
  let remaining = bps;
  let cost = 0;
  let k = 0;
  while (remaining > 0 && k < 200) {
    const step = Math.min(10, remaining);
    cost += density * Math.pow(CONFIG.tailDecayPer10Bp, k) * step;
    remaining -= step;
    k++;
  }
  return cost;
}

/** Inverse of the above: how far `flow` carries past the end of the book. */
function bpsForFlow(flow: number, density: number): number {
  if (density <= 0) return 2000;
  let remaining = flow;
  let bps = 0;
  let k = 0;
  while (remaining > 0 && k < 200) {
    const stepCost = density * Math.pow(CONFIG.tailDecayPer10Bp, k) * 10;
    if (remaining < stepCost) return bps + (remaining / stepCost) * 10;
    remaining -= stepCost;
    bps += 10;
    k++;
  }
  return bps;
}

/** Price reached when `flow` is spent walking from `from`. */
function priceForFlow(
  c: Cumulative,
  from: number,
  flow: number,
  dir: Direction,
  thinness: number,
): number {
  let i = 0;
  while (
    i < c.prices.length &&
    (dir === "down" ? c.prices[i] >= from : c.prices[i] <= from)
  ) {
    i++;
  }
  const startCum = i > 0 ? c.cums[i - 1] : 0;
  const target = startCum + flow;
  if (target <= c.total) {
    let j = i;
    while (j < c.cums.length && c.cums[j] < target) j++;
    return c.prices[Math.min(j, c.prices.length - 1)] ?? from;
  }
  const extraBps = bpsForFlow(target - c.total, c.density * thinness);
  return dir === "down"
    ? c.edge * (1 - extraBps / 10_000)
    : c.edge * (1 + extraBps / 10_000);
}

export interface CascadeInputs {
  bids: BookLevel[];
  asks: BookLevel[];
  mid: number;
  clusters: Cluster[];
  /**
   * Depth over baseline, per side. A downward walk consumes bids and an upward
   * walk consumes asks, so each direction is scored against the side it would
   * actually have to eat through. Using a combined figure for both made a
   * one-sided withdrawal — the floor disappearing while offers stay put — raise
   * the upside score just as much as the downside one, which is exactly
   * backwards: bids leaving makes a move *down* cheap, not a move up.
   */
  lwiBid: number;
  lwiAsk: number;
  openInterestNotional: number;
}

export function simulate(input: CascadeInputs, dir: Direction): CascadePath | null {
  const { mid, clusters } = input;
  const lwi = dir === "down" ? input.lwiBid : input.lwiAsk;
  if (!mid) return null;

  const levels = dir === "down" ? input.bids : input.asks;
  if (levels.length < 5) return null;
  const c = cumulative(levels, mid, dir === "down" ? "bid" : "ask");

  // Withdrawal does not stop at the edge of what we can see. If the visible
  // band is at 40% of its baseline, the unobservable tail is treated as thin
  // too — assuming a normal tail under a thin book is the error that makes
  // sweeps look impossible right up until they happen.
  const thinness = Math.min(1.5, Math.max(0.2, lwi));

  const ahead = clusters
    .filter((cl) => cl.effect === "amplifying" && cl.pushes === dir && cl.notional > 0)
    .filter((cl) => (dir === "down" ? cl.price < mid : cl.price > mid))
    .sort((a, b) => (dir === "down" ? b.price - a.price : a.price - b.price));

  if (!ahead.length) return null;

  const links: CascadeLink[] = [];
  let price = mid;
  let flow = 0;
  let seed = 0;

  for (const cluster of ahead) {
    if (links.length >= CONFIG.maxCascadeLinks) break;
    const { posted, modelled } = costBetween(c, price, cluster.price, dir, thinness);
    const cost = posted + modelled;
    if (!Number.isFinite(cost)) break;

    if (links.length === 0) {
      // The first link is what the seed order has to pay for.
      seed = cost;
    } else if (flow < cost) {
      // Chain breaks: the previous discharge could not reach this level.
      break;
    } else {
      flow -= cost;
    }

    const released = cluster.notional;
    flow += released;
    const after = priceForFlow(c, cluster.price, flow, dir, thinness);

    links.push({
      cluster,
      costToReach: cost,
      modelledPortion: modelled,
      released,
      priceAfter: after,
    });
    price = cluster.price;
  }

  if (!links.length) return null;

  const terminalPrice = links[links.length - 1].priceAfter;
  const terminalPct = ((terminalPrice - mid) / mid) * 100;

  // Reference size for "is this seed small?" — half a percent of open interest,
  // floored so a quiet book doesn't make every order look enormous.
  const ref = Math.max(20_000, input.openInterestNotional * 0.005);
  const cheapness = clamp(1 - seed / (ref * 4), 0, 1);
  const chain = clamp((links.length - 1) / 4, 0, 1);
  const reach = clamp(Math.abs(terminalPct) / 5, 0, 1);
  const thin = clamp(1 - lwi, 0, 1);
  const risk = 100 * (0.35 * cheapness + 0.25 * chain + 0.25 * reach + 0.15 * thin);

  return { direction: dir, seedNotional: seed, links, terminalPrice, terminalPct, risk };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
