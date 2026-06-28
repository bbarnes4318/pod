import { LLMProvider, GenerateTextOptions, GenerateStructuredOutputOptions } from "./interface";

export class OpenAILLMProvider implements LLMProvider {
  name = "openai";
  private apiKey: string;
  private model: string;

  constructor() {
    const key = process.env.OPENAI_API_KEY;
    if (!key || key === "your-openai-api-key") {
      throw new Error("[OpenAI] Missing or default OPENAI_API_KEY environment variable.");
    }
    this.apiKey = key;
    this.model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    console.log(`[OpenAI] Requesting completions via model: ${this.model}`);

    const messages: any[] = [];
    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: options.prompt });

    const body = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
    };

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[OpenAI] API request failed with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("[OpenAI] Received empty response content from model.");
    }

    return content;
  }

  async generateStructuredOutput<T = any>(options: GenerateStructuredOutputOptions): Promise<T> {
    console.log(`[OpenAI] Requesting structured output (JSON mode) via model: ${this.model}`);

    const messages: any[] = [];
    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: options.prompt });

    const body = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.2, // Low temperature for high structure fidelity
      max_tokens: options.maxTokens,
      response_format: { type: "json_object" },
    };

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[OpenAI] API structured request failed with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("[OpenAI] Received empty response content for JSON parsing.");
    }

    try {
      return JSON.parse(content) as T;
    } catch (err: any) {
      console.error("[OpenAI] Failed to parse JSON response:", content);
      throw new Error(`[OpenAI] Failed to parse output as valid JSON: ${err.message}`);
    }
  }
}

export default OpenAILLMProvider;
