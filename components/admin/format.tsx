"use client";
import { useEffect, useState } from "react";

/** Renders a timestamp in the viewer's (teacher's) local time; avoids SSR/CSR mismatch. */
export function LocalTime({ iso, tz, withZone }: { iso?: string; tz?: string; withZone?: boolean }) {
  const [txt, setTxt] = useState<string>("");
  useEffect(() => {
    if (!iso) return;
    try {
      setTxt(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", ...(tz ? { timeZone: tz } : {}), ...(withZone ? { timeZoneName: "short" } : {}) }).format(new Date(iso)));
    } catch { setTxt(iso); }
  }, [iso, tz, withZone]);
  if (!iso) return <span className="text-ink-muted">n/a</span>;
  return <time dateTime={iso} suppressHydrationWarning>{txt || iso.slice(0, 10)}</time>;
}

export const band = (b?: number) => (b === undefined ? "n/a" : b.toFixed(1));

export function BandPill({ value, provisional }: { value?: number; provisional?: boolean }) {
  if (value === undefined) return <span className="text-ink-muted">n/a</span>;
  const tone = value >= 7 ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : value >= 5.5 ? "bg-brand-50 text-brand-800 ring-brand-200" : "bg-amber-50 text-amber-900 ring-amber-200";
  return (
    <span className={`chip ring-1 tabular-nums ${tone}`} title={provisional ? "Provisional: not all sections are graded yet" : undefined}>
      {value.toFixed(1)}{provisional && <span aria-label="provisional">*</span>}
    </span>
  );
}
