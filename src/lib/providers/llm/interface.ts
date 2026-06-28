export interface GenerateTextOptions {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface GenerateStructuredOutputOptions extends GenerateTextOptions {
  jsonSchema?: Record<string, any>;
}

export interface LLMProvider {
  name: string;
  generateText(options: GenerateTextOptions): Promise<string>;
  generateStructuredOutput<T = any>(options: GenerateStructuredOutputOptions): Promise<T>;
}
