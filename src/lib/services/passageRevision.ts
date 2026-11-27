// AI revision of a selected passage of the script.
//
// The creator selects consecutive lines, says what they want ("tighter",
// "make the disagreement sharper"), and gets a PREVIEW: the same lines, same
// speakers, rewritten. Nothing is saved here. Accepting goes through the same
// line-save path as a manual edit, so the edited lines are marked for a fact
// re-check and their recorded audio is flagged stale exactly as a hand edit's.
//
// Two rules keep it honest:
//   * The model may only return text for the lines it was given. Speakers,
//     line count and order are not its to change (validated, not trusted).
//   * A rewrite must not add facts. That is asked for in the prompt and then
//     CHECKED: any figure in the new text that appears nowhere in the original
//     passage is reported to the creator before they accept.

import type { LLMProvider } from "../providers/llm/interface";

export const MAX_PASSAGE_LINES = 12;
export const MAX_INSTRUCTION_LEN = 400;
export const MAX_LINE_LEN = 2000;
const CONTEXT_LINES = 2;

export interface PassageLine {
  lineIndex: number;
  speaker: string;
  text: string;
  isFactual: boolean;
}

export interface Passage {
  lines: PassageLine[];
  before: PassageLine[];
  after: PassageLine[];
}

export interface RevisionPreviewLine {
  lineIndex: number;
  speaker: string;
  before: string;
  after: string;
  changed: boolean;
  /** The line carries a factual claim, so a change to it needs a re-check. */
  factual: boolean;
  /** Figures in the new text that are nowhere in the original passage. */
  newFigures: string[];
}

export type RevisionResult =
  | { ok: true; lines: RevisionPreviewLine[]; changedCount: number; factualChanged: number; newFigureCount: number }
  | { ok: false; error: string };

/** Every spoken line of a script, in order. Script.content is untyped JSON. */
export function flattenScriptLines(content: unknown): PassageLine[] {
  const segments = (content as { segments?: { lines?: Record<string, unknown>[] }[] } | null)?.segments;
  const out: PassageLine[] = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    for (const ln of seg?.lines ?? []) {
      if (!ln || typeof ln.text !== "string" || typeof ln.lineIndex !== "number") continue;
      out.push({
        lineIndex: ln.lineIndex,
        speaker: typeof ln.speakerName === "string" ? ln.speakerName : "",
        text: ln.text,
        isFactual: ln.isFactualClaim === true,
      });
    }
  }
  return out;
}

/** The selected lines plus a little context either side. Lines must be
 *  consecutive in the script: a passage, not a scattering. */
export function selectPassage(content: unknown, startLineIndex: number, endLineIndex: number): { ok: true; passage: Passage } | { ok: false; error: string } {
  const all = flattenScriptLines(content);
  const from = all.findIndex((l) => l.lineIndex === startLineIndex);
  const to = all.findIndex((l) => l.lineIndex === endLineIndex);
  if (from < 0 || to < 0) return { ok: false, error: "Those lines are no longer in the script. Reload and select again." };
  if (to < from) return { ok: false, error: "Select from the first line to the last." };
  if (to - from + 1 > MAX_PASSAGE_LINES) return { ok: false, error: `Select up to ${MAX_PASSAGE_LINES} lines at a time.` };
  return {
    ok: true,
    passage: {
      lines: all.slice(from, to + 1),
      before: all.slice(Math.max(0, from - CONTEXT_LINES), from),
      after: all.slice(to + 1, to + 1 + CONTEXT_LINES),
    },
  };
}

export const REVISION_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { lineIndex: { type: "integer" }, text: { type: "string" } },
        required: ["lineIndex", "text"],
      },
    },
  },
  required: ["lines"],
} as const;

export function buildRevisionPrompt(passage: Passage, instruction: string): { systemPrompt: string; prompt: string } {
  const show = (ls: PassageLine[]) => ls.map((l) => `[${l.lineIndex}] ${l.speaker}: ${l.text}`).join("\n");
  const systemPrompt = [
    "You are the script editor on a two-host spoken podcast. You revise a short passage of dialogue to an editor's instruction.",
    "Rules:",
    "- Return every line of the passage, each with the SAME lineIndex. Do not add, remove, merge, split or reorder lines. Each line stays with its speaker.",
    "- Change only the wording. Do NOT introduce any fact, number, statistic, date, name, quote or source that is not already in the passage. If the instruction would need a new fact, keep the existing claim as it is.",
    "- Write for the ear: natural spoken sentences in that host's voice, no stage directions, no markdown.",
    "- A line that needs no change is returned unchanged, word for word.",
    'Reply with JSON only: {"lines":[{"lineIndex":<number>,"text":"<revised line>"}]}',
  ].join("\n");
  const prompt = [
    passage.before.length ? `What comes just before (context only, do not return):\n${show(passage.before)}` : "",
    `THE PASSAGE TO REVISE:\n${show(passage.lines)}`,
    passage.after.length ? `What comes just after (context only, do not return):\n${show(passage.after)}` : "",
    // The instruction is the creator's text: delimited, and never able to widen the rules above.
    `The editor's instruction, to be applied within the rules above:\n"""${instruction}"""`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { systemPrompt, prompt };
}

/** Null when the reply is usable; otherwise why not (sent back for one repair). */
export function validateRevisionReply(reply: unknown, passage: Passage): string | null {
  const lines = (reply as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(lines)) return "lines must be an array";
  if (lines.length !== passage.lines.length) return `expected exactly ${passage.lines.length} lines, got ${lines.length}`;
  for (let i = 0; i < lines.length; i++) {
    const got = lines[i] as { lineIndex?: unknown; text?: unknown } | null;
    const want = passage.lines[i];
    if (!got || got.lineIndex !== want.lineIndex) return `line ${i + 1} must have lineIndex ${want.lineIndex}, in the original order`;
    if (typeof got.text !== "string" || !got.text.trim()) return `line ${want.lineIndex} has no text`;
    if (got.text.length > MAX_LINE_LEN) return `line ${want.lineIndex} is longer than ${MAX_LINE_LEN} characters`;
  }
  return null;
}

/** Numbers as a listener would hear them: 42, 3.5, 1,200, 38%. */
function figures(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?%?/g) ?? []).map((f) => f.replace(/,/g, ""));
}

export function previewRevision(passage: Passage, reply: { lines: { lineIndex: number; text: string }[] }): RevisionPreviewLine[] {
  // A figure is "new" if it is nowhere in the passage or its context.
  const known = new Set([...passage.before, ...passage.lines, ...passage.after].flatMap((l) => figures(l.text)));
  return passage.lines.map((line, i) => {
    const after = reply.lines[i].text.trim();
    const changed = after !== line.text.trim();
    return {
      lineIndex: line.lineIndex,
      speaker: line.speaker,
      before: line.text,
      after,
      changed,
      factual: line.isFactual,
      newFigures: changed ? [...new Set(figures(after).filter((f) => !known.has(f)))] : [],
    };
  });
}

export async function proposeRevision(
  llm: LLMProvider,
  content: unknown,
  range: { startLineIndex: number; endLineIndex: number },
  rawInstruction: string
): Promise<RevisionResult> {
  const instruction = String(rawInstruction ?? "").trim();
  if (!instruction) return { ok: false, error: "Say what you want changed." };
  if (instruction.length > MAX_INSTRUCTION_LEN) return { ok: false, error: `Keep the instruction under ${MAX_INSTRUCTION_LEN} characters.` };
  const sel = selectPassage(content, range.startLineIndex, range.endLineIndex);
  if (!sel.ok) return sel;

  const { systemPrompt, prompt } = buildRevisionPrompt(sel.passage, instruction);
  let reply: { lines: { lineIndex: number; text: string }[] };
  try {
    reply = await llm.generateStructuredOutput({
      systemPrompt,
      prompt,
      jsonSchema: REVISION_SCHEMA as unknown as Record<string, unknown>,
      validate: (v) => validateRevisionReply(v, sel.passage),
      // Room for twelve long lines; a passage is never a whole script.
      maxTokens: 4000,
      effort: "low",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Say what the creator can act on; keep provider detail out of the UI.
    if (/credit|billing|401|403|api key/i.test(msg)) return { ok: false, error: "The writing model is not available right now (account or credit problem). Edit the lines by hand, or try again later." };
    if (/failed validation/i.test(msg)) return { ok: false, error: "The model's rewrite did not keep the passage's lines intact, so it was discarded. Try again, or word the instruction differently." };
    return { ok: false, error: "The rewrite could not be produced just now. Nothing was changed. Try again." };
  }
  // The provider runs the validator, but not every provider is obliged to.
  const problem = validateRevisionReply(reply, sel.passage);
  if (problem) return { ok: false, error: "The model's rewrite did not keep the passage's lines intact, so it was discarded. Try again." };

  const lines = previewRevision(sel.passage, reply);
  return {
    ok: true,
    lines,
    changedCount: lines.filter((l) => l.changed).length,
    factualChanged: lines.filter((l) => l.changed && l.factual).length,
    newFigureCount: lines.reduce((n, l) => n + l.newFigures.length, 0),
  };
}

/**
 * Which recorded lines no longer say what the script says. A ready audio
 * segment remembers the text it was synthesized from; if the script line has
 * been edited since, the recording is stale. (Scene-voiced episodes keep no
 * per-line text, so they are not covered here.)
 */
export function staleLineIndexes(scriptLines: { lineIndex: number; text: string }[], segments: { lineIndex: number; text: string }[]): number[] {
  const recorded = new Map(segments.map((s) => [s.lineIndex, s.text.trim()]));
  return scriptLines.filter((l) => recorded.has(l.lineIndex) && recorded.get(l.lineIndex) !== l.text.trim()).map((l) => l.lineIndex);
}
