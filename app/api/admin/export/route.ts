import { listAttempts } from "@/lib/store";
import { toCsv } from "@/lib/csv";
import { breakdownByType, cefr, summarize, wordCount, writingTaskBand } from "@/lib/scoring";
import { QUESTION_TYPE_LABEL } from "@/lib/test/types";
import { questionPrompt } from "@/lib/test/prompts";

export const dynamic = "force-dynamic";

const fmt = (iso?: string) => (iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "");
const b = (x?: number) => (x === undefined ? "" : x.toFixed(1));

export async function GET(req: Request) {
  const url = new URL(req.url);
  const type = url.searchParams.get("type") === "detailed" ? "detailed" : "summary";
  const ids = url.searchParams.get("ids")?.split(",").filter(Boolean);
  let attempts = await listAttempts();
  if (ids?.length) attempts = attempts.filter((a) => ids.includes(a.id));

  let rows: (string | number | undefined)[][];
  if (type === "summary") {
    rows = [[
      "Student", "Age", "Time zone", "Status", "Started", "Submitted", "Duration (min)",
      "Listening raw /40", "Listening band", "Reading raw /40", "Reading band",
      "Writing band", "Speaking band", "Overall band", "Overall is provisional", "CEFR (approx.)",
      "Weakest question type", "Teacher notes",
    ]];
    for (const a of attempts) {
      const s = summarize(a);
      rows.push([
        s.name, s.age, s.timezone, s.status === "submitted" ? "Submitted" : `In progress (${s.stage})`, fmt(s.createdAt), fmt(s.submittedAt), s.durationMin,
        s.listening?.raw, b(s.listening?.band), s.reading?.raw, b(s.reading?.band),
        b(s.writing), b(s.speaking), b(s.overall), s.overall === undefined ? "" : s.provisional ? "Yes" : "No", cefr(s.overall),
        s.weakest, a.grading?.notes,
      ]);
    }
  } else {
    rows = [["Student", "Age", "Time zone", "Submitted", "Section", "Part", "Question", "Question type", "Prompt", "Student answer", "Correct answer", "Result", "Score / band", "Word count", "Response text"]];
    for (const a of attempts) {
      const base = [a.student.name, a.student.age, a.student.timezone, fmt(a.submittedAt)];
      for (const section of ["listening", "reading"] as const) {
        const sc = a.scores?.[section];
        if (!sc) continue;
        for (const it of sc.items) {
          rows.push([...base, section === "listening" ? "Listening" : "Reading", it.part, it.n, QUESTION_TYPE_LABEL[it.type], questionPrompt(section, it.n), it.given, it.correct, it.ok ? "Correct" : it.given ? "Incorrect" : "Blank", it.ok ? 1 : 0, "", ""]);
        }
        rows.push([...base, section === "listening" ? "Listening" : "Reading", "", "TOTAL", "", "", "", "", "", `${sc.raw}/40, band ${sc.band.toFixed(1)}`, "", ""]);
      }
      for (const bd of breakdownByType(a)) {
        rows.push([...base, `${bd.section} breakdown`, "", "", bd.label, "", "", "", "", `${bd.correct}/${bd.total} (${bd.pct}%)`, "", ""]);
      }
      const g = a.grading;
      for (const t of ["task1", "task2"] as const) {
        const text = a.writing?.[t];
        if (text === undefined) continue;
        const gr = g?.[t];
        rows.push([...base, "Writing", t === "task1" ? 1 : 2, t === "task1" ? "Task 1" : "Task 2", "", "", "", "", "",
          gr ? `Band ${b(writingTaskBand(gr))} (TA/TR ${gr.ta}, CC ${gr.cc}, LR ${gr.lr}, GRA ${gr.gra})` : "Not graded", wordCount(text), text]);
      }
      if (a.speaking) {
        const sg = g?.speaking;
        const recs = a.speaking.recordings.map((r) => `${r.part}: ${Math.round(r.durationSec)}s`).join("; ");
        rows.push([...base, "Speaking", "", "", "", "", "", "", "",
          sg ? `Band ${b(g?.speakingBand)} (FC ${sg.fc}, LR ${sg.lr}, GRA ${sg.gra}, P ${sg.p})` : "Not graded", "",
          a.speaking.skipped ? `Skipped: ${a.speaking.skipReason ?? ""}` : `Recordings: ${recs || "none"}`]);
      }
      rows.push([...base, "Overall", "", "", "", "", "", "", "", `Overall ${b(summarize(a).overall)} (${summarize(a).provisional ? "provisional" : "final"})`, "", g?.notes ?? ""]);
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="mock-test-${type}-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
