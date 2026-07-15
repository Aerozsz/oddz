import Link from "next/link";
import { cn } from "@/lib/utils";

/** Server component: prev/next pagination links preserving current filters. */
export function PageNav({
  page,
  hasNext,
  searchParams,
}: {
  page: number;
  hasNext: boolean;
  searchParams: Record<string, string | undefined>;
}) {
  if (page <= 1 && !hasNext) return null;

  const hrefFor = (p: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (v && k !== "page") sp.set(k, v);
    }
    if (p > 1) sp.set("page", String(p));
    const qs = sp.toString();
    return `/markets${qs ? `?${qs}` : ""}`;
  };

  const linkCls = (enabled: boolean) =>
    cn(
      "rounded border px-3 py-1.5 text-sm",
      enabled
        ? "border-zinc-700 text-zinc-200 hover:border-zinc-500"
        : "pointer-events-none border-zinc-800 text-zinc-600",
    );

  return (
    <div className="flex items-center justify-between">
      <Link href={hrefFor(page - 1) as never} className={linkCls(page > 1)} aria-disabled={page <= 1}>
        ← Previous
      </Link>
      <span className="text-xs text-zinc-500">Page {page}</span>
      <Link href={hrefFor(page + 1) as never} className={linkCls(hasNext)} aria-disabled={!hasNext}>
        Next →
      </Link>
    </div>
  );
}
