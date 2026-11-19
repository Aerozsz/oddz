"use client";

export type Stage =
  | "details" | "check"
  | "listening-intro" | "listening"
  | "reading-intro" | "reading"
  | "writing-intro" | "writing"
  | "speaking-intro" | "speaking"
  | "review" | "done";

export type PersistState = {
  v: 1;
  attemptId: string;
  token: string;
  student: { name: string; age: number; timezone: string };
  stage: Stage;
  listening: { answers: Record<string, string>; startedAt?: string; deadline?: number; played: Record<string, number>; finishedAt?: string };
  reading: { answers: Record<string, string>; startedAt?: string; deadline?: number; finishedAt?: string };
  writing: { task1: string; task2: string; startedAt?: string; deadline?: number; finishedAt?: string };
  speaking: { done: Record<string, boolean>; skipped?: boolean; startedAt?: string; prepNotes?: string; finishedAt?: string };
};

const KEY = "mocktest:v1";

export function loadState(): PersistState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as PersistState;
    return s?.v === 1 && s.attemptId ? s : null;
  } catch {
    return null;
  }
}

export function saveState(s: PersistState | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch { /* storage unavailable: the server copy still exists */ }
}

export function freshState(attemptId: string, token: string, student: PersistState["student"]): PersistState {
  return {
    v: 1, attemptId, token, student, stage: "check",
    listening: { answers: {}, played: {} },
    reading: { answers: {} },
    writing: { task1: "", task2: "" },
    speaking: { done: {} },
  };
}
