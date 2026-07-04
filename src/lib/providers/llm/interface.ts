export interface GenerateTextOptions {
  prompt: string;
  systemPrompt?: string;
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
