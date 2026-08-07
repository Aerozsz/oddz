/**
 * Does this key work, and is it pointed at the right place?
 *
 *   npm run sweep:check
 *
 * One round trip, no orders, nothing written. It exists because the failure
 * modes here are all silent and all look alike: a live key used against demo,
 * a demo key used against live, Futures not enabled on the key, an IP
 * allowlist that does not include this machine, a clock a few seconds out.
 * Every one of them surfaces as an authentication error somewhere deep inside
 * the control server, and each has a completely different fix.
 *
 * So this asks the one question and reports the specific answer.
 */

import { resolve } from "node:path";
import { loadEnv } from "./load-env";
import {
  type BinanceConfig,
  MissingCredentials,
  fetchAccountRisk,
  loadConfig,
} from "../lib/sweep/exchange/binance";

const dotenv = loadEnv();

console.log("");
if (!dotenv.found) {
  console.log("  No .env file found in this folder.");
  console.log(`  Expected it at ${resolve(".env")}`);
  console.log("");
  console.log("  On Windows, Notepad saves it as .env.txt unless you set");
  console.log('  "Save as type" to "All Files". Check with:  Get-ChildItem -Force .env');
  console.log("");
  process.exit(1);
}
console.log(`  .env read — ${dotenv.count} value${dotenv.count === 1 ? "" : "s"} set`);

let cfg: BinanceConfig;
try {
  cfg = loadConfig();
} catch (err) {
  if (err instanceof MissingCredentials) {
    console.log(`  ${err.message}`);
    console.log("");
    console.log("  The file exists but the keys are not in it, or the names are misspelt.");
    console.log("  They must be exactly:");
    console.log("      BINANCE_API_KEY=...");
    console.log("      BINANCE_API_SECRET=...");
    console.log("");
    process.exit(1);
  }
  throw err;
}

console.log(`  mode    ${cfg.live ? "LIVE — real money" : "demo trading (play money)"}`);
console.log(`  calling ${cfg.baseUrl}`);
console.log("");

// Wrapped rather than left at the top level: tsx transpiles these workers to
// CJS, where a top-level await is a build error rather than a runtime one.
async function main() {
  const t0 = Date.now();

  try {
    const risk = await fetchAccountRisk(cfg);
  const elapsed = Date.now() - t0;

  console.log("  ✓ the key works");
  console.log("");
  console.log(`  balance        ${risk.walletBalance.toFixed(2)} USDT`);
  console.log(`  available      ${risk.availableBalance.toFixed(2)} USDT`);
  console.log(`  open positions ${risk.openPositions.length}`);
  for (const p of risk.openPositions) {
    console.log(
      `                 ${p.symbol} ${p.positionAmt > 0 ? "long" : "short"} ${Math.abs(p.positionAmt)} ` +
        `@ ${p.entryPrice} · liq ${p.liquidationPrice || "—"} · pnl ${p.unrealizedPnl.toFixed(2)}`,
    );
  }
  console.log(`  round trip     ${elapsed}ms`);
  console.log("");

  if (cfg.live) {
    console.log("  This is a LIVE key. Check that withdrawals are disabled on it,");
    console.log("  and that it is restricted to this machine's IP.");
    console.log("");
  }
  if (risk.walletBalance === 0) {
    console.log("  Balance is zero. On demo trading, the faucet is on the testnet");
    console.log("  page — you have to ask it for funds before anything can be sized.");
    console.log("");
  }
  console.log("  Next:  npm run sweep:control");
  console.log("");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.log("  ✗ the key was rejected");
  console.log("");
  console.log(`    ${message}`);
  console.log("");

  if (message.includes("-4411")) {
    console.log("  The key works — this is a policy rejection, not an authentication one.");
    console.log("");
    console.log("  INTCUSDT is a TradFi perpetual: it tracks a stock rather than a token, and");
    console.log("  Binance requires a separate agreement for those on top of the futures one.");
    console.log("  Open the INTCUSDT page in the Binance interface for this environment, accept");
    console.log("  the prompt, and retry. One-off per account; there is no API for it.");
  } else if (message.includes("-2015") || message.includes("-2014")) {
    console.log("  That code means the key was not accepted at all. In order of likelihood:");
    console.log("");
    if (!cfg.live) {
      console.log("    1. It is a LIVE key. Demo and live keys are not interchangeable —");
      console.log("       a demo key is made at testnet.binancefuture.com, and only works");
      console.log(`       against ${cfg.baseUrl}.`);
    } else {
      console.log("    1. It is a DEMO key being used against live. Set BINANCE_LIVE= (blank).");
    }
    console.log("    2. Futures is not enabled on the key.");
    console.log("    3. The key has an IP allowlist that does not include this machine.");
    console.log("    4. A character got lost pasting it — check for spaces or quotes.");
  } else if (message.includes("-1021")) {
    console.log("  The clock on this machine disagrees with Binance by more than the");
    console.log("  allowed window. On Windows: Settings → Time & language → Date & time");
    console.log("  → Sync now.");
  } else if (message.includes("fetch") || message.includes("ENOTFOUND") || message.includes("timeout")) {
    console.log(`  The request never reached ${cfg.baseUrl}. Same network or region issue`);
    console.log("  that would stop the market data feed — a VPN or firewall in the way.");
  }
  console.log("");
  process.exit(1);
}
}

void main();
