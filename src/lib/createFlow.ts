// Shared, pure model for the /studio Create stepper. Imported by the server
// progress action, the server page, and the client stepper so they never drift
// on stage names/order. No server-only or client-only code here.

export const CREATE_STAGES = [
  { key: "take", label: "Take", short: "Take" },
  { key: "setup", label: "Style & hosts", short: "Setup" },
  { key: "research", label: "Research", short: "Research" },
  { key: "script", label: "Script", short: "Script" },
  { key: "preview", label: "Preview", short: "Preview" },
  { key: "voices", label: "Voices", short: "Voices" },
  { key: "mix", label: "Mix", short: "Mix" },
  { key: "assets", label: "Assets", short: "Assets" },
] as const;

export type StageKey = (typeof CREATE_STAGES)[number]["key"];

export const STAGE_ORDER: StageKey[] = CREATE_STAGES.map((s) => s.key);

export function stageIndex(key: StageKey): number {
  return STAGE_ORDER.indexOf(key);
}

/**
 * Map a live Episode.status (written by the worker) to the stepper stage the
 * episode currently sits at. `done` = the whole pipeline finished; `failed` =
 * the pipeline errored on the current stage.
 */
export function stageForStatus(
  status: string | null | undefined,
  hasScript: boolean
): StageKey | "done" | "failed" {
  switch (status) {
    case null:
    case undefined:
      return "research";
    case "draft":
      return hasScript ? "preview" : "script";
    case "script_draft":
      return "preview";
    case "script_approved":
    case "fact_checked":
      return "voices";
    case "audio_segments_ready":
      return "mix";
    case "audio_stitching":
      return "mix";
    case "audio_ready":
    case "content_generating":
      return "assets";
    case "content_ready":
    case "publish_ready":
    case "published":
      return "done";
    case "failed":
      return "failed";
    default:
      return "script";
  }
}

/* ============================================================================
 * PRODUCTION PIPELINE — the live model behind the studio Production Console.
 *
 * CREATE_STAGES above models the *wizard* (the steps a user clicks through).
 * This models what the *worker* actually does after "Start the debate", which
 * is a different sequence: every entry below maps 1:1 to a real BullMQ job that
 * writes a JobLog row, so the console can read a genuine start time, duration,
 * and failure reason for each one.
 *
 * HONESTY POLICY (mirrors episodeEstimate.ts): only `voices` produces
 * incremental output — the TTS worker writes one AudioSegment row per line, so
 * it has a real 0-100%. Every other stage is a single atomic write at the end
 * (see scriptService.ts:829, worker.ts:2369, audioStitchingService.ts:1576), so
 * the console shows elapsed time against a historical median and NEVER a
 * synthetic percentage. `determinate` records which is which.
 * ========================================================================== */

export interface ProductionStage {
  key: string;
  label: string;
  /** Present-tense line shown while this stage is running. */
  verb: string;
  /** One sentence explaining what actually happens here, for the expanded card. */
  blurb: string;
  /** The JobLog.jobType this stage writes, or null for a human checkpoint. */
  jobType: string | null;
  /** How the JobLog.input identifies this episode — the two differ (worker.ts). */
  matchBy: "episodeId" | "scriptId" | null;
  /** True only where the pipeline writes real incremental progress. */
  determinate: boolean;
  /** True where the pipeline is waiting on the user, not on a worker. */
  checkpoint: boolean;
}

export const PRODUCTION_STAGES: ProductionStage[] = [
  {
    key: "script",
    label: "Script",
    verb: "Writing the script",
    blurb: "The hosts' argument is drafted, self-verified, and scored against the research brief.",
    jobType: "generate:script",
    matchBy: "episodeId",
    determinate: false,
    checkpoint: false,
  },
  {
    key: "review",
    label: "Your read",
    verb: "Waiting on you",
    blurb: "Nothing is voiced until you approve the draft — read it, edit any line, then approve.",
    jobType: null,
    matchBy: null,
    determinate: false,
    checkpoint: true,
  },
  {
    key: "factcheck",
    label: "Fact check",
    verb: "Checking every claim",
    blurb: "Each factual claim is matched against the evidence in the brief before anything is recorded.",
    jobType: "fact-check:script",
    matchBy: "scriptId",
    determinate: false,
    checkpoint: false,
  },
  {
    key: "voices",
    label: "Voices",
    verb: "Recording the hosts",
    blurb: "Every line is synthesised in each host's own voice, a couple of lines at a time.",
    jobType: "tts:generate-segments",
    matchBy: "scriptId",
    determinate: true,
    checkpoint: false,
  },
  {
    key: "mix",
    label: "Mix",
    verb: "Mixing the episode",
    blurb: "Lines are spliced to the timeline, music and effects are placed, and the master is levelled.",
    jobType: "audio:stitch-final",
    matchBy: "scriptId",
    determinate: false,
    checkpoint: false,
  },
  {
    key: "assets",
    label: "Show notes",
    verb: "Writing show notes & chapters",
    blurb: "Titles, description, chapter markers, and cover art are generated from the finished episode.",
    jobType: "content:generate-assets",
    matchBy: "scriptId",
    determinate: false,
    checkpoint: false,
  },
];

export const PRODUCTION_STAGE_KEYS = PRODUCTION_STAGES.map((s) => s.key);

export function productionStageIndex(key: string): number {
  return PRODUCTION_STAGE_KEYS.indexOf(key);
}

/**
 * Map a live Episode.status to the production stage currently in flight.
 * "done" means the pipeline finished.
 *
 * Note there is deliberately no "failed" case: the worker NEVER writes
 * Episode.status = "failed". On failure it rolls the status *back* to what it
 * was before the stage started (audioStitchingService.ts:1828,
 * contentAssetService.ts:920), so a failed episode looks identical to one that
 * has not started that stage yet. Failure is detected from the stage's JobLog,
 * not from this function — see createProgress.ts.
 */
export function productionStageForStatus(
  status: string | null | undefined,
  hasScript: boolean
): string {
  switch (status) {
    case null:
    case undefined:
      return "script";
    case "draft":
      return hasScript ? "review" : "script";
    case "script_draft":
      return "review";
    case "script_approved":
      return "factcheck";
    case "fact_checked":
      return "voices";
    case "audio_segments_ready":
    case "audio_stitching":
      return "mix";
    case "audio_ready":
    case "content_generating":
      return "assets";
    case "content_ready":
    case "publish_ready":
    case "published":
      return "done";
    default:
      return "script";
  }
}

/** Named, human streaming line for a live status — "Scouting the take…" etc.
 *  `researching` is true while a research job is running before the brief lands. */
export function streamingMessage(status: string | null | undefined, researching = false): string {
  if (status === null || status === undefined) {
    return researching ? "Scouting the take…" : "Ready to research";
  }
  switch (status) {
    case "draft":
      return "Writing the script…";
    case "script_draft":
      return "Draft is in — give it a read";
    case "script_approved":
      return "Fact-checking the claims…";
    case "fact_checked":
      return "Facts verified — ready to cast voices";
    case "audio_segments_ready":
      return "Voices recorded";
    case "audio_stitching":
      return "Mixing the episode…";
    case "audio_ready":
    case "content_generating":
      return "Writing show notes & chapters…";
    case "content_ready":
    case "publish_ready":
      return "Episode ready";
    case "published":
      return "Live";
    case "failed":
      return "Something went wrong on this stage";
    default:
      return "Working…";
  }
}
