"use client";

import { useState, useTransition } from "react";
import { toggleWatch } from "./actions";
import { cn } from "@/lib/utils";

export function StarButton({
  marketId,
  initialWatched,
  className,
}: {
  marketId: string;
  initialWatched: boolean;
  className?: string;
}) {
  const [watched, setWatched] = useState(initialWatched);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
      aria-pressed={watched}
      title={error ?? (watched ? "Remove from watchlist" : "Add to watchlist")}
      disabled={pending}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = !watched;
        setWatched(next); // optimistic
        setError(null);
        startTransition(async () => {
          const result = await toggleWatch(marketId);
          setWatched(result.watched);
          if (result.error) setError(result.error);
        });
      }}
      className={cn(
        "text-lg leading-none transition-colors disabled:opacity-50",
        error
          ? "text-red-400"
          : watched
            ? "text-amber-300 hover:text-amber-200"
            : "text-zinc-600 hover:text-zinc-300",
        className,
      )}
    >
      {watched ? "★" : "☆"}
    </button>
  );
}
