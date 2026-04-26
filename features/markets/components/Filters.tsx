"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

const VENUES = [
  { value: "", label: "All venues" },
  { value: "polymarket", label: "Polymarket" },
  { value: "kalshi", label: "Kalshi" },
  { value: "manifold", label: "Manifold" },
  { value: "metaculus", label: "Metaculus" },
];

export function Filters() {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const [q, setQ] = useState(params.get("q") ?? "");
  const venue = params.get("venue") ?? "";

  useEffect(() => {
    setQ(params.get("q") ?? "");
  }, [params]);

  function update(next: { q?: string; venue?: string }) {
    const sp = new URLSearchParams(params.toString());
    if (next.q !== undefined) {
      if (next.q) sp.set("q", next.q);
      else sp.delete("q");
    }
    if (next.venue !== undefined) {
      if (next.venue) sp.set("venue", next.venue);
      else sp.delete("venue");
    }
    startTransition(() => router.replace(`/markets?${sp.toString()}`));
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && update({ q })}
        onBlur={() => update({ q })}
        placeholder="Search markets..."
        className="flex-1 rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-600 focus:outline-none"
      />
      <select
        value={venue}
        onChange={(e) => update({ venue: e.target.value })}
        className="rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
      >
        {VENUES.map((v) => (
          <option key={v.value} value={v.value}>
            {v.label}
          </option>
        ))}
      </select>
    </div>
  );
}
