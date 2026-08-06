"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CascadePath, Cluster, Snapshot } from "@/lib/sweep/types";
import { price as fmtPrice, pct, usd } from "./format";
import { setupCanvas, useSize } from "./useEngine";

/**
 * One price axis, two magnitudes measured in the same unit and binned to the
 * same width, so the comparison the map exists to make is a direct one:
 *
 *   left of the divider  — modelled forced flow resting at that level
 *   right of the divider — notional actually posted in the book there
 *
 * A cluster bar longer than the depth bar beside it is the whole warning. It
 * means more forced selling sits at that level than there is resting bid to
 * take it, so the level cannot clear without price moving through it.
 *
 * Bar length carries size; opacity carries confidence. They are separate
 * variables, so they get separate channels — a faint bar is an inference from
 * the leverage ladder, a solid one has printed liquidations behind it.
 */

const ZOOMS = [2, 4, 8, 12] as const;

interface Hit {
  y: number;
  price: number;
  cluster: Cluster | null;
  bookNotional: number;
  side: "bid" | "ask";
}

export default function ClusterMap({ snap }: { snap: Snapshot }) {
  const { ref, size } = useSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hitsRef = useRef<Hit[]>([]);
  const [zoom, setZoom] = useState<number>(4);
  const [showTable, setShowTable] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number; hit: Hit } | null>(null);

  const height = 560;
  const precision = snap.meta?.pricePrecision ?? 2;
  const mid = snap.mid ?? snap.mark?.markPrice ?? null;

  const amplifying = useMemo(
    () => snap.clusters.filter((c) => c.effect === "amplifying"),
    [snap.clusters],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.width || !mid) return;
    const ctx = setupCanvas(canvas, size.width, height);
    if (!ctx) return;

    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const INK = v("--ink") || "#fff";
    const INK2 = v("--ink-2") || "#c3c2b7";
    const MUTED = v("--ink-muted") || "#898781";
    const GRID = v("--grid") || "#2c2c2a";
    const AXIS = v("--axis") || "#383835";
    const LIQ = v("--liq") || "#3987e5";
    const FORCED = v("--forced") || "#d95926";
    const SURFACE = v("--surface") || "#141413";

    const gutter = 58;
    const padTop = 16;
    const padBottom = 22;
    const plotX0 = gutter;
    const plotX1 = size.width - 10;
    const plotW = plotX1 - plotX0;
    const divider = plotX0 + plotW * 0.5;
    const halfW = Math.min(divider - plotX0, plotX1 - divider) - 6;
    const plotY0 = padTop;
    const plotY1 = height - padBottom;
    const plotH = plotY1 - plotY0;

    const lo = mid * (1 - zoom / 100);
    const hi = mid * (1 + zoom / 100);
    const yOf = (p: number) => plotY1 - ((p - lo) / (hi - lo)) * plotH;
    const priceOf = (y: number) => lo + ((plotY1 - y) / plotH) * (hi - lo);

    // Bins are the cluster merge width, so both sides of the divider are
    // "notional inside this price band" and share one scale.
    const binPrice = mid * 0.0015;
    const nBins = Math.ceil((hi - lo) / binPrice);
    const binPx = plotH / nBins;
    const barH = Math.max(2, binPx - 2); // 2px surface gap between fills

    const bookBins = new Map<number, { notional: number; side: "bid" | "ask" }>();
    const addBook = (p: number, notional: number, side: "bid" | "ask") => {
      if (p < lo || p > hi) return;
      const b = Math.floor((p - lo) / binPrice);
      const cur = bookBins.get(b);
      if (cur) cur.notional += notional;
      else bookBins.set(b, { notional, side });
    };
    for (const l of snap.bookBids ?? []) addBook(l.price, l.price * l.qty, "bid");
    for (const l of snap.bookAsks ?? []) addBook(l.price, l.price * l.qty, "ask");

    const visibleClusters = amplifying.filter((c) => c.price >= lo && c.price <= hi);
    const maxNotional = Math.max(
      1,
      ...visibleClusters.map((c) => c.notional),
      ...[...bookBins.values()].map((b) => b.notional),
    );
    const lenOf = (n: number) => Math.max(1.5, (n / maxNotional) * halfW);

    /* ------------------------------------------------------------- chrome */

    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.font = "11px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";

    const rawStep = (hi - lo) / 9;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) ?? mag * 10;
    for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
      const y = Math.round(yOf(p)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(plotX0, y);
      ctx.lineTo(plotX1, y);
      ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.textAlign = "right";
      ctx.fillText(p.toFixed(precision), gutter - 8, y);
    }

    // Divider: the zero of both magnitude scales.
    ctx.strokeStyle = AXIS;
    ctx.beginPath();
    ctx.moveTo(Math.round(divider) + 0.5, plotY0);
    ctx.lineTo(Math.round(divider) + 0.5, plotY1);
    ctx.stroke();

    /* --------------------------------------------------- posted book depth */

    for (const [bin, b] of bookBins) {
      const yTop = plotY1 - (bin + 1) * binPx + 1;
      ctx.fillStyle = LIQ;
      ctx.globalAlpha = 0.85;
      roundRect(ctx, divider + 1, yTop, lenOf(b.notional), barH, 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* --------------------------------------------------- forced-flow bars */

    const hits: Hit[] = [];
    for (const c of visibleClusters) {
      const y = yOf(c.price);
      const len = lenOf(c.notional);
      ctx.fillStyle = FORCED;
      // Opacity is confidence: faint means inferred, solid means observed.
      ctx.globalAlpha = 0.3 + 0.7 * c.confidence;
      roundRect(ctx, divider - 1 - len, y - barH / 2, len, barH, 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      hits.push({ y, price: c.price, cluster: c, bookNotional: 0, side: c.pushes === "down" ? "bid" : "ask" });
    }

    for (const [bin, b] of bookBins) {
      const y = plotY1 - (bin + 0.5) * binPx;
      const existing = hits.find((h) => Math.abs(h.y - y) < binPx / 2);
      if (existing) existing.bookNotional += b.notional;
      else
        hits.push({
          y,
          price: priceOf(y),
          cluster: null,
          bookNotional: b.notional,
          side: b.side,
        });
    }
    hitsRef.current = hits;

    /* ------------------------------------------------------- cascade rails */

    drawCascade(ctx, snap.cascadeDown, yOf, divider - halfW - 4, FORCED, SURFACE, lo, hi);
    drawCascade(ctx, snap.cascadeUp, yOf, divider - halfW - 4, FORCED, SURFACE, lo, hi);

    /* ----------------------------------------------------------- mid line */

    const yMid = Math.round(yOf(mid)) + 0.5;
    ctx.strokeStyle = INK2;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX0, yMid);
    ctx.lineTo(plotX1, yMid);
    ctx.stroke();

    const label = mid.toFixed(precision);
    ctx.font = "600 11px system-ui, -apple-system, sans-serif";
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = INK2;
    roundRect(ctx, gutter - 8 - w, yMid - 8, w, 16, 3);
    ctx.fill();
    ctx.fillStyle = "#0d0d0d";
    ctx.textAlign = "right";
    ctx.fillText(label, gutter - 13, yMid);

    /* --------------------------------------------------------- axis labels */

    ctx.font = "10px system-ui, -apple-system, sans-serif";
    ctx.fillStyle = MUTED;
    ctx.textAlign = "right";
    ctx.fillText("← forced flow (modelled)", divider - 6, plotY1 + 12);
    ctx.textAlign = "left";
    ctx.fillText("posted depth (live) →", divider + 6, plotY1 + 12);
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.fillText(`scale: ${usd(maxNotional)} per ${(0.15).toFixed(2)}% band`, plotX0, plotY0 - 6);
  }, [snap, size.width, zoom, mid, amplifying, precision]);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const x = e.clientX - rect.left;
    let best: Hit | null = null;
    let bestD = 9;
    for (const h of hitsRef.current) {
      const d = Math.abs(h.y - y);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    setHover(best ? { x, y, hit: best } : null);
  };

  return (
    <section className="panel">
      <header>
        <h2>Cluster map — forced flow vs posted depth</h2>
        <div className="controls">
          {ZOOMS.map((z) => (
            <button key={z} aria-pressed={zoom === z} onClick={() => setZoom(z)}>
              ±{z}%
            </button>
          ))}
          <button aria-pressed={showTable} onClick={() => setShowTable((s) => !s)}>
            table
          </button>
        </div>
      </header>

      <div
        className="canvas-wrap"
        ref={ref}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <canvas ref={canvasRef} style={{ height }} />
        {hover && (
          <div
            className="tooltip"
            style={{
              left: Math.min(hover.x + 12, (size.width || 400) - 250),
              top: Math.max(4, hover.y - 46),
            }}
          >
            <b>{fmtPrice(hover.hit.price, precision)}</b>
            <span className="muted">{pct(mid ? ((hover.hit.price - mid) / mid) * 100 : 0)} from mid</span>
            {hover.hit.cluster && (
              <div>
                forced flow {usd(hover.hit.cluster.notional)} ·{" "}
                {hover.hit.cluster.pushes === "down" ? "sells into a fall" : "buys into a rally"}
                <br />
                <span className="muted">
                  {hover.hit.cluster.sources.join(", ") || "book"} · confidence{" "}
                  {(hover.hit.cluster.confidence * 100).toFixed(0)}%
                  {hover.hit.cluster.spent > 0 && ` · ${usd(hover.hit.cluster.spent)} already fired`}
                </span>
              </div>
            )}
            {hover.hit.bookNotional > 0 && (
              <div>
                posted {hover.hit.side} depth {usd(hover.hit.bookNotional)}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="legend">
        <span>
          <i className="swatch" style={{ background: "var(--forced)" }} /> forced flow — stops and
          liquidations, extend the move
        </span>
        <span>
          <i className="swatch" style={{ background: "var(--liq)" }} /> posted depth — resting
          limits, absorb the move
        </span>
        <span className="sub">faint = inferred · solid = liquidations printed there</span>
      </div>

      {showTable && (
        <div style={{ marginTop: 10, maxHeight: 280, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Level</th>
                <th>From mid</th>
                <th>Forced flow</th>
                <th>Pushes</th>
                <th>Conf.</th>
                <th>Sources</th>
              </tr>
            </thead>
            <tbody>
              {amplifying
                .slice()
                .sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct))
                .slice(0, 40)
                .map((c) => (
                  <tr key={`${c.price}-${c.sources.join()}`}>
                    <td className="num">{fmtPrice(c.price, precision)}</td>
                    <td className="num">{pct(c.distPct)}</td>
                    <td className="num">{usd(c.notional)}</td>
                    <td>{c.pushes === "down" ? "down" : "up"}</td>
                    <td className="num">{(c.confidence * 100).toFixed(0)}%</td>
                    <td style={{ textAlign: "left", fontSize: 11, color: "var(--ink-muted)" }}>
                      {c.sources.join(", ")}
                    </td>
                  </tr>
                ))}
              {amplifying.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    Waiting for open interest and history before the ladder can be sized.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function drawCascade(
  ctx: CanvasRenderingContext2D,
  path: CascadePath | null,
  yOf: (p: number) => number,
  x: number,
  color: string,
  surface: string,
  lo: number,
  hi: number,
) {
  if (!path || path.links.length === 0) return;
  const clampP = (p: number) => Math.min(hi, Math.max(lo, p));
  const yStart = yOf(clampP(path.links[0].cluster.price));
  const yEnd = yOf(clampP(path.terminalPrice));

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, yStart);
  ctx.lineTo(x, yEnd);
  ctx.stroke();

  for (const link of path.links) {
    const y = yOf(clampP(link.cluster.price));
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    // 2px surface ring so overlapping nodes stay separable.
    ctx.lineWidth = 2;
    ctx.strokeStyle = surface;
    ctx.stroke();
  }

  // Arrowhead at the terminal.
  const dir = yEnd > yStart ? 1 : -1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, yEnd + dir * 6);
  ctx.lineTo(x - 4, yEnd);
  ctx.lineTo(x + 4, yEnd);
  ctx.closePath();
  ctx.fill();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}
