// Shared structured-output handling for the OpenAI-compatible providers.
//
// The application depends on structured JSON at almost every stage, and a
// partially-parsed script is worse than a failed one: a dropped movement or a
// silently-empty object turns into a short episode nobody asked for. So this
// module rejects rather than salvages whenever salvage would be a guess:
//
//   - Markdown fences are stripped (a formatting artifact, not missing data).
//   - Leading/trailing prose is stripped only when a complete, balanced JSON
//     object can be isolated.
//   - TRUNCATED JSON is rejected, never patched. Unbalanced braces mean the
//     model hit its output ceiling mid-answer.
//   - `{}`, a non-object, or a JSON array where an object is required is
//     rejected — never returned as "success with no content".
//   - Required arrays declared in the caller's schema must be present.
//
// A rejection carries a machine-readable `kind` so the routing layer can decide
// between ONE repair request and moving to the next model.

export type StructuredFailureKind =
  | "empty_response"
  | "no_json_found"
  | "truncated_json"
  | "invalid_json"
  | "not_an_object"
  | "empty_object"
  | "schema_violation";

export class StructuredOutputError extends Error {
  readonly kind: StructuredFailureKind;
  /** Safe-to-log excerpt (never a credential — this is model output only). */
  readonly excerpt: string;
  constructor(kind: StructuredFailureKind, message: string, raw: string) {
    super(message);
    this.name = "StructuredOutputError";
    this.kind = kind;
    this.excerpt = raw.slice(0, 400);
  }
}

/** Strip ```json fences the model added despite instructions. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const lines = trimmed.split("\n");
  if (lines[0].startsWith("```")) lines.shift();
  if (lines.length && lines[lines.length - 1].trim().startsWith("```")) lines.pop();
  return lines.join("\n").trim();
}

interface Balance {
  balanced: boolean;
  /** Index just past the outermost closing brace, or -1. */
  endIndex: number;
  inString: boolean;
  depth: number;
}

/**
 * Walk the text as JSON, tracking string state and escapes, and report whether
 * the outermost object/array closes. This is what distinguishes "the model
 * wrapped its JSON in chatter" (recoverable) from "the model was cut off"
 * (not recoverable).
 */
function scanBalance(text: string, startIndex: number): Balance {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return { balanced: true, endIndex: i + 1, inString: false, depth: 0 };
    }
  }
  return { balanced: false, endIndex: -1, inString, depth };
}

/** Required top-level array properties declared by a JSON Schema object. */
export function requiredArrayKeys(schema: Record<string, any> | undefined): string[] {
  if (!schema || schema.type !== "object") return [];
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const props = (schema.properties || {}) as Record<string, any>;
  return required.filter((k) => props[k]?.type === "array");
}

export interface ParseStructuredOptions {
  /** The caller's real schema, used for required-array checks. */
  jsonSchema?: Record<string, any>;
  /** Caller-supplied structural check. Returns an error message, or null when valid. */
  validate?: (value: unknown) => string | null;
  /** Label used in error messages, e.g. "nvidia/deepseek-ai/deepseek-v4-pro". */
  label: string;
}

/**
 * Parse and validate a model's structured response. Throws StructuredOutputError
 * on every failure mode — never returns a partial or empty result.
 */
export function parseStructuredResponse<T>(raw: string, opts: ParseStructuredOptions): T {
  const label = opts.label;
  if (!raw || !raw.trim()) {
    throw new StructuredOutputError("empty_response", `[${label}] Model returned no content.`, raw || "");
  }

  const cleaned = stripCodeFences(raw);
  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  const start =
    firstBrace === -1 ? firstBracket : firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket);

  if (start === -1) {
    throw new StructuredOutputError(
      "no_json_found",
      `[${label}] No JSON object found in the response.`,
      cleaned
    );
  }

  const balance = scanBalance(cleaned, start);
  if (!balance.balanced) {
    throw new StructuredOutputError(
      "truncated_json",
      `[${label}] JSON is TRUNCATED — the outermost structure never closes (${balance.depth} level(s) still open` +
        `${balance.inString ? ", inside an unterminated string" : ""}). The model hit its output ceiling; the partial ` +
        `result was rejected rather than patched.`,
      cleaned
    );
  }

  const candidate = cleaned.slice(start, balance.endIndex);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err: any) {
    throw new StructuredOutputError(
      "invalid_json",
      `[${label}] Response is not valid JSON: ${err?.message}`,
      candidate
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StructuredOutputError(
      "not_an_object",
      `[${label}] Expected a JSON object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
      candidate
    );
  }

  if (Object.keys(parsed as Record<string, unknown>).length === 0) {
    throw new StructuredOutputError(
      "empty_object",
      `[${label}] Model returned an empty object. An empty result is a failure, not a valid answer.`,
      candidate
    );
  }

  for (const key of requiredArrayKeys(opts.jsonSchema)) {
    if (!Array.isArray((parsed as Record<string, unknown>)[key])) {
      throw new StructuredOutputError(
        "schema_violation",
        `[${label}] Required array '${key}' is missing or not an array.`,
        candidate
      );
    }
  }

  if (opts.validate) {
    const problem = opts.validate(parsed);
    if (problem) {
      throw new StructuredOutputError("schema_violation", `[${label}] ${problem}`, candidate);
    }
  }

  return parsed as T;
}

/** Prompt for the ONE schema-repair attempt allowed before falling back. */
export function buildRepairPrompt(originalPrompt: string, failure: StructuredOutputError): string {
  const diagnosis =
    failure.kind === "truncated_json"
      ? "Your previous answer was cut off before the JSON closed. Produce the SAME content, but more compactly, so the complete JSON fits."
      : failure.kind === "schema_violation"
      ? `Your previous answer did not satisfy the required structure: ${failure.message}`
      : `Your previous answer could not be parsed as JSON: ${failure.message}`;

  return `${originalPrompt}

=== STRUCTURED OUTPUT REPAIR ===
${diagnosis}

Return ONE complete, valid JSON object matching the requested schema exactly. Start with '{' and end with '}'. No markdown fences, no commentary before or after, no trailing text. Do not omit any required field or array.`;
}
