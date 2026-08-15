/**
 * Day counting when the account's own history stops being true.
 *
 * The case: a testnet reset puts the wallet back to its starting balance and
 * leaves every income row before it in place. The ledger then reports trades
 * whose money no longer exists, and every cap measured against "today" is wrong
 * in the same direction.
 */
process.env.SWEEP_LEDGER = "/tmp/sweep-checks/ledger-test.json";

import { rmSync } from "node:fs";
import { countFrom, ledgerPath, rebaseNow, readEpoch, reconcileLedger, writeEpoch } from "../lib/sweep/exchange/ledger";
import { startOfDayUtc } from "../lib/sweep/exchange/activity";
import type { BinanceConfig } from "../lib/sweep/exchange/binance";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

const PATH = ledgerPath();
const cfg = { apiKey: "k", apiSecret: "s", baseUrl: "https://stub", live: false, recvWindowMs: 5000 } as BinanceConfig;

let rows: { incomeType: string; income: string; time: number }[] = [];
let failNext = false;
globalThis.fetch = (async () => {
  if (failNext) return new Response("nope", { status: 500, statusText: "Server Error" });
  return new Response(JSON.stringify(rows), { status: 200 });
}) as typeof fetch;

const NOW = Date.now();

async function main() {
  rmSync(PATH, { force: true });

  console.log("\n## first sight of an account");
  let r = await reconcileLedger(cfg, 5000, NOW);
  ok("adopts the balance without claiming a reset", r.reset === null);
  ok("counts from midnight", r.epoch.epoch === startOfDayUtc(NOW), new Date(r.epoch.epoch).toISOString());

  console.log("\n## an ordinary trading day");
  // Lost $240, paid $40 in fees. Balance moves to 4720; the ledger explains it.
  rows = [
    { incomeType: "REALIZED_PNL", income: "-240", time: NOW + 1000 },
    { incomeType: "COMMISSION", income: "-40", time: NOW + 1001 },
  ];
  r = await reconcileLedger(cfg, 4720, NOW + 60_000);
  ok("explained losses do not move the window", r.reset === null, r.epoch.reason);
  ok("still counting from midnight", r.epoch.epoch === startOfDayUtc(NOW));
  ok("the balance observation rolls forward", r.epoch.balance === 4720, String(r.epoch.balance));

  console.log("\n## a deposit, which the ledger does explain");
  rows = [{ incomeType: "TRANSFER", income: "1000", time: NOW + 70_000 }];
  r = await reconcileLedger(cfg, 5720, NOW + 120_000);
  ok("a transfer in is not mistaken for a reset", r.reset === null, r.epoch.reason);
  ok("...and today's P&L is left alone", r.epoch.epoch === startOfDayUtc(NOW));

  console.log("\n## the testnet reset");
  // The exchange puts the wallet back to 3300 and writes no row for it.
  rows = [];
  r = await reconcileLedger(cfg, 3300, NOW + 180_000);
  ok("an unexplained credit is caught", r.reset !== null, JSON.stringify(r.reset));
  ok("counting restarts at the moment it was noticed", r.epoch.epoch === NOW + 180_000);
  ok("the reason says what happened", /no ledger row/.test(r.epoch.reason), r.epoch.reason);
  ok("the gap is reported for the log", r.reset ? Math.abs(r.reset.gap - (3300 - 5720)) < 1 : false,
    String(r.reset?.gap));

  console.log("\n## the floor holds afterwards");
  ok("countFrom is now the reset, not midnight", countFrom(NOW + 200_000) === NOW + 180_000);
  ok("...and never earlier than midnight", countFrom(NOW + 200_000) >= startOfDayUtc(NOW));

  console.log("\n## an unexplained debit is caught too");
  writeEpoch({ epoch: startOfDayUtc(NOW), balance: 5000, at: NOW, reason: "test" });
  rows = [];
  r = await reconcileLedger(cfg, 100, NOW + 60_000);
  ok("money leaving with no row behind it also rebases", r.reset !== null, String(r.reset?.gap));

  console.log("\n## small differences are noise, not resets");
  writeEpoch({ epoch: startOfDayUtc(NOW), balance: 5000, at: NOW, reason: "test" });
  rows = [];
  r = await reconcileLedger(cfg, 4990, NOW + 60_000);
  ok("a $10 discrepancy is tolerated", r.reset === null, r.epoch.reason);

  writeEpoch({ epoch: startOfDayUtc(NOW), balance: 1_000_000, at: NOW, reason: "test" });
  r = await reconcileLedger(cfg, 999_000, NOW + 60_000);
  ok("the tolerance scales with the account", r.reset === null, r.epoch.reason);

  console.log("\n## a failed ledger read is not evidence of anything");
  writeEpoch({ epoch: startOfDayUtc(NOW), balance: 5000, at: NOW, reason: "test" });
  failNext = true;
  r = await reconcileLedger(cfg, 99, NOW + 60_000);
  failNext = false;
  ok("an unreachable ledger leaves the window alone", r.reset === null && r.epoch.epoch === startOfDayUtc(NOW),
    r.epoch.reason);

  console.log("\n## by hand");
  const e = rebaseNow(3300, NOW + 300_000);
  ok("the manual reset moves the window", e.epoch === NOW + 300_000);
  ok("...and says who did it", /by hand/.test(e.reason), e.reason);
  ok("it survives a re-read", readEpoch().epoch === NOW + 300_000);

  console.log("\n## a corrupt file does not take the server down");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(PATH, "{{{");
  ok("falls back to counting from midnight", readEpoch().epoch === 0 && countFrom(NOW) === startOfDayUtc(NOW));

  rmSync(PATH, { force: true });
  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
}

main();
