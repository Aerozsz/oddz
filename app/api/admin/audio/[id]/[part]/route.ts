import { getAttempt, readFile } from "@/lib/store";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; part: string }> }) {
  const { id, part } = await ctx.params;
  const a = await getAttempt(id);
  const rec = a?.speaking?.recordings.find((r) => r.part === part);
  if (!rec) return fail("Recording not found", 404);
  const f = await readFile(rec.path);
  if (!f) return fail("Recording not found", 404);
  const safeName = a!.student.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return new Response(new Uint8Array(f.body), {
    headers: {
      "Content-Type": rec.contentType || f.contentType,
      "Content-Length": String(f.body.length),
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="${safeName}-speaking-${part}.${rec.path.split(".").pop()}"`,
    },
  });
}
