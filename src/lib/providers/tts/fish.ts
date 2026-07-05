import { SynthesizeSpeechInput, SynthesizeSpeechResult, TTSProvider } from "./types";
import { getFishApiKey } from "../../env";
import { formatLineForFish } from "./fishFormat";

// Fish Audio TTS provider (S2.1 family). Delivery is steered with inline
// natural-language [bracket] cues, so every line passes through
// formatLineForFish() before synthesis — that layer lives HERE, inside the
// provider; every other provider sees only the untouched script text.
//
// API: POST https://api.fish.audio/v1/tts
//   - Authorization: Bearer FISH_API_KEY
//   - model header selects the model (FISH_MODEL, default s2.1-pro-free —
//     same model as s2.1-pro, $0 fair-use, no latency guarantee; switch the
//     env var to s2.1-pro for production)
//   - JSON body: { text, reference_id?, format, ... }
//   - reference_id is the Fish voice/model id; per-host env overrides
//     mirror the Boson provider's pattern.

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";

export class FishTTSProvider implements TTSProvider {
  public readonly name = "fish";

  async synthesizeSpeech(input: SynthesizeSpeechInput): Promise<SynthesizeSpeechResult> {
    const apiKey = getFishApiKey();
    if (!apiKey) {
      throw new Error("FISH_API_KEY is not configured.");
    }

    const model = (process.env.FISH_MODEL || "s2.1-pro-free").trim();
    const format = input.format === "wav" ? "wav" : "mp3";
    const timeoutMs = parseInt(process.env.FISH_TTS_TIMEOUT_MS || "60000", 10);
    const maxAttempts = Math.max(1, parseInt(process.env.FISH_TTS_MAX_RETRIES || "3", 10));

    // Voice resolution: explicit host voice id, per-speaker env override,
    // then Fish's default voice (no reference_id). Stub ids never go out.
    let referenceId: string | undefined = input.voiceId;
    if (!referenceId || referenceId.includes("stub")) referenceId = undefined;
    if (input.speakerName === "Max Voltage" && process.env.FISH_MAX_VOLTAGE_VOICE_ID) {
      referenceId = process.env.FISH_MAX_VOLTAGE_VOICE_ID;
    } else if (input.speakerName === "Dr. Linebreak" && process.env.FISH_DR_LINEBREAK_VOICE_ID) {
      referenceId = process.env.FISH_DR_LINEBREAK_VOICE_ID;
    } else if (!referenceId && process.env.FISH_TTS_VOICE) {
      referenceId = process.env.FISH_TTS_VOICE;
    }

    // The Fish formatting layer: tone/energy/interruption + [tags] become
    // inline natural-language cues, capped at a human amount.
    const cuedText = formatLineForFish({
      text: input.text,
      tone: input.tone,
      energy: input.energy,
      isInterruption: input.isInterruption,
    });

    const body: Record<string, unknown> = {
      text: cuedText,
      format,
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
          raw: { cuedText, model },
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
