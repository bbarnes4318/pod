// Post-production sound design: the layer between raw TTS dialogue and the
// final master that makes an episode sound PRODUCED — theme in/out, stingers
// on topic changes, reaction SFX on emotional beats, and a music bed that
// ducks under speech via sidechain compression.
//
// Design rules (see docs/SOUND_DESIGN.md):
//   - Voice is the anchor. Everything else sits under it in the mix.
//   - SFX land on emotional beats only, never sprinkled — placement is
//     driven by the script's existing tone/energy metadata and rate-limited
//     by the configured density. Deterministic PRNG → same script + same
//     settings = same mix (reproducible QA).
//   - The bed is ducked by the FOREGROUND mix (speech + SFX): dialogue
//     always dominates; the bed breathes back up in gaps.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runFfmpeg } from "./assembly";
import type { ProductionStyle, SfxDensity } from "./soundDesignShared";

/** Decode a WAV to mono s16 PCM at `sampleRate` and compute a DETERMINISTIC
 *  duck-gain envelope: 1.0 where the key is quiet, dropping toward `duckFloor`
 *  where the key exceeds `threshold`, smoothed by attack/release. Written as a
 *  mono s16 WAV (a 0..1 gain signal) that `amultiply` applies to the bed —
 *  replacing ffmpeg's `sidechaincompress`, which is NOT bit-reproducible on this
 *  build (its sidechain float state varies run to run). Pure given the key file. */
function writeDuckEnvelopeWav(ffmpegPath: string, keyWav: string, outWav: string, cfg: { sampleRate: number; totalMs: number; threshold: number; duckFloorDb: number; attackMs: number; releaseMs: number }): void {
  const sr = cfg.sampleRate;
  const total = Math.max(1, Math.round((cfg.totalMs / 1000) * sr));
  // Decode the key to raw mono s16 at the render rate (deterministic).
  const raw = execFileSync(ffmpegPath, ["-nostdin", "-cpuflags", "0", "-threads", "1", "-filter_threads", "1", "-fflags", "+bitexact", "-flags", "+bitexact", "-i", keyWav, "-ac", "1", "-ar", String(sr), "-f", "s16le", "-c:a", "pcm_s16le", "-"], { maxBuffer: 1 << 30 });
  const key = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
  const duckFloor = Math.pow(10, -Math.abs(cfg.duckFloorDb) / 20);
  const aCoef = 1 - Math.exp(-1 / Math.max(1, (cfg.attackMs / 1000) * sr));
  const rCoef = 1 - Math.exp(-1 / Math.max(1, (cfg.releaseMs / 1000) * sr));
  const env = new Int16Array(total);
  let g = 1;
  for (let i = 0; i < total; i++) {
    const s = i < key.length ? Math.abs(key[i]) / 32768 : 0;
    const target = s > cfg.threshold ? duckFloor : 1; // loud key -> duck
    g += (target - g) * (target < g ? aCoef : rCoef);  // attack when ducking, release when recovering
    env[i] = Math.max(0, Math.min(32767, Math.round(g * 32767)));
  }
  // Minimal mono s16 WAV.
  const dataBytes = env.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(env.buffer, env.byteOffset, dataBytes).copy(buf, 44);
  fs.writeFileSync(outWav, buf);
}

// Re-export the client-safe vocabulary so server code has one import site.
export {
  ASSET_KINDS,
  PRODUCTION_STYLES,
  SFX_CATEGORIES,
  SFX_DENSITIES,
  isProductionStyle,
  isSfxDensity,
  parseEpisodeSoundDesign,
} from "./soundDesignShared";
export type { EpisodeSoundDesign, ProductionStyle, SfxDensity } from "./soundDesignShared";

// ---------------------------------------------------------------------------
// Reaction SFX placement — pure and unit-testable.
// ---------------------------------------------------------------------------

/** Timing + emotion metadata for one placed dialogue line. */
export interface SfxLineContext {
  lineIndex: number;
  tone?: string;
  energy?: string;
  startMs: number;
  durationMs: number;
}

export type SfxCategory =
  | "laugh"
  | "crowd"
  | "airhorn"
  | "buzzer"
  | "rimshot"
  | "whoosh"
  | "impact";

export interface ReactionPlacement {
  lineIndex: number;
  /** Preference-ordered categories; the mixer uses the first one available. */
  categories: SfxCategory[];
  atMs: number;
  gainDb: number;
  reason: string;
}

interface DensityProfile {
  /** Minimum spacing between reactions. */
  minSpacingMs: number;
  /** Probability a qualifying beat actually gets a reaction. */
  probability: number;
  /** Whether over-the-top categories (airhorn) are allowed. */
  allowHype: boolean;
  gainDb: number;
}

// +3dB to match the planner's DENSITY_SHAPES — the old values were inaudible.
const DENSITY_PROFILES: Record<SfxDensity, DensityProfile> = {
  subtle: { minSpacingMs: 45_000, probability: 0.4, allowHype: false, gainDb: -12 },
  medium: { minSpacingMs: 25_000, probability: 0.6, allowHype: false, gainDb: -10 },
  hype: { minSpacingMs: 12_000, probability: 0.85, allowHype: true, gainDb: -8 },
};

// Same deterministic PRNG the timeline planner uses.
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

/**
 * Which reaction (if any) fits this line's emotional beat?
 * Returns preference-ordered categories, or null for a non-beat.
 */
function reactionForLine(
  tone: string | undefined,
  energy: string | undefined,
  allowHype: boolean
): { categories: SfxCategory[]; reason: string } | null {
  const t = (tone || "").toLowerCase();
  const high = energy === "high";

  // Funny beats → laughter (rimshot as the drier fallback).
  if (t === "amused") return { categories: ["laugh", "rimshot"], reason: "amused beat" };
  if (t === "sarcastic" && high) return { categories: ["rimshot", "laugh"], reason: "sarcastic jab" };

  // Big/heated beats → crowd reaction; air horn only in hype mode.
  if ((t === "heated" || t === "excited") && high) {
    const cats: SfxCategory[] = allowHype ? ["airhorn", "crowd", "impact"] : ["crowd", "impact"];
    return { categories: cats, reason: `${t} peak` };
  }
  if (t === "incredulous" && high) return { categories: ["crowd", "impact"], reason: "disbelief beat" };

  // Hard dismissal → buzzer (never in subtle mode; gated by caller's density).
  if (t === "dismissive" && high) return { categories: ["buzzer", "rimshot"], reason: "dismissal" };

  return null;
}

/**
 * Plan reaction SFX on emotional beats. Deterministic for a given script +
 * density. Guarantees: minimum spacing between reactions, never on the very
 * first line, at most one reaction per line.
 */
export function planReactionSfx(
  lines: SfxLineContext[],
  density: SfxDensity,
  opts: { availableCategories: Set<SfxCategory> } = { availableCategories: new Set() }
): ReactionPlacement[] {
  const profile = DENSITY_PROFILES[density];
  const placements: ReactionPlacement[] = [];
  let lastPlacedEndMs = -Infinity;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0) continue; // never over the opening line

    const beat = reactionForLine(line.tone, line.energy, profile.allowHype);
    if (!beat) continue;
    // Buzzer is deliberately medium+ — a subtle mix shouldn't game-show anyone.
    if (beat.categories[0] === "buzzer" && density === "subtle") continue;

    // Only place what the library can actually voice.
    const usable = beat.categories.filter((c) => opts.availableCategories.has(c));
    if (usable.length === 0) continue;

    const lineEndMs = line.startMs + line.durationMs;
    if (lineEndMs - lastPlacedEndMs < profile.minSpacingMs) continue;

    const rand = mulberry32(0x51ce0000 ^ (line.lineIndex + 1));
    if (rand() > profile.probability) continue;

    placements.push({
      lineIndex: line.lineIndex,
      categories: usable,
      // Land just before the line's tail ends so the reaction rides the beat
      // instead of trailing it into the gap.
      atMs: Math.max(line.startMs, lineEndMs - 350),
      gainDb: profile.gainDb,
      reason: beat.reason,
    });
    lastPlacedEndMs = lineEndMs;
  }

  return placements;
}

// ---------------------------------------------------------------------------
// Stinger placement at topic/segment breaks.
// ---------------------------------------------------------------------------

export interface StingerSlot {
  /** lineIndex of the line that OPENS the new segment/topic. */
  lineIndex: number;
  breakKind: "segment" | "topic";
  /** When the opening line starts on the timeline. */
  lineStartMs: number;
}

export interface StingerPlacement {
  lineIndex: number;
  stingerIndex: number; // rotation index into the configured stinger list
  atMs: number;
  gainDb: number;
}

/**
 * One stinger per break, rotated deterministically through the configured
 * set, ending just before the opening line starts. Style gating: "light"
 * marks topic breaks only; "full" marks both.
 */
export function planStingers(
  slots: StingerSlot[],
  style: ProductionStyle,
  stingerDurationsMs: number[]
): StingerPlacement[] {
  if (style === "clean" || stingerDurationsMs.length === 0) return [];
  const eligible = slots.filter((s) => (style === "light" ? s.breakKind === "topic" : true));
  return eligible.map((slot, i) => {
    const stingerIndex = i % stingerDurationsMs.length;
    const dur = stingerDurationsMs[stingerIndex];
    return {
      lineIndex: slot.lineIndex,
      stingerIndex,
      // End ~150ms before the next speaker opens their mouth.
      atMs: Math.max(0, slot.lineStartMs - dur - 150),
      gainDb: -5,
    };
  });
}

// ---------------------------------------------------------------------------
// Ducked music bed mixdown (sidechain compression).
// ---------------------------------------------------------------------------

export interface BedMixOptions {
  sampleRate?: number;
  /** Bed level before ducking, relative to the mix. */
  bedGainDb?: number;
  /** Total output duration in ms (bed is looped/trimmed to this). */
  totalMs: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  /**
   * Optional DEDICATED duck key (wav path): typically the dialogue-only
   * submix (+ themes). Without it the FOREGROUND keys the duck — which
   * includes the stingers, so every break's riser mutes the bed in the very
   * gap where the music is supposed to swell (the "10 seconds of silence at a
   * topic turn" bug). With a dialogue-only key, gaps between topics let the
   * actual song rise to full level while speech still crushes it.
   */
  keyWavPath?: string;
}

/**
 * Mix a music bed UNDER an already-rendered foreground (speech + SFX) with
 * sidechain ducking: the foreground's envelope compresses the bed, so music
 * drops when anyone speaks and swells back in gaps. The foreground itself is
 * passed through untouched.
 */
export async function mixBedUnderForeground(
  ffmpegPath: string,
  foregroundWav: string,
  bedSourcePath: string,
  outWav: string,
  opts: BedMixOptions
): Promise<string> {
  const sampleRate = opts.sampleRate || 44100;
  // -6 dB default (was -12, which was inaudible — measured on a real prod
  // render: the whole body was flat ~-19dB voices, music buried 11-15dB under).
  // The STRONG duck below (ratio 10) is what lets the bed be this loud without
  // fading the voices: speech slams it down, gaps let it swell back audibly.
  // `??` (not `||`) so AUDIO_BED_GAIN_DB=0 is honoured — this is your live
  // volume dial: 0 = very present, -3 = present, -6 = default, -10 = subtle.
  const bedGainDb = opts.bedGainDb ?? Number(process.env.AUDIO_BED_GAIN_DB ?? -6);
  const fadeInMs = opts.fadeInMs ?? 1500;
  const fadeOutMs = opts.fadeOutMs ?? 2500;
  const totalSec = (opts.totalMs / 1000).toFixed(3);
  const fadeOutStart = Math.max(0, (opts.totalMs - fadeOutMs) / 1000).toFixed(3);

  // sidechaincompress: [bed][keySignal] — the foreground is the key. Measured
  // and confirmed (2026-07-14): the bed gain passes ~1:1 to the master (a
  // -12→-6 bed change measured +4.8dB in the voice-free gaps), and mastering is
  // a LINEAR loudnorm, so the balance is set right here. Defaults kept at the
  // proven-safe strong duck (no voice fade); the three knobs are env-tunable
  // live so bed presence vs voice clarity can be dialled by ear without a
  // deploy. Loosen the ratio / raise the threshold for a more present bed.
  const duckRatio = Number(process.env.AUDIO_BED_DUCK_RATIO ?? 10);
  const duckThreshold = Number(process.env.AUDIO_BED_DUCK_THRESHOLD ?? 0.02);
  const duckRelease = Number(process.env.AUDIO_BED_DUCK_RELEASE_MS ?? 750);

  // DETERMINISM (PR 4): the bed ducks under speech via a JS-computed gain
  // ENVELOPE applied with `amultiply`, NOT ffmpeg's `sidechaincompress` — that
  // filter's sidechain float state is not bit-reproducible on this build, which
  // made otherwise-identical renders produce different master bytes. The
  // dialogue-only key (or the foreground when no dedicated key) drives the
  // envelope: 1.0 in gaps (bed swells to full), dropping to a floor under speech.
  const keyForDuck = opts.keyWavPath ?? foregroundWav;
  const duckFloorDb = Number(process.env.AUDIO_BED_DUCK_DEPTH_DB ?? 14); // depth of the duck under speech
  // UNIQUE per render (in this render's temp dir), never a shared os.tmpdir path,
  // so concurrent/sequential renders can't read a stale or half-written envelope.
  const envWav = path.join(path.dirname(outWav), `duckenv-${path.basename(outWav)}.wav`);
  writeDuckEnvelopeWav(ffmpegPath, keyForDuck, envWav, {
    sampleRate, totalMs: opts.totalMs, threshold: duckThreshold, duckFloorDb, attackMs: 120, releaseMs: duckRelease,
  });
  void duckRatio; // ratio is subsumed by the fixed duck floor + attack/release.

  const filter =
    `[1:a]aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
    `atrim=0:${totalSec},volume=${bedGainDb}dB,` +
    `afade=t=in:d=${(fadeInMs / 1000).toFixed(3)},afade=t=out:st=${fadeOutStart}:d=${(fadeOutMs / 1000).toFixed(3)}[bed];` +
    `[2:a]aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${totalSec}[env];` +
    `[bed][env]amultiply[ducked];` +
    `[0:a][ducked]amix=inputs=2:normalize=0:dropout_transition=0[out]`;

  const args = [
    "-y",
    "-i", foregroundWav,
    "-stream_loop", "-1",
    "-i", bedSourcePath,
    "-i", envWav,
    "-filter_complex", filter,
    "-map", "[out]",
    "-t", totalSec,
    "-ar", String(sampleRate),
    "-c:a", "pcm_s16le",
    outWav,
  ];
  try {
    await runFfmpeg(ffmpegPath, args);
  } finally {
    try { fs.rmSync(envWav, { force: true }); } catch { /* */ }
  }
  return outWav;
}

// ---------------------------------------------------------------------------
// Asset loading helpers (download + standardize once per stitch job).
// ---------------------------------------------------------------------------

export interface LoadedAsset {
  id: string;
  name: string;
  kind: string;
  category: string | null;
  filePath: string;
  durationMs: number;
}

export interface SoundDesignAssetSet {
  intro: LoadedAsset | null;
  outro: LoadedAsset | null;
  bed: LoadedAsset | null;
  stingers: LoadedAsset[];
  /** Reaction SFX indexed by category; multiple per category allowed. */
  sfxByCategory: Map<SfxCategory, LoadedAsset[]>;
  highlights: Map<string, LoadedAsset>;
  /** Every loaded asset by id — how ProductionPlan cues resolve to files. */
  byId: Map<string, LoadedAsset>;
}

export function emptyAssetSet(): SoundDesignAssetSet {
  return {
    intro: null,
    outro: null,
    bed: null,
    stingers: [],
    sfxByCategory: new Map(),
    highlights: new Map(),
    byId: new Map(),
  };
}

/** Pick one SFX asset for a placement, deterministic per line. */
export function pickSfxAsset(
  set: SoundDesignAssetSet,
  placement: ReactionPlacement
): LoadedAsset | null {
  for (const category of placement.categories) {
    const pool = set.sfxByCategory.get(category);
    if (pool && pool.length > 0) {
      const rand = mulberry32(0xa5f3 ^ (placement.lineIndex + 7));
      return pool[Math.floor(rand() * pool.length) % pool.length];
    }
  }
  return null;
}

/** Summary written into the stitch job log — proof of what was mixed in. */
export interface SoundDesignSummary {
  style: ProductionStyle;
  sfxDensity: SfxDensity;
  introAsset: string | null;
  outroAsset: string | null;
  bedAsset: string | null;
  bedDucking: boolean;
  stingerCount: number;
  reactionCount: number;
  reactions: Array<{ lineIndex: number; asset: string; reason: string; atMs: number }>;
  highlightCount: number;
  highlights: Array<{ lineIndex: number; asset: string }>;
  /** Set when SOUND_DESIGN_PLANNER rendered this episode from a cue sheet. */
  planner?: boolean;
  plannerVersion?: string;
  stingers?: Array<{ lineIndex: number; asset: string; reason: string; atMs: number }>;
  /** Deliberate holds — the plan's documented restraint. */
  silences?: Array<{ lineIndex: number; reason: string }>;
}

/**
 * Insert a clip into a planned timeline AFTER the line at `afterEndMs`,
 * shifting every later clip down by the clip's duration + padding. Returns
 * the inserted clip's start time.
 */
export function shiftTimelineForInsert<T extends { startMs: number }>(
  clips: T[],
  afterEndMs: number,
  insertDurationMs: number,
  padMs = 350
): number {
  const insertAtMs = afterEndMs + padMs;
  const delta = insertDurationMs + padMs * 2;
  for (const clip of clips) {
    if (clip.startMs >= afterEndMs) clip.startMs += delta;
  }
  return insertAtMs;
}
