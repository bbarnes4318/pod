// Business structured calls must carry their output format to the model.
//
// The Anthropic provider forces JSON by INSTRUCTION and never sends
// `jsonSchema` to the API (openaiCompatible providers do send it). Business
// engines lean on their schemas rather than spelling field names out in
// prose, so on Anthropic the model guessed the shape: in the Milestone 2 live
// run every topic came back without `businessNiche` and was rejected, and with
// no length limits the answer ran to ~23k tokens and past the request timeout.
//
// Fixed here, for business calls only, so sports prompts — tuned without a
// schema in the text — are untouched: when a call has a real schema, the
// schema is appended to its system prompt. Harmless where the provider also
// sends it natively.

import type { GenerateStructuredOutputOptions, LLMProvider } from "../providers/llm/interface";

export function withSchemaInstructions(opts: GenerateStructuredOutputOptions): GenerateStructuredOutputOptions {
  const schema = opts.jsonSchema as { properties?: unknown } | undefined;
  if (!schema || !schema.properties) return opts;
  return {
    ...opts,
    systemPrompt: `${opts.systemPrompt ?? ""}\n\nOUTPUT FORMAT: return one JSON object that matches this JSON Schema exactly. Field names are case-sensitive, every "required" field must be present, and maxLength / maxItems are hard limits.\n${JSON.stringify(schema)}`,
  };
}

/** Wrap a provider so every structured call carries its schema. Everything
 *  else (routing, model tracking, `instanceof`) reaches the real provider. */
export function businessLLM<T extends LLMProvider | null | undefined>(llm: T): T {
  if (!llm) return llm;
  const target = llm as LLMProvider;
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "generateStructuredOutput") {
        return (opts: GenerateStructuredOutputOptions) => t.generateStructuredOutput(withSchemaInstructions(opts));
      }
      const value = Reflect.get(t, prop, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
  }) as T;
}
