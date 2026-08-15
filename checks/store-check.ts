import { activeEvents, readStore, recordEvent } from "@/lib/sweep/metrics/event-store";
import { eventRisk } from "@/lib/sweep/metrics/events";
import { rmSync, writeFileSync } from "node:fs";
import * as store from "@/lib/sweep/metrics/event-store";

const P = "/tmp/sweep-checks/evstore.json";
rmSync(P, { force: true });

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

const future = new Date(Date.now() + 40 * 86_400_000).toISOString();

console.log("\n## agent-written calendar");

// Sourced + confirmed stays confirmed and blacks out.
let r = recordEvent({ label: "Intel Q3", at: future, sourceUrl: "https://intc.com/ir", recordedBy: "hermes" }, P);
ok("a sourced date is recorded", r.ok, r.error ?? "");
ok("...and stays confirmed", r.event?.certainty === "confirmed", r.event?.certainty);
ok("...with provenance", r.event?.recordedBy === "hermes" && r.event?.sourceUrl !== null);

const at = Date.parse(future);
ok("a confirmed date blacks out", eventRisk(at - 3600_000, activeEvents(P)).blackout);

// Unsourced "confirmed" is downgraded rather than trusted.
rmSync(P, { force: true });
r = recordEvent({ label: "Rumoured date", at: future, recordedBy: "hermes" }, P);
ok("an unsourced date is downgraded", r.event?.certainty === "projected", r.downgraded ?? "");
ok("...and cannot black out", !eventRisk(at - 3600_000, activeEvents(P)).blackout);
ok("...but still derates size", eventRisk(at - 3600_000, activeEvents(P)).sizeScale < 1);
ok("...and is labelled unsourced", activeEvents(P)[0].label.includes("unsourced"), activeEvents(P)[0].label);

// Corrections supersede rather than delete.
rmSync(P, { force: true });
recordEvent({ label: "Intel Q3", at: future, sourceUrl: "https://a" }, P);
const corrected = new Date(Date.parse(future) + 2 * 86_400_000).toISOString();
recordEvent({ label: "Intel Q3 (corrected)", at: corrected, sourceUrl: "https://b" }, P);
ok("both entries are kept on disk", readStore(P).length === 2, `${readStore(P).length}`);
ok("only the newest is active", activeEvents(P).length === 1);
ok("...and it is the correction", activeEvents(P)[0].at === Date.parse(corrected));
ok("the superseded one is marked, not removed", readStore(P).some((e) => e.supersededBy));

// Nothing can remove a blackout.
ok("no delete exists on the store", !("deleteEvent" in store) && !("removeEvent" in store));

// Rejections.
ok("a past date is refused", !recordEvent({ label: "old", at: "2020-01-01T00:00:00Z" }, P).ok);
ok("an unparseable date is refused", !recordEvent({ label: "x", at: "next tuesday-ish" }, P).ok);
ok("a blank label is refused", !recordEvent({ label: "   ", at: future }, P).ok);

// A corrupt file falls back rather than throwing.
writeFileSync(P, "{not json");
ok("a corrupt calendar falls back to empty", activeEvents(P).length === 0);

rmSync(P, { force: true });
console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails ? 1 : 0);
