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
  /** Authored speaker sequence vs rendered speaker sequence. */
  lineOrderErrorRate?: number | null;
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

// --- Numeric normalization --------------------------------------------------
//
// A script says "eleven pitchers" and "two thousand twelve"; a diarizing ASR
// with smart formatting returns "11 pitchers" and "2012". Those are the SAME
// number, but a purely orthographic comparison scores them as missing critical
// figures — which, with semantic QA failing closed, would block every episode on
// a difference that does not exist.
//
// Both sides are therefore normalized to digits before comparison. This makes
// the check MORE accurate, not more permissive: a genuinely wrong number, or a
// dropped name like "Cease", still fails.
const SMALL_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const MULTIPLIERS: Record<string, number> = { hundred: 100, thousand: 1000, million: 1000000 };

/** Rewrites spelled-out cardinals in a token stream into digit strings. */
export function normalizeNumberWords(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!(t in SMALL_NUMBERS) && !(t in MULTIPLIERS)) {
      out.push(t);
      i += 1;
      continue;
    }
    // Consume the longest run of number words and evaluate it as one value.
    let total = 0;
    let current = 0;
    let consumed = 0;
    let j = i;
    while (j < tokens.length) {
      const w = tokens[j];
      if (w in SMALL_NUMBERS) {
        current += SMALL_NUMBERS[w];
      } else if (w in MULTIPLIERS) {
        const m = MULTIPLIERS[w];
        if (m === 100) current = (current || 1) * 100;
        else {
          total += (current || 1) * m;
          current = 0;
        }
      } else if (w === "and" && consumed > 0 && j + 1 < tokens.length && tokens[j + 1] in SMALL_NUMBERS) {
        // "two thousand and twelve" — keep going.
      } else {
        break;
      }
      consumed += 1;
      j += 1;
    }
    out.push(String(total + current));
    i += consumed;
  }
  return out;
}

/** Token stream with numbers reduced to a canonical digit form. */
function normalizedWords(text: string): string[] {
  return normalizeNumberWords(words(text)).map((w) => w.replace(/[,]/g, ""));
}

export function wordErrorRate(expected: string, actual: string): number {
  // Numbers are compared by VALUE, not spelling — see normalizeNumberWords.
  // Otherwise a correctly-spoken "eleven" transcribed as "11" counts as two
  // word errors (a deletion and an insertion) and inflates WER on every episode.
  const e = normalizeNumberWords(words(expected));
  const a = normalizeNumberWords(words(actual));
  return e.length ? distance(e, a) / e.length : a.length ? 1 : 0;
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

/**
 * Proper nouns, meaning capitalized words that are NOT sentence-initial.
 *
 * Sentence-initial capitals are excluded deliberately: "Eleven pitchers…" and
 * "The league…" are capitalized by position, not because they name anybody, and
 * treating them as names would fail episodes over ordinary words.
 */
export function properNouns(text: string): string[] {
  const out: string[] = [];
  // Split into sentences, then skip each sentence's first token.
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const tokens = sentence.trim().split(/\s+/);
    for (let i = 1; i < tokens.length; i++) {
      const bare = tokens[i].replace(/[^A-Za-z'-]/g, "");
      if (/^[A-Z][a-z]{2,}$/.test(bare)) out.push(bare.toLowerCase());
    }
  }
  return [...new Set(out)];
}

function criticalTokens(text: string): string[] {
  // Capitalized words and digit groups are the meaning-bearing tokens: proper
  // names and figures. A sentence-initial number word ("Eleven pitchers…") is
  // captured by the capitalized branch, so it must be normalized too — otherwise
  // the literal token "eleven" is compared against a transcript containing "11"
  // and reported as a missing figure.
  const raw = (text.match(/\b\d[\d,.%:-]*\b|\b[A-Z][a-z]{2,}\b/g) || []).map((x) => {
    const lowered = x.toLowerCase().replace(/[,]/g, "");
    return normalizeNumberWords([lowered])[0] ?? lowered;
  });
  const normalized = normalizedWords(text);
  // Any figure, however it was written, is critical.
  const numeric = normalized.filter((w) => /^\d+$/.test(w));
  const content = normalized.filter((w) => w.length >= 7 && !STOP.has(w));
  return [...new Set([...raw, ...numeric, ...content])];
}

export function evaluateDiarizedTranscript(expected: ExpectedSpokenLine[], segments: DiarizedSegment[], opts?: { provider?: string; model?: string }): AudioSemanticQaReport {
  const expectedText = expected.map((line) => line.text).join(" ");
  const actualText = segments.map((segment) => segment.text).join(" ");
  const speakerMap = alignDiarizedSpeakers(expected, segments);
  const wer = wordErrorRate(expectedText, actualText);
  const tokens = criticalTokens(expectedText);
  // Compare against the NORMALIZED actual stream too, so "eleven" matches "11".
  const actualNormalized = normalizedWords(actualText);
  const actualWords = new Set([...words(actualText), ...actualNormalized]);
  const actualJoined = `${actualText.toLowerCase()} ${actualNormalized.join(" ")}`;
  const missed = tokens.filter(
    (token) => !actualWords.has(token.replace(/[,.%:]/g, "")) && !actualJoined.includes(token)
  );
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
  // --- line order -----------------------------------------------------------
  // Speaker attribution alone does not prove the episode plays in the authored
  // ORDER. A stitch that emits scene 3 before scene 2, or a re-splice that drops
  // a line, can leave per-speaker text almost unchanged while the argument
  // stops making sense. Compare the authored speaker sequence against the
  // rendered one, collapsing consecutive same-speaker runs so ordinary
  // diarization segmentation is not counted as a fault.
  const collapse = (seq: string[]) => seq.filter((s, i) => i === 0 || s !== seq[i - 1]);
  const expectedOrder = collapse(expected.map((l) => l.speakerHostId));
  const actualOrder = collapse(
    segments.map((s) => speakerMap[s.speaker]).filter((x): x is string => Boolean(x))
  );
  const orderDistance = distance(expectedOrder, actualOrder);
  const lineOrderErrorRate = expectedOrder.length ? orderDistance / expectedOrder.length : 0;

  const failures: string[] = [];
  const warnings: string[] = [];
  if (wer > 0.16) failures.push(`Transcript word-error rate ${(wer * 100).toFixed(1)}% exceeds 16%.`);
  else if (wer > 0.09) warnings.push(`Transcript word-error rate is ${(wer * 100).toFixed(1)}%.`);
  if (criticalMiss > 0.08) failures.push(`Missing or altered ${missed.length}/${tokens.length} critical names, numbers or meaning-bearing words.`);
  // A FIGURE is a fact, not a rate. One wrong number in a long episode barely
  // moves the aggregate miss rate, but it is exactly the error that makes an
  // episode wrong out loud — so any missing numeric token fails on its own.
  const missedNumeric = missed.filter((t) => /^\d+$/.test(t));
  if (missedNumeric.length) {
    failures.push(`Figure(s) not present in the rendered audio: ${missedNumeric.join(", ")}.`);
  }
  // A NAME is a fact for the same reason. Live Deepgram returned "Dylan Cee"
  // for "Dylan Cease": one token in a long episode, far below any aggregate
  // threshold, and a listener hears the surname wrong.
  const expectedNames = new Set(properNouns(expectedText));
  const missedNames = missed.filter((t) => expectedNames.has(t));
  if (missedNames.length) {
    failures.push(`Name(s) not present in the rendered audio: ${missedNames.join(", ")}.`);
  }
  if (speakerError > 0.08) failures.push(`Speaker-attribution error rate ${(speakerError * 100).toFixed(1)}% exceeds 8%.`);
  if (lineOrderErrorRate > 0.12) failures.push(`Rendered speaker order differs from the authored order (${(lineOrderErrorRate * 100).toFixed(1)}% edit distance).`);
  if (interruptionError > 0.5) warnings.push(`${missedInterruptions}/${expectedInterruptions} authored interruptions were not audible as tight handoffs.`);
  return {
    status: failures.length ? "fail" : "pass",
    provider: opts?.provider || null,
    model: opts?.model || null,
    wordErrorRate: wer,
    speakerAttributionErrorRate: speakerError,
    criticalTokenMissRate: criticalMiss,
    interruptionErrorRate: interruptionError,
    lineOrderErrorRate,
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
export const SEMANTIC_QA_PROVIDERS = ["openai", "deepgram"] as const;
export type SemanticQaProvider = (typeof SEMANTIC_QA_PROVIDERS)[number];

export function resolveSemanticQaRequirement(env: NodeJS.ProcessEnv = process.env): {
  required: boolean;
  enabled: boolean;
  missing: string[];
  provider: string;
  providerSupported: boolean;
} {
  const enabled = env.TTS_TRANSCRIPT_QA_ENABLED === "true";
  // Required in production unless an operator recorded a deliberate waiver. The
  // waiver is its own named variable so it appears in an env audit instead of
  // hiding inside a general "strict" toggle.
  const required = env.NODE_ENV === "production" && env.TTS_TRANSCRIPT_QA_WAIVED !== "true";
  const provider = (env.TRANSCRIPT_QA_PROVIDER || "openai").trim().toLowerCase();
  const providerSupported = (SEMANTIC_QA_PROVIDERS as readonly string[]).includes(provider);

  const missing: string[] = [];
  if (!enabled) missing.push("TTS_TRANSCRIPT_QA_ENABLED");
  if (provider === "openai" && !(env.TRANSCRIPT_QA_OPENAI_API_KEY || env.OPENAI_API_KEY || "").trim()) {
    missing.push("TRANSCRIPT_QA_OPENAI_API_KEY (or OPENAI_API_KEY)");
  }
  if (provider === "deepgram" && !(env.TRANSCRIPT_QA_DEEPGRAM_API_KEY || env.DEEPGRAM_API_KEY || "").trim()) {
    missing.push("TRANSCRIPT_QA_DEEPGRAM_API_KEY (or DEEPGRAM_API_KEY)");
  }
  if (!providerSupported) missing.push(`TRANSCRIPT_QA_PROVIDER (unsupported value; expected one of ${SEMANTIC_QA_PROVIDERS.join(", ")})`);
  return { required, enabled, missing, provider, providerSupported };
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

/**
 * Deepgram diarized transcription.
 *
 * This exists because the OpenAI backend was the ONLY implementation, and this
 * deployment has no funded OpenAI account — meaning meaning-aware QA could never
 * actually run, only fail closed. Production already carries a DEEPGRAM_API_KEY,
 * and Deepgram diarizes natively, so this is the path that lets the gate do its
 * job instead of merely blocking.
 *
 * Deepgram returns word-level objects carrying a `speaker` integer when
 * `diarize=true`. Words are folded into contiguous same-speaker runs so the
 * output matches the DiarizedSegment shape the rest of this module expects.
 */
async function transcribeDeepgram(audio: Buffer, mimeType: string): Promise<{ model: string; segments: DiarizedSegment[] }> {
  const apiKey = (process.env.TRANSCRIPT_QA_DEEPGRAM_API_KEY || process.env.DEEPGRAM_API_KEY || "").trim();
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY is missing for transcript QA.");
  const model = (process.env.TRANSCRIPT_QA_MODEL || process.env.DEEPGRAM_MODEL || "nova-2").trim();
  const params = new URLSearchParams({
    model,
    diarize: "true",
    punctuate: "true",
    smart_format: "true",
    language: "en",
  });
  const response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": mimeType },
    body: new Uint8Array(audio),
  });
  if (!response.ok) {
    throw new Error(`Transcript QA API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as {
    results?: {
      channels?: Array<{
        alternatives?: Array<{
          words?: Array<{ word?: string; punctuated_word?: string; speaker?: number; start?: number; end?: number }>;
        }>;
      }>;
    };
  };
  const wordList = body.results?.channels?.[0]?.alternatives?.[0]?.words || [];
  if (!wordList.length) throw new Error("Transcript QA returned no diarized segments.");

  const segments: DiarizedSegment[] = [];
  for (const w of wordList) {
    const token = String(w.punctuated_word || w.word || "").trim();
    if (!token) continue;
    const speaker = `speaker_${Number.isFinite(w.speaker) ? w.speaker : 0}`;
    const start = Number(w.start) || 0;
    const end = Number(w.end) || start;
    const last = segments[segments.length - 1];
    if (last && last.speaker === speaker) {
      last.text = `${last.text} ${token}`.trim();
      last.end = end;
    } else {
      segments.push({ speaker, text: token, start, end });
    }
  }
  if (!segments.length) throw new Error("Transcript QA returned no diarized segments.");
  return { model, segments };
}

export async function runAudioSemanticQa(input: { audio: Buffer; mimeType: string; expected: ExpectedSpokenLine[] }): Promise<AudioSemanticQaReport> {
  const requirement = resolveSemanticQaRequirement();
  if (!requirement.enabled) {
    // FAIL CLOSED in production. Elsewhere, report not_run exactly as before so
    // local and CI work are unaffected.
    if (requirement.required) throw new SemanticQaUnavailableError(requirement.missing);
    return { status: "not_run", provider: null, model: null, wordErrorRate: null, speakerAttributionErrorRate: null, criticalTokenMissRate: null, interruptionErrorRate: null, lineOrderErrorRate: null, transcript: null, speakerMap: {}, failures: [], warnings: ["TTS_TRANSCRIPT_QA_ENABLED is not true."], segments: [] };
  }
  if (requirement.required && requirement.missing.length) {
    throw new SemanticQaUnavailableError(requirement.missing);
  }
  const provider = requirement.provider;
  if (!requirement.providerSupported) {
    throw new Error(`Unsupported TRANSCRIPT_QA_PROVIDER '${provider}'. Expected one of ${SEMANTIC_QA_PROVIDERS.join(", ")}.`);
  }
  const transcribed =
    provider === "deepgram"
      ? await transcribeDeepgram(input.audio, input.mimeType)
      : await transcribeOpenAi(input.audio, input.mimeType);
  return evaluateDiarizedTranscript(input.expected, transcribed.segments, { provider, model: transcribed.model });
}
