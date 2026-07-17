"use client";

import { useActionState } from "react";
import { subscribe, type SubscribeState } from "./actions";

const initial: SubscribeState = { status: "idle" };

export function SubscribeForm() {
  const [state, action, pending] = useActionState(subscribe, initial);

  if (state.status === "ok") {
    return <p className="text-sm text-emerald-300">{state.message}</p>;
  }

  return (
    <form action={action} className="flex w-full max-w-md flex-col gap-2 sm:flex-row">
      <input
        type="email"
        name="email"
        required
        placeholder="you@example.com"
        className="flex-1 rounded-lg border border-border bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-600 focus:outline-none"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
      >
        {pending ? "Joining..." : "Get market alerts"}
      </button>
      {state.status === "error" && (
        <p className="text-xs text-red-400 sm:self-center">{state.message}</p>
      )}
    </form>
  );
}
