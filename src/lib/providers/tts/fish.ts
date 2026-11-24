import { SynthesizeSpeechInput, SynthesizeSpeechResult, TTSProvider } from "./types";
import { getFishApiKey } from "../../env";
import { formatLineForFish } from "./fishFormat";
import { seatFallbackVoice } from "./voiceResolution";
import type { DialogueSceneInput, DialogueSceneProvider, DialogueSceneResult } from "./sceneTypes";
import { synthesizeFishDialogueScene } from "./fishDialogue";

// Fish Audio TTS provider (S2.1 family). Delivery is steered with inline
// natural-language [bracket] cues, so every line passes through
// formatLineForFish() before synthesis — that layer lives HERE, inside the
// provider; every other provider sees only the untouched script text.
//
// API: POST https://api.fish.audio/v1/tts
//   - Authorization: Bearer FISH_API_KEY
//   - model header selects the model
//   - JSON body: { text, reference_id?, prosody, temperature, top_p, ... }

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export class FishTTSProvider implements TTSProvider, DialogueSceneProvider {
  public readonly name = "fish";

  /** Native multi-speaker scene: one request with <|speaker:N|> tags and an
   *  ordered reference_id array (S2-Pro; docs/TTS_SCENE_CAPABILITIES.md). */
  synthesizeDialogueScene(input: DialogueSceneInput): Promise<DialogueSceneResult> {
    return synthesizeFishDialogueScene(input);
  }

  async synthesizeSpeech(input: SynthesizeSpeechInput): Promise<SynthesizeSpeechResult> {
    const apiKey = getFishApiKey();
    if (!apiKey) {
      throw new Error("FISH_API_KEY is not configured.");
    }

    const model = (process.env.FISH_MODEL || "s2.1-pro-free").trim();
    const format = input.format === "wav" ? "wav" : "mp3";
    const timeoutMs = parseInt(process.env.FISH_TTS_TIMEOUT_MS || "60000", 10);
    const maxAttempts = Math.max(1, parseInt(process.env.FISH_TTS_MAX_RETRIES || "3", 10));

    // Voice resolution: explicit voice id (episode/run override, host
    // default) wins; the SEAT-keyed env fallback comes next, ending at
    // FISH_TTS_VOICE; last resort is Fish's default voice (no reference_id).
    const asFishId = (id?: string | null): string | undefined =>
      id && /^[0-9a-f]{32}$/i.test(id) ? id : undefined;
    let referenceId = asFishId(input.voiceId);
    if (!referenceId) {
      referenceId = asFishId(seatFallbackVoice("fish", input.seatIndex)?.voiceId);
    }

    // The Fish formatting layer: tone/energy/interruption + [tags] become
    // inline natural-language cues. The host direction reaches this formatter,
    // while documented provider knobs below control global pace/volume and
    // candidate variability for honest Host Studio previews.
    const cuedText = formatLineForFish({
      text: input.text,
      tone: input.tone,
      energy: input.energy,
      isInterruption: input.isInterruption,
      voiceDirection: input.voiceDirection,
    });

    const temperature = clamp(Number(input.temperature ?? 0.8), 0, 1);
    const topP = clamp(Number(input.topP ?? 0.85), 0, 1);
    const speed = clamp(Number(input.speed ?? 1), 0.5, 2);
    const volume = clamp(Number(input.volume ?? 0), -20, 20);
    const body: Record<string, unknown> = {
      text: cuedText,
      format,
      temperature,
      top_p: topP,
      prosody: { speed, volume, normalize_loudness: true },
      normalize: true,
    };
    if (referenceId) body.reference_id = referenceId;
    if (format === "mp3") body.mp3_bitrate = 192;

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(FISH_TTS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            model,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.status === 429 || response.status >= 500) {
          const errText = await response.text().catch(() => "");
          lastError = new Error(`Fish Audio API ${response.status}: ${errText.slice(0, 300)}`);
          if (attempt < maxAttempts) {
            const retryAfter = parseFloat(response.headers.get("retry-after") || "0");
            const backoffMs = retryAfter > 0 ? retryAfter * 1000 : 1500 * Math.pow(2, attempt - 1);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          throw lastError;
        }

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          throw new Error(`Fish Audio API error: ${response.status} - ${errText.slice(0, 500)}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        if (audioBuffer.length === 0) {
          throw new Error("Fish Audio API returned an empty audio body.");
        }
        return {
          audioBuffer,
          contentType: response.headers.get("content-type") || `audio/${format}`,
          raw: { cuedText, model, temperature, topP, speed, volume },
        };
      } catch (err: any) {
        clearTimeout(timeoutId);
        if (err?.name === "AbortError") {
          lastError = new Error(`Fish Audio TTS request timed out after ${timeoutMs}ms.`);
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
        if (attempt < maxAttempts && (err?.name === "AbortError" || err?.cause || err?.message?.includes("fetch"))) {
          await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt - 1)));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError || new Error("Fish Audio TTS failed after retries.");
  }
}
