"use server";

// Character Studio server actions — signed-in gated (AiHost is a GLOBAL table
// with no ownerId yet; per-account rosters are the NEXT step). Every mutation
// goes through requireSignedIn. Reuses the REAL voice-id validation rules
// (isVoiceIdValidForProvider — same rules as Step 7's ttsVoiceOverrides) and the
// REAL per-line TTS synthesis primitive (getTTSProvider().synthesizeSpeech — the
// exact call generateTtsSegments makes per line in Step 5) for auditions.

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

function parseLines(input: string): string[] {
  if (!input) return [];
  return input.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Save an existing host's character bible + voice assignment + documented voice
 * provenance. Voice ids are validated against the SAME real per-provider rules
 * the pipeline enforces (openai = fixed name list, fish = 32-hex) — invalid ids
 * are rejected, never silently accepted. voiceSource / voiceProvenanceNote are
 * written to the real columns (the Greene v. Google safeguard).
 */
export async function saveStudioHost(id: string, input: StudioHostInput) {
  const gate = await requireSignedIn();
  if (gate) return gate;
  try {
    if (!id) throw new Error("Host id is required.");
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
  const gate = await requireSignedIn();
  if (gate) return gate;
  try {
    await db.aiHost.update({ where: { id }, data: { isArchived: true } });
    revalidatePath("/studio/hosts");
    return { success: true as const };
  } catch (err: any) {
    return { success: false as const, error: err?.message || "Failed to archive the host." };
  }
}

export async function unarchiveHost(id: string) {
  const gate = await requireSignedIn();
  if (gate) return gate;
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
  const gate = await requireSignedIn();
  if (gate) return gate;
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
