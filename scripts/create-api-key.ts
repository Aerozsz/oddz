/**
 * Mint an API key: prints the raw key once, stores only its hash.
 * Usage: npx tsx scripts/create-api-key.ts "customer name" [free|pro]
 */
import { randomBytes } from "node:crypto";
import { db } from "../lib/db/client";
import { apiKeys } from "../lib/db/schema";
import { hashKey } from "../lib/api-auth";

async function main() {
  const name = process.argv[2];
  const tier = process.argv[3] ?? "free";
  if (!name || !["free", "pro"].includes(tier)) {
    console.error('Usage: npx tsx scripts/create-api-key.ts "customer name" [free|pro]');
    process.exit(1);
  }

  const raw = `oddz_${tier}_${randomBytes(24).toString("hex")}`;
  await db.insert(apiKeys).values({ keyHash: hashKey(raw), name, tier });

  console.log(`API key created for "${name}" (${tier}):\n\n  ${raw}\n`);
  console.log("Store it now — only the hash is kept server-side.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
