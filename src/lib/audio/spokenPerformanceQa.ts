import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { getFileDurationMs, runFfmpeg } from "./assembly";

export interface SpokenPerformanceQaMetrics {
  durationSec: number | null;
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDb: number | null;
  pauseCount: number;
  medianPauseSec: number | null;
  meanPauseSec: number | null;
  pauseStdDevSec: number | null;
  pauseCoefficientOfVariation: number | null;
  narrowPauseRatio: number | null;
  longestPauseSec: number;
}

export interface SpokenPerformanceQaReport {
  passed: boolean;
  score: number;
  failures: string[];
  warnings: string[];
  metrics: SpokenPerformanceQaMetrics;
}

interface AnalyzeOptions {
  expectedTurnCount: number;
  sceneType?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  format?: "mp3" | "wav";
  strict?: boolean;
}

interface SilenceInterval {
  start: number;
  end: number;
}

function lastNumber(text: string, re: RegExp): number | null {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const matches = [...text.matchAll(new RegExp(re.source, flags))];
  if (matches.length === 0) return null;
  const value = Number(matches[matches.length - 1][1]);
  return Number.isFinite(value) ? value : null;
}

function silences(text: string): SilenceInterval[] {
  const starts = [...text.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((match) => Number(match[1]));
  const ends = [...text.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((match) => Number(match[1]));
  const intervals: SilenceInterval[] = [];
  for (let index = 0; index < Math.min(starts.length, ends.length); index++) {
    if (Number.isFinite(starts[index]) && Number.isFinite(ends[index]) && ends[index] > starts[index]) {
      intervals.push({ start: starts[index], end: ends[index] });
    }
  }
  return intervals;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((left, right) => left + right, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stdDev(values: number[], average: number | null): number | null {
  if (!values.length || average === null) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

export function scoreSpokenPerformanceMetrics(
  metrics: SpokenPerformanceQaMetrics,
  options: Pick<AnalyzeOptions, "expectedTurnCount" | "sceneType" | "strict">
): SpokenPerformanceQaReport {
  const failures: string[] = [];
  const warnings: string[] = [];
  const strict = options.strict !== false;
  const substantialScene = options.expectedTurnCount >= 5;
  const highStakesScene = options.sceneType === "cold_open" || options.sceneType === "argument_escalation";
  let score = 100;

  const minimumLra = highStakesScene ? 3.0 : substantialScene ? 2.6 : 1.8;
  if (metrics.loudnessRangeLu === null) {
    warnings.push("Loudness range could not be measured.");
    score -= 8;
  } else if (metrics.loudnessRangeLu < minimumLra) {
    failures.push(`Flat vocal dynamics: ${metrics.loudnessRangeLu.toFixed(1)} LU LRA; minimum ${minimumLra.toFixed(1)} LU for this scene.`);
    score -= 32;
  } else if (metrics.loudnessRangeLu < minimumLra + 0.8) {
    warnings.push(`Limited vocal dynamics: ${metrics.loudnessRangeLu.toFixed(1)} LU LRA.`);
    score -= 9;
  } else {
    score += Math.min(4, (metrics.loudnessRangeLu - minimumLra) * 0.8);
  }

  if (metrics.truePeakDb !== null && metrics.truePeakDb > -0.2) {
    failures.push(`Candidate is clipping or effectively clipping at ${metrics.truePeakDb.toFixed(1)} dBFS.`);
    score -= 20;
  }

  if (metrics.longestPauseSec > 3.2) {
    failures.push(`Dead conversational gap of ${metrics.longestPauseSec.toFixed(2)} seconds.`);
    score -= 18;
  } else if (metrics.longestPauseSec > 2.3) {
    warnings.push(`Long pause of ${metrics.longestPauseSec.toFixed(2)} seconds.`);
    score -= 6;
  }

  // This runs on RAW provider speech, before music or room tone can hide the
  // repeated timing pattern that makes synthetic dialogue sound metronomic.
  if (substantialScene && metrics.pauseCount >= 4) {
    const coefficient = metrics.pauseCoefficientOfVariation ?? 0;
    const narrowRatio = metrics.narrowPauseRatio ?? 1;
    const spread = metrics.pauseStdDevSec ?? 0;
    if (spread < 0.10 && coefficient < 0.30) {
      failures.push(`Metronome pacing: pause σ=${spread.toFixed(2)}s, CV=${coefficient.toFixed(2)}.`);
      score -= 30;
    } else if (narrowRatio > 0.82) {
      failures.push(`${Math.round(narrowRatio * 100)}% of pauses cluster around one timing value.`);
      score -= 24;
    } else if (spread < 0.14 || coefficient < 0.36 || narrowRatio > 0.72) {
      warnings.push(`Pause rhythm is still too regular (σ=${spread.toFixed(2)}s, CV=${coefficient.toFixed(2)}, cluster=${Math.round(narrowRatio * 100)}%).`);
      score -= 10;
    }
  } else if (substantialScene) {
    warnings.push(`Only ${metrics.pauseCount} measurable pauses across ${options.expectedTurnCount} scripted turns.`);
    score -= 6;
  }

  if (metrics.durationSec !== null && options.expectedTurnCount >= 5) {
    const secondsPerTurn = metrics.durationSec / options.expectedTurnCount;
    if (secondsPerTurn < 0.9) {
      failures.push(`Runaway/rushed render: ${secondsPerTurn.toFixed(2)} seconds per scripted turn.`);
      score -= 20;
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const minimumScore = highStakesScene ? 80 : 75;
  if (strict && failures.length === 0 && score < minimumScore) {
    failures.push(`Performance score ${score}/100 is below the ${minimumScore}/100 publishing floor.`);
  }
  return { passed: failures.length === 0 && (!strict || score >= minimumScore), score, failures, warnings, metrics };
}

export async function analyzeSpokenPerformanceBuffer(
  audioBuffer: Buffer,
  options: AnalyzeOptions
): Promise<SpokenPerformanceQaReport> {
  const ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobePath = options.ffprobePath || process.env.FFPROBE_PATH || "ffprobe";
  const extension = options.format === "wav" ? "wav" : "mp3";
  const token = crypto.randomBytes(8).toString("hex");
  const tempPath = path.join(os.tmpdir(), `take-machine-performance-${process.pid}-${token}.${extension}`);
  fs.writeFileSync(tempPath, audioBuffer);

  try {
    const [output, durationMs] = await Promise.all([
      runFfmpeg(ffmpegPath, [
        "-i", tempPath,
        "-af", "silencedetect=noise=-38dB:d=0.08,ebur128=peak=true",
        "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null",
      ]),
      getFileDurationMs(ffprobePath, tempPath),
    ]);

    const pauses = silences(output)
      .map((interval) => interval.end - interval.start)
      .filter((seconds) => seconds >= 0.08 && seconds <= 5);
    const pauseMean = mean(pauses);
    const pauseMedian = median(pauses);
    const pauseStdDev = stdDev(pauses, pauseMean);
    const narrowPauseRatio = pauseMedian === null || pauses.length === 0
      ? null
      : pauses.filter((seconds) => Math.abs(seconds - pauseMedian) <= 0.12).length / pauses.length;

    const metrics: SpokenPerformanceQaMetrics = {
      durationSec: durationMs / 1000,
      integratedLufs: lastNumber(output, /I:\s+(-?[\d.]+)\s+LUFS/),
      loudnessRangeLu: lastNumber(output, /LRA:\s+([\d.]+)\s+LU/),
      truePeakDb: lastNumber(output, /Peak:\s+(-?[\d.]+)\s+dBFS/),
      pauseCount: pauses.length,
      medianPauseSec: pauseMedian,
      meanPauseSec: pauseMean,
      pauseStdDevSec: pauseStdDev,
      pauseCoefficientOfVariation: pauseMean && pauseStdDev !== null ? pauseStdDev / pauseMean : null,
      narrowPauseRatio,
      longestPauseSec: pauses.length ? Math.max(...pauses) : 0,
    };

    return scoreSpokenPerformanceMetrics(metrics, options);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
  }
}
