import { LLMProvider, GenerateTextOptions, GenerateStructuredOutputOptions } from "./interface";

/**
 * Stub LLM provider rejects real generation attempts as required by the safety spec.
 */
export class StubLLMProvider implements LLMProvider {
  name = "stub-llm";

  async generateText(options: GenerateTextOptions): Promise<string> {
    throw new Error("LLM provider is stub. Real topic generation disabled.");
  }

  async generateStructuredOutput<T = any>(options: GenerateStructuredOutputOptions): Promise<T> {
    throw new Error("LLM provider is stub. Real topic generation disabled.");
  }
}

export default StubLLMProvider;
