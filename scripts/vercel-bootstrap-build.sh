#!/usr/bin/env bash
set -euo pipefail

BRANCH="claude/refactor-project-structure-JIiXS"
REPO="https://github.com/aerozsz/oddz.git"

DB_DIRECT="postgresql://neondb_owner:npg_dWoVaO4fpwX9@ep-ancient-sky-al6o1y63.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require"
DB_POOLED="postgresql://neondb_owner:npg_dWoVaO4fpwX9@ep-ancient-sky-al6o1y63-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require"
SECRET="f5a03d5d792237b151c7369692d42a503334aa710b68eca93796bca99753b07b"

echo "== cloning source =="
git clone --depth 1 -b "$BRANCH" "$REPO" _src
cp -a _src/. .
rm -rf _src

echo "== injecting runtime secrets into next.config.ts (preserving headers etc.) =="
# File-upload deploys have no dashboard env vars, so runtime serverless
# functions need the secrets baked into next.config `env`. Insert an env
# block into the existing config rather than overwriting it, so security
# headers / images config survive.
DB_POOLED="$DB_POOLED" SECRET="$SECRET" node -e '
const fs = require("fs");
let s = fs.readFileSync("next.config.ts", "utf8");
const envBlock = `\n  env: { DATABASE_URL: ${JSON.stringify(process.env.DB_POOLED)}, CRON_SECRET: ${JSON.stringify(process.env.SECRET)} },`;
s = s.replace(/const config: NextConfig = \{/, (m) => m + envBlock);
fs.writeFileSync("next.config.ts", s);
console.log("env injected into next.config.ts");
'

echo "== install =="
npm install --no-audit --no-fund

echo "== migrate (direct connection) =="
DATABASE_URL="$DB_DIRECT" CRON_SECRET="$SECRET" npx drizzle-kit migrate

echo "== build =="
DATABASE_URL="$DB_POOLED" CRON_SECRET="$SECRET" npx next build

echo "== seed venues =="
DATABASE_URL="$DB_DIRECT" CRON_SECRET="$SECRET" npx tsx lib/db/seed.ts || true

echo "== done =="
