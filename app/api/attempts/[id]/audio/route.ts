import { saveAttempt, saveAudio } from "@/lib/store";
import { loadForStudent } from "@/lib/attempt-access";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const PARTS = new Set(["part1", "part2", "part3"]);
const MAX_BYTES = 4 * 1024 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const part = url.searchParams.get("part") ?? "";
  const duration = Math.max(0, Math.min(1800, Number(url.searchParams.get("duration")) || 0));
  if (!PARTS.has(part)) return fail("Unknown speaking part.");

  const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!contentType.startsWith("audio/")) return fail("Expected an audio recording.");

  const a = await loadForStudent(id, req.headers.get("x-attempt-token"));
  if (!a) return fail("Test session not found.", 404);
  if (a.status === "submitted") return fail("This test has already been submitted.", 409);

  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0) return fail("The recording was empty. Please try again.");
  if (buf.length > MAX_BYTES) return fail("The recording is too large to upload.", 413);

  const path = await saveAudio(id, part, buf, contentType);
  a.speaking = a.speaking ?? { recordings: [] };
  a.speaking.recordings = [
    ...a.speaking.recordings.filter((r) => r.part !== part),
    { part, path, contentType, durationSec: Math.round(duration), size: buf.length, uploadedAt: new Date().toISOString() },
  ].sort((x, y) => x.part.localeCompare(y.part));
  await saveAttempt(a);
  return json({ ok: true });
}
