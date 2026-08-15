/** The note thread: two files, one direction each, never a conflict. */
process.env.SWEEP_MESSAGES = "/tmp/sweep-checks/msg/out.jsonl";
process.env.SWEEP_REPLIES  = "/tmp/sweep-checks/msg/rep.jsonl";
import { rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { appendNote, appendReply, outbox, outboxPath, repliesPath, thread, MAX_LEN } from "../lib/sweep/agent/messages";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };
const DIR = "/tmp/sweep-checks/msg";
rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });

console.log("\n## writing a note");
const r = appendNote("this short looked wrong", { symbol: "BTCUSDT", mid: 64285, armed: true, holding: -0.225 });
ok("accepted", r.ok, r.note);
ok("carries the state it was written at", r.message?.context?.symbol === "BTCUSDT" && r.message?.context?.holding === -0.225);
ok("it is in the outbox", outbox().length === 1);

console.log("\n## a reply arrives in the other file");
appendReply("that was the hourly ceiling, not the signal");
ok("outbox is untouched by a reply", outbox().length === 1, String(outbox().length));
ok("the thread merges both", thread().length === 2, String(thread().length));
ok("ordered oldest first", thread()[0].from === "operator" && thread()[1].from === "claude");
ok("the two files are different paths", outboxPath() !== repliesPath());

console.log("\n## neither side ever writes the other's file");
const outBefore = readFileSync(outboxPath(), "utf8");
appendReply("second reply");
ok("appending a reply does not touch the outbox", readFileSync(outboxPath(), "utf8") === outBefore);
const repBefore = readFileSync(repliesPath(), "utf8");
appendNote("another note");
ok("appending a note does not touch the replies", readFileSync(repliesPath(), "utf8") === repBefore);

console.log("\n## refusals and bounds");
ok("empty is refused", !appendNote("   ").ok);
ok("a very long note is truncated, not dropped",
  appendNote("x".repeat(MAX_LEN + 500)).message?.text.length === MAX_LEN);

console.log("\n## a corrupt line does not lose the thread");
writeFileSync(outboxPath(), readFileSync(outboxPath(), "utf8") + "{not json\n");
ok("still reads the good lines", thread().length >= 4, String(thread().length));

console.log("\n## an absent file is empty, not an error");
rmSync(repliesPath(), { force: true });
ok("no replies yet is fine", thread().every((m) => m.from === "operator"));

rmSync(DIR, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
