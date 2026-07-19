// Pre-snapshot diversity ORCHESTRATOR + decision record (PR 4). PURE.
//
// Ties the podcast diversity HISTORY + POLICY + episode seed into the per-role
// diversity SELECTION for intro/outro/bed, and assembles a typed, versioned,
// FINGERPRINTED SoundDiversityDecision. The caller (snapshot builder) decides
// whether to APPLY the diversity picks (soft/enforce) or keep the plain picks
// while still recording the decision (observe). Reproduction never calls this —
// it replays the already-frozen selection.

import crypto from "crypto";
import type { FrozenSoundProfile, FrozenSoundAssetRef } from "@/lib/services/podcastSoundProfile";
import { DEFAULT_SONIC_IDENTITY, type SonicIdentity } from "@/lib/audio/sonicIdentity";
import { eligibleVariants, BRAND_MATCH } from "@/lib/audio/variantSelection";
import { selectDiverseVariant, type DiversitySelectionDecision, type RoleHistoryView } from "@/lib/audio/soundDiversitySelection";
import { evaluateMotifContinuity } from "@/lib/audio/soundMotifContinuity";
import type { SoundDiversityPolicy, DiversityMode, DiversityRelaxationCode } from "@/lib/audio/soundDiversityPolicy";
import type { DiversityHistory } from "@/lib/services/diversityHistory";

export const SOUND_DIVERSITY_DECISION_VERSION = 1 as const;

/** A branded-motif rate decision (fully computed in the motif module, PR4 C4). */
export interface MotifContinuityDecision {
  role: "intro" | "outro" | "bed" | "none";
  recentRate: number;
  minimumRate: number;
  maximumRate: number;
  action: "prefer" | "penalize" | "neutral" | "unavoidable" | "unavailable";
  reason: string;
}

/** The frozen, safe pre-snapshot diversity decision. Cue/sequence fields are
 *  RENDER-time (recorded in render diagnostics, PR4 C3) and stay null here. */
export interface SoundDiversityDecision {
  version: number;
  policyVersion: number;
  mode: DiversityMode;
  seed: string;
  historyWindow: number;
  selectedIntro: DiversitySelectionDecision | null;
  selectedOutro: DiversitySelectionDecision | null;
  selectedBed: DiversitySelectionDecision | null;
  motifDecision: MotifContinuityDecision | null;
  relaxations: DiversityRelaxationCode[];
  warnings: string[];
  fingerprint: string;
}

export interface DiverseBookendContext {
  policy: SoundDiversityPolicy;
  mode: DiversityMode;
  history: DiversityHistory;
  seed: string;
  formatId: string;
  identity?: SonicIdentity;
  /** Opt-in shared-system cross-podcast history (Part 9). Applied only as a SOFT
   *  penalty over shared-system assets — never overrides hard podcast rules. */
  systemHistory?: DiversityHistory;
}

export interface DiverseBookendResult {
  intro: FrozenSoundAssetRef | null;
  outro: FrozenSoundAssetRef | null;
  bed: FrozenSoundAssetRef | null;
  decision: SoundDiversityDecision;
}

const roleHistory = (history: DiversityHistory, pick: (e: DiversityHistory["episodes"][number]) => { assetId: string | null; family: string | null }): RoleHistoryView => {
  const assetIds: Array<string | null> = [];
  const families: Array<string | null> = [];
  for (const e of history.episodes) { const v = pick(e); assetIds.push(v.assetId); families.push(v.family); }
  return { assetIds, families };
};

/** Run diversity selection for intro/outro/bed. `mode` off is never passed here
 *  (the caller short-circuits); observe computes as if soft but the caller keeps
 *  the plain picks. */
export function selectDiverseBookends(profile: FrozenSoundProfile, ctx: DiverseBookendContext): DiverseBookendResult {
  const identity = ctx.identity ?? profile.sonicIdentity ?? DEFAULT_SONIC_IDENTITY;
  const applyMode = ctx.mode === "enforce" ? "enforce" : "soft"; // observe computes as soft
  const warnings: string[] = [...ctx.history.warnings];
  const relaxations: DiversityRelaxationCode[] = [];

  const introPool = eligibleVariants(profile.introVariants ?? (profile.intro ? [profile.intro] : []), ctx.formatId, identity);
  const outroPool = eligibleVariants(profile.outroVariants ?? (profile.outro ? [profile.outro] : []), ctx.formatId, identity);
  const bedPool = eligibleVariants(profile.beds ?? (profile.bed ? [profile.bed] : []), ctx.formatId, identity);

  const introEnabled = profile.introEnabled !== false;
  const outroEnabled = profile.outroEnabled !== false;
  const bedEnabled = identity.bedPolicy !== "none";

  // System-wide shared-asset recency (soft, opt-in). Flattened newest-first.
  const systemRecent = ctx.systemHistory && ctx.policy.systemCrossPodcastDiversityEnabled
    ? { intro: ctx.systemHistory.episodes.map((e) => e.introAssetId).filter((x): x is string => !!x), outro: ctx.systemHistory.episodes.map((e) => e.outroAssetId).filter((x): x is string => !!x), bed: ctx.systemHistory.episodes.map((e) => e.bedAssetId).filter((x): x is string => !!x) }
    : null;

  // Motif rate decisions per role (drives prefer/penalize of branded motifs).
  const introMotif = evaluateMotifContinuity({ role: "intro", candidates: introPool, recentMotifUsage: ctx.history.episodes.map((e) => e.introIsMotif), policy: ctx.policy });
  const outroMotif = evaluateMotifContinuity({ role: "outro", candidates: outroPool, recentMotifUsage: ctx.history.episodes.map((e) => e.outroIsMotif), policy: ctx.policy });

  // Intro
  const introRes = introEnabled && introPool.length
    ? selectDiverseVariant({ role: "intro", candidates: introPool, policy: ctx.policy, mode: applyMode, seed: ctx.seed, history: roleHistory(ctx.history, (e) => ({ assetId: e.introAssetId, family: e.introFamily })), motifAction: introMotif.action, systemRecentAssetIds: systemRecent?.intro })
    : null;
  const intro = introRes?.selected ?? null;

  // Outro: brand-match the chosen intro, avoid the exact prior pair, avoid the same file.
  const matchFamily = intro?.cueFamily ? BRAND_MATCH[intro.cueFamily] : undefined;
  const outroCandidates = outroPool.filter((r) => !intro || r.assetId !== intro.assetId);
  const outroRes = outroEnabled && (outroCandidates.length || outroPool.length)
    ? selectDiverseVariant({
        role: "outro", candidates: outroCandidates.length ? outroCandidates : outroPool, policy: ctx.policy, mode: applyMode, seed: ctx.seed,
        history: roleHistory(ctx.history, (e) => ({ assetId: e.outroAssetId, family: e.outroFamily })),
        chosenIntroId: intro?.assetId ?? null,
        priorPairs: ctx.history.episodes.map((e) => ({ introId: e.introAssetId, outroId: e.outroAssetId })),
        familyBonus: matchFamily ? { family: matchFamily, amount: ctx.policy.brandedContinuityBonus } : undefined,
        motifAction: outroMotif.action, systemRecentAssetIds: systemRecent?.outro,
      })
    : null;
  const outro = outroRes?.selected ?? null;

  // Bed
  const bedRes = bedEnabled && bedPool.length
    ? selectDiverseVariant({ role: "bed", candidates: bedPool, policy: ctx.policy, mode: applyMode, seed: ctx.seed, history: roleHistory(ctx.history, (e) => ({ assetId: e.bedAssetId, family: e.bedFamily })), systemRecentAssetIds: systemRecent?.bed })
    : null;
  const bed = bedRes?.selected ?? null;

  for (const r of [introRes, outroRes, bedRes]) if (r) for (const rx of r.decision.relaxations) if (!relaxations.includes(rx)) relaxations.push(rx);
  // Motif edge-case relaxations (honest, deterministic).
  for (const m of [introMotif, outroMotif]) {
    if (m.action === "unavailable" && m.recentRate < m.minimumRate && !relaxations.includes("motif_minimum_unavailable")) relaxations.push("motif_minimum_unavailable");
    if (m.action === "unavoidable" && !relaxations.includes("motif_maximum_unavoidable")) relaxations.push("motif_maximum_unavoidable");
  }
  // The primary branding slot's motif decision (intro), with outro noted in warnings.
  if (outroMotif.action === "unavoidable" || outroMotif.action === "unavailable") warnings.push(`outro motif: ${outroMotif.reason}`);

  const decision: SoundDiversityDecision = {
    version: SOUND_DIVERSITY_DECISION_VERSION,
    policyVersion: ctx.policy.version,
    mode: ctx.mode,
    seed: ctx.seed,
    historyWindow: ctx.history.windowUsed,
    selectedIntro: introRes?.decision ?? null,
    selectedOutro: outroRes?.decision ?? null,
    selectedBed: bedRes?.decision ?? null,
    motifDecision: introMotif,
    relaxations,
    warnings,
    fingerprint: "",
  };
  decision.fingerprint = fingerprintDiversityDecision(decision);
  return { intro, outro, bed, decision };
}

/** Deterministic fingerprint of a diversity decision's selection content
 *  (excludes the fingerprint field). Same inputs -> same hash. */
export function fingerprintDiversityDecision(d: SoundDiversityDecision): string {
  const roleFp = (s: DiversitySelectionDecision | null) => s && [s.role, s.selectedAssetId, s.assetStreak, s.familyStreak, s.relaxations, s.candidates.map((c) => [c.assetId, Math.round(c.score * 1000) / 1000, c.excluded])];
  const canonical = {
    v: d.version, pv: d.policyVersion, mode: d.mode, seed: d.seed, hw: d.historyWindow,
    intro: roleFp(d.selectedIntro), outro: roleFp(d.selectedOutro), bed: roleFp(d.selectedBed),
    motif: d.motifDecision && [d.motifDecision.role, d.motifDecision.action, Math.round(d.motifDecision.recentRate * 1000) / 1000],
    relax: d.relaxations,
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
