import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../env";
import * as schema from "./schema";

const url = env().DATABASE_URL;

// Neon's pooled connection string (-pooler suffix) speaks the regular
// Postgres wire protocol, so node-postgres works against both Neon and
// any other Postgres without needing the Neon HTTP driver. We're on
// the Node runtime everywhere, so the HTTP driver's Edge advantage
// doesn't apply here.
const pool = new Pool({
  connectionString: url,
  ssl: needsSsl(url) ? { rejectUnauthorized: false } : false,
  max: 5,
});

export const db = drizzle(pool, { schema, casing: "snake_case" });

export type Db = typeof db;

function needsSsl(u: string): boolean {
  if (/sslmode=disable/.test(u)) return false;
  if (/sslmode=require/.test(u)) return true;
  if (/localhost|127\.0\.0\.1/.test(u)) return false;
  return true;
}
