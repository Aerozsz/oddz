"use client";

import { createSweepFeed, type SweepFeed } from "./feed";

declare global {
  interface Window {
    /**
     * The live monitor, for an agent or a script running inside the page.
     * Present only on /sweep, and only once the dashboard has mounted.
     */
    sweepFeed?: SweepFeed;
  }
}

let exposed: SweepFeed | null = null;

/**
 * Publish the feed on `window.sweepFeed`.
 *
 * The engine runs in the browser, so anything driving this page — a headless
 * session, an extension, a console — already has the data in its process; the
 * only thing missing is a named handle to reach it. This adds nothing that a
 * page script could not already read, and exposes no control surface: the feed
 * is read-only and holds no credentials.
 */
export function exposeSweepFeed(): SweepFeed {
  if (typeof window === "undefined") {
    throw new Error("exposeSweepFeed is browser-only");
  }
  if (!exposed) {
    exposed = createSweepFeed();
    window.sweepFeed = exposed;
  }
  return exposed;
}
