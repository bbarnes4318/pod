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

function isNumberWord(w: string): boolean {
  return w in ONES || w in TENS || w in ORDINALS || w in SCALE;
}

/** Fold a run of spelled number-words into one value: "seventeen thousand five
 *  hundred" -> 17500, "three hundred" -> 300, "twenty three" -> 23. */
function wordsToNumber(words: string[]): number | null {
  let result = 0;
  let current = 0;
  let any = false;
  for (const w of words) {
    if (w in ONES) { current += ONES[w]; any = true; }
    else if (w in TENS) { current += TENS[w]; any = true; }
    else if (w in ORDINALS) { current += ORDINALS[w]; any = true; }
    else if (w === "hundred") { current = (current || 1) * 100; any = true; }
    else if (w === "thousand") { result += (current || 1) * 1000; current = 0; any = true; }
    else if (w === "dozen") { current = (current || 1) * 12; any = true; }
    else return null;
  }
  return any ? result + current : null;
}

export interface CollectedNumber {
  value: number;
  surface: string;
}

/**
 * Every numeric quantity a text asserts, as (value, surface) — correctly
 * handling comma-grouped digits ("17,500"), digit records ("48-38"), SPOKEN
 * YEARS ("twenty twenty-three" -> 2023, not a bare 20), and SPELLED COMPOSITES
 * ("seventeen thousand five hundred" -> 17500). Used for both the evidence
 * corpus (values) and a line's asserted figures (values + surfaces).
 */
export function collectNumbers(text: string): CollectedNumber[] {
  let t = normalize(text);
  const out: CollectedNumber[] = [];
  const push = (value: number, surface: string) => {
    if (Number.isFinite(value)) out.push({ value, surface: surface.trim() });
  };
  // Blank spans as they're consumed so nothing double-counts.
  const blank = (start: number, len: number) => {
    t = t.slice(0, start) + " ".repeat(len) + t.slice(start + len);
  };

  // 1. comma-grouped digits: 17,500 -> 17500
  for (const m of t.matchAll(/\b\d{1,3}(?:,\d{3})+\b/g)) {
    push(parseInt(m[0].replace(/,/g, ""), 10), m[0]);
  }
  t = t.replace(/\b\d{1,3}(?:,\d{3})+\b/g, (s) => " ".repeat(s.length));

  // 2. digit records "48-38" / "5-and-15" (each half is a figure)
  for (const m of t.matchAll(/\b(\d{1,3})\s*[-–](?:\s*and\s*[-–]?\s*)?(\d{1,3})\b/g)) {
    push(parseInt(m[1], 10), m[0]);
    push(parseInt(m[2], 10), m[0]);
    blank(m.index!, m[0].length);
  }

  // 3. spoken years: (nineteen|twenty) + <tens-led remainder 0-99>
  const yearRe = /\b(nineteen|twenty)[\s-]+((?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)(?:[\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?|nineteen|eighteen|seventeen|sixteen|fifteen|fourteen|thirteen)\b/g;
  for (const m of t.matchAll(yearRe)) {
    const base = m[1] === "nineteen" ? 1900 : 2000;
    const remWords = m[2].split(/[\s-]+/).filter(Boolean);
    const rem = m[2] === "hundred" ? 0 : wordsToNumber(remWords) ?? 0;
    push(base + rem, m[0]);
    blank(m.index!, m[0].length);
  }

  // 4. spelled digit "five and fifteen" record (both parts already covered by
  //    ranges; handle the all-spelled variant)
  for (const m of t.matchAll(/\b([a-z]+)\s+and\s+([a-z]+)\b/g)) {
    const a = ONES[m[1]] ?? TENS[m[1]];
    const b = ONES[m[2]] ?? TENS[m[2]];
    if (a !== undefined && b !== undefined) {
      push(a, m[0]);
      push(b, m[0]);
      blank(m.index!, m[0].length);
    }
  }

  // 5. plain digits (ints/decimals), incl. 4-digit years
  for (const m of t.matchAll(/\b\d+(?:\.\d+)?\b/g)) {
    push(parseFloat(m[0]), m[0]);
  }
  t = t.replace(/\b\d+(?:\.\d+)?\b/g, (s) => " ".repeat(s.length));

  // 6. maximal runs of spelled number-words -> one folded value each
  const tokenRe = /[a-z]+/g;
  let run: string[] = [];
  let runStart = -1;
  let runEnd = -1;
  const flush = () => {
    if (run.length) {
      const v = wordsToNumber(run);
      if (v !== null) push(v, t.slice(runStart, runEnd));
    }
    run = [];
    runStart = runEnd = -1;
  };
  for (const m of t.matchAll(tokenRe)) {
    const w = m[0];
    if (isNumberWord(w)) {
      if (!run.length) runStart = m.index!;
      run.push(w);
      runEnd = m.index! + w.length;
    } else if (w === "and" && run.length > 0 && (run[run.length - 1] === "hundred" || run[run.length - 1] === "thousand")) {
      // "five hundred and eighty-one" is ONE number — bridge the "and" ONLY
      // after a scale word. "five and fifteen" (a 5-15 record) has no scale
      // before the "and", so it correctly stays two separate figures.
      runEnd = m.index! + w.length;
    } else {
      flush();
    }
  }
  flush();

  return out;
}

/** All numeric values that appear in evidence text. */
export function extractEvidenceNumbers(text: string): number[] {
  return collectNumbers(text).map((n) => n.value);
}

export interface AssertedFigure {
  surface: string; // as written in the line
  value: number;
  /** surface forms to look for as exact tokens in evidence */
  forms: string[];
}

/** Numeric figures a line asserts (values + surfaces), for verification. */
export function extractAssertedFigures(text: string): AssertedFigure[] {
  const seen = new Set<string>();
  const out: AssertedFigure[] = [];
  for (const { value, surface } of collectNumbers(text)) {
    const key = `${value}|${surface}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ surface, value, forms: Array.from(new Set([surface, String(value), ...spellNumber(value)])) });
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

const isYearLike = (n: number): boolean => Number.isInteger(n) && n >= 1900 && n <= 2099;

/**
 * Rounding-tolerant matching that still catches fabrication:
 *  - small counts stay tight ("five" does NOT support 3),
 *  - "fifty" supports 49.8 (rounding),
 *  - large figures allow spoken rounding ("seventeen thousand" ~ 17,581, 5%),
 *  - years stay near-exact (2018 does NOT support 2016).
 */
function withinTolerance(value: number, evidenceNums: number[]): boolean {
  for (const e of evidenceNums) {
    let tol: number;
    if (isYearLike(value) || isYearLike(e)) tol = 0.5;
    else if (Math.abs(e) >= 1000) tol = Math.max(0.5, 0.05 * Math.abs(e));
    else tol = Math.max(0.5, Math.min(0.1 * Math.abs(e), 2));
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
  /** Named real people presented as saying/doing something specific, absent from evidence. */
  unsupportedAttributions: string[];
}

// A named person becomes a SPECIFIC ATTRIBUTION (a quote, statement, or specific
// action — legal exposure, not just accuracy) when a speech/action verb or a
// possessive action-noun attaches to them. General references ("Boone's bullpen
// management") carry no such verb/noun and are allowed. Colloquial g-dropped
// forms ("sayin'", "callin'") are included.
const ATTRIBUTION_VERBS = new Set([
  "said", "say", "says", "sayin", "saying", "told", "tells", "telling",
  "call", "called", "calls", "callin", "calling", "claim", "claimed", "claims", "claiming",
  "insist", "insists", "insisted", "argue", "argues", "argued", "admit", "admits", "admitted",
  "think", "thinks", "thinkin", "thinking", "believe", "believes", "believed",
  "decide", "decided", "decides", "deciding", "bench", "benched", "pull", "pulled",
  "order", "ordered", "promise", "promised", "guarantee", "guaranteed", "announce", "announced",
  "tweet", "tweeted", "wrote", "writes", "rip", "ripped", "blast", "blasted",
  "praise", "praised", "vow", "vowed", "demand", "demanded", "pledge", "pledged",
  "suggest", "suggested", "warn", "warned", "predict", "predicted",
]);
const ATTRIBUTION_NOUNS = new Set([
  "decision", "call", "quote", "statement", "comment", "take", "promise", "guarantee",
  "benching", "tweet", "remark", "pledge", "vow", "order", "claim", "prediction",
  "admission", "warning", "guarantee's",
]);

const cleanTok = (w: string) => (w || "").replace(/[’]/g, "'").replace(/[.,!?;:"]+$/g, "");
const nrmVerb = (w: string) => cleanTok(w).toLowerCase().replace(/'$/, "");
function isProperNameTok(w: string): boolean {
  const c = cleanTok(w);
  return /^[A-Z][A-Za-z]*('s|')?$/.test(c) && c.replace(/'s?$/, "").length >= 3;
}

/**
 * Named real people a line ASSERTS as saying/doing something specific — the
 * fabricated-quote / invented-action risk. General mentions are NOT returned.
 */
export function extractAttributions(text: string, hostNames: string[] = []): string[] {
  const hostTokens = new Set(
    hostNames.flatMap((h) => h.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 1))
  );
  const stripped = String(text ?? "").replace(/\[[^\]]*\]/g, " ");
  const out = new Set<string>();
  for (const sent of stripped.split(/(?<=[.!?—])\s+/)) {
    const words = sent.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      if (!isProperNameTok(words[i])) continue;
      // Build a multi-word proper-name phrase (e.g. "Michael Kay['s]").
      let j = i;
      const parts: string[] = [cleanTok(words[i]).replace(/'s?$/, "")];
      while (j + 1 < words.length && isProperNameTok(words[j + 1]) && !ATTRIBUTION_VERBS.has(nrmVerb(words[j + 1]))) {
        parts.push(cleanTok(words[j + 1]).replace(/'s?$/, ""));
        j++;
      }
      const lastTok = cleanTok(words[j]);
      const possessive = /'s?$/.test(lastTok);
      const nameStr = parts.join(" ");
      const lowerParts = parts.map((p) => p.toLowerCase());
      if (lowerParts.every((p) => hostTokens.has(p)) || lowerParts.every((p) => NAME_STOPWORDS.has(p))) {
        i = j;
        continue;
      }
      const after1 = nrmVerb(words[j + 1] || "");
      const after2 = nrmVerb(words[j + 2] || "");
      if (ATTRIBUTION_VERBS.has(after1) || ATTRIBUTION_VERBS.has(after2)) out.add(nameStr);
      else if (possessive && ATTRIBUTION_NOUNS.has(after1)) out.add(nameStr);
      i = j;
    }
  }
  return [...out];
}

/**
 * Verify the figures and person-attributions a factual line states appear in the
 * supplied evidence. verifiable=false when there's no evidence text (degrade to
 * semantic). A figure is supported if an exact surface form is present OR it is
 * within rounding tolerance of an evidence number. An attribution is supported
 * if the person's name appears in the evidence.
 */
export function verifyClaimFigures(
  lineText: string,
  evidenceText: string,
  opts: { hostNames?: string[]; checkAttributions?: boolean } = {}
): ClaimVerification {
  const evidenceLower = normalize(evidenceText);
  if (!evidenceLower.trim()) {
    return { verifiable: false, unsupportedFigures: [], unsupportedAttributions: [] };
  }
  const evidenceNums = extractEvidenceNumbers(evidenceText);

  const unsupportedFigures: FigureVerdict[] = [];
  for (const fig of extractAssertedFigures(lineText)) {
    if (fig.forms.some((f) => tokenPresent(evidenceLower, f))) continue;
    if (withinTolerance(fig.value, evidenceNums)) continue;
    const near = [...evidenceNums].sort((a, b) => Math.abs(a - fig.value) - Math.abs(b - fig.value)).slice(0, 4);
    unsupportedFigures.push({ surface: fig.surface.replace(/#b$/, ""), value: fig.value, evidenceSays: near });
  }

  const unsupportedAttributions: string[] = [];
  if (opts.checkAttributions) {
    for (const name of extractAttributions(lineText, opts.hostNames)) {
      // supported if any token of the name appears in evidence
      const nameTokens = name.split(/\s+/);
      if (!nameTokens.some((t) => tokenPresent(evidenceLower, t))) unsupportedAttributions.push(name);
    }
  }

  return { verifiable: true, unsupportedFigures, unsupportedAttributions };
}

/**
 * The canonical per-line verification used by BOTH the deterministic gate and
 * the generation-time self-verify loop, so they agree exactly. Checks the line's
 * cited evidence first, then keeps only violations ALSO absent from the full
 * episode corpus (so ref-misattribution and rounding never false-fail).
 */
export function verifyLineAgainstEvidence(
  lineText: string,
  citedText: string,
  fullEvidenceText: string,
  hostNames: string[] = []
): ClaimVerification {
  const cited = verifyClaimFigures(lineText, citedText, { hostNames, checkAttributions: true });
  if (cited.verifiable) {
    const corpus = verifyClaimFigures(lineText, fullEvidenceText, { hostNames, checkAttributions: true });
    return {
      verifiable: true,
      unsupportedFigures: cited.unsupportedFigures.filter((f) =>
        corpus.unsupportedFigures.some((c) => c.value === f.value && c.surface === f.surface)
      ),
      unsupportedAttributions: cited.unsupportedAttributions.filter((n) => corpus.unsupportedAttributions.includes(n)),
    };
  }
  const corpus = verifyClaimFigures(lineText, fullEvidenceText, { hostNames, checkAttributions: true });
  return corpus.verifiable ? corpus : { verifiable: false, unsupportedFigures: [], unsupportedAttributions: [] };
}
