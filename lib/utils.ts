import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatPct(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}%`;
}

export function formatUSD(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

/**
 * Parse a query-param integer safely: rejects NaN/±Infinity, floors to
 * an int, and clamps to [min, max]. Prevents negative/NaN values from
 * reaching Drizzle's .limit()/.offset() (where NaN silently removes the
 * clause and dumps the whole table) or Date math.
 */
export function clampInt(
  raw: string | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = raw == null ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export function timeAgo(date: Date | string): string {
  const t = typeof date === "string" ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - t.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
