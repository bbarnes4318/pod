// Deterministic stand-in for api.fish.audio, used ONLY by the Playwright
// harness (E2E_TEST_MODE=1). Returns real, playable audio so the browser can
// actually play the takes. Inert in production: callers check shouldStubFish().

import { FISH_CREATE_MODEL_URL, FISH_VOICE_DESIGN_URL } from "./fishVoiceStudio";

/** A short mono 16-bit WAV: a soft tone, different per take. */
function toneWav(frequency: number, seconds = 1.2, sampleRate = 22050): Buffer {
  const samples = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const fade = Math.min(1, i / 800, (samples - i) / 800);
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 9000 * fade), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

let designCalls = 0;

export const e2eFishFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === FISH_VOICE_DESIGN_URL) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { n?: number; reference_text?: string; instruction?: string };
    designCalls++;
    const n = body.n ?? 3;
    const candidates = Array.from({ length: n }, (_, index) => ({
      id: `e2e-design-${designCalls}-${index}`,
      index,
      audio_base64: toneWav(220 + 40 * index + 15 * designCalls).toString("base64"),
      sample_rate: 22050,
      duration_ms: 1200,
      text: body.reference_text ?? null,
      instruct: body.instruction ?? null,
      language: "en",
    }));
    return new Response(JSON.stringify({ candidates }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url === FISH_CREATE_MODEL_URL) {
    const id = Array.from({ length: 32 }, (_, i) => "0123456789abcdef"[(Date.now() + i * 7) % 16]).join("");
    return new Response(JSON.stringify({ _id: id, state: "trained", title: "e2e voice" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response("not staged in the e2e Fish stub", { status: 404 });
};
