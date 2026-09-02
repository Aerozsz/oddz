import type { Account, TransferEdge } from "./ledger";
import type { Behavior, ClusterEvidence, Entity, EntityKind } from "./types";

/**
 * Entity resolution over the token's own transfer graph.
 *
 * The problem this solves: a holder who wants to hide splits a position across
 * fresh addresses, hops it through intermediaries, or routes transactions
 * through a relayer so the on-chain signer is not theirs. Ranking raw
 * addresses then shows six 8% holders instead of one 48% holder, which is the
 * single easiest way to misread a holder table.
 *
 * Nothing here is a claim about a human. It is a claim that a set of addresses
 * behaves as one economic actor, with the evidence attached so the claim can
 * be checked rather than trusted.
 *
 * Every signal is weighted and accumulated; addresses merge only once their
 * combined evidence clears MERGE_THRESHOLD, so no single weak heuristic can
 * fuse two unrelated wallets on its own.
 */

/** A signer serving more than this many distinct addresses is infrastructure. */
export const RELAYER_FANOUT = 12;

/** Evidence needed before two addresses are treated as one entity. */
export const MERGE_THRESHOLD = 1.0;

/** Blocks within which a forward still counts as the same movement. */
const HOP_WINDOW = 900;

/** Fraction of inflow that must come from one source to call it a hop. */
const PASS_THROUGH_IN = 0.95;
/** Fraction of that inflow that must leave again. */
const PASS_THROUGH_OUT = 0.9;

const WEIGHT = {
  sharedSigner: 1.0, // same EOA signed for both, and it is not a relayer
  passThrough: 1.0, // B is a conduit for A's tokens
  soleFunder: 0.7, // every token B holds came from A
  amountEcho: 0.45, // value in, near-identical value straight out
  consolidation: 0.6, // B swept its whole balance into A
  coTiming: 0.3, // repeatedly active in the same blocks
} as const;

export interface ClusterInput {
  accounts: Map<string, Account>;
  edges: Map<string, TransferEdge>;
  /** txHash -> signer (tx.from), resolved by the tracker. */
  signers: Map<string, string>;
  /** txHash -> addresses that appeared in that transaction's transfers. */
  txParticipants: Map<string, Set<string>>;
  /** Excluded from clustering: pool, burns, known routers. */
  excluded: Set<string>;
}

export interface ClusterResult {
  /** address -> entity id (the entity's primary address). */
  assignment: Map<string, string>;
  evidence: ClusterEvidence[];
  /** Signers judged to be shared infrastructure rather than an identity. */
  relayers: { address: string; fanOut: number; txCount: number }[];
}

// ------------------------------------------------------------- union-find
class DisjointSet {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  find(x: string): string {
    const p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
      return x;
    }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root); // path compression
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const ka = this.rank.get(ra) ?? 0;
    const kb = this.rank.get(rb) ?? 0;
    if (ka < kb) this.parent.set(ra, rb);
    else if (ka > kb) this.parent.set(rb, ra);
    else {
      this.parent.set(rb, ra);
      this.rank.set(ra, ka + 1);
    }
  }
}

/** Undirected pair key, so A-B and B-A accumulate into one score. */
function pairKey(a: string, b: string): string {
  return a < b ? a + "|" + b : b + "|" + a;
}

export function cluster(input: ClusterInput): ClusterResult {
  const { accounts, edges, signers, txParticipants, excluded } = input;

  const scores = new Map<string, number>();
  const evidence: ClusterEvidence[] = [];

  const add = (
    a: string,
    b: string,
    weight: number,
    kind: ClusterEvidence["kind"],
    detail: string,
  ) => {
    if (a === b || excluded.has(a) || excluded.has(b)) return;
    const key = pairKey(a, b);
    scores.set(key, (scores.get(key) ?? 0) + weight);
    evidence.push({ kind, a, b, weight, detail });
  };

  // ---------------------------------------------------- signal: shared signer
  // A relayer is precisely a signer that serves many unrelated addresses, so
  // fan-out is what separates "these two are the same person" from "these two
  // both used the same forwarding service". Counting a relayer as identity
  // evidence would merge every one of its users into a single phantom whale.
  const signerToAddresses = new Map<string, Set<string>>();
  const signerTxCount = new Map<string, number>();
  for (const [txHash, signer] of signers) {
    const participants = txParticipants.get(txHash);
    if (!participants) continue;
    signerTxCount.set(signer, (signerTxCount.get(signer) ?? 0) + 1);
    let set = signerToAddresses.get(signer);
    if (!set) {
      set = new Set();
      signerToAddresses.set(signer, set);
    }
    for (const p of participants) if (!excluded.has(p)) set.add(p);
  }

  const relayers: ClusterResult["relayers"] = [];
  for (const [signer, addrs] of signerToAddresses) {
    if (addrs.size > RELAYER_FANOUT) {
      relayers.push({
        address: signer,
        fanOut: addrs.size,
        txCount: signerTxCount.get(signer) ?? 0,
      });
      continue; // infrastructure: contributes no identity evidence
    }
    // A signer with a handful of counterparties is a person operating a
    // handful of addresses. The signer itself joins the cluster when it also
    // holds a balance, which catches the "sign from the main wallet, hold in
    // the burners" pattern.
    const members = [...addrs];
    if (accounts.has(signer) && !excluded.has(signer)) members.push(signer);
    const unique = [...new Set(members)];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        add(
          unique[i],
          unique[j],
          WEIGHT.sharedSigner,
          "shared-signer",
          `both signed by ${short(signer)} (${addrs.size} addresses)`,
        );
      }
    }
  }
  relayers.sort((a, b) => b.fanOut - a.fanOut);

  // ------------------------------------- signals: funding, hops, consolidation
  // Index edges by endpoint once; the per-address scans below are otherwise
  // quadratic in the number of edges.
  const inbound = new Map<string, TransferEdge[]>();
  const outbound = new Map<string, TransferEdge[]>();
  for (const e of edges.values()) {
    if (excluded.has(e.from) || excluded.has(e.to)) continue;
    (inbound.get(e.to) ?? setDefault(inbound, e.to)).push(e);
    (outbound.get(e.from) ?? setDefault(outbound, e.from)).push(e);
  }

  for (const [address, acc] of accounts) {
    if (excluded.has(address)) continue;
    const ins = inbound.get(address) ?? [];
    if (ins.length === 0) continue;

    const totalIn = ins.reduce((s, e) => s + e.value, 0n);
    if (totalIn === 0n) continue;

    // Sole funder: essentially everything this address ever held came from one
    // place, and it never bought any of it on the market.
    const dominant = ins.reduce((best, e) => (e.value > best.value ? e : best), ins[0]);
    const dominantShare = ratio(dominant.value, totalIn);
    if (dominantShare >= PASS_THROUGH_IN && acc.boughtTokens === 0n) {
      add(
        dominant.from,
        address,
        WEIGHT.soleFunder,
        "sole-funder",
        `${pct(dominantShare)} of inflow from ${short(dominant.from)}, never bought`,
      );

      // Pass-through: the funded address forwarded that balance straight on.
      // This is the peel chain — A to B to the pool, so the sale looks like
      // B's when the position was always A's.
      const outs = outbound.get(address) ?? [];
      const totalOut = outs.reduce((s, e) => s + e.value, 0n) + acc.soldTokens;
      if (totalOut > 0n && ratio(totalOut, totalIn) >= PASS_THROUGH_OUT) {
        const promptly =
          acc.lastActiveBlock - dominant.firstBlock <= HOP_WINDOW ||
          outs.some((e) => e.firstBlock - dominant.lastBlock <= HOP_WINDOW);
        if (promptly) {
          add(
            dominant.from,
            address,
            WEIGHT.passThrough,
            "pass-through",
            `conduit: in from ${short(dominant.from)}, ${pct(ratio(totalOut, totalIn))} forwarded on`,
          );
          // Follow the trail one more link, so a two-hop laundering path
          // collapses to the origin rather than to the middle address.
          for (const e of outs) {
            add(
              dominant.from,
              e.to,
              WEIGHT.passThrough * 0.6,
              "pass-through",
              `two-hop: ${short(dominant.from)} to ${short(address)} to ${short(e.to)}`,
            );
          }
        }
      }

      // Amount echo: value arrives and a near-identical value leaves. Fees and
      // dust make an exact match rare, so a 2% band is the working tolerance.
      for (const e of outs) {
        if (within(e.value, dominant.value, 0.02) && e.firstBlock >= dominant.firstBlock) {
          add(
            dominant.from,
            e.to,
            WEIGHT.amountEcho,
            "amount-echo",
            `${fmt(e.value)} forwarded on within ${e.firstBlock - dominant.firstBlock} blocks`,
          );
        }
      }
    }

    // Consolidation: this address swept its entire position into one other.
    const outs = outbound.get(address) ?? [];
    if (acc.balance === 0n && outs.length > 0) {
      const sink = outs.reduce((best, e) => (e.value > best.value ? e : best), outs[0]);
      const outTotal = outs.reduce((s, e) => s + e.value, 0n);
      if (ratio(sink.value, outTotal) >= 0.95 && acc.sellCount === 0) {
        add(
          address,
          sink.to,
          WEIGHT.consolidation,
          "consolidation",
          `swept its whole balance to ${short(sink.to)} without selling`,
        );
      }
    }
  }

  // --------------------------------------------------- signal: co-timing
  // Addresses that keep acting in the same block are either one actor running
  // a script or two actors reacting to the same trigger. Weak on its own by
  // design: it only matters when it stacks on a structural signal.
  const blockActors = new Map<number, Set<string>>();
  for (const [, acc] of accounts) void acc;
  for (const e of edges.values()) {
    if (excluded.has(e.from) || excluded.has(e.to)) continue;
    for (const b of [e.firstBlock, e.lastBlock]) {
      const set = blockActors.get(b) ?? setDefaultNum(blockActors, b);
      set.add(e.from);
      set.add(e.to);
    }
  }
  const coTiming = new Map<string, number>();
  for (const actors of blockActors.values()) {
    if (actors.size < 2 || actors.size > 8) continue; // a busy block proves nothing
    const list = [...actors];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const k = pairKey(list[i], list[j]);
        coTiming.set(k, (coTiming.get(k) ?? 0) + 1);
      }
    }
  }
  for (const [key, count] of coTiming) {
    if (count < 3) continue; // one coincidence is not a pattern
    const [a, b] = key.split("|");
    // Only reinforces a pair that already has structural evidence.
    if (!scores.has(key)) continue;
    add(a, b, WEIGHT.coTiming, "co-timing", `co-active in ${count} blocks`);
  }

  // ------------------------------------------------------------- merge
  const ds = new DisjointSet();
  for (const [key, score] of scores) {
    if (score < MERGE_THRESHOLD) continue;
    const [a, b] = key.split("|");
    ds.union(a, b);
  }

  // Name each entity after its largest-balance member, which is the address a
  // reader is most likely to already recognise.
  const groups = new Map<string, string[]>();
  for (const address of accounts.keys()) {
    if (excluded.has(address)) continue;
    const root = ds.find(address);
    (groups.get(root) ?? setDefault(groups, root)).push(address);
  }
  const assignment = new Map<string, string>();
  for (const members of groups.values()) {
    const primary = members.reduce((best, m) => {
      const bb = accounts.get(best)?.balance ?? 0n;
      const mb = accounts.get(m)?.balance ?? 0n;
      return mb > bb ? m : best;
    }, members[0]);
    for (const m of members) assignment.set(m, primary);
  }

  // Keep only the evidence that supports a merge that actually happened.
  const kept = evidence.filter((e) => {
    const s = scores.get(pairKey(e.a, e.b)) ?? 0;
    return s >= MERGE_THRESHOLD;
  });

  return { assignment, evidence: kept, relayers };
}

// -------------------------------------------------------------- aggregation
/**
 * Fold clustered addresses into entities.
 *
 * Transfers between members of the same entity are netted out: moving your own
 * tokens between your own addresses is not distribution, and leaving it in
 * would make every hop look like a sale.
 */
export function buildEntities(
  assignment: Map<string, string>,
  accounts: Map<string, Account>,
  edges: Map<string, TransferEdge>,
  evidence: ClusterEvidence[],
): Map<string, Entity> {
  const members = new Map<string, string[]>();
  for (const [addr, root] of assignment) {
    (members.get(root) ?? setDefault(members, root)).push(addr);
  }

  // Internal flow per entity, to be subtracted from the off-market counters.
  const internalIn = new Map<string, bigint>();
  const internalOut = new Map<string, bigint>();
  for (const e of edges.values()) {
    const ra = assignment.get(e.from);
    const rb = assignment.get(e.to);
    if (ra && rb && ra === rb) {
      internalIn.set(ra, (internalIn.get(ra) ?? 0n) + e.value);
      internalOut.set(ra, (internalOut.get(ra) ?? 0n) + e.value);
    }
  }

  const evidenceByRoot = new Map<string, ClusterEvidence[]>();
  for (const ev of evidence) {
    const root = assignment.get(ev.a) ?? assignment.get(ev.b);
    if (!root) continue;
    (evidenceByRoot.get(root) ?? setDefault(evidenceByRoot, root)).push(ev);
  }

  const out = new Map<string, Entity>();
  for (const [root, addrs] of members) {
    let balance = 0n;
    let firstSeenBlock = Number.MAX_SAFE_INTEGER;
    let lastActiveBlock = 0;
    let transferCount = 0;
    const b: Behavior = {
      boughtTokens: 0n,
      soldTokens: 0n,
      spentQuote: 0n,
      receivedQuote: 0n,
      buyCount: 0,
      sellCount: 0,
      receivedOffMarket: 0n,
      sentOffMarket: 0n,
      firstTradeBlock: null,
      lastTradeBlock: null,
      distributionRatio: 0,
      acquisition: "none",
    };
    for (const a of addrs) {
      const acc = accounts.get(a);
      if (!acc) continue;
      balance += acc.balance;
      firstSeenBlock = Math.min(firstSeenBlock, acc.firstSeenBlock);
      lastActiveBlock = Math.max(lastActiveBlock, acc.lastActiveBlock);
      transferCount += acc.transferCount;
      b.boughtTokens += acc.boughtTokens;
      b.soldTokens += acc.soldTokens;
      b.spentQuote += acc.spentQuote;
      b.receivedQuote += acc.receivedQuote;
      b.buyCount += acc.buyCount;
      b.sellCount += acc.sellCount;
      b.receivedOffMarket += acc.receivedOffMarket;
      b.sentOffMarket += acc.sentOffMarket;
      if (acc.firstTradeBlock !== null) {
        b.firstTradeBlock =
          b.firstTradeBlock === null
            ? acc.firstTradeBlock
            : Math.min(b.firstTradeBlock, acc.firstTradeBlock);
      }
      if (acc.lastTradeBlock !== null) {
        b.lastTradeBlock =
          b.lastTradeBlock === null
            ? acc.lastTradeBlock
            : Math.max(b.lastTradeBlock, acc.lastTradeBlock);
      }
    }

    // Net out shuffling between the entity's own addresses.
    const ii = internalIn.get(root) ?? 0n;
    const io = internalOut.get(root) ?? 0n;
    b.receivedOffMarket = max0(b.receivedOffMarket - ii);
    b.sentOffMarket = max0(b.sentOffMarket - io);

    const acquired = b.boughtTokens + b.receivedOffMarket;
    const distributed = b.soldTokens + b.sentOffMarket;
    b.distributionRatio = acquired > 0n ? ratio(distributed, acquired) : 0;
    b.acquisition =
      acquired === 0n
        ? "none"
        : b.boughtTokens === 0n
          ? "farmed"
          : b.receivedOffMarket === 0n
            ? "bought"
            : "mixed";

    const ev = evidenceByRoot.get(root) ?? [];
    out.set(root, {
      id: root,
      addresses: addrs.sort((x, y) => {
        const bx = accounts.get(x)?.balance ?? 0n;
        const by = accounts.get(y)?.balance ?? 0n;
        return by > bx ? 1 : by < bx ? -1 : 0;
      }),
      balance,
      firstSeenBlock: firstSeenBlock === Number.MAX_SAFE_INTEGER ? 0 : firstSeenBlock,
      lastActiveBlock,
      transferCount,
      behavior: b,
      evidence: ev,
      // Confidence saturates rather than growing without bound: five
      // independent signals and fifty say much the same thing.
      confidence: addrs.length === 1 ? 1 : Math.min(1, sum(ev.map((e) => e.weight)) / 3),
      kind: "wallet" as EntityKind,
    });
  }
  return out;
}

// ------------------------------------------------------------------ helpers
function setDefault<T>(m: Map<string, T[]>, k: string): T[] {
  const v: T[] = [];
  m.set(k, v);
  return v;
}
function setDefaultNum(m: Map<number, Set<string>>, k: number): Set<string> {
  const v = new Set<string>();
  m.set(k, v);
  return v;
}
function ratio(a: bigint, b: bigint): number {
  if (b === 0n) return 0;
  return Number((a * 10_000n) / b) / 10_000;
}
function within(a: bigint, b: bigint, tol: number): boolean {
  if (b === 0n) return false;
  const diff = a > b ? a - b : b - a;
  return ratio(diff, b) <= tol;
}
function max0(v: bigint): bigint {
  return v < 0n ? 0n : v;
}
function sum(ns: number[]): number {
  return ns.reduce((s, n) => s + n, 0);
}
function short(a: string): string {
  return a.slice(0, 6) + "…" + a.slice(-4);
}
function pct(n: number): string {
  return (n * 100).toFixed(0) + "%";
}
function fmt(v: bigint): string {
  return v.toString();
}
