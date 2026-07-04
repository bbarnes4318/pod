"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

/**
 * Assign an ElevenLabs voice to a host in one click: sets the host's TTS
 * provider to elevenlabs and stores the chosen voice ID.
 */
export async function assignElevenLabsVoiceToHost(hostId: string, voiceId: string) {
  try {
    if (!hostId) throw new Error("Host is required.");
    if (!voiceId) throw new Error("Voice is required.");

    const host = await db.aiHost.update({
      where: { id: hostId },
      data: { ttsProvider: "elevenlabs", ttsVoiceId: voiceId },
    });

    revalidatePath("/admin/voices");
    revalidatePath("/admin/personalities");
    return { success: true, hostName: host.name };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to assign voice." };
  }
}
