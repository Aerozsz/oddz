import { randomBytes, randomUUID } from "crypto";
import { saveAttempt } from "@/lib/store";
import { fail, json } from "@/lib/http";
import type { Attempt } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { name?: unknown; age?: unknown; timezone?: unknown };
  try { body = await req.json(); } catch { return fail("Invalid request."); }

  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  const age = Number(body.age);
  const timezone = typeof body.timezone === "string" ? body.timezone.trim() : "";

  if (name.length < 2 || name.length > 80) return fail("Please enter your full name (2–80 characters).");
  if (!Number.isInteger(age) || age < 8 || age > 100) return fail("Please enter a valid age between 8 and 100.");
  let tzOk = false;
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); tzOk = timezone.length > 0; } catch { tzOk = false; }
  if (!tzOk) return fail("Please choose a valid time zone.");

  const now = new Date().toISOString();
  const attempt: Attempt = {
    id: randomUUID(),
    token: randomBytes(24).toString("hex"),
    status: "in_progress",
    createdAt: now,
    updatedAt: now,
    student: { name, age, timezone },
    currentStage: "intro",
    userAgent: req.headers.get("user-agent")?.slice(0, 200) ?? undefined,
  };
  await saveAttempt(attempt);
  return json({ id: attempt.id, token: attempt.token }, 201);
}
