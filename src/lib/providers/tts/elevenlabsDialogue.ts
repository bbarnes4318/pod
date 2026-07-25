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
    // Text to Dialogue is a v3 capability; refuse to guess about other models.
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

  // Approved text only. Existing [tags] pass through for v3; nothing injected.
  const inputs = input.utterances.map((u) => ({ text: u.spokenText, voice_id: u.voiceId }));

  // Optional stability from the host performance profile — ONE scene-level
  // value (the endpoint has a single settings object, not per-turn settings).
  // We take the median of the cast's configured stabilities when any exist.
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

interface AlignmentPayload {
  characters?: string[];
  character_start_times_seconds?: number[];
  character_end_times_seconds?: number[];
}

/**
 * Map the dialogue alignment (characters of the WHOLE scene in order) back to
 * per-utterance spans. Deterministic sequential matcher: we sent the turns,
 * so their concatenation must appear in order in the alignment stream. Fails
 * to null (→ timing_unavailable) rather than fabricating timing.
 */
export function timingMapFromAlignment(
  input: DialogueSceneInput,
  alignment: AlignmentPayload | null | undefined
): SceneTimingMap | null {
  const chars = alignment?.characters;
  const starts = alignment?.character_start_times_seconds;
  const ends = alignment?.character_end_times_seconds;
  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends)) return null;
  if (chars.length === 0 || chars.length !== starts.length || chars.length !== ends.length) return null;

  const utterances: SceneUtteranceTiming[] = [];
  let cursor = 0;
  const isSkippable = (c: string) => /\s/.test(c);
  for (const u of input.utterances) {
    const target = u.spokenText;
    let ti = 0;
    let startSec: number | null = null;
    let endSec: number | null = null;
    while (ti < target.length && cursor < chars.length) {
      const tc = target[ti];
      const ac = chars[cursor];
      if (tc === ac) {
        if (startSec === null && !isSkippable(tc)) startSec = starts[cursor];
        if (!isSkippable(tc)) endSec = ends[cursor];
        ti++;
        cursor++;
      } else if (isSkippable(tc)) {
        ti++; // our whitespace the engine collapsed
      } else if (isSkippable(ac)) {
        cursor++; // engine-inserted spacing
      } else {
        // Real divergence (normalization) — advance the alignment stream; if
        // we drift too far the whole map is abandoned below.
        cursor++;
      }
    }
    if (ti < target.length * 0.8 || startSec === null || endSec === null) {
      return null; // could not confidently place this utterance — no fake timing
    }
    utterances.push({
      lineIndex: u.lineIndex,
      sceneId: input.sceneId,
      startMs: Math.round(startSec * 1000),
      endMs: Math.round(endSec * 1000),
      speakerHostId: u.speakerHostId,
    });
  }
  return { status: "provider_timestamps", utterances };
}

/** Execute the scene request. Retries once on 429/5xx. */
export async function synthesizeElevenLabsDialogueScene(
  input: DialogueSceneInput
): Promise<DialogueSceneResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new SceneGenerationError("authentication", "ELEVENLABS_API_KEY is not configured.");

  const payload = buildElevenLabsDialoguePayload(input);

  const doFetch = () =>
    fetch(payload.url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload.body),
    });

  let response = await doFetch();
  if (response.status === 429 || response.status >= 500) {
    await new Promise((r) => setTimeout(r, 2000));
    response = await doFetch();
  }
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new SceneGenerationError(
      categorizeHttpStatus(response.status),
      `ElevenLabs dialogue API error ${response.status}: ${errText.slice(0, 300)}`
    );
  }

  let audioBuffer: Buffer;
  let timingMap: SceneTimingMap | undefined;
  let contentType = "audio/mpeg";
  if (input.wantTimestamps) {
    const json = (await response.json()) as { audio_base64?: string; alignment?: AlignmentPayload; normalized_alignment?: AlignmentPayload };
    if (!json.audio_base64) throw new SceneGenerationError("empty_audio", "ElevenLabs dialogue timestamps response had no audio.");
    audioBuffer = Buffer.from(json.audio_base64, "base64");
    timingMap = timingMapFromAlignment(input, json.alignment ?? json.normalized_alignment) ?? undefined;
  } else {
    audioBuffer = Buffer.from(await response.arrayBuffer());
    contentType = response.headers.get("content-type") || contentType;
  }
  if (audioBuffer.length === 0) {
    throw new SceneGenerationError("empty_audio", "ElevenLabs dialogue API returned empty audio.");
  }

  return {
    audioBuffer,
    contentType,
    renderUnit: "multi_speaker_scene",
    model: payload.modelId,
    endpoint: payload.endpoint,
    seed: payload.body.seed,
    timingMap,
    providerMetadata: {
      requestId: response.headers.get("request-id") || undefined,
      voiceOrder: [...new Set(input.utterances.map((u) => u.voiceId))],
      characterCount: input.utterances.reduce((a, u) => a + u.spokenText.length, 0),
    },
  };
}
