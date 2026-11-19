import { NextResponse } from "next/server";
import { ADMIN_COOKIE, checkPassword, createSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let pw = "";
  try { pw = String((await req.json()).password ?? ""); } catch { /* empty */ }
  if (!process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: "Admin password is not configured on the server (ADMIN_PASSWORD)." }, { status: 500 });
  }
  if (!(await checkPassword(pw))) {
    await new Promise((r) => setTimeout(r, 600));
    return NextResponse.json({ error: "That password is not correct." }, { status: 401 });
  }
  const s = await createSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, s.value, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: s.maxAge });
  return res;
}
