import { LLMProvider, LLMUsage, GenerateTextOptions, GenerateStructuredOutputOptions } from "./interface";

export class OpenAILLMProvider implements LLMProvider {
  name = "openai";
  private apiKey: string;
  private model: string;
  private usage: LLMUsage = { inputTokens: 0, outputTokens: 0, requestCount: 0 };

  getAccumulatedUsage(): LLMUsage {
    return { ...this.usage };
  }

  private recordUsage(data: any): void {
    const u = data?.usage;
    if (u) {
      this.usage.inputTokens += u.prompt_tokens || 0;
      this.usage.outputTokens += u.completion_tokens || 0;
      this.usage.requestCount += 1;
    }
  }

  constructor(modelOverride?: string) {
    const key = process.env.OPENAI_API_KEY;
    if (!key || key === "your-openai-api-key") {
      throw new Error("[OpenAI] Missing or default OPENAI_API_KEY environment variable.");
    }
    this.apiKey = key;
    this.model = modelOverride || process.env.OPENAI_MODEL || "gpt-4o-mini";
  }

  private isReasoningModel(): boolean {
    const m = this.model.toLowerCase();
    return m.startsWith("o1") || m.startsWith("o3") || m === "gpt-5.5";
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    console.log(`[OpenAI] Requesting completions via model: ${this.model}`);

    const messages: any[] = [];
    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: options.prompt });

    const body: any = {
      model: this.model,
      messages,
    };

    if (this.isReasoningModel()) {
      if (options.maxTokens) {
        // Reasoning models need a much larger budget because reasoning tokens count against the limit
        body.max_completion_tokens = Math.max(options.maxTokens, 25000);
      }
    } else {
      if (options.maxTokens) {
        body.max_tokens = options.maxTokens;
      }
      body.temperature = options.temperature ?? 0.7;
    }

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
    this.recordUsage(data);
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

    const body: any = {
      model: this.model,
      messages,
      response_format: { type: "json_object" },
    };

    if (this.isReasoningModel()) {
      if (options.maxTokens) {
        // Reasoning models need a much larger budget because reasoning tokens count against the limit
        body.max_completion_tokens = Math.max(options.maxTokens, 25000);
      }
    } else {
      if (options.maxTokens) {
        body.max_tokens = options.maxTokens;
      }
      body.temperature = options.temperature ?? 0.2; // Low temperature for high structure fidelity
    }

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
    this.recordUsage(data);
    console.log("[OpenAI] Response data:", JSON.stringify(data));
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      const refusal = data.choices?.[0]?.message?.refusal;
      const errorMsg = refusal ? `Refusal: ${refusal}` : "Empty content";
      throw new Error(`[OpenAI] Received empty response content for JSON parsing (${errorMsg}).`);
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
