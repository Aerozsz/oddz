import { getEngine } from "../engine";
import { mentionVelocity } from "../metrics/news-poller";
import { newsPressure } from "../metrics/news-store";
import type { NewsPressure } from "./types";

/**
 * Everything the outside world is saying, as one number the sizer can act on.
 *
 * Three sources, ordered by how early they can possibly be:
 *
 *  1. **The tape** — milliseconds. Every event reaches the order book before it
 *     reaches any wire, because the book is how it reaches the world.
 *  2. **Crowd chatter** — a minute or two. Not the text, only the rate: a spike
 *     in how often a ticker is named is measurable, fast, and needs no judgement
 *     about what any single post meant.
 *  3. **Headlines** — minutes to tens of minutes. Late by construction, and kept
 *     mainly so a human reading a post-mortem can see what the move was.
 *
 * Combined with `max` rather than a sum. Each is a separate view of the same
 * question — "is this still the market this strategy was calibrated on" — and
 * adding them would let three weak agreeing signals outrank one strong one.
 *
 * The output only ever makes the agent smaller. None of these carries a
 * direction: a chatter spike does not say which way, a spread blowout does not
 * say which way, and a headline that appears to is usually already in the price.
 *
 * Shared by the control server and the shadow run so the two cannot drift. Two
 * definitions of "what the news says right now" that disagreed would be worse
 * than either alone, and would quietly invalidate every comparison between a
 * shadow trade and a live one.
 */
export function livePressure(symbol: string, now = Date.now()): NewsPressure {
  const feeds = newsPressure(symbol, now);
  const shock = getEngine(symbol).readShock(now);
  const chatter = mentionVelocity(symbol);

  /*
   * Chatter is deliberately harder to trigger than the tape.
   *
   * The baseline is a slow average of a noisy count, so a quiet ticker can
   * double on two posts. Six times normal is the point where it stops being
   * plausible as noise, and even then it caps at 2 — the crowd noticing
   * something is a reason to size down, never a reason to stand fully aside.
   */
  const chatterLevel = chatter > 6 ? 2 : chatter > 3 ? 1 : 0;

  const reasons = [...shock.reasons];
  if (chatterLevel > 0) reasons.push(`${symbol} mentioned ${chatter.toFixed(1)}x its usual rate`);

  /*
   * How long ago, which is what the sizer actually decays against.
   *
   * The chatter case needs stating because getting it wrong is silent: velocity
   * is measured over a rolling five minutes, so a spike *is* now — there is no
   * "minutes since" to report, and leaving it null meant a raised impact with a
   * null age, which the sizer reads as nothing to decay and skips entirely. The
   * derate would have been computed, displayed, and never applied.
   *
   * Zero is the honest answer, and the spike expires on its own: as the posts
   * age out of the five-minute window the velocity falls, the level falls, and
   * the derate lifts without anything having to time it.
   */
  const ages = [
    feeds.minutesSince,
    shock.secondsSince !== null ? shock.secondsSince / 60 : null,
    chatterLevel > 0 ? 0 : null,
  ].filter((x): x is number => x !== null);

  return {
    ...feeds,
    impact: Math.max(feeds.impact, shock.level, chatterLevel),
    minutesSince: ages.length ? Math.min(...ages) : null,
    shockLevel: shock.level,
    shockReasons: reasons,
    chatterVelocity: chatter,
  };
}
