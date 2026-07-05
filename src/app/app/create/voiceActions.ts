"use server";

// Voice-engine selection for the user surface. The TTS pipeline already
// resolves the provider per host (host.ttsProvider || TTS_PROVIDER env), so
// picking an engine here just updates both active hosts — no schema changes.

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

export const VOICE_ENGINES = ["default", "elevenlabs", "boson", "fish"] as const;
export type VoiceEngine = (typeof VOICE_ENGINES)[number];

export async function setVoiceEngine(engine: string): Promise<{ ok: boolean; message: string }> {
  if (!VOICE_ENGINES.includes(engine as VoiceEngine)) {
    return { ok: false, message: `Unknown voice engine: ${engine}` };
  }
  try {
    // ttsProvider is non-nullable; empty string falls through to the
    // TTS_PROVIDER env default in the segment service's resolution chain.
    await db.aiHost.updateMany({
      where: { isActive: true },
      data: { ttsProvider: engine === "default" ? "" : engine },
    });
    revalidatePath("/app/create");
    return { ok: true, message: engine === "default" ? "Using the system default voice engine." : `Voice engine set to ${engine}.` };
  } catch (err) {
    return { ok: false, message: (err as Error).message?.slice(0, 200) || "Failed to update voice engine." };
  }
}
