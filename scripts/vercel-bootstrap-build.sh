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

echo "== injecting runtime secrets into next.config.ts =="
cat > next.config.ts <<CFG
import type { NextConfig } from "next";
const config: NextConfig = {
  typedRoutes: true,
  env: {
    DATABASE_URL: "${DB_POOLED}",
    CRON_SECRET: "${SECRET}",
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "polymarket-upload.s3.us-east-2.amazonaws.com" },
      { protocol: "https", hostname: "manifold.markets" },
      { protocol: "https", hostname: "kalshi.com" },
    ],
  },
};
export default config;
CFG

echo "== install =="
npm install --no-audit --no-fund

echo "== migrate (direct connection) =="
DATABASE_URL="$DB_DIRECT" CRON_SECRET="$SECRET" npx drizzle-kit migrate

echo "== build =="
DATABASE_URL="$DB_POOLED" CRON_SECRET="$SECRET" npx next build

echo "== seed venues =="
DATABASE_URL="$DB_DIRECT" CRON_SECRET="$SECRET" npx tsx lib/db/seed.ts || true

echo "== done =="
