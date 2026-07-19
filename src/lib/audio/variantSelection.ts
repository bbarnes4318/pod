// Deterministic per-episode VARIANT SELECTION (PR 2).
//
// Given a podcast's PERMITTED sound pools (from resolvePodcastSoundProfile) plus
// a stable per-episode seed, the show's format, and its sonic identity, choose
// the EXACT intro/outro/bed variant to freeze into the episode snapshot. Pure +
// deterministic: identical inputs -> identical selection (reproducible); a
// different seed may select a different variant (cross-episode variety). No
// Math.random, no wall-clock — a seeded mulberry32 stream, the same PRNG family
// the production planner uses.
//
// This is the FOUNDATION PR 4 builds its cross-episode anti-repetition on; the
// full diversity engine is intentionally NOT here.

import type { FrozenSoundProfile, FrozenSoundAssetRef } from "@/lib/services/podcastSoundProfile";
import { type SonicIdentity, DEFAULT_SONIC_IDENTITY } from "@/lib/audio/sonicIdentity";

// FNV-1a (string -> 32-bit) + mulberry32 — identical to productionPlanner.ts.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A single deterministic weighted pick from `candidates` (weight <= 0 skipped). */
function weightedPick<T>(rand: () => number, candidates: Array<{ item: T; weight: number }>): T | null {
  const pool = candidates.filter((c) => c.weight > 0);
  if (pool.length === 0) return null;
  const total = pool.reduce((a, c) => a + c.weight, 0);
  let roll = rand() * total;
  for (const c of pool) { roll -= c.weight; if (roll <= 0) return c.item; }
  return pool[pool.length - 1].item;
}

/** Is this variant compatible with the episode's format, per the assignment's
 *  own allow/deny lists AND the identity's format restrictions? */
export function variantFormatCompatible(ref: FrozenSoundAssetRef, formatId: string, identity: SonicIdentity): boolean {
  const allow = ref.allowedFormatIds ?? [];
  const deny = ref.prohibitedFormatIds ?? [];
  if (allow.length > 0 && !allow.includes(formatId)) return false;
  if (deny.includes(formatId)) return false;
  if (identity.allowedFormatIds.length > 0 && !identity.allowedFormatIds.includes(formatId)) return false;
  if (identity.prohibitedFormatIds.includes(formatId)) return false;
  return true;
}

/** Intro brand family -> the preferred matching OUTRO family (a coherent close). */
export const BRAND_MATCH: Record<string, string> = {
  brand_main: "close_main",
  brand_short: "close_short",
  brand_high_energy: "close_high_energy",
  brand_breaking: "close_main",
  brand_minimal: "close_reflective",
};

/** Filter a pool to variants compatible with the episode's format + identity. */
export const eligibleVariants = (pool: FrozenSoundAssetRef[] | undefined, formatId: string, identity: SonicIdentity): FrozenSoundAssetRef[] =>
  (pool ?? []).filter((r) => variantFormatCompatible(r, formatId, identity));

const eligible = eligibleVariants;

export interface VariantSelectionInput {
  seed: string;          // stable per-episode seed (e.g. the episode id)
  formatId: string;
  identity?: SonicIdentity;
}

/**
 * Select the exact intro/outro/bed for this episode from the permitted pools.
 * Returns a NEW profile: `intro`/`outro`/`bed` become the SELECTED variants; the
 * *Variants pools are preserved (audit + planner); `selectionSeed`,
 * `selectionReasons` and format/identity `excluded` entries are recorded. Clean
 * profiles pass through untouched.
 */
export function selectEpisodeSoundVariants(profile: FrozenSoundProfile, input: VariantSelectionInput): FrozenSoundProfile {
  if (profile.mode === "clean") return profile;
  const identity = input.identity ?? profile.sonicIdentity ?? DEFAULT_SONIC_IDENTITY;
  const formatId = input.formatId;
  const excluded = [...profile.excluded];
  const reasons: { intro?: string; outro?: string; bed?: string } = {};

  const introPool = profile.introVariants ?? (profile.intro ? [profile.intro] : []);
  const outroPool = profile.outroVariants ?? (profile.outro ? [profile.outro] : []);
  const bedPool = profile.beds ?? (profile.bed ? [profile.bed] : []);

  const note = (role: string, pool: FrozenSoundAssetRef[], picked: FrozenSoundAssetRef | null): string => {
    const dropped = pool.length - eligible(pool, formatId, identity).length;
    if (dropped > 0) for (const r of pool) if (!variantFormatCompatible(r, formatId, identity)) excluded.push({ assetId: r.assetId, role, reason: `variant not compatible with format ${formatId}` });
    if (!picked) return pool.length === 0 ? "no variants configured" : `all ${pool.length} variant(s) excluded by format/identity`;
    if (pool.length === 1) return "only variant in the pool";
    return `weighted pick among ${eligible(pool, formatId, identity).length} eligible variant(s) (seed-deterministic)`;
  };

  // --- Intro: format-eligible weighted pick ---------------------------------
  const introElig = eligible(introPool, formatId, identity);
  const intro = profile.introEnabled === false ? null
    : weightedPick(mulberry32(fnv1a(`${input.seed}:intro`)), introElig.map((r) => ({ item: r, weight: r.weight ?? 1 })));
  reasons.intro = note("intro", introPool, intro);

  // --- Outro: prefer the intro's matching brand family; avoid the same file --
  const outroElig = eligible(outroPool, formatId, identity).filter((r) => !intro || r.assetId !== intro.assetId);
  const matchFamily = intro?.cueFamily ? BRAND_MATCH[intro.cueFamily] : undefined;
  const outro = profile.outroEnabled === false ? null
    : weightedPick(mulberry32(fnv1a(`${input.seed}:outro`)),
        (outroElig.length ? outroElig : eligible(outroPool, formatId, identity)).map((r) => ({
          item: r,
          // Boost a brand-matching close so intro+outro feel like one identity.
          weight: (r.weight ?? 1) * (matchFamily && r.cueFamily === matchFamily ? 4 : 1),
        })));
  reasons.outro = intro && outro?.cueFamily === matchFamily
    ? `brand-matched close for ${intro.cueFamily} (seed-deterministic)`
    : note("outro", outroPool, outro);

  // --- Bed: identity bedPolicy "none" => no bed; else weighted pick ----------
  const bed = identity.bedPolicy === "none" ? null
    : weightedPick(mulberry32(fnv1a(`${input.seed}:bed`)), eligible(bedPool, formatId, identity).map((r) => ({ item: r, weight: r.weight ?? 1 })));
  reasons.bed = identity.bedPolicy === "none" ? "bed policy: none" : note("bed", bedPool, bed);

  return {
    ...profile,
    intro,
    outro,
    bed,
    introVariants: introPool,
    outroVariants: outroPool,
    beds: bedPool,
    sonicIdentity: identity,
    selectionSeed: input.seed,
    selectionReasons: reasons,
    excluded,
  };
}
