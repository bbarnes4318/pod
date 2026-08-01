// ElevenLabs Text to Dialogue scene adapter.
//
// Verified contract (docs/TTS_SCENE_CAPABILITIES.md):
//   POST /v1/text-to-dialogue            → audio bytes
//   POST /v1/text-to-dialogue/with-timestamps → { audio_base64, alignment }
//   body: { inputs: [{ text, voice_id }...], model_id, settings?{stability},
//           seed? } ; query output_format. Max 10 unique voices; keep total
//   text ≤ 2,000 chars for reliable generation.
//
// Deliberate non-features (the endpoint does not support them — never send):
//   previous_text / next_text, SSML, per-turn voice_settings, num_generations.
//
// Tag policy: the APPROVED text's own [tags] pass through (eleven_v3 performs
// them). NOTHING is auto-injected — scene mode relies on the dialogue model's
// own reading of the conversation, not per-line emotional stamps.

import {
  DialogueSceneInput,
  DialogueSceneResult,
  SceneGenerationError,
  SceneTimingMap,
  SceneUtteranceTiming,
  categorizeHttpStatus,
} from "./sceneTypes";
import {
  analyzeSpokenPerformanceBuffer,
  type SpokenPerformanceQaReport,
} from "../../audio/spokenPerformanceQa";

const DIALOGUE_URL = "https://api.elevenlabs.io/v1/text-to-dialogue";

export interface ElevenLabsDialoguePayload {
  url: string;
  body: {
    inputs: Array<{ text: string; voice_id: string }>;
    model_id: string;
    seed?: number;
    settings?: { stability: number };
  };
  modelId: string;
  endpoint: "text-to-dialogue" | "text-to-dialogue/with-timestamps";
}

/** Pure request builder (unit-tested without network). */
export function buildElevenLabsDialoguePayload(
  input: DialogueSceneInput,
  opts: { modelId?: string } = {}
): ElevenLabsDialoguePayload {
  const modelId =
    opts.modelId ||
    process.env.ELEVENLABS_DIALOGUE_MODEL_ID ||
    process.env.ELEVENLABS_MODEL_ID ||
    process.env.ELEVENLABS_MODEL ||
    "eleven_v3";
  if (!modelId.startsWith("eleven_v3")) {
    throw new SceneGenerationError(
      "unsupported_model",
      `ElevenLabs dialogue scenes require an eleven_v3 model (got '${modelId}'). Set ELEVENLABS_DIALOGUE_MODEL_ID.`
    );
  }

  const uniqueVoices = new Set(input.utterances.map((u) => u.voiceId));
  if (uniqueVoices.size === 0) {
    throw new SceneGenerationError("invalid_voice", "Scene has no utterances/voices.");
  }
  if (uniqueVoices.size > 10) {
    throw new SceneGenerationError("request_too_large", `Scene uses ${uniqueVoices.size} voices; ElevenLabs dialogue allows at most 10.`);
  }
  for (const u of input.utterances) {
    if (!u.voiceId || u.voiceId.includes("stub")) {
      throw new SceneGenerationError("invalid_voice", `Line ${u.lineIndex}: missing/stub ElevenLabs voice id.`);
    }
  }

  const inputs = input.utterances.map((u) => ({ text: u.spokenText, voice_id: u.voiceId }));

  const stabilities = input.cast
    .map((c) => c.providerOverrides?.stability)
    .filter((s): s is number => typeof s === "number" && s >= 0 && s <= 1)
    .sort((a, b) => a - b);
  const settings =
    stabilities.length > 0 ? { stability: stabilities[Math.floor(stabilities.length / 2)] } : undefined;

  const endpoint = input.wantTimestamps ? "text-to-dialogue/with-timestamps" : "text-to-dialogue";
  const format = input.format === "wav" ? "pcm_44100" : "mp3_44100_192";
  return {
    url: `${DIALOGUE_URL}${input.wantTimestamps ? "/with-timestamps" : ""}?output_format=${format}`,
    body: {
      inputs,
      model_id: modelId,
      ...(typeof input.seed === "number" ? { seed: input.seed >>> 0 } : {}),
      ...(settings ? { settings } : {}),
    },
    modelId,
    endpoint,
  };
}

export interface AlignmentPayload {
  characters?: string[];
  character_start_times_seconds?: number[];
  character_end_times_seconds?: number[];
}
export interface VoiceSegmentPayload {
  voice_id?: string;
  start_time_seconds?: number;
  end_time_seconds?: number;
  dialogue_input_index?: number;
}

export function timingMapFromVoiceSegments(
  input: DialogueSceneInput,
  segments: VoiceSegmentPayload[] | null | undefined
): SceneTimingMap | null {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const byIndex = new Map<number, VoiceSegmentPayload>();
  for (const segment of segments) {
    const index = Number(segment.dialogue_input_index);
    if (!Number.isInteger(index) || index < 0 || index >= input.utterances.length) continue;
    if (!Number.isFinite(Number(segment.start_time_seconds)) || !Number.isFinite(Number(segment.end_time_seconds))) continue;
    if (Number(segment.end_time_seconds) <= Number(segment.start_time_seconds)) continue;
    byIndex.set(index, segment);
  }
  if (byIndex.size !== input.utterances.length) return null;
  const utterances: SceneUtteranceTiming[] = [];
  for (let index = 0; index < input.utterances.length; index++) {
    const source = input.utterances[index];
    const segment = byIndex.get(index)!;
    if (segment.voice_id && segment.voice_id !== source.voiceId) return null;
    utterances.push({
      lineIndex: source.lineIndex,
      sceneId: input.sceneId,
      startMs: Math.round(Number(segment.start_time_seconds) * 1000),
      endMs: Math.round(Number(segment.end_time_seconds) * 1000),
      speakerHostId: source.speakerHostId,
    });
  }
  return { status: "provider_timestamps", utterances };
}

export function timingMapFromAlignment(
  input: DialogueSceneInput,
  alignment: AlignmentPayload | null | undefined
): SceneTimingMap | null {
  const chars = alignment?.characters;
  const starts = alignment?.character_start_times_seconds;
  const ends = alignment?.character_end_times_seconds;
  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends)) return null;
  if (!chars.length || chars.length !== starts.length || chars.length !== ends.length) return null;
  const utterances: SceneUtteranceTiming[] = [];
  let cursor = 0;
  const skippable = (c: string) => /\s/.test(c);
  for (const u of input.utterances) {
    const target = u.spokenText;
    let ti = 0;
    let startSec: number | null = null;
    let endSec: number | null = null;
    while (ti < target.length && cursor < chars.length) {
      const tc = target[ti], ac = chars[cursor];
      if (tc === ac) {
        if (startSec === null && !skippable(tc)) startSec = starts[cursor];
        if (!skippable(tc)) endSec = ends[cursor];
        ti++; cursor++;
      } else if (skippable(tc)) ti++;
      else cursor++;
    }
    if (ti < target.length * 0.8 || startSec === null || endSec === null) return null;
    utterances.push({
      lineIndex: u.lineIndex, sceneId: input.sceneId,
      startMs: Math.round(startSec * 1000), endMs: Math.round(endSec * 1000),
      speakerHostId: u.speakerHostId,
    });
  }
  return { status: "provider_timestamps", utterances };
}

interface ElevenCandidate {
  index: number;
  audioBuffer: Buffer;
  contentType: string;
  timingMap?: SceneTimingMap;
  seed?: number;
  requestId?: string;
  qa?: SpokenPerformanceQaReport;
}
function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}
function performanceQaEnabled(): boolean {
  if (process.env.ELEVENLABS_PERFORMANCE_QA_ENABLED === "false") return false;
  if (process.env.ELEVENLABS_PERFORMANCE_QA_ENABLED === "true") return true;
  return process.env.NODE_ENV === "production";
}
function strictPerformanceQa(): boolean {
  if (process.env.TTS_PERFORMANCE_QA_STRICT === "false") return false;
  if (process.env.TTS_PERFORMANCE_QA_STRICT === "true") return true;
  return process.env.NODE_ENV === "production";
}
function candidateCount(input: DialogueSceneInput): number {
  if (!performanceQaEnabled()) return 1;
  const fallback = input.sceneType === "cold_open" || input.sceneType === "argument_escalation" ? 3 : 2;
  return envInt("ELEVENLABS_DIALOGUE_CANDIDATES", fallback, 1, 4);
}
function payloadForCandidate(input: DialogueSceneInput, index: number): ElevenLabsDialoguePayload {
  const payload = buildElevenLabsDialoguePayload(input);
  if (typeof payload.body.seed === "number") {
    payload.body.seed = (payload.body.seed + index * 2654435761) >>> 0;
  }
  return payload;
}
async function requestCandidate(
  apiKey: string, input: DialogueSceneInput, index: number, runQa: boolean
): Promise<ElevenCandidate> {
  const payload = payloadForCandidate(input, index);
  const doFetch = () => fetch(payload.url, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload.body),
  });
  let response = await doFetch();
  if (response.status === 429 || response.status >= 500) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    response = await doFetch();
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new SceneGenerationError(
      categorizeHttpStatus(response.status),
      `ElevenLabs dialogue candidate ${index} error ${response.status}: ${text.slice(0, 300)}`
    );
  }
  let audioBuffer: Buffer;
  let timingMap: SceneTimingMap | undefined;
  let contentType = "audio/mpeg";
  if (input.wantTimestamps) {
    const json = await response.json() as {
      audio_base64?: string;
      alignment?: AlignmentPayload;
      normalized_alignment?: AlignmentPayload;
      voice_segments?: VoiceSegmentPayload[];
    };
    if (!json.audio_base64) throw new SceneGenerationError("empty_audio", `ElevenLabs candidate ${index} had no audio.`);
    audioBuffer = Buffer.from(json.audio_base64, "base64");
    timingMap = timingMapFromVoiceSegments(input, json.voice_segments)
      ?? timingMapFromAlignment(input, json.alignment ?? json.normalized_alignment)
      ?? undefined;
  } else {
    audioBuffer = Buffer.from(await response.arrayBuffer());
    contentType = response.headers.get("content-type") || contentType;
  }
  if (!audioBuffer.length) throw new SceneGenerationError("empty_audio", `ElevenLabs candidate ${index} returned empty audio.`);
  const qa = runQa ? await analyzeSpokenPerformanceBuffer(audioBuffer, {
    expectedTurnCount: input.utterances.length,
    sceneType: input.sceneType,
    format: input.format === "wav" ? "wav" : "mp3",
    strict: strictPerformanceQa(),
  }) : undefined;
  return {
    index, audioBuffer, contentType, timingMap, seed: payload.body.seed,
    requestId: response.headers.get("request-id") || undefined, qa,
  };
}

export async function synthesizeElevenLabsDialogueScene(
  input: DialogueSceneInput
): Promise<DialogueSceneResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new SceneGenerationError("authentication", "ELEVENLABS_API_KEY is not configured.");
  const runQa = performanceQaEnabled();
  const requested = candidateCount(input);
  const candidates: ElevenCandidate[] = [];
  const errors: string[] = [];
  for (let index = 0; index < requested; index++) {
    try {
      const candidate = await requestCandidate(apiKey, input, index, runQa);
      candidates.push(candidate);
      if (candidate.qa) {
        console.log(`[ElevenPerformance] scene=${input.sceneIndex} candidate=${index} score=${candidate.qa.score}/100 pass=${candidate.qa.passed}`);
      }
    } catch (error) {
      errors.push(`candidate ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const selected = runQa
    ? candidates.filter((c) => c.qa?.passed).sort((a, b) => (b.qa?.score ?? 0) - (a.qa?.score ?? 0))[0]
    : candidates[0];
  if (!selected) {
    const reports = candidates.map((c) =>
      `candidate ${c.index} ${c.qa?.score ?? 0}/100: ${c.qa?.failures?.join("; ") || "failed performance floor"}`
    );
    throw new SceneGenerationError(
      runQa ? "quality_gate_failed" : "provider_unavailable",
      `ElevenLabs produced no publishable performance for scene ${input.sceneIndex}. ${[...reports, ...errors].join(" | ").slice(0, 1200)}`
    );
  }
  const payload = buildElevenLabsDialoguePayload(input);
  return {
    audioBuffer: selected.audioBuffer,
    contentType: selected.contentType,
    renderUnit: "multi_speaker_scene",
    model: payload.modelId,
    endpoint: `${payload.endpoint}; best of ${requested}`,
    seed: selected.seed,
    timingMap: selected.timingMap,
    providerMetadata: {
      requestId: selected.requestId,
      voiceOrder: [...new Set(input.utterances.map((u) => u.voiceId))],
      characterCount: input.utterances.reduce((sum, u) => sum + u.spokenText.length, 0),
      selectedCandidate: selected.index,
      candidatesRequested: requested,
      candidatesCompleted: candidates.length,
      candidateScores: candidates.map((c) => ({
        index: c.index, seed: c.seed, score: c.qa?.score, passed: c.qa?.passed,
        failures: c.qa?.failures, warnings: c.qa?.warnings, metrics: c.qa?.metrics,
      })),
      selectedPerformanceQa: selected.qa,
      timingSource: selected.timingMap ? "provider_voice_segments_or_alignment" : "unavailable",
    },
  };
}
