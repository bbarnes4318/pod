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
  assignments?: Array<{ assetId: string; role: string; orderIndex: number; gainDb: number | null; fadeInMs: number | null; fadeOutMs: number | null }>;
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
      assignments: (production?.soundAssignments ?? []).map((a) => ({
        assetId: a.assetId, role: a.role, orderIndex: a.orderIndex, gainDb: a.gainDb, fadeInMs: a.fadeInMs, fadeOutMs: a.fadeOutMs,
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
  duplicate_assignment: "The same asset is assigned twice to one role.",
  multiple_singleton: "A show can have only one intro, one outro, and one bed.",
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
