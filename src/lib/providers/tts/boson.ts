import { SynthesizeSpeechInput, SynthesizeSpeechResult, TTSProvider } from "./types";
import { getBosonApiKey } from "../../env";
import { formatLineForBoson } from "./bosonFormat";

// Boson AI (Higgs) TTS provider. The distinguishing feature: delivery is
// steered with inline control tokens, so every line is passed through
// formatLineForBoson() before synthesis. That formatting layer lives HERE,
// inside the provider — the shared TTS pipeline and every other provider see
// only the untouched script text.

const BOSON_TTS_URL = "https://api.boson.ai/v1/audio/speech";

export class BosonTTSProvider implements TTSProvider {
  public readonly name = "boson";

  async synthesizeSpeech(input: SynthesizeSpeechInput): Promise<SynthesizeSpeechResult> {
    const apiKey = getBosonApiKey();
    if (!apiKey) {
      throw new Error("BOSON_API_KEY is not configured.");
    }

    const modelId = process.env.BOSON_TTS_MODEL || "higgs-tts-3";
    const format = input.format === "wav" ? "wav" : "mp3";
    const timeoutMs = parseInt(process.env.BOSON_TTS_TIMEOUT_MS || "45000", 10);
    const maxAttempts = Math.max(1, parseInt(process.env.BOSON_TTS_MAX_RETRIES || "3", 10));

    // An explicitly resolved voice id (episode/run override) is honored
    // as-is; per-speaker env overrides and the shared default are only the
    // FALLBACK when no usable id was passed. Stub placeholders never reach
    // the API.
    const isStubVoice = !input.voiceId || input.voiceId.includes("stub");
    let voice = isStubVoice ? "" : input.voiceId;
    if (!voice) {
      if (input.speakerName === "Max Voltage" && process.env.BOSON_MAX_VOLTAGE_VOICE_ID) {
        voice = process.env.BOSON_MAX_VOLTAGE_VOICE_ID;
      } else if (input.speakerName === "Dr. Linebreak" && process.env.BOSON_DR_LINEBREAK_VOICE_ID) {
        voice = process.env.BOSON_DR_LINEBREAK_VOICE_ID;
      } else {
        voice = process.env.BOSON_TTS_VOICE || "default";
      }
    }

    // The Boson formatting layer: tone/energy/interruption metadata + inline
    // [tags] become lead delivery tokens, positional pauses, and sfx cues.
    const taggedText = formatLineForBoson({
      text: input.text,
      tone: input.tone,
      energy: input.energy,
      isInterruption: input.isInterruption,
    });

    const body: Record<string, unknown> = {
      model: modelId,
      input: taggedText,
      voice,
      response_format: format,
    };
    if (process.env.BOSON_TTS_REF_AUDIO) body.ref_audio = process.env.BOSON_TTS_REF_AUDIO;
    if (process.env.BOSON_TTS_REF_TEXT) body.ref_text = process.env.BOSON_TTS_REF_TEXT;

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(BOSON_TTS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.status === 429 || response.status >= 500) {
          const errText = await response.text().catch(() => "");
          lastError = new Error(`Boson API ${response.status}: ${errText.slice(0, 300)}`);
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
          throw new Error(`Boson API error: ${response.status} - ${errText.slice(0, 500)}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        if (audioBuffer.length === 0) {
          throw new Error("Boson API returned an empty audio body.");
        }
        return {
          audioBuffer,
          contentType: response.headers.get("content-type") || `audio/${format}`,
          providerAudioId: response.headers.get("x-boson-request-id") || undefined,
          raw: { taggedText },
        };
      } catch (err: any) {
        clearTimeout(timeoutId);
        if (err?.name === "AbortError") {
          lastError = new Error(`Boson TTS request timed out after ${timeoutMs}ms.`);
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
        // Network-level failures are retryable; API 4xx (non-429) are not
        // and were thrown above without setting up another loop pass.
        if (attempt < maxAttempts && (err?.name === "AbortError" || err?.cause || err?.message?.includes("fetch"))) {
          await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt - 1)));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError || new Error("Boson TTS failed after retries.");
  }
}
