/**
 * Hand-rolled ABI codec for the handful of calls and events the tracker needs.
 *
 * Every selector and topic below is a fixed, well-known constant of the ERC-20
 * and Uniswap-V2 interfaces, so no keccak implementation is required at all.
 */

// ---------------------------------------------------------------- selectors
export const SELECTOR = {
  balanceOf: "0x70a08231", // balanceOf(address)
  decimals: "0x313ce567", // decimals()
  symbol: "0x95d89b41", // symbol()
  name: "0x06fdde03", // name()
  totalSupply: "0x18160ddd", // totalSupply()
  token0: "0x0dfe1681", // token0()
  token1: "0xd21220a7", // token1()
  getReserves: "0x0902f1ac", // getReserves()
} as const;

// ------------------------------------------------------------------- topics
/** Transfer(address indexed,address indexed,uint256) */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Uniswap V2 Swap(address indexed,uint,uint,uint,uint,address indexed) */
export const SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";

/** Uniswap V2 Sync(uint112,uint112) — emitted on every reserve change. */
export const SYNC_TOPIC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1";

// ------------------------------------------------------------------ encoding
/** Left-pad a 20-byte address to a 32-byte ABI word. */
export function padAddress(addr: string): string {
  return "000000000000000000000000" + addr.toLowerCase().replace(/^0x/, "");
}

export function encodeBalanceOf(addr: string): string {
  return SELECTOR.balanceOf + padAddress(addr);
}

/** A 32-byte log topic back to a lowercase address. */
export function topicToAddress(topic: string): string {
  return "0x" + topic.slice(-40).toLowerCase();
}

// ------------------------------------------------------------------ decoding
/** Split ABI return data into 32-byte words. */
export function words(data: string): string[] {
  const body = data.replace(/^0x/, "");
  const out: string[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64) out.push(body.slice(i, i + 64));
  return out;
}

export function decodeUint(data: string, index = 0): bigint {
  const w = words(data)[index];
  return w ? BigInt("0x" + w) : 0n;
}

/**
 * Decode a string return value. Handles both the ABI-correct dynamic form and
 * the bytes32 form that older tokens (notably pre-2018 ERC-20s) return for
 * symbol() and name().
 */
export function decodeString(data: string): string | null {
  const body = data.replace(/^0x/, "");
  if (body.length === 0) return null;
  if (body.length === 64) {
    // bytes32: trim trailing zero padding.
    const trimmed = body.replace(/(00)+$/, "");
    return hexToUtf8(trimmed) || null;
  }
  try {
    const w = words(data);
    const offset = Number(BigInt("0x" + w[0])) / 32;
    const len = Number(BigInt("0x" + w[offset]));
    if (!Number.isFinite(len) || len <= 0) return null;
    const chars = body.slice((offset + 1) * 64, (offset + 1) * 64 + len * 2);
    return hexToUtf8(chars) || null;
  } catch {
    return null;
  }
}

function hexToUtf8(h: string): string {
  const bytes = h.match(/.{1,2}/g) ?? [];
  const buf = Uint8Array.from(bytes.map((b) => parseInt(b, 16)));
  // Drop the C0 controls and NUL padding a bytes32 field carries. Done by
  // codepoint rather than a regex literal so no control byte ever has to
  // appear in this source file.
  return Array.from(new TextDecoder().decode(buf))
    .filter((c) => c.codePointAt(0)! >= 0x20)
    .join("")
    .trim();
}

/** getReserves() -> (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) */
export function decodeReserves(data: string): { r0: bigint; r1: bigint } | null {
  const w = words(data);
  if (w.length < 2) return null;
  return { r0: BigInt("0x" + w[0]), r1: BigInt("0x" + w[1]) };
}

/** Swap event data: four uint256 words; indexed sender/to live in the topics. */
export function decodeSwap(data: string): {
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
} | null {
  const w = words(data);
  if (w.length < 4) return null;
  return {
    amount0In: BigInt("0x" + w[0]),
    amount1In: BigInt("0x" + w[1]),
    amount0Out: BigInt("0x" + w[2]),
    amount1Out: BigInt("0x" + w[3]),
  };
}

/** Sync event data: reserve0, reserve1 as uint112 in two words. */
export function decodeSync(data: string): { r0: bigint; r1: bigint } | null {
  const w = words(data);
  if (w.length < 2) return null;
  return { r0: BigInt("0x" + w[0]), r1: BigInt("0x" + w[1]) };
}

/** Convert a base-unit bigint to a float in human units. */
export function toUnits(v: bigint, decimals: number): number {
  if (v === 0n) return 0;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs - whole * base;
  // Number(whole) is exact below 2^53; the fraction only adds the precision a
  // display path can use, so the split keeps large balances honest.
  const n = Number(whole) + Number(frac) / Number(base);
  return neg ? -n : n;
}
