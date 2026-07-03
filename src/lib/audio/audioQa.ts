// Automated "human-ness" checks for a finished episode.
//
// These are proxies, not a golden ear — but they catch exactly the
// regressions that make TTS audio sound robotic:
//   - flat delivery      -> loudness-range / short-term loudness variance
//   - metronome pacing   -> pause-length variance
//   - splice artifacts   -> long dead-silent gaps (real rooms are never
//                           digitally silent), clipping
//   - mastering problems -> integrated loudness off podcast target

import { runFfmpeg } from "./assembly";

export interface AudioQaCheck {
  name: string;
  status: "pass" | "warning" | "fail";
  value: string;
  detail: string;
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
  };
}

interface SilenceInterval {
  start: number;
  end: number;
}

export async function analyzeEpisodeAudio(
  ffmpegPath: string,
  filePath: string,
  opts: { targetLufs?: number } = {}
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

  check(checks, {
    name: "Pause variety (no metronome pacing)",
    ok: gapStdDev === null || gapStdDev >= 0.12,
    warn: gapStdDev !== null && gapStdDev >= 0.06,
    value: gapStdDev === null ? "n/a" : `σ=${gapStdDev.toFixed(2)}s over ${gapLengths.length} pauses`,
    detail:
      "Identical gaps between every line is how splice-assembled audio gives itself away. Std deviation of pause lengths should exceed ~0.12s.",
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
