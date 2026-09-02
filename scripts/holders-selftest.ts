/**
 * Self-test for the holder tracker against an in-memory fake chain.
 *
 * The tracker's whole job is turning raw logs into a correct picture of who
 * holds what and who is really behind it. That logic is worth proving without
 * a live endpoint, so this script stands up a synthetic chain with a known
 * answer — including a deliberately obfuscated position — and checks the
 * tracker recovers it.
 *
 * Run: npx tsx scripts/holders-selftest.ts
 */

import { SWAP_TOPIC, SYNC_TOPIC, TRANSFER_TOPIC, padAddress } from "../lib/holders/abi";
import { trackerConfig } from "../lib/holders/config";
import { serialize } from "../lib/holders/serialize";
import { Tracker } from "../lib/holders/tracker";

// ------------------------------------------------------------------ fixtures
const TOKEN = "0x" + "11".repeat(20);
const PAIR = "0x" + "22".repeat(20);
const QUOTE = "0x" + "33".repeat(20);
const ZERO = "0x" + "00".repeat(20);

const WHALE = "0x" + "aa".repeat(20);
const HOP = "0x" + "ab".repeat(20); // whale's conduit address
const BUYER = "0x" + "bb".repeat(20);
const TWIN_A = "0x" + "ca".repeat(20); // same signer as TWIN_B
const TWIN_B = "0x" + "cb".repeat(20);
const SHARED_SIGNER = "0x" + "cc".repeat(20);
const RELAYER = "0x" + "dd".repeat(20);
const relayerUser = (i: number) => "0x" + "e" + i.toString(16).padStart(39, "0");

const E18 = 10n ** 18n;
const word = (v: bigint) => v.toString(16).padStart(64, "0");
const hexdata = (...vs: bigint[]) => "0x" + vs.map(word).join("");

interface FakeLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

const logs: FakeLog[] = [];
const txSenders = new Map<string, string>();
let logIndex = 0;

function txHash(n: number): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

function transfer(block: number, tx: number, from: string, to: string, amount: bigint) {
  logs.push({
    address: TOKEN,
    topics: [TRANSFER_TOPIC, "0x" + padAddress(from), "0x" + padAddress(to)],
    data: hexdata(amount),
    blockNumber: "0x" + block.toString(16),
    transactionHash: txHash(tx),
    logIndex: "0x" + (logIndex++).toString(16),
  });
}

/** A swap: token leg plus the pair's Swap event, in one transaction. */
function swap(
  block: number,
  tx: number,
  trader: string,
  side: "buy" | "sell",
  tokenAmt: bigint,
  quoteAmt: bigint,
) {
  if (side === "buy") {
    transfer(block, tx, PAIR, trader, tokenAmt);
    logs.push({
      address: PAIR,
      topics: [SWAP_TOPIC, "0x" + padAddress(trader), "0x" + padAddress(trader)],
      // token is token0: amount0In, amount1In, amount0Out, amount1Out
      data: hexdata(0n, quoteAmt, tokenAmt, 0n),
      blockNumber: "0x" + block.toString(16),
      transactionHash: txHash(tx),
      logIndex: "0x" + (logIndex++).toString(16),
    });
  } else {
    transfer(block, tx, trader, PAIR, tokenAmt);
    logs.push({
      address: PAIR,
      topics: [SWAP_TOPIC, "0x" + padAddress(trader), "0x" + padAddress(trader)],
      data: hexdata(tokenAmt, 0n, 0n, quoteAmt),
      blockNumber: "0x" + block.toString(16),
      transactionHash: txHash(tx),
      logIndex: "0x" + (logIndex++).toString(16),
    });
  }
}

function sync(block: number, tx: number, rToken: bigint, rQuote: bigint) {
  logs.push({
    address: PAIR,
    topics: [SYNC_TOPIC],
    data: hexdata(rToken, rQuote),
    blockNumber: "0x" + block.toString(16),
    transactionHash: txHash(tx),
    logIndex: "0x" + (logIndex++).toString(16),
  });
}

// ------------------------------------------------------------------ scenario
// Seed the pool and mint the whale's stack.
transfer(10, 1, ZERO, PAIR, 20_000n * E18);
transfer(10, 1, ZERO, WHALE, 100_000n * E18);
sync(10, 1, 20_000n * E18, 1_000n * E18);
txSenders.set(txHash(1), WHALE);

// An honest buyer, straight from the pool.
swap(20, 2, BUYER, "buy", 500n * E18, 26n * E18);
txSenders.set(txHash(2), BUYER);

// The whale launders 30k through a fresh address and sells it from there.
// Naive ranking would show HOP as an unrelated seller.
transfer(30, 3, WHALE, HOP, 30_000n * E18);
txSenders.set(txHash(3), WHALE);
swap(31, 4, HOP, "sell", 30_000n * E18, 700n * E18);
txSenders.set(txHash(4), RELAYER); // routed through a relayer to break the trail
sync(31, 4, 49_500n * E18, 274n * E18);

// Two addresses signed by the same low-fan-out key: one actor, two wallets.
swap(40, 5, TWIN_A, "buy", 200n * E18, 3n * E18);
txSenders.set(txHash(5), SHARED_SIGNER);
swap(41, 6, TWIN_B, "buy", 300n * E18, 5n * E18);
txSenders.set(txHash(6), SHARED_SIGNER);

// The relayer also serves many unrelated users. Its fan-out must disqualify it
// as identity evidence, or every one of these merges into a phantom whale.
for (let i = 0; i < 20; i++) {
  const tx = 100 + i;
  swap(50 + i, tx, relayerUser(i), "buy", 10n * E18, 1n * E18);
  txSenders.set(txHash(tx), RELAYER);
}
sync(80, 200, 45_000n * E18, 300n * E18);

const HEAD = 100;

// ------------------------------------------------------------- fake endpoint
function callResult(to: string, data: string): string {
  const sel = data.slice(0, 10);
  if (to === TOKEN) {
    if (sel === "0x313ce567") return hexdata(18n); // decimals
    if (sel === "0x18160ddd") return hexdata(120_000n * E18); // totalSupply
    if (sel === "0x95d89b41") return encodeStr("FAKE");
    if (sel === "0x06fdde03") return encodeStr("Fake Token");
  }
  if (to === PAIR) {
    if (sel === "0x0dfe1681") return "0x" + padAddress(TOKEN); // token0
    if (sel === "0xd21220a7") return "0x" + padAddress(QUOTE); // token1
    if (sel === "0x0902f1ac") return hexdata(45_000n * E18, 300n * E18, 0n);
  }
  if (to === QUOTE && sel === "0x313ce567") return hexdata(18n);
  return "0x";
}

function encodeStr(s: string): string {
  const hexs = Buffer.from(s, "utf8").toString("hex").padEnd(64, "0");
  return "0x" + word(32n) + word(BigInt(s.length)) + hexs;
}

function handle(method: string, params: unknown[]): unknown {
  switch (method) {
    case "eth_blockNumber":
      return "0x" + HEAD.toString(16);
    case "eth_chainId":
      return "0x1";
    case "eth_call": {
      const p = params[0] as { to: string; data: string };
      return callResult(p.to.toLowerCase(), p.data);
    }
    case "eth_getCode": {
      const addr = (params[0] as string).toLowerCase();
      const block = params[1] as string;
      const contracts = new Set([TOKEN, PAIR, QUOTE]);
      if (!contracts.has(addr)) return "0x";
      // The token exists from block 5 onward, so the deploy-block search has
      // a real boundary to find.
      if (block !== "latest" && Number(BigInt(block)) < 5) return "0x";
      return "0x60806040";
    }
    case "eth_getTransactionByHash": {
      const h = (params[0] as string).toLowerCase();
      const from = txSenders.get(h);
      return from ? { from, hash: h } : null;
    }
    case "eth_getLogs": {
      const f = params[0] as { address: string; topics: unknown[]; fromBlock: string; toBlock: string };
      const from = Number(BigInt(f.fromBlock));
      const to = Number(BigInt(f.toBlock));
      const addr = f.address.toLowerCase();
      const want = f.topics[0];
      const wanted = Array.isArray(want) ? (want as string[]) : [want as string];
      return logs.filter((l) => {
        const b = Number(BigInt(l.blockNumber));
        return (
          l.address.toLowerCase() === addr &&
          b >= from &&
          b <= to &&
          wanted.includes(l.topics[0])
        );
      });
    }
    default:
      return null;
  }
}

globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const one = (r: { id: number; method: string; params: unknown[] }) => ({
    jsonrpc: "2.0",
    id: r.id,
    result: handle(r.method, r.params ?? []),
  });
  const payload = Array.isArray(body) ? body.map(one) : one(body);
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

// ------------------------------------------------------------------- asserts
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const cfg = trackerConfig({
    rpcUrls: ["http://fake"],
    token: TOKEN,
    pair: PAIR,
    fromBlock: 0,
    logChunk: 1_000,
    topN: 50,
  });
  const tracker = new Tracker(cfg);
  const snap = serialize(await tracker.refresh(20_000));

  console.log(`\ntoken: ${snap.token.name} (${snap.token.symbol}) dec=${snap.token.decimals}`);
  console.log(`indexed to block ${snap.indexedBlock} of ${snap.headBlock}`);
  console.log(`holders=${snap.holderCount} entities=${snap.entities.length}\n`);

  console.log("top entities:");
  for (const e of snap.entities.slice(0, 6)) {
    console.log(
      `  #${e.rank} ${e.id.slice(0, 10)} bal=${e.balance.toFixed(0)} addrs=${e.addressCount} ` +
        `buys=${e.behavior.buyCount} sells=${e.behavior.sellCount} ` +
        `acq=${e.behavior.acquisition} dist=${(e.behavior.distributionRatio * 100).toFixed(0)}%` +
        (e.viaRelayer ? " [relayed]" : ""),
    );
  }
  console.log("");

  // --- metadata and replay
  check("token metadata decoded", snap.token.symbol === "FAKE" && snap.token.decimals === 18);
  check("replay reached head", snap.indexedBlock >= HEAD);

  // --- balances are chain truth
  const whale = snap.entities.find((e) => e.addresses.includes(WHALE));
  check("whale entity exists", !!whale);
  // 100k minted, 30k moved to the hop, hop sold it all -> 70k remains.
  check(
    "whale balance is 70k after the laundered sale",
    !!whale && Math.abs(whale.balance - 70_000) < 1,
    whale ? `got ${whale.balance}` : "",
  );

  // --- the trail-following claim
  check(
    "conduit address clustered into the whale",
    !!whale && whale.addresses.includes(HOP),
    whale ? `addresses: ${whale.addresses.length}` : "",
  );
  check(
    "the laundered sale is attributed to the whale",
    !!whale && whale.behavior.sellCount === 1 && whale.behavior.soldTokens > 29_000,
    whale ? `sells=${whale.behavior.sellCount} sold=${whale.behavior.soldTokens}` : "",
  );
  check("relayer routing flagged on the row", !!whale && whale.viaRelayer);

  // --- shared-signer clustering
  const twin = snap.entities.find((e) => e.addresses.includes(TWIN_A));
  check(
    "same-signer wallets merged",
    !!twin && twin.addresses.includes(TWIN_B),
    twin ? `addresses=${twin.addresses.join(",")}` : "not found",
  );
  check(
    "merged twin balance is the sum",
    !!twin && Math.abs(twin.balance - 500) < 1,
    twin ? `got ${twin.balance}` : "",
  );

  // --- relayer must NOT merge its users
  check(
    "relayer identified as infrastructure",
    snap.relayers.some((r) => r.address === RELAYER),
    `relayers=${snap.relayers.map((r) => r.address.slice(0, 8)).join(",")}`,
  );
  const relayerEntities = snap.entities.filter((e) =>
    e.addresses.some((a) => a.startsWith("0xe")),
  );
  const anyMerged = relayerEntities.some((e) => e.addressCount > 1);
  check(
    "relayer users NOT collapsed into one phantom whale",
    !anyMerged,
    anyMerged ? "some relayer users were merged" : "",
  );

  // --- behavior classification
  const buyer = snap.entities.find((e) => e.addresses.includes(BUYER));
  check(
    "market buyer classified as bought",
    !!buyer && buyer.behavior.acquisition === "bought" && buyer.behavior.buyCount === 1,
    buyer ? `acq=${buyer.behavior.acquisition} buys=${buyer.behavior.buyCount}` : "",
  );
  check(
    "whale that never bought is classified as farmed",
    !!whale && whale.behavior.acquisition === "farmed",
    whale ? `acq=${whale.behavior.acquisition}` : "",
  );
  check(
    "internal shuffle is not counted as distribution",
    !!whale && whale.behavior.distributionRatio < 0.35,
    whale ? `dist=${whale.behavior.distributionRatio}` : "",
  );

  // --- pool is excluded from the float
  const poolRow = snap.entities.find((e) => e.id === PAIR);
  check("pool not ranked as a holder", !poolRow || poolRow.share === 0);
  check("pool balance tracked separately", snap.poolBalance > 0);

  // --- exit math
  check("depth ladder computed", snap.depthLadder.length > 0);
  const monotonic = snap.depthLadder.every(
    (d, i, arr) => i === 0 || d.priceImpact <= arr[i - 1].priceImpact,
  );
  check("bigger sells hurt more", monotonic);
  check(
    "cascade threshold computed",
    snap.cascade?.tokensToHalve != null && snap.cascade.tokensToHalve > 0,
  );

  console.log(
    failures === 0
      ? "\nAll checks passed.\n"
      : `\n${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
