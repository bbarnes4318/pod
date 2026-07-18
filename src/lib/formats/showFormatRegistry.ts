// The versioned show-format registry (Prompt 7).
//
// A show format declares HOW MANY voices an episode has (1-4) and WHAT ROLE
// each chair plays. `two_host_debate` — previously the hardcoded architecture
// — is now simply the first registered format. Every pipeline stage resolves
// speaker count, roles, seating, and validation THROUGH a format, never
// through a baked-in pair.
//
// Client-safe: no Node imports, no database. The registry is code, not data —
// formats ship with the application and are versioned here, so an Episode
// snapshot can record exactly (formatId, formatVersion) it was built with.
//
// GENERATION READINESS: a format may be registered before every pipeline
// stage can produce it. `generationReady` is the honest gate — a format is
// selectable for NEW shows/episodes only when the whole pipeline (script ->
// TTS -> stitch -> transcript -> clips) supports its speaker count. The
// engine PRs flip these flags on as each capability lands; nothing is ever
// presented as functional before it is.

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

export interface ShowFormat {
  id: string;
  /** Bumped when a format's roles/semantics change; frozen into snapshots. */
  version: number;
  displayName: string;
  description: string;
  speakerMin: number;
  speakerMax: number;
  /** Ordered chairs; index = seat order (also drives stereo seating + colors). */
  roles: ShowFormatRole[];
  /** True once EVERY pipeline stage can produce this format. */
  generationReady: boolean;
}

const FORMATS: ShowFormat[] = [
  {
    id: "two_host_debate",
    version: 1,
    displayName: "Two-host debate",
    description:
      "Two colliding personas argue the rundown — the higher-intensity chair drives, the analytical chair counters.",
    speakerMin: 2,
    speakerMax: 2,
    roles: [
      { id: "chair_a", name: "Chair A", direction: "Higher-intensity, emotional drive; opens segments and pushes the take.", required: true, minLineSharePct: 25 },
      { id: "chair_b", name: "Chair B", direction: "Analytical counterweight; challenges with evidence and reframes.", required: true, minLineSharePct: 25 },
    ],
    // The complete existing pipeline IS this format.
    generationReady: true,
  },
  {
    id: "solo_briefing",
    version: 1,
    displayName: "Solo briefing",
    description: "One host delivers a direct, tightly-paced rundown briefing straight to the listener.",
    speakerMin: 1,
    speakerMax: 1,
    roles: [
      { id: "anchor", name: "Anchor", direction: "Carries the whole episode alone; addresses the listener directly.", required: true, minLineSharePct: 0 },
    ],
    generationReady: false, // flipped on when script/TTS/stitch support 1 voice
  },
  {
    id: "interview",
    version: 1,
    displayName: "Interview",
    description: "A lead host drives questions; the featured guest chair carries the answers and stories.",
    speakerMin: 2,
    speakerMax: 2,
    roles: [
      { id: "interviewer", name: "Interviewer", direction: "Drives structure, asks and follows up; hands the floor to the guest.", required: true, minLineSharePct: 15 },
      { id: "guest", name: "Guest", direction: "Carries the substance; longer answers, personal angles.", required: true, minLineSharePct: 30 },
    ],
    generationReady: false,
  },
  {
    id: "roundtable",
    version: 1,
    displayName: "Roundtable",
    description: "A moderator steers three or four voices through the rundown with rotating leads.",
    speakerMin: 3,
    speakerMax: 4,
    roles: [
      { id: "moderator", name: "Moderator", direction: "Steers topics, arbitrates, hands the floor around the table.", required: true, minLineSharePct: 10 },
      { id: "panelist_1", name: "Panelist 1", direction: "First take on each topic; strong opinions.", required: true, minLineSharePct: 12 },
      { id: "panelist_2", name: "Panelist 2", direction: "Counter-angle; pushes back on the first take.", required: true, minLineSharePct: 12 },
      { id: "panelist_3", name: "Panelist 3", direction: "Wildcard chair; optional fourth voice.", required: false, minLineSharePct: 0 },
    ],
    generationReady: false,
  },
];

const BY_ID = new Map(FORMATS.map((f) => [f.id, f]));

export function listShowFormats(): ShowFormat[] {
  return [...FORMATS];
}

export function getShowFormat(id: string): ShowFormat | null {
  return BY_ID.get(id) ?? null;
}

export function isRegisteredFormat(id: string): boolean {
  return BY_ID.has(id);
}

/** May a NEW show/episode select this format today? Registered AND the whole
 *  pipeline supports it. `two_host_debate` is the only ready format until the
 *  engine PRs land the generalized stages. */
export function isGenerationReadyFormat(id: string): boolean {
  return BY_ID.get(id)?.generationReady === true;
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

/** The role for a given seat index, e.g. seat 0 of two_host_debate = chair_a.
 *  Seats beyond the declared roles reuse the last role (defensive; cannot
 *  happen within speakerMax). */
export function roleForSeat(format: ShowFormat, seatIndex: number): ShowFormatRole {
  return format.roles[Math.min(seatIndex, format.roles.length - 1)];
}
