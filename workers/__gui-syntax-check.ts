/**
 * Parse the GUI script the control server actually serves.
 *
 * The whole page is a template literal inside sweep-control.ts, which means a
 * single backslash-n in the TypeScript becomes a real newline in the emitted
 * JavaScript and terminates whatever string it was sitting in. That is a
 * syntax error in the served page, not in the TypeScript, so tsc passes, the
 * build passes, the server starts, the HTML renders — and every script on the
 * page is dead. The symptom is a GUI stuck on "connecting…" with no clue as to
 * why, which is exactly how it presented.
 *
 * Nothing else catches it, so this does:  npm run sweep:guicheck
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./sweep-control.ts", import.meta.url), "utf8");

// The page is built from one template literal; pull every <script> body out of
// it without running the server.
/**
 * Evaluate each script body the way the template literal does.
 *
 * Reading the raw source is not enough and misses the exact bug this exists
 * for: in TypeScript source a backslash-n is still two characters, and only
 * becomes a real newline when the literal is evaluated. So the escapes have to
 * be processed the same way the running server processes them, which means
 * actually evaluating a template literal rather than pattern-matching text.
 *
 * `${...}` is server-side interpolation rather than JavaScript, so it is
 * replaced with a placeholder valid in an expression position. What is being
 * checked is the surrounding syntax — above all, strings terminated by an
 * escape that turned into a newline.
 */
function evaluateTemplate(body: string): string {
  const withoutInterpolation = body.replace(/\$\{[\s\S]*?\}/g, "0");
  // Backticks would close the literal being built.
  const safe = withoutInterpolation.replace(/`/g, "\\`");
  return Function(`return \`${safe}\`;`)() as string;
}

const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) =>
  evaluateTemplate(m[1]),
);
if (!scripts.length) {
  console.error("  no <script> block found in sweep-control.ts — has the GUI moved?");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "guicheck-"));
let failed = 0;

scripts.forEach((body, i) => {
  const file = join(dir, `script-${i}.js`);
  writeFileSync(file, body);
  const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (res.status !== 0) {
    failed++;
    console.error(`\n  script ${i} does not parse:\n`);
    console.error(
      (res.stderr ?? "")
        .split("\n")
        .filter((l) => l.trim() && !l.includes("node:internal"))
        .slice(0, 8)
        .map((l) => `    ${l}`)
        .join("\n"),
    );
  }
});

if (failed) {
  console.error(`\n  ${failed} of ${scripts.length} script blocks are broken.\n`);
  process.exit(1);
}
console.log(`  ok — ${scripts.length} script block${scripts.length === 1 ? "" : "s"} parse`);
