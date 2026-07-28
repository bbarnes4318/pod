import { getFishApiKey } from "../../env";

const FISH_API_BASE = "https://api.fish.audio";
export const FISH_VOICE_DESIGN_URL = `${FISH_API_BASE}/v1/voice-design`;
export const FISH_CREATE_MODEL_URL = `${FISH_API_BASE}/model`;
export const MAX_VOICE_SAMPLE_BYTES = 15 * 1024 * 1024;
export const MAX_VOICE_SAMPLE_COUNT = 3;

export interface FishVoiceDesignInput {
  instruction: string;
  referenceText?: string;
  language?: string;
  candidateCount?: number;
  speed?: number;
  seed?: number;
}

export interface FishVoiceDesignCandidate {
  id: string;
  index: number;
  audioBase64: string;
  sampleRate: number;
  durationMs: number;
  text?: string | null;
  instruction?: string | null;
  language?: string | null;
}

export interface FishVoiceSample {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  transcript?: string;
}

export interface FishCreatedVoice {
  id: string;
  state: string;
  title: string;
}

function boundedText(value: unknown, label: string, min: number, max: number): string {
  const text = String(value ?? "").trim();
  if (text.length < min || text.length > max) {
    throw new Error(`${label} must be between ${min} and ${max} characters.`);
  }
  return text;
}

function fishKey(): string {
  const apiKey = getFishApiKey();
  if (!apiKey) throw new Error("Voice creation is unavailable because FISH_API_KEY is not configured on the web app.");
  return apiKey;
}

async function fishError(response: Response, action: string): Promise<Error> {
  const text = (await response.text().catch(() => "")).slice(0, 500);
  if (response.status === 401 || response.status === 403) return new Error(`${action} failed because the Fish API key was rejected.`);
  if (response.status === 402) return new Error(`${action} failed because the Fish account has insufficient API credit.`);
  if (response.status === 429) return new Error(`${action} is temporarily rate limited. Try again in a moment.`);
  return new Error(`${action} failed (${response.status})${text ? `: ${text}` : "."}`);
}

export function buildFishVoiceDesignBody(input: FishVoiceDesignInput) {
  const instruction = boundedText(input.instruction, "Voice description", 1, 2000);
  const referenceText = input.referenceText?.trim();
  if (referenceText && referenceText.length > 150) throw new Error("Preview text must be 150 characters or fewer.");
  return {
    instruction,
    reference_text: referenceText || null,
    language: input.language?.trim() || "en",
    n: Math.max(1, Math.min(4, Math.round(input.candidateCount ?? 3))),
    speed: Math.max(0.5, Math.min(2, Number(input.speed ?? 1))),
    num_step: 32,
    guidance_scale: 2,
    instruct_guidance_scale: 0,
    seed: Number.isInteger(input.seed) ? input.seed : null,
  };
}

export async function designFishVoice(
  input: FishVoiceDesignInput,
  fetchImpl: typeof fetch = fetch
): Promise<FishVoiceDesignCandidate[]> {
  const response = await fetchImpl(FISH_VOICE_DESIGN_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fishKey()}`,
      "Content-Type": "application/json",
      model: "voice-design-1",
    },
    body: JSON.stringify(buildFishVoiceDesignBody(input)),
  });
  if (!response.ok) throw await fishError(response, "Voice design");
  const json = await response.json() as { candidates?: Array<Record<string, unknown>> };
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const parsed = candidates.map((candidate, index) => ({
    id: String(candidate.id ?? `candidate-${index}`),
    index: Number(candidate.index ?? index),
    audioBase64: String(candidate.audio_base64 ?? ""),
    sampleRate: Number(candidate.sample_rate ?? 44100),
    durationMs: Number(candidate.duration_ms ?? 0),
    text: candidate.text == null ? null : String(candidate.text),
    instruction: candidate.instruct == null ? null : String(candidate.instruct),
    language: candidate.language == null ? null : String(candidate.language),
  })).filter((candidate) => candidate.audioBase64.length > 0);
  if (parsed.length === 0) throw new Error("Fish returned no playable voice candidates.");
  return parsed;
}

export function validateVoiceSamples(samples: FishVoiceSample[]): FishVoiceSample[] {
  if (samples.length < 1 || samples.length > MAX_VOICE_SAMPLE_COUNT) {
    throw new Error(`Add between 1 and ${MAX_VOICE_SAMPLE_COUNT} voice recordings.`);
  }
  let total = 0;
  for (const sample of samples) {
    if (!sample.bytes?.byteLength) throw new Error("One of the voice recordings is empty.");
    if (sample.bytes.byteLength > MAX_VOICE_SAMPLE_BYTES) throw new Error(`Each voice recording must be smaller than ${MAX_VOICE_SAMPLE_BYTES / 1024 / 1024} MB.`);
    if (!/^audio\//i.test(sample.contentType || "")) throw new Error("Voice recordings must be audio files.");
    total += sample.bytes.byteLength;
  }
  if (total > 35 * 1024 * 1024) throw new Error("The combined voice recordings are too large. Keep the total below 35 MB.");
  return samples;
}

export async function createFishVoiceModel(
  input: {
    title: string;
    description?: string;
    samples: FishVoiceSample[];
    sourceTag: "voice-design" | "authorized-clone";
  },
  fetchImpl: typeof fetch = fetch
): Promise<FishCreatedVoice> {
  const title = boundedText(input.title, "Voice name", 1, 120);
  const samples = validateVoiceSamples(input.samples);
  const form = new FormData();
  form.append("type", "tts");
  form.append("title", title);
  form.append("train_mode", "fast");
  form.append("visibility", "private");
  form.append("description", (input.description || "Private host voice created in Host Studio").slice(0, 1000));
  form.append("enhance_audio_quality", "true");
  form.append("generate_sample", "false");
  form.append("tags", "host-studio");
  form.append("tags", input.sourceTag);
  for (const sample of samples) {
    const bytes = Uint8Array.from(sample.bytes);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const blob = new Blob([buffer], { type: sample.contentType || "audio/wav" });
    form.append("voices", blob, sample.filename || "voice-sample.wav");
    if (sample.transcript?.trim()) form.append("texts", sample.transcript.trim());
  }

  const response = await fetchImpl(FISH_CREATE_MODEL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${fishKey()}` },
    body: form,
  });
  if (!response.ok) throw await fishError(response, "Voice creation");
  const json = await response.json() as { _id?: string; state?: string; title?: string };
  const id = String(json._id ?? "");
  if (!/^[0-9a-f]{32}$/i.test(id)) throw new Error("Fish created the voice but did not return a valid voice ID.");
  return { id, state: String(json.state ?? "created"), title: String(json.title ?? title) };
}

export function decodeBase64Audio(base64: string): Uint8Array {
  const clean = base64.replace(/^data:[^;]+;base64,/, "").trim();
  if (!clean || clean.length > 24 * 1024 * 1024) throw new Error("The selected voice preview is missing or too large.");
  return new Uint8Array(Buffer.from(clean, "base64"));
}
