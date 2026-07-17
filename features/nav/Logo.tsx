import { brand } from "@/lib/brand";

/**
 * "The Eye" (option 1c): half-arc over a signal dot. Arc uses currentColor
 * so it follows the theme's text color; the dot stays accent green in both
 * modes. 48×48 construction from the brand spec, scaled by `size`.
 */
export function Logo({ size = 22, withWordmark = true }: { size?: number; withWordmark?: boolean }) {
  return (
    <span className="inline-flex items-center" style={{ gap: size * 0.3 }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        aria-hidden="true"
        style={{ display: "block", color: "rgb(var(--c-fg))" }}
      >
        <g transform="rotate(135 24 24)">
          <circle
            cx="24"
            cy="24"
            r="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="7"
            strokeDasharray="56.5 56.6"
            strokeLinecap="round"
          />
          <circle cx="24" cy="24" r="7" fill="rgb(var(--c-accent))" />
        </g>
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
