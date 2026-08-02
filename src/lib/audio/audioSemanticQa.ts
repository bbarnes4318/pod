// Transcript-, speaker- and meaning-aware audio QA. Unlike waveform QA, this
// gate listens to the rendered bytes through a configured diarizing ASR model,
// aligns anonymous speaker labels to the approved cast, and compares what was
// actually said with what was approved.

export interface ExpectedSpokenLine {
  lineIndex: number;
  speakerHostId: string;
  speakerName: string;
  text: string;
  isInterruption?: boolean;
}

export interface DiarizedSegment {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

export interface AudioSemanticQaReport {
  status: "pass" | "fail" | "not_run";
  provider: string | null;
  model: string | null;
  wordErrorRate: number | null;
  speakerAttributionErrorRate: number | null;
  criticalTokenMissRate: number | null;
  interruptionErrorRate: number | null;
  transcript: string | null;
  speakerMap: Record<string, string>;
  failures: string[];
  warnings: string[];
  segments: DiarizedSegment[];
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/\[[^\]]*\]/g, " ").match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g) || [];
}

function distance(a: string[], b: string[]): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = old;
    }
  }
  return row[b.length];
}

export function wordErrorRate(expected: string, actual: string): number {
  const e = words(expected);
  return e.length ? distance(e, words(actual)) / e.length : words(actual).length ? 1 : 0;
}

function permutations<T>(values: T[]): T[][] {
  if (values.length <= 1) return [values];
  return values.flatMap((value, i) => permutations(values.filter((_, j) => i !== j)).map((rest) => [value, ...rest]));
}

/** Map anonymous ASR labels (A/B/...) to host ids by minimizing per-speaker
 * transcript error. This works without storing biometric voice references. */
export function alignDiarizedSpeakers(expected: ExpectedSpokenLine[], actual: DiarizedSegment[]): Record<string, string> {
  const hostIds = [...new Set(expected.map((line) => line.speakerHostId))];
  const labels = [...new Set(actual.map((segment) => segment.speaker))].slice(0, hostIds.length);
  const expectedByHost = new Map(hostIds.map((hostId) => [hostId, expected.filter((l) => l.speakerHostId === hostId).map((l) => l.text).join(" ")]));
  const actualByLabel = new Map(labels.map((label) => [label, actual.filter((s) => s.speaker === label).map((s) => s.text).join(" ")]));
  let best: { score: number; map: Record<string, string> } = { score: Infinity, map: {} };
  for (const order of permutations(hostIds).slice(0, 24)) {
    const map: Record<string, string> = {};
    let score = 0;
    labels.forEach((label, i) => {
      map[label] = order[i];
      score += wordErrorRate(expectedByHost.get(order[i]) || "", actualByLabel.get(label) || "");
    });
    if (score < best.score) best = { score, map };
  }
  return best.map;
}

const STOP = new Set(["the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "is", "are", "was", "were", "it", "that", "this", "you", "i", "we", "they"]);
function criticalTokens(text: string): string[] {
  const raw = text.match(/\b\d[\d,.%:-]*\b|\b[A-Z][a-z]{2,}\b/g) || [];
  const content = words(text).filter((w) => w.length >= 7 && !STOP.has(w));
  return [...new Set([...raw.map((x) => x.toLowerCase()), ...content])];
}

export function evaluateDiarizedTranscript(expected: ExpectedSpokenLine[], segments: DiarizedSegment[], opts?: { provider?: string; model?: string }): AudioSemanticQaReport {
  const expectedText = expected.map((line) => line.text).join(" ");
  const actualText = segments.map((segment) => segment.text).join(" ");
  const speakerMap = alignDiarizedSpeakers(expected, segments);
  const wer = wordErrorRate(expectedText, actualText);
  const tokens = criticalTokens(expectedText);
  const actualWords = new Set(words(actualText));
  const missed = tokens.filter((token) => !actualWords.has(token.replace(/[,.%:]/g, "")) && !actualText.toLowerCase().includes(token));
  const criticalMiss = tokens.length ? missed.length / tokens.length : 0;

  const expectedByHost = new Map<string, string>();
  for (const line of expected) expectedByHost.set(line.speakerHostId, `${expectedByHost.get(line.speakerHostId) || ""} ${line.text}`);
  let attributionErrors = 0;
  let attributionWords = 0;
  for (const segment of segments) {
    const mapped = speakerMap[segment.speaker];
    const segmentWords = words(segment.text).length;
    attributionWords += segmentWords;
    if (!mapped) attributionErrors += segmentWords;
    else {
      const own = wordErrorRate(expectedByHost.get(mapped) || "", segment.text);
      const other = Math.min(...[...expectedByHost.entries()].filter(([id]) => id !== mapped).map(([, text]) => wordErrorRate(text, segment.text)), Infinity);
      if (other + 0.08 < own) attributionErrors += segmentWords;
    }
  }
  const speakerError = attributionWords ? attributionErrors / attributionWords : 1;

  const expectedInterruptions = expected.filter((line) => line.isInterruption).length;
  let missedInterruptions = 0;
  if (expectedInterruptions) {
    // Diarization segment overlap or a <=120ms handoff is the observable sign
    // that the authored cut-in reached the audio.
    const fastHandoffs = segments.slice(1).filter((s, i) => s.start - segments[i].end <= 0.12).length;
    missedInterruptions = Math.max(0, expectedInterruptions - fastHandoffs);
  }
  const interruptionError = expectedInterruptions ? missedInterruptions / expectedInterruptions : 0;
  const failures: string[] = [];
  const warnings: string[] = [];
  if (wer > 0.16) failures.push(`Transcript word-error rate ${(wer * 100).toFixed(1)}% exceeds 16%.`);
  else if (wer > 0.09) warnings.push(`Transcript word-error rate is ${(wer * 100).toFixed(1)}%.`);
  if (criticalMiss > 0.08) failures.push(`Missing or altered ${missed.length}/${tokens.length} critical names, numbers or meaning-bearing words.`);
  if (speakerError > 0.08) failures.push(`Speaker-attribution error rate ${(speakerError * 100).toFixed(1)}% exceeds 8%.`);
  if (interruptionError > 0.5) warnings.push(`${missedInterruptions}/${expectedInterruptions} authored interruptions were not audible as tight handoffs.`);
  return {
    status: failures.length ? "fail" : "pass",
    provider: opts?.provider || null,
    model: opts?.model || null,
    wordErrorRate: wer,
    speakerAttributionErrorRate: speakerError,
    criticalTokenMissRate: criticalMiss,
    interruptionErrorRate: interruptionError,
    transcript: actualText,
    speakerMap,
    failures,
    warnings,
    segments,
  };
}

async function transcribeOpenAi(audio: Buffer, mimeType: string): Promise<{ model: string; segments: DiarizedSegment[] }> {
  const apiKey = (process.env.TRANSCRIPT_QA_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing for transcript QA.");
  const model = (process.env.TRANSCRIPT_QA_MODEL || "gpt-4o-transcribe-diarize").trim();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), mimeType.includes("wav") ? "scene.wav" : "scene.mp3");
  form.append("model", model);
  form.append("response_format", "diarized_json");
  form.append("chunking_strategy", "auto");
  form.append("language", "en");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Transcript QA API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json() as { segments?: Array<{ speaker?: string; text?: string; start?: number; end?: number }> };
  const segments = (body.segments || []).map((segment) => ({
    speaker: String(segment.speaker || "unknown"),
    text: String(segment.text || "").trim(),
    start: Number(segment.start) || 0,
    end: Number(segment.end) || 0,
  })).filter((segment) => segment.text);
  if (!segments.length) throw new Error("Transcript QA returned no diarized segments.");
  return { model, segments };
}

/**
 * Which semantic-QA settings are missing, by NAME only — never a value.
 *
 * Production episode e7867729 reported `TTS_TRANSCRIPT_QA_ENABLED=false` and
 * published anyway: `not_run` was an accepted outcome all the way to the
 * master. Meaning-aware QA is the only check that can catch a wrong speaker, a
 * dropped line, or a hallucinated number, so in production its absence must
 * stop the episode rather than annotate it.
 */
export function resolveSemanticQaRequirement(env: NodeJS.ProcessEnv = process.env): {
  required: boolean;
  enabled: boolean;
  missing: string[];
  provider: string;
} {
  const enabled = env.TTS_TRANSCRIPT_QA_ENABLED === "true";
  // Required in production unless an operator recorded a deliberate waiver. The
  // waiver is its own named variable so it appears in an env audit instead of
  // hiding inside a general "strict" toggle.
  const required = env.NODE_ENV === "production" && env.TTS_TRANSCRIPT_QA_WAIVED !== "true";
  const provider = (env.TRANSCRIPT_QA_PROVIDER || "openai").trim().toLowerCase();

  const missing: string[] = [];
  if (!enabled) missing.push("TTS_TRANSCRIPT_QA_ENABLED");
  if (provider === "openai" && !(env.TRANSCRIPT_QA_OPENAI_API_KEY || env.OPENAI_API_KEY || "").trim()) {
    missing.push("TRANSCRIPT_QA_OPENAI_API_KEY (or OPENAI_API_KEY)");
  }
  return { required, enabled, missing, provider };
}

export class SemanticQaUnavailableError extends Error {
  readonly code = "SEMANTIC_QA_UNAVAILABLE";
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Meaning-aware audio QA cannot run and this is production. Missing configuration: ${missing.join(", ")}. ` +
        `Configure a transcription provider, or record a deliberate waiver via TTS_TRANSCRIPT_QA_WAIVED=true. ` +
        `Nothing else verifies speaker attribution, names, or numbers.`
    );
    this.name = "SemanticQaUnavailableError";
    this.missing = missing;
  }
}

export async function runAudioSemanticQa(input: { audio: Buffer; mimeType: string; expected: ExpectedSpokenLine[] }): Promise<AudioSemanticQaReport> {
  const requirement = resolveSemanticQaRequirement();
  if (!requirement.enabled) {
    // FAIL CLOSED in production. Elsewhere, report not_run exactly as before so
    // local and CI work are unaffected.
    if (requirement.required) throw new SemanticQaUnavailableError(requirement.missing);
    return { status: "not_run", provider: null, model: null, wordErrorRate: null, speakerAttributionErrorRate: null, criticalTokenMissRate: null, interruptionErrorRate: null, transcript: null, speakerMap: {}, failures: [], warnings: ["TTS_TRANSCRIPT_QA_ENABLED is not true."], segments: [] };
  }
  if (requirement.required && requirement.missing.length) {
    throw new SemanticQaUnavailableError(requirement.missing);
  }
  const provider = requirement.provider;
  if (provider !== "openai") throw new Error(`Unsupported TRANSCRIPT_QA_PROVIDER '${provider}'.`);
  const transcribed = await transcribeOpenAi(input.audio, input.mimeType);
  return evaluateDiarizedTranscript(input.expected, transcribed.segments, { provider, model: transcribed.model });
}
