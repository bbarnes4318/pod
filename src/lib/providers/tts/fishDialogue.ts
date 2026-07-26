// Fish Audio S2-Pro multi-speaker scene adapter.
//
// Verified contract (docs/TTS_SCENE_CAPABILITIES.md — multi-speaker shape
// verified through the indexed OFFICIAL docs; validated hard at runtime):
//   POST https://api.fish.audio/v1/tts, `model` header (scene default:
//   `s2-pro`, the SDK-canonical production id; override FISH_SCENE_MODEL).
//   text  = whole dialogue with `<|speaker:N|>` tags marking each turn
//   reference_id = ARRAY of 32-hex voice model ids; position == speaker index
//
// Cue policy (anti-mechanical, by design):
//   - The approved text's own [tags] convert in place (same table as line mode).
//   - NO per-line tone openers. At most ONE scene-level accent cue is placed,
//     on the single hottest line of the scene, and only when the scene carries
//     a real emotional peak. Interruptions keep their [cutting in] marker
//     because turn-taking depends on it.
//   - Per-utterance cue cap = the speaker's profile maxCueDensity.

import { getFishApiKey } from "../../env";
import {
  DialogueSceneInput,
  DialogueSceneResult,
  SceneGenerationError,
  categorizeHttpStatus,
} from "./sceneTypes";
import { FISH_REFERENCE_ID_RE } from "./providerIds";
import { SCRIPT_TAG_TO_FISH, TONE_TO_FISH_CUE } from "./fishFormat";

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const TAG_PATTERN = /\[([^\[\]]{1,40})\]/g;

/** Heated cues for a host whose anger goes DOWN (slower, quieter, precise)
 *  instead of up. Same hot tones, opposite delivery direction. */
const SLOW_QUIET_ANGER_CUES: Record<string, string | null> = {
  heated: "[slow, quiet, cold and precise]",
  excited: "[measured, intense, deliberate]",
  incredulous: "[quiet disbelief, unhurried]",
  dismissive: "[flat, slow, done with this]",
};

/** Heated cues for a host whose volume goes UP while pace goes DOWN — the
 *  trained-projection voice that stretches words and holds terminals under
 *  pressure rather than accelerating. Distinct from BOTH other sets: the hot
 *  set is loud-and-fast, the slow/quiet set drops volume as well as pace. This
 *  is the one that keeps two loud hosts legible in mono — they differ in pace
 *  direction, not volume. */
const LOUD_SLOW_ANGER_CUES: Record<string, string | null> = {
  heated: "[loud and slow, stretching every word]",
  excited: "[booming, unhurried, savoring it]",
  incredulous: "[loud disbelief, drawn out]",
  dismissive: "[loud, flat, dragging the words]",
};

export interface FishScenePayload {
  url: string;
  model: string;
  body: {
    text: string;
    reference_id: string[];
    format: "mp3" | "wav";
    mp3_bitrate?: number;
    temperature: number;
    top_p: number;
  };
  /** Speaker-index order: voiceId per index (audit trail; matches reference_id). */
  voiceOrder: string[];
}

/** Heat score to pick the single scene line allowed a tone accent. */
function lineHeat(u: { tone?: string; energy?: string }): number {
  const e = u.energy === "high" ? 2 : u.energy === "medium" ? 1 : 0;
  const hotTone = ["heated", "excited", "incredulous"].includes((u.tone || "").toLowerCase()) ? 2 : 0;
  return e + hotTone;
}

/** Pure request builder (unit-tested without network). */
export function buildFishScenePayload(input: DialogueSceneInput): FishScenePayload {
  // Default is the FREE-TIER model. s2-pro (the SDK-canonical paid model)
  // 402s on an account with no API credit — Fish bills API credit separately
  // from platform credit — and the prod account hit exactly that: 17/17
  // scenes failed on 2026-07-25. s2.1-pro-free renders multi-speaker scenes
  // (verified live against the real API the same day). Funded accounts opt
  // into the paid model with FISH_SCENE_MODEL=s2-pro.
  const model = (process.env.FISH_SCENE_MODEL || "s2.1-pro-free").trim();

  // Speaker index = order of first appearance in the scene.
  const voiceOrder: string[] = [];
  const speakerIndexByHost = new Map<string, number>();
  for (const u of input.utterances) {
    if (!speakerIndexByHost.has(u.speakerHostId)) {
      if (!FISH_REFERENCE_ID_RE.test(u.voiceId)) {
        throw new SceneGenerationError(
          "invalid_voice",
          `Line ${u.lineIndex}: '${u.voiceId || "(empty)"}' is not a valid 32-hex Fish reference id — a scene needs an explicit Fish voice per speaker.`
        );
      }
      speakerIndexByHost.set(u.speakerHostId, voiceOrder.length);
      voiceOrder.push(u.voiceId);
    }
  }

  const cueCapByHost = new Map<string, number>();
  const angerStyleByHost = new Map<string, "louder_faster" | "slower_quieter" | "louder_slower">();
  for (const c of input.cast) {
    cueCapByHost.set(c.speakerHostId, Math.max(0, Math.min(2, c.maxCueDensity)));
    angerStyleByHost.set(c.speakerHostId, c.angerStyle ?? "louder_faster");
  }

  // The ONE line (if any) allowed a tone-derived accent cue this scene.
  let accentLineIndex = -1;
  let bestHeat = 0;
  for (const u of input.utterances) {
    const heat = lineHeat(u);
    if (heat >= 3 && heat > bestHeat) {
      bestHeat = heat;
      accentLineIndex = u.lineIndex;
    }
  }

  const parts: string[] = [];
  for (const u of input.utterances) {
    const idx = speakerIndexByHost.get(u.speakerHostId)!;
    let cueCount = 0;
    const cap = cueCapByHost.get(u.speakerHostId) ?? 1;

    // Turn-taking first: an interruption marker outranks decorative cues —
    // the model needs it to cut in, so it claims budget before anything else.
    const openers: string[] = [];
    if (u.isInterruption && cap > 0) {
      openers.push("[cutting in]");
      cueCount++;
    }

    // Convert the approved text's own tags in place (same table as line
    // mode), within whatever budget the turn-taking marker left.
    const text = u.spokenText.replace(TAG_PATTERN, (_m, inner: string) => {
      const mapped = SCRIPT_TAG_TO_FISH[inner.trim().toLowerCase()];
      if (mapped === undefined || mapped === null) return " ";
      if (cueCount >= Math.max(cap, u.isInterruption ? 2 : cap)) return " ";
      cueCount++;
      return ` ${mapped} `;
    });

    // Scene-level accent: exactly one line in the scene may open with a
    // tone cue — controlled variation instead of stamping every hot line.
    // The cue direction follows the SPEAKER's anger signature. Three distinct
    // sets, because volume and pace move independently: louder_faster gets the
    // hot cue, slower_quieter lands as slow cold precision, louder_slower stays
    // loud but stretches. Differing directions keep a heated stretch legible
    // even in mono — including when both hosts are loud.
    if (u.lineIndex === accentLineIndex && cueCount === 0 && cap > 0) {
      const tone = (u.tone || "").toLowerCase();
      const anger = angerStyleByHost.get(u.speakerHostId) ?? "louder_faster";
      const cue =
        anger === "slower_quieter"
          ? SLOW_QUIET_ANGER_CUES[tone] ?? TONE_TO_FISH_CUE[tone]
          : anger === "louder_slower"
            ? LOUD_SLOW_ANGER_CUES[tone] ?? TONE_TO_FISH_CUE[tone]
            : TONE_TO_FISH_CUE[tone];
      if (cue) {
        openers.push(cue);
        cueCount++;
      }
    }

    const body = text.replace(/\s+/g, " ").trim();
    parts.push(`<|speaker:${idx}|>${openers.length ? `${openers.join(" ")} ` : ""}${body}`);
  }

  // Fish sampling knobs from the cast's profiles (median when configured).
  const temps = input.cast
    .map((c) => c.providerOverrides?.temperature)
    .filter((t): t is number => typeof t === "number" && t >= 0 && t <= 1)
    .sort((a, b) => a - b);
  const topPs = input.cast
    .map((c) => c.providerOverrides?.topP)
    .filter((t): t is number => typeof t === "number" && t >= 0 && t <= 1)
    .sort((a, b) => a - b);

  const format = input.format === "wav" ? "wav" : "mp3";
  return {
    url: FISH_TTS_URL,
    model,
    body: {
      text: parts.join(""),
      reference_id: voiceOrder,
      format,
      ...(format === "mp3" ? { mp3_bitrate: 192 } : {}),
      temperature: temps.length ? temps[Math.floor(temps.length / 2)] : 0.7,
      top_p: topPs.length ? topPs[Math.floor(topPs.length / 2)] : 0.7,
    },
    voiceOrder,
  };
}

/** Execute the scene request. Retries once on 429/5xx. */
export async function synthesizeFishDialogueScene(input: DialogueSceneInput): Promise<DialogueSceneResult> {
  const apiKey = getFishApiKey();
  if (!apiKey) throw new SceneGenerationError("authentication", "FISH_API_KEY is not configured.");

  const payload = buildFishScenePayload(input);
  const timeoutMs = parseInt(process.env.FISH_TTS_TIMEOUT_MS || "120000", 10);

  const doFetch = async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(payload.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          model: payload.model,
        },
        body: JSON.stringify(payload.body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
  };

  let response: Response;
  try {
    response = await doFetch();
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = parseFloat(response.headers.get("retry-after") || "0");
      await new Promise((r) => setTimeout(r, retryAfter > 0 ? retryAfter * 1000 : 3000));
      response = await doFetch();
    }
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new SceneGenerationError("provider_unavailable", `Fish scene request timed out after ${timeoutMs}ms.`);
    }
    throw new SceneGenerationError("provider_unavailable", `Fish scene request failed: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new SceneGenerationError(
      categorizeHttpStatus(response.status),
      `Fish Audio scene API error ${response.status}: ${errText.slice(0, 300)}`
    );
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  if (audioBuffer.length === 0) {
    throw new SceneGenerationError("empty_audio", "Fish Audio scene API returned an empty audio body.");
  }

  return {
    audioBuffer,
    contentType: response.headers.get("content-type") || `audio/${payload.body.format}`,
    renderUnit: "multi_speaker_scene",
    model: payload.model,
    endpoint: "v1/tts (multi-speaker)",
    providerMetadata: {
      voiceOrder: payload.voiceOrder,
      temperature: payload.body.temperature,
      topP: payload.body.top_p,
      // The exact provider text is auditable but must NEVER reach
      // listener-visible surfaces; it lives only in safe metadata.
      cuedTextPreview: payload.body.text.slice(0, 400),
      characterCount: payload.body.text.length,
    },
  };
}
