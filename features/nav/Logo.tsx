import { brand } from "@/lib/brand";

/**
 * "The Currents" (option 9a): two equal, offset horizontal beams. YES enters
 * from the left and fades out; NO enters from the right and fades out. The 4px
 * horizontal offset between the bars is essential — never align them.
 *
 * Colors follow the theme via CSS variables (green `--c-accent`, red `--c-neg`),
 * so the mark reskins automatically in dark/light mode. 48×48 construction from
 * the brand spec, scaled by `size`.
 */
export function Logo({ size = 22, withWordmark = true }: { size?: number; withWordmark?: boolean }) {
  return (
    <span className="inline-flex items-center" style={{ gap: size * 0.34 }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        aria-hidden="true"
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient id="oddz-yes" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="rgb(var(--c-accent))" />
            <stop offset="1" stopColor="rgb(var(--c-accent))" stopOpacity="0.12" />
          </linearGradient>
          <linearGradient id="oddz-no" x1="1" y1="0" x2="0" y2="0">
            <stop offset="0" stopColor="rgb(var(--c-neg))" />
            <stop offset="1" stopColor="rgb(var(--c-neg))" stopOpacity="0.12" />
          </linearGradient>
        </defs>
        <rect x="3" y="13" width="38" height="9" rx="4.5" fill="url(#oddz-yes)" />
        <rect x="7" y="26" width="38" height="9" rx="4.5" fill="url(#oddz-no)" />
      </svg>
      {withWordmark && (
        <span
          className="font-sans font-bold text-fg"
          style={{ fontSize: size * 0.82, letterSpacing: "-0.03em", lineHeight: 1 }}
        >
          {brand.wordmark}
        </span>
      )}
    </span>
  );
}
