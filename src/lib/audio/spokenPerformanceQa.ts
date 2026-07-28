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
  analyzedPhraseCount: number;
  terminalFallRatio: number | null;
  medianTerminalPitchChangeSemitones: number | null;
  medianPhrasePitchRangeSemitones: number | null;
  phraseEnergyCoefficientOfVariation: number | null;
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

interface PhraseRegion {
  startSample: number;
  endSample: number;
  rms: number;
}

interface PitchPhraseMetrics {
  terminalChangeSemitones: number;
  rangeSemitones: number;
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

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p)));
  return sorted[index];
}

function stdDev(values: number[], average: number | null): number | null {
  if (!values.length || average === null) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function coefficientOfVariation(values: number[]): number | null {
  const average = mean(values);
  const spread = stdDev(values, average);
  return average && spread !== null ? spread / average : null;
}

function decodePcm16(buffer: Buffer): Float32Array {
  const sampleCount = Math.floor(buffer.length / 2);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index++) samples[index] = buffer.readInt16LE(index * 2) / 32768;
  return samples;
}

function windowRms(samples: Float32Array, start: number, end: number): number {
  const boundedStart = Math.max(0, Math.floor(start));
  const boundedEnd = Math.min(samples.length, Math.ceil(end));
  if (boundedEnd <= boundedStart) return 0;
  let sum = 0;
  for (let index = boundedStart; index < boundedEnd; index++) sum += samples[index] * samples[index];
  return Math.sqrt(sum / (boundedEnd - boundedStart));
}

function detectPhraseRegions(samples: Float32Array, sampleRate: number): PhraseRegion[] {
  const frameSize = Math.round(sampleRate * 0.02);
  const hopSize = Math.round(sampleRate * 0.01);
  const rmsFrames: number[] = [];
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    rmsFrames.push(windowRms(samples, start, start + frameSize));
  }
  if (!rmsFrames.length) return [];

  const noiseFloor = percentile(rmsFrames, 0.20);
  const activeThreshold = Math.max(0.006, noiseFloor * 3.2);
  const raw: Array<{ startFrame: number; endFrame: number }> = [];
  let open = -1;
  for (let frame = 0; frame < rmsFrames.length; frame++) {
    const active = rmsFrames[frame] >= activeThreshold;
    if (active && open < 0) open = frame;
    if (!active && open >= 0) {
      raw.push({ startFrame: open, endFrame: frame - 1 });
      open = -1;
    }
  }
  if (open >= 0) raw.push({ startFrame: open, endFrame: rmsFrames.length - 1 });

  const mergeGapFrames = Math.round(0.12 / 0.01);
  const merged: Array<{ startFrame: number; endFrame: number }> = [];
  for (const region of raw) {
    const previous = merged[merged.length - 1];
    if (previous && region.startFrame - previous.endFrame <= mergeGapFrames) previous.endFrame = region.endFrame;
    else merged.push({ ...region });
  }

  const minPhraseSamples = Math.round(sampleRate * 0.24);
  return merged
    .map((region) => {
      const startSample = region.startFrame * hopSize;
      const endSample = Math.min(samples.length, region.endFrame * hopSize + frameSize);
      return { startSample, endSample, rms: windowRms(samples, startSample, endSample) };
    })
    .filter((region) => region.endSample - region.startSample >= minPhraseSamples);
}

/** Fast normalized autocorrelation on one voiced slice. */
function estimatePitchHz(
  samples: Float32Array,
  startSample: number,
  endSample: number,
  sampleRate: number
): number | null {
  const start = Math.max(0, Math.floor(startSample));
  const end = Math.min(samples.length, Math.ceil(endSample));
  const length = end - start;
  if (length < sampleRate * 0.08) return null;

  let average = 0;
  for (let index = start; index < end; index++) average += samples[index];
  average /= length;
  let energy = 0;
  for (let index = start; index < end; index++) {
    const value = samples[index] - average;
    energy += value * value;
  }
  if (energy / length < 0.00001) return null;

  const minimumLag = Math.max(1, Math.floor(sampleRate / 320));
  const maximumLag = Math.min(length - 2, Math.ceil(sampleRate / 65));
  let bestLag = -1;
  let bestCorrelation = -1;
  for (let lag = minimumLag; lag <= maximumLag; lag++) {
    let cross = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    const stop = end - lag;
    for (let index = start; index < stop; index += 2) {
      const left = samples[index] - average;
      const right = samples[index + lag] - average;
      cross += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const denominator = Math.sqrt(leftEnergy * rightEnergy);
    const correlation = denominator > 0 ? cross / denominator : 0;
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }
  return bestLag > 0 && bestCorrelation >= 0.34 ? sampleRate / bestLag : null;
}

function phrasePitchMetrics(
  samples: Float32Array,
  region: PhraseRegion,
  sampleRate: number
): PitchPhraseMetrics | null {
  const length = region.endSample - region.startSample;
  const edgeInset = Math.min(Math.round(sampleRate * 0.05), Math.round(length * 0.08));
  const sliceLength = Math.min(Math.round(sampleRate * 0.28), Math.round(length * 0.38));
  if (sliceLength < sampleRate * 0.08) return null;

  const startPitch = estimatePitchHz(samples, region.startSample + edgeInset, region.startSample + edgeInset + sliceLength, sampleRate);
  const middleStart = region.startSample + Math.max(0, Math.round((length - sliceLength) / 2));
  const middlePitch = estimatePitchHz(samples, middleStart, middleStart + sliceLength, sampleRate);
  const endPitch = estimatePitchHz(samples, region.endSample - edgeInset - sliceLength, region.endSample - edgeInset, sampleRate);
  if (!startPitch || !endPitch) return null;

  const pitches = [startPitch, middlePitch, endPitch].filter((value): value is number => !!value && Number.isFinite(value));
  const semitones = pitches.map((pitch) => 12 * Math.log2(pitch));
  return {
    terminalChangeSemitones: 12 * Math.log2(endPitch / startPitch),
    rangeSemitones: Math.max(...semitones) - Math.min(...semitones),
  };
}

function analyzePcmProsody(pcmBuffer: Buffer, sampleRate: number): Pick<
  SpokenPerformanceQaMetrics,
  "analyzedPhraseCount" | "terminalFallRatio" | "medianTerminalPitchChangeSemitones" |
  "medianPhrasePitchRangeSemitones" | "phraseEnergyCoefficientOfVariation"
> {
  const samples = decodePcm16(pcmBuffer);
  const regions = detectPhraseRegions(samples, sampleRate);
  const pitch = regions
    .map((region) => phrasePitchMetrics(samples, region, sampleRate))
    .filter((value): value is PitchPhraseMetrics => value !== null);
  const terminalChanges = pitch.map((item) => item.terminalChangeSemitones);
  const ranges = pitch.map((item) => item.rangeSemitones);
  return {
    analyzedPhraseCount: pitch.length,
    terminalFallRatio: pitch.length ? terminalChanges.filter((change) => change <= -2).length / pitch.length : null,
    medianTerminalPitchChangeSemitones: median(terminalChanges),
    medianPhrasePitchRangeSemitones: median(ranges),
    phraseEnergyCoefficientOfVariation: coefficientOfVariation(regions.map((region) => region.rms)),
  };
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

  const minimumLra = highStakesScene ? 3.0 : substantialScene ? 2.6 : 1.2;
  if (metrics.loudnessRangeLu === null) {
    warnings.push("Loudness range could not be measured.");
    score -= 8;
  } else if (metrics.loudnessRangeLu < minimumLra) {
    if (substantialScene || highStakesScene) {
      failures.push(`Flat vocal dynamics: ${metrics.loudnessRangeLu.toFixed(1)} LU LRA; minimum ${minimumLra.toFixed(1)} LU for this scene.`);
      score -= 28;
    } else {
      warnings.push(`Short scene has only ${metrics.loudnessRangeLu.toFixed(1)} LU of measurable dynamics.`);
      score -= 8;
    }
  } else if ((substantialScene || highStakesScene) && metrics.loudnessRangeLu < minimumLra + 0.8) {
    warnings.push(`Limited vocal dynamics: ${metrics.loudnessRangeLu.toFixed(1)} LU LRA.`);
    score -= 8;
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

  if (substantialScene && metrics.pauseCount >= 4) {
    const coefficient = metrics.pauseCoefficientOfVariation ?? 0;
    const narrowRatio = metrics.narrowPauseRatio ?? 1;
    const spread = metrics.pauseStdDevSec ?? 0;
    if (spread < 0.10 && coefficient < 0.30) {
      failures.push(`Metronome pacing: pause σ=${spread.toFixed(2)}s, CV=${coefficient.toFixed(2)}.`);
      score -= 28;
    } else if (narrowRatio > 0.82) {
      failures.push(`${Math.round(narrowRatio * 100)}% of pauses cluster around one timing value.`);
      score -= 22;
    } else if (spread < 0.14 || coefficient < 0.36 || narrowRatio > 0.72) {
      warnings.push(`Pause rhythm is still too regular (σ=${spread.toFixed(2)}s, CV=${coefficient.toFixed(2)}, cluster=${Math.round(narrowRatio * 100)}%).`);
      score -= 9;
    }
  } else if (substantialScene) {
    warnings.push(`Only ${metrics.pauseCount} measurable pauses across ${options.expectedTurnCount} scripted turns.`);
    score -= 5;
  }

  // The latest failed episode ended nearly every phrase with the same steep
  // downward contour. That is a read-aloud signature even when combined LRA is
  // acceptable because two voices have different baseline levels.
  if (metrics.analyzedPhraseCount >= 6) {
    const fallRatio = metrics.terminalFallRatio ?? 0;
    const terminalChange = metrics.medianTerminalPitchChangeSemitones ?? 0;
    const phraseRange = metrics.medianPhrasePitchRangeSemitones ?? 99;
    const energyCv = metrics.phraseEnergyCoefficientOfVariation ?? 99;

    if (fallRatio >= 0.84 && terminalChange <= -2.5) {
      failures.push(
        `Read-aloud terminal cadence: ${Math.round(fallRatio * 100)}% of phrases fall by at least 2 semitones; median ending change ${terminalChange.toFixed(1)} semitones.`
      );
      score -= 32;
    } else if (fallRatio >= 0.74 && terminalChange <= -2) {
      warnings.push(`Repetitive terminal fall on ${Math.round(fallRatio * 100)}% of phrases (median ${terminalChange.toFixed(1)} semitones).`);
      score -= 12;
    }

    if (phraseRange < 1.1 && energyCv < 0.18) {
      failures.push(`Monotone phrase delivery: median pitch movement ${phraseRange.toFixed(1)} semitones and phrase-energy CV ${energyCv.toFixed(2)}.`);
      score -= 28;
    } else if (phraseRange < 1.5 && energyCv < 0.24) {
      warnings.push(`Limited within-phrase movement (${phraseRange.toFixed(1)} semitones; energy CV ${energyCv.toFixed(2)}).`);
      score -= 10;
    }
  } else if (substantialScene) {
    warnings.push(`Pitch audition could confidently analyze only ${metrics.analyzedPhraseCount} phrase(s).`);
    score -= 4;
  }

  if (metrics.durationSec !== null && options.expectedTurnCount >= 5) {
    const secondsPerTurn = metrics.durationSec / options.expectedTurnCount;
    if (secondsPerTurn < 0.9) {
      failures.push(`Runaway/rushed render: ${secondsPerTurn.toFixed(2)} seconds per scripted turn.`);
      score -= 20;
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const minimumScore = highStakesScene ? 80 : substantialScene ? 75 : 65;
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
  const pcmPath = path.join(os.tmpdir(), `take-machine-performance-${process.pid}-${token}.pcm`);
  const pcmSampleRate = 12000;
  fs.writeFileSync(tempPath, audioBuffer);

  try {
    const [output, durationMs] = await Promise.all([
      runFfmpeg(ffmpegPath, [
        "-i", tempPath,
        "-af", "silencedetect=noise=-38dB:d=0.08,ebur128=peak=true",
        "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null",
      ]),
      getFileDurationMs(ffprobePath, tempPath),
      runFfmpeg(ffmpegPath, [
        "-y", "-i", tempPath,
        "-vn", "-ac", "1", "-ar", String(pcmSampleRate),
        "-acodec", "pcm_s16le", "-f", "s16le", pcmPath,
      ]),
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
    const prosody = analyzePcmProsody(fs.readFileSync(pcmPath), pcmSampleRate);

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
      ...prosody,
    };
    return scoreSpokenPerformanceMetrics(metrics, options);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    try { fs.unlinkSync(pcmPath); } catch { /* best effort */ }
  }
}
