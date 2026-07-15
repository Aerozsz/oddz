"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="max-w-md text-sm text-zinc-400">
        The page hit an unexpected error. It has been logged{error.digest ? ` (ref ${error.digest})` : ""}.
        Usually a retry fixes it.
      </p>
      <button
        onClick={reset}
        className="rounded bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400"
      >
        Try again
      </button>
    </div>
  );
}
