// Fish Audio S2-Pro multi-speaker scene adapter.
//
// One request renders a whole conversation with <|speaker:N|> tags. Consecutive
// stored JSON lines from the same host are collapsed into ONE speaker run so a
// database/storage boundary cannot become an audible cadence reset.

import { getFishApiKey } from "../../env";
import {
  DialogueSceneInput,
  DialogueSceneResult,
  SceneGenerationError,
  categorizeHttpStatus,
  type ScenePerformanceContext,
} from "./sceneTypes";
import { FISH_REFERENCE_ID_RE } from "./providerIds";
import { SCRIPT_TAG_TO_FISH, TONE_TO_FISH_CUE } from "./fishFormat";

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const TAG_PATTERN = /\[([^\[\]]{1,40})\]/g;

const SLOW_QUIET_ANGER_CUES: Record<string, string | null> = {
  heated: "[slow, quiet, cold and precise]",
  excited: "[measured, intense, deliberate]",
  incredulous: "[quiet disbelief, unhurried]",
  dismissive: "[flat, slow, done with this]",
};

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
  voiceOrder: string[];
  directionCues: Record<string, string>;
  /** Number of provider speaker runs after adjacent same-host lines collapse. */
  speakerRunCount: number;
}

function lineHeat(u: { tone?: string; energy?: string }): number {
  const e = u.energy === "high" ? 2 : u.energy === "medium" ? 1 : 0;
  const hotTone = ["heated", "excited", "incredulous"].includes((u.tone || "").toLowerCase()) ? 2 : 0;
  return e + hotTone;
}

/** Distill the authored Delivery style into one short Fish control cue. */
export function compactFishDeliveryCue(ctx: ScenePerformanceContext): string | null {
  const direction = (ctx.direction || "").replace(/\s+/g, " ").trim();
  if (!direction) return null;
  const match = direction.match(/Delivery style:\s*(.*?)(?=\s+(?:This is|The disagreement|Mid-conversation|Your intensity|When genuinely|Never:)|$)/i);
  let style = (match?.[1] || "").trim();
  if (!style) return null;

  const firstSentence = style.match(/^(.{20,190}?[.!?])(?:\s|$)/)?.[1];
  style = (firstSentence || style).replace(/[.!?]+$/, "").trim();
  if (style.length > 180) {
    const cut = style.slice(0, 180);
    style = cut.slice(0, Math.max(40, cut.lastIndexOf(" "))).trim();
  }
  return `[${style}; conversational, responsive, reacting in the moment]`;
}

/** Pure request builder (unit-tested without network). */
export function buildFishScenePayload(input: DialogueSceneInput): FishScenePayload {
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
  const baselineCueByHost = new Map<string, string>();
  const directionCues: Record<string, string> = {};
  for (const c of input.cast) {
    cueCapByHost.set(c.speakerHostId, Math.max(0, Math.min(2, c.maxCueDensity)));
    angerStyleByHost.set(c.speakerHostId, c.angerStyle ?? "louder_faster");
    const cue = compactFishDeliveryCue(c);
    if (cue) {
      baselineCueByHost.set(c.speakerHostId, cue);
      directionCues[c.speakerHostId] = cue;
    }
  }

  // Exactly one line may carry the scene's tone-derived emotional accent.
  let accentLineIndex = -1;
  let bestHeat = 0;
  for (const u of input.utterances) {
    const heat = lineHeat(u);
    if (heat >= 3 && heat > bestHeat) {
      bestHeat = heat;
      accentLineIndex = u.lineIndex;
    }
  }

  const baselineApplied = new Set<string>();
  const parts: string[] = [];
  let previousHostId: string | null = null;

  for (const u of input.utterances) {
    const idx = speakerIndexByHost.get(u.speakerHostId)!;
    let cueCount = 0;
    const cap = cueCapByHost.get(u.speakerHostId) ?? 1;
    const openers: string[] = [];

    if (u.isInterruption && cap > 0) {
      openers.push("[cutting in]");
      cueCount++;
    }

    const text = u.spokenText.replace(TAG_PATTERN, (_m, inner: string) => {
      const mapped = SCRIPT_TAG_TO_FISH[inner.trim().toLowerCase()];
      if (mapped === undefined || mapped === null) return " ";
      if (cueCount >= Math.max(cap, u.isInterruption ? 2 : cap)) return " ";
      cueCount++;
      return ` ${mapped} `;
    });

    if (u.lineIndex === accentLineIndex && cueCount < cap && cap > 0) {
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

    if (!baselineApplied.has(u.speakerHostId) && cueCount < cap && cap > 0) {
      const baseline = baselineCueByHost.get(u.speakerHostId);
      if (baseline) {
        openers.push(baseline);
        cueCount++;
        baselineApplied.add(u.speakerHostId);
      }
    }

    const body = text.replace(/\s+/g, " ").trim();
    const rendered = `${openers.length ? `${openers.join(" ")} ` : ""}${body}`;

    // The script stores lines for editing, evidence and approval. Fish should
    // hear speaker TURNS. Adjacent lines by the same host stay under the same
    // speaker tag unless a real segment/topic boundary starts a new run.
    const continuesSameRun =
      previousHostId === u.speakerHostId &&
      u.segmentBoundary !== "segment" &&
      u.segmentBoundary !== "topic" &&
      !u.isInterruption;

    if (continuesSameRun && parts.length > 0) {
      parts[parts.length - 1] += ` ${rendered}`;
    } else {
      parts.push(`<|speaker:${idx}|>${rendered}`);
    }
    previousHostId = u.speakerHostId;
  }

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
    directionCues,
    speakerRunCount: parts.length,
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
      directionCues: payload.directionCues,
      speakerRunCount: payload.speakerRunCount,
      approvedUtteranceCount: input.utterances.length,
      cuedTextPreview: payload.body.text.slice(0, 400),
      characterCount: payload.body.text.length,
    },
  };
}
