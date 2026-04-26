import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  CRON_SECRET: z.string().min(16),
  KALSHI_API_KEY: z.string().optional(),
  MANIFOLD_API_KEY: z.string().optional(),
  METACULUS_API_KEY: z.string().optional(),
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid environment variables:\n  ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
