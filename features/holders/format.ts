/** Display helpers shared by the tracker views. */

export function shortAddr(a: string): string {
  return a.slice(0, 6) + "…" + a.slice(-4);
}

export function tokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + "k";
  if (abs >= 1) return n.toFixed(2);
  if (abs === 0) return "0";
  return n.toFixed(4);
}

export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return (n * 100).toFixed(digits) + "%";
}

export function signed(n: number, fmt: (v: number) => string): string {
  if (n === 0) return "—";
  return (n > 0 ? "+" : "") + fmt(n);
}

/** Colour class for a value where up is good and down is bad. */
export function toneFor(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "text-muted";
  return n > 0 ? "text-accent" : "text-neg";
}

/** How an entity got its position, phrased for a table cell. */
export const ACQUISITION_LABEL: Record<string, string> = {
  bought: "bought",
  farmed: "farmed",
  mixed: "mixed",
  none: "—",
};

export const EVIDENCE_LABEL: Record<string, string> = {
  "shared-signer": "same signer",
  "pass-through": "conduit hop",
  "sole-funder": "sole funder",
  "amount-echo": "amount echo",
  consolidation: "swept in",
  "co-timing": "co-timed",
};
