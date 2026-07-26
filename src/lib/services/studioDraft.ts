// Durable, cross-session resume state for the Studio multi-topic rundown BUILDER.
//
// This is PRE-generation editor state (mode, selected topics + order, lead
// story, target count, podcast, hosts, production settings, title/description,
// active step) persisted server-side so a producer can close the tab or switch
// machines and resume with nothing lost. It is NOT an episode and NEVER holds a
// generated episode's immutable topic snapshots — once the episode is created
// the draft is cleared. Parsing is fail-open: a corrupt/legacy blob resumes as
// "no draft" (a fresh builder) rather than crashing the page.

import { z } from "zod";
import { db } from "../db";
import { PLATFORM_MAX_TOPICS, MAX_HOSTS, MAX_TITLE_LEN, MAX_DESCRIPTION_LEN, PRODUCTION_STYLES, SFX_DENSITIES } from "../episodeLimits";
import { dedupeIds } from "../studio/rundownRules";

/** The DB surface the draft helpers touch — satisfied by PrismaClient and the
 *  in-memory test doubles, so no `any` is needed at call sites. */
export interface StudioDraftDb {
  studioDraft: {
    findUnique: (args: unknown) => Promise<{ state: unknown } | null>;
    upsert: (args: unknown) => Promise<unknown>;
    deleteMany: (args: unknown) => Promise<unknown>;
  };
}

export const RUNDOWN_STEPS = ["show", "topics", "hosts", "production", "review"] as const;
export type RundownStep = (typeof RUNDOWN_STEPS)[number];

/** The raw draft SHAPE, exported so the /admin draft schema can compose the
 *  SAME fields + the SAME refinement (src/lib/services/adminDraft.ts) instead of
 *  forking a second, drifting copy of the rundown rules. */
export const RundownDraftShape = {
    mode: z.enum(["manual", "automatic", "hybrid"]),
    // Deduplicated (order-preserving) before any logical check or persistence.
    selectedTopicIds: z.array(z.string().trim().min(1)).default([]).transform(dedupeIds),
    leadTopicId: z.string().min(1).nullable().optional(),
    // Never above the ONE shared platform maximum (0/7/24 all rejected here).
    targetTopicCount: z.number().int().min(1).max(PLATFORM_MAX_TOPICS).default(3),
    podcastId: z.string().min(1).nullable().optional(),
    hostIds: z.array(z.string().min(1)).max(MAX_HOSTS, `The pipeline supports ${MAX_HOSTS} hosts.`).default([]),
    // Show format for standalone episodes (podcast episodes inherit the show's
    // format server-side). Optional so legacy drafts keep parsing.
    formatId: z.string().min(1).nullable().optional(),
    // Normalized to the canonical provider id; validated in superRefine against
    // the shared supported-provider list.
    ttsProvider: z.string().trim().min(1).transform((s) => s.toLowerCase()).nullable().optional(),
    ttsVoiceOverrides: z.unknown().optional(),
    productionStyle: z.enum(PRODUCTION_STYLES).nullable().optional(),
    sfxDensity: z.enum(SFX_DENSITIES).nullable().optional(),
    title: z.string().max(MAX_TITLE_LEN).nullable().optional(),
    description: z.string().max(MAX_DESCRIPTION_LEN).nullable().optional(),
    // ---- Automatic/Hybrid backend SELECTION preferences (distinct from the
    //      picker's board display filters) — these actually steer createEpisodeDraft.
    verticals: z.array(z.string().min(1)).optional(),
    leagueIds: z.array(z.string().min(1)).optional(),
    teams: z.array(z.string().min(1)).optional(),
    sport: z.string().min(1).nullable().optional(),
    minDebateScore: z.number().min(0).max(100).nullable().optional(),
    // ---- PROVENANCE ----
    // Whether each setting is an EXPLICIT producer override (true) or merely an
    // inherited/default value (false). Without this, a restored draft can't tell
    // "Podcast A gave me these hosts" from "the producer chose these hosts", and
    // inherited values wrongly survive a switch to another podcast.
    // Legacy drafts have no `overrides` key → safe default: nothing is an
    // override, so every value stays replaceable by the next selected podcast.
    overrides: z
      .object({
        hosts: z.boolean(),
        targetTopicCount: z.boolean(),
        selectionPreferences: z.boolean(),
      })
      .default({ hosts: false, targetTopicCount: false, selectionPreferences: false }),
    activeStep: z.enum(RUNDOWN_STEPS).default("show"),
} as const;

/** PERSISTENCE-time schema: the shape WITHOUT the creation rules.
 *
 *  A draft is a scratchpad, not an episode. The builder's default state on step
 *  one is manual mode with zero topics — a state refineRundownDraft rejects —
 *  so validating persistence with the creation rules made autosave silently
 *  fail for the entire first screen (title, description, mode, show pick all
 *  lost on reload). Field-level integrity (types, caps, provider ids via the
 *  creation schema at submit) still applies; only the cross-field "is this a
 *  creatable rundown yet" rules are deferred to Create, where they belong. */
export const RundownDraftPersistSchema = z.object({
  ...RundownDraftShape,
  // A transient pick of a 3rd host (e.g. while exploring formats) must not
  // void the whole autosave; the creation path still enforces MAX_HOSTS.
  hostIds: z.array(z.string().min(1)).default([]),
});

export type RundownDraftState = z.infer<typeof RundownDraftPersistSchema>;

/** Load + validate a user's saved rundown draft. Returns null when there is no
 *  draft OR the stored blob no longer validates (fail-open to a fresh builder). */
export async function loadStudioDraft(
  ownerId: string,
  dbi: StudioDraftDb = db as unknown as StudioDraftDb
): Promise<RundownDraftState | null> {
  const row = await dbi.studioDraft.findUnique({ where: { ownerId } });
  if (!row) return null;
  const parsed = RundownDraftPersistSchema.safeParse(row.state);
  return parsed.success ? parsed.data : null;
}

/** Upsert a user's rundown draft. The state is validated before persistence so a
 *  malformed client payload can never poison the resume record. */
export async function saveStudioDraft(
  ownerId: string,
  state: unknown,
  dbi: StudioDraftDb = db as unknown as StudioDraftDb
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = RundownDraftPersistSchema.safeParse(state);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message || "Invalid draft state." };
  }
  const value = parsed.data as unknown as object;
  await dbi.studioDraft.upsert({
    where: { ownerId },
    create: { ownerId, state: value },
    update: { state: value },
  });
  return { ok: true };
}

/** Remove a user's rundown draft (after the episode is created, or on discard). */
export async function clearStudioDraft(
  ownerId: string,
  dbi: StudioDraftDb = db as unknown as StudioDraftDb
): Promise<void> {
  await dbi.studioDraft.deleteMany({ where: { ownerId } });
}
