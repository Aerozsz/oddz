/**
 * Read a single-entry zip without a dependency or a shell.
 *
 * The archive files are zips and Node has no unzip. The obvious answers are a
 * package or shelling out, and both are worse here than forty lines: a package
 * is a supply-chain surface on a machine that holds exchange credentials, and
 * shelling out means `unzip` on one platform and `Expand-Archive` on another,
 * where this runs on Windows and is developed on Linux.
 *
 * `zlib` is already in Node and a zip entry is a deflate stream with a header
 * in front of it.
 */

import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/**
 * Entry names and their bytes.
 *
 * Read through the central directory rather than the local headers, because a
 * local header is allowed to carry zero sizes and defer them to a descriptor
 * after the data — which cannot be parsed forwards. The central directory
 * always has the real numbers.
 */
export function unzipEntries(buf: Buffer): { name: string; data: Buffer }[] {
  // The end-of-central-directory record is last, but a zip comment may follow
  // it, so it is found by scanning backwards over the maximum comment length.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const out: { name: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error(`corrupt central directory at entry ${i}`);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("latin1");

    // The local header repeats the name and extra fields, and its extra field
    // length may differ from the central one — so it has to be read, not assumed.
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compressedSize);

    out.push({ name, data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * The rows of the single CSV inside one of these archives.
 *
 * A header line is present in the recent files and absent in the older ones, so
 * it is detected rather than configured: if the first field of the first row
 * does not parse as a number, it was a header.
 */
export function csvRows(buf: Buffer): string[][] {
  const rows: string[][] = [];
  for (const line of buf.toString("utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    rows.push(t.split(","));
  }
  if (rows.length && !Number.isFinite(Number(rows[0][0])) && !/^\d{4}-\d{2}-\d{2}/.test(rows[0][0])) {
    rows.shift();
  }
  return rows;
}

/**
 * Binance writes timestamps three ways across the archive's lifetime.
 *
 * Milliseconds, microseconds since 2023 in some feeds, and "YYYY-MM-DD hh:mm:ss"
 * in others. Guessing wrong shifts an entire day's alignment by a factor of a
 * thousand, which produces a backtest that runs and is meaningless.
 */
export function parseTs(v: string): number {
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return Date.parse(s.replace(" ", "T") + (s.endsWith("Z") ? "" : "Z"));
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  // 1e15 is the year 33658 in ms and 2001 in µs, so the split is unambiguous
  // for any date this archive covers.
  return n > 1e15 ? Math.floor(n / 1000) : n;
}
