// Conversation-aware audio assembly.
//
// The old pipeline concatenated every MP3 line with fixed-length silence between
// every line (hard cuts, identical 450ms gaps, no shared acoustic space) —
// the classic "spliced TTS clips" sound. This module instead:
//
//   1. Plans a timeline: every clip gets an absolute start time. Gaps vary
//      with the script's delivery metadata (pauseBefore), get deterministic
//      human jitter, and interruptions genuinely OVERLAP the previous line.
//   2. Renders the timeline in a single ffmpeg mix (adelay + amix), with
//      per-clip micro-fades (kills concat clicks), light stereo seating so
//      the two hosts sit like two people in a room, and a continuous low
//      room-tone bed so the "air" never cuts to digital black between turns.
//   3. Masters with two-pass loudnorm (linear gain — no pumping) to the
//      podcast-standard integrated loudness.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";

// Force single-threaded filtering + coding so the render is BYTE-DETERMINISTIC.
// Multi-threaded ffmpeg reorders float accumulation (amix/filters) run-to-run
// depending on CPU scheduling, which made otherwise-identical renders produce
// different master bytes. Slower, but the pipeline is offline and determinism
// is a hard requirement (PR 4). Applied to EVERY ffmpeg call from one place.
// -cpuflags 0 forces ffmpeg's reference C implementations instead of SIMD
// (SSE/AVX) kernels. The vectorized kernels can accumulate floats in a
// different order than the scalar path, so under heavy process churn a render
// can occasionally land on a different rounding and produce different master
// bytes across separate processes. The reference path is bit-identical
// regardless of CPU dispatch or scheduling. Slower, but the pipeline is offline
// and cross-process determinism is a hard requirement (PR 4).
const DETERMINISTIC_FFMPEG_FLAGS = ["-nostdin", "-cpuflags", "0", "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1", "-fflags", "+bitexact", "-flags", "+bitexact"];

// IIR biquad filters (highpass/lowpass/bandpass/…) keep recursive state. In the
// default direct-form-I / f32 path, that state can decay into DENORMAL floats on
// the near-silent tails of faded/overlapping speech. Denormal arithmetic depends
// on the process FPU mode (MXCSR flush-to-zero), which is NOT bit-stable across
// separate ffmpeg processes on Windows — so the SAME inputs + SAME filter graph
// produced different master bytes intermittently (bisected to `highpass` after
// the foreground amix: ~21/24 renders diverged). Running the biquad state in
// double precision keeps it far above the f64 denormal floor for any audio-range
// signal, making every biquad bit-reproducible. Append to EVERY biquad filter.
const BIQUAD_DET = "precision=f64";

/** Transient Windows process-spawn crashes (STATUS_DLL_INIT_FAILED /
 *  heap-exhaustion under heavy ffmpeg churn) — retryable; a retry is byte-safe
 *  because the render is deterministic. */
const TRANSIENT_FFMPEG_CODES = new Set([3221225794, 3221226505]); // 0xC0000142, 0xC0000409
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<string> {
  const attempt = () => new Promise<string>((resolve, reject) => {
    const proc = spawn(ffmpegPath, [...DETERMINISTIC_FFMPEG_FLAGS, ...args]);
    let stdout = "";
    let stderr = "";
    proc.on("error", (err) => reject(Object.assign(err, { transient: true })));
    proc.stdout.on("data", (data) => (stdout += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout + stderr);
      else reject(Object.assign(new Error(`FFmpeg exited with code ${code}. Error: ${stderr.slice(-4000)}`), { transient: code != null && TRANSIENT_FFMPEG_CODES.has(code) }));
    });
  });
  for (let tries = 0; ; tries++) {
    try { return await attempt(); }
    catch (err) {
      // Windows can transiently fail to spawn ffmpeg under heavy churn; back off
      // and retry generously (a retry is byte-safe — the render is deterministic).
      if ((err as { transient?: boolean }).transient && tries < 6) { await delay(400 * (tries + 1)); continue; }
      throw err;
    }
  }
}

export function runFfprobe(ffprobePath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath, args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => (stdout += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`FFprobe exited with code ${code}. Error: ${stderr.slice(-4000)}`));
      }
    });
  });
}

export async function getFileDurationMs(ffprobePath: string, filePath: string): Promise<number> {
  const output = await runFfprobe(ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const sec = parseFloat(output);
  if (isNaN(sec)) {
    throw new Error(`Could not read duration of ${filePath}`);
  }
  return Math.round(sec * 1000);
}

/**
 * Leading/trailing silence of a clip, in ms. TTS clips ship with ~50ms of
 * lead-in and 150-280ms of tail padding; an interruption overlap that only
 * eats that padding sounds like polite turn-taking, not a cut-in, so the
 * timeline planner widens interruption overlaps by exactly this much.
 */
export async function measureEdgeSilenceMs(
  ffmpegPath: string,
  filePath: string,
  opts: { noiseDb?: number; minSilenceMs?: number } = {}
): Promise<{ leadMs: number; tailMs: number }> {
  const noiseDb = opts.noiseDb ?? -40;
  const minSilenceSec = (opts.minSilenceMs ?? 50) / 1000;
  const out = await runFfmpeg(ffmpegPath, [
    "-i", filePath,
    "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
    "-f", "null", "-",
  ]);
  const starts = [...out.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...out.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
  let leadMs = 0;
  if (starts.length > 0 && starts[0] <= 0.02 && ends.length > 0) {
    leadMs = Math.max(0, Math.round(ends[0] * 1000));
  }
  let tailMs = 0;
  // A final silence_start without a matching silence_end (or one ending at
  // EOF) means the clip fades to silence and stays there.
  if (starts.length > 0 && starts.length > ends.length) {
    const durMatch = out.match(/time=(\d+):(\d+):([\d.]+)/g);
    const last = durMatch?.[durMatch.length - 1]?.match(/time=(\d+):(\d+):([\d.]+)/);
    if (last) {
      const totalSec = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
      tailMs = Math.max(0, Math.round((totalSec - starts[starts.length - 1]) * 1000));
    }
  }
  return { leadMs, tailMs };
}

/**
 * Decode any source clip to a standardized WAV at a consistent speech
 * loudness so no host is louder than the other before the mix.
 */
export async function standardizeClipToWav(
  ffmpegPath: string,
  inPath: string,
  outPath: string,
  opts: { sampleRate?: number; targetLufs?: number } = {}
): Promise<string> {
  const sampleRate = opts.sampleRate || 44100;
  const targetLufs = opts.targetLufs ?? -18;
  await runFfmpeg(ffmpegPath, [
    "-y",
    "-i", inPath,
    "-af", `loudnorm=I=${targetLufs}:TP=-2:LRA=11,aresample=${sampleRate}`,
    "-ar", String(sampleRate),
    "-ac", "2",
    "-c:a", "pcm_s16le",
    outPath,
  ]);
  return outPath;
}

export type SegmentBreak = "none" | "segment" | "topic";

// Single source of truth for pause lengths lives in pauseTiming.ts (pure, so
// UI view-models can share it); re-exported here for existing importers.
import { DEFAULT_PAUSE_MS, DEFAULT_SEGMENT_GAP_MS, DEFAULT_TOPIC_GAP_MS } from "./pauseTiming";
export { DEFAULT_PAUSE_MS };

export interface PlannedLine {
  filePath: string;
  durationMs: number;
  lineIndex: number;
  /** Seat index (0-3) — used for stereo seating. The two-host debate keeps
   *  its classic left/right pair; 1-4 voices spread across the field via
   *  seatPan(). */
  hostSlot: number;
  pauseBefore?: "none" | "beat" | "breath" | "long";
  isInterruption?: boolean;
  /** Does a new script segment start at this line? */
  segmentBreak?: SegmentBreak;
  /** Per-line base gap override (before jitter). The stitcher sets this on a
   *  break line to fit the SPECIFIC stinger cued there — the v10 bug was
   *  widening EVERY break to fit the longest stinger in the episode. */
  breakGapBaseMs?: number;
  /** Post-jitter floor for this line's gap (e.g. stinger duration + margin so
   *  a right-aligned stinger can never start before the previous line ends). */
  breakGapMinMs?: number;
  /** Measured silence at the head of this clip (TTS lead-in padding). */
  leadSilenceMs?: number;
  /** Measured silence at the tail of this clip (TTS tail padding). */
  tailSilenceMs?: number;
}

export interface TimelineClip {
  filePath: string;
  startMs: number;
  durationMs: number;
  kind: "speech" | "music" | "sfx";
  /** -1 (hard left) .. 1 (hard right); small values only. */
  pan: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** Extra gain in dB applied to this clip in the mix. */
  gainDb: number;
}

export interface TimelinePlanOptions {
  pauseNoneMs?: number;
  pauseBeatMs?: number;
  pauseBreathMs?: number;
  pauseLongMs?: number;
  segmentGapMs?: number;
  topicGapMs?: number;
  /** How far an interrupting line bites into the previous line's tail. */
  interruptOverlapMs?: number;
  /** 0..1 — fraction of random variation applied to every gap. */
  jitterFraction?: number;
  /** 0..1 — stereo seating amount (0 = both centered). */
  stereoSpread?: number;
  /** Number of cast seats (1-4). Drives seatPan(); default 2 keeps the
   *  classic two-host left/right seating. */
  castSize?: number;
  startAtMs?: number;
}

/**
 * Stereo position for a seat (Prompt 7): 1 voice sits center; 2 keep the
 * classic left/right pair; 3 sit left/center/right; 4 spread evenly across
 * the field. Deterministic, and for castSize=2 EXACTLY the legacy pan values.
 */
export function seatPan(seatIndex: number, castSize: number, stereoSpread: number): number {
  const n = Math.max(1, Math.min(4, Math.floor(castSize) || 2));
  if (n === 1) return 0;
  const seat = Math.max(0, Math.min(n - 1, seatIndex));
  // Evenly spaced positions from -1 to +1: 2 -> [-1,+1]; 3 -> [-1,0,+1];
  // 4 -> [-1,-1/3,+1/3,+1]. Scaled by the spread amount.
  const position = -1 + (2 * seat) / (n - 1);
  return position * stereoSpread;
}

// Deterministic PRNG so the same script always renders the same timing
// (important for reproducible QA and regression comparison).
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== ""
    ? v
    : fallback;
}

export function planConversationTimeline(
  lines: PlannedLine[],
  opts: TimelinePlanOptions = {}
): TimelineClip[] {
  const pauseNone = opts.pauseNoneMs ?? envNum("AUDIO_PAUSE_NONE_MS", DEFAULT_PAUSE_MS.none);
  const pauseBeat = opts.pauseBeatMs ?? envNum("AUDIO_PAUSE_BEAT_MS", DEFAULT_PAUSE_MS.beat);
  const pauseBreath = opts.pauseBreathMs ?? envNum("AUDIO_PAUSE_BREATH_MS", DEFAULT_PAUSE_MS.breath);
  const pauseLong = opts.pauseLongMs ?? envNum("AUDIO_PAUSE_LONG_MS", DEFAULT_PAUSE_MS.long);
  const segmentGap = opts.segmentGapMs ?? envNum("AUDIO_SEGMENT_GAP_MS", DEFAULT_SEGMENT_GAP_MS);
  const topicGap = opts.topicGapMs ?? envNum("AUDIO_TOPIC_GAP_MS", DEFAULT_TOPIC_GAP_MS);
  const interruptOverlap = opts.interruptOverlapMs ?? envNum("AUDIO_INTERRUPT_OVERLAP_MS", 320);
  const jitterFraction = opts.jitterFraction ?? envNum("AUDIO_GAP_JITTER", 0.35);
  const stereoSpread = opts.stereoSpread ?? envNum("AUDIO_STEREO_SPREAD", 0.14);
  // Seat count for pan positions: explicit option wins, else the largest seat
  // index seen in the lines (legacy callers pass none and two-seat lines ->
  // castSize 2, the classic seating).
  const castSize = opts.castSize ?? Math.max(2, ...lines.map((l) => l.hostSlot + 1));

  const clips: TimelineClip[] = [];
  let cursorMs = opts.startAtMs ?? 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const rand = mulberry32(0x9e3779b9 ^ (line.lineIndex + 1));

    let gapMs: number;
    if (i === 0) {
      gapMs = 0;
    } else if (line.isInterruption) {
      // Real interruption: bite into the previous speaker's tail. The bite
      // must land on VOICE — TTS clips carry ~50ms lead-in and 150-280ms tail
      // padding, and an overlap that only eats that padding renders as polite
      // turn-taking. Widen the overlap by the measured edge silence so the
      // audible voice-on-voice overlap is the configured window, clamped so
      // the interruption never swallows 40% of the previous line.
      const edgeSilence =
        (lines[i - 1].tailSilenceMs ?? 0) + (line.leadSilenceMs ?? 0);
      gapMs = -Math.min(
        interruptOverlap + edgeSilence,
        Math.round(lines[i - 1].durationMs * 0.4)
      );
    } else if (line.breakGapBaseMs !== undefined) {
      // Stinger-fitted break: the floor holds the asset (it must fully fit,
      // right-aligned, without touching the previous line), and jitter applies
      // ONLY to the padding above the floor — jittering the asset's own
      // duration would reopen multi-second silence before the stinger starts.
      const floor = Math.max(40, line.breakGapMinMs ?? 40);
      const pad = Math.max(0, line.breakGapBaseMs - floor);
      const jitter = 1 + (rand() * 2 - 1) * jitterFraction;
      gapMs = floor + Math.round(pad * jitter);
    } else {
      const base =
        line.segmentBreak === "topic"
          ? topicGap
          : line.segmentBreak === "segment"
            ? segmentGap
            : line.pauseBefore === "none"
              ? pauseNone
              : line.pauseBefore === "breath"
                ? pauseBreath
                : line.pauseBefore === "long"
                  ? pauseLong
                  : pauseBeat;
      // Humans never leave identical gaps twice; jitter each one.
      const jitter = 1 + (rand() * 2 - 1) * jitterFraction;
      gapMs = Math.max(40, Math.round(base * jitter));
    }

    const startMs = Math.max(0, cursorMs + gapMs);

    clips.push({
      filePath: line.filePath,
      startMs,
      durationMs: line.durationMs,
      kind: "speech",
      pan: seatPan(line.hostSlot, castSize, stereoSpread),
      fadeInMs: 4,
      fadeOutMs: 8,
      gainDb: 0,
    });

    cursorMs = startMs + line.durationMs;
  }

  return clips;
}

export interface RenderOptions {
  sampleRate?: number;
  /** Room-tone bed level in dBFS; set to -100 or lower to disable. */
  roomToneDb?: number;
  /** Milliseconds of room tone to keep after the last clip ends. */
  tailMs?: number;
}

/**
 * Render a planned timeline into a single WAV using one ffmpeg mix graph.
 * Overlaps (interruptions, music crossfades) mix naturally because every
 * clip is placed at an absolute time and summed, never concatenated.
 */
export async function renderTimelineToWav(
  ffmpegPath: string,
  clips: TimelineClip[],
  outPath: string,
  opts: RenderOptions = {}
): Promise<string> {
  if (clips.length === 0) {
    throw new Error("Cannot render an empty timeline.");
  }

  const sampleRate = opts.sampleRate || 44100;
  const roomToneDb = opts.roomToneDb ?? envNum("AUDIO_ROOM_TONE_DB", -58);
  const tailMs = opts.tailMs ?? 700;

  const endMs = Math.max(...clips.map((c) => c.startMs + c.durationMs)) + tailMs;
  const totalSec = (endMs / 1000).toFixed(3);

  const inputs: string[] = [];
  const filterLines: string[] = [];
  const mixLabels: string[] = [];

  clips.forEach((clip, idx) => {
    inputs.push("-i", clip.filePath);
    const fadeOutStart = Math.max(0, clip.durationMs - clip.fadeOutMs) / 1000;
    const l = clip.pan <= 0 ? 1 : 1 - clip.pan;
    const r = clip.pan >= 0 ? 1 : 1 + clip.pan;
    const gain = clip.gainDb !== 0 ? `,volume=${clip.gainDb}dB` : "";
    filterLines.push(
      `[${idx}:a]aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `afade=t=in:d=${(clip.fadeInMs / 1000).toFixed(3)},` +
        `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${(clip.fadeOutMs / 1000).toFixed(3)},` +
        `pan=stereo|c0=${l.toFixed(3)}*c0|c1=${r.toFixed(3)}*c1${gain},` +
        `adelay=${clip.startMs}|${clip.startMs}[c${idx}]`
    );
    mixLabels.push(`[c${idx}]`);
  });

  // Continuous room-tone bed: quiet filtered pink noise for the whole
  // timeline, so every voice sits in the same "air" and gaps never drop to
  // pure digital silence.
  const includeRoomTone = roomToneDb > -100;
  if (includeRoomTone) {
    const amplitude = Math.pow(10, roomToneDb / 20).toFixed(6);
    filterLines.push(
      `anoisesrc=color=pink:sample_rate=${sampleRate}:amplitude=${amplitude}:seed=1337:duration=${totalSec},` +
        `lowpass=f=3800:${BIQUAD_DET},highpass=f=90:${BIQUAD_DET},aformat=sample_fmts=fltp:channel_layouts=stereo[room]`
    );
    mixLabels.push("[room]");
  }

  // Sum everything, then a gentle glue chain: high-pass rumble cut and a
  // slow 2:1 bus compressor so alternating voices feel like one recording.
  filterLines.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:normalize=0:dropout_transition=0[mix]`,
    `[mix]highpass=f=55:${BIQUAD_DET},acompressor=threshold=-21dB:ratio=2:attack=15:release=250:makeup=1.5dB[out]`
  );

  // Filter graphs for long episodes exceed command-line limits — always use
  // a filter script file.
  const filterScriptPath = path.join(
    path.dirname(outPath),
    `${path.basename(outPath, path.extname(outPath))}-filter.txt`
  );
  fs.writeFileSync(filterScriptPath, filterLines.join(";\n"));

  await runFfmpeg(ffmpegPath, [
    "-y",
    ...inputs,
    "-filter_complex_script", filterScriptPath,
    "-map", "[out]",
    "-t", totalSec,
    "-ar", String(sampleRate),
    "-c:a", "pcm_s16le",
    outPath,
  ]);

  return outPath;
}

/**
 * Two-pass loudnorm master: measure, then apply with linear gain.
 * Single-pass loudnorm rides gain dynamically and audibly "pumps" on
 * conversational material — never use it for the final master.
 */
export async function masterToMp3(
  ffmpegPath: string,
  inPath: string,
  outPath: string,
  opts: { targetLufs?: number; bitrate?: string } = {}
): Promise<string> {
  const targetLufs = opts.targetLufs ?? -16;
  const bitrate = opts.bitrate || process.env.AUDIO_TARGET_BITRATE || "192k";

  const measureOut = await runFfmpeg(ffmpegPath, [
    "-i", inPath,
    "-af", `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:print_format=json`,
    "-f", "null",
    process.platform === "win32" ? "NUL" : "/dev/null",
  ]);

  const jsonMatch = measureOut.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  let loudnormFilter = `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`;
  if (jsonMatch) {
    try {
      const m = JSON.parse(jsonMatch[0]);
      loudnormFilter =
        `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:` +
        `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:` +
        `measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
    } catch {
      // fall back to dynamic mode if the measurement JSON is malformed
    }
  }

  await runFfmpeg(ffmpegPath, [
    "-y",
    "-i", inPath,
    "-af", loudnormFilter,
    "-ar", "44100",
    "-c:a", "libmp3lame",
    "-b:a", bitrate,
    outPath,
  ]);

  return outPath;
}
