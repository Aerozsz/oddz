import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The running state of the agent, written to a file that is safe to share.
 *
 * This exists because of a specific and expensive failure mode: the analysis
 * does not run on the machine the agent runs on, so every diagnosis started as
 * a guess, went out as a question, and came back a round trip later. Over one
 * session that produced a sequence of confident wrong answers — a target gate
 * blamed for refusals that were actually a trade cap, a maker path called broken
 * when it was gated, a settings form reported as wiped when it was a render
 * throw. Every one of those was answerable from state the server already held.
 *
 * So the server writes what it knows, continuously, and the file can be pushed
 * to the repository like any other artefact.
 *
 * ## What must never be in it
 *
 * Credentials, signatures, and the control token. The redaction below is applied
 * to the serialised text rather than to individual fields, because the failure
 * that matters is a secret arriving somewhere nobody thought to look — inside a
 * log line, an error message, a URL in a stack trace. Redacting the finished
 * string catches those; redacting known fields does not.
 *
 * Balances and positions are kept. They are not secrets, they are the subject.
 */

/** Applied to the whole serialised snapshot, not to chosen fields. */
export function redactSnapshot(text: string): string {
  return text
    // Signed request signatures, wherever they surface.
    .replace(/(signature=)[A-Fa-f0-9]+/gi, "$1<redacted>")
    // Environment-style assignments, in logs or error text.
    .replace(/((?:BINANCE_API_(?:KEY|SECRET)|SWEEP_CONTROL_TOKEN|SWEEP_X_BEARER)\s*[=:]\s*)\S+/gi, "$1<redacted>")
    // JSON fields by name, whatever nests them.
    .replace(/("(?:apiKey|apiSecret|secret|token|password|bearer|authorization)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"')
    // Bearer headers.
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/g, "$1<redacted>")
    /*
     * Anything with the shape of a Binance key or secret.
     *
     * Both are 64 alphanumeric characters. This is deliberately blunt and will
     * occasionally redact an innocent hash — which costs a line of a diagnostic
     * file, against an account for being wrong the other way.
     */
    .replace(/\b[A-Za-z0-9]{64}\b/g, "<redacted-64>")
    // The control token, which is 32 hex characters when generated.
    .replace(/\b[A-Fa-f0-9]{32}\b/g, "<redacted-32>");
}

export interface SnapshotMeta {
  at: number;
  /** Which commit produced this, so a report is tied to the code that made it. */
  revision: string | null;
  node: string;
  platform: string;
}

export function snapshotPath(): string {
  return resolve(process.env.SWEEP_SNAPSHOT ?? "evidence/snapshot.json");
}

/**
 * Write it, redacted, atomically.
 *
 * Atomic because this file is read by another process on its own clock, and a
 * reader landing mid-write gets a parse error that looks exactly like the agent
 * having crashed.
 */
export function writeSnapshot(payload: unknown, path = snapshotPath()): { bytes: number; path: string } {
  const text = redactSnapshot(`${JSON.stringify(payload, null, 2)}\n`);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return { bytes: text.length, path };
}
