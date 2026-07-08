"use server";

// Character Studio server actions — per-account host ownership.
//
// AiHost.ownerId is nullable: null = system/shared host (visible read-only to
// everyone, never editable by non-admins); non-null = owned by that user. Every
// MUTATION is owner-gated server-side (requireOwnedHost) so a user can never
// edit/archive/delete another account's — or a shared — host; they clone it
// first. New hosts stamp ownerId = currentUser. Reuses the REAL voice-id
// validation (isVoiceIdValidForProvider) and the REAL per-line TTS primitive
// (getTTSProvider().synthesizeSpeech, Step 5) for auditions.

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { getTTSProvider } from "@/lib/providers/tts/factory";
import { isVoiceIdValidForProvider } from "@/lib/providers/tts/voiceResolution";
import { isTtsProviderId } from "@/lib/providers/tts/providerIds";
import { VOICE_SOURCES, type StudioHostInput } from "./constants";

async function requireSignedIn(): Promise<{ success: false; error: string } | null> {
  if (!(await currentUser())) {
    return { success: false as const, error: "Please sign in to manage hosts." };
  }
  return null;
}

/**
 * Ownership gate for a mutation: the host must exist AND be owned by the current
 * user (or the user is an admin). Shared (ownerId=null) and other users' hosts
 * are rejected here — server-side, not just in the UI. This is the check that
 * guarantees a user can never mutate a host that isn't theirs.
 */
async function requireOwnedHost(id: string) {
  const user = await currentUser();
  if (!user) return { ok: false as const, error: "Please sign in to manage hosts." };
  if (!id) return { ok: false as const, error: "Host id is required." };
  const host = await db.aiHost.findUnique({ where: { id }, select: { id: true, ownerId: true } });
  if (!host) return { ok: false as const, error: "That host no longer exists." };
  const isAdmin = user.role === "ADMIN";
  if (host.ownerId !== user.id && !isAdmin) {
    return {
      ok: false as const,
      error:
        host.ownerId === null
          ? "This is a shared starter host — clone it to your roster to make an editable copy."
          : "This host belongs to another account.",
    };
  }
  return { ok: true as const, user, host };
}

function parseLines(input: string): string[] {
  if (!input) return [];
  return input.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function slugify(name: string): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return base || "host";
}

/** A slug guaranteed unique against AiHost.slug (@unique). */
async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  const existing = await db.aiHost.findUnique({ where: { slug: base }, select: { id: true } });
  if (!existing) return base;
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

/**
 * Save an existing host's character bible + voice assignment + documented voice
 * provenance. Voice ids are validated against the SAME real per-provider rules
 * the pipeline enforces (openai = fixed name list, fish = 32-hex) — invalid ids
 * are rejected, never silently accepted. voiceSource / voiceProvenanceNote are
 * written to the real columns (the Greene v. Google safeguard).
 */
export async function saveStudioHost(id: string, input: StudioHostInput) {
  const owned = await requireOwnedHost(id);
  if (!owned.ok) return { success: false as const, error: owned.error };
  try {
    const name = input.name.trim();
    if (!name) throw new Error("Name is required.");
    const role = input.role.trim();
    const worldview = input.worldview.trim();
    const speakingStyle = input.speakingStyle.trim();
    if (!role || !worldview || !speakingStyle) {
      throw new Error("Role, worldview, and speaking style are required.");
    }
    const intensity = Math.round(Number(input.intensityLevel));
    if (!Number.isFinite(intensity) || intensity < 1 || intensity > 10) {
      throw new Error("Intensity must be a number between 1 and 10.");
    }

    const provider = input.ttsProvider.trim().toLowerCase();
    if (!isTtsProviderId(provider)) {
      throw new Error(`Unknown TTS provider '${input.ttsProvider}'.`);
    }
    const voiceId = input.ttsVoiceId.trim();
    if (!voiceId) throw new Error("A voice id is required.");
    // The stub engine is a non-audible placeholder; real engines must carry a
    // provider-valid voice id (rejected here, not at synthesis time).
    if (provider !== "stub" && !isVoiceIdValidForProvider(provider, voiceId)) {
      throw new Error(
        provider === "openai"
          ? "Invalid OpenAI voice — must be one of the OpenAI voice names (e.g. onyx, echo, nova)."
          : provider === "fish"
            ? "Invalid Fish reference id — it must be a 32-character hex string."
            : `That voice id isn't valid for ${provider}.`
      );
    }

    const voiceSource = input.voiceSource.trim();
    if (voiceSource && !(VOICE_SOURCES as readonly string[]).includes(voiceSource)) {
      throw new Error("Voice source must be owned, licensed, or synthetic-stock.");
    }

    await db.aiHost.update({
      where: { id },
      data: {
        name,
        role,
        worldview,
        speakingStyle,
        catchphrases: parseLines(input.catchphrasesRaw),
        bannedPhrases: parseLines(input.boundariesRaw),
        intensityLevel: intensity,
        ttsProvider: provider,
        ttsVoiceId: voiceId,
        // Provenance persists to the real columns; empty string clears to null.
        voiceSource: voiceSource || null,
        voiceProvenanceNote: input.voiceProvenanceNote.trim() || null,
      },
    });

    revalidatePath("/studio/hosts");
    return { success: true as const };
  } catch (err: any) {
    return { success: false as const, error: err?.message || "Failed to save the host." };
  }
}

/**
 * Audition a voice assignment: synthesize a short line in the given provider +
 * voiceId using the REAL TTS path (getTTSProvider().synthesizeSpeech — the same
 * primitive Step 5's generateTtsSegments calls per line), returned as an inline
 * base64 data URL. No DB write, no S3. If the assignment can't produce real
 * audio (stub engine, invalid id, or a provider/key failure) it reports that
 * honestly rather than playing a canned clip.
 */
export async function auditionHostVoice(input: {
  provider: string;
  voiceId: string;
  name: string;
  role: string;
  speakingStyle: string;
  intensityLevel: number;
  line?: string;
}) {
  const gate = await requireSignedIn();
  if (gate) return gate;

  const provider = input.provider.trim().toLowerCase();
  const voiceId = input.voiceId.trim();
  if (!isTtsProviderId(provider)) {
    return { success: false as const, error: `Unknown TTS provider '${input.provider}'.` };
  }
  if (provider === "stub") {
    return {
      success: false as const,
      error: "This host is on the stub engine — assign a real voice (ElevenLabs, Cartesia, OpenAI, Boson, or Fish) to audition it.",
    };
  }
  if (!isVoiceIdValidForProvider(provider, voiceId)) {
    return { success: false as const, error: `The assigned voice id isn't valid for ${provider} — fix it before auditioning.` };
  }

  const line =
    input.line?.trim() ||
    "Alright, let's get into it — this is the take everyone's going to be arguing about all week.";
  const voiceDirection = `You are "${input.name}", a sports debate podcast host mid-episode, talking to your co-host. ${input.role}. Delivery style: ${input.speakingStyle} Overall intensity ${Math.round(Number(input.intensityLevel) || 5)}/10.`;

  try {
    const providerImpl = getTTSProvider(provider);
    const result = await providerImpl.synthesizeSpeech({
      text: line,
      voiceId,
      speakerName: input.name,
      tone: "analytical",
      energy: "medium",
      voiceDirection,
      format: "mp3",
    });
    if (!result?.audioBuffer?.length) {
      return { success: false as const, error: "The engine returned no audio for this voice." };
    }
    const contentType = result.contentType || "audio/mpeg";
    const audioDataUrl = `data:${contentType};base64,${result.audioBuffer.toString("base64")}`;
    return { success: true as const, audioDataUrl, durationMs: result.durationMs ?? null };
  } catch (err: any) {
    // Honest failure — e.g. a missing API key or an engine error. No fake audio.
    return { success: false as const, error: `Couldn't audition this voice: ${err?.message || "the engine failed"}.` };
  }
}

/** How many existing episodes reference this host (Episode.hostIds `has`). */
async function episodeReferenceCount(hostId: string): Promise<number> {
  return db.episode.count({ where: { hostIds: { has: hostId } } });
}

/**
 * Soft-archive a host: it leaves active pickers but every episode that already
 * references it is untouched (those pages resolve hosts by id without an
 * isActive/isArchived filter). Always safe — no reference check needed.
 */
export async function archiveHost(id: string) {
  const owned = await requireOwnedHost(id);
  if (!owned.ok) return { success: false as const, error: owned.error };
  try {
    await db.aiHost.update({ where: { id }, data: { isArchived: true } });
    revalidatePath("/studio/hosts");
    return { success: true as const };
  } catch (err: any) {
    return { success: false as const, error: err?.message || "Failed to archive the host." };
  }
}

export async function unarchiveHost(id: string) {
  const owned = await requireOwnedHost(id);
  if (!owned.ok) return { success: false as const, error: owned.error };
  try {
    await db.aiHost.update({ where: { id }, data: { isArchived: false } });
    revalidatePath("/studio/hosts");
    return { success: true as const };
  } catch (err: any) {
    return { success: false as const, error: err?.message || "Failed to restore the host." };
  }
}

/**
 * Hard-delete — ONLY permitted for a host no episode references. Any referenced
 * host is protected (orphan protection): the caller is steered to archive
 * instead, so existing episodes never lose their cast.
 */
export async function deleteHostSafely(id: string) {
  const owned = await requireOwnedHost(id);
  if (!owned.ok) return { success: false as const, error: owned.error };
  try {
    const [epRefs, segRefs] = await Promise.all([
      episodeReferenceCount(id),
      db.audioSegment.count({ where: { hostId: id } }),
    ]);
    if (epRefs > 0 || segRefs > 0) {
      return {
        success: false as const,
        error: `This host is used by ${epRefs} episode(s) and ${segRefs} audio segment(s). Archive it instead — deleting would orphan them.`,
        referenced: true as const,
      };
    }
    await db.aiHost.delete({ where: { id } });
    revalidatePath("/studio/hosts");
    return { success: true as const };
  } catch (err: any) {
    return { success: false as const, error: err?.message || "Failed to delete the host." };
  }
}

/** Shared validation for create/save persona + voice input. */
function validateHostInput(input: StudioHostInput) {
  const name = input.name.trim();
  if (!name) throw new Error("Name is required.");
  const role = input.role.trim();
  const worldview = input.worldview.trim();
  const speakingStyle = input.speakingStyle.trim();
  if (!role || !worldview || !speakingStyle) {
    throw new Error("Role, worldview, and speaking style are required.");
  }
  const intensity = Math.round(Number(input.intensityLevel));
  if (!Number.isFinite(intensity) || intensity < 1 || intensity > 10) {
    throw new Error("Intensity must be a number between 1 and 10.");
  }
  const provider = input.ttsProvider.trim().toLowerCase();
  if (!isTtsProviderId(provider)) throw new Error(`Unknown TTS provider '${input.ttsProvider}'.`);
  const voiceId = input.ttsVoiceId.trim();
  if (!voiceId) throw new Error("A voice id is required.");
  if (provider !== "stub" && !isVoiceIdValidForProvider(provider, voiceId)) {
    throw new Error(
      provider === "openai"
        ? "Invalid OpenAI voice — must be one of the OpenAI voice names (e.g. onyx, echo, nova)."
        : provider === "fish"
          ? "Invalid Fish reference id — it must be a 32-character hex string."
          : `That voice id isn't valid for ${provider}.`
    );
  }
  const voiceSource = input.voiceSource.trim();
  if (voiceSource && !(VOICE_SOURCES as readonly string[]).includes(voiceSource)) {
    throw new Error("Voice source must be owned, licensed, or synthetic-stock.");
  }
  return { name, role, worldview, speakingStyle, intensity, provider, voiceId, voiceSource };
}

/**
 * Create a brand-new host OWNED by the current user (ownerId stamped). Uses the
 * same voice-id validation as save. The slug is auto-generated + made unique.
 */
export async function createStudioHost(input: StudioHostInput) {
  const user = await currentUser();
  if (!user) return { success: false as const, error: "Please sign in to create hosts." };
  try {
    const v = validateHostInput(input);
    const host = await db.aiHost.create({
      data: {
        name: v.name,
        slug: await uniqueSlug(v.name),
        role: v.role,
        worldview: v.worldview,
        speakingStyle: v.speakingStyle,
        catchphrases: parseLines(input.catchphrasesRaw),
        likes: [],
        dislikes: [],
        argumentPatterns: [],
        bannedPhrases: parseLines(input.boundariesRaw),
        ttsProvider: v.provider,
        ttsVoiceId: v.voiceId,
        intensityLevel: v.intensity,
        voiceSource: v.voiceSource || null,
        voiceProvenanceNote: input.voiceProvenanceNote.trim() || null,
        isActive: true,
        isArchived: false,
        ownerId: user.id, // stamp ownership
      },
      select: { id: true },
    });
    revalidatePath("/studio/hosts");
    return { success: true as const, hostId: host.id };
  } catch (err: any) {
    return { success: false as const, error: err?.message || "Failed to create the host." };
  }
}

/**
 * Clone a SHARED (ownerId=null) or your own host into an owner-owned editable
 * copy — the mechanism that gives each account independent characters (so it's
 * never "the same two voices everywhere"). Another user's private host cannot be
 * cloned. The full persona + voice assignment + provenance carry over; the copy
 * is owned by the current user with a fresh unique slug.
 */
export async function cloneHostToRoster(sourceId: string) {
  const user = await currentUser();
  if (!user) return { success: false as const, error: "Please sign in to clone hosts." };
  try {
    const src = await db.aiHost.findUnique({ where: { id: sourceId } });
    if (!src) return { success: false as const, error: "That host no longer exists." };
    // Clonable when shared (null owner), owned by me, or I'm an admin.
    if (src.ownerId !== null && src.ownerId !== user.id && user.role !== "ADMIN") {
      return { success: false as const, error: "You can only clone shared starter hosts or your own." };
    }
    const copy = await db.aiHost.create({
      data: {
        name: src.name,
        slug: await uniqueSlug(src.name),
        role: src.role,
        worldview: src.worldview,
        speakingStyle: src.speakingStyle,
        catchphrases: src.catchphrases as any,
        likes: src.likes as any,
        dislikes: src.dislikes as any,
        argumentPatterns: src.argumentPatterns as any,
        bannedPhrases: src.bannedPhrases as any,
        ttsProvider: src.ttsProvider,
        ttsVoiceId: src.ttsVoiceId,
        intensityLevel: src.intensityLevel,
        voiceSource: src.voiceSource,
        voiceProvenanceNote: src.voiceProvenanceNote,
        isActive: true,
        isArchived: false,
        ownerId: user.id, // the copy is mine
      },
      select: { id: true },
    });
    revalidatePath("/studio/hosts");
    return { success: true as const, hostId: copy.id };
  } catch (err: any) {
    return { success: false as const, error: err?.message || "Failed to clone the host." };
  }
}
