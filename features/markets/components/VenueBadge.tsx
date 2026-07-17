/**
 * Neutral venue chip. The brand reserves green/coral strictly for
 * probability semantics, so venues are distinguished by name on a neutral
 * surface chip rather than colour-coding.
 */
export function VenueBadge({ venue, name }: { venue: string; name?: string }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded border border-border bg-surface px-2 py-0.5 text-xs font-medium text-muted">
      {name ?? venue}
    </span>
  );
}
