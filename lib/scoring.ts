import type { KeyEntry, QuestionType } from "./test/types";
import { QUESTION_TYPE_LABEL } from "./test/types";
import type { Attempt, AttemptSummary, ItemResult, ObjectiveScore, SpeakingGrade, WritingGrade } from "./types";

/** Round to the nearest half band, IELTS-style (.25 → .5, .75 → next whole). */
export function roundBand(x: number): number {
  return Math.floor(x * 2 + 0.5) / 2;
}

const LISTENING_BANDS: [number, number][] = [
  [39, 9], [37, 8.5], [35, 8], [32, 7.5], [30, 7], [26, 6.5], [23, 6], [18, 5.5], [16, 5], [13, 4.5], [10, 4], [8, 3.5], [6, 3], [4, 2.5], [2, 2], [1, 1],
];
const ACADEMIC_READING_BANDS: [number, number][] = [
  [39, 9], [37, 8.5], [35, 8], [33, 7.5], [30, 7], [27, 6.5], [23, 6], [19, 5.5], [15, 5], [13, 4.5], [10, 4], [8, 3.5], [6, 3], [4, 2.5], [2, 2], [1, 1],
];

function toBand(raw: number, table: [number, number][]) {
  for (const [min, band] of table) if (raw >= min) return band;
  return 0;
}
export const listeningBand = (raw: number) => toBand(raw, LISTENING_BANDS);
export const readingBand = (raw: number) => toBand(raw, ACADEMIC_READING_BANDS);

export function normalize(s: string | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[£$€%]/g, "")
    .replace(/[“”"‘’'.,;:!?()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function scoreObjective(answers: Record<string, string>, key: Record<number, KeyEntry>, kind: "listening" | "reading"): ObjectiveScore {
  const items: ItemResult[] = [];
  const handled = new Set<number>();
  const nums = Object.keys(key).map(Number).sort((a, b) => a - b);

  for (const n of nums) {
    if (handled.has(n)) continue;
    const entry = key[n];
    if (entry.set) {
      // "Choose TWO": each correct letter scores one mark, in any order.
      const given = entry.set.map((m) => (answers[m] ?? "").toUpperCase().trim()).filter(Boolean);
      const remaining = [...entry.answers];
      const marks: boolean[] = [];
      for (const g of given) {
        const idx = remaining.indexOf(g);
        if (idx >= 0) { marks.push(true); remaining.splice(idx, 1); } else marks.push(false);
      }
      entry.set.forEach((m, i) => {
        handled.add(m);
        items.push({ n: m, part: entry.part, type: entry.type, given: given[i] ?? "", correct: entry.answers.join(" / ") + " (any order)", ok: marks[i] ?? false });
      });
      continue;
    }
    handled.add(n);
    const given = answers[n] ?? "";
    const ok = given.trim() !== "" && entry.answers.some((a) => normalize(a) === normalize(given));
    items.push({ n, part: entry.part, type: entry.type, given, correct: entry.answers[0], ok });
  }
  items.sort((a, b) => a.n - b.n);
  const raw = items.filter((i) => i.ok).length;
  return { raw, band: kind === "listening" ? listeningBand(raw) : readingBand(raw), items };
}

export function writingTaskBand(g?: WritingGrade): number | undefined {
  if (!g) return undefined;
  return roundBand((g.ta + g.cc + g.lr + g.gra) / 4);
}

export function writingBand(t1?: WritingGrade, t2?: WritingGrade): number | undefined {
  const b1 = writingTaskBand(t1), b2 = writingTaskBand(t2);
  if (b1 === undefined || b2 === undefined) return undefined;
  // Task 2 carries twice the weight of Task 1.
  return roundBand((b1 + 2 * b2) / 3);
}

export function speakingBand(g?: SpeakingGrade): number | undefined {
  if (!g) return undefined;
  return roundBand((g.fc + g.lr + g.gra + g.p) / 4);
}

export function overallBand(parts: (number | undefined)[]): number | undefined {
  const xs = parts.filter((x): x is number => typeof x === "number");
  if (xs.length === 0) return undefined;
  return roundBand(xs.reduce((a, b) => a + b, 0) / xs.length);
}

export function cefr(band?: number): string {
  if (band === undefined) return "n/a";
  if (band >= 8.5) return "C2";
  if (band >= 7) return "C1";
  if (band >= 5.5) return "B2";
  if (band >= 4) return "B1";
  if (band >= 3) return "A2";
  return "A1";
}

export type TypeBreakdown = { section: "Listening" | "Reading"; type: QuestionType; label: string; correct: number; total: number; pct: number };

export function breakdownByType(a: Attempt): TypeBreakdown[] {
  const out: TypeBreakdown[] = [];
  for (const [section, score] of [["Listening", a.scores?.listening], ["Reading", a.scores?.reading]] as const) {
    if (!score) continue;
    const map = new Map<QuestionType, { c: number; t: number }>();
    for (const it of score.items) {
      const m = map.get(it.type) ?? { c: 0, t: 0 };
      m.t++; if (it.ok) m.c++;
      map.set(it.type, m);
    }
    for (const [type, { c, t }] of map) out.push({ section, type, label: QUESTION_TYPE_LABEL[type], correct: c, total: t, pct: Math.round((c / t) * 100) });
  }
  return out;
}

export function breakdownByPart(score?: ObjectiveScore): { part: number; correct: number; total: number }[] {
  if (!score) return [];
  const map = new Map<number, { correct: number; total: number }>();
  for (const it of score.items) {
    const m = map.get(it.part) ?? { correct: 0, total: 0 };
    m.total++; if (it.ok) m.correct++;
    map.set(it.part, m);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([part, v]) => ({ part, ...v }));
}

export function wordCount(s?: string): number {
  return (s ?? "").trim().split(/\s+/).filter(Boolean).length;
}

export function summarize(a: Attempt): AttemptSummary {
  const L = a.scores?.listening, R = a.scores?.reading;
  const W = a.grading?.writingBand, S = a.grading?.speakingBand;
  const overall = overallBand([L?.band, R?.band, W, S]);
  const provisional = W === undefined || S === undefined || !L || !R;
  const weakestType = breakdownByType(a).filter((b) => b.total >= 3).sort((x, y) => x.pct - y.pct)[0];
  const start = a.listening?.startedAt ?? a.createdAt;
  const durationMin = a.submittedAt ? Math.round((Date.parse(a.submittedAt) - Date.parse(start)) / 60000) : undefined;
  return {
    id: a.id,
    status: a.status,
    name: a.student.name,
    age: a.student.age,
    timezone: a.student.timezone,
    createdAt: a.createdAt,
    submittedAt: a.submittedAt,
    durationMin,
    listening: L ? { raw: L.raw, band: L.band } : undefined,
    reading: R ? { raw: R.raw, band: R.band } : undefined,
    writing: W,
    speaking: S,
    overall,
    provisional,
    weakest: weakestType ? `${weakestType.section}: ${weakestType.label} (${weakestType.pct}%)` : undefined,
    stage: a.currentStage,
  };
}
