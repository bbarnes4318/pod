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

export function runFfmpeg(ffmpegPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => (stdout += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout + stderr);
      } else {
        reject(new Error(`FFmpeg exited with code ${code}. Error: ${stderr.slice(-4000)}`));
      }
    });
  });
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

/** The four scripted pause lengths, in milliseconds. Single source of truth:
 *  planConversationTimeline uses these as its gap defaults, and the QA
 *  pause-variety check maps the script's `pauseBefore` values back through the
 *  same table so it measures the pacing we actually authored (not silence
 *  detected in the mastered mix, which the music bed masks). */
export const DEFAULT_PAUSE_MS: Record<"none" | "beat" | "breath" | "long", number> = {
  none: 80,
  beat: 300,
  breath: 650,
  long: 1100,
};

export interface PlannedLine {
  filePath: string;
  durationMs: number;
  lineIndex: number;
  /** 0 = host A, 1 = host B — used for stereo seating. */
  hostSlot: 0 | 1;
  pauseBefore?: "none" | "beat" | "breath" | "long";
  isInterruption?: boolean;
  /** Does a new script segment start at this line? */
  segmentBreak?: SegmentBreak;
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
  startAtMs?: number;
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
  const segmentGap = opts.segmentGapMs ?? envNum("AUDIO_SEGMENT_GAP_MS", 850);
  const topicGap = opts.topicGapMs ?? envNum("AUDIO_TOPIC_GAP_MS", 1200);
  const interruptOverlap = opts.interruptOverlapMs ?? envNum("AUDIO_INTERRUPT_OVERLAP_MS", 320);
  const jitterFraction = opts.jitterFraction ?? envNum("AUDIO_GAP_JITTER", 0.35);
  const stereoSpread = opts.stereoSpread ?? envNum("AUDIO_STEREO_SPREAD", 0.14);

  const clips: TimelineClip[] = [];
  let cursorMs = opts.startAtMs ?? 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const rand = mulberry32(0x9e3779b9 ^ (line.lineIndex + 1));

    let gapMs: number;
    if (i === 0) {
      gapMs = 0;
    } else if (line.isInterruption) {
      // Real interruption: bite into the previous speaker's tail.
      gapMs = -Math.min(
        interruptOverlap,
        Math.round(lines[i - 1].durationMs * 0.4)
      );
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
      pan: line.hostSlot === 0 ? -stereoSpread : stereoSpread,
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
        `lowpass=f=3800,highpass=f=90,aformat=sample_fmts=fltp:channel_layouts=stereo[room]`
    );
    mixLabels.push("[room]");
  }

  // Sum everything, then a gentle glue chain: high-pass rumble cut and a
  // slow 2:1 bus compressor so alternating voices feel like one recording.
  filterLines.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:normalize=0:dropout_transition=0[mix]`,
    `[mix]highpass=f=55,acompressor=threshold=-21dB:ratio=2:attack=15:release=250:makeup=1.5dB[out]`
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
