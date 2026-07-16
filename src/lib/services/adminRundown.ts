// Admin rundown-builder LOGIC, extracted behind an authenticated-operator seam
// so it is testable without bypassing the server actions (the same pattern
// studioActions.ts uses for Studio).
//
// THIS FILE CONTAINS NO BUSINESS RULES OF ITS OWN. Eligibility comes from the
// shared topicEligibility contract, the view-models from the shared
// buildStudioTopicVMs, ordering from the shared rundownRules, and creation from
// the shared createRundownEpisode → createEpisodeDraft. What lives here is only
// what is legitimately different about Admin:
//
//   • Scope     — the authorized GLOBAL topic catalog (Studio is owner-scoped).
//   • Authority — an admin actor, which unlocks the audited reuse override.
//   • Storage   — AdminDraft (Studio's StudioDraft requires a User FK an admin
//                 identity cannot satisfy).
//
// Authorization itself is NOT enforced here — it is enforced by requireAdmin()
// in the "use server" action layer, on every mutation. This module never reads
// a role/ownerId/admin flag out of client input.

import type { PrismaClient } from "@prisma/client";
import { buildStudioTopicVMs, type RawPoolTopic, type StudioTopicVM } from "./studioTopicPool";
import { getTopicUsage, resolveTopicReusePolicy, type UsageDb } from "./topicUsageService";
import { createRundownEpisode, type RundownCreationOutcome } from "./rundownCreation";
import { loadAdminDraft, saveAdminDraft, clearAdminDraft, AdminRundownDraftStateSchema, type AdminRundownDraftState, type AdminDraftDb } from "./adminDraft";
import { getResearchStates, type ResearchStateDb } from "./researchState";
import type { EligibilityReason } from "./topicEligibility";

/** The authenticated context every Admin rundown action runs under. The id is
 *  adminIdentity() — an audit label, NOT a User row. */
export interface AdminCtx {
  admin: { id: string };
  db: PrismaClient;
}

export interface AdminRundownInput {
  mode: "manual" | "automatic" | "hybrid";
  selectedTopicIds: string[];
  targetTopicCount?: number;
  leadTopicId?: string | null;
  podcastId?: string | null;
  hostIds?: string[];
  ttsProvider?: string;
  ttsVoiceOverrides?: unknown;
  productionStyle?: string;
  sfxDensity?: string;
  title?: string;
  description?: string;
  verticals?: string[];
  leagueIds?: string[];
  teams?: string[];
  sport?: string;
  minDebateScore?: number;
  reuseOverride?: boolean;
}

/** How many topics the Admin board loads. Higher than Studio's 60 because Admin
 *  reviews the global catalog, but still bounded — an unbounded findMany would
 *  degrade as the topic table grows. */
export const ADMIN_TOPIC_BOARD_LIMIT = 200;

/**
 * The AUTHORIZED GLOBAL topic catalog for the Admin board.
 *
 * Unlike the old Admin query this replaces, there is NO hidden WHERE clause:
 * every editorial status is loaded and every topic is returned with its shared
 * eligibility result attached. A topic below the automatic debate/talkability
 * threshold is NOT filtered out in SQL — it comes back visible and manually
 * selectable, carrying a below_automatic_threshold WARNING. That difference is
 * the entire point of this surface.
 */
export async function getAdminTopicsFor(
  ctx: AdminCtx,
  opts: { podcastId?: string | null; selectedTopicIds?: string[] } = {}
): Promise<{ success: true; topics: StudioTopicVM[]; truncated: boolean } | { success: false; error: string }> {
  const podcastId = opts.podcastId || undefined;
  if (podcastId) {
    const pod = await ctx.db.podcast.findUnique({ where: { id: podcastId }, select: { id: true } });
    if (!pod) return { success: false, error: "That show no longer exists." };
  }

  const topics = (await ctx.db.topicCandidate.findMany({
    // No status filter, no score floor, no brief requirement: Admin is
    // authorized to SEE the whole catalog. What a topic is or isn't eligible
    // for is decided by the shared contract below and shown, never hidden.
    include: { researchBrief: true },
    orderBy: { createdAt: "desc" },
    take: ADMIN_TOPIC_BOARD_LIMIT + 1,
  })) as unknown as RawPoolTopic[];

  const truncated = topics.length > ADMIN_TOPIC_BOARD_LIMIT;
  const page = truncated ? topics.slice(0, ADMIN_TOPIC_BOARD_LIMIT) : topics;

  // `system: true` because an admin operator has no User row to scope by; the
  // podcast scope (what the reuse policy actually needs) is unaffected.
  const usage = await getTopicUsage(
    page.map((t) => t.id),
    { system: true, podcastId },
    ctx.db as unknown as UsageDb
  );
  const policy = resolveTopicReusePolicy();
  // Real research state from real job history — this is what turns
  // "researching" / "research failed" into facts rather than guesses.
  const researchStates = await getResearchStates(page.map((t) => t.id), ctx.db as unknown as ResearchStateDb);
  const vms = buildStudioTopicVMs(page, {
    usage,
    policy,
    podcastId,
    actor: { kind: "admin", adminId: ctx.admin.id },
    selectedTopicIds: opts.selectedTopicIds,
    researchStates,
  }).sort((a, b) => b.talkability - a.talkability);

  return { success: true, topics: vms, truncated };
}

export type AdminCreateResult =
  | (Extract<RundownCreationOutcome, { success: true }> & { draftCleanupWarning?: string })
  | Extract<RundownCreationOutcome, { success: false }>;

/**
 * Create a draft episode from an Admin rundown, through the SHARED creation
 * core — the identical path Studio uses. Admin passes an admin authority, which
 * is the only thing that lets `reuseOverride` survive; the override is audited
 * by the action layer before this runs.
 *
 * Episodes created here are OWNERLESS (Episode.ownerId is a nullable FK to
 * User, and an admin identity has no User row) — matching the pre-existing
 * admin creation path.
 */
export async function createAdminEpisodeFor(ctx: AdminCtx, input: AdminRundownInput): Promise<AdminCreateResult> {
  const res = await createRundownEpisode(
    {
      db: ctx.db,
      authority: { kind: "admin", ownerId: null, adminId: ctx.admin.id },
      // Admin is authorized across the catalog of shows.
      canUsePodcast: () => true,
    },
    input
  );

  if (!res.success) return res;

  // Success → clear the resume draft. A cleanup failure is NON-fatal but
  // SURFACED, so a stale draft can't silently cause a duplicate.
  let draftCleanupWarning: string | undefined;
  try {
    await clearAdminDraft(ctx.admin.id, ctx.db as unknown as AdminDraftDb);
  } catch (err) {
    draftCleanupWarning = "The episode was created, but the saved draft couldn't be cleared automatically — discard it manually to avoid a duplicate.";
    console.error(`[admin] draft cleanup failed for admin=${ctx.admin.id} episode=${res.episodeId}:`, (err as Error).message);
  }

  return { ...res, draftCleanupWarning };
}

/** A selected topic whose eligibility CHANGED while the draft was parked. */
export interface ChangedSelection {
  topicId: string;
  title: string;
  /** Why it can no longer be selected — the precise shared reasons. */
  blockingReasons: EligibilityReason[];
}

export interface AdminResume {
  draft: AdminRundownDraftState | null;
  topics: StudioTopicVM[];
  truncated: boolean;
  /**
   * Topics still in the restored rundown that are no longer selectable.
   * They are deliberately LEFT IN the draft: a resumed rundown must never
   * silently drop a producer's pick. The UI shows the reason and the operator
   * decides explicitly.
   */
  changedSelections: ChangedSelection[];
}

/**
 * Restore an Admin draft AND re-evaluate the current eligibility of everything
 * in it. Order, mode, target, lead, filters, podcast and hosts come back
 * exactly as saved; what changed underneath is reported, not applied.
 */
export async function resumeAdminRundown(ctx: AdminCtx): Promise<AdminResume> {
  const draft = await loadAdminDraft(ctx.admin.id, ctx.db as unknown as AdminDraftDb);
  const pool = await getAdminTopicsFor(ctx, {
    podcastId: draft?.podcastId ?? undefined,
    selectedTopicIds: draft?.selectedTopicIds,
  });
  if (!pool.success) return { draft, topics: [], truncated: false, changedSelections: [] };

  const changedSelections: ChangedSelection[] = [];
  if (draft) {
    const byId = new Map(pool.topics.map((t) => [t.id, t]));
    for (const id of draft.selectedTopicIds) {
      const vm = byId.get(id);
      if (!vm) {
        changedSelections.push({
          topicId: id,
          title: id,
          blockingReasons: [{ code: "not_found", message: `Topic candidate ${id} not found in database.` }],
        });
        continue;
      }
      if (!vm.eligibility.manuallySelectable) {
        changedSelections.push({ topicId: id, title: vm.title, blockingReasons: vm.eligibility.blockingReasons });
      }
    }
  }

  return { draft, topics: pool.topics, truncated: pool.truncated, changedSelections };
}

export async function loadAdminDraftFor(ctx: AdminCtx): Promise<{ success: true; draft: AdminRundownDraftState | null }> {
  const draft = await loadAdminDraft(ctx.admin.id, ctx.db as unknown as AdminDraftDb);
  return { success: true, draft };
}

export async function saveAdminDraftFor(ctx: AdminCtx, state: unknown): Promise<{ success: true } | { success: false; error: string }> {
  const res = await saveAdminDraft(ctx.admin.id, state, ctx.db as unknown as AdminDraftDb);
  return res.ok ? { success: true } : { success: false, error: res.error };
}

export async function discardAdminDraftFor(ctx: AdminCtx): Promise<{ success: true }> {
  await clearAdminDraft(ctx.admin.id, ctx.db as unknown as AdminDraftDb);
  return { success: true };
}

export { AdminRundownDraftStateSchema };
export type { AdminRundownDraftState };
