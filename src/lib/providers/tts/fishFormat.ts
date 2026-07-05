// Fish Audio (S2.1-pro) inline cue formatting layer.
//
// Fish's S2.1 models treat [square brackets] as NATURAL LANGUAGE delivery
// cues, placed INLINE exactly where the effect occurs — not a fixed token
// set. "I can't believe it [gasp] you actually did it [laugh]".
//
// This is deliberately a different shape from the Boson formatter: no
// leading control tokens, no fixed vocabulary. Cues are short descriptive
// phrases at the moment they happen, and the golden rule is DON'T OVER-TAG —
// a human amount is one or two cues per line, many lines need none.
//
// Only the Fish provider calls this. Other providers get untouched text.

export interface FishLineInput {
  /** Script line text; may contain whitelisted [tags] like [laughs]. */
  text: string;
  /** Script tone label (heated, sarcastic, analytical, ...). */
  tone?: string;
  /** Vocal intensity for this line. */
  energy?: "low" | "medium" | "high";
  /** True when this line cuts the previous speaker off. */
  isInterruption?: boolean;
}

/**
 * Our script tags → Fish natural-language cues, kept at the same position.
 * `null` = drop the tag (the words already carry it).
 */
export const SCRIPT_TAG_TO_FISH: Record<string, string | null> = {
  "laughs": "[laugh]",
  "laughs hard": "[laughing hard]",
  "laughs softly": "[soft chuckle]",
  "chuckles": "[chuckle]",
  "sighs": "[sigh]",
  "exhales": "[exhale]",
  "inhales": "[inhale]",
  "groans": "[groans]",
  "gasps": "[gasp]",
  "scoffs": "[scoffs]",
  "clears throat": "[clears throat]",
  "whispers": "[whisper]",
  "pause": "[pause]",
  "hesitates": "[hesitates]",
  "stammers": "[stammering]",
  "excited": "[excited]",
  "sarcastic": "[sarcastic]",
  "frustrated": "[frustrated]",
  "curious": "[curious]",
  "deadpan": "[dry, unimpressed]",
  "interrupting": "[cutting in]",
};

/**
 * Tone → an OPTIONAL opening cue, used only when the line carries no cue of
 * its own. Descriptive, host-fitting, sports-debate register. `null` tones
 * read naturally without steering.
 */
export const TONE_TO_FISH_CUE: Record<string, string | null> = {
  heated: "[angry]",
  excited: "[excited]",
  sarcastic: "[dry, mocking]",
  amused: "[amused]",
  dismissive: "[dry, unimpressed]",
  incredulous: "[genuinely stunned]",
  reflective: "[thoughtful]",
  conceding: "[reluctant]",
  analytical: null,
  setup: null,
  transition: null,
};

/** Heated/excited lines at full energy get the shout build instead. */
const HIGH_ENERGY_ESCALATION: Record<string, string> = {
  heated: "[building to a shout]",
  excited: "[building to a shout]",
};

const TAG_PATTERN = /\[([^\[\]]{1,40})\]/g;

/**
 * Produce Fish-cued text for one script line.
 *
 * Rules:
 *  1. Existing script [tags] convert IN PLACE to Fish natural-language cues.
 *  2. If (and only if) the line ends up with no cues, one tone-derived cue
 *     may open the line; high-energy heated/excited lines escalate to
 *     "[building to a shout]".
 *  3. Interruptions open with [cutting in] (counts toward the cue budget).
 *  4. Never more than 2 cues total — humans don't perform every word.
 */
export function formatLineForFish(line: FishLineInput): string {
  const raw = (line.text || "").trim();
  if (!raw) return "";

  let cueCount = 0;

  // 1. Convert existing tags in place.
  let text = raw.replace(TAG_PATTERN, (_m, inner: string) => {
    const mapped = SCRIPT_TAG_TO_FISH[inner.trim().toLowerCase()];
    if (mapped === undefined) return " ";      // unknown tag — strip
    if (mapped === null) return " ";           // deliberate drop
    if (cueCount >= 2) return " ";             // over the human budget
    cueCount++;
    return ` ${mapped} `;
  });

  // 2 + 3. Optional opening cue.
  const openers: string[] = [];
  if (line.isInterruption && cueCount < 2) {
    openers.push("[cutting in]");
    cueCount++;
  }
  if (cueCount === 0) {
    const escalated = line.energy === "high" ? HIGH_ENERGY_ESCALATION[line.tone || ""] : undefined;
    const cue = escalated ?? TONE_TO_FISH_CUE[line.tone || ""] ?? null;
    if (cue) {
      openers.push(cue);
      cueCount++;
    }
  }

  const body = text.replace(/\s+/g, " ").trim();
  return openers.length ? `${openers.join(" ")} ${body}` : body;
}

/** All bracketed cues in a string (for tests). */
export function extractFishCues(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  TAG_PATTERN.lastIndex = 0;
  while ((m = TAG_PATTERN.exec(text)) !== null) out.push(m[1]);
  return out;
}
