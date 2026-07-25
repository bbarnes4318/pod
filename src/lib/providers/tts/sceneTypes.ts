// Scene-level TTS contract (additive to the line-level TTSProvider contract).
//
// The line contract (`synthesizeSpeech`) survives untouched for legacy mode
// and for engines that genuinely cannot render a conversation. Scene mode is
// a SEPARATE, capability-gated method: the shared service builds ONE common
// DialogueSceneInput and each adapter compiles it into its own verified API
// request (docs/TTS_SCENE_CAPABILITIES.md is the authority on what each
// engine verifiably supports — adapters must never exceed it).
//
// Client-safe: types only, no Node imports.

/** What one TTS request renders. */
export type TtsRenderUnit =
  | "single_line"          // one script line per request (legacy)
  | "speaker_turn_cluster" // several consecutive same-speaker lines per request
  | "multi_speaker_scene"  // a whole multi-voice conversation per request
  | "performance_conversion"; // human performance + voice conversion (premium path; no adapter yet)

/** Verified, static description of what an engine can do (see capabilities.ts). */
export interface TtsProviderCapabilities {
  providerId: string;
  renderUnits: TtsRenderUnit[];
  /** Max distinct voices in one request (scene engines only; 1 otherwise). */
  maxSpeakers: number;
  /** Documented reliable request budget (characters across all turn texts). */
  recommendedMaxCharacters?: number;
  /** Documented hard cap, when one exists. */
  hardMaxCharacters?: number;
  /** Cross-request prosody continuation (previous/next text, context ids). */
  supportsContinuation: boolean;
  supportsSeed: boolean;
  /** Provider-side n-candidates in one request (none of ours have this). */
  supportsMultipleCandidates: boolean;
  /** Word/character-level timestamps on scene output. */
  supportsWordTimestamps: boolean;
  /** Speaker labels on output timestamps. */
  supportsSpeakerTimestamps: boolean;
  /** Inline delivery cues in the text ([laughs], (whispering), ...). */
  supportsInlineDeliveryCues: boolean;
  /** A dedicated natural-language direction/instructions parameter. */
  supportsNaturalLanguageDirection: boolean;
  /** Scene output is ONE mixed track (never per-speaker stems). When true the
   *  assembler must NOT pan hosts inside the scene. */
  mixedSpeakerOutput: boolean;
}

/** Scene types the planner can emit (deterministic; see dialogueScenePlanner). */
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

/** One ordered utterance inside a scene. `spokenText` is the APPROVED text —
 *  adapters may derive provider control text from it but must never persist
 *  or return control syntax as listener-visible text. */
export interface SceneUtterance {
  lineIndex: number;
  speakerHostId: string;
  speakerName: string;
  /** Seat order in the cast (0-3). Stable within the episode. */
  seatIndex: number;
  /** Provider-specific voice id resolved for this speaker (validated upstream). */
  voiceId: string;
  /** Approved spoken words (sanitized of markdown, never rewritten). */
  spokenText: string;
  tone?: string;
  energy?: "low" | "medium" | "high";
  isInterruption?: boolean;
  pauseBefore?: "none" | "beat" | "breath" | "long";
  /** Script segment boundary entering this line ("none" inside a beat). */
  segmentBoundary?: "none" | "segment" | "topic";
}

/** Per-speaker performance context, compiled from format role + host profile.
 *  Secret-free; adapters translate it into whatever their API accepts. */
export interface ScenePerformanceContext {
  speakerHostId: string;
  /** ShowFormatRole.id for this chair (e.g. "news_anchor", "moderator"). */
  formatRoleId: string;
  /** Compiled natural-language direction (only sent to engines whose
   *  capabilities declare supportsNaturalLanguageDirection). */
  direction: string;
  /** 1-10 character intensity CEILING (range, not a per-line volume command). */
  intensityLevel: number;
  /** Max inline delivery cues per utterance the adapter may emit. */
  maxCueDensity: number;
  /** Versioned performance profile snapshot (validated; may be defaults). */
  profileVersion: number;
  /** Provider-specific knobs from the host performance profile (validated
   *  upstream against the profile schema; e.g. elevenlabs stability). */
  providerOverrides?: Record<string, number | string | boolean>;
}

export interface DialogueSceneInput {
  episodeId: string;
  scriptId: string;
  /** Stable scene id: `${scriptId}:${sceneIndex}:${plannerVersion}`. */
  sceneId: string;
  sceneIndex: number;
  sceneType: DialogueSceneType;
  /** Registered show format that built the episode. */
  formatId: string;
  /** Ordered turns (speaking order preserved exactly). */
  utterances: SceneUtterance[];
  /** Performance context per distinct speaker in this scene. */
  cast: ScenePerformanceContext[];
  /** Stable seed for engines that support it (ignored otherwise). */
  seed?: number;
  /** Continuation handle — ONLY set when the target provider officially
   *  supports cross-request continuation (none of the current scene engines
   *  do; reserved for future adapters). */
  continuationRef?: string;
  format?: "mp3" | "wav";
  /** When true and supported, request provider timestamps for the timing map. */
  wantTimestamps?: boolean;
}

/** Utterance timing relative to the scene audio (never fabricated). */
export interface SceneUtteranceTiming {
  lineIndex: number;
  sceneId: string;
  startMs: number;
  endMs: number;
  speakerHostId: string;
}

export type SceneTimingStatus =
  | "provider_timestamps" // from an officially supported timestamps response
  | "forced_alignment"    // from a configured alignment service (none wired yet)
  | "stt_alignment"       // from a configured STT+diarization service (none wired yet)
  | "timing_unavailable"; // honest absence — consumers must not invent timing

export interface SceneTimingMap {
  status: SceneTimingStatus;
  utterances: SceneUtteranceTiming[];
}

export interface DialogueSceneResult {
  audioBuffer: Buffer;
  contentType: string;
  durationMs?: number;
  /** The render unit the adapter ACTUALLY used. */
  renderUnit: TtsRenderUnit;
  /** Exact model + endpoint mode used (audit trail). */
  model: string;
  endpoint: string;
  /** Seed actually sent (when supported). */
  seed?: number;
  /** Timing map when the provider returned timestamps; else undefined and the
   *  caller records `timing_unavailable`. */
  timingMap?: SceneTimingMap;
  /** Secret-free provider metadata (voice map echo, request ids, cue text). */
  providerMetadata?: Record<string, unknown>;
}

/** Safe error taxonomy for scene generation (never raw provider bodies). */
export type SceneErrorCategory =
  | "authentication"
  | "unsupported_model"
  | "invalid_voice"
  | "request_too_large"
  | "rate_limited"
  | "provider_unavailable"
  | "empty_audio"
  | "truncated_audio"
  | "alignment_failed"
  | "transcript_mismatch"
  | "storage_failed"
  | "unknown_provider_failure";

export class SceneGenerationError extends Error {
  readonly category: SceneErrorCategory;
  constructor(category: SceneErrorCategory, message: string) {
    super(message);
    this.name = "SceneGenerationError";
    this.category = category;
  }
}

/** Classify an HTTP status into the safe taxonomy. */
export function categorizeHttpStatus(status: number): SceneErrorCategory {
  if (status === 401 || status === 403) return "authentication";
  if (status === 404 || status === 422) return "invalid_voice";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "unknown_provider_failure";
}

/** Optional scene-rendering extension of the base TTSProvider. */
export interface DialogueSceneProvider {
  synthesizeDialogueScene(input: DialogueSceneInput): Promise<DialogueSceneResult>;
}

export function isDialogueSceneProvider(p: unknown): p is DialogueSceneProvider {
  return !!p && typeof (p as DialogueSceneProvider).synthesizeDialogueScene === "function";
}
