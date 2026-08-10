// Scene-level TTS contracts. Scene mode is capability-gated and adapters must
// record the render unit, provider/model and any honest failure category.

export type TtsRenderUnit =
  | "single_line"
  | "speaker_turn_cluster"
  | "multi_speaker_scene"
  | "performance_conversion";

export interface TtsProviderCapabilities {
  providerId: string;
  renderUnits: TtsRenderUnit[];
  maxSpeakers: number;
  recommendedMaxCharacters?: number;
  hardMaxCharacters?: number;
  supportsContinuation: boolean;
  supportsSeed: boolean;
  supportsMultipleCandidates: boolean;
  supportsWordTimestamps: boolean;
  supportsSpeakerTimestamps: boolean;
  supportsInlineDeliveryCues: boolean;
  supportsNaturalLanguageDirection: boolean;
  mixedSpeakerOutput: boolean;
}

export type DialogueSceneType =
  | "cold_open"
  | "conversation"
  | "argument_escalation"
  | "argument_resolution"
  | "transition"
  | "news_block"
  | "host_expert_exchange"
  | "interview_exchange"
  | "documentary_narration"
  | "rapid_fire"
  | "closing";

export interface SceneUtterance {
  lineIndex: number;
  speakerHostId: string;
  speakerName: string;
  seatIndex: number;
  voiceId: string;
  spokenText: string;
  tone?: string;
  energy?: "low" | "medium" | "high";
  isInterruption?: boolean;
  pauseBefore?: "none" | "beat" | "breath" | "long";
  segmentBoundary?: "none" | "segment" | "topic";
}

export interface ScenePerformanceContext {
  speakerHostId: string;
  formatRoleId: string;
  direction: string;
  intensityLevel: number;
  angerStyle?: "louder_faster" | "slower_quieter" | "louder_slower";
  maxCueDensity: number;
  profileVersion: number;
  providerOverrides?: Record<string, number | string | boolean>;
}

export interface DialogueSceneInput {
  episodeId: string;
  scriptId: string;
  sceneId: string;
  sceneIndex: number;
  sceneType: DialogueSceneType;
  formatId: string;
  utterances: SceneUtterance[];
  cast: ScenePerformanceContext[];
  seed?: number;
  continuationRef?: string;
  format?: "mp3" | "wav";
  wantTimestamps?: boolean;
}

export interface SceneUtteranceTiming {
  lineIndex: number;
  sceneId: string;
  startMs: number;
  endMs: number;
  speakerHostId: string;
}

export type SceneTimingStatus =
  | "provider_timestamps"
  | "forced_alignment"
  | "stt_alignment"
  | "timing_unavailable";

export interface SceneTimingMap {
  status: SceneTimingStatus;
  utterances: SceneUtteranceTiming[];
}

export interface DialogueSceneResult {
  audioBuffer: Buffer;
  contentType: string;
  durationMs?: number;
  renderUnit: TtsRenderUnit;
  model: string;
  endpoint: string;
  seed?: number;
  timingMap?: SceneTimingMap;
  providerMetadata?: Record<string, unknown>;
}

export type SceneErrorCategory =
  | "authentication"
  | "insufficient_credit"
  | "unsupported_model"
  | "invalid_voice"
  | "request_too_large"
  | "rate_limited"
  | "provider_unavailable"
  | "empty_audio"
  | "truncated_audio"
  | "alignment_failed"
  | "transcript_mismatch"
  | "quality_gate_failed"
  | "storage_failed"
  /** Cast cannot be performed as a scene (multi-engine, or a non-scene engine).
   *  In production this fails the episode instead of degrading it to line TTS. */
  | "ineligible_cast"
  /** One or more scenes could not be rendered at full quality. Partly-performed
   *  and partly-cold audio is worse than none — nobody can hear the seam. */
  | "incomplete_scene_render"
  | "unknown_provider_failure";

export class SceneGenerationError extends Error {
  readonly category: SceneErrorCategory;

  constructor(category: SceneErrorCategory, message: string) {
    super(message);
    this.name = "SceneGenerationError";
    this.category = category;
  }
}

export function categorizeHttpStatus(status: number): SceneErrorCategory {
  if (status === 401 || status === 403) return "authentication";
  if (status === 402) return "insufficient_credit";
  if (status === 404 || status === 422) return "invalid_voice";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "unknown_provider_failure";
}

export interface DialogueSceneProvider {
  synthesizeDialogueScene(input: DialogueSceneInput): Promise<DialogueSceneResult>;
}

export function isDialogueSceneProvider(provider: unknown): provider is DialogueSceneProvider {
  return !!provider && typeof (provider as DialogueSceneProvider).synthesizeDialogueScene === "function";
}
