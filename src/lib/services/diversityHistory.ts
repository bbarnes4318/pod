// Podcast-scoped sound diversity HISTORY reader (PR 4). Derives recent creative
// sound selections from SUCCESSFUL renders + frozen snapshots + stored plans, so
// the diversity engine can avoid repetition without ever reading another
// podcast's or owner's private usage.
//
// Evidence sources, in order of preference:
//   - intro/outro/bed asset + family + branded-motif  <- the episode's FROZEN
//     snapshot (production.soundProfile.intro/outro/bed), the immutable record
//     of what was creatively selected.
//   - transition/reaction assets + the ordered cue-family sequence  <- the
//     succeeded render's STORED plan (cuePlacements), the exact executed cues.
//
// Rules honored: successful renders only; one entry PER EPISODE (a re-render or
// reproduce of the same episode never double-counts as a new creative
// selection); strict podcast/owner/system scoping (never cross ownership);
// deterministic ordering (creation time then id — recency, never randomness);
// bounded window; missing/corrupt snapshot or plan handled honestly with a
// warning rather than a throw.

import { resolveSnapshotSoundProfile } from "@/lib/services/episodeConfigurationSnapshot";
import type { FrozenSoundAssetRef } from "@/lib/services/podcastSoundProfile";
import type { CooldownScopeFilter } from "@/lib/services/cueCooldownService";
import { DIVERSITY_BOUNDS } from "@/lib/audio/soundDiversityPolicy";

export type RenderKind = "initial" | "remix" | "reproduce" | "legacy";

export interface DiversityHistoryEpisode {
  episodeId: string;
  renderId: string | null;
  /** 0 = most recent within the window. Deterministic. */
  creationOrder: number;
  formatId: string | null;
  introAssetId: string | null;
  outroAssetId: string | null;
  bedAssetId: string | null;
  transitionAssetIds: string[];
  reactionAssetIds: string[];
  introFamily: string | null;
  outroFamily: string | null;
  bedFamily: string | null;
  transitionFamilySequence: string[];
  reactionFamilySequence: string[];
  /** Full ordered ROLE:family token stream (INTRO/BED/…/OUTRO). Bounded. */
  cueFamilySequence: string[];
  introIsMotif: boolean;
  outroIsMotif: boolean;
  bedIsMotif: boolean;
  brandedMotifUsed: boolean;
  planningEngine: string | null;
  planningVersion: number | null;
  planFingerprint: string | null;
  renderKind: RenderKind;
}

export interface DiversityHistory {
  scope: "podcast" | "owner" | "system";
  windowRequested: number;
  windowUsed: number;
  episodes: DiversityHistoryEpisode[]; // newest first
  warnings: string[];
  truncated: boolean;
}

/** Minimal DB surface the reader needs (the global Prisma client satisfies it;
 *  tests inject their own embedded-PG client). */
export interface DiversityHistoryDb {
  episode: {
    findMany(args: unknown): Promise<Array<{
      id: string;
      createdAt: Date;
      formatId: string | null;
      podcastId?: string | null;
      ownerId?: string | null;
      configurationSnapshot: unknown;
      audioRenders: Array<{ id: string; plan: unknown; diagnostics: unknown; renderMode: string | null; renderVersion: number }>;
    }>>;
  };
}

function scopeWhere(scope: CooldownScopeFilter): Record<string, unknown> {
  switch (scope.kind) {
    case "podcast": return { podcastId: scope.podcastId };
    case "owner": return { ownerId: scope.ownerId };
    case "system": return { ownerId: null, podcastId: null };
  }
}

function renderKindFromMode(mode: string | null): RenderKind {
  if (mode === "reproduce") return "reproduce";
  if (mode === "remix_episode_profile" || mode === "remix_current_podcast") return "remix";
  if (mode === "legacy") return "legacy";
  return "initial";
}

interface CuePlacementLite { kind?: string; assetId?: string; cueFamily?: string | null; targetStartMs?: number }
function parseStoredPlan(plan: unknown): { placements: CuePlacementLite[]; fingerprint: string | null; version: number | null; mode: string | null } {
  if (!plan || typeof plan !== "object") return { placements: [], fingerprint: null, version: null, mode: null };
  const p = plan as { cuePlacements?: unknown; fingerprint?: unknown; directorVersion?: unknown; mode?: unknown };
  const placements = Array.isArray(p.cuePlacements) ? (p.cuePlacements as CuePlacementLite[]) : [];
  return {
    placements,
    fingerprint: typeof p.fingerprint === "string" ? p.fingerprint : null,
    version: typeof p.directorVersion === "number" ? p.directorVersion : null,
    mode: typeof p.mode === "string" ? p.mode : null,
  };
}

/** Read the recent diversity history for a scope. `systemHistoryEnabled` must be
 *  true for system scope to return anything (opt-in cross-podcast history). */
export async function readDiversityHistory(opts: {
  db: DiversityHistoryDb;
  scope: CooldownScopeFilter;
  windowEpisodes: number;
  excludeEpisodeId?: string;
  systemHistoryEnabled?: boolean;
}): Promise<DiversityHistory> {
  const scopeKind = opts.scope.kind;
  const warnings: string[] = [];
  const windowRequested = Math.max(0, Math.floor(opts.windowEpisodes));

  // Bound the window (Part 17). System scope has its own tighter record ceiling.
  let window = Math.min(windowRequested, DIVERSITY_BOUNDS.maxHistoryWindowEpisodes);
  if (window < windowRequested) warnings.push(`history window reduced to ${window} (bound ${DIVERSITY_BOUNDS.maxHistoryWindowEpisodes})`);

  if (scopeKind === "system" && !opts.systemHistoryEnabled) {
    // Opt-in only: without the explicit flag, system history is IGNORED.
    return { scope: scopeKind, windowRequested, windowUsed: 0, episodes: [], warnings: [...warnings, "system history disabled"], truncated: false };
  }
  if (scopeKind === "system") window = Math.min(window, DIVERSITY_BOUNDS.maxSystemHistoryRecords);
  if (window === 0) return { scope: scopeKind, windowRequested, windowUsed: 0, episodes: [], warnings, truncated: false };

  const rows = await opts.db.episode.findMany({
    where: {
      ...scopeWhere(opts.scope),
      ...(opts.excludeEpisodeId ? { id: { not: opts.excludeEpisodeId } } : {}),
      audioRenders: { some: { status: "succeeded" } },
    },
    // Deterministic recency ordering: creation time, id as a stable tiebreak.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: window,
    select: {
      id: true, createdAt: true, formatId: true, configurationSnapshot: true,
      audioRenders: {
        where: { status: "succeeded" },
        orderBy: { renderVersion: "desc" },
        take: 1,
        select: { id: true, plan: true, diagnostics: true, renderMode: true, renderVersion: true },
      },
    },
  });

  const episodes: DiversityHistoryEpisode[] = [];
  const sharedOnly = scopeKind === "system";
  const refScopeOk = (ref: FrozenSoundAssetRef | null | undefined): boolean => !sharedOnly || (!!ref && ref.scope === "shared_system");
  const idOf = (ref: FrozenSoundAssetRef | null | undefined): string | null => (ref && refScopeOk(ref) ? ref.assetId : null);
  const famOf = (ref: FrozenSoundAssetRef | null | undefined): string | null => (ref && refScopeOk(ref) ? ref.cueFamily ?? null : null);

  rows.forEach((row, i) => {
    const { profile, status } = resolveSnapshotSoundProfile(row.configurationSnapshot);
    if (status === "corrupt") warnings.push(`episode ${row.id}: corrupt frozen profile ignored`);
    const render = row.audioRenders[0] ?? null;
    const parsed = parseStoredPlan(render?.plan);
    if (render && !parsed.mode) warnings.push(`episode ${row.id}: stored plan missing/unreadable`);

    const intro = profile?.intro ?? null, outro = profile?.outro ?? null, bed = profile?.bed ?? null;

    // Ordered cue-family token stream from the executed plan (bounded).
    const cueFamilySequence: string[] = [];
    const transitionAssetIds: string[] = [], reactionAssetIds: string[] = [];
    const transitionFamilySequence: string[] = [], reactionFamilySequence: string[] = [];
    if (intro && refScopeOk(intro)) cueFamilySequence.push(`INTRO:${intro.cueFamily ?? "none"}`);
    if (bed && refScopeOk(bed)) cueFamilySequence.push(`BED:${bed.cueFamily ?? "none"}`);
    const ordered = [...parsed.placements].sort((a, b) => (a.targetStartMs ?? 0) - (b.targetStartMs ?? 0));
    for (const c of ordered) {
      if (cueFamilySequence.length >= DIVERSITY_BOUNDS.maxCueTokensPerEpisode) break;
      const fam = c.cueFamily ?? "none";
      if (c.kind === "transition") {
        cueFamilySequence.push(`TRANSITION:${fam}`);
        transitionFamilySequence.push(fam);
        if (c.assetId) transitionAssetIds.push(c.assetId);
      } else if (c.kind === "reaction") {
        cueFamilySequence.push(`REACTION:${fam}`);
        reactionFamilySequence.push(fam);
        if (c.assetId) reactionAssetIds.push(c.assetId);
      }
    }
    if (outro && refScopeOk(outro) && cueFamilySequence.length < DIVERSITY_BOUNDS.maxCueTokensPerEpisode) cueFamilySequence.push(`OUTRO:${outro.cueFamily ?? "none"}`);

    const brandedMotifUsed =
      !!(intro?.isBrandedMotif && refScopeOk(intro)) ||
      !!(outro?.isBrandedMotif && refScopeOk(outro)) ||
      !!(bed?.isBrandedMotif && refScopeOk(bed));

    const engine = (() => {
      const d = render?.diagnostics;
      if (d && typeof d === "object") {
        const pt = (d as { postTts?: { planningEngine?: unknown } }).postTts;
        if (pt && typeof pt.planningEngine === "string") return pt.planningEngine;
      }
      return null;
    })();

    episodes.push({
      episodeId: row.id,
      renderId: render?.id ?? null,
      creationOrder: i,
      formatId: row.formatId ?? null,
      introAssetId: idOf(intro),
      outroAssetId: idOf(outro),
      bedAssetId: idOf(bed),
      transitionAssetIds,
      reactionAssetIds,
      introFamily: famOf(intro),
      outroFamily: famOf(outro),
      bedFamily: famOf(bed),
      transitionFamilySequence,
      reactionFamilySequence,
      cueFamilySequence,
      introIsMotif: !!(intro?.isBrandedMotif && refScopeOk(intro)),
      outroIsMotif: !!(outro?.isBrandedMotif && refScopeOk(outro)),
      bedIsMotif: !!(bed?.isBrandedMotif && refScopeOk(bed)),
      brandedMotifUsed,
      planningEngine: engine,
      planningVersion: parsed.version,
      planFingerprint: parsed.fingerprint,
      renderKind: renderKindFromMode(render?.renderMode ?? null),
    });
  });

  return { scope: scopeKind, windowRequested, windowUsed: episodes.length, episodes, warnings, truncated: episodes.length >= window && windowRequested > window };
}
