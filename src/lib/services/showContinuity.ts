// The continuity engine — what turns a hundred disconnected episodes into a
// season.
//
// Design rule, from which everything here follows: THE MODEL NEVER INVENTS A
// CONTINUITY VALUE. It selects from state and reports what it used; this module
// computes the next state. A generator that could author its own continuity
// would drift, contradict itself, and re-reveal beats the audience has already
// heard — which is exactly the failure the engine exists to prevent.
//
// WHAT CHANGED, AND WHY IT MATTERS
//
// The previous engine REQUIRED a fixed set of comedy devices in every single
// episode — an inflated crowd figure, a pronoun correction, a name-drop, a
// teammate from a fixed bank. That is a checklist, and it produces episodes
// that sound assembled rather than lived. Worse, it made the show's memory a
// scoreboard: the state existed to count gags, so the only thing that could
// carry across episodes was a gag.
//
// This engine has NO mandatory device. Every device below is OPTIONAL and
// EARNED, and at most ONE carries real weight in a normal episode. A strong
// standalone episode uses none, and that is a legitimate outcome the prompt
// says out loud rather than a failure the guards punish.
//
// Four devices, each with a different update rule:
//
//   LADDER   The Red Eye File. One-shot layers, monotonic, TERMINATES, and
//            additionally GATED ON TOPIC — a layer is ineligible unless the
//            episode is genuinely about scapegoating, leaks, or institutional
//            self-protection. Nothing here generates a new layer; an exhausted
//            file is a signal to a human, not a prompt to improvise.
//   LOG      The Language Ledger. Append-only record of the institutional
//            phrases Cal reached for, plus whether he later rejected or revised
//            one. Evidence of how he hides, and whether he is changing.
//   LOG      Position Memory. What each host actually argued, so a callback can
//            be checked for relevance instead of asserted.
//   STATE    Relationship movement. Compact, non-numeric in the prompt, used to
//            steer writing rather than to score a game.
//
// RATE LIMIT rolling windows over episode indices keep every device scarce.
// Stored as the indices where each fired, so scarcity holds forever with no
// season boundary and no reset job.
//
// There is no season concept anywhere in this file. See the ShowContinuity
// model comment for why.

import type { ShowContinuity } from "@prisma/client";

// ---------------------------------------------------------------------------
// Authored content. These are FIXED lists. Nothing at runtime appends to them.
// ---------------------------------------------------------------------------

/**
 * THE RED EYE FILE — LADDER. Each layer fires at most once. Index === redEyeStage.
 *
 * Cal's one unresolved career decision: he helped an organization turn its own
 * failed decision into a story about a player's character.
 *
 * HARD BOUNDARY, enforced in the prompt and restated at every call site: this
 * history is FICTIONAL and COMPOSITE. It is never attached to a real player, a
 * real team, or a real event, it is never offered as evidence about a current
 * story, and it never implies Cal has private knowledge about a real person.
 * It exists to give the character stakes, guilt, and somewhere to move — not to
 * manufacture reporting.
 */
export const RED_EYE_LAYERS = [
  "He lets slip that he has been on the wrong side of a story shaped like this one. No detail. He changes the subject and she lets him.",
  "He names his position in it for the first time: he was in the room when the language was chosen, and he was not the one who chose it — but he was there.",
  "He admits the decision that failed was not the player's decision. It was the building's, and it had already failed before anyone said a word about attitude.",
  "He admits he helped write the sentence. Not the whole story — one clause, the one that made it about the player.",
  "He admits the part he has never said out loud: it worked, and he was relieved.",
  "He says what stopping it would have cost him, and that he was not willing to pay it. This is the layer where he stops framing it as a mistake.",
  "He says what happened to the person afterward, and admits he never once checked. No absolution follows. She does not offer one.",
] as const;
export const RED_EYE_LADDER_END = RED_EYE_LAYERS.length - 1;

/**
 * TOPIC GATE for the Red Eye File. A layer is only eligible when the episode is
 * genuinely about how an institution protected itself — scapegoating, leaks,
 * public narratives, firings framed as character.
 *
 * This gate is the difference between continuity and a tic. Without it the
 * ladder advances on schedule and the confession arrives on top of a story it
 * has nothing to do with, which is exactly how a character becomes a bit.
 */
const RED_EYE_TOPIC_PATTERNS: ReadonlyArray<RegExp> = [
  /\bscapegoat|\bblame|\bblamed\b|\bfall guy\b/i,
  /\battitude|\bcharacter (concerns?|issues?)|\bcoachab|\bbuy[- ]in\b|\blocker[- ]room\b|\bculture\b/i,
  /\bleak(ed|s)?\b|\banonymous\b|\bunnamed\b|\bsources? (said|say|told|tell)\b|\breport(ed|edly)?\b/i,
  /\bfired|\bfiring\b|\bdismiss|\brelieved of\b|\bstepped down\b|\bousted?\b|\bmutual(ly)? (parting|agreement)\b/i,
  /\bbenched?\b|\bhealthy scratch\b|\bwaived\b|\breleased\b|\bcut\b|\bdemot/i,
  /\bstatement\b|\bpress conference\b|\bspokes(man|woman|person)\b|\bpublic relations\b|\bnarrative\b|\bspin\b/i,
  /\bfront office\b|\borganizations?\b|\bownership\b|\binternal\b|\baccountab/i,
  /\btrade request\b|\bdisgruntl|\bdistraction\b|\binsubordinat/i,
];

/** True when the supplied topic material genuinely touches the Red Eye themes. */
export function redEyeTopicEligible(topicText: string | null | undefined): boolean {
  const text = (topicText ?? "").trim();
  if (!text) return false;
  return RED_EYE_TOPIC_PATTERNS.some((re) => re.test(text));
}

/**
 * Institutional phrases worth recording when Cal reaches for one. NOT a banned
 * list and NOT a required list — it is the vocabulary the Language Ledger
 * recognises, so the ledger stays about how he hides rather than becoming a
 * catch-all for anything he says twice.
 */
export const LEDGER_PHRASES = [
  "culture fit",
  "communication issue",
  "football decision",
  "basketball decision",
  "baseball decision",
  "the room had concerns",
  "everybody signed off",
  "a difference in philosophy",
  "not a fit",
  "we moved in a different direction",
  "a distraction",
  "handled internally",
  "a business decision",
  "the timing wasn't right",
] as const;

/** RATE LIMITS. `max` firings within the last `window` episodes. */
export const RATE_LIMITS = {
  /** A Red Eye layer is the heaviest thing the show can spend. Keep it rare. */
  redEyeLayer: { max: 1, window: 4, label: "A Red Eye File layer" },
  /** Zabala pulling a phrase back out of the ledger. */
  languageRecall: { max: 1, window: 3, label: "Zabala recalling a phrase from the Language Ledger" },
  /** A prior-episode position brought back into the argument. */
  positionCallback: { max: 1, window: 3, label: "A prior-episode position recalled" },
} as const;

export type RateLimitKey = keyof typeof RATE_LIMITS;

/** Which ContinuityState field stores each device's firing log. */
const RATE_LIMIT_FIELD = {
  redEyeLayer: "redEyeFirings",
  languageRecall: "languageRecallFirings",
  positionCallback: "positionCallbackFirings",
} as const satisfies Record<RateLimitKey, string>;

// ---------------------------------------------------------------------------
// Stored JSON shapes. Validated on read; a malformed entry is dropped, never
// guessed at.
// ---------------------------------------------------------------------------

/** One institutional phrase Cal used, and what became of it. */
export interface LedgerEntry {
  phrase: string;
  episodeIndex: number;
  /** What he was covering when he said it. One clause, not a paragraph. */
  context: string;
  /** "used" until he later takes it back. */
  status: "used" | "rejected" | "revised";
}

/** A position a host actually argued, so a callback can be checked. */
export interface PositionEntry {
  host: "cal" | "zabala";
  episodeIndex: number;
  /** Normalized subject tokens — what the position was ABOUT. */
  topicKey: string;
  /** One sentence, in the host's own terms. */
  position: string;
}

export interface RelationshipState {
  /** -5..5. Guides writing. NEVER rendered as a number in the prompt. */
  trust: number;
  calDisclosures: number;
  calRationalizations: number;
  zabalaOverreaches: number;
  positionChanges: number;
  /** The interpersonal thread still hanging, if any. */
  openThread: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers — no database, unit-testable.
// ---------------------------------------------------------------------------

/** A continuity row's shape without requiring a real Prisma row (tests). */
export type ContinuityState = Pick<
  ShowContinuity,
  | "episodeCount"
  | "redEyeStage"
  | "redEyeDisclosures"
  | "redEyeFirings"
  | "languageRecallFirings"
  | "positionCallbackFirings"
  | "trustLevel"
  | "calDisclosureCount"
  | "calRationalizationCount"
  | "zabalaOverreachCount"
  | "positionChangeCount"
  | "openThread"
> & {
  /** Stored as JSON; always read through `readLedger` / `readPositions`. */
  languageLedger: unknown;
  positionMemory: unknown;
};

export const EMPTY_CONTINUITY: ContinuityState = {
  episodeCount: 0,
  redEyeStage: 0,
  redEyeDisclosures: [],
  redEyeFirings: [],
  languageLedger: [],
  languageRecallFirings: [],
  positionMemory: [],
  positionCallbackFirings: [],
  trustLevel: 0,
  calDisclosureCount: 0,
  calRationalizationCount: 0,
  zabalaOverreachCount: 0,
  positionChangeCount: 0,
  openThread: null,
};

const LEDGER_STATUSES = new Set(["used", "rejected", "revised"]);

/** Read the stored ledger, dropping anything that no longer has the shape. */
export function readLedger(stored: unknown): LedgerEntry[] {
  if (!Array.isArray(stored)) return [];
  const out: LedgerEntry[] = [];
  for (const raw of stored) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.phrase !== "string" || !e.phrase.trim()) continue;
    if (typeof e.episodeIndex !== "number" || !Number.isFinite(e.episodeIndex)) continue;
    out.push({
      phrase: e.phrase.trim(),
      episodeIndex: Math.max(0, Math.trunc(e.episodeIndex)),
      context: typeof e.context === "string" ? e.context.slice(0, 200) : "",
      status: LEDGER_STATUSES.has(String(e.status)) ? (e.status as LedgerEntry["status"]) : "used",
    });
  }
  return out;
}

/** Read stored position memory, dropping anything that no longer has the shape. */
export function readPositions(stored: unknown): PositionEntry[] {
  if (!Array.isArray(stored)) return [];
  const out: PositionEntry[] = [];
  for (const raw of stored) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (e.host !== "cal" && e.host !== "zabala") continue;
    if (typeof e.position !== "string" || !e.position.trim()) continue;
    if (typeof e.episodeIndex !== "number" || !Number.isFinite(e.episodeIndex)) continue;
    out.push({
      host: e.host,
      episodeIndex: Math.max(0, Math.trunc(e.episodeIndex)),
      topicKey: typeof e.topicKey === "string" ? normalizeTopicKey(e.topicKey) : "",
      position: e.position.trim().slice(0, 240),
    });
  }
  return out;
}

export function readRelationship(state: ContinuityState): RelationshipState {
  return {
    trust: state.trustLevel,
    calDisclosures: state.calDisclosureCount,
    calRationalizations: state.calRationalizationCount,
    zabalaOverreaches: state.zabalaOverreachCount,
    positionChanges: state.positionChangeCount,
    openThread: state.openThread,
  };
}

/** Lowercase content tokens, stopwords removed. The unit relevance is measured in. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "for", "to", "in", "on", "at", "by", "with", "from",
  "is", "was", "were", "are", "be", "been", "it", "its", "this", "that", "these", "those", "as",
  "his", "her", "their", "they", "he", "she", "you", "we", "not", "has", "have", "had", "about",
  "after", "before", "over", "into", "out", "up", "down", "than", "then", "so", "if", "what", "who",
]);

export function normalizeTopicKey(text: string): string {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    ),
  ]
    .sort()
    .join(" ");
}

/** Token overlap between a stored topicKey and the current episode's material. */
export function topicOverlap(storedKey: string, currentText: string): number {
  const A = new Set(storedKey.split(" ").filter(Boolean));
  const B = new Set(normalizeTopicKey(currentText).split(" ").filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / A.size;
}

/** A prior position is recallable only when the current topic genuinely relates. */
export const POSITION_RELEVANCE_THRESHOLD = 0.34;

/**
 * RATE LIMIT check. True when the device may fire on the episode about to be
 * generated (index = state.episodeCount, 0-based).
 *
 * The window is measured from the UPCOMING episode's index, so a firing at
 * index 0 with window 4 blocks again until index 4 — scarcity that holds
 * forever with no boundary and no reset job.
 */
export function rateLimitAllows(state: ContinuityState, key: RateLimitKey): boolean {
  const { max, window } = RATE_LIMITS[key];
  const firings = state[RATE_LIMIT_FIELD[key]] ?? [];
  const upcoming = state.episodeCount;
  const recent = firings.filter((i) => i > upcoming - window);
  return recent.length < max;
}

/** Episodes remaining until a maxed-out rate-limited device is available. */
export function rateLimitCooldown(state: ContinuityState, key: RateLimitKey): number {
  if (rateLimitAllows(state, key)) return 0;
  const { window } = RATE_LIMITS[key];
  const firings = [...(state[RATE_LIMIT_FIELD[key]] ?? [])].sort((a, b) => a - b);
  const recent = firings.filter((i) => i > state.episodeCount - window);
  // Available once the OLDEST blocking firing falls out of the window.
  return Math.max(0, recent[0] + window - state.episodeCount);
}

/** LADDER exhaustion. An exhausted file is reported, never improvised past. */
export interface LadderStatus {
  key: "redEye";
  current: number;
  end: number;
  exhausted: boolean;
  /** The layer text for the CURRENT rung, or null once exhausted. */
  layer: string | null;
}

export function redEyeStatus(state: ContinuityState): LadderStatus {
  return {
    key: "redEye",
    current: state.redEyeStage,
    end: RED_EYE_LADDER_END,
    exhausted: state.redEyeStage > RED_EYE_LADDER_END,
    layer: state.redEyeStage <= RED_EYE_LADDER_END ? RED_EYE_LAYERS[state.redEyeStage] : null,
  };
}

// ---------------------------------------------------------------------------
// The optional-devices list handed to the generator.
// ---------------------------------------------------------------------------

/** Per-episode facts the state itself cannot know. */
export interface ContinuityContext {
  /** Topic titles + summaries for THIS episode; drives every relevance gate. */
  topicText: string;
}

export const EMPTY_CONTEXT: ContinuityContext = { topicText: "" };

/**
 * Which device — if any — carries real weight this episode. Exactly zero or one.
 * The show is allowed to be about nothing but the story in front of it.
 */
export type FeaturedDevice = "redEye" | "languageRecall" | "positionCallback" | "none";

export interface ContinuityOpportunities {
  episodeIndex: number;
  /** Zero or one device carries weight. Never more. */
  featured: FeaturedDevice;
  redEye: {
    /** Eligible = topic-relevant AND off cooldown AND ladder not spent. */
    eligible: boolean;
    /** Why not, when it is not. Rendered so a reader can audit the decision. */
    blockedBy: "topic" | "cooldown" | "exhausted" | null;
    stage: number;
    layer: string | null;
    /** Every layer already revealed. These must never be re-confessed. */
    alreadyDisclosed: string[];
    cooldownEpisodes: number;
  };
  languageLedger: {
    /** Everything on record, newest last. */
    entries: LedgerEntry[];
    /** Recall is allowed at all (off cooldown and something to recall). */
    recallAvailable: boolean;
    /** Entries whose subject genuinely relates to this episode. */
    relevant: LedgerEntry[];
    cooldownEpisodes: number;
  };
  positions: {
    /** Prior positions whose subject genuinely relates to this episode. */
    relevant: PositionEntry[];
    callbackAvailable: boolean;
    cooldownEpisodes: number;
  };
  relationship: RelationshipState;
  /** True when the Red Eye ladder is spent — a human authors more, or it is over. */
  redEyeExhausted: boolean;
}

export function continuityOpportunities(
  state: ContinuityState,
  ctx: ContinuityContext = EMPTY_CONTEXT
): ContinuityOpportunities {
  const redEye = redEyeStatus(state);
  const topicOk = redEyeTopicEligible(ctx.topicText);
  const redEyeCooldown = rateLimitCooldown(state, "redEyeLayer");
  const redEyeEligible = !redEye.exhausted && topicOk && redEyeCooldown === 0;
  const redEyeBlockedBy: ContinuityOpportunities["redEye"]["blockedBy"] = redEye.exhausted
    ? "exhausted"
    : !topicOk
      ? "topic"
      : redEyeCooldown > 0
        ? "cooldown"
        : null;

  const ledger = readLedger(state.languageLedger);
  const ledgerCooldown = rateLimitCooldown(state, "languageRecall");
  const relevantLedger = ctx.topicText
    ? ledger.filter((e) => topicOverlap(normalizeTopicKey(e.context || e.phrase), ctx.topicText) >= POSITION_RELEVANCE_THRESHOLD)
    : [];
  const recallAvailable = ledgerCooldown === 0 && relevantLedger.length > 0;

  const positions = readPositions(state.positionMemory);
  const positionCooldown = rateLimitCooldown(state, "positionCallback");
  const relevantPositions = ctx.topicText
    ? positions.filter((p) => topicOverlap(p.topicKey, ctx.topicText) >= POSITION_RELEVANCE_THRESHOLD)
    : [];
  const callbackAvailable = positionCooldown === 0 && relevantPositions.length > 0;

  // AT MOST ONE device carries weight, in descending order of what it costs the
  // show to spend. Everything not featured is still visible to the writer as
  // context, but the prompt will not ask for it.
  const featured: FeaturedDevice = redEyeEligible
    ? "redEye"
    : recallAvailable
      ? "languageRecall"
      : callbackAvailable
        ? "positionCallback"
        : "none";

  return {
    episodeIndex: state.episodeCount,
    featured,
    redEye: {
      eligible: redEyeEligible,
      blockedBy: redEyeBlockedBy,
      stage: state.redEyeStage,
      layer: redEye.layer,
      alreadyDisclosed: [...state.redEyeDisclosures],
      cooldownEpisodes: redEyeCooldown,
    },
    languageLedger: {
      entries: ledger,
      recallAvailable,
      relevant: relevantLedger,
      cooldownEpisodes: ledgerCooldown,
    },
    positions: {
      relevant: relevantPositions,
      callbackAvailable,
      cooldownEpisodes: positionCooldown,
    },
    relationship: readRelationship(state),
    redEyeExhausted: redEye.exhausted,
  };
}

// ---------------------------------------------------------------------------
// Relationship state, rendered as PROSE.
// ---------------------------------------------------------------------------

/**
 * Turn the relationship counters into a sentence a writer can act on.
 *
 * Deliberately never emits a number. A visible score turns the show into a game
 * mechanic — the model starts writing toward the meter, and the audience hears
 * it. The state steers; it does not appear.
 */
export function describeRelationship(r: RelationshipState): string {
  const parts: string[] = [];
  if (r.trust >= 3) parts.push("She has started treating him as someone who tells her the truth, and that is new for both of them");
  else if (r.trust >= 1) parts.push("There is more trust between them than there was, and neither has acknowledged it");
  else if (r.trust <= -3) parts.push("She does not believe him right now, and he knows it");
  else if (r.trust <= -1) parts.push("Something is off between them; she is listening for the dodge before he speaks");
  else parts.push("They are cordial professionals who have not yet decided how much to trust each other");

  if (r.calRationalizations > r.calDisclosures + 1) {
    parts.push("he has been hiding behind process language more often than he has been honest, and she has noticed");
  } else if (r.calDisclosures > r.calRationalizations) {
    parts.push("he has given up more than he meant to lately, and he is aware of it");
  }
  if (r.zabalaOverreaches >= 2) parts.push("she has overshot at least twice and has not fully squared that");
  if (r.positionChanges >= 1) parts.push("one of them has genuinely moved the other before, so neither treats this as theatre");
  return parts.join(". ") + ".";
}
