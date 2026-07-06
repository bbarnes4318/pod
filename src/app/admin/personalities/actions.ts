"use server";

import { requireAdmin } from "@/lib/adminAuth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

// Helper to convert line-separated textarea input into a JSON array
function parseLines(input: string): string[] {
  if (!input) return [];
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Validation helper for clean slugs
function isValidSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug);
}

interface HostInput {
  name: string;
  slug: string;
  role: string;
  worldview: string;
  speakingStyle: string;
  catchphrasesRaw: string;
  likesRaw: string;
  dislikesRaw: string;
  argumentPatternsRaw: string;
  bannedPhrasesRaw: string;
  ttsProvider: string;
  ttsVoiceId: string;
  intensityLevel: number;
  isActive: boolean;
}

export async function createHost(input: HostInput) {
  await requireAdmin();
  try {
    // 1. Basic validation
    if (!input.name.trim()) throw new Error("Name is required");
    if (!input.slug.trim()) throw new Error("Slug is required");
    if (!isValidSlug(input.slug.trim())) {
      throw new Error("Slug must contain only lowercase letters, numbers, and hyphens (e.g. max-voltage)");
    }
    if (!input.role.trim()) throw new Error("Role is required");
    if (!input.worldview.trim()) throw new Error("Worldview is required");
    if (!input.speakingStyle.trim()) throw new Error("Speaking style is required");
    if (!input.ttsProvider.trim()) throw new Error("TTS provider is required");
    if (!input.ttsVoiceId.trim()) throw new Error("TTS Voice ID is required");
    
    const intensity = Math.round(Number(input.intensityLevel));
    if (isNaN(intensity) || intensity < 1 || intensity > 10) {
      throw new Error("Intensity level must be a number between 1 and 10");
    }

    const slug = input.slug.trim().toLowerCase();

    // 2. Uniqueness validation
    const existing = await db.aiHost.findUnique({
      where: { slug },
    });
    if (existing) {
      throw new Error(`Slug '${slug}' is already taken. Please choose another unique slug.`);
    }

    // 3. Create host record
    const host = await db.aiHost.create({
      data: {
        name: input.name.trim(),
        slug,
        role: input.role.trim(),
        worldview: input.worldview.trim(),
        speakingStyle: input.speakingStyle.trim(),
        catchphrases: parseLines(input.catchphrasesRaw),
        likes: parseLines(input.likesRaw),
        dislikes: parseLines(input.dislikesRaw),
        argumentPatterns: parseLines(input.argumentPatternsRaw),
        bannedPhrases: parseLines(input.bannedPhrasesRaw),
        ttsProvider: input.ttsProvider.trim(),
        ttsVoiceId: input.ttsVoiceId.trim(),
        intensityLevel: intensity,
        isActive: input.isActive,
      },
    });

    revalidatePath("/admin/personalities");
    return { success: true, hostId: host.id };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to create AI host" };
  }
}

export async function updateHost(id: string, input: HostInput) {
  await requireAdmin();
  try {
    // 1. Basic validation
    if (!id) throw new Error("Host ID is required for update");
    if (!input.name.trim()) throw new Error("Name is required");
    if (!input.slug.trim()) throw new Error("Slug is required");
    if (!isValidSlug(input.slug.trim())) {
      throw new Error("Slug must contain only lowercase letters, numbers, and hyphens (e.g. max-voltage)");
    }
    if (!input.role.trim()) throw new Error("Role is required");
    if (!input.worldview.trim()) throw new Error("Worldview is required");
    if (!input.speakingStyle.trim()) throw new Error("Speaking style is required");
    if (!input.ttsProvider.trim()) throw new Error("TTS provider is required");
    if (!input.ttsVoiceId.trim()) throw new Error("TTS Voice ID is required");
    
    const intensity = Math.round(Number(input.intensityLevel));
    if (isNaN(intensity) || intensity < 1 || intensity > 10) {
      throw new Error("Intensity level must be a number between 1 and 10");
    }

    const slug = input.slug.trim().toLowerCase();

    // 2. Uniqueness validation (excluding current host)
    const existing = await db.aiHost.findFirst({
      where: {
        slug,
        id: { not: id },
      },
    });
    if (existing) {
      throw new Error(`Slug '${slug}' is already taken by another host.`);
    }

    // 3. Update host record
    const host = await db.aiHost.update({
      where: { id },
      data: {
        name: input.name.trim(),
        slug,
        role: input.role.trim(),
        worldview: input.worldview.trim(),
        speakingStyle: input.speakingStyle.trim(),
        catchphrases: parseLines(input.catchphrasesRaw),
        likes: parseLines(input.likesRaw),
        dislikes: parseLines(input.dislikesRaw),
        argumentPatterns: parseLines(input.argumentPatternsRaw),
        bannedPhrases: parseLines(input.bannedPhrasesRaw),
        ttsProvider: input.ttsProvider.trim(),
        ttsVoiceId: input.ttsVoiceId.trim(),
        intensityLevel: intensity,
        isActive: input.isActive,
      },
    });

    revalidatePath("/admin/personalities");
    revalidatePath(`/admin/personalities/${id}`);
    return { success: true, hostId: host.id };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to update AI host" };
  }
}

export async function toggleHostStatus(id: string, isActive: boolean) {
  await requireAdmin();
  try {
    if (!id) throw new Error("Host ID is required");

    await db.aiHost.update({
      where: { id },
      data: { isActive },
    });

    revalidatePath("/admin/personalities");
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to toggle host status" };
  }
}

export async function getElevenLabsVoices() {
  await requireAdmin();
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY is not configured. Add it in your environment to browse voices.");
    }

    // /v1/voices returns every voice available to the account (premade,
    // professional, cloned, and any added from the voice library), each with
    // a preview_url and descriptive labels we use for filtering.
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      method: "GET",
      headers: {
        "xi-api-key": apiKey,
        "Accept": "application/json",
      },
      // Voice list changes rarely; let Next cache it briefly to keep the UI snappy.
      next: { revalidate: 300 },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`ElevenLabs API error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    const voices = Array.isArray(data?.voices) ? data.voices : [];

    return {
      success: true,
      voices: voices.map((v: any) => ({
        id: v.voice_id,
        name: v.name || "Unnamed",
        category: v.category || "",
        gender: v.labels?.gender || "",
        accent: v.labels?.accent || "",
        age: v.labels?.age || "",
        useCase: v.labels?.use_case || v.labels?.["use case"] || "",
        description: v.description || v.labels?.description || "",
        preview_url: v.preview_url || null,
      })),
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch ElevenLabs voices", voices: [] };
  }
}

export async function getCartesiaVoices() {
  await requireAdmin();
  try {
    const apiKey = process.env.CARTESIA_API_KEY;
    if (!apiKey) {
      throw new Error("CARTESIA_API_KEY is not configured.");
    }

    const response = await fetch("https://api.cartesia.ai/voices", {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        "Cartesia-Version": "2024-06-10",
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Cartesia API error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    
    // Sort and map the voice list
    const voices = Array.isArray(data) ? data : [];
    return {
      success: true,
      voices: voices.map((v: any) => ({
        id: v.id,
        name: v.name,
        description: v.description || "",
        gender: v.gender || "",
        language: v.language || "",
        preview_url: v.preview_url || null,
      })),
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch Cartesia voices" };
  }
}
