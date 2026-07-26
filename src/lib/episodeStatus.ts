// The canonical Episode.status ladder.
//
// This exists because the produced-or-later set had been hand-copied into four
// separate services. Season progression now depends on that boundary, and a
// duplicated literal fails SILENTLY IN BOTH DIRECTIONS: add a status to the
// ladder and continuity either commits too early or stops committing, with
// nothing raised. One definition, imported everywhere.
//
// Any code that needs to ask "has this episode been produced yet?" imports
// `isProducedOrLater`. Any code that needs the ordered sequence imports
// `EPISODE_STATUS_LADDER`. Nothing re-derives either from a literal.

/**
 * Every Episode.status, in pipeline order. `failed` is not in the ladder — it
 * is an orthogonal terminal state reachable from anywhere, and it is listed
 * separately so the exhaustiveness test can still account for it.
 */
export const EPISODE_STATUS_LADDER = [
  "draft",
  "script_draft",
  "fact_checked",
  "script_approved",
  "audio_segments_ready",
  "audio_stitching",
  "audio_ready",
  "content_generating",
  "content_ready",
  "publish_ready",
  "published",
] as const;

export type EpisodeStatus = (typeof EPISODE_STATUS_LADDER)[number];

/** Reachable from any rung; not part of the ordered sequence. */
export const EPISODE_STATUS_OFF_LADDER = ["failed"] as const;

/**
 * The boundary: the final audio file exists, so this episode is going to be
 * heard. Everything from `audio_ready` onward.
 *
 * This is the set that continuity commits on, that a re-stitch must not knock
 * a published episode back out of, and that the admin final-audio action gates
 * on. All four call sites import THIS — see the module comment for why that
 * matters more than it looks.
 */
export const PRODUCED_OR_LATER: ReadonlySet<string> = new Set<string>([
  "audio_ready",
  "content_generating",
  "content_ready",
  "publish_ready",
  "published",
]);

/** True once the episode's final audio exists. */
export function isProducedOrLater(status: string): boolean {
  return PRODUCED_OR_LATER.has(status);
}

/**
 * The complement: on the ladder but before the audio exists. Exported so the
 * exhaustiveness test can assert every rung falls on exactly one side, which
 * is what forces a decision when someone adds a status.
 */
export const PRE_PRODUCTION: ReadonlySet<string> = new Set<string>(
  EPISODE_STATUS_LADDER.filter((s) => !PRODUCED_OR_LATER.has(s))
);

/** Position in the ladder, or -1 for an off-ladder status. */
export function episodeStatusIndex(status: string): number {
  return (EPISODE_STATUS_LADDER as readonly string[]).indexOf(status);
}
