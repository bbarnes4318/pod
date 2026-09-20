// Deterministic "can a listener follow this?" checks, plus one batched repair.
//
// Written against the 2026-09-20 episode, which a lifelong fan could not
// follow: 66 lines in which "Rays" and "Royals" never appeared, a player called
// "the kid" for five lines before he was named, "keep an eye on the attitude"
// said nine times, and every topic dissolved into "the building", "the file",
// "who signed the sentence". None of the LLM judges flagged any of it. These
// checks are string arithmetic; they cannot be talked out of it.

import type { LLMProvider } from "../providers/llm/interface";
import { stripAudioTags } from "../audio/speechText";
import { withLlmStage } from "../providers/llm/costLedger";

export type ListenerIssueKind = "orientation" | "recycled_phrase" | "meta_vocabulary";

export interface ListenerIssue {
  lineIndex: number;
  kind: ListenerIssueKind;
  detail: string;
}

export interface ListenerCheckLine {
  lineIndex: number;
  speakerName: string;
  text: string;
}

export interface ListenerCheckSegment {
  type: string;
  topicId?: string | null;
  lines: ListenerCheckLine[];
}

/** Front-office abstractions that replaced the actual game. One use per
 *  episode is a turn of phrase; the second is the show's subject. */
export const META_VOCABULARY: RegExp[] = [
  /\b(that|the|this) building\b/i,
  /\bthe file\b/i,
  /\bthe page\b/i,
  /\bthe desk\b/i,
  /\bthe receipt\b/i,
  /\bthe paperwork\b/i,
  /\bwho signed\b/i,
  /\bsigned (for|off on) (it|that|the|him|her)\b/i,
  /\b(wrote|typed|write) (that|the|a) sentence\b/i,
  /\bthe story going around\b/i,
];

/** How many times a content phrase may recur before it is recycling. */
export const PHRASE_RECYCLE_BUDGET = 2;
/** Entity tokens the first two lines of a topic segment must carry. */
export const ORIENTATION_MIN_ENTITIES = 2;

// Capitalized words that are not names. Sentence starters and calendar words
// are the noise; everything else capitalized in a sports brief is a team, a
// player, a city or a league.
const NOT_AN_ENTITY = new Set([
  "the", "and", "but", "that", "this", "then", "there", "they", "them", "their", "these", "those",
  "when", "what", "where", "which", "who", "why", "how", "with", "from", "into", "over", "after",
  "before", "because", "about", "against", "between", "during", "under", "until", "while",
  "you", "your", "our", "his", "her", "its", "not", "now", "yes", "yeah", "okay", "fine", "look",
  "all", "any", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "first", "second", "third", "last", "next", "new", "old", "big", "just", "still", "even", "only",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "here", "hey", "hold", "wait", "right", "sure", "well", "come", "give", "name", "tell", "say", "put", "let",
  "somebody", "nobody", "everybody", "anybody", "someone", "everyone", "nothing", "something",
  "player", "month", "series", "world", "hall", "famer", "league", "game", "games", "october",
]);

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "in", "on", "at", "to", "for", "with", "that", "this",
  "it", "its", "is", "was", "are", "were", "be", "been", "he", "she", "they", "them", "his", "her",
  "their", "you", "your", "i", "we", "me", "my", "so", "if", "as", "by", "from", "about", "just",
  "like", "there", "here", "what", "not", "no", "do", "did", "does", "has", "have", "had", "got",
  "then", "than", "up", "out", "one", "all", "any", "can", "cant", "dont", "im", "youre", "thats",
]);

function normalize(text: string): string {
  return stripAudioTags(String(text))
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Capitalized tokens (lowercased) that look like names — from evidence text
 *  or from a spoken line. */
export function entityTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of String(text).split(/[^A-Za-z.'’-]+/)) {
    const w = raw.replace(/^[.'’-]+|[.'’-]+$/g, "");
    if (w.length < 3 || !/^[A-Z]/.test(w)) continue;
    const key = w.toLowerCase().replace(/'s$/, "");
    if (NOT_AN_ENTITY.has(key)) continue;
    out.add(key);
  }
  return out;
}

export interface ListenerCheckContext {
  /** Entity tokens per topicId (from that topic's title + evidence). */
  entitiesByTopic: Map<string, Set<string>>;
  /** Union of every topic's entities — used when a segment has no topicId. */
  episodeEntities: Set<string>;
}

export function buildListenerCheckContext(
  topics: Array<{ id: string; text: string }>
): ListenerCheckContext {
  const entitiesByTopic = new Map<string, Set<string>>();
  const episodeEntities = new Set<string>();
  for (const t of topics) {
    const tokens = entityTokens(t.text);
    entitiesByTopic.set(t.id, tokens);
    for (const tok of tokens) episodeEntities.add(tok);
  }
  return { entitiesByTopic, episodeEntities };
}

export function findListenerIssues(
  segments: ListenerCheckSegment[],
  ctx: ListenerCheckContext
): ListenerIssue[] {
  const issues: ListenerIssue[] = [];
  const flat = segments.flatMap((s) => s.lines);

  // 1. ORIENTATION: the first two lines of every topic segment name at least
  //    two entities from that topic's evidence (a team and a person, in
  //    practice). The cold open gets the same test against the whole episode.
  for (const seg of segments) {
    if (seg.type !== "topic" && seg.type !== "cold_open") continue;
    if (!seg.lines.length) continue;
    const pool =
      (seg.topicId && ctx.entitiesByTopic.get(seg.topicId)) || ctx.episodeEntities;
    if (pool.size < ORIENTATION_MIN_ENTITIES) continue; // nothing to test against
    const opening = seg.lines.slice(0, 2).map((l) => l.text).join(" ");
    const named = [...entityTokens(opening)].filter((t) => pool.has(t));
    if (named.length < ORIENTATION_MIN_ENTITIES) {
      issues.push({
        lineIndex: seg.lines[0].lineIndex,
        kind: "orientation",
        detail:
          `The first two lines of this ${seg.type} segment name ${named.length} of the story's people/teams ` +
          `(${named.join(", ") || "none"}); a listener cannot tell who or what it is about. ` +
          `Open by setting the table: the team, the person's full name and job, what happened, when, the number.`,
      });
    }
  }

  // 2. RECYCLED PHRASES: a content 4-gram said more than PHRASE_RECYCLE_BUDGET
  //    times across the episode. Each occurrence past the budget is flagged on
  //    its line ("keep an eye on the attitude" x9).
  const gramLines = new Map<string, number[]>();
  for (const line of flat) {
    const words = normalize(line.text).split(" ").filter(Boolean);
    const seenHere = new Set<string>();
    for (let i = 0; i + 4 <= words.length; i++) {
      const gram = words.slice(i, i + 4);
      if (gram.filter((w) => !STOP.has(w)).length < 2) continue;
      const key = gram.join(" ");
      if (seenHere.has(key)) continue;
      seenHere.add(key);
      const arr = gramLines.get(key) ?? [];
      arr.push(line.lineIndex);
      gramLines.set(key, arr);
    }
  }
  const recycledOn = new Map<number, Set<string>>();
  for (const [gram, lines] of gramLines) {
    if (lines.length <= PHRASE_RECYCLE_BUDGET) continue;
    for (const lineIndex of lines.slice(PHRASE_RECYCLE_BUDGET)) {
      const set = recycledOn.get(lineIndex) ?? new Set<string>();
      set.add(gram);
      recycledOn.set(lineIndex, set);
    }
  }
  for (const [lineIndex, grams] of recycledOn) {
    // Overlapping grams from one repeated sentence collapse to the longest few.
    const sample = [...grams].slice(0, 3).map((g) => `"${g}"`).join(", ");
    issues.push({
      lineIndex,
      kind: "recycled_phrase",
      detail: `Repeats a phrase already used ${PHRASE_RECYCLE_BUDGET}+ times this episode (${sample}). Say something new or cut it.`,
    });
  }

  // 3. META VOCABULARY: the front-office abstractions, budget one per episode
  //    across the whole list.
  let metaUses = 0;
  for (const line of flat) {
    const hits = META_VOCABULARY.filter((re) => re.test(line.text));
    if (!hits.length) continue;
    metaUses += hits.length;
    if (metaUses > 1) {
      issues.push({
        lineIndex: line.lineIndex,
        kind: "meta_vocabulary",
        detail:
          `Uses front-office abstraction(s) ${hits.map((h) => String(h).slice(1, -2)).join(", ")} — the episode's one allowed use is spent. ` +
          `Say the team, the person and what they actually did on the field instead.`,
      });
    }
  }

  return issues.sort((a, b) => a.lineIndex - b.lineIndex);
}

/**
 * One batched rewrite of the flagged lines. Mutates `segments` in place and
 * returns how many of the requested repairs were applied. Best-effort: a
 * failed call leaves the draft as it was.
 */
export async function repairListenerIssues(
  llm: LLMProvider,
  segments: ListenerCheckSegment[],
  issues: ListenerIssue[],
  systemPrompt: string
): Promise<{ requested: number; applied: number }> {
  if (!issues.length) return { requested: 0, applied: 0 };
  const byLine = new Map<number, ListenerIssue[]>();
  for (const issue of issues) byLine.set(issue.lineIndex, [...(byLine.get(issue.lineIndex) ?? []), issue]);
  const lineOf = new Map<number, ListenerCheckLine>();
  for (const seg of segments) for (const l of seg.lines) lineOf.set(l.lineIndex, l);

  const blocks = [...byLine.entries()]
    .filter(([idx]) => lineOf.has(idx))
    .map(([idx, list]) => {
      const line = lineOf.get(idx)!;
      const words = normalize(line.text).split(" ").filter(Boolean).length;
      const grows = list.some((i) => i.kind === "orientation");
      return `LINE ${idx} — ${line.speakerName} — ${words} words${grows ? " (this one may grow by up to 40 words to set the table)" : " (keep within 20% of this length)"}
  CURRENT: ${JSON.stringify(line.text)}
  PROBLEMS:
${list.map((i) => `  - [${i.kind}] ${i.detail}`).join("\n")}`;
    });
  if (!blocks.length) return { requested: 0, applied: 0 };

  const result = await withLlmStage("script:listener-repair", () =>
    llm.generateStructuredOutput<{ lines: Array<{ lineIndex: number; text: string }> }>({
      systemPrompt,
      prompt: `Rewrite ONLY the lines below so a listener who did not watch the game can follow them. Keep the speaker, the conversational action the line performs, its facts, its evidence and its tone. Speak in plain words: the team name, the person's full name, what happened. Never introduce a new statistic, quote or event. Return every listed line, rewritten.

${blocks.join("\n\n")}

Return valid JSON only: {"lines":[{"lineIndex":0,"text":"..."}]}`,
      temperature: 0.5,
      maxTokens: 6000,
      validate: (value) => {
        const lines = (value as { lines?: unknown })?.lines;
        if (!Array.isArray(lines) || !lines.length) return "Missing non-empty 'lines' array.";
        for (const l of lines as Array<Record<string, unknown>>) {
          if (!Number.isInteger(l?.lineIndex) || typeof l?.text !== "string" || !l.text.trim()) {
            return "Every entry needs an integer lineIndex and non-empty text.";
          }
        }
        return null;
      },
    })
  );

  let applied = 0;
  for (const rewrite of result.lines ?? []) {
    const line = lineOf.get(Number(rewrite.lineIndex));
    if (!line || !byLine.has(Number(rewrite.lineIndex))) continue;
    line.text = String(rewrite.text).trim();
    applied++;
  }
  return { requested: blocks.length, applied };
}
