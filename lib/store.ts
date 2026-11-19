import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { del, get, list, put } from "@vercel/blob";
import type { Attempt } from "./types";

/**
 * Storage: a private Vercel Blob store in production (BLOB_READ_WRITE_TOKEN),
 * or the local ./.data folder during development.
 */
const blobConfigured = !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
// Never fall back to local disk on Vercel: it is read-only and not persistent.
const useBlob = blobConfigured || !!process.env.VERCEL;
const LOCAL = path.join(process.cwd(), ".data");

export class StorageNotConfigured extends Error {
  constructor() { super("Storage is not connected. Connect a Vercel Blob store to this project, then redeploy."); }
}
function ensureConfigured() {
  if (useBlob && !blobConfigured) throw new StorageNotConfigured();
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function writeFile(p: string, body: Buffer | string, contentType: string) {
  ensureConfigured();
  if (useBlob) {
    await put(p, body, { access: "private", contentType, allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 60 });
    return;
  }
  const full = path.join(LOCAL, p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body);
}

export async function readFile(p: string): Promise<{ body: Buffer; contentType: string } | null> {
  ensureConfigured();
  if (useBlob) {
    const r = await get(p, { access: "private", useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return { body: await streamToBuffer(r.stream), contentType: r.blob.contentType };
  }
  try {
    const body = await fs.readFile(path.join(LOCAL, p));
    const ext = path.extname(p);
    const contentType = ext === ".json" ? "application/json" : ext === ".mp4" || ext === ".m4a" ? "audio/mp4" : ext === ".ogg" ? "audio/ogg" : "audio/webm";
    return { body, contentType };
  } catch {
    return null;
  }
}

async function listPaths(prefix: string): Promise<string[]> {
  ensureConfigured();
  if (useBlob) {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await list({ prefix, cursor, limit: 1000 });
      out.push(...r.blobs.map((b) => b.pathname));
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out;
  }
  const dir = path.join(LOCAL, prefix);
  try {
    const walk = async (d: string): Promise<string[]> => {
      const ents = await fs.readdir(d, { withFileTypes: true });
      const res = await Promise.all(ents.map((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])));
      return res.flat();
    };
    return (await walk(dir)).map((f) => path.relative(LOCAL, f).split(path.sep).join("/"));
  } catch {
    return [];
  }
}

async function removePaths(paths: string[]) {
  if (paths.length === 0) return;
  if (useBlob) return del(paths);
  await Promise.all(paths.map((p) => fs.rm(path.join(LOCAL, p), { force: true })));
}

const attemptPath = (id: string) => `attempts/${id}.json`;

export async function saveAttempt(a: Attempt) {
  a.updatedAt = new Date().toISOString();
  await writeFile(attemptPath(a.id), JSON.stringify(a), "application/json");
}

export async function getAttempt(id: string): Promise<Attempt | null> {
  if (!/^[a-z0-9-]{8,64}$/i.test(id)) return null;
  const f = await readFile(attemptPath(id));
  if (!f) return null;
  return JSON.parse(f.body.toString("utf8")) as Attempt;
}

export async function listAttempts(): Promise<Attempt[]> {
  const paths = (await listPaths("attempts/")).filter((p) => p.endsWith(".json"));
  const results: Attempt[] = [];
  // Read in small batches to stay friendly to the API.
  for (let i = 0; i < paths.length; i += 16) {
    const batch = await Promise.all(paths.slice(i, i + 16).map((p) => readFile(p)));
    for (const f of batch) if (f) { try { results.push(JSON.parse(f.body.toString("utf8"))); } catch { /* skip corrupt */ } }
  }
  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveAudio(id: string, part: string, body: Buffer, contentType: string) {
  const ext = contentType.includes("mp4") ? "m4a" : contentType.includes("ogg") ? "ogg" : "webm";
  const p = `audio/${id}/${part}.${ext}`;
  await writeFile(p, body, contentType);
  return p;
}

export async function deleteAttempt(id: string) {
  const audio = await listPaths(`audio/${id}/`);
  await removePaths([attemptPath(id), ...audio]);
}

export const storageMode = blobConfigured ? "blob" : useBlob ? "missing" : "local";
