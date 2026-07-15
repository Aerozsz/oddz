import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Server component: renders top-category filter chips as plain links so
 * they work without client JS. Current filters are preserved except
 * `page`, which resets on any category change.
 */
export function CategoryChips({
  categories,
  active,
  searchParams,
}: {
  categories: { category: string; count: number }[];
  active?: string;
  searchParams: Record<string, string | undefined>;
}) {
  if (categories.length === 0) return null;

  const hrefFor = (cat?: string) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (v && k !== "cat" && k !== "page") sp.set(k, v);
    }
    if (cat) sp.set("cat", cat);
    const qs = sp.toString();
    return `/markets${qs ? `?${qs}` : ""}`;
  };

  const chip = (label: string, href: string, isActive: boolean, count?: number) => (
    <Link
      key={label}
      href={href as never}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs capitalize",
        isActive
          ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
          : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200",
      )}
    >
      {label}
      {count !== undefined && <span className="text-zinc-500">{count}</span>}
    </Link>
  );

  return (
    <div className="flex flex-wrap gap-2">
      {chip("all", hrefFor(undefined), !active)}
      {categories.map((c) => chip(c.category, hrefFor(c.category), active === c.category, c.count))}
    </div>
  );
}
