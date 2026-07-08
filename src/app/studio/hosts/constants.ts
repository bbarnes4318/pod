// Plain (non-"use server") module: shared constants + types for the Character
// Studio. A "use server" file may only export async functions, so these live
// here and are imported by both the actions and the client component.

import { TTS_PROVIDER_IDS } from "@/lib/providers/tts/providerIds";

/** Documented provenance is a clear choice, not free text for the source axis. */
export const VOICE_SOURCES = ["owned", "licensed", "synthetic-stock"] as const;
export type VoiceSourceValue = (typeof VOICE_SOURCES)[number];

/** Engines offered in the voice-assignment picker (includes the stub placeholder). */
export const STUDIO_TTS_PROVIDERS = TTS_PROVIDER_IDS;

export interface StudioHostInput {
  name: string;
  role: string;
  worldview: string;
  speakingStyle: string;
  catchphrasesRaw: string;
  boundariesRaw: string; // maps to AiHost.bannedPhrases (things the host won't say)
  intensityLevel: number;
  ttsProvider: string;
  ttsVoiceId: string;
  voiceSource: string; // "" | owned | licensed | synthetic-stock
  voiceProvenanceNote: string;
}
