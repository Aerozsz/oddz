// Route-level loading UI. Shows instantly on navigation (App Router Suspense)
// so a click always produces immediate feedback while data streams in.
export default function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
      <div className="flex flex-col gap-2">
        <div className="skeleton h-7 w-48" />
        <div className="skeleton h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="skeleton h-28 w-full" />
        ))}
      </div>
      <div className="flex flex-col gap-2 overflow-hidden rounded-lg border border-border bg-surface p-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="skeleton h-4 w-6" />
            <div className="skeleton h-4 flex-1" style={{ opacity: 1 - i * 0.06 }} />
            <div className="skeleton h-4 w-16" />
            <div className="skeleton h-4 w-14" />
          </div>
        ))}
      </div>
    </div>
  );
}
