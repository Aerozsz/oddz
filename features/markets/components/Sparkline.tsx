/**
 * Tiny server-rendered SVG sparkline. No client JS, no chart library —
 * keeps the market list page payload flat regardless of row count.
 */
export function Sparkline({
  values,
  width = 96,
  height = 28,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  if (values.length < 2) {
    return <span className="text-xs text-zinc-600">—</span>;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 0.0001;
  const pad = 2;

  const stepX = (width - pad * 2) / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (height - pad * 2) * (1 - (v - min) / range);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const up = values[values.length - 1] >= values[0];
  const stroke = up ? "#34d399" : "#f87171";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Price trend, ${up ? "up" : "down"}`}
      className="shrink-0"
    >
      <polyline points={pts.join(" ")} fill="none" stroke={stroke} strokeWidth="1.5" />
    </svg>
  );
}
