import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * A thread between the operator and whoever is analysing the run.
 *
 * The gap this closes is small and kept costing whole exchanges. Something looks
 * wrong at 03:00 — a trade that should not have fired, a setup that was skipped,
 * a number that reads oddly — and by the time it comes up the moment is gone and
 * the snapshot that would have explained it has rolled past. The observation and
 * the state it refers to end up in different places.
 *
 * So a note typed on the page is attached to the run rather than to a chat
 * window: it goes out with the next snapshot, alongside the limits, the refusals
 * and the log for that exact minute.
 *
 * ## Why two files rather than one
 *
 * The obvious design is a single thread both sides append to. That guarantees a
 * git conflict, every time: the operator's machine is writing new lines while a
 * reply is being written to the same file elsewhere, and both are pushing to the
 * same branch.
 *
 * So each direction owns a file and never writes the other's. Outbound notes are
 * carried inside the snapshot, which is already pushed; replies arrive in
 * `control/replies.jsonl`, which is already pulled. Neither side ever edits a
 * file the other is appending to, so there is nothing to resolve. The page merges
 * the two by timestamp and shows one conversation.
 */

export interface Message {
  at: number;
  from: "operator" | "claude";
  text: string;
  /**
   * What the run looked like when it was written.
   *
   * A note saying "this one looked wrong" is close to useless a day later
   * without it. Filled in by the server for operator notes; absent on replies.
   */
  context?: { symbol: string | null; mid: number | null; armed: boolean; holding: number };
}

const MAX_KEEP = 200;
/** Long enough for a real observation, short enough to stay a note. */
const MAX_LEN = 2000;

export function outboxPath(): string {
  return resolve(process.env.SWEEP_MESSAGES ?? "data/sweep-messages.jsonl");
}

export function repliesPath(): string {
  return resolve(process.env.SWEEP_REPLIES ?? "control/replies.jsonl");
}

function readJsonl(path: string): Message[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as Message;
        } catch {
          return null;
        }
      })
      .filter((m): m is Message => Boolean(m && typeof m.text === "string" && Number.isFinite(m.at)));
  } catch {
    return [];
  }
}

/** Everything either side has said, oldest first. */
export function thread(limit = 60): Message[] {
  return [...readJsonl(outboxPath()), ...readJsonl(repliesPath())]
    .sort((a, b) => a.at - b.at)
    .slice(-limit);
}

/** Just the operator's notes, for carrying in the snapshot. */
export function outbox(limit = 40): Message[] {
  return readJsonl(outboxPath()).slice(-limit);
}

export interface AppendResult {
  ok: boolean;
  note: string;
  message: Message | null;
}

export function appendNote(text: string, context?: Message["context"]): AppendResult {
  const clean = String(text ?? "").trim().slice(0, MAX_LEN);
  if (!clean) return { ok: false, note: "nothing to send", message: null };

  const message: Message = { at: Date.now(), from: "operator", text: clean, context };
  const path = outboxPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    /*
     * Appended rather than rewritten, and never trimmed on write.
     *
     * Trimming means reading the whole file, dropping lines and writing it back,
     * which turns every note into a chance to lose the ones before it. The
     * reader caps what it shows instead; the file is a few kilobytes a week.
     */
    appendFileSync(path, `${JSON.stringify(message)}\n`);
    return { ok: true, note: "sent — it goes out with the next snapshot", message };
  } catch (err) {
    return { ok: false, note: err instanceof Error ? err.message : String(err), message: null };
  }
}

/** Used from the analysis side to answer. Appends to the file that is pulled. */
export function appendReply(text: string, path = repliesPath()): AppendResult {
  const clean = String(text ?? "").trim().slice(0, MAX_LEN);
  if (!clean) return { ok: false, note: "nothing to send", message: null };
  const message: Message = { at: Date.now(), from: "claude", text: clean };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(message)}\n`);
    return { ok: true, note: "written", message };
  } catch (err) {
    return { ok: false, note: err instanceof Error ? err.message : String(err), message: null };
  }
}

export { MAX_KEEP, MAX_LEN };
