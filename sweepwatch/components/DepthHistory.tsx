"use client";

import { useEffect, useRef, useState } from "react";
import { CONFIG } from "../lib/config";
import type { Snapshot } from "../lib/types";
import { clock, usd } from "./format";
import { setupCanvas, useSize } from "./useEngine";

/**
 * One series: notional resting inside the primary band, sampled continuously.
 * The reference line is that series' own slow baseline, so the question the
 * chart answers is "thinner than this book's own normal", not "thin in the
 * abstract".
 *
 * Marks below the plot are thinning events — moments where depth left without
 * trading. They are the precondition, and they show up here before anything is
 * visible in price.
 */
export default function DepthHistory({ snap }: { snap: Snapshot }) {
  const { ref, size } = useSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<{ x: number; i: number } | null>(null);
  const height = 132;

  const history = snap.depthHistory;
  const baseline = snap.liquidity?.baselineNotional ?? 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.width || history.length < 2) return;
    const ctx = setupCanvas(canvas, size.width, height);
    if (!ctx) return;

    const css = getComputedStyle(document.documentElement);
    const v = (n: string) => css.getPropertyValue(n).trim();
    const LIQ = v("--liq") || "#3987e5";
    const MUTED = v("--ink-muted") || "#898781";
    const GRID = v("--grid") || "#2c2c2a";
    const FORCED = v("--forced") || "#d95926";
    const INK2 = v("--ink-2") || "#c3c2b7";

    const padL = 4;
    const padR = 52;
    const padT = 8;
    const padB = 22;
    const w = size.width - padL - padR;
    const h = height - padT - padB;

    const totals = history.map((s) => s.bid + s.ask);
    const max = Math.max(baseline * 1.25, ...totals) || 1;
    const t0 = history[0].t;
    const t1 = history[history.length - 1].t || t0 + 1;
    const xOf = (t: number) => padL + ((t - t0) / Math.max(1, t1 - t0)) * w;
    const yOf = (n: number) => padT + h - (n / max) * h;

    // Area under the series, kept low-contrast so the line reads as the data.
    ctx.beginPath();
    ctx.moveTo(xOf(history[0].t), padT + h);
    for (let i = 0; i < history.length; i++) ctx.lineTo(xOf(history[i].t), yOf(totals[i]));
    ctx.lineTo(xOf(history[history.length - 1].t), padT + h);
    ctx.closePath();
    ctx.fillStyle = "rgba(57,135,229,0.16)";
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = xOf(history[i].t);
      const y = yOf(totals[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = LIQ;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    if (baseline > 0) {
      const y = Math.round(yOf(baseline)) + 0.5;
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + w, y);
      ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.font = "10px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("baseline", padL + w + 6, y);
    }

    // Endpoint direct label — the only value printed on the plot.
    const lastY = yOf(totals[totals.length - 1]);
    ctx.fillStyle = INK2;
    ctx.font = "600 11px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(usd(totals[totals.length - 1]), padL + w + 6, lastY);
    ctx.beginPath();
    ctx.arc(padL + w, lastY, 3, 0, Math.PI * 2);
    ctx.fillStyle = LIQ;
    ctx.fill();

    // Thinning events, on their own rule beneath the plot.
    ctx.fillStyle = FORCED;
    for (const e of snap.thinning) {
      if (e.t < t0) continue;
      const x = xOf(e.t);
      ctx.beginPath();
      ctx.moveTo(x, padT + h + 4);
      ctx.lineTo(x - 3.5, padT + h + 10);
      ctx.lineTo(x + 3.5, padT + h + 10);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = MUTED;
    ctx.font = "10px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(clock(t0), padL, height - 4);
    ctx.textAlign = "right";
    ctx.fillText("now", padL + w, height - 4);
  }, [history, baseline, size.width, snap.thinning]);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (history.length < 2) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = size.width - 56;
    const frac = Math.min(1, Math.max(0, (x - 4) / w));
    setHover({ x, i: Math.round(frac * (history.length - 1)) });
  };

  const point = hover ? history[hover.i] : null;

  return (
    <div>
      <div
        className="canvas-wrap"
        ref={ref}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <canvas ref={canvasRef} style={{ height }} />
        {point && (
          <div
            className="tooltip"
            style={{ left: Math.min((hover?.x ?? 0) + 10, (size.width || 300) - 190), top: 4 }}
          >
            <b>{usd(point.bid + point.ask)}</b>
            <span className="muted">
              {clock(point.t)} · bid {usd(point.bid)} / ask {usd(point.ask)}
            </span>
          </div>
        )}
      </div>
      <p className="sub" style={{ margin: "6px 0 0" }}>
        Notional inside ±{CONFIG.primaryBandBps} bps, sampled every{" "}
        {CONFIG.sampleIntervalMs}ms. Marks below the plot are withdrawal events.
      </p>
    </div>
  );
}
