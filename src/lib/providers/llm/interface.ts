export interface GenerateTextOptions {
  prompt: string;
  systemPrompt?: string;
  /** Large context that is byte-identical across several calls in a run
   *  (evidence packet, character data). Providers place it in a separate
   *  system block with a provider cache breakpoint so repeat calls read it
   *  from the prompt cache instead of re-billing full input price. */
  cacheableContext?: string;
  temperature?: number;
  maxTokens?: number;
  /** Determinism seed, sent only to models whose capability record declares
   *  seed support. Silently omitted elsewhere rather than risking a 400. */
  seed?: number;
  /** Reasoning posture the CALLER wants. Providers translate it into their own
   *  spelling, or ignore it when the model has no reasoning mode. Reasoning
   *  content is always separated from the answer — it never reaches dialogue,
   *  show notes or TTS. Defaults to the role's posture when routed by role. */
  reasoning?: "off" | "on";
}

export interface GenerateStructuredOutputOptions extends GenerateTextOptions {
  jsonSchema?: Record<string, any>;
  /** Structural check run against the parsed object before it is returned.
   *  Return an error message to reject the result (which triggers ONE schema
   *  repair, then the next model in the role's chain), or null when valid.
   *  This is where "a movement with no lines" is caught at the provider edge
   *  instead of three services later. */
  validate?: (value: unknown) => string | null;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  /** Provider-reported reasoning tokens, when the provider reports them. */
  reasoningTokens?: number;
  /** Provider-reported cache-read input tokens, when reported. */
  cachedInputTokens?: number;
}

export interface LLMProvider {
  name: string;
  generateText(options: GenerateTextOptions): Promise<string>;
  generateStructuredOutput<T = any>(options: GenerateStructuredOutputOptions): Promise<T>;
  /** Cumulative token usage across this provider instance's calls (optional). */
  getAccumulatedUsage?(): LLMUsage;
}
