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
  // Literal process.env.X references (not a dynamic object walk) so
  // Next.js can inline values configured via next.config `env` at build
  // time — required for file-upload deploys where no platform env vars
  // exist. Works identically with real env vars.
  const raw = {
    DATABASE_URL: process.env.DATABASE_URL,
    CRON_SECRET: process.env.CRON_SECRET,
    KALSHI_API_KEY: process.env.KALSHI_API_KEY,
    MANIFOLD_API_KEY: process.env.MANIFOLD_API_KEY,
    METACULUS_API_KEY: process.env.METACULUS_API_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    NODE_ENV: process.env.NODE_ENV,
  };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid environment variables:\n  ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
