// Plain (non-"use server") module: shared constants + types for Host Studio.
// A "use server" file may only export async functions, so these live here and
// are imported by both the actions and the client component.

import type { HostStudioSettings } from "@/lib/hosts/hostStudioProfile";

/** Documented provenance is a clear choice, not free text for the source axis. */
export const VOICE_SOURCES = ["owned", "licensed", "synthetic-stock"] as const;
export type VoiceSourceValue = (typeof VOICE_SOURCES)[number];

export const PLACEHOLDER_USER_VOICE = "PLACEHOLDER_USER_VOICE";

/**
 * New UI path: settings are the simple controls and the server compiles them
 * into role/worldview/speakingStyle/performanceProfile. Legacy optional fields
 * remain for old callers and safe rollback; the new screen never exposes them.
 */
export interface StudioHostInput {
  name: string;
  settings?: HostStudioSettings;
  role?: string;
  worldview?: string;
  speakingStyle?: string;
  catchphrasesRaw?: string;
  boundariesRaw?: string;
  argumentPatternsRaw?: string;
  prohibitedTraitsRaw?: string;
  intensityLevel?: number;
  ttsProvider: string;
  ttsVoiceId: string;
  voiceSource: string; // "" | owned | licensed | synthetic-stock
  voiceProvenanceNote: string;
}

export type VoiceSetupMode = "design" | "clone" | "existing" | "later";
export type PreviewScenario = "hello" | "disagree" | "pressure";
