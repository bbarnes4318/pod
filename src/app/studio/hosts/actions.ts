"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { getTTSProvider } from "@/lib/providers/tts/factory";
import { isVoiceIdValidForProvider } from "@/lib/providers/tts/voiceResolution";
import { isTtsProviderId } from "@/lib/providers/tts/providerIds";
import {
  compileHostStudioProfile,
  defaultHostStudioSettings,
  hostStudioSettingsSchema,
  previewDirectionFor,
  type HostStudioSettings,
} from "@/lib/hosts/hostStudioProfile";
import {
  createFishVoiceModel,
  decodeBase64Audio,
  designFishVoice,
  type FishVoiceSample,
} from "@/lib/providers/tts/fishVoiceStudio";
import { PLACEHOLDER_USER_VOICE, VOICE_SOURCES, type PreviewScenario, type StudioHostInput } from "./constants";

async function requireSignedIn(): Promise<{ success: false; error: string } | null> {
  if (!(await currentUser())) return { success: false as const, error: "Please sign in to manage hosts." };
  return null;
}

async function requireOwnedHost(id: string) {
  const user = await currentUser();
  if (!user) return { ok: false as const, error: "Please sign in to manage hosts." };
  if (!id) return { ok: false as const, error: "Host id is required." };
  const host = await db.aiHost.findUnique({ where: { id }, select: { id: true, ownerId: true, name: true } });
  if (!host) return { ok: false as const, error: "That host no longer exists." };
  const isAdmin = user.role === "ADMIN";
  if (host.ownerId !== user.id && !isAdmin) {
    return {
      ok: false as const,
      error: host.ownerId === null
        ? "This is a shared starter host — clone it to your roster to make an editable copy."
        : "This host belongs to another account.",
    };
  }
  return { ok: true as const, user, host };
}

function parseLines(input?: string): string[] {
  if (!input) return [];
  return [...new Set(input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

function slugify(name: string): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return base || "host";
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  const existing = await db.aiHost.findUnique({ where: { slug: base }, select: { id: true } });
  if (!existing) return base;
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

function legacySettings(input: StudioHostInput): HostStudioSettings {
  const defaults = defaultHostStudioSettings();
  return {
    ...defaults,
    customRole: input.role?.trim() || defaults.customRole,
    belief: input.worldview?.trim() || defaults.belief,
    castPriority: Math.max(1, Math.min(10, Math.round(Number(input.intensityLevel ?? defaults.castPriority)))),
    argumentPatterns: parseLines(input.argumentPatternsRaw),
    bannedPhrases: parseLines(input.boundariesRaw),
    prohibitedTraits: parseLines(input.prohibitedTraitsRaw),
    catchphrases: parseLines(input.catchphrasesRaw),
    extraInstructions: input.speakingStyle?.trim() || "",
  };
}

function normalizeHostInput(input: StudioHostInput) {
  const name = input.name.trim();
  if (!name) throw new Error("Give the host a name.");
  const settings = input.settings
    ? hostStudioSettingsSchema.parse(input.settings)
    : legacySettings(input);
  const compiled = compileHostStudioProfile(settings);

  const provider = (input.ttsProvider || "fish").trim().toLowerCase();
  if (!isTtsProviderId(provider)) throw new Error(`Unknown voice provider '${input.ttsProvider}'.`);
  const voiceId = input.ttsVoiceId.trim() || PLACEHOLDER_USER_VOICE;
  const isPlaceholder = /^PLACEHOLDER[_-]/i.test(voiceId);
  if (!isPlaceholder && provider !== "stub" && !isVoiceIdValidForProvider(provider, voiceId)) {
    throw new Error(provider === "fish"
      ? "That Fish voice is not valid. Choose or create a voice in the Voice step."
      : `That voice is not valid for ${provider}.`);
  }
  const voiceSource = input.voiceSource.trim();
  if (voiceSource && !(VOICE_SOURCES as readonly string[]).includes(voiceSource)) {
    throw new Error("Voice source must be owned, licensed, or synthetic/stock.");
  }
  return { name, settings, compiled, provider, voiceId, voiceSource };
}

function hostWriteData(input: StudioHostInput) {
  const value = normalizeHostInput(input);
  return {
    value,
    data: {
      name: value.name,
      role: value.compiled.role,
      worldview: value.compiled.worldview,
      speakingStyle: value.compiled.speakingStyle,
      catchphrases: value.compiled.catchphrases,
      argumentPatterns: value.compiled.argumentPatterns,
      bannedPhrases: value.compiled.bannedPhrases,
      intensityLevel: value.compiled.intensityLevel,
      performanceProfile: value.compiled.performanceProfile as never,
      ttsProvider: value.provider,
      ttsVoiceId: value.voiceId,
      voiceSource: value.voiceSource || null,
      voiceProvenanceNote: input.voiceProvenanceNote.trim() || null,
    },
  };
}

export async function saveStudioHost(id: string, input: StudioHostInput) {
  const owned = await requireOwnedHost(id);
  if (!owned.ok) return { success: false as const, error: owned.error };
  try {
    const { data } = hostWriteData(input);
    await db.aiHost.update({ where: { id }, data });
    revalidatePath("/studio/hosts");
    return { success: true as const, hostId: id };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "Failed to save the host." };
  }
}

export async function createStudioHost(input: StudioHostInput) {
  const user = await currentUser();
  if (!user) return { success: false as const, error: "Please sign in to create hosts." };
  try {
    const { value, data } = hostWriteData(input);
    const host = await db.aiHost.create({
      data: {
        ...data,
        slug: await uniqueSlug(value.name),
        likes: [],
        dislikes: [],
        isActive: true,
        isArchived: false,
        ownerId: user.id,
      },
      select: { id: true },
    });
    revalidatePath("/studio/hosts");
    return { success: true as const, hostId: host.id };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "Failed to create the host." };
  }
}

const PREVIEW = {
  hello: {
    line: "Alright, let's get into it. I know exactly which part of this story does not add up.",
    tone: "conversational",
    energy: "medium" as const,
    interruption: false,
  },
  disagree: {
    line: "No—hold on. That sounds clean because you skipped the person who paid for the decision.",
    tone: "incredulous",
    energy: "medium" as const,
    interruption: true,
  },
  pressure: {
    line: "That's the excuse. Now tell me who chose it, and who had to live with it.",
    tone: "heated",
    energy: "high" as const,
    interruption: false,
  },
} as const;

export async function auditionHostVoice(input: {
  provider: string;
  voiceId: string;
  name: string;
  settings?: HostStudioSettings;
  role?: string;
  speakingStyle?: string;
  intensityLevel?: number;
  scenario?: PreviewScenario;
  line?: string;
}) {
  const gate = await requireSignedIn();
  if (gate) return gate;
  const provider = input.provider.trim().toLowerCase();
  const voiceId = input.voiceId.trim();
  if (!isTtsProviderId(provider)) return { success: false as const, error: "That voice provider is not supported." };
  if (provider === "stub" || /^PLACEHOLDER[_-]/i.test(voiceId)) {
    return { success: false as const, error: "This host still needs a real voice. Create, clone, or attach one first." };
  }
  if (!isVoiceIdValidForProvider(provider, voiceId)) {
    return { success: false as const, error: "The assigned voice is not valid." };
  }

  const settings = input.settings
    ? hostStudioSettingsSchema.parse(input.settings)
    : legacySettings({
        name: input.name,
        role: input.role,
        worldview: input.role,
        speakingStyle: input.speakingStyle,
        intensityLevel: input.intensityLevel,
        ttsProvider: provider,
        ttsVoiceId: voiceId,
        voiceSource: "",
        voiceProvenanceNote: "",
      });
  const compiled = compileHostStudioProfile(settings);
  const profile = compiled.performanceProfile;
  const scenario = input.scenario ?? "hello";
  const preview = PREVIEW[scenario];
  const fish = profile.providerOverrides.fish;
  let speed = profile.baselinePace;
  let volume = 0;
  if (scenario === "pressure") {
    if (profile.angerStyle === "slower_quieter") {
      speed = Math.max(0.65, profile.baselinePace * 0.9);
      volume = -2;
    } else if (profile.angerStyle === "louder_slower") {
      speed = Math.max(0.65, profile.baselinePace * 0.92);
      volume = 2;
    } else {
      speed = profile.maxEscalationPace;
      volume = 2;
    }
  }

  try {
    const result = await getTTSProvider(provider).synthesizeSpeech({
      text: input.line?.trim() || preview.line,
      voiceId,
      speakerName: input.name,
      tone: preview.tone,
      energy: preview.energy,
      isInterruption: preview.interruption,
      voiceDirection: previewDirectionFor(settings),
      speed,
      volume,
      temperature: fish?.temperature,
      topP: fish?.topP,
      format: "mp3",
    });
    if (!result.audioBuffer?.length) return { success: false as const, error: "The voice engine returned no audio." };
    const contentType = result.contentType || "audio/mpeg";
    return {
      success: true as const,
      audioDataUrl: `data:${contentType};base64,${result.audioBuffer.toString("base64")}`,
      durationMs: result.durationMs ?? null,
    };
  } catch (error) {
    return { success: false as const, error: `Couldn't preview this voice: ${error instanceof Error ? error.message : "the engine failed"}.` };
  }
}

export async function designHostVoice(input: {
  instruction: string;
  previewText?: string;
  speed?: number;
}) {
  const gate = await requireSignedIn();
  if (gate) return gate;
  try {
    const candidates = await designFishVoice({
      instruction: input.instruction,
      referenceText: input.previewText,
      speed: input.speed,
      candidateCount: 3,
      language: "en",
    });
    return {
      success: true as const,
      candidates: candidates.map((candidate) => ({
        ...candidate,
        audioDataUrl: `data:audio/wav;base64,${candidate.audioBase64}`,
      })),
    };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "Voice design failed." };
  }
}

async function attachFishVoice(hostId: string, voiceId: string, source: string, note: string) {
  await db.aiHost.update({
    where: { id: hostId },
    data: { ttsProvider: "fish", ttsVoiceId: voiceId, voiceSource: source, voiceProvenanceNote: note },
  });
  revalidatePath("/studio/hosts");
}

export async function saveDesignedHostVoice(hostId: string, input: {
  title: string;
  audioBase64: string;
  previewText?: string;
  instruction?: string;
}) {
  const owned = await requireOwnedHost(hostId);
  if (!owned.ok) return { success: false as const, error: owned.error };
  try {
    const voice = await createFishVoiceModel({
      title: input.title || `${owned.host.name} designed voice`,
      description: `Designed in Host Studio. ${input.instruction || ""}`.slice(0, 1000),
      sourceTag: "voice-design",
      samples: [{
        bytes: decodeBase64Audio(input.audioBase64),
        filename: "designed-voice.wav",
        contentType: "audio/wav",
        transcript: input.previewText,
      }],
    });
    await attachFishVoice(hostId, voice.id, "synthetic-stock", `Fish voice-design candidate selected in Host Studio. Model state: ${voice.state}.`);
    return { success: true as const, voiceId: voice.id, state: voice.state };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "Could not save the designed voice." };
  }
}

export async function cloneHostVoice(hostId: string, formData: FormData) {
  const owned = await requireOwnedHost(hostId);
  if (!owned.ok) return { success: false as const, error: owned.error };
  if (String(formData.get("consent") || "") !== "true") {
    return { success: false as const, error: "Confirm that you own this voice or have written permission to clone it." };
  }
  try {
    const files = formData.getAll("voiceSamples").filter((item): item is File => item instanceof File && item.size > 0);
    const transcript = String(formData.get("transcript") || "").trim();
    const source = String(formData.get("voiceSource") || "owned") === "licensed" ? "licensed" : "owned";
    const samples: FishVoiceSample[] = await Promise.all(files.map(async (file, index) => ({
      bytes: new Uint8Array(await file.arrayBuffer()),
      filename: file.name || `voice-sample-${index + 1}.wav`,
      contentType: file.type || "audio/wav",
      transcript: transcript || undefined,
    })));
    const voice = await createFishVoiceModel({
      title: String(formData.get("title") || `${owned.host.name} voice`),
      description: "Private voice clone created through Host Studio with user attestation.",
      sourceTag: "authorized-clone",
      samples,
    });
    await attachFishVoice(hostId, voice.id, source, `User attested on ${new Date().toISOString()} that they own this voice or have written permission to clone it. Fish model state: ${voice.state}.`);
    return { success: true as const, voiceId: voice.id, state: voice.state };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "Voice cloning failed." };
  }
}

export async function assignExistingFishVoice(hostId: string, input: { voiceId: string; source: string; note?: string }) {
  const owned = await requireOwnedHost(hostId);
  if (!owned.ok) return { success: false as const, error: owned.error };
  const voiceId = input.voiceId.trim();
  if (!/^[0-9a-f]{32}$/i.test(voiceId)) return { success: false as const, error: "Enter a valid 32-character Fish voice ID." };
  if (!(VOICE_SOURCES as readonly string[]).includes(input.source)) return { success: false as const, error: "Choose who owns or licenses this voice." };
  await attachFishVoice(hostId, voiceId, input.source, input.note?.trim() || "Existing Fish voice attached in Host Studio.");
  return { success: true as const, voiceId };
}

async function episodeReferenceCount(hostId: string): Promise<number> {
  return db.episode.count({ where: { hostIds: { has: hostId } } });
}

export async function archiveHost(id: string) {
  const owned = await requireOwnedHost(id);
  if (!owned.ok) return { success: false as const, error: owned.error };
  try {
    await db.aiHost.update({ where: { id }, data: { isArchived: true } });
    revalidatePath("/studio/hosts");
    return { success: true as const };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "Failed to archive the host." };
  }
}

export async function unarchiveHost(id: string) {
  const owned = await requireOwnedHost(id);
  if (!owned.ok) return { success: false as const, error: owned.error };
  try {
    await db.aiHost.update({ where: { id }, data: { isArchived: false } });
    revalidatePath("/studio/hosts");
    return { success: true as const };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "Failed to restore the host." };
  }
}

export async function deleteHostSafely(id: string) {
  const owned = await requireOwnedHost(id);
  if (!owned.ok) return { success: false as const, error: owned.error };
  try {
    const [episodeRefs, segmentRefs] = await Promise.all([
      episodeReferenceCount(id),
      db.audioSegment.count({ where: { hostId: id } }),
    ]);
    if (episodeRefs > 0 || segmentRefs > 0) {
      return {
        success: false as const,
        error: `This host is used by ${episodeRefs} episode(s) and ${segmentRefs} audio segment(s). Archive it instead.`,
      };
    }
    await db.aiHost.delete({ where: { id } });
    revalidatePath("/studio/hosts");
    return { success: true as const };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "Failed to delete the host." };
  }
}

export async function cloneHostToRoster(sourceId: string) {
  const user = await currentUser();
  if (!user) return { success: false as const, error: "Please sign in to clone hosts." };
  try {
    const source = await db.aiHost.findUnique({ where: { id: sourceId } });
    if (!source) return { success: false as const, error: "That host no longer exists." };
    if (source.ownerId !== null && source.ownerId !== user.id && user.role !== "ADMIN") {
      return { success: false as const, error: "You can only clone shared starter hosts or your own." };
    }
    const copy = await db.aiHost.create({
      data: {
        name: source.name,
        slug: await uniqueSlug(source.name),
        role: source.role,
        worldview: source.worldview,
        speakingStyle: source.speakingStyle,
        catchphrases: source.catchphrases as never,
        likes: source.likes as never,
        dislikes: source.dislikes as never,
        argumentPatterns: source.argumentPatterns as never,
        bannedPhrases: source.bannedPhrases as never,
        performanceProfile: source.performanceProfile as never,
        ttsProvider: source.ttsProvider,
        ttsVoiceId: source.ttsVoiceId,
        intensityLevel: source.intensityLevel,
        voiceSource: source.voiceSource,
        voiceProvenanceNote: source.voiceProvenanceNote,
        isActive: true,
        isArchived: false,
        ownerId: user.id,
      },
      select: { id: true },
    });
    revalidatePath("/studio/hosts");
    return { success: true as const, hostId: copy.id };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "Failed to clone the host." };
  }
}
