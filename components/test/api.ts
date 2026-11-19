"use client";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

let chain: Promise<unknown> = Promise.resolve();

/** All writes go through one queue so autosaves and uploads never overwrite each other on the server. */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (e instanceof ApiError && e.status < 500) throw e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** i));
    }
  }
  throw last;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function parse(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data;
}

export async function createAttempt(student: { name: string; age: number; timezone: string }): Promise<{ id: string; token: string }> {
  const res = await fetch("/api/attempts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(student) });
  return parse(res);
}

export function patchAttempt(id: string, token: string, body: Record<string, unknown>) {
  return enqueue(() => withRetry(async () => {
    const res = await fetch(`/api/attempts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-attempt-token": token },
      body: JSON.stringify(body),
      keepalive: JSON.stringify(body).length < 60000,
    });
    return parse(res);
  }));
}

export function uploadAudio(id: string, token: string, part: string, blob: Blob, durationSec: number) {
  return enqueue(() => withRetry(async () => {
    const res = await fetch(`/api/attempts/${id}/audio?part=${part}&duration=${Math.round(durationSec)}`, {
      method: "POST",
      headers: { "Content-Type": blob.type.split(";")[0] || "audio/webm", "x-attempt-token": token },
      body: blob,
    });
    return parse(res);
  }));
}
