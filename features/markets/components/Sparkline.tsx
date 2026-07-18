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
  const stroke = up ? "rgb(var(--c-accent))" : "rgb(var(--c-neg))";
  // Closed polygon under the line for a faint area fill.
  const area = `${pad},${height - pad} ${pts.join(" ")} ${(pad + (values.length - 1) * stepX).toFixed(1)},${height - pad}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Price trend, ${up ? "up" : "down"}`}
      className="draw shrink-0"
      style={{ "--draw-len": 180 } as React.CSSProperties}
    >
      <polygon points={area} fill={stroke} opacity="0.08" stroke="none" />
      <polyline points={pts.join(" ")} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
