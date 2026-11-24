// Business scene re-timing: keep the one-block performance, fix the hand-offs.
//
// Owner A/B, Milestone 2 (same words, same voices):
//   - one-block Fish scenes: the hosts react to each other, but Fish picks
//     every hand-off gap (near-uniform) and can never put two voices on top
//     of each other, so marked interruptions never cut in;
//   - each line voiced alone with planned timing: timing fixed, but every
//     voice reads cold, without hearing the other host;
//   - one-block scene, then the hand-offs re-placed: judged "BETTER".
// This module does the third. Inside one rendered scene it finds each
// SPEAKER HAND-OFF (never a pause inside one host's turn), cuts there, and
// re-places the turns with conversational timing. A hand-off it cannot find
// confidently is left exactly as performed — it never cuts a word.

import fs from "fs";
import path from "path";
import { runFfmpeg, getFileDurationMs, type TimelineClip } from "./assembly";

export interface SceneTurn {
  /** Host speaking this turn (consecutive lines by one host form one turn). */
  speakerHostId: string;
  /** Spoken characters in the turn (drives the position estimate). */
  chars: number;
  /** First line of this turn was written as an interruption. */
  isInterruption: boolean;
  /** Pause the writer marked before the first line of this turn. */
  pauseBefore?: string;
  /** Words in the turn (short replies land fast). */
  words: number;
  /** Script line indexes in this turn, for logs. */
  lineIndexes: number[];
}

export interface Silence {
  startMs: number;
  endMs: number;
}

/** Group a scene's lines into speaker turns, in order. */
export function turnsFromLines(
  lines: { lineIndex: number; speakerHostId: string; text: string; isInterruption?: boolean; pauseBefore?: string }[]
): SceneTurn[] {
  const turns: SceneTurn[] = [];
  for (const l of lines) {
    const text = l.text.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
    const last = turns[turns.length - 1];
    if (last && last.speakerHostId === l.speakerHostId) {
      last.chars += text.length + 1;
      last.words += text.split(" ").filter(Boolean).length;
      last.lineIndexes.push(l.lineIndex);
    } else {
      turns.push({
        speakerHostId: l.speakerHostId,
        chars: text.length,
        isInterruption: l.isInterruption === true,
        pauseBefore: l.pauseBefore,
        words: text.split(" ").filter(Boolean).length,
        lineIndexes: [l.lineIndex],
      });
    }
  }
  return turns;
}

/** Parse ffmpeg silencedetect output into intervals (ms). */
export function parseSilences(ffmpegOutput: string): Silence[] {
  const starts = [...ffmpegOutput.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]) * 1000);
  const ends = [...ffmpegOutput.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]) * 1000);
  const out: Silence[] = [];
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    if (ends[i] > starts[i]) out.push({ startMs: Math.max(0, Math.round(starts[i])), endMs: Math.round(ends[i]) });
  }
  return out;
}

/**
 * Locate each hand-off. The expected position comes from the turns' text
 * lengths across the speech span; the hand-off is the pause nearest to it
 * within a window. Silences are used at most once and in order. A hand-off
 * with no pause in its window is null (left as performed).
 */
export function locateHandoffs(
  turns: SceneTurn[],
  silences: Silence[],
  speechStartMs: number,
  speechEndMs: number,
  opts: { windowMs?: number } = {}
): (Silence | null)[] {
  const total = turns.reduce((a, t) => a + t.chars, 0) || 1;
  const span = Math.max(1, speechEndMs - speechStartMs);
  const window = opts.windowMs ?? Math.max(1500, Math.round(span * 0.05));
  const inner = silences.filter((s) => s.startMs > speechStartMs && s.endMs < speechEndMs);
  const found: (Silence | null)[] = [];
  let cum = 0;
  let lastEnd = speechStartMs;
  for (let k = 0; k < turns.length - 1; k++) {
    cum += turns[k].chars;
    const expected = speechStartMs + (cum / total) * span;
    // A hand-off is usually the LONGER pause: a host's own sentence breaks
    // are short. Score = distance minus 4x the pause length (a pause 100 ms
    // longer counts as 400 ms closer). In the owner-approved test render the
    // nearest pause was the beat after "Fine —" inside the next host's turn;
    // the real hand-off was the 450 ms pause just before it.
    let best: Silence | null = null;
    let bestScore = Infinity;
    for (const s of inner) {
      if (s.startMs <= lastEnd) continue;
      const mid = (s.startMs + s.endMs) / 2;
      const d = Math.abs(mid - expected);
      if (d > window) continue;
      const score = d - 4 * (s.endMs - s.startMs);
      if (score < bestScore) { best = s; bestScore = score; }
    }
    found.push(best);
    if (best) lastEnd = best.endMs;
  }
  return found;
}

// Deterministic per-scene randomness: the same script always renders the same timing.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HandoffTiming {
  /** Gap from the previous turn's last word to this turn's first word; negative = overlap. */
  gapMs: number;
  kind: "cut-in" | "latch" | "quick" | "pause";
}

/**
 * The owner-approved timing ("as long as it's not the second host
 * interrupting 100% of the time"):
 *  - a marked interruption is a real overlap about 70% of the time
 *    (200-450 ms), otherwise a latched reply (20-70 ms);
 *  - no host gets two hard cut-ins within three turns;
 *  - a short reply (<= 8 words) lands fast (60-150 ms);
 *  - otherwise a varied pause (150-400 ms, +150 ms where the writer marked a beat).
 */
export function planHandoffs(turns: SceneTurn[], seed: number): HandoffTiming[] {
  const rand = mulberry32(seed);
  const lastCut = new Map<string, number>();
  const out: HandoffTiming[] = [];
  for (let k = 1; k < turns.length; k++) {
    const t = turns[k];
    const r1 = rand();
    const r2 = rand();
    if (t.isInterruption) {
      const recent = lastCut.get(t.speakerHostId);
      if ((recent === undefined || k - recent >= 3) && r1 < 0.7) {
        out.push({ gapMs: -(200 + Math.round(r2 * 250)), kind: "cut-in" });
        lastCut.set(t.speakerHostId, k);
      } else {
        out.push({ gapMs: 20 + Math.round(r2 * 50), kind: "latch" });
      }
    } else if (t.words <= 8) {
      out.push({ gapMs: 60 + Math.round(r2 * 90), kind: "quick" });
    } else {
      out.push({ gapMs: 150 + Math.round(r2 * 250) + (t.pauseBefore === "beat" || t.pauseBefore === "long" ? 150 : 0), kind: "pause" });
    }
  }
  return out;
}

/** Plain sum of placed clips: no room tone, no compression (the final episode
 *  mix adds those once; doing it here too would flatten the scene twice). */
async function mixPlain(ffmpegPath: string, clips: TimelineClip[], outPath: string, sampleRate: number) {
  const inputs: string[] = [];
  const lines: string[] = [];
  clips.forEach((c, i) => {
    inputs.push("-i", c.filePath);
    const fadeOutStart = Math.max(0, c.durationMs - c.fadeOutMs) / 1000;
    lines.push(
      `[${i}:a]aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `afade=t=in:d=${(c.fadeInMs / 1000).toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${(c.fadeOutMs / 1000).toFixed(3)},` +
        `volume=${c.gainDb}dB,adelay=${Math.round(c.startMs)}|${Math.round(c.startMs)}[c${i}]`
    );
  });
  lines.push(`${clips.map((_, i) => `[c${i}]`).join("")}amix=inputs=${clips.length}:normalize=0:dropout_transition=0[out]`);
  const script = `${outPath}.filter.txt`;
  fs.writeFileSync(script, lines.join(";\n"));
  await runFfmpeg(ffmpegPath, ["-y", ...inputs, "-filter_complex_script", script, "-map", "[out]", "-ar", String(sampleRate), "-c:a", "pcm_s16le", outPath]);
}

async function cut(ffmpegPath: string, src: string, dst: string, fromMs: number, toMs: number) {
  await runFfmpeg(ffmpegPath, [
    "-y", "-i", src, "-af", `atrim=${(fromMs / 1000).toFixed(3)}:${(toMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS`,
    "-c:a", "pcm_s16le", dst,
  ]);
}

export interface RetimeResult {
  filePath: string;
  durationMs: number;
  handoffs: { lines: number[]; kind: string; gapMs: number; before: number | null }[];
  untouched: number;
}

/**
 * Re-time the hand-offs of one rendered scene WAV. Returns the original file
 * unchanged when there is nothing to re-time.
 */
export async function retimeSceneHandoffs(input: {
  ffmpegPath: string;
  ffprobePath: string;
  sceneWav: string;
  turns: SceneTurn[];
  seed: number;
  workDir: string;
  sampleRate: number;
}): Promise<RetimeResult> {
  const { ffmpegPath, ffprobePath, sceneWav, turns, workDir } = input;
  const durationMs = await getFileDurationMs(ffprobePath, sceneWav);
  if (turns.length < 2) return { filePath: sceneWav, durationMs, handoffs: [], untouched: 0 };

  const det = await runFfmpeg(ffmpegPath, ["-hide_banner", "-nostats", "-i", sceneWav, "-af", "silencedetect=noise=-38dB:d=0.12", "-f", "null", "-"]);
  const silences = parseSilences(det);
  const lead = silences.find((s) => s.startMs <= 5);
  const tail = silences.find((s) => s.endMs >= durationMs - 20);
  const speechStart = lead ? lead.endMs : 0;
  const speechEnd = tail ? tail.startMs : durationMs;
  const found = locateHandoffs(turns, silences, speechStart, speechEnd);
  const timing = planHandoffs(turns, input.seed);

  // Pieces: cut at the middle of each located hand-off pause. A hand-off that
  // was not located joins its two turns into one piece (left as performed).
  interface Piece { fromMs: number; toMs: number; speechStartMs: number; speechEndMs: number; firstTurn: number }
  const pieces: Piece[] = [{ fromMs: 0, toMs: durationMs, speechStartMs: speechStart, speechEndMs: speechEnd, firstTurn: 0 }];
  const handoffs: RetimeResult["handoffs"] = [];
  let untouched = 0;
  found.forEach((s, k) => {
    const t = timing[k];
    if (!s) {
      untouched++;
      handoffs.push({ lines: turns[k + 1].lineIndexes, kind: "left as performed", gapMs: 0, before: null });
      return;
    }
    const cur = pieces[pieces.length - 1];
    const mid = Math.round((s.startMs + s.endMs) / 2);
    pieces[pieces.length - 1] = { ...cur, toMs: mid, speechEndMs: s.startMs };
    pieces.push({ fromMs: mid, toMs: durationMs, speechStartMs: s.endMs, speechEndMs: speechEnd, firstTurn: k + 1 });
    handoffs.push({ lines: turns[k + 1].lineIndexes, kind: t.kind, gapMs: t.gapMs, before: s.endMs - s.startMs });
  });
  if (pieces.length === 1) return { filePath: sceneWav, durationMs, handoffs, untouched };

  fs.mkdirSync(workDir, { recursive: true });
  const clips: TimelineClip[] = [];
  let prevSpeechEndAbs = 0;
  for (let p = 0; p < pieces.length; p++) {
    const piece = pieces[p];
    const file = path.join(workDir, `piece-${p}.wav`);
    await cut(ffmpegPath, sceneWav, file, piece.fromMs, piece.toMs);
    const relSpeechStart = piece.speechStartMs - piece.fromMs;
    const gap = p === 0 ? 0 : timing[piece.firstTurn - 1].gapMs;
    const startMs = p === 0 ? 0 : Math.max(0, prevSpeechEndAbs + gap - relSpeechStart);
    const len = piece.toMs - piece.fromMs;
    clips.push({ filePath: file, startMs, durationMs: len, kind: "speech", pan: 0, fadeInMs: 8, fadeOutMs: 12, gainDb: 0 });
    prevSpeechEndAbs = startMs + (piece.speechEndMs - piece.fromMs);
  }
  // Under a real cut-in the interrupted host drops back (-6 dB) instead of
  // two voices at full level: re-cut that piece's tail as a separate, quieter clip.
  for (let p = 1; p < pieces.length; p++) {
    const t = timing[pieces[p].firstTurn - 1];
    if (t.kind !== "cut-in") continue;
    const prev = clips[p - 1];
    const overlapStartRel = clips[p].startMs + (pieces[p].speechStartMs - pieces[p].fromMs) - prev.startMs;
    if (overlapStartRel <= 0 || overlapStartRel >= prev.durationMs) continue;
    const head = path.join(workDir, `piece-${p - 1}-head.wav`);
    const tailF = path.join(workDir, `piece-${p - 1}-tail.wav`);
    const src = pieces[p - 1];
    await cut(ffmpegPath, sceneWav, head, src.fromMs, src.fromMs + overlapStartRel);
    await cut(ffmpegPath, sceneWav, tailF, src.fromMs + overlapStartRel, src.toMs);
    clips[p - 1] = { ...prev, filePath: head, durationMs: overlapStartRel, fadeOutMs: 30 };
    clips.push({ ...prev, filePath: tailF, startMs: prev.startMs + overlapStartRel, durationMs: prev.durationMs - overlapStartRel, fadeInMs: 30, gainDb: -6 });
  }
  const out = path.join(workDir, "retimed.wav");
  await mixPlain(ffmpegPath, clips, out, input.sampleRate);
  return { filePath: out, durationMs: await getFileDurationMs(ffprobePath, out), handoffs, untouched };
}
