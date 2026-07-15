/**
 * Build the Vercel file-upload deployment payload.
 *
 * Reads the repo sources plus three OVERRIDE files that carry runtime
 * credentials (package.json vercel-build, next.config.ts env, vercel.json
 * cron path). Credentials come from env vars — never from git:
 *
 *   DATABASE_URL_DIRECT  - Neon direct URL (build-time migrate)
 *   DATABASE_URL_POOLED  - Neon pooled URL (serverless runtime)
 *   CRON_SECRET          - snapshot cron auth
 *
 * Output: /tmp/deploy-files.json — array of {file, data} for
 * mcp__Vercel__deploy_to_vercel.
 */
import fs from "node:fs";
import path from "node:path";

const DIRECT = process.env.DATABASE_URL_DIRECT;
const POOLED = process.env.DATABASE_URL_POOLED;
const SECRET = process.env.CRON_SECRET;
if (!DIRECT || !POOLED || !SECRET) {
  console.error("Missing DATABASE_URL_DIRECT / DATABASE_URL_POOLED / CRON_SECRET");
  process.exit(1);
}

const files = [];
const include = (p) => files.push({ file: p, data: fs.readFileSync(p, "utf8") });
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else include(p);
  }
};
["app", "features", "workers", "lib"].forEach(walk);
["tsconfig.json", "tailwind.config.ts", "postcss.config.mjs", "drizzle.config.ts"].forEach(include);

const excluded = ["lib/db/demo-seed.ts", "lib/db/migrations/meta/0000_snapshot.json"];
const final = files.filter((f) => !excluded.includes(f.file));

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.scripts["vercel-build"] = `export DATABASE_URL='${DIRECT}' CRON_SECRET='${SECRET}' && drizzle-kit migrate && next build && tsx lib/db/seed.ts`;
final.push({ file: "package.json", data: JSON.stringify(pkg, null, 2) + "\n" });

const nextCfg = fs
  .readFileSync("next.config.ts", "utf8")
  .replace(
    "const config: NextConfig = {",
    `const config: NextConfig = {\n  env: {\n    DATABASE_URL: ${JSON.stringify(POOLED)},\n    CRON_SECRET: ${JSON.stringify(SECRET)},\n  },`,
  );
final.push({ file: "next.config.ts", data: nextCfg });

const vercelJson =
  JSON.stringify(
    {
      $schema: "https://openapi.vercel.sh/vercel.json",
      crons: [{ path: `/api/cron/snapshot?key=${SECRET}`, schedule: "*/5 * * * *" }],
    },
    null,
    2,
  ) + "\n";
final.push({ file: "vercel.json", data: vercelJson });

fs.writeFileSync("/tmp/deploy-files.json", JSON.stringify(final));
const total = final.reduce((a, f) => a + f.data.length, 0);
console.log(`payload: ${final.length} files, ${total} bytes -> /tmp/deploy-files.json`);
