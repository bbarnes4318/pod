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
// Reuse the EXISTING provider/voice validation architecture — no duplicated
// provider definitions here.
import { isTtsProviderId } from "../providers/tts/providerIds";
import { validateTtsVoiceOverridesInput } from "../providers/tts/voiceResolution";

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

export const RundownDraftStateSchema = z
  .object({
    mode: z.enum(["manual", "automatic", "hybrid"]),
    // Deduplicated (order-preserving) before any logical check or persistence.
    selectedTopicIds: z.array(z.string().trim().min(1)).default([]).transform(dedupeIds),
    leadTopicId: z.string().min(1).nullable().optional(),
    // Never above the ONE shared platform maximum (0/7/24 all rejected here).
    targetTopicCount: z.number().int().min(1).max(PLATFORM_MAX_TOPICS).default(3),
    podcastId: z.string().min(1).nullable().optional(),
    hostIds: z.array(z.string().min(1)).max(MAX_HOSTS, `The pipeline supports ${MAX_HOSTS} hosts.`).default([]),
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
    activeStep: z.enum(RUNDOWN_STEPS).default("show"),
  })
  .superRefine((val, ctx) => {
    const n = val.selectedTopicIds.length;
    if (val.mode === "manual" && n < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedTopicIds"], message: "Manual mode needs at least one topic." });
    }
    if (val.mode === "automatic") {
      if (n > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedTopicIds"], message: "Automatic mode can't carry hand-picked topics." });
      if (val.leadTopicId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["leadTopicId"], message: "Automatic mode has no lead topic." });
    }
    if (val.mode === "hybrid") {
      if (n < 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedTopicIds"], message: "Hybrid mode needs at least one pinned topic." });
      if (n > val.targetTopicCount) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedTopicIds"], message: `Pinned topics (${n}) can't exceed the target count (${val.targetTopicCount}).` });
    }
    if (n > PLATFORM_MAX_TOPICS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedTopicIds"], message: `No more than ${PLATFORM_MAX_TOPICS} topics per episode.` });
    }
    if (val.leadTopicId && !val.selectedTopicIds.includes(val.leadTopicId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["leadTopicId"], message: "The lead topic must be one of the selected topics." });
    }
    // TTS: validate against the SHARED provider list + override validator, so a
    // malformed engine/voice can never be persisted and silently restored.
    if (val.ttsProvider && !isTtsProviderId(val.ttsProvider)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ttsProvider"], message: `Unknown TTS provider '${val.ttsProvider}'.` });
    }
    if (val.ttsVoiceOverrides !== undefined && val.ttsVoiceOverrides !== null) {
      try {
        validateTtsVoiceOverridesInput(val.ttsVoiceOverrides);
      } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ttsVoiceOverrides"], message: (err as Error).message });
      }
    }
  });

export type RundownDraftState = z.infer<typeof RundownDraftStateSchema>;

/** Load + validate a user's saved rundown draft. Returns null when there is no
 *  draft OR the stored blob no longer validates (fail-open to a fresh builder). */
export async function loadStudioDraft(
  ownerId: string,
  dbi: StudioDraftDb = db as unknown as StudioDraftDb
): Promise<RundownDraftState | null> {
  const row = await dbi.studioDraft.findUnique({ where: { ownerId } });
  if (!row) return null;
  const parsed = RundownDraftStateSchema.safeParse(row.state);
  return parsed.success ? parsed.data : null;
}

/** Upsert a user's rundown draft. The state is validated before persistence so a
 *  malformed client payload can never poison the resume record. */
export async function saveStudioDraft(
  ownerId: string,
  state: unknown,
  dbi: StudioDraftDb = db as unknown as StudioDraftDb
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = RundownDraftStateSchema.safeParse(state);
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
