/** Admin session helpers. Uses Web Crypto so it works in middleware and route handlers. */
export const ADMIN_COOKIE = "mt_admin";
const SESSION_DAYS = 14;

function secret(): string {
  return `${process.env.SESSION_SECRET ?? ""}::${process.env.ADMIN_PASSWORD ?? ""}`;
}

async function hmac(data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function createSession(): Promise<{ value: string; maxAge: number }> {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  return { value: `${exp}.${await hmac(String(exp))}`, maxAge: SESSION_DAYS * 86400 };
}

export async function verifySession(value: string | undefined): Promise<boolean> {
  if (!value || !process.env.ADMIN_PASSWORD) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(exp));
}

export async function checkPassword(pw: string): Promise<boolean> {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  // Compare HMACs so timing does not depend on the password's content.
  return safeEqual(await hmac(`pw:${pw}`), await hmac(`pw:${expected}`));
}
