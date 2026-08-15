import { mentionVelocity, chatterWarm, __resetChatter, __noteMention } from "../lib/sweep/metrics/news-poller";

let fails = 0;
const check = (n: string, c: boolean, d = "") => { console.log(`${c?"  ok  ":"  FAIL"} ${n}${d?"  — "+d:""}`); if (!c) fails++; };

const T0 = 1_700_000_000_000;
const MIN = 60_000;

// A ticker mentioned at a steady 4 posts per minute for two hours.
function warmUp(rate = 4, minutes = 120) {
  __resetChatter();
  for (let m = 0; m < minutes; m++)
    for (let i = 0; i < rate; i++) __noteMention("BTCUSDT", T0 + m*MIN + i*(MIN/rate));
  return T0 + minutes*MIN;
}

let t = warmUp();
check("warm after two hours of steady chatter", chatterWarm("BTCUSDT", t));
const steady = mentionVelocity("BTCUSDT", t);
check("steady chatter reads near 1x", steady > 0.7 && steady < 1.4, steady.toFixed(2));

// Now a genuine spike: 10x the rate for two minutes.
for (let i = 0; i < 80; i++) __noteMention("BTCUSDT", t + i*(2*MIN/80));
const spikeT = t + 2*MIN;
const spike = mentionVelocity("BTCUSDT", spikeT);
check("a 10x burst reads as a spike", spike > 3, spike.toFixed(2));

// It must clear on its own once the burst ages out of the window.
const afterT = spikeT + 8*MIN;
const after = mentionVelocity("BTCUSDT", afterT);
check("spike clears once the window rolls past it", after < 3, after.toFixed(2));

// A sustained elevated rate must re-baseline rather than derate forever.
let u = spikeT;
for (let m = 0; m < 90; m++) for (let i = 0; i < 40; i++) __noteMention("BTCUSDT", u + m*MIN + i*(MIN/40));
const sustainedT = u + 90*MIN;
const sustained = mentionVelocity("BTCUSDT", sustainedT);
check("a sustained new normal re-baselines", sustained < 3, sustained.toFixed(2));

// Silence must not read as a spike.
const silentT = sustainedT + 3*3_600_000;
check("silence reads below normal, never above", mentionVelocity("BTCUSDT", silentT) <= 1,
  mentionVelocity("BTCUSDT", silentT).toFixed(2));

// A ticker never mentioned is always 1.
check("unknown ticker is 1", mentionVelocity("ZZZUSDT", silentT) === 1);

console.log(fails ? `\n${fails} FAILED` : "\nall warm-path checks passed");
process.exit(fails ? 1 : 0);
