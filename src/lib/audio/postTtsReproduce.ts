// Post-TTS verbatim reproduce (PR 3 review, Blocker 2). PURE + deterministic.
//
// A successful post-TTS render stores its FULL execution plan (the director's
// PostTtsSoundDirectionPlan, whose bookend segments + cue placements + bed
// already carry every executed timestamp/gain/fade/source-window) PLUS a small
// reproduce ENVELOPE: the plan version, a fingerprint of the dialogue source it
// was built from, the frozen-profile fingerprint, and the content hash of every
// frozen asset the plan uses. Reproduce loads that stored plan and executes it
// VERBATIM — it never re-runs the director, format-policy selection, or cue
// selection. The envelope lets reproduce fail clearly when the inputs no longer
// match the plan (asset changed, dialogue re-generated, profile changed,
// unsupported plan version) instead of silently producing a different render.
//
// Contains NO URLs, storage keys, paths, or credentials — only ids, hashes,
// counts, and timings.

import crypto from "crypto";
import type { PostTtsSoundDirectionPlan } from "@/lib/audio/postTtsSoundDirector";
import { POST_TTS_DIRECTOR_VERSION } from "@/lib/audio/postTtsSoundDirector";
import type { FrozenSoundProfile } from "@/lib/services/podcastSoundProfile";

export const POST_TTS_REPRODUCE_VERSION = 1 as const;

/** One planned dialogue line's identity for source-drift detection (never text
 *  or audio — just index, seat, and measured duration). */
export interface ReproduceDialogueLine { lineIndex: number; hostSlot: number; durationMs: number }

export interface PostTtsReproduceEnvelope {
  reproduceVersion: number;
  directorVersion: number;
  planFingerprint: string;
  /** Fingerprint of the dialogue timeline inputs (ordered lines + offset). */
  sourceFingerprint: string;
  /** Fingerprint of the frozen sound profile (identity + bookend/pool asset ids). */
  frozenProfileFingerprint: string;
  /** assetId -> content hash for every frozen asset the plan references. */
  assetHashes: Record<string, string | null>;
  dialogueStartMs: number;
}

/** The object persisted on the render record's `plan` column for a post-TTS
 *  render: the director plan plus the reproduce envelope. */
export type StoredPostTtsPlan = PostTtsSoundDirectionPlan & { reproduce: PostTtsReproduceEnvelope };

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Deterministic fingerprint of the dialogue source the plan was built from.
 *  Same lines (index/seat/duration) + same offset -> same hash. */
export function fingerprintDialogueSource(lines: ReproduceDialogueLine[], dialogueStartMs: number): string {
  const canonical = { start: Math.round(dialogueStartMs), lines: lines.map((l) => [l.lineIndex, l.hostSlot, Math.round(l.durationMs)]) };
  return sha(JSON.stringify(canonical));
}

/** Deterministic fingerprint of the frozen profile's identity + selected assets.
 *  Any change to the bookend/bed/cue selection or identity changes this. */
export function fingerprintFrozenProfile(profile: FrozenSoundProfile): string {
  const ref = (r: { assetId: string; contentHash?: string | null } | null | undefined) => (r ? [r.assetId, r.contentHash ?? null] : null);
  const canonical = {
    mode: profile.mode,
    intro: ref(profile.intro), outro: ref(profile.outro), bed: ref(profile.bed),
    stingers: profile.stingers.map((r) => ref(r)), reactions: profile.reactions.map((r) => ref(r)),
    identity: profile.sonicIdentity ?? null,
  };
  return sha(JSON.stringify(canonical));
}

/** Every frozen asset id the plan references (bookends, cues, bed). */
export function planReferencedAssetIds(plan: PostTtsSoundDirectionPlan): string[] {
  const ids = new Set<string>();
  if (plan.bookendPlan.intro?.assetId) ids.add(plan.bookendPlan.intro.assetId);
  if (plan.bookendPlan.outro?.assetId) ids.add(plan.bookendPlan.outro.assetId);
  if (plan.bedPlan?.assetId) ids.add(plan.bedPlan.assetId);
  for (const c of plan.cuePlacements) ids.add(c.assetId);
  return [...ids];
}

/** Build the reproduce envelope for a plan about to be rendered successfully. */
export function buildReproduceEnvelope(args: {
  plan: PostTtsSoundDirectionPlan;
  dialogueLines: ReproduceDialogueLine[];
  dialogueStartMs: number;
  frozenProfile: FrozenSoundProfile;
  assetHashById: Map<string, string | null>;
}): PostTtsReproduceEnvelope {
  const assetHashes: Record<string, string | null> = {};
  for (const id of planReferencedAssetIds(args.plan)) assetHashes[id] = args.assetHashById.get(id) ?? null;
  return {
    reproduceVersion: POST_TTS_REPRODUCE_VERSION,
    directorVersion: args.plan.directorVersion,
    planFingerprint: args.plan.fingerprint,
    sourceFingerprint: fingerprintDialogueSource(args.dialogueLines, args.dialogueStartMs),
    frozenProfileFingerprint: fingerprintFrozenProfile(args.frozenProfile),
    assetHashes,
    dialogueStartMs: Math.round(args.dialogueStartMs),
  };
}

export type ReproduceValidation = { ok: true } | { ok: false; reason: string };

/** Type guard: is `x` a stored post-TTS plan with a reproduce envelope? */
export function isStoredPostTtsPlan(x: unknown): x is StoredPostTtsPlan {
  if (!x || typeof x !== "object") return false;
  const p = x as { mode?: unknown; reproduce?: unknown; bookendPlan?: unknown };
  return p.mode === "post_tts" && !!p.reproduce && typeof p.reproduce === "object" && !!p.bookendPlan;
}

/** Validate that a stored plan can be executed verbatim against the CURRENT
 *  inputs. Any mismatch is a clear, safe failure (never a silent re-plan). */
export function validateStoredPlanForReproduce(args: {
  stored: StoredPostTtsPlan;
  frozenProfile: FrozenSoundProfile;
  dialogueLines: ReproduceDialogueLine[];
  dialogueStartMs: number;
  assetHashById: Map<string, string | null>;
  loadedAssetIds: Set<string>;
}): ReproduceValidation {
  const env = args.stored.reproduce;
  if (!env || typeof env !== "object") return { ok: false, reason: "stored post-TTS plan has no reproduce envelope" };
  if (env.reproduceVersion !== POST_TTS_REPRODUCE_VERSION) return { ok: false, reason: `unsupported reproduce version ${env.reproduceVersion} (this build supports ${POST_TTS_REPRODUCE_VERSION})` };
  if (env.directorVersion !== POST_TTS_DIRECTOR_VERSION) return { ok: false, reason: `unsupported director version ${env.directorVersion} (this build supports ${POST_TTS_DIRECTOR_VERSION})` };
  if (args.stored.fingerprint !== env.planFingerprint) return { ok: false, reason: "stored plan fingerprint does not match its envelope (corrupt plan)" };

  // Frozen profile must match the one the plan was built from.
  if (fingerprintFrozenProfile(args.frozenProfile) !== env.frozenProfileFingerprint) {
    return { ok: false, reason: "the episode's frozen sound profile no longer matches the stored plan" };
  }
  // Dialogue source (segments) must match — reproduce replays the exact plan, so
  // the audio it was built from must be unchanged.
  if (fingerprintDialogueSource(args.dialogueLines, args.dialogueStartMs) !== env.sourceFingerprint) {
    return { ok: false, reason: "the dialogue audio no longer matches the stored plan's source (regenerated segments)" };
  }
  // Every referenced asset must be present, in the frozen pool, and byte-identical.
  for (const id of planReferencedAssetIds(args.stored)) {
    if (!args.loadedAssetIds.has(id)) return { ok: false, reason: `plan asset ${id} is not available in the frozen pool` };
    const expected = env.assetHashes[id] ?? null;
    const current = args.assetHashById.get(id) ?? null;
    if (expected !== current) return { ok: false, reason: `plan asset ${id} content hash changed since the stored render` };
  }
  return { ok: true };
}
