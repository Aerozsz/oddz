import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  CRON_SECRET: z.string().min(16),
  KALSHI_API_KEY: z.string().optional(),
  MANIFOLD_API_KEY: z.string().optional(),
  METACULUS_API_KEY: z.string().optional(),
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // --- INTC foundry monitor: notification channels (all optional) -------
  // Configure whichever you'll actually read on your phone. Each is fired
  // independently; the monitor no-ops on any that's unset.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  /** ntfy.sh topic — the zero-account path: pick a topic, subscribe in the app. */
  NTFY_TOPIC: z.string().optional(),
  NTFY_SERVER: z.string().url().default("https://ntfy.sh"),
  /** Generic JSON webhook (Slack / Discord / Zapier / your own endpoint). */
  INTC_WEBHOOK_URL: z.string().url().optional(),
  /** Push only items at or above this severity. Default: high. */
  INTC_MIN_SEVERITY: z.enum(["low", "medium", "high", "critical"]).default("high"),
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
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    NTFY_TOPIC: process.env.NTFY_TOPIC,
    NTFY_SERVER: process.env.NTFY_SERVER,
    INTC_WEBHOOK_URL: process.env.INTC_WEBHOOK_URL,
    INTC_MIN_SEVERITY: process.env.INTC_MIN_SEVERITY,
  };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid environment variables:\n  ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
