/**
 * Nothing secret leaves the machine.
 *
 * The snapshot exists so a diagnosis never again starts as a guess. That is only
 * worth having if the file is safe to push, so the redaction is tested against
 * the shapes a credential actually arrives in — which is rarely a field someone
 * named, and usually a log line, a URL, or an error message.
 */
import { rmSync, readFileSync } from "node:fs";
import { redactSnapshot, writeSnapshot } from "../lib/sweep/metrics/snapshot";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

const KEY = "A".repeat(64);
const SECRET = "b3f9" + "c".repeat(60);
const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

console.log("\n## the shapes a credential actually arrives in");
const cases: [string, string][] = [
  ["a signed URL in a log line", `GET /fapi/v2/account?timestamp=1&signature=deadbeefcafe1234567890abcdef`],
  ["an env assignment in an error", `Error: bad key BINANCE_API_KEY=${KEY}`],
  ["a secret in an env assignment", `BINANCE_API_SECRET=${SECRET}`],
  ["a JSON field", `{"apiSecret":"${SECRET}"}`],
  ["a nested JSON field", `{"cfg":{"apiKey":"${KEY}","live":false}}`],
  ["a bearer header", `authorization: Bearer ${KEY}`],
  ["a bare 64-char key anywhere", `the key is ${KEY} apparently`],
  ["the control token", `http://127.0.0.1:8787/?token=${TOKEN}`],
  ["an X bearer", `SWEEP_X_BEARER=${KEY}`],
];
for (const [name, text] of cases) {
  const out = redactSnapshot(text);
  const leaked = out.includes(KEY) || out.includes(SECRET) || out.includes(TOKEN) ||
    /signature=[A-Fa-f0-9]{16,}/i.test(out);
  ok(name, !leaked, out.slice(0, 78));
}

console.log("\n## it survives being nested deep inside a real payload");
const path = "/tmp/sweep-checks/snap-test.json";
rmSync(path, { force: true });
writeSnapshot({
  status: { mode: "testnet", limits: { maxPositionUsd: 32845 } },
  log: [
    { t: 1, text: `execution failed: 400 signature=abcdef0123456789abcdef` },
    { t: 2, text: `loaded BINANCE_API_KEY=${KEY}` },
    { t: 3, text: "ordinary line with no secret in it" },
  ],
  nested: { deeply: { cfg: { apiSecret: SECRET } } },
}, path);
const written = readFileSync(path, "utf8");
ok("no key in the written file", !written.includes(KEY));
ok("no secret in the written file", !written.includes(SECRET));
ok("no signature in the written file", !/signature=[A-Fa-f0-9]{16,}/i.test(written));
ok("the ordinary line is untouched", written.includes("ordinary line with no secret in it"));
ok("the operational data is kept", written.includes("32845") && written.includes("testnet"));

console.log("\n## redaction is idempotent, which is what the pre-push check relies on");
ok("running it twice changes nothing", redactSnapshot(written) === written);

console.log("\n## it does not mangle what it should keep");
for (const keep of [
  "BTCUSDT", "already took trades today, the cap is 8", "$3,300.00",
  "bids at 1.17x expected, asks at 1.00x", "65157.05",
]) {
  ok(`keeps "${keep.slice(0, 40)}"`, redactSnapshot(keep) === keep, redactSnapshot(keep));
}

rmSync(path, { force: true });
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
