import "server-only";
import { getAttempt } from "./store";

export async function loadForStudent(id: string, token: string | null) {
  const a = await getAttempt(id);
  if (!a || !token || a.token !== token) return null;
  return a;
}
