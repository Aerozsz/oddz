import { listening } from "./listening";
import { reading } from "./reading";
import type { Group } from "./types";

function collect(groups: Group[], out: Map<number, string>) {
  for (const g of groups) {
    for (const it of g.items) {
      if (it.kind === "gap") out.set(it.n, [it.before, "____", it.after].filter(Boolean).join(" "));
      else if (it.kind === "mcq" || it.kind === "select" || it.kind === "tfng") out.set(it.n, it.prompt);
      else if (it.kind === "multi") it.ns.forEach((n) => out.set(n, it.prompt));
    }
  }
}

const L = new Map<number, string>();
listening.forEach((p) => collect(p.groups, L));
const R = new Map<number, string>();
reading.forEach((p) => collect(p.groups, R));

export const questionPrompt = (section: "listening" | "reading", n: number) => (section === "listening" ? L : R).get(n) ?? "";
