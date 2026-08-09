// Fish Audio S2.1 Pro / S2-Pro multi-speaker scene adapter.
//
// Production rule: provider success is not performance success. Each scene is
// rendered several times, analyzed while it is still RAW speech, and only the
// strongest passing performance is returned. Flat/metronomic output never
// reaches storage or the final stitcher.

import { getFishApiKey } from "../../env";
import { analyzeSpokenPerformanceBuffer, type SpokenPerformanceQaReport } from "../../audio/spokenPerformanceQa";
import {
  DialogueSceneInput,
  DialogueSceneResult,
  SceneGenerationError,
  categorizeHttpStatus,
  type DialogueSceneType,
  type ScenePerformanceContext,
} from "./sceneTypes";
import { FISH_REFERENCE_ID_RE } from "./providerIds";
import { SCRIPT_TAG_TO_FISH, TONE_TO_FISH_CUE } from "./fishFormat";

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const TAG_PATTERN = /\[([^\[\]]{1,80})\]/g;

const SLOW_QUIET_ANGER_CUES: Record<string, string | null> = {
  heated: "[slow, quiet, cold, precise]",
  excited: "[measured, intense, controlled]",
  incredulous: "[quiet disbelief, unhurried]",
  dismissive: "[flat, slow, finished]",
};

const LOUD_SLOW_ANGER_CUES: Record<string, string | null> = {
  heated: "[loud, slow, stretching words]",
  excited: "[booming, slow, unhurried]",
  incredulous: "[loud disbelief, drawn out]",
  dismissive: "[loud, flat, dragging words]",
};

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
  directionCues: Record<string, string>;
  /** The scene-level shading cue actually emitted into `text`. Persisted so a
   *  future "why did this scene sound flat?" is answerable from the row. */
  sceneCue: string;
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

function lineHeat(u: { tone?: string; energy?: string }): number {
  const energy = u.energy === "high" ? 2 : u.energy === "medium" ? 1 : 0;
  const hotTone = ["heated", "excited", "incredulous", "dismissive"].includes((u.tone || "").toLowerCase()) ? 2 : 0;
  return energy + hotTone;
}

/** Scene shading, compressed for an inline bracket.
 *
 * Fish has NO natural-language `instructions` parameter — the ONLY channel for
 * direction is bracket text inside `text`. The compiled direction's scene
 * shading therefore has to be carried here explicitly or it never reaches the
 * engine at all. It previously did not: the old cue regex stopped at the very
 * words the shading starts with, so every scene of an episode — cold open,
 * peak argument and closing alike — was rendered under one identical cue.
 * That is an episode with no dynamic range by construction. */
const SCENE_CUE: Record<DialogueSceneType, string> = {
  cold_open: "cold open, arriving mid-energy, hooking fast, no throat-clearing",
  conversation: "mid-conversation, reacting to what was just said before adding your own point",
  argument_escalation: "the disagreement is building, intensity climbing across the exchange",
  argument_resolution: "the argument is landing, letting the concession breathe",
  transition: "moving the show to the next block, brief and forward-leaning",
  news_block: "factual block, clarity first",
  host_expert_exchange: "question-and-explanation rhythm, answers unhurried",
  interview_exchange: "interview rhythm, leaving space for the answer",
  documentary_narration: "narrative continuity, momentum across sentences",
  rapid_fire: "rapid fire, instant and clipped, no wind-up",
  closing: "the close, energy settling, landing the goodbye like a real conversation",
};

/** The scene-level cue, emitted once at the head of the scene. */
export function sceneShadingCue(sceneType: DialogueSceneType): string {
  return `[${SCENE_CUE[sceneType] ?? SCENE_CUE.conversation}]`;
}

/** How this speaker sounds under pressure — a structured profile field, not
 *  prose. Scraped from the direction string it was silently dropped; read from
 *  the profile it always survives, and it is what keeps two voices legible as
 *  two different people during a fight. */
function angerSignature(anger: ScenePerformanceContext["angerStyle"]): string | null {
  if (anger === "slower_quieter") return "angry here means slower, quieter, more precise — never louder";
  if (anger === "louder_slower") return "angry here means louder and slower, stretching words out";
  return null;
}

/** Distill the authored delivery style into a compact Fish bracket cue.
 *
 * Built from the delivery style prose PLUS the structured profile fields. The
 * old version took only the first sentence, which made the direction Fish
 * received a lottery on sentence order: a host whose style opens on timbre
 * ("Fast, flat Northwest Indiana vowels, smoker's edge.") reached the engine
 * with no performance instruction whatsoever, while a host whose style opens on
 * manner kept his. That is exactly how one host ends up flatter than the other. */
export function compactFishDeliveryCue(ctx: ScenePerformanceContext): string | null {
  const direction = (ctx.direction || "").replace(/\s+/g, " ").trim();
  if (!direction) return null;
  const match = direction.match(/Delivery style:\s*(.*?)(?=\s+(?:This is|The disagreement|Mid-conversation|Your intensity|When genuinely|Never:)|$)/i);
  let style = (match?.[1] || "").trim();
  if (!style) return null;

  // Take whole sentences up to the budget — not just the first one — so a
  // timbre-first style still carries its manner clauses through.
  const BUDGET = 210;
  const sentences = style.match(/[^.!?]+[.!?]?/g) ?? [style];
  let taken = "";
  for (const sentence of sentences) {
    const next = (taken + sentence).trim();
    if (taken && next.length > BUDGET) break;
    taken = next;
    if (taken.length >= BUDGET) break;
  }
  style = (taken || style).replace(/[.!?]+$/, "").trim();
  if (style.length > BUDGET) {
    const cut = style.slice(0, BUDGET);
    style = cut.slice(0, Math.max(40, cut.lastIndexOf(" "))).trim();
  }

  const anger = angerSignature(ctx.angerStyle);
  const parts = [style, ...(anger ? [anger] : []), "speaking to the other host, reacting in this moment, never reading"];
  return `[${parts.join("; ")}]`;
}

function emotionalCue(
  tone: string,
  anger: "louder_faster" | "slower_quieter" | "louder_slower"
): string | null {
  if (anger === "slower_quieter") return SLOW_QUIET_ANGER_CUES[tone] ?? TONE_TO_FISH_CUE[tone] ?? null;
  if (anger === "louder_slower") return LOUD_SLOW_ANGER_CUES[tone] ?? TONE_TO_FISH_CUE[tone] ?? null;
  return TONE_TO_FISH_CUE[tone] ?? null;
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

  const cueCapByHost = new Map<string, number>();
  const angerStyleByHost = new Map<string, "louder_faster" | "slower_quieter" | "louder_slower">();
  const baselineCueByHost = new Map<string, string>();
  const directionCues: Record<string, string> = {};
  for (const cast of input.cast) {
    // Fish works best with sparse, meaningful bracket direction. Permit a
    // baseline cue plus up to two genuine peak/turn cues per speaker per scene.
    cueCapByHost.set(cast.speakerHostId, Math.max(1, Math.min(3, cast.maxCueDensity + 1)));
    angerStyleByHost.set(cast.speakerHostId, cast.angerStyle ?? "louder_faster");
    const baseline = compactFishDeliveryCue(cast);
    if (baseline) {
      baselineCueByHost.set(cast.speakerHostId, baseline);
      directionCues[cast.speakerHostId] = baseline;
    }
  }

  const cuesUsedByHost = new Map<string, number>();
  const baselineApplied = new Set<string>();
  const parts: string[] = [];
  let previousHostId: string | null = null;
  // Scene shading is a property of the SCENE, not of a speaker, so it is
  // emitted once at the head of the scene and is not charged to any host's cue
  // budget — otherwise it would compete with that host's character cue and the
  // scene would silently lose its shading again.
  const sceneCue = sceneShadingCue(input.sceneType);
  let sceneCueApplied = false;

  // One authored emotional peak per scene. Per-host budgets allowed every hot
  // speaker to receive a cue, which stamped synthetic emotion over the whole
  // exchange. Pick the strongest line; on a tie, the later line wins so the
  // performance can build rather than peak immediately.
  let accentLineIndex: number | null = null;
  let accentHeat = 2;
  for (const utterance of input.utterances) {
    const heat = lineHeat(utterance);
    if (heat >= 3 && heat >= accentHeat) {
      accentHeat = heat;
      accentLineIndex = utterance.lineIndex;
    }
  }

  for (const utterance of input.utterances) {
    const speakerIndex = speakerIndexByHost.get(utterance.speakerHostId)!;
    const cap = cueCapByHost.get(utterance.speakerHostId) ?? 2;
    let used = cuesUsedByHost.get(utterance.speakerHostId) ?? 0;
    const openers: string[] = [];

    if (!sceneCueApplied) {
      openers.push(sceneCue);
      sceneCueApplied = true;
    }

    if (!baselineApplied.has(utterance.speakerHostId) && used < cap) {
      const baseline = baselineCueByHost.get(utterance.speakerHostId);
      if (baseline) {
        openers.push(baseline);
        baselineApplied.add(utterance.speakerHostId);
        used++;
      }
    }

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

    // Use delivery direction at genuine peaks and sharp reactions, not once for
    // the entire scene and not on every sentence.
    if (used < cap && utterance.lineIndex === accentLineIndex) {
      const cue = emotionalCue(
        (utterance.tone || "").toLowerCase(),
        angerStyleByHost.get(utterance.speakerHostId) ?? "louder_faster"
      );
      if (cue) {
        openers.push(cue);
        used++;
      }
    }
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

  const temperatures = input.cast
    .map((cast) => cast.providerOverrides?.temperature)
    .filter((value): value is number => typeof value === "number" && value >= 0 && value <= 1)
    .sort((a, b) => a - b);
  const topPs = input.cast
    .map((cast) => cast.providerOverrides?.topP)
    .filter((value): value is number => typeof value === "number" && value >= 0 && value <= 1)
    .sort((a, b) => a - b);
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
      temperature: temperatures.length ? temperatures[Math.floor(temperatures.length / 2)] : 0.78,
      top_p: topPs.length ? topPs[Math.floor(topPs.length / 2)] : 0.82,
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
    directionCues,
    sceneCue,
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
  const selected = passing[0];
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
      temperature: selected.temperature,
      topP: selected.topP,
      directionCues: payload.directionCues,
      sceneCue: payload.sceneCue,
      speakerRunCount: payload.speakerRunCount,
      approvedUtteranceCount: input.utterances.length,
      cuedTextPreview: payload.body.text.slice(0, 500),
      characterCount: payload.body.text.length,
      requestId: selected.requestId,
    },
  };
}
