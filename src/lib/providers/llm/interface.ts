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
}

export interface GenerateStructuredOutputOptions extends GenerateTextOptions {
  jsonSchema?: Record<string, any>;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}

export interface LLMProvider {
  name: string;
  generateText(options: GenerateTextOptions): Promise<string>;
  generateStructuredOutput<T = any>(options: GenerateStructuredOutputOptions): Promise<T>;
  /** Cumulative token usage across this provider instance's calls (optional). */
  getAccumulatedUsage?(): LLMUsage;
}
