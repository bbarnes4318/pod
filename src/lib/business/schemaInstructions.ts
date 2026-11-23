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

/**
 * A reply that was not valid JSON. The Anthropic provider forces JSON by
 * instruction only and, unlike the OpenAI-compatible providers, makes no
 * repair request, so one stray quote threw away a whole call: in the second
 * Milestone 2 live run topic batch 1 of 3 was lost this way ("Unexpected
 * token ... is not valid JSON").
 */
export function isMalformedJsonError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /failed to parse (output|json)|not valid json|unexpected (token|end of json)|no json object found/i.test(msg);
}

/** Wrap a provider so every structured call carries its schema, and a reply
 *  that came back as broken JSON is asked for once more (business calls only;
 *  sports keeps the provider's own behaviour). Everything else (routing,
 *  model tracking, `instanceof`) reaches the real provider. */
export function businessLLM<T extends LLMProvider | null | undefined>(llm: T): T {
  if (!llm) return llm;
  const target = llm as LLMProvider;
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "generateStructuredOutput") {
        return async (opts: GenerateStructuredOutputOptions) => {
          const withSchema = withSchemaInstructions(opts);
          try {
            return await t.generateStructuredOutput(withSchema);
          } catch (err) {
            if (!isMalformedJsonError(err)) throw err;
            console.warn(`[business] structured reply was not valid JSON; asking once more: ${(err as Error).message.slice(0, 160)}`);
            return t.generateStructuredOutput(withSchema);
          }
        };
      }
      const value = Reflect.get(t, prop, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
  }) as T;
}
