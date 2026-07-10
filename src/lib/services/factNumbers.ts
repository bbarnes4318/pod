// Pure, dependency-free "number-in-evidence" verification for the deterministic
// fact-check layer (FIX 1). The old deterministic layer only checked that a
// factual line HAD an evidence ref — never that the figures the line asserts
// actually appear in that evidence. So an inflated number with a real citation
// ("five homers" citing a fact that says three) passed at 100% coverage. This
// module closes that blind spot.
//
// Design goals:
//  - Catch fabrication/inflation: "five homers" when evidence says three;
//    "three 100-loss seasons" / "56 runs" / "5-and-15" absent from evidence.
//  - NOT false-fail legitimate rounding: the writer is told to say "damn near
//    fifty percent" for 49.8% — so a line number within a small tolerance of a
//    real evidence number counts as supported.
//  - Degrade, never silently pass: if there is no evidence text to check
//    against, we report verifiable=false so the caller leaves the line to the
//    semantic reviewer instead of asserting it clean.
//
// Everything here is pure and unit-tested (see testFactNumbers.ts).

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10,
};
const SCALE: Record<string, number> = { hundred: 100, thousand: 1000, dozen: 12 };

// Capitalized tokens that look like names but are NOT person/team entities we
// should verify — directions, calendar words, filler, and generic sports nouns.
const NAME_STOPWORDS = new Set([
  "the", "a", "an", "and", "but", "or", "so", "he", "she", "they", "we", "i", "you",
  "east", "west", "north", "south", "eastern", "western", "central", "al", "nl",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "monday", "tuesday", "wednesday",
  "thursday", "friday", "saturday", "sunday", "mvp", "cy", "young", "yeah", "no",
  "okay", "ok", "look", "listen", "wait", "hold", "right", "sure", "well", "oh",
  "anyway", "fine", "God", "lord", "man", "world", "series", "league", "east.",
]);

function normalize(text: string): string {
  return String(text ?? "").toLowerCase();
}

/** Spell an integer 0-99 (and round hundreds/thousands) to its English word. */
function spellNumber(n: number): string[] {
  const forms = new Set<string>();
  if (!Number.isFinite(n)) return [];
  const int = Math.round(n);
  const entries = [
    ...Object.entries(ONES),
    ...Object.entries(TENS),
    ...Object.entries(SCALE),
  ];
  for (const [word, val] of entries) if (val === int) forms.add(word);
  // compound tens (twenty-one .. ninety-nine)
  if (int > 20 && int < 100 && int % 10 !== 0) {
    const tens = Math.floor(int / 10) * 10;
    const ones = int % 10;
    const tw = Object.entries(TENS).find(([, v]) => v === tens)?.[0];
    const ow = Object.entries(ONES).find(([, v]) => v === ones)?.[0];
    if (tw && ow) {
      forms.add(`${tw}-${ow}`);
      forms.add(`${tw} ${ow}`);
    }
  }
  return [...forms];
}

/** All numeric values that appear in evidence text (digits + spelled). */
export function extractEvidenceNumbers(text: string): number[] {
  const t = normalize(text);
  const nums: number[] = [];
  // digit forms incl. decimals and record halves
  for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) {
    const v = parseFloat(m[0]);
    if (Number.isFinite(v)) nums.push(v);
  }
  // spelled cardinals / tens / ordinals (single-token)
  const tokens = t.split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i];
    if (w in ONES) nums.push(ONES[w]);
    else if (w in TENS) {
      // greedily combine "twenty one"
      const next = tokens[i + 1];
      if (next && next in ONES && ONES[next] < 10) nums.push(TENS[w] + ONES[next]);
      else nums.push(TENS[w]);
    } else if (w in ORDINALS) nums.push(ORDINALS[w]);
    else if (w in SCALE) nums.push(SCALE[w]);
  }
  // hyphenated compounds like "twenty-one"
  for (const m of t.matchAll(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(one|two|three|four|five|six|seven|eight|nine)\b/g)) {
    nums.push(TENS[m[1]] + ONES[m[2]]);
  }
  return nums;
}

export interface AssertedFigure {
  surface: string; // as written in the line
  value: number;
  /** surface forms to look for as exact tokens in evidence */
  forms: string[];
}

/** Numeric figures a line asserts: digits, records ("48-38", "5-and-15"),
 *  spelled cardinals/ordinals, and tens compounds. */
export function extractAssertedFigures(text: string): AssertedFigure[] {
  const t = normalize(text);
  const out: AssertedFigure[] = [];
  const seen = new Set<string>();
  const push = (surface: string, value: number, extra: string[] = []) => {
    const key = `${value}|${surface}`;
    if (seen.has(key) || !Number.isFinite(value)) return;
    seen.add(key);
    out.push({ surface, value, forms: Array.from(new Set([surface, String(value), ...spellNumber(value), ...extra])) });
  };

  // Records / scores: "48-38", "5-and-15", "five and fifteen"
  for (const m of t.matchAll(/\b(\d{1,3})\s*[-–]\s*and\s*[-–]?\s*(\d{1,3})\b/g)) {
    push(m[0], parseInt(m[1], 10), [`${m[1]}-${m[2]}`, `${m[1]} and ${m[2]}`]);
    push(m[0] + "#b", parseInt(m[2], 10));
  }
  for (const m of t.matchAll(/\b(\d{1,3})[-–](\d{1,3})\b/g)) {
    push(m[0], parseInt(m[1], 10), [`${m[1]}-${m[2]}`]);
    push(m[0] + "#b", parseInt(m[2], 10), [`${m[1]}-${m[2]}`]);
  }
  // spelled record "five and fifteen"
  for (const m of t.matchAll(/\b([a-z]+)\s+and\s+([a-z]+)\b/g)) {
    const a = ONES[m[1]] ?? TENS[m[1]];
    const b = ONES[m[2]] ?? TENS[m[2]];
    if (a !== undefined && b !== undefined) {
      push(m[0], a, [`${a}-${b}`, m[0]]);
      push(m[0] + "#b", b);
    }
  }
  // plain digit runs (ints/decimals)
  for (const m of t.matchAll(/\b\d+(?:\.\d+)?\b/g)) {
    push(m[0], parseFloat(m[0]));
  }
  // spelled single-token cardinals / ordinals / tens (+compound) / scale
  const tokens = t.split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i];
    if (w in TENS) {
      const next = tokens[i + 1];
      if (next && next in ONES && ONES[next] < 10) {
        push(`${w}-${next}`, TENS[w] + ONES[next]);
        i++; // consume the ones token so "thirty-one" doesn't also emit 1
      } else {
        push(w, TENS[w]);
      }
    } else if (w in ONES) push(w, ONES[w]);
    else if (w in ORDINALS) push(w, ORDINALS[w]);
    else if (w in SCALE) push(w, SCALE[w]);
  }
  for (const m of t.matchAll(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(one|two|three|four|five|six|seven|eight|nine)\b/g)) {
    push(m[0], TENS[m[1]] + ONES[m[2]]);
  }
  return out;
}

function tokenPresent(evidenceLower: string, form: string): boolean {
  const f = form.toLowerCase().trim();
  if (!f) return false;
  // Whole-token / phrase match with digit-safe boundaries (so "5" != "56").
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\w.])${esc}(?![\\w.])`, "i");
  return re.test(evidenceLower);
}

/** Rounding-tolerant: "fifty" supports evidence 49.8; "five" does NOT support 3. */
function withinTolerance(value: number, evidenceNums: number[]): boolean {
  for (const e of evidenceNums) {
    const tol = Math.max(0.5, Math.min(0.1 * Math.abs(e), 2));
    if (Math.abs(value - e) <= tol) return true;
  }
  return false;
}

export interface FigureVerdict {
  surface: string;
  value: number;
  evidenceSays: number[]; // nearest/available evidence numbers, for the reason
}

export interface ClaimVerification {
  verifiable: boolean; // false => no evidence text; caller should degrade to semantic
  unsupportedFigures: FigureVerdict[];
  unsupportedNames: string[];
}

/** Proper-name candidates a line asserts (capitalized, not stopwords/hosts). */
export function extractAssertedNames(text: string, hostNames: string[] = []): string[] {
  const hostTokens = new Set(
    hostNames.flatMap((h) => h.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 1))
  );
  const stripped = String(text ?? "").replace(/\[[^\]]*\]/g, " "); // drop [tags]
  const names = new Set<string>();
  // Capitalized word not at sentence start (index>0 in its sentence), 4+ letters.
  const sentences = stripped.split(/(?<=[.!?—-])\s+/);
  for (const sent of sentences) {
    const words = sent.split(/\s+/);
    words.forEach((raw, idx) => {
      const w = raw.replace(/[^A-Za-z']/g, "");
      if (w.length < 4) return;
      if (!/^[A-Z][a-z']+$/.test(w)) return; // Proper-case only (skip ALLCAPS/lowercase)
      const lw = w.toLowerCase();
      if (idx === 0) return; // sentence-initial capital is ambiguous
      if (NAME_STOPWORDS.has(lw) || hostTokens.has(lw)) return;
      names.add(w);
    });
  }
  return [...names];
}

/**
 * Verify every figure (and asserted name) a factual line states appears in the
 * supplied evidence text. Returns verifiable=false when there is no evidence
 * text to check (degrade to semantic). A figure is supported if an exact
 * surface form is present OR it is within rounding tolerance of an evidence
 * number. Names are supported if the token appears in the evidence text.
 */
export function verifyClaimFigures(
  lineText: string,
  evidenceText: string,
  opts: { hostNames?: string[]; checkNames?: boolean } = {}
): ClaimVerification {
  const evidenceLower = normalize(evidenceText);
  if (!evidenceLower.trim()) {
    return { verifiable: false, unsupportedFigures: [], unsupportedNames: [] };
  }
  const evidenceNums = extractEvidenceNumbers(evidenceText);

  const unsupportedFigures: FigureVerdict[] = [];
  for (const fig of extractAssertedFigures(lineText)) {
    const exact = fig.forms.some((f) => tokenPresent(evidenceLower, f));
    if (exact) continue;
    if (withinTolerance(fig.value, evidenceNums)) continue;
    // nearest evidence numbers for the reason
    const near = [...evidenceNums].sort((a, b) => Math.abs(a - fig.value) - Math.abs(b - fig.value)).slice(0, 4);
    unsupportedFigures.push({ surface: fig.surface.replace(/#b$/, ""), value: fig.value, evidenceSays: near });
  }

  const unsupportedNames: string[] = [];
  if (opts.checkNames) {
    for (const name of extractAssertedNames(lineText, opts.hostNames)) {
      if (!tokenPresent(evidenceLower, name)) unsupportedNames.push(name);
    }
  }

  return { verifiable: true, unsupportedFigures, unsupportedNames };
}
