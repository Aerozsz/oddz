"use client";

import { useEffect, useRef, useState } from "react";
import type { WireSnapshot } from "@/lib/holders/serialize";

export type StreamStatus = "connecting" | "live" | "polling" | "error";

interface Options {
  token?: string;
  pair?: string;
  top?: number;
  intervalMs?: number;
  /** Paused streams stop consuming RPC budget for a tab nobody is looking at. */
  paused?: boolean;
}

/**
 * Subscribes to the holder stream.
 *
 * SSE is the primary transport. It degrades to polling rather than failing,
 * because streamed responses are the first thing an intermediary breaks:
 * some proxies buffer them into silence, and serverless platforms cap how
 * long a single response may stay open. A tracker that shows nothing when
 * SSE is unavailable is worse than one that quietly polls.
 */
export function useHolderStream(opts: Options = {}) {
  const { token, pair, top = 100, intervalMs = 4_000, paused = false } = opts;
  const [snapshot, setSnapshot] = useState<WireSnapshot | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  /** Bumped on every accepted snapshot, so views can flash on change. */
  const [tick, setTick] = useState(0);
  const sawEventRef = useRef(false);

  useEffect(() => {
    if (paused) return;

    const params = new URLSearchParams();
    if (token) params.set("token", token);
    if (pair) params.set("pair", pair);
    params.set("top", String(top));
    params.set("interval", String(intervalMs));
    const qs = params.toString();

    let cancelled = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const accept = (data: WireSnapshot) => {
      if (cancelled) return;
      sawEventRef.current = true;
      setSnapshot(data);
      setError(data.warnings[0] ?? null);
      setTick((t) => t + 1);
    };

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/holders?${qs}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        accept((await res.json()) as WireSnapshot);
        setStatus("polling");
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setError(String(err).slice(0, 200));
        }
      }
      if (!cancelled) pollTimer = setTimeout(poll, intervalMs);
    };

    const startPolling = () => {
      source?.close();
      source = null;
      if (pollTimer === null && !cancelled) void poll();
    };

    try {
      source = new EventSource(`/api/holders/stream?${qs}`);
      source.addEventListener("snapshot", (ev) => {
        try {
          accept(JSON.parse((ev as MessageEvent).data) as WireSnapshot);
          setStatus("live");
        } catch {
          // A truncated frame is not worth tearing the stream down for.
        }
      });
      source.addEventListener("error", () => {
        // EventSource retries on its own; only fall back once it has failed
        // without ever delivering a snapshot.
        if (!sawEventRef.current) startPolling();
      });
      // If the stream connects but stays silent — the classic buffering proxy
      // — fall back rather than showing an empty table indefinitely.
      fallbackTimer = setTimeout(() => {
        if (!sawEventRef.current) startPolling();
      }, 12_000);
    } catch {
      startPolling();
    }

    return () => {
      cancelled = true;
      source?.close();
      if (pollTimer) clearTimeout(pollTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, [token, pair, top, intervalMs, paused]);

  return { snapshot, status, error, tick };
}
