// Shared fact-vs-opinion language rules for the debate format.
//
// One source of truth for three consumers — script generation
// (scriptService), the approval validator (scriptValidation), and the fact
// checker (factCheckService) — which previously each carried their own copy
// of a single PROHIBITED_KEYWORDS list that banned ordinary predictive
// speech ("likely to", "could be") alongside fabricated-sourcing language.
// On a sports DEBATE show, speculation IS the format; fabricating sources is
// the actual offense. The two must never be merged again.

/**
 * Fabricated-sourcing language: hard-prohibited. A host may never attribute
 * a claim to reporting or anonymous sources — the show argues only from its
 * own research evidence. Flagged on every line type.
 */
export const RUMOR_KEYWORDS = [
  "sources say",
  "rumored",
  "reportedly",
  "insider",
  "unnamed source",
];

/**
 * Predictive hedging: normal debate speech ("he's likely to win MVP",
 * "they could be the best defense"). Never flagged on opinion/prediction
 * lines. On a genuine factual assertion it is only suspect when the brief
 * doesn't support the phrasing — the fact checker verifies that; the
 * validator does not blanket-ban it.
 */
export const SPECULATION_KEYWORDS = [
  "expected to",
  "likely to",
  "could be",
  "might be",
];

/** First hard-prohibited rumor keyword found in the (lowercased) text. */
export function findRumorKeyword(textLower: string): string | null {
  for (const word of RUMOR_KEYWORDS) {
    if (textLower.includes(word)) return word;
  }
  return null;
}

/** First speculation keyword found in the (lowercased) text. */
export function findSpeculationKeyword(textLower: string): string | null {
  for (const word of SPECULATION_KEYWORDS) {
    if (textLower.includes(word)) return word;
  }
  return null;
}

// Markers of clearly-framed opinion/prediction speech. Deliberately loose:
// this only ever runs on lines the writer marked isFactualClaim=true that
// carry NO evidence ref, deciding whether to hold them to the factual-claim
// bar. A miss in either direction is non-fatal — the unsafe-claims check and
// the LLM semantic review still see every line.
const OPINION_MARKERS = [
  // first-person judgment framing
  "i think",
  "i believe",
  "i'd ",
  "i would",
  "my take",
  "to me",
  "if you ask me",
  "i'm telling you",
  "mark my words",
  "for my money",
  "i guarantee",
  // predictive / hypothetical framing
  "gonna",
  "going to",
  "will win",
  "will be",
  "won't",
  "would be",
  "wouldn't",
  "could ",
  "might ",
  "may be",
  "should ",
  "expected to",
  "likely to",
  "on pace to",
  "feels like",
  "looks like",
  "no chance",
  "no way",
];

/** True when the line reads as opinion/prediction rather than stated fact. */
export function isOpinionFramed(textLower: string): boolean {
  return OPINION_MARKERS.some((m) => textLower.includes(m));
}

/**
 * The factual-claim bar applies to a line when the writer marked it factual
 * AND it either cites evidence (then it must check out) or is stated flatly
 * as fact. A ref-less line in clear opinion/prediction framing is treated as
 * opinion — the writer over-marking hot takes as "factual" must not tank
 * evidence coverage or trip speculation flags.
 */
export function isGenuineFactualAssertion(
  line: { isFactualClaim?: boolean; evidenceRefs?: unknown[] },
  spokenTextLower: string
): boolean {
  if (line.isFactualClaim !== true) return false;
  if (Array.isArray(line.evidenceRefs) && line.evidenceRefs.length > 0) return true;
  return !isOpinionFramed(spokenTextLower);
}
