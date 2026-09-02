# Whale tracker (`/whales`)

Live holder tracking for an ERC-20, read from chain state.

## Why it does not use an aggregator for holders

Neither aggregator serves the data the page is about:

- **DexScreener** has no holders endpoint at all. It is authoritative for
  price, liquidity, volume and 24h buy/sell counts, and that is what it is
  used for here.
- **GMGN**'s top-holders route covers Solana, Ethereum, Base and BSC. It does
  not cover arbitrary chains, so it cannot answer for a token on a new one.
- **Block explorers** (rh-scan, Blockscout) render holder tables client-side
  and gate their APIs behind keys, so there is nothing stable to fetch.

Holders therefore come from the chain itself: the tracker replays the token's
`Transfer` logs to reconstruct every balance, which is what an explorer does
internally. That works on any EVM chain, needs no API key, and cannot be stale
relative to the chain.

## How it works

1. **Bootstrap** — `decimals`, `symbol`, `name`, `totalSupply` on the token;
   `token0`, `token1`, `getReserves` on the pair. The token's deploy block is
   found by binary search over historical `eth_getCode`, so the backfill starts
   there rather than at genesis (~25 calls instead of millions of empty blocks).
2. **Replay** — `eth_getLogs` for the token's `Transfer` events and the pair's
   `Swap`/`Sync` events, walked in chunks. Balances, first-seen block, lifetime
   in/out and transfer counts fall out of the replay.
3. **Pricing** — each `Transfer` touching the pair is joined to the `Swap` in
   the same transaction, which yields the exact quote amount and therefore the
   execution price. This is what turns "balance went down" into "sold 30,000
   for 700 NVDA".
4. **Clustering** — see below.
5. **Valuation** — positions are priced both at spot and at what the pool would
   actually pay (x·y=k, 30bp fee).

The replay is incremental. The first pass is expensive; every refresh after it
costs one `eth_getLogs` over the blocks since the cursor, which is what makes
per-second updates affordable.

## Entity resolution

Rows are **economic actors, not addresses**. A position split across six
wallets is one seller, and ranking raw addresses would show it as six holders —
understating exactly the concentration the page exists to measure.

Addresses merge only when weighted evidence clears a threshold, so no single
weak heuristic can fuse two unrelated wallets:

| Signal | Weight | What it catches |
| --- | --- | --- |
| `shared-signer` | 1.0 | Same EOA signed for both, and it is not a relayer |
| `pass-through` | 1.0 | A → B → pool: the peel chain |
| `sole-funder` | 0.7 | Every token B holds came from A, and B never bought |
| `consolidation` | 0.6 | B swept its whole balance into A without selling |
| `amount-echo` | 0.45 | Value in, near-identical value straight back out |
| `co-timing` | 0.3 | Repeatedly active in the same blocks (reinforcement only) |

Transfers between an entity's own addresses are netted out, so shuffling your
own tokens does not register as distribution.

### Relayers

A shared signer is identity evidence only when its fan-out is low. A relayer is
precisely a signer used by many unrelated addresses, so **fan-out is what
separates the two**: above `RELAYER_FANOUT` (12) distinct addresses, a signer is
classified as infrastructure and contributes no identity evidence. Without that
rule, every user of one forwarding service would collapse into a single phantom
whale. Addresses that transacted through a relayer are still flagged `relayed`
on their row.

Each clustered row exposes the evidence it was built from. It is a claim that
addresses behave as one actor, not a claim about a person.

## Configuration

`HOLDERS_RPC_URLS` is required — comma-separated JSON-RPC endpoints, tried in
order on failure. Without it the page renders an explicit "not configured"
state rather than an empty table. Everything else is optional; see
`.env.example`. Per-request overrides: `/whales?token=0x…&pair=0x…`.

## Transport

`/api/holders/stream` is SSE: one server-side indexer fans out to every
connected tab, so ten tabs cost the same RPC traffic as one. The client falls
back to polling `/api/holders` if the stream errors or connects but stays
silent for 12s — buffering proxies and serverless response caps break streams
often enough that a tracker which shows nothing without SSE is worse than one
that quietly polls.

Both routes run server-side because neither DexScreener nor GeckoTerminal sends
permissive CORS headers; a browser cannot call them directly.

## Known limits

- **Cost basis is exact in quote terms, approximate in dollars.** Quote amounts
  come from the `Swap` events and are exact. Converting them to USD uses the
  *current* quote price, because no historical quote/USD series is available.
  Realized and unrealized PnL inherit that.
- **Exit values assume one venue.** They model a single market sale into the
  tracked pool, gross of gas, ignoring every other pool and any bridge.
- **A contract holder is not necessarily a locked one.** The tracker reports
  that an address has bytecode; whether it is a vesting vault, a farm, or a
  bridge lockbox is not inferable from balances alone.
- **Clustering is inference.** Recall is bounded by what the token's own
  transfer graph and transaction signers reveal: a holder funded from a
  centralized exchange with no on-chain link leaves no edge to find.

## Verification

`npm run holders:selftest` runs the tracker against an in-memory fake chain
with a known answer, including a position deliberately laundered through a
fresh address and a relayer, plus 20 genuine relayer users that must *not*
merge. It asserts balances, attribution, clustering, relayer exclusion,
behavior classification and the AMM math.
