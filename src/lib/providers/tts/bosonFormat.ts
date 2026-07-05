// Boson inline-tag formatting layer.
//
// Boson's Higgs TTS steers delivery with inline control tokens:
//   <|emotion:X|>  <|style:X|>  <|sfx:X|>  <|prosody:X|>
//
// Placement rules implemented here (per Boson docs):
//   - Delivery tokens (emotion, style, speed/pitch/expressiveness prosody)
//     set the WHOLE turn and must LEAD the line, before any text. They stack.
//   - <|prosody:pause|> / <|prosody:long_pause|> are positional and go inline
//     exactly where the break falls.
//   - Every <|sfx:X|> must be immediately followed by matching onomatopoeia
//     ("<|sfx:laughter|>Haha," "<|sfx:sigh|>Ahh,"). Never a bare sfx token.
//
// This module is ONLY invoked by the Boson provider. Other TTS providers
// receive the untouched script text, so no Boson tokens can leak to them.
//
// Signal source: the script generator already emits per-line delivery
// metadata (tone, energy, isInterruption, pauseBefore) plus whitelisted
// inline audio tags like [laughs] — see speechText.ALLOWED_AUDIO_TAGS. The
// mapping tables below translate that vocabulary to Boson's.
//
// NOTE on pauseBefore: inter-line gaps ("beat"/"breath"/"long") are rendered
// by the assembly timeline as real silence between clips. We intentionally do
// NOT also emit a leading pause token for them — that would double the gap.
// Only INLINE pause markers ([pause], [hesitates], [stammers]) become
// <|prosody:pause|> tokens.

export interface BosonLineInput {
  /** Script line text; may contain whitelisted [tags] like [laughs]. */
  text: string;
  /** Script tone label (heated, sarcastic, analytical, ...). */
  tone?: string;
  /** Vocal intensity for this line. */
  energy?: "low" | "medium" | "high";
  /** True when this line cuts the previous speaker off. */
  isInterruption?: boolean;
}

// ---------------------------------------------------------------------------
// Vocabulary (exactly the sets Boson accepts — used for validation too)
// ---------------------------------------------------------------------------

export const BOSON_EMOTIONS = [
  "elation", "amusement", "enthusiasm", "determination", "pride",
  "contentment", "affection", "relief", "contemplation", "confusion",
  "surprise", "awe", "longing", "arousal", "anger", "fear", "disgust",
  "bitterness", "sadness", "shame", "helplessness",
] as const;

export const BOSON_STYLES = ["singing", "shouting", "whispering"] as const;

export const BOSON_SFX = [
  "cough", "laughter", "crying", "screaming", "burping", "humming",
  "sigh", "sniff", "sneeze",
] as const;

export const BOSON_PROSODY = [
  "speed_very_slow", "speed_slow", "speed_fast", "speed_very_fast",
  "pitch_low", "pitch_high", "pause", "long_pause",
  "expressive_high", "expressive_low",
] as const;

// ---------------------------------------------------------------------------
// Mapping tables — script vocabulary → Boson vocabulary
// ---------------------------------------------------------------------------

/**
 * Script tone → Boson emotion. Sports-debate register: heated/mocking/
 * stunned/hyped dominate, so those map to strong hues. `null` = no emotion
 * token (neutral connective lines sound better unforced).
 */
export const TONE_TO_EMOTION: Record<string, (typeof BOSON_EMOTIONS)[number] | null> = {
  heated: "anger",
  excited: "enthusiasm",
  sarcastic: "amusement",   // mocking, not literal joy
  amused: "amusement",
  dismissive: "bitterness", // curt, scoffing
  incredulous: "surprise",
  analytical: "contemplation",
  reflective: "contemplation",
  conceding: "relief",      // "fine — you got me"
  setup: "determination",   // driving the show forward
  transition: null,         // neutral connective tissue
};

/** Extra turn-level prosody a tone implies (beyond energy). */
export const TONE_TO_PROSODY: Record<string, (typeof BOSON_PROSODY)[number] | null> = {
  heated: "expressive_high",
  excited: "expressive_high",
  incredulous: "expressive_high",
  reflective: "speed_slow",
  sarcastic: null,
  amused: null,
  dismissive: null,
  analytical: null,
  conceding: null,
  setup: null,
  transition: null,
};

/**
 * Inline [tag] → Boson conversion. Three shapes:
 *   sfx:   replace tag with "<|sfx:X|>Onomatopoeia," at the same spot
 *   hoist: remove tag from text; contribute a turn-level lead token
 *   pause: replace tag with a positional pause token
 *   drop:  no faithful Boson equivalent — remove (never emit a bare sfx)
 */
export const TAG_RULES: Record<
  string,
  | { kind: "sfx"; token: (typeof BOSON_SFX)[number]; cue: string }
  | { kind: "hoist"; emotion?: (typeof BOSON_EMOTIONS)[number]; style?: (typeof BOSON_STYLES)[number]; prosody?: (typeof BOSON_PROSODY)[number] }
  | { kind: "pause" }
  | { kind: "drop" }
> = {
  "laughs":        { kind: "sfx", token: "laughter", cue: "Haha," },
  "laughs hard":   { kind: "sfx", token: "laughter", cue: "Hahaha!" },
  "laughs softly": { kind: "sfx", token: "laughter", cue: "Heh heh," },
  "chuckles":      { kind: "sfx", token: "laughter", cue: "Heh," },
  "sighs":         { kind: "sfx", token: "sigh", cue: "Ahh," },
  "exhales":       { kind: "sfx", token: "sigh", cue: "Hahh," },
  "groans":        { kind: "sfx", token: "sigh", cue: "Ugh," },
  "clears throat": { kind: "sfx", token: "cough", cue: "Ahem," },
  "whispers":      { kind: "hoist", style: "whispering" },
  "excited":       { kind: "hoist", emotion: "enthusiasm" },
  "sarcastic":     { kind: "hoist", emotion: "amusement" },
  "frustrated":    { kind: "hoist", emotion: "anger" },
  "curious":       { kind: "hoist", emotion: "contemplation" },
  "scoffs":        { kind: "hoist", emotion: "disgust" }, // no scoff sfx exists
  "gasps":         { kind: "hoist", emotion: "surprise" }, // no gasp sfx exists
  "deadpan":       { kind: "hoist", prosody: "expressive_low" },
  "interrupting":  { kind: "hoist", prosody: "speed_fast" },
  "hesitates":     { kind: "pause" },
  "pause":         { kind: "pause" },
  "stammers":      { kind: "pause" },
  "inhales":       { kind: "drop" }, // no matching sfx + cue pair
};

const TAG_PATTERN = /\[([^\[\]]{1,40})\]/g;
const BOSON_TOKEN_PATTERN = /<\|(emotion|style|sfx|prosody):([a-z_]+)\|>/g;

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/**
 * Produce Boson-tagged text for one script line.
 *
 * Output shape: `<lead delivery tokens><text with inline pause/sfx tokens>`
 * e.g. `<|emotion:anger|><|prosody:expressive_high|>How dare you put that
 * stat on my screen. <|prosody:pause|> Run it again.`
 */
export function formatLineForBoson(line: BosonLineInput): string {
  const raw = (line.text || "").trim();
  if (!raw) return "";

  // Idempotence: if the text already carries Boson tokens, trust it as-is.
  BOSON_TOKEN_PATTERN.lastIndex = 0;
  if (BOSON_TOKEN_PATTERN.test(raw)) return raw;

  // Turn-level delivery state (filled by tone/energy tables + hoisted tags).
  let emotion = TONE_TO_EMOTION[line.tone || ""] ?? null;
  let style: (typeof BOSON_STYLES)[number] | null = null;
  let expressiveness: "expressive_high" | "expressive_low" | null =
    (TONE_TO_PROSODY[line.tone || ""] === "expressive_high" ? "expressive_high" : null);
  let speed: "speed_slow" | "speed_fast" | null =
    (TONE_TO_PROSODY[line.tone || ""] === "speed_slow" ? "speed_slow" : null);

  // 1. Convert inline [tags]; hoisted tags override the tone-derived state
  //    (an explicit [frustrated] beats a generic tone label).
  let text = raw.replace(TAG_PATTERN, (_match, inner: string) => {
    const rule = TAG_RULES[inner.trim().toLowerCase()];
    if (!rule) return " "; // unknown tag — strip, never guess a token
    switch (rule.kind) {
      case "sfx":
        return ` <|sfx:${rule.token}|>${rule.cue} `;
      case "hoist":
        if (rule.emotion) emotion = rule.emotion;
        if (rule.style) style = rule.style;
        if (rule.prosody === "expressive_low") expressiveness = "expressive_low";
        if (rule.prosody === "speed_fast") speed = "speed_fast";
        return " ";
      case "pause":
        return " [[BOSON_PAUSE]] ";
      case "drop":
        return " ";
    }
  });

  // 2. Energy → expressiveness (tone-level signal wins over the blunter
  //    energy field; deadpan hoist wins over everything).
  if (!expressiveness) {
    if (line.energy === "high") expressiveness = "expressive_high";
    else if (line.energy === "low") expressiveness = "expressive_low";
  }

  // 3. Interruptions come in hot.
  if (line.isInterruption) speed = "speed_fast";

  // 4. Positional pauses: a pause marker right after sentence-ending
  //    punctuation is a dramatic beat → long_pause; mid-sentence → pause.
  text = text
    .replace(/([.!?…]["”)]?)\s*\[\[BOSON_PAUSE\]\]/g, "$1 <|prosody:long_pause|>")
    .replace(/\[\[BOSON_PAUSE\]\]/g, "<|prosody:pause|>");

  // 5. Assemble lead tokens: emotion, then style, then prosody. Cap at 3 so
  //    lines never open with token soup.
  const lead: string[] = [];
  if (emotion) lead.push(`<|emotion:${emotion}|>`);
  if (style) lead.push(`<|style:${style}|>`);
  if (expressiveness && lead.length < 3) lead.push(`<|prosody:${expressiveness}|>`);
  if (speed && lead.length < 3) lead.push(`<|prosody:${speed}|>`);

  const body = text.replace(/\s+/g, " ").trim();
  return `${lead.join("")}${body}`;
}

/** All Boson tokens present in a string (for validation/tests). */
export function extractBosonTokens(text: string): Array<{ category: string; value: string }> {
  const out: Array<{ category: string; value: string }> = [];
  let m: RegExpExecArray | null;
  BOSON_TOKEN_PATTERN.lastIndex = 0;
  while ((m = BOSON_TOKEN_PATTERN.exec(text)) !== null) {
    out.push({ category: m[1], value: m[2] });
  }
  return out;
}

/** True if every token uses a category/value Boson actually accepts. */
export function allTokensValid(text: string): boolean {
  const vocab: Record<string, readonly string[]> = {
    emotion: BOSON_EMOTIONS,
    style: BOSON_STYLES,
    sfx: BOSON_SFX,
    prosody: BOSON_PROSODY,
  };
  return extractBosonTokens(text).every((t) => vocab[t.category]?.includes(t.value));
}
