// Shared helpers for handling spoken-dialogue text that may contain inline
// audio delivery tags like [laughs] or [sighs] (ElevenLabs v3 style).
//
// The `text` field of a script line is allowed to contain these tags so the
// TTS layer can render non-verbal vocalizations. Everything that treats the
// text as *content* (transcripts, fact-checking, RSS show notes) must strip
// them first via stripAudioTags().

// Conversational tags we allow the script LLM to emit. Anything else in
// square brackets (e.g. sound effects like [explosion]) is removed so a
// hallucinated tag can never reach a TTS engine or a transcript.
export const ALLOWED_AUDIO_TAGS = [
  "laughs",
  "laughs hard",
  "laughs softly",
  "chuckles",
  "sighs",
  "exhales",
  "inhales",
  "whispers",
  "excited",
  "sarcastic",
  "frustrated",
  "curious",
  "deadpan",
  "hesitates",
  "pause",
  "clears throat",
  "scoffs",
  "groans",
  "gasps",
  "stammers",
  "interrupting",
] as const;

const TAG_PATTERN = /\[([^\[\]]{1,40})\]/g;

const ALLOWED_TAG_SET = new Set<string>(ALLOWED_AUDIO_TAGS.map((t) => t.toLowerCase()));

/** Remove ALL bracketed audio tags — for transcripts, fact-checks, display text. */
export function stripAudioTags(text: string): string {
  return text.replace(TAG_PATTERN, " ").replace(/\s+/g, " ").trim();
}

/** Keep only whitelisted conversational tags; strip anything unrecognized. */
export function sanitizeAudioTags(text: string): string {
  return text
    .replace(TAG_PATTERN, (match, inner: string) => {
      const normalized = inner.trim().toLowerCase();
      return ALLOWED_TAG_SET.has(normalized) ? `[${normalized}]` : " ";
    })
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** True if the text still contains any bracketed tag after sanitizing. */
export function hasAudioTags(text: string): boolean {
  TAG_PATTERN.lastIndex = 0;
  return TAG_PATTERN.test(text);
}

export type LineEnergy = "low" | "medium" | "high";
export type LinePause = "none" | "beat" | "breath" | "long";

/** Delivery metadata carried on each script line (all optional, defaulted). */
export interface LineDelivery {
  energy: LineEnergy;
  pauseBefore: LinePause;
  isInterruption: boolean;
}

export function normalizeDelivery(line: {
  energy?: unknown;
  pauseBefore?: unknown;
  isInterruption?: unknown;
}): LineDelivery {
  const energy: LineEnergy =
    line.energy === "low" || line.energy === "high" ? line.energy : "medium";
  const pauseBefore: LinePause =
    line.pauseBefore === "none" ||
    line.pauseBefore === "breath" ||
    line.pauseBefore === "long"
      ? line.pauseBefore
      : "beat";
  return {
    energy,
    pauseBefore,
    isInterruption: line.isInterruption === true,
  };
}
