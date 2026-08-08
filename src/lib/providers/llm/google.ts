// Google (Gemini) — via the OpenAI-compatible endpoint on Generative Language.
//
// WHY THIS PROVIDER IS HERE: Gemini leads long-document retrieval and holding a
// large context without losing the thread. Two roles here are exactly that
// shape — the continuity editor, which has to notice that a host contradicts
// something said twenty minutes earlier, and the debate architect, which has to
// keep a whole episode's argument coherent. Both fail in ways a short-context
// model cannot even detect.
//
// As with every provider in this directory: a reason to test, not a result.
// `npm run eval:models` decides.
//
// PROTOCOL NOTE: this deliberately uses Google's OpenAI-compatibility layer
// rather than the native generateContent API, so it inherits the shared
// retry/redaction/structured-parsing behaviour every other provider here gets
// instead of forking a second code path. The compatibility layer maps
// `reasoning_effort` onto Gemini's `thinking_level` on Google's side.
//
// MODEL ID IS UNVERIFIED. Google's naming has drifted across the 3.x line and
// the default below has NOT been confirmed against a live account. Confirm with
// `npm run probe:llm-contract` and correct via GOOGLE_MODEL if it is wrong —
// that is a variable change, not a code change.

import {
  OpenAICompatibleConfig,
  OpenAICompatibleLLMProvider,
  numberFromEnv,
  requireApiKey,
} from "./openaiCompatible";
import { MODEL_IDS } from "./capabilities";
import { ShapeContext, ShapeResult } from "./nvidiaRequestProfiles";
import { readRoutingEnv } from "./routingEnv";

export const GOOGLE_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

export class GoogleLLMProvider extends OpenAICompatibleLLMProvider {
  constructor(modelOverride?: string) {
    const model = modelOverride || readRoutingEnv("GOOGLE_MODEL") || MODEL_IDS.google.geminiPro;
    const config: OpenAICompatibleConfig = {
      provider: "google",
      model,
      baseUrl: readRoutingEnv("GOOGLE_BASE_URL") || GOOGLE_DEFAULT_BASE_URL,
      // GEMINI_API_KEY is accepted as an alias because Google's own docs and
      // console use both spellings; an operator who followed the Google quickstart
      // should not get a "missing credential" error for a key that is present.
      apiKey: requireApiKey(
        "google",
        readRoutingEnv("GOOGLE_API_KEY") ? "GOOGLE_API_KEY" : "GEMINI_API_KEY",
        "Google (Gemini)",
        "Create a key at aistudio.google.com and set GOOGLE_API_KEY on BOTH the web and worker services.",
      ),
      timeoutMs: numberFromEnv("GOOGLE_REQUEST_TIMEOUT_MS", 240_000),
      maxRetries: numberFromEnv("GOOGLE_MAX_RETRIES", 2),
      unpriced: true,
    };
    super(config);
  }

  /**
   * See xai.ts. Worth stating explicitly for Gemini: the 3.x line THINKS BY
   * DEFAULT, so reasoning content will come back on requests this shaping never
   * asked to reason. That is recorded honestly below rather than being claimed
   * as a capability this application exercised.
   */
  protected shapeModelFields(ctx: ShapeContext): ShapeResult {
    return {
      fields: {},
      diagnostics: {
        reasoningRequested: false,
        note:
          "google-gemini: no provider-specific fields sent. " +
          `Caller wanted reasoning: ${ctx.wantsReasoning}. Gemini 3.x thinks by default, so reasoning content in the ` +
          "response is NOT evidence that this shaping requested it.",
      },
    };
  }
}

export default GoogleLLMProvider;
