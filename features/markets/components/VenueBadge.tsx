import { cn } from "@/lib/utils";

const styles: Record<string, string> = {
  polymarket: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  kalshi: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  manifold: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  metaculus: "bg-purple-500/15 text-purple-300 border-purple-500/30",
};

export function VenueBadge({ venue, name }: { venue: string; name?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium",
        styles[venue] ?? "bg-zinc-700/40 text-zinc-300 border-zinc-600",
      )}
    >
      {name ?? venue}
    </span>
  );
}
