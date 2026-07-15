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

const SORTS = [
  { value: "", label: "Sort: Volume" },
  { value: "liquidity", label: "Sort: Liquidity" },
  { value: "updated", label: "Sort: Recently updated" },
];

export function Filters() {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const [q, setQ] = useState(params.get("q") ?? "");
  const venue = params.get("venue") ?? "";
  const sort = params.get("sort") ?? "";

  useEffect(() => {
    setQ(params.get("q") ?? "");
  }, [params]);

  function update(next: { q?: string; venue?: string; sort?: string }) {
    const sp = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) continue;
      if (value) sp.set(key, value);
      else sp.delete(key);
    }
    sp.delete("page"); // any filter change resets pagination
    startTransition(() => router.replace(`/markets?${sp.toString()}`));
  }

  const selectCls =
    "rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none";

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
      <select value={venue} onChange={(e) => update({ venue: e.target.value })} className={selectCls}>
        {VENUES.map((v) => (
          <option key={v.value} value={v.value}>
            {v.label}
          </option>
        ))}
      </select>
      <select value={sort} onChange={(e) => update({ sort: e.target.value })} className={selectCls}>
        {SORTS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
}
