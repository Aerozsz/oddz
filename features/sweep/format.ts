export function usd(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(abs >= 1e5 ? 0 : digits)}k`;
  return `$${v.toFixed(0)}`;
}

export function price(v: number | null | undefined, precision = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toFixed(precision);
}

export function pct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

export function ratio(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}×`;
}

export function qty(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return v.toFixed(digits);
}

export function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds(),
  ).padStart(2, "0")}`;
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** Status token for a 0–100 risk score. */
export function riskStatus(risk: number): {
  key: "good" | "warning" | "serious" | "critical";
  label: string;
  icon: string;
} {
  if (risk >= 70) return { key: "critical", label: "Critical", icon: "!!" };
  if (risk >= 50) return { key: "serious", label: "Serious", icon: "!" };
  if (risk >= 30) return { key: "warning", label: "Elevated", icon: "▲" };
  return { key: "good", label: "Contained", icon: "✓" };
}

export const STATUS_VAR: Record<string, string> = {
  good: "var(--good)",
  warning: "var(--warning)",
  serious: "var(--serious)",
  critical: "var(--critical)",
};
