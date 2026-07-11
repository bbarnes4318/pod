// Automated "human-ness" checks for a finished episode.
//
// These are proxies, not a golden ear — but they catch exactly the
// regressions that make TTS audio sound robotic:
//   - flat delivery      -> loudness-range / short-term loudness variance
//   - metronome pacing   -> pause-length variance
//   - splice artifacts   -> long dead-silent gaps (real rooms are never
//                           digitally silent), clipping
//   - mastering problems -> integrated loudness off podcast target

import { runFfmpeg, DEFAULT_PAUSE_MS } from "./assembly";

export interface AudioQaCheck {
  name: string;
  status: "pass" | "warning" | "fail";
  value: string;
  detail: string;
}

export type ScriptedPause = "none" | "beat" | "breath" | "long";

export interface PauseVarietyScore {
  status: "pass" | "warning" | "fail";
  value: string;
  detail: string;
  /** Population σ of the scripted pause lengths in ms (null when no lines). */
  stdDevMs: number | null;
  meanMs: number | null;
  /** Did the script ever call for a dramatic "long" beat? */
  hasLong: boolean;
  count: number;
  histogram: Record<ScriptedPause, number>;
}

// Meaningful-spread and floor thresholds for σ of the scripted pause lengths,
// in ms. Chosen against the two anchors this metric must separate, recomputed
// for the compressed pause table (none 80 / beat 300 / breath 450 / long 600 —
// see pauseTiming.ts):
//   - a well-paced script (v3 mix: none 24 / beat 30 / breath 4 / long 5) → σ≈156ms
//   - a long-capped 68-line episode (none 11 / beat 50 / breath 4 / long 3) → σ≈114ms
//   - a metronome script (every line the same beat)                        → σ=0ms
const PAUSE_SIGMA_MEANINGFUL_MS = 100;
const PAUSE_SIGMA_SOME_MS = 50;

/**
 * Score pacing variety from the SCRIPTED pause plan — the pauseBefore each line
 * was authored with — rather than from silence detected in the mastered mix.
 *
 * Why not measure the audio? The final master carries a ducked music bed that
 * sits above the −45dB silence gate, so it masks the very gaps we'd measure,
 * and an 80ms "none" pause falls under ffmpeg's 0.15s detection floor. The old
 * acoustic check therefore reported "σ=0.00 over 2 pauses" on a perfectly-paced
 * script — an unmeetable, dishonest metric. The scripted plan is exactly what
 * the pipeline controls and what planConversationTimeline turns into real gaps
 * (via DEFAULT_PAUSE_MS), so it is the honest thing to grade.
 *
 * Pure and ffmpeg-free so it is unit-testable in isolation. Unknown/undefined
 * pauseBefore maps to "beat", mirroring planConversationTimeline's fallback.
 */
export function scorePauseVariety(pauses: Array<ScriptedPause | undefined | null>): PauseVarietyScore {
  const histogram: Record<ScriptedPause, number> = { none: 0, beat: 0, breath: 0, long: 0 };
  const ms: number[] = [];
  for (const p of pauses) {
    const kind: ScriptedPause = p === "none" || p === "breath" || p === "long" ? p : "beat";
    histogram[kind]++;
    ms.push(DEFAULT_PAUSE_MS[kind]);
  }
  const count = ms.length;
  const meanMs = count ? ms.reduce((a, b) => a + b, 0) / count : null;
  const stdDevMs =
    count > 1 && meanMs !== null
      ? Math.sqrt(ms.reduce((a, b) => a + (b - meanMs) ** 2, 0) / count)
      : count === 1
        ? 0
        : null;
  const hasLong = histogram.long > 0;

  let status: "pass" | "warning" | "fail";
  if (stdDevMs === null) {
    status = "warning"; // no scripted pacing data to grade
  } else if (stdDevMs >= PAUSE_SIGMA_MEANINGFUL_MS && hasLong) {
    status = "pass";
  } else if (stdDevMs >= PAUSE_SIGMA_SOME_MS) {
    status = "warning"; // some spread, but not enough or missing a "long" beat
  } else {
    status = "fail"; // metronome pacing
  }

  const shape = `none ${histogram.none} / beat ${histogram.beat} / breath ${histogram.breath} / long ${histogram.long}`;
  return {
    status,
    value:
      stdDevMs === null
        ? "n/a (no script pacing data)"
        : `σ=${Math.round(stdDevMs)}ms over ${count} pauses (${shape})`,
    detail:
      `Scripted pause plan (none ${DEFAULT_PAUSE_MS.none} / beat ${DEFAULT_PAUSE_MS.beat} / breath ${DEFAULT_PAUSE_MS.breath} / long ${DEFAULT_PAUSE_MS.long} ms). Metronome pacing is the #1 splice tell; a human debate mixes short and long beats. Needs σ ≥ ${PAUSE_SIGMA_MEANINGFUL_MS}ms AND at least one 'long'.`,
    stdDevMs,
    meanMs,
    hasLong,
    count,
    histogram,
  };
}

export interface AudioQaReport {
  passed: boolean;
  checks: AudioQaCheck[];
  metrics: {
    integratedLufs: number | null;
    loudnessRangeLu: number | null;
    truePeakDb: number | null;
    silenceGapCount: number;
    maxSilenceGapSec: number;
    meanGapSec: number | null;
    gapStdDevSec: number | null;
    /** σ of the SCRIPTED pause plan (ms) — the honest pacing-variety metric. */
    scriptedPauseStdDevMs: number | null;
    scriptedPauseHasLong: boolean;
    scriptedPauseCount: number;
  };
}

interface SilenceInterval {
  start: number;
  end: number;
}

export async function analyzeEpisodeAudio(
  ffmpegPath: string,
  filePath: string,
  opts: { targetLufs?: number; scriptedPauses?: Array<ScriptedPause | undefined | null> } = {}
): Promise<AudioQaReport> {
  const targetLufs = opts.targetLufs ?? -16;

  // One analysis pass: EBU R128 loudness + silence detection.
  // Silence threshold is set at -45dB so the room-tone bed (~-58dB) still
  // counts as "silence" for *pause* measurement, but detects true dead air
  // via a second, stricter threshold below.
  const nullSink = process.platform === "win32" ? "NUL" : "/dev/null";
  const output = await runFfmpeg(ffmpegPath, [
    "-i", filePath,
    "-af", "silencedetect=noise=-45dB:d=0.15,ebur128=peak=true",
    "-f", "null", nullSink,
  ]);

  const deadAirOutput = await runFfmpeg(ffmpegPath, [
    "-i", filePath,
    "-af", "silencedetect=noise=-70dB:d=0.6",
    "-f", "null", nullSink,
  ]);

  // ---- Parse EBU R128 summary ----
  const integratedLufs = matchNum(output, /I:\s+(-?[\d.]+)\s+LUFS/);
  const loudnessRangeLu = matchNum(output, /LRA:\s+([\d.]+)\s+LU/);
  const truePeakDb = matchNum(output, /Peak:\s+(-?[\d.]+)\s+dBFS/);

  // ---- Parse pauses (speech gaps) ----
  const gaps = parseSilences(output).filter((g) => g.end - g.start >= 0.15);
  const gapLengths = gaps.map((g) => g.end - g.start);
  const meanGap = gapLengths.length
    ? gapLengths.reduce((a, b) => a + b, 0) / gapLengths.length
    : null;
  const gapStdDev =
    gapLengths.length > 1 && meanGap !== null
      ? Math.sqrt(
          gapLengths.reduce((a, b) => a + (b - meanGap) ** 2, 0) / gapLengths.length
        )
      : null;
  const maxGap = gapLengths.length ? Math.max(...gapLengths) : 0;

  // ---- Parse true dead air (digital black) ----
  const deadAir = parseSilences(deadAirOutput).filter((g) => g.end - g.start >= 0.6);

  const checks: AudioQaCheck[] = [];

  check(checks, {
    name: "Integrated loudness on podcast target",
    ok: integratedLufs !== null && Math.abs(integratedLufs - targetLufs) <= 1.5,
    warn: integratedLufs !== null && Math.abs(integratedLufs - targetLufs) <= 3,
    value: integratedLufs === null ? "unknown" : `${integratedLufs.toFixed(1)} LUFS`,
    detail: `Target ${targetLufs} LUFS ±1.5. Off-target loudness is the first thing podcast apps expose.`,
  });

  check(checks, {
    name: "Loudness range (delivery dynamics)",
    ok: loudnessRangeLu !== null && loudnessRangeLu >= 4,
    warn: loudnessRangeLu !== null && loudnessRangeLu >= 2.5,
    value: loudnessRangeLu === null ? "unknown" : `${loudnessRangeLu.toFixed(1)} LU`,
    detail:
      "Human conversation breathes — LRA under ~2.5 LU means the whole episode is delivered at one flat intensity (the #1 robotic tell).",
  });

  check(checks, {
    name: "True peak headroom",
    ok: truePeakDb !== null && truePeakDb <= -0.8,
    warn: truePeakDb !== null && truePeakDb <= -0.2,
    value: truePeakDb === null ? "unknown" : `${truePeakDb.toFixed(1)} dBFS`,
    detail: "Peaks above -0.8 dBFS risk clipping after lossy re-encoding by podcast platforms.",
  });

  // Pace variety is graded from the SCRIPTED pause plan, not from silence in
  // the mastered mix: the ducked music bed masks the gaps and 80ms "none"
  // pauses fall under ffmpeg's detection floor, so the acoustic reading was an
  // illusion ("σ=0.00 over 2 pauses" on a well-paced script). See
  // scorePauseVariety. When no script pacing data is supplied it reports n/a
  // (a warning), never a spurious fail.
  const pauseVariety = scorePauseVariety(opts.scriptedPauses ?? []);
  checks.push({
    name: "Pause variety (no metronome pacing)",
    status: pauseVariety.status,
    value: pauseVariety.value,
    detail: pauseVariety.detail,
  });

  check(checks, {
    name: "No awkward dead stretches",
    ok: maxGap <= 2.2,
    warn: maxGap <= 3.5,
    value: `longest pause ${maxGap.toFixed(2)}s`,
    detail: "Pauses beyond ~2.2s read as an editing error rather than a dramatic beat.",
  });

  check(checks, {
    name: "No digital black (shared room tone present)",
    ok: deadAir.length === 0,
    warn: deadAir.length <= 2,
    value: `${deadAir.length} dead-air gap(s) ≥0.6s below -70dB`,
    detail:
      "Real recordings always carry room tone. Absolute digital silence between turns exposes clip-by-clip assembly.",
  });

  return {
    passed: checks.every((c) => c.status !== "fail"),
    checks,
    metrics: {
      integratedLufs,
      loudnessRangeLu,
      truePeakDb,
      silenceGapCount: gapLengths.length,
      maxSilenceGapSec: maxGap,
      meanGapSec: meanGap,
      gapStdDevSec: gapStdDev,
      scriptedPauseStdDevMs: pauseVariety.stdDevMs,
      scriptedPauseHasLong: pauseVariety.hasLong,
      scriptedPauseCount: pauseVariety.count,
    },
  };
}

function check(
  list: AudioQaCheck[],
  input: { name: string; ok: boolean; warn: boolean; value: string; detail: string }
) {
  list.push({
    name: input.name,
    status: input.ok ? "pass" : input.warn ? "warning" : "fail",
    value: input.value,
    detail: input.detail,
  });
}

function matchNum(text: string, re: RegExp): number | null {
  // ebur128 prints a running summary; the final Summary block is last.
  const matches = [...text.matchAll(new RegExp(re.source, "g"))];
  if (matches.length === 0) return null;
  const v = parseFloat(matches[matches.length - 1][1]);
  return Number.isFinite(v) ? v : null;
}

function parseSilences(output: string): SilenceInterval[] {
  const intervals: SilenceInterval[] = [];
  const starts = [...output.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...output.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    if (ends[i] > starts[i]) intervals.push({ start: starts[i], end: ends[i] });
  }
  return intervals;
}
