// The Anthropic provider must send the caller's JSON schema and honour its
// validator with ONE repair request. Before this, both were silently dropped and
// the dossier writer failed live: "verifiedStatistics: Expected array, received object".
import assert from "node:assert";
import { AnthropicLLMProvider, anthropicSupportsJsonOutputs, toAnthropicJsonSchema } from "../lib/providers/llm/anthropic";

async function main() {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-not-real";
  const replies = ['{"stats":{"a":1}}', '{"stats":[1]}'];
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    const text = replies.shift()!;
    return new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: {} }), { status: 200 });
  }) as typeof fetch;

  const p = new AnthropicLLMProvider("claude-sonnet-5");
  const out = await p.generateStructuredOutput<{ stats: number[] }>({
    prompt: "give stats",
    jsonSchema: { type: "object", properties: { stats: { type: "array" } }, required: ["stats"] },
    validate: (v: any) => (Array.isArray(v?.stats) ? null : "stats Expected array, received object"),
  });

  const sys = (b: any) => JSON.stringify(b.system ?? "");
  assert.deepEqual(out, { stats: [1] }, "repaired reply is returned");
  assert.equal(bodies.length, 2, "exactly one repair request");
  assert.ok(sys(bodies[0]).includes('\\"stats\\"'), "schema is sent to Claude");
  assert.ok(JSON.stringify(bodies[1].messages).includes("Expected array"), "repair names the error");

  // A reply that still fails after the repair must throw (so routing can fall over), not return junk.
  replies.push('{"stats":{}}', '{"stats":{}}');
  await assert.rejects(
    p.generateStructuredOutput({ prompt: "x", validate: (v: any) => (Array.isArray(v?.stats) ? null : "bad") }),
    /failed validation after one repair/
  );
  // Native JSON outputs: format is sent, with limits stripped and objects closed.
  const fmt = bodies[0].output_config?.format;
  assert.equal(fmt?.type, "json_schema", "native JSON outputs requested");
  assert.equal(fmt.schema.additionalProperties, false, "objects closed");
  const s = toAnthropicJsonSchema({ type: "object", properties: { a: { type: "array", maxItems: 3, items: { type: "object", properties: { t: { type: "string", maxLength: 9 } } } } } });
  assert.deepEqual(s.properties.a, { type: "array", items: { type: "object", properties: { t: { type: "string" } }, additionalProperties: false } }, "unsupported keys stripped recursively");
  assert.ok(!anthropicSupportsJsonOutputs("claude-opus-4-6") && anthropicSupportsJsonOutputs("claude-sonnet-5") && anthropicSupportsJsonOutputs("claude-opus-5"));

  // A 400 on the schema falls back to the instruction-only request instead of failing.
  bodies.length = 0;
  let calls = 0;
  globalThis.fetch = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    if (calls++ === 0) return new Response('{"error":{"message":"bad schema"}}', { status: 400 });
    return new Response(JSON.stringify({ content: [{ type: "text", text: '{"stats":[2]}' }], stop_reason: "end_turn", usage: {} }), { status: 200 });
  }) as typeof fetch;
  const fb = await p.generateStructuredOutput({ prompt: "x", jsonSchema: { type: "object", properties: { stats: { type: "array" } } } });
  assert.deepEqual(fb, { stats: [2] });
  assert.ok(bodies[0].output_config?.format && !bodies[1].output_config?.format, "second request drops the format");

  // A field NAMED like a constraint survives; enum values are left alone.
  const named = toAnthropicJsonSchema({ type: "object", properties: { maximum: { type: "number", maximum: 5 }, kind: { enum: [{ minLength: 1 }] } } });
  assert.deepEqual(named.properties.maximum, { type: "number" }, "a property called maximum is kept, its limit stripped");
  assert.deepEqual(named.properties.kind.enum, [{ minLength: 1 }], "enum values untouched");

  // The schema that was rejected is remembered: the next call skips the 400.
  bodies.length = 0;
  await p.generateStructuredOutput({ prompt: "x", jsonSchema: { type: "object", properties: { stats: { type: "array" } } } });
  assert.equal(bodies.length, 1, "no second 400 for a schema already rejected");
  assert.ok(!bodies[0].output_config?.format);

  // A 400 that is not about the schema (no credit) is NOT retried instruction-only.
  bodies.length = 0;
  globalThis.fetch = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response('{"error":{"message":"Your credit balance is too low"}}', { status: 400 });
  }) as typeof fetch;
  await assert.rejects(p.generateStructuredOutput({ prompt: "x", jsonSchema: { type: "object", properties: { other: { type: "string" } } } }), /status 400/);
  assert.equal(bodies.length, 1, "one request, no fallback");

  // Cut off at max_tokens: retried once with a higher cap, then a clear error
  // that is not a JSON-parse error (so nothing above repeats it).
  bodies.length = 0;
  globalThis.fetch = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ content: [{ type: "text", text: '{"stats":[1,' }], stop_reason: "max_tokens", usage: {} }), { status: 200 });
  }) as typeof fetch;
  const { isMalformedJsonError } = await import("../lib/business/schemaInstructions");
  const cut = await p.generateStructuredOutput({ prompt: "x", maxTokens: 1000 }).catch((e) => e as Error);
  assert.ok(/cut off at max_tokens/.test(cut.message) && !isMalformedJsonError(cut), "truncation is its own error");
  assert.equal(bodies.length, 2, "exactly one escalation");
  assert.ok(bodies[1].max_tokens === bodies[0].max_tokens * 2, "cap doubled");

  // Retry amplification is bounded: validator always rejects + every reply is
  // malformed on a business call would have been 2 x 2 x 3 requests and more.
  bodies.length = 0;
  process.env.ANTHROPIC_STRUCTURED_MAX_REQUESTS = "3";
  globalThis.fetch = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response("overloaded", { status: 529, headers: { "retry-after": "0.001" } });
  }) as typeof fetch;
  await assert.rejects(p.generateStructuredOutput({ prompt: "x" }), /status 529|stopped after 3 HTTP requests/);
  assert.ok(bodies.length <= 3, `at most the budget (${bodies.length})`);
  delete process.env.ANTHROPIC_STRUCTURED_MAX_REQUESTS;

  console.log("ok  anthropic structured output: native JSON format, validator honoured, one repair, schema-only 400 fallback, truncation, request budget");
}

main().catch((e) => { console.error("FAIL", e); process.exit(1); });
