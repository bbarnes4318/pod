// The versioned show-format registry (Prompt 7 — COMPLETE ten-format catalog).
//
// A show format declares HOW MANY voices an episode has (1-4), WHAT ROLE each
// chair plays, per-chair balance floors, and structural line rules the script
// validator enforces. `two_host_debate` — once the hardcoded architecture —
// is simply one of ten registered formats.
//
// Client-safe: no Node imports, no database. Formats ship with the app and
// are versioned here, so an Episode snapshot records exactly
// (formatId, formatVersion) it was built with.
//
// ALIASES: the engine's first release shipped `solo_briefing` and
// `roundtable`. Those ids are now DEPRECATED COMPATIBILITY ALIASES for the
// canonical `solo_commentary` and `three_person_panel`: historical Episodes,
// snapshots, and configurations that reference them keep resolving (lookup
// maps alias -> canonical definition), but they never appear in new-format
// selectors and new records always store the canonical id. Historical
// snapshots are NEVER rewritten — a stored alias id stays byte-stable.

export const SHOW_FORMAT_REGISTRY_VERSION = 2;

export const PLATFORM_MIN_SPEAKERS = 1;
export const PLATFORM_MAX_SPEAKERS = 4;

export interface ShowFormatRole {
  /** Stable role id, recorded on cast members and snapshots. */
  id: string;
  name: string;
  /** What the script engine should do with this chair. */
  direction: string;
  /** Required roles must be filled before generation; optional chairs may be
   *  left empty when the cast is smaller than speakerMax. */
  required: boolean;
  /** Approval-time minimum line share (percent) for this chair. The script
   *  GENERATION gate uses 0.8x this floor (the debate's historical 25%/20%
   *  pair). 0 = no floor (solo anchor, optional chairs). */
  minLineSharePct: number;
}

/** Structural line rules the script validator enforces per format. */
export interface ShowFormatLineRules {
  /** Hard cap on words per spoken line (rapid-fire answers). */
  maxWordsPerLine?: number;
  /** The role that must speak the episode's FIRST line. */
  openingRole?: string;
  /** The role that must speak the episode's LAST line. */
  closingRole?: string;
  /** Seat whose line share must EXCEED seat 0's (host_and_expert: the expert
   *  carries more than the host). Value = seat index. */
  mustOutweighSeatZero?: number;
}

export interface ShowFormat {
  id: string;
  /** Bumped when a format's roles/semantics change; frozen into snapshots. */
  version: number;
  displayName: string;
  description: string;
  /** UI card: typical pacing. */
  pacing: string;
  /** UI card: when to pick this format. */
  useCase: string;
  speakerMin: number;
  speakerMax: number;
  /** Ordered chairs; index = seat order (also drives stereo seating + colors). */
  roles: ShowFormatRole[];
  /** Structural validation rules (empty object = none). */
  lineRules: ShowFormatLineRules;
  /** True once EVERY pipeline stage can produce this format. */
  generationReady: boolean;
}

const FORMATS: ShowFormat[] = [
  {
    id: "solo_commentary",
    version: 2,
    displayName: "Solo commentary",
    description: "One host delivers a direct, tightly-paced take straight to the listener.",
    pacing: "Direct address, varied energy, self-interruptions instead of dialogue.",
    useCase: "Daily takes, briefings, one-voice shows.",
    speakerMin: 1,
    speakerMax: 1,
    roles: [
      { id: "anchor", name: "Anchor", direction: "Carries the whole episode alone; addresses the listener directly.", required: true, minLineSharePct: 0 },
    ],
    lineRules: {},
    generationReady: true,
  },
  {
    id: "two_host_debate",
    version: 1,
    displayName: "Two-host debate",
    description: "Two colliding personas argue the rundown — the higher-intensity chair drives, the analytical chair counters.",
    pacing: "Fast clashes, interruptions, escalation from either chair.",
    useCase: "Hot-take sports debate; the classic show.",
    speakerMin: 2,
    speakerMax: 2,
    roles: [
      { id: "chair_a", name: "Chair A", direction: "Higher-intensity, emotional drive; opens segments and pushes the take.", required: true, minLineSharePct: 25 },
      { id: "chair_b", name: "Chair B", direction: "Analytical counterweight; challenges with evidence and reframes.", required: true, minLineSharePct: 25 },
    ],
    lineRules: {},
    generationReady: true,
  },
  {
    id: "sports_radio",
    version: 1,
    displayName: "Sports radio",
    description: "A lead host and co-host run a conversational sports-radio hour; an optional update chair drops factual resets and headlines.",
    pacing: "Loose, quick reactions, topic teases, strong transitions — not every topic becomes a debate.",
    useCase: "Recurring daily shows with a radio feel.",
    speakerMin: 2,
    speakerMax: 3,
    roles: [
      { id: "lead_host", name: "Lead host", direction: "Drives the show: teases topics, sets pace, hands off. Conversational, not adversarial by default.", required: true, minLineSharePct: 20 },
      { id: "co_host", name: "Co-host", direction: "Rides along: quick reactions, color, short natural interruptions; agrees as often as argues.", required: true, minLineSharePct: 15 },
      { id: "producer_or_update_host", name: "Update host", direction: "Occasional factual resets and headline updates ONLY — grounded in evidence; never invents callers or off-mic events.", required: false, minLineSharePct: 0 },
    ],
    lineRules: {},
    generationReady: true,
  },
  {
    id: "news_roundup",
    version: 1,
    displayName: "News roundup",
    description: "An anchor moves through multiple concise stories headline-first; an optional analyst explains implications.",
    pacing: "Efficient story-by-story delivery with clean boundaries; no forced disagreement.",
    useCase: "Timely multi-story recaps ordered by importance.",
    speakerMin: 1,
    speakerMax: 2,
    roles: [
      { id: "news_anchor", name: "News anchor", direction: "Headline first, then the facts. Clean story transitions; keeps fact and analysis clearly separated.", required: true, minLineSharePct: 40 },
      { id: "analyst", name: "Analyst", direction: "Explains what a story MEANS — implications and context, never a re-read of the anchor's facts.", required: false, minLineSharePct: 10 },
    ],
    lineRules: { openingRole: "news_anchor", closingRole: "news_anchor" },
    generationReady: true,
  },
  {
    id: "host_and_expert",
    version: 1,
    displayName: "Host & expert",
    description: "A host asks grounded questions; a configured synthetic expert character explains in depth.",
    pacing: "Question, substantive answer, follow-up that responds to the answer.",
    useCase: "Explainers and deep dives on one subject.",
    speakerMin: 2,
    speakerMax: 2,
    roles: [
      { id: "host", name: "Host", direction: "Asks grounded questions and follow-ups that respond to the PREVIOUS answer; never 'great question' filler.", required: true, minLineSharePct: 15 },
      { id: "expert", name: "Expert", direction: "A SYNTHETIC show character: explains with evidence. Never claims real-world credentials, employment, attendance, or first-person experience.", required: true, minLineSharePct: 35 },
    ],
    lineRules: { openingRole: "host", mustOutweighSeatZero: 1 },
    generationReady: true,
  },
  {
    id: "three_person_panel",
    version: 2,
    displayName: "Three-person panel",
    description: "A moderator steers two panelists with distinguishable perspectives through positions, cross-examination, and final takeaways.",
    pacing: "Opening positions, challenge round, concise takeaway from all three.",
    useCase: "Structured multi-angle discussion.",
    speakerMin: 3,
    speakerMax: 3,
    roles: [
      { id: "moderator", name: "Moderator", direction: "Controls the discussion, frames and arbitrates; NEVER dominates the substance.", required: true, minLineSharePct: 10 },
      { id: "panelist_one", name: "Panelist 1", direction: "First perspective; opens each topic with a position and defends it directly against Panelist 2.", required: true, minLineSharePct: 15 },
      { id: "panelist_two", name: "Panelist 2", direction: "Counter-perspective; challenges Panelist 1 directly, not only via the moderator.", required: true, minLineSharePct: 15 },
    ],
    lineRules: { openingRole: "moderator", closingRole: "moderator" },
    generationReady: true,
  },
  {
    id: "interview",
    version: 1,
    displayName: "Interview",
    description: "A lead host drives questions; the featured guest chair carries the answers and stories.",
    pacing: "Short questions, long answers; pressing follow-ups.",
    useCase: "Character-led conversations.",
    speakerMin: 2,
    speakerMax: 2,
    roles: [
      { id: "interviewer", name: "Interviewer", direction: "Drives structure, asks and follows up; hands the floor to the guest.", required: true, minLineSharePct: 15 },
      { id: "guest", name: "Guest", direction: "Carries the substance; longer answers, personal angles.", required: true, minLineSharePct: 30 },
    ],
    lineRules: {},
    generationReady: true,
  },
  {
    id: "documentary",
    version: 1,
    displayName: "Documentary",
    description: "Narration-led chapters build an evidence-driven story to a thesis-resolving conclusion; optional voices add analysis or clearly-framed readings.",
    pacing: "Chapter architecture, turning points, measured delivery.",
    useCase: "Deep, structured storytelling on one arc.",
    speakerMin: 1,
    speakerMax: 4,
    roles: [
      { id: "narrator", name: "Narrator", direction: "Owns the spine: opens, closes, and carries the chronological/thematic chapters. Paraphrases are NEVER presented as quotes.", required: true, minLineSharePct: 30 },
      { id: "secondary_narrator", name: "Second narrator", direction: "Shares narration for texture; same evidence rules.", required: false, minLineSharePct: 0 },
      { id: "analyst", name: "Analyst", direction: "Steps in to interpret evidence at turning points.", required: false, minLineSharePct: 0 },
      { id: "character_voice", name: "Character voice", direction: "Reads VERIFIED excerpts or clearly synthetic framing only — never fabricated quotes or fake archival audio.", required: false, minLineSharePct: 0 },
    ],
    lineRules: { openingRole: "narrator", closingRole: "narrator" },
    generationReady: true,
  },
  {
    id: "betting_desk",
    version: 1,
    displayName: "Betting desk",
    description: "A desk host frames markets, an odds analyst explains data and movement, an optional contrarian challenges assumptions.",
    pacing: "Market-by-market; disciplined uncertainty language.",
    useCase: "Odds-centric shows where projection and fact must never blur.",
    speakerMin: 2,
    speakerMax: 3,
    roles: [
      { id: "desk_host", name: "Desk host", direction: "Frames each market and keeps odds context honest: current lines only from evidence, with timestamps when supplied.", required: true, minLineSharePct: 20 },
      { id: "odds_analyst", name: "Odds analyst", direction: "Explains the data and movement; NEVER invents lines, prices, or movement; predictions are hedged, never certainties.", required: true, minLineSharePct: 20 },
      { id: "contrarian", name: "Contrarian", direction: "Challenges the desk's assumptions; still bound by the same no-invented-numbers rules.", required: false, minLineSharePct: 0 },
    ],
    lineRules: { openingRole: "desk_host" },
    generationReady: true,
  },
  {
    id: "rapid_fire",
    version: 1,
    displayName: "Rapid fire",
    description: "A moderator throws short prompts at 1-3 respondents who answer under a strict length cap; ends on a scorecard.",
    pacing: "Short prompts, capped answers, fast category changes, zero monologues.",
    useCase: "High-tempo take rounds.",
    speakerMin: 2,
    speakerMax: 4,
    roles: [
      { id: "moderator", name: "Moderator", direction: "Fires short prompts, enforces the clock, calls category changes, and closes with the scorecard.", required: true, minLineSharePct: 15 },
      { id: "respondent_one", name: "Respondent 1", direction: "Answers fast and short — the cap is structural, not a suggestion.", required: true, minLineSharePct: 10 },
      { id: "respondent_two", name: "Respondent 2", direction: "Same rules; every respondent gets real participation.", required: false, minLineSharePct: 0 },
      { id: "respondent_three", name: "Respondent 3", direction: "Same rules.", required: false, minLineSharePct: 0 },
    ],
    lineRules: { maxWordsPerLine: 45, openingRole: "moderator", closingRole: "moderator" },
    generationReady: true,
  },
];

/** DEPRECATED alias -> canonical id. Historical records keep resolving;
 *  aliases never appear in selectors and are never written to new records. */
export const FORMAT_ALIASES: Record<string, string> = {
  solo_briefing: "solo_commentary",
  roundtable: "three_person_panel",
};

const BY_ID = new Map(FORMATS.map((f) => [f.id, f]));

/** Canonical formats only (selector-safe): aliases are never listed. */
export function listShowFormats(): ShowFormat[] {
  return [...FORMATS];
}

export function canonicalFormatId(id: string): string {
  return FORMAT_ALIASES[id] ?? id;
}

export function isDeprecatedFormatAlias(id: string): boolean {
  return id in FORMAT_ALIASES;
}

/** Lookup resolves historical aliases to their canonical definition. */
export function getShowFormat(id: string): ShowFormat | null {
  return BY_ID.get(canonicalFormatId(id)) ?? null;
}

export function isRegisteredFormat(id: string): boolean {
  return BY_ID.has(canonicalFormatId(id));
}

/** May a NEW show/episode select this format today? Registered AND the whole
 *  pipeline supports it. Unknown formats fail closed. */
export function isGenerationReadyFormat(id: string): boolean {
  return getShowFormat(id)?.generationReady === true;
}

export const DEFAULT_FORMAT_ID = "two_host_debate";

export type CastValidationError =
  | { code: "unknown_format"; formatId: string }
  | { code: "too_many_speakers"; max: number; got: number }
  | { code: "too_few_speakers"; min: number; got: number }
  | { code: "duplicate_host"; hostId: string };

/**
 * Validate a PINNED cast against a format's bounds. An empty/partial pin is
 * legal at configuration time (auto-casting fills the remaining chairs at
 * build time); the MIN is enforced when the cast is actually resolved.
 */
export function validatePinnedCast(
  formatId: string,
  hostIds: string[]
): { ok: true } | { ok: false; error: CastValidationError } {
  const format = getShowFormat(formatId);
  if (!format) return { ok: false, error: { code: "unknown_format", formatId } };
  if (hostIds.length > format.speakerMax) {
    return { ok: false, error: { code: "too_many_speakers", max: format.speakerMax, got: hostIds.length } };
  }
  const seen = new Set<string>();
  for (const id of hostIds) {
    if (seen.has(id)) return { ok: false, error: { code: "duplicate_host", hostId: id } };
    seen.add(id);
  }
  return { ok: true };
}

/** The role for a given seat index. Seats beyond the declared roles reuse the
 *  last role (defensive; cannot happen within speakerMax). */
export function roleForSeat(format: ShowFormat, seatIndex: number): ShowFormatRole {
  return format.roles[Math.min(seatIndex, format.roles.length - 1)];
}
