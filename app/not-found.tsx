import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="max-w-md text-sm text-zinc-400">
        That market or page doesn&apos;t exist — it may have resolved and been delisted by its venue.
      </p>
      <Link
        href="/markets"
        className="rounded bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400"
      >
        Browse live markets
      </Link>
    </div>
  );
}
