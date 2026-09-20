// Fish Audio S2.1 Pro / S2-Pro multi-speaker scene adapter.
//
// Production rule: provider success is not performance success. Each scene is
// rendered several times, analyzed while it is still RAW speech, and only the
// strongest passing performance is returned. Flat/metronomic output never
// reaches storage or the final stitcher.
//
// Direction is NOT prose. This adapter used to open every scene with a scene
// cue plus a ~210-char per-host delivery paragraph inside brackets ("Play her
// low and certain, at the speed of someone reading a number off a page...").
// An A/B on the same lines/voices/sampling (2026-09-20) had the operator pick
// the bare version as "way more human"; Fish's own docs say bracket cues must
// stay short or the read goes unnatural. The only brackets that reach the
// engine now are the script's own sparse [tags] and [cutting in].

import { getFishApiKey } from "../../env";
import { analyzeSpokenPerformanceBuffer, isBrokenPerformance, type SpokenPerformanceQaReport } from "../../audio/spokenPerformanceQa";
import {
  DialogueSceneInput,
  DialogueSceneResult,
  SceneGenerationError,
  categorizeHttpStatus,
} from "./sceneTypes";
import { FISH_REFERENCE_ID_RE } from "./providerIds";
import { SCRIPT_TAG_TO_FISH } from "./fishFormat";

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const TAG_PATTERN = /\[([^\[\]]{1,80})\]/g;

interface FishProsody {
  speed: number;
  volume: number;
  normalize_loudness: boolean;
}

export interface FishScenePayload {
  url: string;
  model: string;
  body: {
    text: string;
    reference_id: string[];
    format: "mp3" | "wav";
    sample_rate: number;
    mp3_bitrate?: 64 | 128 | 192;
    temperature: number;
    top_p: number;
    prosody: FishProsody;
    chunk_length: number;
    normalize: boolean;
    latency: "normal";
    max_new_tokens: number;
    repetition_penalty: number;
    min_chunk_length: number;
    condition_on_previous_chunks: boolean;
    early_stop_threshold: number;
  };
  voiceOrder: string[];
  /** Per-host sampling settings that were authored and NOT applied, recorded so
   *  the discard is inspectable instead of invisible. Empty when none exist. */
  ignoredPerHostOverrides: Record<string, { temperature?: number; topP?: number }>;
  speakerRunCount: number;
}

interface CandidateResult {
  index: number;
  audioBuffer: Buffer;
  contentType: string;
  qa: SpokenPerformanceQaReport;
  temperature: number;
  topP: number;
  requestId?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function productionStrict(): boolean {
  if (process.env.TTS_PERFORMANCE_QA_STRICT === "false") return false;
  if (process.env.TTS_PERFORMANCE_QA_STRICT === "true") return true;
  return process.env.NODE_ENV === "production";
}

export function resolveFishSceneModel(): string {
  // Quality behavior (direction cues, multi-take auditions, acoustic and
  // semantic QA) is model-independent. Keep Fish's free development model as
  // the cost-safe default while allowing an explicit production promotion.
  const tier = (process.env.FISH_SCENE_MODEL_TIER || "free").trim().toLowerCase();
  const tierDefault = tier === "pro" ? "s2.1-pro" : "s2.1-pro-free";
  const model = (process.env.FISH_SCENE_MODEL || process.env.FISH_MODEL || tierDefault).trim();
  if (!/^s2(?:[.-]|$)/i.test(model)) {
    throw new SceneGenerationError(
      "unsupported_model",
      `Fish multi-speaker publishing requires an S2-family model; got '${model}'.`
    );
  }
  return model;
}

function performanceCandidateCount(input: DialogueSceneInput): number {
  const fallback = input.sceneType === "cold_open" || input.sceneType === "argument_escalation" ? 3 : 2;
  return envInt("FISH_PERFORMANCE_CANDIDATES", fallback, 1, 4);
}

/** Pure request builder. Candidate sampling overrides are applied later. */
export function buildFishScenePayload(input: DialogueSceneInput): FishScenePayload {
  const model = resolveFishSceneModel();
  const voiceOrder: string[] = [];
  const speakerIndexByHost = new Map<string, number>();
  for (const utterance of input.utterances) {
    if (speakerIndexByHost.has(utterance.speakerHostId)) continue;
    if (!FISH_REFERENCE_ID_RE.test(utterance.voiceId)) {
      throw new SceneGenerationError(
        "invalid_voice",
        `Line ${utterance.lineIndex}: '${utterance.voiceId || "(empty)"}' is not a valid 32-hex Fish reference id.`
      );
    }
    speakerIndexByHost.set(utterance.speakerHostId, voiceOrder.length);
    voiceOrder.push(utterance.voiceId);
  }

  // Sparse script [tags] only: up to two per speaker per scene, in place.
  const cueCapByHost = new Map<string, number>();
  for (const cast of input.cast) {
    cueCapByHost.set(cast.speakerHostId, Math.max(1, Math.min(2, cast.maxCueDensity)));
  }

  const cuesUsedByHost = new Map<string, number>();
  const parts: string[] = [];
  let previousHostId: string | null = null;

  for (const utterance of input.utterances) {
    const speakerIndex = speakerIndexByHost.get(utterance.speakerHostId)!;
    const cap = cueCapByHost.get(utterance.speakerHostId) ?? 2;
    let used = cuesUsedByHost.get(utterance.speakerHostId) ?? 0;
    const openers: string[] = [];

    if (utterance.isInterruption && used < cap) {
      openers.push("[cutting in]");
      used++;
    }

    const text = utterance.spokenText.replace(TAG_PATTERN, (_match, inner: string) => {
      const mapped = SCRIPT_TAG_TO_FISH[inner.trim().toLowerCase()];
      if (mapped === undefined || mapped === null || used >= cap) return " ";
      used++;
      return ` ${mapped} `;
    });

    cuesUsedByHost.set(utterance.speakerHostId, used);

    const body = text.replace(/\s+/g, " ").trim();
    const rendered = `${openers.length ? `${openers.join(" ")} ` : ""}${body}`;
    const continuesSameRun =
      previousHostId === utterance.speakerHostId &&
      utterance.segmentBoundary !== "segment" &&
      utterance.segmentBoundary !== "topic" &&
      !utterance.isInterruption;

    if (continuesSameRun && parts.length > 0) parts[parts.length - 1] += ` ${rendered}`;
    else parts.push(`<|speaker:${speakerIndex}|>${rendered}`);
    previousHostId = utterance.speakerHostId;
  }

  // SAMPLING IS CAST-WIDE, BY CONSTRUCTION.
  //
  // A scene is ONE request containing every speaker, and Fish's /v1/tts takes a
  // single temperature and top_p for that request. There is no per-utterance
  // sampling control, so a per-host setting cannot be honoured — not "is not
  // yet", cannot.
  //
  // This used to take the MEDIAN across the cast, which with two hosts is
  // `Math.floor(2/2) = 1` — the HIGHER value. Vandergrift's deliberately tighter
  // 0.75/0.85 was discarded and the whole scene rendered at Fettig's 0.95/0.92,
  // silently. One intentional documented value is honest where a derived blend
  // is not: a mean would render both characters at a setting neither was
  // authored for while keeping two per-host inputs alive that do not apply
  // per host.
  const temperature = clamp(Number(process.env.FISH_SCENE_TEMPERATURE) || 0.78, 0.55, 0.98);
  const topP = clamp(Number(process.env.FISH_SCENE_TOP_P) || 0.82, 0.6, 0.98);
  // Kept only so the discarded intent is visible in providerMetadata rather
  // than vanishing. Nothing reads these to build the request.
  const requestedByHost: Record<string, { temperature?: number; topP?: number }> = {};
  for (const cast of input.cast) {
    const t = cast.providerOverrides?.temperature;
    const p = cast.providerOverrides?.topP;
    if (typeof t === "number" || typeof p === "number") {
      requestedByHost[cast.speakerHostId] = {
        ...(typeof t === "number" ? { temperature: t } : {}),
        ...(typeof p === "number" ? { topP: p } : {}),
      };
    }
  }
  if (Object.keys(requestedByHost).length > 0) {
    console.warn(
      `[FishScene] scene=${input.sceneIndex}: per-host sampling overrides are NOT applied — Fish renders a scene in ` +
        `one request, so temperature/top_p are cast-wide. Using ${temperature}/${topP}. ` +
        `Ignored: ${JSON.stringify(requestedByHost)}`
    );
  }
  const format = input.format === "wav" ? "wav" : "mp3";

  return {
    url: FISH_TTS_URL,
    model,
    body: {
      text: parts.join(""),
      reference_id: voiceOrder,
      format,
      sample_rate: 44100,
      ...(format === "mp3" ? { mp3_bitrate: 192 as const } : {}),
      temperature,
      top_p: topP,
      prosody: { speed: 1, volume: 0, normalize_loudness: true },
      chunk_length: envInt("FISH_SCENE_CHUNK_LENGTH", 300, 100, 300),
      normalize: true,
      latency: "normal",
      max_new_tokens: envInt("FISH_SCENE_MAX_NEW_TOKENS", 4096, 1024, 8192),
      repetition_penalty: clamp(Number(process.env.FISH_SCENE_REPETITION_PENALTY) || 1.15, 1, 2),
      min_chunk_length: envInt("FISH_SCENE_MIN_CHUNK_LENGTH", 80, 50, 300),
      condition_on_previous_chunks: true,
      early_stop_threshold: 1,
    },
    voiceOrder,
    ignoredPerHostOverrides: requestedByHost,
    speakerRunCount: parts.length,
  };
}

async function requestCandidate(
  apiKey: string,
  payload: FishScenePayload,
  candidateIndex: number,
  input: DialogueSceneInput
): Promise<CandidateResult> {
  const temperatureOffsets = [-0.04, 0.08, 0.16, -0.10];
  const topPOffsets = [0, 0.06, -0.04, 0.10];
  const temperature = clamp(payload.body.temperature + (temperatureOffsets[candidateIndex] ?? 0), 0.55, 0.98);
  const topP = clamp(payload.body.top_p + (topPOffsets[candidateIndex] ?? 0), 0.60, 0.98);
  const body = { ...payload.body, temperature, top_p: topP };
  const timeoutMs = envInt("FISH_TTS_TIMEOUT_MS", 180000, 30000, 300000);

  const doFetch = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(payload.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          model: payload.model,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let response: Response;
  try {
    response = await doFetch();
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      await new Promise((resolve) => setTimeout(resolve, retryAfter > 0 ? retryAfter * 1000 : 3000));
      response = await doFetch();
    }
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      throw new SceneGenerationError("provider_unavailable", `Fish candidate ${candidateIndex} timed out after ${timeoutMs}ms.`);
    }
    throw new SceneGenerationError("provider_unavailable", `Fish candidate ${candidateIndex} failed: ${(error as Error).message}`);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new SceneGenerationError(
      categorizeHttpStatus(response.status),
      `Fish Audio candidate ${candidateIndex} error ${response.status}: ${errorText.slice(0, 300)}`
    );
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  if (audioBuffer.length === 0) throw new SceneGenerationError("empty_audio", `Fish candidate ${candidateIndex} returned empty audio.`);

  const qa = await analyzeSpokenPerformanceBuffer(audioBuffer, {
    expectedTurnCount: payload.speakerRunCount,
    sceneType: input.sceneType,
    format: payload.body.format,
    strict: productionStrict(),
  });

  return {
    index: candidateIndex,
    audioBuffer,
    contentType: response.headers.get("content-type") || `audio/${payload.body.format}`,
    qa,
    temperature,
    topP,
    requestId: response.headers.get("request-id") || undefined,
  };
}

/** Generate, audition and select a real performance—not merely valid bytes. */
export async function synthesizeFishDialogueScene(input: DialogueSceneInput): Promise<DialogueSceneResult> {
  const apiKey = getFishApiKey();
  if (!apiKey) throw new SceneGenerationError("authentication", "FISH_API_KEY is not configured.");
  const payload = buildFishScenePayload(input);
  const candidateCount = performanceCandidateCount(input);
  const candidates: CandidateResult[] = [];
  const errors: string[] = [];

  for (let index = 0; index < candidateCount; index++) {
    try {
      const candidate = await requestCandidate(apiKey, payload, index, input);
      candidates.push(candidate);
      console.log(
        `[FishPerformance] scene=${input.sceneIndex} candidate=${index} score=${candidate.qa.score}/100 ` +
        `pass=${candidate.qa.passed} LRA=${candidate.qa.metrics.loudnessRangeLu ?? "n/a"} ` +
        `pauseσ=${candidate.qa.metrics.pauseStdDevSec ?? "n/a"}`
      );
    } catch (error) {
      errors.push(`candidate ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const passing = candidates.filter((candidate) => candidate.qa.passed).sort((a, b) => b.qa.score - a.qa.score);
  let selected = passing[0];
  let selectedBelowFloor = false;
  if (!selected) {
    // Nothing passed. If the best take is merely BLAND - under the loudness
    // range or pacing floors, or the score floor those drive - it ships with
    // a flag rather than killing the scene and the episode with it. Only a
    // BROKEN take (clipping, dead gap, rushed render) is refused outright.
    // See HARD_PERFORMANCE_FAILURE for the line and the episode behind it.
    const bland = candidates
      .filter((candidate) => !isBrokenPerformance(candidate.qa))
      .sort((a, b) => b.qa.score - a.qa.score);
    if (bland[0]) {
      selected = bland[0];
      selectedBelowFloor = true;
      console.warn(
        `[SceneTTS] Scene ${input.sceneIndex}: no take passed the publishing floor; shipping the best bland one ` +
        `(candidate ${selected.index}, ${selected.qa.score}/100: ${selected.qa.failures.join("; ")}) flagged for review.`
      );
    }
  }
  if (!selected) {
    const reports = candidates.map((candidate) =>
      `candidate ${candidate.index} ${candidate.qa.score}/100: ${candidate.qa.failures.join("; ") || "failed score floor"}`
    );
    throw new SceneGenerationError(
      "quality_gate_failed",
      `Fish produced no publishable performance for scene ${input.sceneIndex}. ` +
      [...reports, ...errors].join(" | ").slice(0, 1200)
    );
  }

  return {
    audioBuffer: selected.audioBuffer,
    contentType: selected.contentType,
    renderUnit: "multi_speaker_scene",
    model: payload.model,
    endpoint: `v1/tts multi-speaker; best of ${candidateCount}`,
    providerMetadata: {
      voiceOrder: payload.voiceOrder,
      selectedCandidate: selected.index,
      candidatesRequested: candidateCount,
      candidatesCompleted: candidates.length,
      candidateScores: candidates.map((candidate) => ({
        index: candidate.index,
        score: candidate.qa.score,
        passed: candidate.qa.passed,
        failures: candidate.qa.failures,
        warnings: candidate.qa.warnings,
        metrics: candidate.qa.metrics,
        temperature: candidate.temperature,
        topP: candidate.topP,
      })),
      selectedPerformanceQa: selected.qa,
      /** True when no take passed and the best BLAND one shipped, flagged. */
      selectedBelowFloor,
      temperature: selected.temperature,
      topP: selected.topP,
      samplingScope: "cast_wide",
      ignoredPerHostOverrides: payload.ignoredPerHostOverrides,
      speakerRunCount: payload.speakerRunCount,
      approvedUtteranceCount: input.utterances.length,
      cuedTextPreview: payload.body.text.slice(0, 500),
      characterCount: payload.body.text.length,
      requestId: selected.requestId,
    },
  };
}
