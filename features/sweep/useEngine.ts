"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { emptySnapshot, getEngine } from "@/lib/sweep/engine";
import type { Snapshot } from "@/lib/sweep/types";

const server = emptySnapshot();

/**
 * The engine republishes a whole snapshot object at a fixed rate, so React only
 * has to compare identity. Incoming socket data is never throttled — only the
 * render is.
 */
export function useSnapshot(): Snapshot {
  useEffect(() => {
    const engine = getEngine();
    engine.start();
    // The engine is a tab-level singleton and outlives any single mount, so it
    // is deliberately not stopped on unmount — remounting must not drop the
    // continuous history the withdrawal metrics depend on.
  }, []);

  const engine = getEngine();
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot, () => server);
}

/** Element size, tracked for canvases that must redraw on layout change. */
export function useSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ width: r.width, height: r.height });
    });
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  return { ref, size };
}

/** Canvas sized to its container at device pixel ratio. */
export function setupCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}
