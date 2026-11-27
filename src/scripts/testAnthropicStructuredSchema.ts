// The Anthropic provider must send the caller's JSON schema and honour its
// validator with ONE repair request. Before this, both were silently dropped and
// the dossier writer failed live: "verifiedStatistics: Expected array, received object".
import assert from "node:assert";
import { AnthropicLLMProvider } from "../lib/providers/llm/anthropic";

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
  console.log("ok  anthropic structured output: schema sent, validator honoured, one repair");
}

main().catch((e) => { console.error("FAIL", e); process.exit(1); });
