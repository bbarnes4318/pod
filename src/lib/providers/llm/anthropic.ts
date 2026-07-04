import { LLMProvider, GenerateTextOptions, GenerateStructuredOutputOptions } from "./interface";

export class AnthropicLLMProvider implements LLMProvider {
  name = "anthropic";
  private apiKey: string;
  private model: string;

  constructor(modelOverride?: string) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || key === "your-anthropic-api-key") {
      throw new Error("[Anthropic] Missing or default ANTHROPIC_API_KEY environment variable.");
    }
    this.apiKey = key;
    this.model = modelOverride || process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    console.log(`[Anthropic] Requesting messages via model: ${this.model}`);

    const body = {
      model: this.model,
      messages: [{ role: "user", content: options.prompt }],
      system: options.systemPrompt,
      max_tokens: options.maxTokens || 4000,
      temperature: options.temperature ?? 0.7,
    };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[Anthropic] API request failed with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data.content?.[0]?.text;
    if (!content) {
      throw new Error("[Anthropic] Received empty response content from messages endpoint.");
    }

    return content;
  }

  async generateStructuredOutput<T = any>(options: GenerateStructuredOutputOptions): Promise<T> {
    console.log(`[Anthropic] Requesting structured output (JSON forced) via model: ${this.model}`);

    // Append JSON system instructions to help Claude output pure parseable JSON
    const systemPromptWithJson = `${options.systemPrompt || ""}\n\nCRITICAL: You must return a single, valid JSON object starting with '{' and ending with '}'. Do not include markdown code blocks (e.g. \`\`\`json ... \`\`\`), no conversational preambles, and no conversational postambles. Only return the raw JSON object.`;

    const body = {
      model: this.model,
      messages: [{ role: "user", content: options.prompt }],
      system: systemPromptWithJson,
      max_tokens: options.maxTokens || 4000,
      temperature: options.temperature ?? 0.2, // Low temperature for high structure fidelity
    };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[Anthropic] API structured request failed with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    let content = data.content?.[0]?.text;
    if (!content) {
      throw new Error("[Anthropic] Received empty response content for JSON parsing.");
    }

    content = content.trim();

    // Clean markdown code blocks if the LLM outputted them despite system prompt
    if (content.startsWith("```")) {
      const lines = content.split("\n");
      // Remove first line (e.g. ```json) and last line (```)
      if (lines[0].startsWith("```")) {
        lines.shift();
      }
      if (lines[lines.length - 1].startsWith("```")) {
        lines.pop();
      }
      content = lines.join("\n").trim();
    }

    try {
      return JSON.parse(content) as T;
    } catch (err: any) {
      console.error("[Anthropic] Failed to parse JSON response content:", content);
      throw new Error(`[Anthropic] Failed to parse output as valid JSON: ${err.message}`);
    }
  }
}

export default AnthropicLLMProvider;
