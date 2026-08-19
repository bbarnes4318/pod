// What the process has learned about each provider's REFILLING rate window.
//
// WHY THIS EXISTS. A per-minute budget belongs to the ACCOUNT, not to the
// request that happened to discover it — the same fact `insufficient_credit`
// already gets its own fallback verdict for. But until now every caller
// rediscovered it independently:
//
//   script:outline        cerebras  ok    3,262 tokens
//   script:private-agendas cerebras ok    1,054 tokens
//   script:story-spine    cerebras  ok
//   script:turn-plan      cerebras  429   "Tokens per minute limit exceeded"
//   script:turn-plan      groq      -> schema violation on the largest schema
//   script:turn-plan      anthropic -> unfunded, episode dead
//
// The 429 is the account saying "not for the next N seconds". Every request
// this process sends to that provider inside those N seconds is refused too, so
// firing them is not a fallback attempt — it is a guaranteed failure that spends
// a rung of the chain. On the free tier the chain is two rungs deep, so ONE
// exhausted window destroys the episode.
//
// A window is remembered here so the next caller WAITS instead of rediscovering
// it, and so the routing layer can tell "this chain is out of options" apart
// from "this chain is out of options for another forty seconds".
//
// Process-local by design. It is a cache of an observation, not a distributed
// lock: two workers each learn their own copy, and the worst case is that each
// one wastes a single request finding out. A shared store would add an
// infrastructure dependency to a fact that costs one HTTP round trip to
// re-learn.

/**
 * How long a window is assumed to last when the provider publishes no
 * `retry-after`.
 *
 * 60s because every refusal we have actually recorded names a per-MINUTE
 * budget (Cerebras: "Tokens per minute limit exceeded"), and a per-second
 * window is subsumed by waiting a minute. Assuming less would put us back to
 * firing requests into a budget that has not refilled.
 */
export const DEFAULT_RATE_WINDOW_MS = 60_000;

/**
 * Ceiling on a remembered window, including one a provider asked for.
 *
 * Matches the cap the transport already applies to `retry-after` in
 * openaiCompatible's backoff. A provider that asks for ten minutes is asking
 * for something a user watching a progress bar will read as a hang; we wait a
 * minute, try, and let the next refusal re-arm the window if it was serious.
 */
export const MAX_RATE_WINDOW_MS = 60_000;

/** provider name (the ACCOUNT, not the model) → epoch ms when it may be tried. */
const readyAt = new Map<string, number>();

/** Parse a `retry-after` header. Seconds only — the HTTP-date form is not used
 *  by any provider in this chain, and guessing at one would be worse than the
 *  measured default. */
function retryAfterMs(header: string | null | undefined): number | null {
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, MAX_RATE_WINDOW_MS);
}

/**
 * Record that `provider` refused with a limit that refills on its own.
 *
 * Returns the window length actually stored, so the caller can log the number it
 * will be held to rather than the number it asked for.
 */
export function noteRateWindow(
  provider: string,
  retryAfterHeader?: string | null,
  now: number = Date.now()
): number {
  const windowMs = retryAfterMs(retryAfterHeader) ?? DEFAULT_RATE_WINDOW_MS;
  const until = now + windowMs;
  // Never SHORTEN a window that is already further out. Two roles failing four
  // seconds apart must not let the second one's fresh 60s clock replace a
  // longer wait the provider explicitly asked for.
  const existing = readyAt.get(provider) ?? 0;
  readyAt.set(provider, Math.max(existing, until));
  return Math.max(existing, until) - now;
}

/**
 * Milliseconds until `provider` is worth calling again. 0 when it is now.
 *
 * Callers should treat a positive number as "this request will be refused",
 * because that is what the account just said.
 */
export function rateWindowRemainingMs(provider: string, now: number = Date.now()): number {
  const until = readyAt.get(provider);
  if (until === undefined) return 0;
  if (until <= now) {
    readyAt.delete(provider);
    return 0;
  }
  return until - now;
}

/**
 * A successful call is proof the budget refilled — the strongest evidence
 * available, and better than waiting for the clock we guessed at to run out.
 */
export function clearRateWindow(provider: string): void {
  readyAt.delete(provider);
}

/**
 * The longest wait among a set of providers, e.g. every provider on one role's
 * candidate chain. 0 when none of them is cooling down.
 */
export function longestRateWindowMs(providers: Iterable<string>, now: number = Date.now()): number {
  let longest = 0;
  for (const p of providers) longest = Math.max(longest, rateWindowRemainingMs(p, now));
  return longest;
}

/** Test seam. Never called by the pipeline. */
export function resetRateWindows(): void {
  readyAt.clear();
}
