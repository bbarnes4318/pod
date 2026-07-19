"use server";

// Podcast Sound & Branding server actions (Prompt 6). Session-authorized,
// thin: profile resolution + saving live in the canonical services, including
// Prompt 5 optimistic concurrency (a stale save returns a structured conflict
// for the UI to surface). DTOs are safe — no storage data.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import {
  listAccessibleAudioAssets,
  toSafeAudioAssetDto,
  type SafeAudioAssetDto,
} from "@/lib/services/audioAssetAccess";
import {
  resolvePodcastSoundProfile,
  savePodcastSoundProfile,
  type FrozenSoundProfile,
  type SoundAssignmentInput,
  type SoundProfileMode,
} from "@/lib/services/podcastSoundProfile";
import { selectEpisodeSoundVariants } from "@/lib/audio/variantSelection";
import { validateSonicIdentity, DEFAULT_SONIC_IDENTITY, type SonicIdentity } from "@/lib/audio/sonicIdentity";

export interface SoundAssignmentDto {
  assetId: string; role: string; orderIndex: number; enabled: boolean;
  gainDb: number | null; fadeInMs: number | null; fadeOutMs: number | null;
  cueFamily: string | null; weight: number; isBrandedMotif: boolean;
  maxUsesPerEpisode: number | null; minEpisodeCooldown: number | null;
  allowedFormatIds: string[]; prohibitedFormatIds: string[];
}

export interface PodcastSoundData {
  success: boolean;
  error?: string;
  podcastName?: string;
  configVersion?: number;
  production?: {
    soundProfileMode: string;
    targetLoudnessLufs: number | null;
    cooldownScope: string;
    stingerCooldownEpisodes: number | null;
    reactionCooldownEpisodes: number | null;
    defaultIntroEnabled: boolean;
    defaultOutroEnabled: boolean;
    productionStyle: string | null;
    sfxDensity: string | null;
  };
  sonicIdentity?: SonicIdentity;
  assignments?: SoundAssignmentDto[];
  resolvedProfile?: FrozenSoundProfile;
  assets?: SafeAudioAssetDto[];
}

export async function fetchPodcastSoundData(podcastId: string): Promise<PodcastSoundData> {
  const user = await currentUser();
  if (!user) return { success: false, error: "Sign in to manage show sound." };
  try {
    const pod = await db.podcast.findFirst({
      where: { id: podcastId, ownerId: user.id }, // owner-scoped: others read as missing
      include: { productionConfig: { include: { soundAssignments: { orderBy: [{ role: "asc" }, { orderIndex: "asc" }] } } } },
    });
    if (!pod) return { success: false, error: "That show no longer exists." };
    const production = pod.productionConfig;
    const resolvedProfile = await resolvePodcastSoundProfile(db, { id: pod.id, ownerId: pod.ownerId }, production);
    const assets = await listAccessibleAudioAssets(db, { kind: "user", userId: user.id }, { podcastId: pod.id });
    return {
      success: true,
      podcastName: pod.name,
      configVersion: pod.configVersion,
      production: {
        soundProfileMode: production?.soundProfileMode ?? "system_default",
        targetLoudnessLufs: production?.targetLoudnessLufs ?? null,
        cooldownScope: production?.cooldownScope ?? "podcast",
        stingerCooldownEpisodes: production?.stingerCooldownEpisodes ?? null,
        reactionCooldownEpisodes: production?.reactionCooldownEpisodes ?? null,
        defaultIntroEnabled: production?.defaultIntroEnabled ?? true,
        defaultOutroEnabled: production?.defaultOutroEnabled ?? true,
        productionStyle: production?.productionStyle ?? null,
        sfxDensity: production?.sfxDensity ?? null,
      },
      sonicIdentity: (() => {
        const r = production?.sonicIdentity != null ? validateSonicIdentity(production.sonicIdentity) : null;
        return r && r.ok ? r.identity : DEFAULT_SONIC_IDENTITY;
      })(),
      assignments: (production?.soundAssignments ?? []).map((a) => ({
        assetId: a.assetId, role: a.role, orderIndex: a.orderIndex, enabled: a.enabled,
        gainDb: a.gainDb, fadeInMs: a.fadeInMs, fadeOutMs: a.fadeOutMs,
        cueFamily: a.cueFamily, weight: a.weight, isBrandedMotif: a.isBrandedMotif,
        maxUsesPerEpisode: a.maxUsesPerEpisode, minEpisodeCooldown: a.minEpisodeCooldown,
        allowedFormatIds: a.allowedFormatIds, prohibitedFormatIds: a.prohibitedFormatIds,
      })),
      resolvedProfile,
      assets: assets.map(toSafeAudioAssetDto),
    };
  } catch (err) {
    return { success: false, error: (err as Error).message || "Could not load sound settings." };
  }
}

const SAVE_ERROR_COPY: Record<string, string> = {
  podcast_not_found: "That show no longer exists.",
  podcast_forbidden: "That show belongs to another account.",
  podcast_configuration_changed: "This show's configuration changed in another window. Reload to pick up the latest version.",
  invalid_mode: "Pick a valid sound-profile mode.",
  invalid_cooldown_scope: "Pick a valid cooldown scope.",
  invalid_gain: "Gain must be between -24 and +6 dB.",
  invalid_fade: "Fades must be between 0 and 10000 ms.",
  invalid_weight: "Weight must be between 0 and 100.",
  duplicate_assignment: "The same asset is assigned twice to one role.",
  bookend_enabled_without_asset: "You enabled an intro/outro but assigned no variant. Add a variant or disable the bookend.",
  invalid_cue_family: "A cue family does not match its role.",
  cue_family_prohibited: "A cue family is prohibited by this show's sonic identity.",
  invalid_format_id: "An assignment references an unknown show format.",
  invalid_sonic_identity: "The sonic identity has an invalid value.",
  asset_not_assignable: "One of the selected assets cannot be assigned to this show.",
};

export async function savePodcastSound(input: {
  podcastId: string;
  expectedVersion: number;
  soundProfileMode: SoundProfileMode;
  targetLoudnessLufs?: number | null;
  cooldownScope?: "podcast" | "owner";
  stingerCooldownEpisodes?: number | null;
  reactionCooldownEpisodes?: number | null;
  defaultIntroEnabled?: boolean;
  defaultOutroEnabled?: boolean;
  assignments?: SoundAssignmentInput[];
  sonicIdentity?: unknown;
}) {
  const user = await currentUser();
  if (!user) return { success: false, error: "Sign in first." };
  const res = await savePodcastSoundProfile({
    db,
    podcastId: input.podcastId,
    expectedVersion: input.expectedVersion,
    canEdit: (p) => p.ownerId === user.id,
    profile: {
      soundProfileMode: input.soundProfileMode,
      targetLoudnessLufs: input.targetLoudnessLufs,
      cooldownScope: input.cooldownScope,
      stingerCooldownEpisodes: input.stingerCooldownEpisodes,
      reactionCooldownEpisodes: input.reactionCooldownEpisodes,
      defaultIntroEnabled: input.defaultIntroEnabled,
      defaultOutroEnabled: input.defaultOutroEnabled,
      assignments: input.assignments,
      sonicIdentity: input.sonicIdentity,
    },
  });
  if (!res.ok) {
    return {
      success: false,
      conflict: res.error.code === "podcast_configuration_changed",
      error: SAVE_ERROR_COPY[res.error.code] ?? `Save failed (${res.error.code}).`,
    };
  }
  revalidatePath(`/app/podcasts/${input.podcastId}/sound`);
  return { success: true, configVersion: res.configVersion };
}

export interface PreviewExample {
  seed: string;
  intro: string | null;
  outro: string | null;
  bed: string | null;
  introReason: string | null;
  outroReason: string | null;
  bedReason: string | null;
  transitionFamilies: string[];
  reactionFamilies: string[];
  exclusions: Array<{ assetId: string; role: string; reason: string }>;
}

/**
 * PREVIEW RESOLUTION (owner-gated, deterministic): show three example future
 * episode resolutions WITHOUT creating episodes or generating audio. Uses fixed
 * example seeds so the preview is stable. Names only — never storage URLs/keys.
 * Actual episode selection is frozen at EPISODE CREATION time.
 */
export async function previewPodcastSoundResolution(
  podcastId: string,
  formatId = "two_host_debate"
): Promise<{ success: boolean; error?: string; examples?: PreviewExample[]; note?: string }> {
  const user = await currentUser();
  if (!user) return { success: false, error: "Sign in to preview." };
  const pod = await db.podcast.findFirst({
    where: { id: podcastId, ownerId: user.id }, // owner-scoped
    include: { productionConfig: true },
  });
  if (!pod) return { success: false, error: "That show no longer exists." };
  const permitted = await resolvePodcastSoundProfile(db, { id: pod.id, ownerId: pod.ownerId }, pod.productionConfig);
  const nameOf = (r: { name?: string } | null | undefined) => (r?.name ?? null);
  const examples: PreviewExample[] = ["preview-example-1", "preview-example-2", "preview-example-3"].map((seed) => {
    const sel = selectEpisodeSoundVariants(permitted, { seed, formatId });
    return {
      seed,
      intro: nameOf(sel.intro),
      outro: nameOf(sel.outro),
      bed: nameOf(sel.bed),
      introReason: sel.selectionReasons?.intro ?? null,
      outroReason: sel.selectionReasons?.outro ?? null,
      bedReason: sel.selectionReasons?.bed ?? null,
      transitionFamilies: [...new Set(sel.stingers.map((s) => s.cueFamily).filter((f): f is string => !!f))],
      reactionFamilies: [...new Set(sel.reactions.map((s) => s.cueFamily).filter((f): f is string => !!f))],
      exclusions: sel.excluded,
    };
  });
  return { success: true, examples, note: "These are example resolutions. Each episode's exact selection is frozen at creation time." };
}
