/**
 * How the system answers a venue that says no.
 *
 * The reflex fix for a refused order is "send less", and for most rejection
 * codes it is wrong in a way that is quiet and lasting: shrinking the order
 * does not sync a clock, sign an agreement or fix a key, and the shrink
 * persists long after the real cause is gone. So the tests here are mostly
 * about which lever gets pulled, not whether one gets pulled at all.
 *
 * Two properties matter more than the rest:
 *
 *  1. Nothing retries unchanged. A rejected order re-sent identically is a
 *     loop, and against a rate limiter it is an escalating one that ends in a
 *     ban — the failure mode where the automated response is worse than doing
 *     nothing.
 *  2. Only sizing faults are answered by sizing. Everything else either fixes
 *     the specific defect or stops.
 */
import {
  ConstraintMemory, classifyConstraint,
  type ConstraintKind, type Fault, type Immediate,
} from "@/lib/sweep/exchange/constraints";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

/** A rejection shaped the way the exchange client actually throws them. */
const binance = (code: number, msg = "rejected") =>
  new Error(`400 {"code":${code},"msg":"${msg}"}`);

console.log("\n## the error that started this");
{
  const c = classifyConstraint(binance(-2019, "Margin is insufficient."));
  ok("-2019 is read as a sizing fault", c.fault === "sizing" && c.kind === "margin-short");
  ok("...answered by a smaller retry", c.immediate === "retry-smaller", c.immediate);
  ok("...that is a decisive step, not a nibble", (c.retryScale ?? 1) <= 0.7, String(c.retryScale));
  ok("...bounded in attempts", c.maxAttempts <= 2, String(c.maxAttempts));
  ok("...and repeats justify a persistent change", c.adaptAfter !== null && c.adaptAfter >= 2, String(c.adaptAfter));
  ok("...with the cause named, not just the symptom",
    c.explain.includes("commission") || c.explain.includes("bracket"), c.explain.slice(0, 60));
}

console.log("\n## only sizing faults are answered by sizing");
{
  const sizingCodes = [-2019, -2018, -2010, -2027];
  for (const code of sizingCodes) {
    const c = classifyConstraint(binance(code));
    ok(`${code} shrinks the order`, c.immediate === "retry-smaller", c.immediate);
  }

  // The ones where sending less would change nothing at all.
  const notSizing: [number, string][] = [
    [-1021, "clock drift"], [-2015, "bad key"], [-2014, "bad key format"],
    [-4411, "unsigned agreement"], [-4120, "wrong endpoint"], [-2022, "reduce-only"],
    [-5022, "post-only"], [-4131, "price band"], [-4164, "below minimum"], [-1013, "filter"],
  ];
  for (const [code, why] of notSizing) {
    const c = classifyConstraint(binance(code));
    ok(`${code} (${why}) does NOT shrink the order`, c.immediate !== "retry-smaller", c.immediate);
  }
}

console.log("\n## nothing that cannot succeed is retried");
{
  const terminal: [number, Immediate][] = [
    [-1021, "halt-all"], [-2015, "halt-all"], [-2014, "halt-all"], [-4411, "halt-symbol"],
  ];
  for (const [code, expected] of terminal) {
    const c = classifyConstraint(binance(code));
    ok(`${code} halts rather than retries`, c.immediate === expected, c.immediate);
    ok(`...and tells the operator what to do`, !!c.operatorAction, c.operatorAction?.slice(0, 50) ?? "MISSING");
  }

  const ban = classifyConstraint(new Error("418 I'm a teapot"));
  ok("a 418 ban halts everything", ban.immediate === "halt-all" && ban.kind === "banned", ban.immediate);
  ok("...and says the ban escalates", ban.explain.includes("escalate"), ban.explain.slice(0, 60));

  const unknown = classifyConstraint(binance(-99999));
  ok("an unclassified code is abandoned, not retried blindly", unknown.immediate === "abandon", unknown.immediate);
  ok("...and never adapts a cap", unknown.adaptAfter === null);
  ok("...but still reports the code", unknown.explain.includes("-99999"), unknown.explain);
}

console.log("\n## a rate limit is backed off, never pushed against");
{
  for (const e of [binance(-1003), binance(-1015), new Error("429 Too Many Requests")]) {
    const c = classifyConstraint(e);
    ok(`${c.code} waits`, c.immediate === "retry-later", c.immediate);
    ok("...and repeats slow the trade rate", c.adaptAfter !== null, String(c.adaptAfter));
  }
}

console.log("\n## the venue's own faults are the one thing re-sent unchanged");
{
  const server = classifyConstraint(new Error("502 Bad Gateway"));
  ok("a 5xx is retried as-is", server.immediate === "retry-later", server.immediate);
  ok("...and never moves a cap — it is not our fault", server.adaptAfter === null);

  const net = classifyConstraint(new Error("fetch failed"));
  ok("a request that never arrived is retried", net.immediate === "retry-later", net.immediate);
  ok("...and explicitly says nothing was submitted",
    net.explain.includes("never reached"), net.explain);
}

console.log("\n## an order below the venue minimum is skipped, never inflated");
{
  const c = classifyConstraint(binance(-4164, "Order's notional must be no smaller than 5"));
  ok("it abandons rather than sizing up", c.immediate === "abandon", c.immediate);
  ok("...because inflating would let the venue set the position size",
    c.explain.includes("risk budget"), c.explain.slice(0, 80));
  ok("...and it tells the operator the real choice", !!c.operatorAction);
}

console.log("\n## a post-only rejection does not silently become a taker");
{
  const c = classifyConstraint(binance(-5022));
  ok("it does not cross the spread automatically", c.immediate !== "retry-taker", c.immediate);
  ok("...and frames the miss as the order type working",
    c.explain.includes("working"), c.explain.slice(0, 60));
}

console.log("\n## a Binance code beats the HTTP status");
{
  // Both present. Reading the 400 would classify a margin problem as unknown.
  const c = classifyConstraint(new Error(`400 {"code":-2019,"msg":"Margin is insufficient."}`));
  ok("the specific code wins over the generic status", c.kind === "margin-short", c.kind);

  const bare = classifyConstraint(new Error("400 Bad Request"));
  ok("a bare 400 is not treated as a margin problem", bare.kind !== "margin-short", bare.kind);
  ok("...and is abandoned rather than resized", bare.immediate === "abandon", bare.immediate);
}

console.log("\n## every entry in the table is internally consistent");
{
  const codes = [-2019, -2018, -2010, -2027, -4028, -4164, -1013, -1111, -4003, -4005,
                 -4131, -2021, -2022, -4045, -4120, -5022, -1003, -1015, -1021, -2014, -2015, -4411];
  let bad: string[] = [];
  for (const code of codes) {
    const c = classifyConstraint(binance(code));
    // A retry-smaller without a scale would retry at the same size.
    if (c.immediate === "retry-smaller" && !(c.retryScale && c.retryScale < 1)) bad.push(`${code}: no retryScale`);
    // A retry with one attempt allowed can never actually retry.
    if (c.immediate.startsWith("retry") && c.maxAttempts < 2) bad.push(`${code}: retry with maxAttempts ${c.maxAttempts}`);
    // A halt that retries is a contradiction.
    if (c.immediate.startsWith("halt") && c.maxAttempts > 1) bad.push(`${code}: halt with retries`);
    // Anything that stops the account must say what to do about it.
    if (c.immediate.startsWith("halt") && !c.operatorAction) bad.push(`${code}: halt with no operator action`);
    // An empty explanation is worse than none — it looks like a real answer.
    if (c.explain.length < 40) bad.push(`${code}: thin explanation`);
  }
  ok(`all ${codes.length} classified codes are self-consistent`, bad.length === 0, bad.join("; "));

  // Faults are answered by the right kind of action, across the whole table.
  const answers: Record<Fault, Immediate[]> = {
    sizing: ["retry-smaller", "abandon"],
    config: ["abandon", "retry-rounded", "retry-smaller"],
    account: ["halt-all", "halt-symbol", "abandon"],
    venue: ["retry-later", "abandon", "halt-all"],
    clock: ["halt-all"],
  };
  const mismatched = codes
    .map((c) => classifyConstraint(binance(c)))
    .filter((c) => !answers[c.fault].includes(c.immediate))
    .map((c) => `${c.code} ${c.fault}→${c.immediate}`);
  ok("each fault is answered by an action appropriate to it", mismatched.length === 0, mismatched.join("; "));
}

console.log("\n## the memory is windowed, so old problems expire");
{
  const m = new ConstraintMemory(3_600_000);
  const now = Date.now();
  const ev = (at: number, kind: ConstraintKind = "margin-short", symbol = "BTCUSDT") =>
    ({ at, symbol, kind, code: -2019, detail: "Margin is insufficient." });

  for (let i = 0; i < 5; i++) m.record(ev(now - i * 60_000));
  ok("five rejections in an hour are five", m.count("margin-short", undefined, now) === 5);

  const old = new ConstraintMemory(3_600_000);
  for (let i = 0; i < 5; i++) old.record(ev(now - (2 + i) * 3_600_000));
  ok("the same five spread over hours have expired", old.count("margin-short", undefined, now) === 0,
    String(old.count("margin-short", undefined, now)));

  const mixed = new ConstraintMemory();
  mixed.record(ev(now, "margin-short", "BTCUSDT"));
  mixed.record(ev(now, "margin-short", "INTCUSDT"));
  mixed.record(ev(now, "rate-limited", "BTCUSDT"));
  ok("counts can be scoped to one contract", mixed.count("margin-short", "BTCUSDT", now) === 1);
  ok("...or taken across all of them", mixed.count("margin-short", undefined, now) === 2);
  ok("different kinds do not pool", mixed.count("rate-limited", undefined, now) === 1);

  ok("the summary ranks by frequency", mixed.summary(now)[0].kind === "margin-short", mixed.summary(now)[0].kind);
  mixed.clear("margin-short");
  ok("clearing one kind leaves the others", mixed.count("margin-short", undefined, now) === 0 && mixed.count("rate-limited", undefined, now) === 1);

  // A pathological loop must not exhaust memory faster than the window drains.
  const flood = new ConstraintMemory();
  for (let i = 0; i < 5_000; i++) flood.record(ev(now));
  ok("a rejection loop cannot grow memory without bound", flood.all(now).length <= 500,
    String(flood.all(now).length));
}

console.log("\n## margin headroom is the right answer to a margin rejection");
{
  /*
   * The policy assertion, mirroring constraintChange in the control server.
   * Cutting risk per trade to fix -2019 would shrink the edge to solve an
   * arithmetic problem, and would have to keep cutting: the boundary being hit
   * is a fraction of the balance, so a smaller position at the same fraction
   * hits it again.
   */
  const balance = 5_000;
  const maxLev = 20;
  for (const headroom of [0, 5, 10]) {
    const committable = balance * (1 - headroom / 100);
    const notional = committable * maxLev;
    const margin = notional / maxLev;
    const feeOnOpen = notional * 0.0005;
    const fundable = margin + feeOnOpen <= balance;
    ok(`at ${headroom}% headroom the maximum position ${fundable ? "fits" : "does NOT fit"}`,
      headroom === 0 ? !fundable : fundable,
      `margin ${margin.toFixed(0)} + fee ${feeOnOpen.toFixed(2)} vs balance ${balance}`);
  }
}

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
