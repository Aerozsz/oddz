import { listening } from "@/lib/test/listening";
import { fail, json } from "@/lib/http";

// Transcripts are fetched only when a recording starts, so they aren't readable from the page beforehand.
export async function GET(_req: Request, ctx: { params: Promise<{ part: string }> }) {
  const { part } = await ctx.params;
  const p = listening.find((x) => x.id === part);
  if (!p) return fail("Not found", 404);
  return json({ script: p.script });
}
