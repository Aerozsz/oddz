"use server";

import { z } from "zod";
import { db } from "@/lib/db/client";
import { subscribers } from "@/lib/db/schema";
import { log } from "@/lib/logger";

const EmailSchema = z.string().trim().toLowerCase().email().max(254);

export interface SubscribeState {
  status: "idle" | "ok" | "error";
  message?: string;
}

export async function subscribe(_prev: SubscribeState, formData: FormData): Promise<SubscribeState> {
  const parsed = EmailSchema.safeParse(formData.get("email"));
  if (!parsed.success) {
    return { status: "error", message: "That doesn't look like an email address." };
  }

  try {
    await db
      .insert(subscribers)
      .values({ email: parsed.data, source: "landing" })
      .onConflictDoNothing();
    return { status: "ok", message: "You're on the list." };
  } catch (err) {
    log.error("subscribe failed", { error: String(err) });
    return { status: "error", message: "Something went wrong — try again." };
  }
}
