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

/** Named, human streaming line for a live status — "Scouting the take…" etc.
 *  `researching` is true while a research job is running before the brief lands. */
export function streamingMessage(status: string | null | undefined, researching = false): string {
  if (status === null || status === undefined) {
    return researching ? "Scouting the take…" : "Ready to research";
  }
  switch (status) {
    case "draft":
      return "Writing the debate…";
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
