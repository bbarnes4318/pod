// Episode-wide SEMANTIC repeated-point detector.
//
// WHY THIS EXISTS
// ---------------
// scriptRepetition.ts catches near-duplicate STRINGS (word-trigram Jaccard on
// whole lines). A real 66-line / 1470-word production episode sailed through it
// while restating the same three propositions in every one of its 7 segments,
// hammering a handful of content words ("spreadsheet" x11, "fan" x18,
// "product" x13) and reusing one rhetorical frame ("that's not X, that's Y")
// until it became a tic. Every restatement was lexically *different enough*
// to be invisible to string-similarity.
//
// This module models repetition at the level of PROPOSITIONS, EVIDENCE,
// METAPHORS, CONCLUSIONS, SENTENCE FRAMES and CONCEPT BUDGETS instead.
//
// DESIGN CONSTRAINTS
//  - Fully offline + deterministic: no network, no API keys, no model calls.
//    Everything below is classical lexical semantics (stemming, stopword
//    stripping, tf-idf cosine, Jaccard, n-gram shingling, numeric
//    normalization) plus a domain-neutral concept-field lexicon.
//  - NO domain word list. The detector never looks for "spreadsheet" or
//    "fan". Budgets are derived from episode word count; the concept lexicon
//    is generic English (RESOLUTION, ARTIFICE, MONEY, ...), not baseball.
//  - Every finding is itemised with the lines that produced it, so an editor
//    or an automatic rewrite pass can act on it.

import { stripAudioTags } from "../audio/speechText";

/** Minimum repetitionScore (0-100, higher = less repetitive) for `passed`. */
export const SEMANTIC_REPETITION_THRESHOLD = 70;

/** A distinctive content lemma may appear this often per 1000 spoken words. */
export const DEFAULT_LEMMA_BUDGET_PER_1000 = 6;

/** A content-word bigram/trigram may appear this often per 1000 spoken words. */
export const DEFAULT_PHRASE_BUDGET_PER_1000 = 2.5;

/** A repeated sentence *skeleton* (function-word frame) allowance per 1000 words. */
export const DEFAULT_FRAME_BUDGET_PER_1000 = 2;

export type SemanticRepetitionCategory =
  | "repeated_claim"
  | "repeated_evidence"
  | "repeated_metaphor"
  | "repeated_conclusion"
  | "repeated_frame"
  | "phrase_budget"
  | "segment_recap"
  | "duplicate_thesis";

export type SemanticRepetitionSeverity = "low" | "medium" | "high";

export interface SemanticRepetitionEvidence {
  segmentIndex: number;
  segmentTitle?: string;
  lineIndex: number;
  speaker?: string;
  text: string;
}

export interface SemanticRepetitionFinding {
  category: SemanticRepetitionCategory;
  severity: SemanticRepetitionSeverity;
  /** One-line, editor-readable statement of the problem. */
  message: string;
  /** How many times the repeated thing occurs (cluster size / usage count). */
  occurrences: number;
  /** Points subtracted from repetitionScore by this finding. */
  penalty: number;
  /** Similarity / rate that triggered the finding, where meaningful. */
  measure?: number;
  /** Budget the measure was compared against, where meaningful. */
  allowance?: number;
  evidence: SemanticRepetitionEvidence[];
}

export interface SemanticRepetitionTotals {
  segments: number;
  lines: number;
  sentences: number;
  words: number;
  contentTokens: number;
  distinctContentLemmas: number;
  /** distinct content lemmas / content tokens — low = a small vocabulary reused. */
  typeTokenRatio: number;
}

export interface SemanticRepetitionBudgets {
  lemmaPer1000: number;
  lemmaAllowance: number;
  phrasePer1000: number;
  phraseAllowance: number;
  framePer1000: number;
  frameAllowance: number;
}

export interface SemanticRepetitionDiagnostics {
  topClaimPairs: Array<{ a: number; b: number; similarity: number; lexical: number; conceptual: number; aText: string; bText: string }>;
  topLemmas: Array<{ lemma: string; count: number; per1000: number }>;
  segmentNovelty: Array<{ segmentIndex: number; title?: string; noveltyRatio: number; words: number }>;
}

export interface SemanticRepetitionReport {
  /** 0-100, higher = better (less repetitive). */
  repetitionScore: number;
  passed: boolean;
  threshold: number;
  totals: SemanticRepetitionTotals;
  budgets: SemanticRepetitionBudgets;
  findings: SemanticRepetitionFinding[];
  categoriesTriggered: SemanticRepetitionCategory[];
  findingsByCategory: Record<SemanticRepetitionCategory, number>;
  penaltyByCategory: Record<SemanticRepetitionCategory, number>;
  diagnostics?: SemanticRepetitionDiagnostics;
}

export interface SemanticRepetitionOptions {
  /** Override SEMANTIC_REPETITION_THRESHOLD. */
  threshold?: number;
  lemmaBudgetPer1000?: number;
  phraseBudgetPer1000?: number;
  frameBudgetPer1000?: number;
  /** Similarity at/above which two sentences are "the same claim". */
  claimSimilarity?: number;
  /** Similarity at/above which two closing statements are "the same conclusion". */
  conclusionSimilarity?: number;
  /** Attach near-miss diagnostics (for tuning / debugging). */
  diagnostics?: boolean;
}

/** Loose shapes: script segments come from several places in this codebase. */
export interface SemanticRepetitionLineInput {
  text?: unknown;
  speakerName?: unknown;
  speaker?: unknown;
  [key: string]: unknown;
}
export interface SemanticRepetitionSegmentInput {
  type?: unknown;
  title?: unknown;
  topicId?: unknown;
  lines?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Lexical layer
// ---------------------------------------------------------------------------

const STOPWORDS = new Set<string>([
  "a", "about", "above", "after", "again", "against", "all", "already", "also", "am", "an", "and", "another",
  "any", "anything", "are", "around", "as", "at", "back", "be", "because", "been", "before", "being", "below",
  "beneath", "between", "beyond", "both", "but", "by", "can", "could", "did", "do", "does", "doing", "done",
  "down", "during", "each", "either", "else", "enough", "even", "ever", "every", "for", "from", "further",
  "get", "getting", "go", "going", "got", "had", "has", "have", "having", "he", "her", "here", "hers", "herself",
  "him", "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just", "kind", "lot",
  "make", "makes", "making", "many", "may", "me", "mean", "means", "might", "mine", "more", "most", "much",
  "my", "myself", "neither", "next", "no", "nor", "not", "now", "of", "off", "on", "once", "one", "only",
  "onto", "or", "other", "others", "our", "ours", "out", "over", "own", "part", "per", "pretty", "put",
  "quite", "rather", "really", "right", "said", "same", "say", "saying", "says", "see", "she", "should", "since",
  "so", "some", "something", "still", "such", "sure", "take", "than", "that", "the", "their", "theirs", "them",
  "themselves", "then", "there", "these", "they", "thing", "things", "this", "those", "though", "through",
  "to", "too", "under", "until", "up", "upon", "us", "very", "was", "way", "we", "well", "were", "what",
  "whatever", "when", "where", "whether", "which", "while", "who", "whom", "whose", "why", "will", "with",
  "within", "without", "would", "yeah", "yes", "yet", "you", "your", "yours", "yourself",
]);

/** Discourse glue that should never be treated as a content lemma. */
const DISCOURSE_WORDS = new Set<string>([
  "okay", "ok", "alright", "hey", "look", "listen", "man", "hmm", "uh", "um", "oh", "wow", "sort", "guess",
  "think", "thought", "know", "knew", "want", "wanted", "let", "lets", "come", "came", "give", "gave",
]);

function isFunctionWord(token: string): boolean {
  if (!token) return true;
  if (STOPWORDS.has(token)) return true;
  const apostrophe = token.indexOf("'");
  if (apostrophe > 0) {
    const base = token.slice(0, apostrophe);
    const tail = token.slice(apostrophe + 1);
    if (STOPWORDS.has(base) && /^(s|t|re|ve|ll|d|m|nt)$/.test(tail)) return true;
    if (base === "n" || tail === "t") return true;
  }
  return false;
}

/**
 * Light Porter-style stemmer. Deliberately conservative: it must merge
 * inflections ("fans"/"fan", "ended"/"ending"/"end") without merging
 * unrelated words, because lemma budgets are counted on stems.
 */
export function stemWord(word: string): string {
  let s = word.replace(/'(s|re|ve|ll|d|m)$/, "").replace(/n't$/, "");
  if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && /(sses|shes|ches|xes|zes)$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);

  const trimmable = (stripped: string) => stripped.length >= 3 && /[aeiouy]/.test(stripped);
  if (s.length > 5 && s.endsWith("ingly") && trimmable(s.slice(0, -5))) s = s.slice(0, -5);
  else if (s.length > 4 && s.endsWith("ing") && trimmable(s.slice(0, -3))) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("edly") && trimmable(s.slice(0, -4))) s = s.slice(0, -4);
  else if (s.length > 4 && s.endsWith("ed") && trimmable(s.slice(0, -2))) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith("ly") && trimmable(s.slice(0, -2))) s = s.slice(0, -2);

  // collapse a doubled final consonant left behind by -ing/-ed stripping
  if (s.length > 3 && /([bdfglmnprt])\1$/.test(s)) s = s.slice(0, -1);
  return s;
}

function normalizeText(text: unknown): string {
  return stripAudioTags(String(text ?? ""))
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, " - ")
    .toLowerCase();
}

function tokenize(normalized: string): string[] {
  return normalized
    .replace(/[^a-z0-9'$%.:\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[-'.:]+/, "").replace(/[-'.:,]+$/, ""))
    .filter(Boolean);
}

function splitSentences(normalized: string): string[] {
  return normalized
    .split(/(?<=[.!?])\s+|\s+-\s+/)
    .map((s) => s.trim())
    .filter((s) => tokenize(s).length > 0);
}

// ---------------------------------------------------------------------------
// Concept-field lexicon
//
// Domain-NEUTRAL abstract frames. This is the "semantic" half of the
// representation: it lets two sentences with almost no shared wording
// ("the drama ended before the second inning" / "by the time the first
// wrapped up nobody had any doubt about the result") be recognised as the
// same proposition. `weight` encodes how propositionally *substantive* a
// frame is — generic frames (PERCEPTION, COMPETITION) are weak evidence,
// specific ones (RESOLUTION, ARTIFICE, FAILURE) are strong.
// ---------------------------------------------------------------------------

interface ConceptFrame {
  weight: number;
  words: string[];
}

const CONCEPT_FRAMES: Record<string, ConceptFrame> = {
  RESOLUTION: {
    weight: 0.95,
    words: [
      "end", "ended", "ending", "finish", "finished", "settle", "settled", "decide", "decided", "decisive",
      "determine", "determined", "seal", "sealed", "resolve", "resolved", "conclude", "concluded", "wrap",
      "wrapped", "final", "finale", "outcome", "result", "foregone", "clinch", "clinched", "locked", "over",
      "verdict", "closed",
    ],
  },
  EARLINESS: {
    weight: 0.75,
    words: [
      "early", "earliest", "first", "second", "third", "opening", "open", "start", "started", "begin",
      "beginning", "began", "initial", "immediately", "instantly", "soon", "outset", "gate", "premature",
      "prematurely", "top",
    ],
  },
  LATENESS: {
    weight: 0.6,
    words: ["late", "later", "eventually", "finally", "last", "overdue", "delay", "delayed", "lingering", "dragged"],
  },
  CERTAINTY: {
    weight: 0.85,
    words: [
      "obvious", "obviously", "clear", "clearly", "certain", "certainly", "doubt", "guarantee", "guaranteed",
      "inevitable", "inevitably", "predictable", "predicted", "evident", "apparent", "telegraphed", "sure",
      "suspense", "unclear", "unknown", "mystery",
    ],
  },
  FAILURE: {
    weight: 0.9,
    words: [
      "fail", "failed", "failure", "broken", "broke", "collapse", "collapsed", "disaster", "mess", "botched",
      "flop", "flopped", "bust", "wrong", "mistake", "error", "misstep", "blunder", "problem", "dysfunction",
      "embarrassing", "embarrassment",
    ],
  },
  SUCCESS: {
    weight: 0.8,
    words: [
      "win", "won", "winner", "succeed", "success", "successful", "triumph", "nailed", "delivered", "dominate",
      "dominated", "dominant", "thrive", "thrived", "worked", "flawless", "perfect",
    ],
  },
  MONEY: {
    weight: 0.9,
    words: [
      "money", "cost", "costs", "price", "priced", "pay", "paid", "dollar", "dollars", "revenue", "profit",
      "profitable", "budget", "cash", "spend", "spending", "sell", "selling", "sold", "sponsor", "sponsorship",
      "buy", "bought", "contract", "salary", "monetize", "commercial", "ad", "ads",
    ],
  },
  ARTIFICE: {
    weight: 0.95,
    words: [
      "fake", "faked", "staged", "manufactured", "artificial", "scripted", "gimmick", "stunt", "marketing",
      "brand", "branded", "product", "packaging", "packaged", "optics", "theater", "theatre", "choreographed",
      "contrived", "synthetic", "simulation", "content", "engagement", "engineered",
    ],
  },
  AUTHENTICITY: {
    weight: 0.9,
    words: ["real", "genuine", "genuinely", "authentic", "honest", "honestly", "true", "raw", "organic", "sincere", "human", "actual"],
  },
  PLANNING: {
    weight: 0.85,
    words: [
      "plan", "planned", "planning", "schedule", "scheduled", "scheduling", "logistics", "logistical",
      "calendar", "itinerary", "arrange", "arranged", "organize", "organized", "slot", "slotted", "timetable",
      "allocation", "allocate", "coordination", "coordinate", "operations", "operational", "process",
    ],
  },
  EMOTION_HIGH: {
    weight: 0.8,
    words: [
      "drama", "dramatic", "thrill", "thrilling", "excite", "excited", "exciting", "excitement", "tension",
      "tense", "electric", "buzz", "roar", "roared", "passion", "passionate", "chaos", "chaotic", "wild",
      "frenzy", "adrenaline", "stakes",
    ],
  },
  EMOTION_LOW: {
    weight: 0.85,
    words: [
      "boring", "bored", "dull", "flat", "lifeless", "tedious", "snooze", "sterile", "joyless", "listless",
      "bland", "inert", "numb", "apathy", "apathetic", "indifferent",
    ],
  },
  QUANTITY_UP: {
    weight: 0.55,
    words: ["increase", "increased", "rise", "rose", "risen", "grew", "grow", "growth", "surge", "surged", "spike", "spiked", "double", "doubled", "triple", "record", "highest", "climbed"],
  },
  QUANTITY_DOWN: {
    weight: 0.55,
    words: ["decrease", "decreased", "drop", "dropped", "fall", "fell", "decline", "declined", "shrink", "shrank", "cut", "slashed", "lowest", "plunge", "plunged", "fewer", "less"],
  },
  AUDIENCE: {
    weight: 0.7,
    words: [
      "fan", "fans", "crowd", "crowds", "viewer", "viewers", "audience", "attendance", "ticket", "tickets",
      "stands", "spectator", "spectators", "public", "subscriber", "subscribers", "customer", "customers",
    ],
  },
  PERCEPTION: {
    weight: 0.5,
    words: ["watch", "watched", "watching", "saw", "seen", "look", "looked", "looking", "notice", "noticed", "witness", "witnessed", "observe", "tuned", "viewing"],
  },
  ABSENCE: {
    weight: 0.7,
    words: ["nobody", "nothing", "none", "never", "empty", "absent", "absence", "lack", "lacking", "missing", "vanished", "gone", "without", "zero"],
  },
  COMPETITION: {
    weight: 0.5,
    words: ["game", "games", "match", "contest", "compete", "competition", "competitive", "rival", "rivalry", "opponent", "battle", "race", "showdown", "matchup", "playoff", "tournament"],
  },
  OBLIGATION: {
    weight: 0.55,
    words: ["should", "must", "need", "needs", "needed", "ought", "require", "required", "mandatory", "obligation", "supposed"],
  },
  CHANGE: {
    weight: 0.7,
    words: ["change", "changed", "shift", "shifted", "become", "became", "turning", "transform", "transformed", "evolve", "evolved", "modern", "modernized", "era", "trend", "new", "different", "anymore", "used"],
  },
  RITUAL: {
    weight: 0.8,
    words: ["ceremony", "ceremonial", "ritual", "tribute", "celebration", "celebrate", "honor", "honored", "commemorate", "recognition", "award", "presentation", "salute"],
  },
  SCALE: {
    weight: 0.5,
    words: ["huge", "massive", "enormous", "giant", "tiny", "small", "big", "biggest", "largest", "minor", "major"],
  },
};

const FRAME_WEIGHT = new Map<string, number>();
const STEM_TO_FRAMES = new Map<string, string[]>();
for (const [frame, def] of Object.entries(CONCEPT_FRAMES)) {
  FRAME_WEIGHT.set(frame, def.weight);
  for (const word of def.words) {
    const stem = stemWord(word);
    const existing = STEM_TO_FRAMES.get(stem);
    if (existing) {
      if (!existing.includes(frame)) existing.push(frame);
    } else {
      STEM_TO_FRAMES.set(stem, [frame]);
    }
  }
}

const CARDINALS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, thousand: 1000, million: 1000000, billion: 1000000000,
};
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12,
};

const CONCLUSION_MARKERS = /\b(at the end of the day|bottom line|the point is|that's the point|which is why|in the end|ultimately|net net|so really|the whole story|that's the story|the takeaway|what it comes down to|when you add it up|so there it is)\b/;
const FRESH_EVIDENCE_MARKERS = /\b(get this|here's the thing|here's the number|turns out|it turns out|check this|listen to this|and this is the part|the number is|look it up|believe it or not|would you believe)\b/;
// Only explicitly FIGURATIVE comparison markers. A bare copula ("it's a good
// move") is not a metaphor, and treating it as one floods the report.
const METAPHOR_MARKERS = /\b(like a|like an|is basically|are basically|basically a|basically an|might as well be|is just a|are just a|just a|is nothing but|nothing but a|feels like|felt like|feel like|sounds like|looks like|is essentially|essentially a|the equivalent of|amounts to|a version of|not a|not an|not just a)\b/;
const RECAP_MARKERS = /\b(as i said|like i said|as we said|to recap|recapping|coming back to|circling back|again,|to repeat|as mentioned|going back to|same as before|like we talked about)\b/;

// ---------------------------------------------------------------------------
// Sentence model
// ---------------------------------------------------------------------------

interface NumericClaim {
  /** Normalized "value" or "value:unit" key. */
  key: string;
  value: number;
  unit?: string;
  raw: string;
}

interface SentenceUnit {
  id: number;
  segmentIndex: number;
  segmentTitle?: string;
  lineIndex: number;
  speaker?: string;
  /** Position of the sentence inside its line. */
  sentenceInLine: number;
  isLastInSegment: boolean;
  text: string;
  normalized: string;
  tokens: string[];
  contentStems: string[];
  stemSet: Set<string>;
  tf: Map<string, number>;
  frames: Map<string, number>;
  anchors: Set<string>;
  numerics: NumericClaim[];
  wordCount: number;
  isQuestion: boolean;
  negated: boolean;
  isAssertive: boolean;
  hasConclusionMarker: boolean;
  hasFreshEvidenceMarker: boolean;
  hasRecapMarker: boolean;
}

function isContentToken(token: string): boolean {
  if (isFunctionWord(token)) return false;
  if (DISCOURSE_WORDS.has(token)) return false;
  if (/^[0-9$%.:-]+$/.test(token)) return false;
  return token.length > 1;
}

function extractNumerics(tokens: string[]): NumericClaim[] {
  const claims: NumericClaim[] = [];
  let consumedUpTo = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (i <= consumedUpTo) continue;
    const token = tokens[i];
    let value: number | null = null;
    let raw = token;

    const digits = token.match(/^\$?(\d[\d,]*(?:\.\d+)?)%?$/);
    if (digits) {
      value = Number(digits[1].replace(/,/g, ""));
    } else if (CARDINALS[token] !== undefined && CARDINALS[token] >= 2) {
      value = CARDINALS[token];
    }
    // Ordinals ("the ninth inning", "the second batter") are POSITIONS, not
    // statistics. They anchor propositions but are never "reused evidence".
    if (value === null || !Number.isFinite(value)) continue;

    let unit: string | undefined;
    let scale = 1;
    const next = tokens[i + 1];
    if (next && CARDINALS[next] !== undefined && CARDINALS[next] >= 100) {
      scale = CARDINALS[next];
      raw = `${token} ${next}`;
      consumedUpTo = i + 1;
      const afterScale = tokens[i + 2];
      if (afterScale && isContentToken(afterScale)) unit = stemWord(afterScale);
    } else if (token.startsWith("$")) {
      unit = "dollar";
    } else if (token.endsWith("%")) {
      unit = "percent";
    } else if (next && isContentToken(next)) {
      unit = stemWord(next);
      raw = `${token} ${next}`;
    }

    const normalizedValue = value * scale;
    claims.push({
      key: unit ? `${normalizedValue}:${unit}` : `${normalizedValue}`,
      value: normalizedValue,
      unit,
      raw,
    });
  }
  return claims;
}

function buildSentence(
  id: number,
  segmentIndex: number,
  segmentTitle: string | undefined,
  lineIndex: number,
  speaker: string | undefined,
  sentenceInLine: number,
  rawSentence: string,
  displayText: string,
): SentenceUnit {
  const normalized = rawSentence;
  const tokens = tokenize(normalized);
  const contentStems: string[] = [];
  const frames = new Map<string, number>();
  const anchors = new Set<string>();

  for (const token of tokens) {
    if (!isContentToken(token)) continue;
    const stem = stemWord(token);
    if (!stem) continue;
    contentStems.push(stem);
    const frameNames = STEM_TO_FRAMES.get(stem);
    if (frameNames) for (const frame of frameNames) frames.set(frame, (frames.get(frame) || 0) + 1);
  }

  const numerics = extractNumerics(tokens);
  for (const claim of numerics) anchors.add(`#${claim.key}`);
  for (const token of tokens) {
    if (ORDINALS[token] !== undefined) anchors.add(`#ord${ORDINALS[token]}`);
  }

  const tf = new Map<string, number>();
  for (const stem of contentStems) tf.set(stem, (tf.get(stem) || 0) + 1);

  const wordCount = tokens.length;
  const isQuestion = /\?\s*$/.test(displayText.trim());
  const negated = /\b(not|no|never|nobody|nothing|isn't|wasn't|aren't|don't|didn't|doesn't|won't|can't)\b/.test(normalized);

  return {
    id,
    segmentIndex,
    segmentTitle,
    lineIndex,
    speaker,
    sentenceInLine,
    isLastInSegment: false,
    text: displayText,
    normalized,
    tokens,
    contentStems,
    stemSet: new Set(contentStems),
    tf,
    frames,
    anchors,
    numerics,
    wordCount,
    isQuestion,
    negated,
    isAssertive: !isQuestion && wordCount >= 7 && new Set(contentStems).size >= 4,
    hasConclusionMarker: CONCLUSION_MARKERS.test(normalized),
    hasFreshEvidenceMarker: FRESH_EVIDENCE_MARKERS.test(normalized),
    hasRecapMarker: RECAP_MARKERS.test(normalized),
  };
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}

function cosine(a: Map<string, number>, b: Map<string, number>, idf: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [stem, count] of a) {
    const weight = count * (idf.get(stem) ?? 1);
    normA += weight * weight;
  }
  for (const [stem, count] of b) {
    const weight = count * (idf.get(stem) ?? 1);
    normB += weight * weight;
    const other = a.get(stem);
    if (other) dot += weight * other * (idf.get(stem) ?? 1);
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Salience-weighted concept-frame vector for one sentence. */
function frameVector(unit: SentenceUnit): Map<string, number> {
  const vector = new Map<string, number>();
  for (const [frame, count] of unit.frames) vector.set(frame, count * (FRAME_WEIGHT.get(frame) ?? 0.5));
  return vector;
}

interface ClaimMatch {
  a: SentenceUnit;
  b: SentenceUnit;
  similarity: number;
  lexical: number;
  conceptual: number;
}

/**
 * Two-channel proposition similarity.
 *
 *  LEXICAL — stem Jaccard + tf-idf cosine. Catches restatements that reuse
 *  most of their vocabulary ("the game was over in the first" / "the game
 *  was already over by the first inning").
 *
 *  CONCEPTUAL — weighted overlap of abstract concept frames. Catches true
 *  paraphrase, where the two sentences share almost no words but assert the
 *  same thing. Requires at least two shared frames, one of which must be
 *  propositionally substantive (weight >= 0.8), plus dominant coverage of the
 *  smaller frame profile — so merely both being "about sport" is not enough.
 */
function propositionSimilarity(a: SentenceUnit, b: SentenceUnit, idf: Map<string, number>): ClaimMatch {
  const stemJaccard = jaccard(a.stemSet, b.stemSet);
  const cos = cosine(a.tf, b.tf, idf);
  const lexical = 0.55 * stemJaccard + 0.45 * cos;

  let sharedWeight = 0;
  let maxSharedFrameWeight = 0;
  let sharedFrames = 0;
  for (const frame of a.frames.keys()) {
    if (!b.frames.has(frame)) continue;
    const weight = FRAME_WEIGHT.get(frame) ?? 0.5;
    sharedWeight += weight;
    sharedFrames++;
    if (weight > maxSharedFrameWeight) maxSharedFrameWeight = weight;
  }
  const selfWeight = (unit: SentenceUnit) => {
    let total = 0;
    for (const frame of unit.frames.keys()) total += FRAME_WEIGHT.get(frame) ?? 0.5;
    return total;
  };
  const minSelf = Math.min(selfWeight(a), selfWeight(b));
  const coverage = minSelf > 0 ? sharedWeight / minSelf : 0;

  let conceptual = 0;
  const bothAssertive = a.isAssertive && b.isAssertive;
  const polarityAgrees = a.negated === b.negated;
  // Gate first (precision), then score. The gate demands that the two
  // sentences share at least two concept frames, at least one of which is
  // propositionally substantive, and that those shared frames dominate the
  // smaller of the two frame profiles — "both mention sport" cannot qualify.
  if (bothAssertive && sharedFrames >= 2 && maxSharedFrameWeight >= 0.8 && coverage >= 0.6) {
    let sharedAnchor = false;
    for (const anchor of a.anchors) if (b.anchors.has(anchor)) sharedAnchor = true;
    // Cosine in CONCEPT space: the same vector-space model as tf-idf, with
    // salience-weighted concept frames standing in for words.
    const frameCosine = cosineVectors(frameVector(a), frameVector(b));
    conceptual = Math.min(
      1,
      0.32 +
        0.42 * frameCosine +
        0.12 * Math.min(1, coverage) +
        (sharedAnchor ? 0.08 : 0) +
        0.12 * stemJaccard -
        (polarityAgrees ? 0 : 0.03),
    );
  }

  return { a, b, similarity: Math.max(lexical, conceptual), lexical, conceptual };
}

// ---------------------------------------------------------------------------
// Union-find for clustering matched claims
// ---------------------------------------------------------------------------

class DisjointSet {
  private parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootB] = rootA;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const CATEGORY_CAPS: Record<SemanticRepetitionCategory, number> = {
  repeated_claim: 34,
  repeated_evidence: 12,
  repeated_metaphor: 12,
  repeated_conclusion: 12,
  repeated_frame: 16,
  phrase_budget: 20,
  segment_recap: 18,
  duplicate_thesis: 14,
};

const ALL_CATEGORIES = Object.keys(CATEGORY_CAPS) as SemanticRepetitionCategory[];

export function analyzeSemanticRepetition(
  segments: SemanticRepetitionSegmentInput[] | null | undefined,
  opts: SemanticRepetitionOptions = {},
): SemanticRepetitionReport {
  const threshold = opts.threshold ?? SEMANTIC_REPETITION_THRESHOLD;
  const lemmaPer1000 = opts.lemmaBudgetPer1000 ?? DEFAULT_LEMMA_BUDGET_PER_1000;
  const phrasePer1000 = opts.phraseBudgetPer1000 ?? DEFAULT_PHRASE_BUDGET_PER_1000;
  const framePer1000 = opts.frameBudgetPer1000 ?? DEFAULT_FRAME_BUDGET_PER_1000;
  const claimSimilarity = opts.claimSimilarity ?? 0.55;
  const conclusionSimilarity = opts.conclusionSimilarity ?? 0.45;

  // ---- flatten -----------------------------------------------------------
  const sentences: SentenceUnit[] = [];
  const segmentList = Array.isArray(segments) ? segments : [];
  let globalLineIndex = 0;
  let totalWords = 0;
  const segmentMeta: Array<{ index: number; title?: string; topicKey: string; words: number; sentenceIds: number[] }> = [];

  segmentList.forEach((segment, segmentIndex) => {
    const title = segment?.title === undefined || segment?.title === null ? undefined : String(segment.title);
    const topicKey = String(segment?.topicId ?? segment?.title ?? segment?.type ?? `segment-${segmentIndex}`).toLowerCase();
    const lines = Array.isArray(segment?.lines) ? (segment.lines as SemanticRepetitionLineInput[]) : [];
    const meta = { index: segmentIndex, title, topicKey, words: 0, sentenceIds: [] as number[] };

    for (const line of lines) {
      const rawText = typeof line === "string" ? line : line?.text;
      const speakerRaw = typeof line === "string" ? undefined : (line?.speakerName ?? line?.speaker);
      const speaker = speakerRaw === undefined || speakerRaw === null ? undefined : String(speakerRaw);
      const display = stripAudioTags(String(rawText ?? "")).trim();
      const normalized = normalizeText(rawText);
      const lineWords = tokenize(normalized).length;
      totalWords += lineWords;
      meta.words += lineWords;

      const parts = splitSentences(normalized);
      const displayParts = splitSentences(display.replace(/[–—]/g, " - "));
      parts.forEach((part, sentenceInLine) => {
        const unit = buildSentence(
          sentences.length,
          segmentIndex,
          title,
          globalLineIndex,
          speaker,
          sentenceInLine,
          part,
          (displayParts[sentenceInLine] ?? part).trim(),
        );
        sentences.push(unit);
        meta.sentenceIds.push(unit.id);
      });
      globalLineIndex++;
    }

    if (meta.sentenceIds.length > 0) {
      const lastId = meta.sentenceIds[meta.sentenceIds.length - 1];
      sentences[lastId].isLastInSegment = true;
    }
    segmentMeta.push(meta);
  });

  const findings: SemanticRepetitionFinding[] = [];

  const totals: SemanticRepetitionTotals = {
    segments: segmentList.length,
    lines: globalLineIndex,
    sentences: sentences.length,
    words: totalWords,
    contentTokens: 0,
    distinctContentLemmas: 0,
    typeTokenRatio: 0,
  };

  const budgets: SemanticRepetitionBudgets = {
    lemmaPer1000,
    lemmaAllowance: Math.max(3, Math.ceil((lemmaPer1000 * Math.max(totalWords, 1)) / 1000)),
    phrasePer1000,
    phraseAllowance: Math.max(2, Math.ceil((phrasePer1000 * Math.max(totalWords, 1)) / 1000)),
    framePer1000,
    frameAllowance: Math.max(3, Math.ceil((framePer1000 * Math.max(totalWords, 1)) / 1000)),
  };

  if (sentences.length === 0) {
    return {
      repetitionScore: 100,
      passed: 100 >= threshold,
      threshold,
      totals,
      budgets,
      findings,
      categoriesTriggered: [],
      findingsByCategory: emptyCounts(),
      penaltyByCategory: emptyCounts(),
    };
  }

  // ---- corpus statistics -------------------------------------------------
  const df = new Map<string, number>();
  const lemmaCounts = new Map<string, number>();
  let contentTokens = 0;
  for (const sentence of sentences) {
    for (const stem of sentence.contentStems) {
      lemmaCounts.set(stem, (lemmaCounts.get(stem) || 0) + 1);
      contentTokens++;
    }
    for (const stem of sentence.stemSet) df.set(stem, (df.get(stem) || 0) + 1);
  }
  totals.contentTokens = contentTokens;
  totals.distinctContentLemmas = lemmaCounts.size;
  totals.typeTokenRatio = contentTokens > 0 ? Number((lemmaCounts.size / contentTokens).toFixed(4)) : 0;

  const idf = new Map<string, number>();
  for (const [stem, count] of df) idf.set(stem, Math.log(1 + sentences.length / count));
  const medianIdf = median([...idf.values()]);
  const isDistinctive = (stem: string) => (idf.get(stem) ?? 0) >= medianIdf;

  const evidenceOf = (unit: SentenceUnit): SemanticRepetitionEvidence => ({
    segmentIndex: unit.segmentIndex,
    segmentTitle: unit.segmentTitle,
    lineIndex: unit.lineIndex,
    speaker: unit.speaker,
    text: unit.text,
  });

  // =========================================================================
  // 1. REPEATED CLAIMS / PROPOSITIONS
  // =========================================================================
  const matches: ClaimMatch[] = [];
  const allPairs: ClaimMatch[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const a = sentences[i];
    if (!a.isAssertive) continue;
    for (let j = i + 1; j < sentences.length; j++) {
      const b = sentences[j];
      if (!b.isAssertive) continue;
      const match = propositionSimilarity(a, b, idf);
      if (opts.diagnostics) allPairs.push(match);
      if (match.similarity >= claimSimilarity) matches.push(match);
    }
  }

  if (matches.length > 0) {
    const dsu = new DisjointSet(sentences.length);
    for (const match of matches) dsu.union(match.a.id, match.b.id);
    const clusters = new Map<number, number[]>();
    for (const match of matches) {
      for (const id of [match.a.id, match.b.id]) {
        const root = dsu.find(id);
        const bucket = clusters.get(root) ?? [];
        if (!bucket.includes(id)) bucket.push(id);
        clusters.set(root, bucket);
      }
    }
    const ordered = [...clusters.values()].sort((x, y) => y.length - x.length);
    let spent = 0;
    for (const cluster of ordered) {
      const ids = [...cluster].sort((x, y) => x - y);
      const size = ids.length;
      const bestSimilarity = Math.max(
        ...matches.filter((m) => ids.includes(m.a.id) && ids.includes(m.b.id)).map((m) => m.similarity),
      );
      const segmentsSpanned = new Set(ids.map((id) => sentences[id].segmentIndex)).size;
      const raw = 5 + 3 * (size - 2) + (segmentsSpanned >= 3 ? 3 : 0);
      const penalty = Math.min(raw, Math.max(0, CATEGORY_CAPS.repeated_claim - spent));
      spent += penalty;
      findings.push({
        category: "repeated_claim",
        severity: size >= 4 || segmentsSpanned >= 3 ? "high" : size >= 3 ? "medium" : "low",
        message:
          `the same proposition is asserted ${size} times` +
          (segmentsSpanned > 1 ? ` across ${segmentsSpanned} segments` : " in one segment") +
          ` (peak similarity ${bestSimilarity.toFixed(2)}): "${truncate(sentences[ids[0]].text, 90)}"`,
        occurrences: size,
        penalty,
        measure: Number(bestSimilarity.toFixed(3)),
        allowance: claimSimilarity,
        evidence: ids.map((id) => evidenceOf(sentences[id])),
      });
      if (spent >= CATEGORY_CAPS.repeated_claim) break;
    }
  }

  // =========================================================================
  // 2. REPEATED EVIDENCE (the same number presented as if it were new)
  // =========================================================================
  const numericUses = new Map<string, Array<{ unit: SentenceUnit; raw: string }>>();
  for (const sentence of sentences) {
    const seenInSentence = new Set<string>();
    for (const claim of sentence.numerics) {
      if (seenInSentence.has(claim.key)) continue;
      seenInSentence.add(claim.key);
      const bucket = numericUses.get(claim.key) ?? [];
      bucket.push({ unit: sentence, raw: claim.raw });
      numericUses.set(claim.key, bucket);
    }
  }
  {
    let spent = 0;
    const reused = [...numericUses.entries()]
      .filter(([, uses]) => new Set(uses.map((u) => u.unit.lineIndex)).size >= 2)
      .sort((a, b) => b[1].length - a[1].length);
    for (const [key, uses] of reused) {
      if (spent >= CATEGORY_CAPS.repeated_evidence) break;
      const distinctLines = new Set(uses.map((u) => u.unit.lineIndex)).size;
      const framedAsNew = uses.filter((u) => u.unit.hasFreshEvidenceMarker).length;
      const raw = 3 + (distinctLines >= 3 ? 2 : 0) + (framedAsNew >= 1 ? 2 : 0);
      const penalty = Math.min(raw, CATEGORY_CAPS.repeated_evidence - spent);
      spent += penalty;
      findings.push({
        category: "repeated_evidence",
        severity: distinctLines >= 3 || framedAsNew >= 1 ? "high" : "medium",
        message:
          `the same statistic (${uses[0].raw}${key.includes(":") ? "" : ""}) is presented ${distinctLines} times` +
          (framedAsNew ? " — at least once framed as a fresh revelation" : ""),
        occurrences: distinctLines,
        penalty,
        measure: distinctLines,
        allowance: 1,
        evidence: uses.map((u) => evidenceOf(u.unit)),
      });
    }
  }

  // =========================================================================
  // 3. REPEATED METAPHORS (same comparison vehicle reused)
  // =========================================================================
  const vehicleUses = new Map<string, SentenceUnit[]>();
  for (const sentence of sentences) {
    for (const vehicle of extractMetaphorVehicles(sentence)) {
      const bucket = vehicleUses.get(vehicle) ?? [];
      if (!bucket.some((u) => u.lineIndex === sentence.lineIndex)) bucket.push(sentence);
      vehicleUses.set(vehicle, bucket);
    }
  }
  {
    let spent = 0;
    const repeated = [...vehicleUses.entries()].filter(([, uses]) => uses.length >= 2).sort((a, b) => b[1].length - a[1].length);
    for (const [vehicle, uses] of repeated) {
      if (spent >= CATEGORY_CAPS.repeated_metaphor) break;
      const raw = 3 + 2 * (uses.length - 2);
      const penalty = Math.min(raw, CATEGORY_CAPS.repeated_metaphor - spent);
      spent += penalty;
      findings.push({
        category: "repeated_metaphor",
        severity: uses.length >= 3 ? "high" : "medium",
        message: `the "${vehicle}" comparison is used as a metaphor ${uses.length} times — the image stops landing after the first`,
        occurrences: uses.length,
        penalty,
        measure: uses.length,
        allowance: 1,
        evidence: uses.map(evidenceOf),
      });
    }
  }

  // =========================================================================
  // 4. REPEATED CONCLUSIONS
  // =========================================================================
  const conclusions = sentences.filter((s) => s.isAssertive && (s.hasConclusionMarker || s.isLastInSegment));
  {
    const pairs: ClaimMatch[] = [];
    for (let i = 0; i < conclusions.length; i++) {
      for (let j = i + 1; j < conclusions.length; j++) {
        const match = propositionSimilarity(conclusions[i], conclusions[j], idf);
        if (match.similarity >= conclusionSimilarity) pairs.push(match);
      }
    }
    let spent = 0;
    const grouped = groupPairs(pairs);
    for (const group of grouped) {
      if (spent >= CATEGORY_CAPS.repeated_conclusion) break;
      const raw = 4 + 2 * (group.ids.length - 2);
      const penalty = Math.min(raw, CATEGORY_CAPS.repeated_conclusion - spent);
      spent += penalty;
      findings.push({
        category: "repeated_conclusion",
        severity: group.ids.length >= 3 ? "high" : "medium",
        message: `${group.ids.length} segment conclusions land on the same takeaway (similarity ${group.best.toFixed(2)}): "${truncate(sentences[group.ids[0]].text, 90)}"`,
        occurrences: group.ids.length,
        penalty,
        measure: Number(group.best.toFixed(3)),
        allowance: conclusionSimilarity,
        evidence: group.ids.map((id) => evidenceOf(sentences[id])),
      });
    }
  }

  // =========================================================================
  // 5. REPEATED SENTENCE FRAMES (function-word skeleton shingles)
  // =========================================================================
  {
    const frameUses = new Map<string, SentenceUnit[]>();
    for (const sentence of sentences) {
      // A frame slot holds a PHRASE, not a single word: "that's not a
      // scheduling error, that's the modern game" and "that's not a
      // spreadsheet, that's execution" are the same frame, so runs of
      // content words collapse into one slot.
      const skeleton: string[] = [];
      for (const token of sentence.tokens) {
        if (isFunctionWord(token)) skeleton.push(token);
        else if (skeleton[skeleton.length - 1] !== "•") skeleton.push("•");
      }
      const seen = new Set<string>();
      for (let n = 5; n <= 6; n++) {
        for (let i = 0; i + n <= skeleton.length; i++) {
          const window = skeleton.slice(i, i + n);
          const functionCount = window.filter((token) => token !== "•").length;
          const slotCount = n - functionCount;
          if (functionCount < 3 || slotCount < 1) continue;
          const key = window.join(" ");
          if (seen.has(key)) continue;
          seen.add(key);
          const bucket = frameUses.get(key) ?? [];
          bucket.push(sentence);
          frameUses.set(key, bucket);
        }
      }
    }
    let spent = 0;
    const overused = [...frameUses.entries()]
      .map(([key, uses]) => ({ key, uses, lines: new Set(uses.map((u) => u.lineIndex)).size }))
      .filter((entry) => entry.lines > budgets.frameAllowance)
      .sort((a, b) => b.lines - a.lines || a.key.length - b.key.length);

    const claimedLines = new Set<number>();
    for (const entry of overused) {
      if (spent >= CATEGORY_CAPS.repeated_frame) break;
      // Do not report ten overlapping shingles of the same tic.
      const lineIds = [...new Set(entry.uses.map((u) => u.lineIndex))];
      const fresh = lineIds.filter((id) => !claimedLines.has(id));
      if (fresh.length < Math.max(2, Math.ceil(lineIds.length * 0.5))) continue;
      for (const id of lineIds) claimedLines.add(id);
      const raw = 4 + 2 * (entry.lines - budgets.frameAllowance);
      const penalty = Math.min(raw, CATEGORY_CAPS.repeated_frame - spent);
      spent += penalty;
      findings.push({
        category: "repeated_frame",
        severity: entry.lines >= budgets.frameAllowance * 2 ? "high" : "medium",
        message: `the sentence frame "${entry.key.replace(/•/g, "___")}" is used in ${entry.lines} lines (budget ${budgets.frameAllowance} for ${totalWords} words)`,
        occurrences: entry.lines,
        penalty,
        measure: entry.lines,
        allowance: budgets.frameAllowance,
        evidence: dedupeByLine(entry.uses).slice(0, 8).map(evidenceOf),
      });
    }
  }

  // =========================================================================
  // 6. PHRASE / CONCEPT BUDGETS
  // =========================================================================
  {
    let spent = 0;
    // NOTE: no distinctiveness filter here. The budget IS the test — a lemma
    // that recurs this often is by definition not incidental, and gating on
    // rarity would exclude exactly the words being hammered.
    const overBudget = [...lemmaCounts.entries()]
      .filter(([, count]) => count > budgets.lemmaAllowance)
      .map(([stem, count]) => ({ stem, count, per1000: (count * 1000) / Math.max(1, totalWords) }))
      .sort((a, b) => b.count - a.count);
    for (const entry of overBudget) {
      if (spent >= CATEGORY_CAPS.phrase_budget) break;
      const overrun = entry.count / budgets.lemmaAllowance;
      const raw = Math.min(7, 2 + 4 * (overrun - 1));
      const penalty = Math.min(raw, CATEGORY_CAPS.phrase_budget - spent);
      spent += penalty;
      const uses = sentences.filter((s) => s.stemSet.has(entry.stem));
      findings.push({
        category: "phrase_budget",
        severity: overrun >= 2 ? "high" : overrun >= 1.4 ? "medium" : "low",
        message: `"${entry.stem}" appears ${entry.count} times (${entry.per1000.toFixed(1)} per 1000 words; budget ${budgets.lemmaAllowance} = ${lemmaPer1000}/1000)`,
        occurrences: entry.count,
        penalty: Number(penalty.toFixed(2)),
        measure: Number(entry.per1000.toFixed(2)),
        allowance: budgets.lemmaAllowance,
        evidence: dedupeByLine(uses).slice(0, 8).map(evidenceOf),
      });
    }

    // content-word n-gram budget (catchphrases)
    const phraseUses = new Map<string, SentenceUnit[]>();
    for (const sentence of sentences) {
      const stems = sentence.contentStems;
      for (let n = 2; n <= 3; n++) {
        for (let i = 0; i + n <= stems.length; i++) {
          const key = stems.slice(i, i + n).join(" ");
          const bucket = phraseUses.get(key) ?? [];
          if (!bucket.some((u) => u.id === sentence.id)) bucket.push(sentence);
          phraseUses.set(key, bucket);
        }
      }
    }
    const overusedPhrases = [...phraseUses.entries()]
      .map(([key, uses]) => ({ key, lines: new Set(uses.map((u) => u.lineIndex)).size, uses }))
      .filter((entry) => entry.lines > budgets.phraseAllowance)
      .sort((a, b) => b.lines - a.lines || b.key.length - a.key.length);
    const claimedPhraseLines = new Set<string>();
    for (const entry of overusedPhrases) {
      if (spent >= CATEGORY_CAPS.phrase_budget) break;
      const signature = [...new Set(entry.uses.map((u) => u.lineIndex))].sort((a, b) => a - b).join(",");
      if (claimedPhraseLines.has(signature)) continue;
      claimedPhraseLines.add(signature);
      const raw = Math.min(6, 2 + 2 * (entry.lines - budgets.phraseAllowance));
      const penalty = Math.min(raw, CATEGORY_CAPS.phrase_budget - spent);
      spent += penalty;
      findings.push({
        category: "phrase_budget",
        severity: entry.lines >= budgets.phraseAllowance * 2 ? "high" : "medium",
        message: `the phrase "${entry.key}" recurs in ${entry.lines} lines (budget ${budgets.phraseAllowance} for ${totalWords} words)`,
        occurrences: entry.lines,
        penalty: Number(penalty.toFixed(2)),
        measure: entry.lines,
        allowance: budgets.phraseAllowance,
        evidence: dedupeByLine(entry.uses).slice(0, 6).map(evidenceOf),
      });
    }
  }

  // =========================================================================
  // 7. SEGMENT RECAPS THAT ADD NOTHING NEW
  // =========================================================================
  const noveltyBySegment: Array<{ segmentIndex: number; title?: string; noveltyRatio: number; words: number }> = [];
  {
    const seen = new Set<string>();
    let spent = 0;
    for (const meta of segmentMeta) {
      // Novelty is measured over ALL content lemmas the segment spends words
      // on — a segment can be full of rare-ish words and still be a recap if
      // every one of them was already said.
      const distinctive = new Set<string>();
      let contentTokensHere = 0;
      let novelTokens = 0;
      for (const id of meta.sentenceIds) {
        for (const stem of sentences[id].stemSet) distinctive.add(stem);
        for (const stem of sentences[id].contentStems) {
          contentTokensHere++;
          if (!seen.has(stem)) novelTokens++;
        }
      }
      let novel = 0;
      for (const stem of distinctive) if (!seen.has(stem)) novel++;
      const typeNovelty = distinctive.size > 0 ? novel / distinctive.size : 1;
      const tokenNovelty = contentTokensHere > 0 ? novelTokens / contentTokensHere : 1;
      const noveltyRatio = Math.min(typeNovelty, tokenNovelty);
      noveltyBySegment.push({ segmentIndex: meta.index, title: meta.title, noveltyRatio: Number(noveltyRatio.toFixed(3)), words: meta.words });

      const recapMarkers = meta.sentenceIds.filter((id) => sentences[id].hasRecapMarker).length;
      if (meta.index > 0 && meta.words >= 40 && distinctive.size >= 5 && (noveltyRatio < 0.4 || (noveltyRatio < 0.55 && recapMarkers >= 1))) {
        const raw = 6 + (noveltyRatio < 0.25 ? 3 : 0);
        const penalty = Math.min(raw, Math.max(0, CATEGORY_CAPS.segment_recap - spent));
        spent += penalty;
        if (penalty > 0) {
          findings.push({
            category: "segment_recap",
            severity: noveltyRatio < 0.25 ? "high" : "medium",
            message: `segment ${meta.index + 1}${meta.title ? ` ("${meta.title}")` : ""} recaps earlier material: only ${(noveltyRatio * 100).toFixed(0)}% of its distinctive vocabulary is new`,
            occurrences: meta.sentenceIds.length,
            penalty,
            measure: noveltyRatio,
            allowance: 0.4,
            evidence: meta.sentenceIds.slice(0, 4).map((id) => evidenceOf(sentences[id])),
          });
        }
      }
      for (const stem of distinctive) seen.add(stem);
    }
  }

  // =========================================================================
  // 8. TWO DIFFERENT TOPICS ARGUING THE SAME UNDERLYING PROPOSITION
  // =========================================================================
  {
    const profiles = segmentMeta.map((meta) => {
      const frameVector = new Map<string, number>();
      const stems = new Set<string>();
      for (const id of meta.sentenceIds) {
        for (const [frame, count] of sentences[id].frames) {
          frameVector.set(frame, (frameVector.get(frame) || 0) + count * (FRAME_WEIGHT.get(frame) ?? 0.5));
        }
        for (const stem of sentences[id].stemSet) if (isDistinctive(stem)) stems.add(stem);
      }
      return { meta, frameVector, stems };
    });
    let spent = 0;
    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        if (spent >= CATEGORY_CAPS.duplicate_thesis) break;
        const left = profiles[i];
        const right = profiles[j];
        if (left.meta.topicKey === right.meta.topicKey) continue;
        if (left.meta.sentenceIds.length < 3 || right.meta.sentenceIds.length < 3) continue;
        const entityOverlap = jaccard(left.stems, right.stems);
        // "different topics" = the subject matter does not overlap much...
        if (entityOverlap > 0.34) continue;
        const thesisCosine = cosineVectors(left.frameVector, right.frameVector);
        const crossMatches = matches.filter(
          (m) =>
            (m.a.segmentIndex === left.meta.index && m.b.segmentIndex === right.meta.index) ||
            (m.a.segmentIndex === right.meta.index && m.b.segmentIndex === left.meta.index),
        );
        // ...while the argument being made is the same.
        if (!(thesisCosine >= 0.82 && crossMatches.length >= 1) && crossMatches.length < 2) continue;
        const raw = 7;
        const penalty = Math.min(raw, CATEGORY_CAPS.duplicate_thesis - spent);
        spent += penalty;
        const sample = crossMatches[0];
        findings.push({
          category: "duplicate_thesis",
          severity: crossMatches.length >= 2 ? "high" : "medium",
          message:
            `segments ${left.meta.index + 1}${left.meta.title ? ` ("${left.meta.title}")` : ""} and ${right.meta.index + 1}${right.meta.title ? ` ("${right.meta.title}")` : ""} cover different subjects ` +
            `(entity overlap ${entityOverlap.toFixed(2)}) but argue the same underlying proposition (thesis similarity ${thesisCosine.toFixed(2)}, ${crossMatches.length} matching claim pair(s))`,
          occurrences: crossMatches.length,
          penalty,
          measure: Number(thesisCosine.toFixed(3)),
          allowance: 0.82,
          evidence: sample ? [evidenceOf(sample.a), evidenceOf(sample.b)] : [],
        });
      }
    }
  }

  // ---- score -------------------------------------------------------------
  const penaltyByCategory = emptyCounts();
  const findingsByCategory = emptyCounts();
  for (const finding of findings) {
    penaltyByCategory[finding.category] += finding.penalty;
    findingsByCategory[finding.category] += 1;
  }
  let totalPenalty = 0;
  for (const category of ALL_CATEGORIES) {
    penaltyByCategory[category] = Number(Math.min(penaltyByCategory[category], CATEGORY_CAPS[category]).toFixed(2));
    totalPenalty += penaltyByCategory[category];
  }
  const repetitionScore = Math.max(0, Math.min(100, Math.round(100 - totalPenalty)));

  findings.sort((a, b) => b.penalty - a.penalty || a.category.localeCompare(b.category));

  const report: SemanticRepetitionReport = {
    repetitionScore,
    passed: repetitionScore >= threshold,
    threshold,
    totals,
    budgets,
    findings,
    categoriesTriggered: ALL_CATEGORIES.filter((category) => findingsByCategory[category] > 0),
    findingsByCategory,
    penaltyByCategory,
  };

  if (opts.diagnostics) {
    report.diagnostics = {
      topClaimPairs: allPairs
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 8)
        .map((m) => ({
          a: m.a.lineIndex,
          b: m.b.lineIndex,
          similarity: Number(m.similarity.toFixed(3)),
          lexical: Number(m.lexical.toFixed(3)),
          conceptual: Number(m.conceptual.toFixed(3)),
          aText: truncate(m.a.text, 70),
          bText: truncate(m.b.text, 70),
        })),
      topLemmas: [...lemmaCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([lemma, count]) => ({ lemma, count, per1000: Number(((count * 1000) / Math.max(1, totalWords)).toFixed(2)) })),
      segmentNovelty: noveltyBySegment,
    };
  }

  return report;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function emptyCounts(): Record<SemanticRepetitionCategory, number> {
  return {
    repeated_claim: 0,
    repeated_evidence: 0,
    repeated_metaphor: 0,
    repeated_conclusion: 0,
    repeated_frame: 0,
    phrase_budget: 0,
    segment_recap: 0,
    duplicate_thesis: 0,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function dedupeByLine(units: SentenceUnit[]): SentenceUnit[] {
  const seen = new Set<number>();
  const out: SentenceUnit[] = [];
  for (const unit of units) {
    if (seen.has(unit.lineIndex)) continue;
    seen.add(unit.lineIndex);
    out.push(unit);
  }
  return out;
}

function cosineVectors(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [, value] of a) normA += value * value;
  for (const [key, value] of b) {
    normB += value * value;
    const other = a.get(key);
    if (other) dot += other * value;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function groupPairs(pairs: ClaimMatch[]): Array<{ ids: number[]; best: number }> {
  if (pairs.length === 0) return [];
  const ids = [...new Set(pairs.flatMap((p) => [p.a.id, p.b.id]))].sort((a, b) => a - b);
  const index = new Map(ids.map((id, position) => [id, position]));
  const dsu = new DisjointSet(ids.length);
  for (const pair of pairs) dsu.union(index.get(pair.a.id)!, index.get(pair.b.id)!);
  const groups = new Map<number, number[]>();
  for (const id of ids) {
    const root = dsu.find(index.get(id)!);
    const bucket = groups.get(root) ?? [];
    bucket.push(id);
    groups.set(root, bucket);
  }
  return [...groups.values()]
    .filter((group) => group.length >= 2)
    .map((group) => ({
      ids: group,
      best: Math.max(...pairs.filter((p) => group.includes(p.a.id) && group.includes(p.b.id)).map((p) => p.similarity)),
    }))
    .sort((a, b) => b.ids.length - a.ids.length);
}

/**
 * Pull the "vehicle" out of a comparison — the thing the subject is being
 * likened to. Purely structural: it looks for comparison markers and takes
 * the distinctive content stems that follow them.
 */
function extractMetaphorVehicles(sentence: SentenceUnit): string[] {
  const vehicles: string[] = [];
  const text = sentence.normalized;
  const marker = new RegExp(METAPHOR_MARKERS.source, "g");
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) {
    const tail = text.slice(match.index + match[0].length);
    const tailTokens = tokenize(tail).slice(0, 4);
    for (const token of tailTokens) {
      if (!isContentToken(token)) continue;
      const stem = stemWord(token);
      if (stem.length < 3) continue;
      if (!vehicles.includes(stem)) vehicles.push(stem);
      break; // head noun of the vehicle phrase only
    }
    if (marker.lastIndex <= match.index) marker.lastIndex = match.index + 1;
  }
  return vehicles;
}
