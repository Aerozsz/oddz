import { saveAttempt } from "@/lib/store";
import { loadForStudent } from "@/lib/attempt-access";
import { fail, json } from "@/lib/http";
import { scoreObjective } from "@/lib/scoring";
import { LISTENING_KEY, READING_KEY } from "@/lib/test/key";

export const dynamic = "force-dynamic";

type Body = {
  stage?: string;
  section?: "listening" | "reading" | "writing" | "speaking";
  data?: Record<string, unknown>;
  submit?: boolean;
};

const clip = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

function cleanAnswers(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const n = Number(k);
    if (Number.isInteger(n) && n >= 1 && n <= 40 && typeof val === "string") out[n] = val.slice(0, 80);
  }
  return out;
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const a = await loadForStudent(id, req.headers.get("x-attempt-token"));
  if (!a) return fail("Test session not found.", 404);
  if (a.status === "submitted") return fail("This test has already been submitted.", 409);

  let body: Body;
  try { body = await req.json(); } catch { return fail("Invalid request."); }
  const d = body.data ?? {};

  if (typeof body.stage === "string") a.currentStage = body.stage.slice(0, 40);

  switch (body.section) {
    case "listening":
    case "reading": {
      const answers = cleanAnswers(d.answers);
      const prev = a[body.section];
      a[body.section] = {
        answers,
        startedAt: prev?.startedAt ?? clip(d.startedAt, 40),
        finishedAt: clip(d.finishedAt, 40) ?? prev?.finishedAt,
        timeUp: d.timeUp === true || prev?.timeUp,
      };
      a.scores = a.scores ?? {};
      a.scores[body.section] = scoreObjective(answers, body.section === "listening" ? LISTENING_KEY : READING_KEY, body.section);
      break;
    }
    case "writing": {
      const prev = a.writing;
      a.writing = {
        task1: clip(d.task1, 20000) ?? prev?.task1 ?? "",
        task2: clip(d.task2, 30000) ?? prev?.task2 ?? "",
        startedAt: prev?.startedAt ?? clip(d.startedAt, 40),
        finishedAt: clip(d.finishedAt, 40) ?? prev?.finishedAt,
        timeUp: d.timeUp === true || prev?.timeUp,
      };
      break;
    }
    case "speaking": {
      const prev = a.speaking;
      a.speaking = {
        recordings: prev?.recordings ?? [],
        skipped: typeof d.skipped === "boolean" ? d.skipped : prev?.skipped,
        skipReason: clip(d.skipReason, 300) ?? prev?.skipReason,
        prepNotes: clip(d.prepNotes, 3000) ?? prev?.prepNotes,
        startedAt: prev?.startedAt ?? clip(d.startedAt, 40),
        finishedAt: clip(d.finishedAt, 40) ?? prev?.finishedAt,
      };
      break;
    }
  }

  if (body.submit) {
    a.status = "submitted";
    a.submittedAt = new Date().toISOString();
    a.currentStage = "done";
  }

  await saveAttempt(a);
  return json({ ok: true, status: a.status });
}
