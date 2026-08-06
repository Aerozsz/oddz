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

/**
 * The same snapshot, delivered slowly.
 *
 * The engine publishes ten times a second because a canvas benefits from it.
 * Text does not: a figure that changes every 100ms cannot be read at all, and
 * the eye registers the motion instead of the value. Two or three updates a
 * second is still live and is actually legible, so every panel made of numbers
 * uses this and only the canvas runs at full rate.
 *
 * Reads the same engine snapshot either way, so a throttled panel and the
 * canvas beside it can never disagree about more than a few hundred
 * milliseconds.
 */
export function useSnapshotThrottled(intervalMs = 400): Snapshot {
  const engine = getEngine();
  // Starts from the same empty snapshot the server renders, so the first
  // client paint matches the prerendered markup.
  const [snap, setSnap] = useState<Snapshot>(() => engine.getSnapshot());

  useEffect(() => {
    engine.start();
    const id = setInterval(() => setSnap(engine.getSnapshot()), intervalMs);
    return () => clearInterval(id);
  }, [engine, intervalMs]);

  return snap;
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
