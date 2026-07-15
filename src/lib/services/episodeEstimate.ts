// Rundown estimates for the Studio builder — duration, script length, TTS cost.
//
// HONESTY POLICY: these are ESTIMATES, and every one says so. Duration + script
// length are grounded in the pipeline's REAL defaults (scriptService: 2200-word
// budget for a 12-minute target ⇒ ~183 words/min). TTS COST has NO real pricing
// in this repo (no provider carries per-character rates — verified), so we NEVER
// fabricate a dollar figure: we surface the DRIVER (estimated characters) and
// only compute a cost if an explicit rate is configured via TTS_COST_PER_1K_CHARS.

/** Real ratio implied by scriptService defaults (2200 words / 12 min target). */
export const WORDS_PER_MINUTE = 183;
/** scriptService default word budget when the producer sets none. */
export const DEFAULT_MAX_WORDS = 2200;
/** Rough words a single topic segment adds, plus a fixed intro/outro base. Tuned
 *  so a 3-topic rundown lands near the 2200-word default. */
const BASE_WORDS = 500;
const WORDS_PER_TOPIC = 550;
/** Average characters per spoken word incl. trailing space (TTS bills per char). */
const CHARS_PER_WORD = 6;

export interface RundownEstimateInput {
  /** Topics in the rundown (for automatic mode, the TARGET count). */
  topicCount: number;
  /** Advanced word budget, if the producer set one; else the topic-scaled estimate. */
  maxWords?: number | null;
}

export interface RundownEstimate {
  isEstimate: true;
  topicCount: number;
  estimatedWords: number;
  estimatedDurationMinutes: number;
  estimatedTtsCharacters: number;
  /** Computed only when TTS_COST_PER_1K_CHARS is configured; otherwise null. */
  estimatedCostUsd: number | null;
  /** Plain-language explanation of what drives each estimate. */
  costBasis: string;
}

/** Per-1k-character TTS rate, ONLY if the operator has configured one. There is
 *  no provider pricing in the repo, so absent this env we do not invent a cost. */
function configuredTtsRatePer1kChars(): number | null {
  const raw = Number(process.env.TTS_COST_PER_1K_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * Estimate a rundown's duration, script length, and TTS character volume. Cost
 * is returned only when a real rate is configured; otherwise the character
 * driver is surfaced and cost is left null (never faked).
 */
export function estimateRundown(input: RundownEstimateInput): RundownEstimate {
  const topicCount = Math.max(0, Math.floor(input.topicCount));
  const words =
    input.maxWords && input.maxWords > 0
      ? Math.round(input.maxWords)
      : BASE_WORDS + WORDS_PER_TOPIC * topicCount;
  const durationMinutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
  const chars = words * CHARS_PER_WORD;

  const rate = configuredTtsRatePer1kChars();
  const costUsd = rate !== null ? Math.round((chars / 1000) * rate * 100) / 100 : null;

  const costBasis =
    rate !== null
      ? `Estimate. ~${words.toLocaleString()} words ≈ ${durationMinutes} min at ${WORDS_PER_MINUTE} wpm; ~${chars.toLocaleString()} TTS characters × $${rate}/1k chars (TTS_COST_PER_1K_CHARS).`
      : `Estimate. ~${words.toLocaleString()} words ≈ ${durationMinutes} min at ${WORDS_PER_MINUTE} wpm; ~${chars.toLocaleString()} TTS characters. Dollar cost depends on your voice provider's per-character rate, which isn't stored here.`;

  return {
    isEstimate: true,
    topicCount,
    estimatedWords: words,
    estimatedDurationMinutes: durationMinutes,
    estimatedTtsCharacters: chars,
    estimatedCostUsd: costUsd,
    costBasis,
  };
}
