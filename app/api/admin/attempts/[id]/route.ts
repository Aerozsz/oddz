import { deleteAttempt, getAttempt, saveAttempt } from "@/lib/store";
import { fail, json } from "@/lib/http";
import { speakingBand, writingBand } from "@/lib/scoring";
import type { SpeakingGrade, WritingGrade } from "@/lib/types";

export const dynamic = "force-dynamic";

const band = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 9 && Math.round(n * 2) === n * 2 ? n : undefined;
};

function wg(v: unknown): WritingGrade | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const g = { ta: band(o.ta), cc: band(o.cc), lr: band(o.lr), gra: band(o.gra) };
  return Object.values(g).every((x) => x !== undefined) ? (g as WritingGrade) : undefined;
}
function sg(v: unknown): SpeakingGrade | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const g = { fc: band(o.fc), lr: band(o.lr), gra: band(o.gra), p: band(o.p) };
  return Object.values(g).every((x) => x !== undefined) ? (g as SpeakingGrade) : undefined;
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const a = await getAttempt(id);
  if (!a) return fail("Not found", 404);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail("Invalid request."); }

  const g = a.grading ?? {};
  if ("task1" in body) g.task1 = wg(body.task1);
  if ("task2" in body) g.task2 = wg(body.task2);
  if ("speaking" in body) g.speaking = sg(body.speaking);
  if (typeof body.notes === "string") g.notes = body.notes.slice(0, 10000);
  g.writingBand = writingBand(g.task1, g.task2);
  g.speakingBand = speakingBand(g.speaking);
  g.gradedAt = new Date().toISOString();
  a.grading = g;
  await saveAttempt(a);
  return json({ ok: true, grading: g });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const a = await getAttempt(id);
  if (!a) return fail("Not found", 404);
  await deleteAttempt(id);
  return json({ ok: true });
}
