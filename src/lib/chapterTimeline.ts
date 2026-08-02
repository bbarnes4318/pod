// Chapter-timeline integrity. PURE + deterministic (no DB, no ffmpeg, no env),
// so the publish-side generator and its tests share one implementation.
//
// PRODUCTION DEFECT THIS EXISTS TO PREVENT
// ----------------------------------------
// A published episode shipped a 638-second chapter list against a 515-second
// MP3 — the Closing chapter ended two minutes after the audio stopped. The
// cause was two independently computed numbers that were never reconciled:
//
//   calculatedDurationSeconds = round(currentTimeMs / 1000)   // 638, estimated
//   finalDurationSeconds      = episode.durationSeconds || …  // 515, MEASURED
//
// `finalDurationSeconds` was used for the duration field only. The chapters
// kept the text-estimated timeline, and nothing ever compared the last chapter
// endpoint to the real audio length. Every estimator error (flat inter-line
// gaps, ignored interruption overlaps, a hardcoded 30s intro fallback,
// word-count guesses on scene-voiced episodes) accumulated straight into the
// published timestamps.
//
// The rule: a chapter timeline is a claim about audio that exists. It must be
// monotonic and it must fit inside that audio, or it must not ship.

export interface ChapterTiming {
  title: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  type?: string;
}

export type ChapterViolationCode =
  | "invalid_number"        // NaN / Infinity / negative endpoint
  | "non_positive_length"   // start >= end
  | "non_monotonic_start"   // starts before the previous chapter started
  | "overlaps_previous"     // starts before the previous chapter ended
  | "exceeds_audio_duration"; // endpoint past the real audio length

export interface ChapterViolation {
  code: ChapterViolationCode;
  chapterIndex: number;
  title: string;
  detail: string;
}

export interface ChapterTimelineValidation {
  ok: boolean;
  violations: ChapterViolation[];
  /** Last chapter endpoint, for the "how far past the end" message. */
  timelineEndSeconds: number;
  finalDurationSeconds: number;
}

/**
 * Tolerance (seconds) for the final endpoint. Chapters are rounded to a tenth
 * of a second and the master carries a short room-tone tail, so a sub-second
 * overhang is rounding, not a broken timeline. 123 seconds is not.
 */
export const CHAPTER_END_TOLERANCE_SECONDS = 1;

/**
 * Structured validation of a chapter timeline against the REAL audio duration.
 * Pure: same input, same violations, every time. `ok === false` must block
 * publication of the timeline — never be downgraded to a warning.
 */
export function validateChapterTimeline(
  chapters: ChapterTiming[],
  finalDurationSeconds: number
): ChapterTimelineValidation {
  const violations: ChapterViolation[] = [];
  const list = Array.isArray(chapters) ? chapters : [];
  const duration = Number(finalDurationSeconds);
  const limit = Number.isFinite(duration) && duration > 0 ? duration : 0;

  let timelineEndSeconds = 0;
  let prevStart = -Infinity;
  let prevEnd = -Infinity;

  list.forEach((c, i) => {
    const title = String(c?.title ?? `chapter ${i}`);
    const start = Number(c?.startTimeSeconds);
    const end = Number(c?.endTimeSeconds);
    const push = (code: ChapterViolationCode, detail: string) =>
      violations.push({ code, chapterIndex: i, title, detail });

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0) {
      push("invalid_number", `"${title}" has non-finite or negative timestamps (${c?.startTimeSeconds} → ${c?.endTimeSeconds}).`);
      return;
    }
    if (end > timelineEndSeconds) timelineEndSeconds = end;

    if (start >= end) {
      push("non_positive_length", `"${title}" starts at ${start}s and ends at ${end}s — a chapter must have positive length.`);
    }
    if (start < prevStart) {
      push("non_monotonic_start", `"${title}" starts at ${start}s, before the previous chapter's start (${prevStart}s).`);
    } else if (start + 1e-9 < prevEnd) {
      push("overlaps_previous", `"${title}" starts at ${start}s, before the previous chapter ended (${prevEnd}s).`);
    }
    if (limit > 0 && end > limit + CHAPTER_END_TOLERANCE_SECONDS) {
      push(
        "exceeds_audio_duration",
        `"${title}" ends at ${end}s but the final audio is only ${limit}s long — the timeline overruns the audio by ${(end - limit).toFixed(1)}s.`
      );
    } else if (limit > 0 && start > limit) {
      push(
        "exceeds_audio_duration",
        `"${title}" starts at ${start}s, past the end of the ${limit}s final audio.`
      );
    }

    prevStart = start;
    prevEnd = Math.max(prevEnd, end);
  });

  return { ok: violations.length === 0, violations, timelineEndSeconds, finalDurationSeconds: limit };
}

/** One-line, log/error-safe rendering of a validation failure. */
export function describeChapterViolations(v: ChapterTimelineValidation): string {
  return v.violations.map((x) => `[${x.code}] ${x.detail}`).join(" ");
}

/**
 * Proportionally compress an over-running millisecond timeline onto the real
 * audio duration. Used when the ESTIMATED walk is longer than the measured
 * master: the shape of the episode (relative segment lengths) is the part we
 * actually know, so keep it and scale it into the true length rather than
 * shipping endpoints that cannot exist.
 *
 * Returns 1 (no change) when the estimate already fits.
 */
export function timelineRescaleFactor(estimatedTotalMs: number, realDurationMs: number): number {
  const est = Number(estimatedTotalMs);
  const real = Number(realDurationMs);
  if (!Number.isFinite(est) || !Number.isFinite(real) || est <= 0 || real <= 0) return 1;
  if (est <= real) return 1;
  return real / est;
}

/** Apply {@link timelineRescaleFactor} to a chapter list (seconds in, seconds out). */
export function rescaleChapterTimeline(
  chapters: ChapterTiming[],
  finalDurationSeconds: number
): ChapterTiming[] {
  const list = Array.isArray(chapters) ? chapters : [];
  if (list.length === 0) return [];
  const end = Math.max(...list.map((c) => Number(c.endTimeSeconds) || 0));
  const factor = timelineRescaleFactor(end, finalDurationSeconds);
  if (factor === 1) return list.map((c) => ({ ...c }));
  const round = (v: number) => Math.round(v * factor * 10) / 10;
  return list.map((c) => ({ ...c, startTimeSeconds: round(Number(c.startTimeSeconds) || 0), endTimeSeconds: round(Number(c.endTimeSeconds) || 0) }));
}
