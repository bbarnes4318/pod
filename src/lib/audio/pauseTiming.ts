// Single source of truth for scripted pause timing.
//
// Pure module (no node imports) so client components, view-models, and the
// ffmpeg assembly layer can all share the same table — the UI timeline, the
// QA grader, and the renderer must never disagree about what a "breath" is.
//
// The four scripted pause lengths, in milliseconds. planConversationTimeline
// uses these as its gap defaults (overridable per-render via AUDIO_PAUSE_*_MS
// env vars), and the QA pause-variety check maps the script's `pauseBefore`
// values back through the same table.
//
// v10 postmortem: "long" at 1100ms read as radio dead air between two hosts
// mid-argument — a dramatic beat in a two-hander tops out around half a
// second of true silence before it stops feeling intentional. 600ms keeps the
// beat audible without killing momentum; "breath" drops to 450ms to stay
// clearly shorter than "long".
export const DEFAULT_PAUSE_MS: Record<"none" | "beat" | "breath" | "long", number> = {
  none: 80,
  beat: 300,
  breath: 450,
  long: 600,
};

/** Default gap at a script-segment boundary (same-topic section change). */
export const DEFAULT_SEGMENT_GAP_MS = 850;
/** Default gap at a topic change. */
export const DEFAULT_TOPIC_GAP_MS = 1200;

// "long" is a dramatic beat — rare by definition. The generator is told this,
// but models overuse it, so capLongPauses() enforces the budget structurally
// after generation: at most MAX per episode, never two within MIN_SPACING
// lines of each other. Excess downgrades to "breath".
export const MAX_LONG_PAUSES_PER_EPISODE = 3;
export const MIN_LINES_BETWEEN_LONG_PAUSES = 10;

export interface CapLongPausesResult {
  /** How many "long" pauses were downgraded to "breath". */
  downgraded: number;
  /** How many "long" pauses survived the budget. */
  kept: number;
}

/**
 * Enforce the long-pause budget over a script's lines (flat, in speaking
 * order). Mutates `pauseBefore` in place: any "long" that exceeds the
 * per-episode budget or falls within MIN_LINES_BETWEEN_LONG_PAUSES of the
 * previously kept "long" becomes "breath". First-come-first-kept keeps the
 * earliest dramatic beats, which is where cold-open reveals live.
 */
export function capLongPauses(
  lines: Array<{ pauseBefore?: unknown }>,
  opts: { max?: number; minSpacing?: number } = {}
): CapLongPausesResult {
  const max = opts.max ?? MAX_LONG_PAUSES_PER_EPISODE;
  const minSpacing = opts.minSpacing ?? MIN_LINES_BETWEEN_LONG_PAUSES;
  let kept = 0;
  let downgraded = 0;
  let lastKeptAt = -Infinity;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].pauseBefore !== "long") continue;
    if (kept >= max || i - lastKeptAt < minSpacing) {
      lines[i].pauseBefore = "breath";
      downgraded++;
    } else {
      kept++;
      lastKeptAt = i;
    }
  }
  return { downgraded, kept };
}
