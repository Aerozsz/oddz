process.env.SWEEP_NEWS = "/tmp/sweep-checks/news-vel.json";
import { rmSync } from "node:fs";
import { startNewsPoller, mentionVelocity, chatterWarm, __resetChatter } from "../lib/sweep/metrics/news-poller";
import { livePressure } from "../lib/sweep/agent/pressure";

let fails = 0;
const check = (n: string, c: boolean, d = "") => { console.log(`${c?"  ok  ":"  FAIL"} ${n}${d?"  — "+d:""}`); if (!c) fails++; };

// Drive the poller with a stubbed fetch and a controllable clock.
function stub(postsPerPoll: number, at: number) {
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("reddit.com")) {
      return new Response(JSON.stringify({ data: { children: Array.from({length: postsPerPoll}, (_,i) => (
        { data: { title: `bitcoin chatter ${at}-${i}`, permalink: `/r/z/${at}${i}`, created_utc: at/1000, score: 1 } })) } }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as any;
}

async function main() {
  rmSync("/tmp/sweep-checks/news-vel.json", { force: true });
  const real = globalThis.fetch;
  __resetChatter();

  const t0 = Date.now();
  const nowSpy = (ms: number) => t0 + ms;

  // 1. Cold start: a burst on the very first poll must NOT read as a spike.
  stub(15, t0);
  const p = startNewsPoller({});
  await p.pollNow();
  check("cold start reports normal despite a 15-post burst", mentionVelocity("BTCUSDT", nowSpy(0)) === 1,
    String(mentionVelocity("BTCUSDT", nowSpy(0))));
  check("cold start is not warm", !chatterWarm("BTCUSDT", nowSpy(0)));
  p.stop();

  // 2. Steady chatter through warmup, then read at a normal rate.
  //    3 posts per poll, one poll a minute, for 40 minutes.
  __resetChatter();
  let ms = 0;
  for (let i = 0; i < 40; i++) {
    ms += 60_000;
    stub(3, nowSpy(ms));
    const q = startNewsPoller({});
    // startNewsPoller uses Date.now internally for noteMention; simulate by
    // polling in real time is impossible, so drive noteMention through the
    // poller and then read with an offset clock.
    await q.pollNow();
    q.stop();
  }
  // Everything above happened inside a few real seconds, so "now" for the read
  // is genuinely ~0ms later. Warmup must therefore still refuse.
  check("40 fast polls inside one real minute are still not warm", !chatterWarm("BTCUSDT"),
    "velocity " + mentionVelocity("BTCUSDT"));
  check("and still report normal", mentionVelocity("BTCUSDT") === 1, String(mentionVelocity("BTCUSDT")));

  // 3. Read far in the future: window empties, count falls to zero, velocity
  //    must not stay pinned at its old spike.
  const far = nowSpy(3 * 3_600_000);
  check("a stale spike does not persist", mentionVelocity("BTCUSDT", far) <= 1,
    String(mentionVelocity("BTCUSDT", far)));

  // 4. livePressure must not invent a derate from an unwarm baseline.
  const lp = livePressure("BTCUSDT");
  check("livePressure chatterVelocity is 1 when cold", lp.chatterVelocity === 1, String(lp.chatterVelocity));
  check("livePressure impact stays 0 when cold", lp.impact === 0, String(lp.impact));
  check("livePressure minutesSince stays null when cold", lp.minutesSince === null, String(lp.minutesSince));

  globalThis.fetch = real;
  console.log(fails ? `\n${fails} FAILED` : "\nall velocity checks passed");
  process.exit(fails ? 1 : 0);
}
main();
