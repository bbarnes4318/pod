// Cross-model quality judge for a generated script.
//
// A writing model must never be the only judge of its own output, and an LLM
// score on its own is not evidence either. So the quality decision is assembled
// from independent signals and reported as a BREAKDOWN, not collapsed into one
// number that hides where it came from:
//
//   1. the existing deterministic scorer (episodeQualityService) — unchanged;
//      it is not to be re-tuned to make a new model or profile win
//   2. this cross-model LLM evaluation, on the quality_judge role
//   3. factual validation, which already runs as self-verify + the fact-check
//      gate and is reported alongside
//   4. human-readable excerpts, so a reviewer can check the verdict themselves
//   5. manual editorial review during development — the final word
//
// The judge is deliberately asked about the failure modes that a single model
// writing both hosts actually produces: two voices converging, mechanical
// alternation, repeated sentence openings, agreement filler, monologues.

import { LLMProvider } from "../providers/llm/interface";
import { withLlmStage } from "../providers/llm/costLedger";
import { stripAudioTags } from "../audio/speechText";
import { ScriptQualityReport, scoreScriptQuality } from "./episodeQualityService";

export const JUDGE_AXES = [
  "hostDistinctness",
  "characterConsistency",
  "conversationalCausality",
  "spokenNaturalness",
  "mechanicalAlternation",
  "repetition",
  "genericFiller",
  "evidenceGrounding",
  "argumentProgression",
  "emotionalProgression",
  "movementContinuity",
  "callbacks",
  "closingPayoff",
  "monologueRestraint",
  "sentenceOpeningVariety",
  "agreementPhraseVariety",
  "singleModelSmell",
] as const;

export type JudgeAxis = (typeof JUDGE_AXES)[number];

export interface JudgeVerdict {
  /** 0-10 per axis. Higher is better on EVERY axis, including the negatively
   *  worded ones (mechanicalAlternation: 10 = not mechanical at all). */
  axes: Record<JudgeAxis, number>;
  /** 0-100, the judge's own overall figure. */
  overall: number;
  /** Do the two hosts read as one underlying model wearing two labels? */
  bothHostsSoundLikeOneModel: boolean;
  strengths: string[];
  weaknesses: string[];
  /** Verbatim quotes from the script supporting the weaknesses. */
  evidenceQuotes: string[];
}

export interface CombinedQualityReport {
  deterministic: ScriptQualityReport;
  judge: JudgeVerdict | null;
  /** Why the judge is null, when it is. Never silently omitted. */
  judgeError?: string;
  /** Excerpts a human reviewer can read without opening the transcript. */
  excerpts: string[];
  lineCount: number;
  wordCount: number;
}

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    axes: {
      type: "object",
      properties: Object.fromEntries(
        JUDGE_AXES.map((a) => [a, { type: "number", minimum: 0, maximum: 10 }])
      ),
      required: [...JUDGE_AXES],
    },
    overall: { type: "number", minimum: 0, maximum: 100 },
    bothHostsSoundLikeOneModel: { type: "boolean" },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    evidenceQuotes: { type: "array", items: { type: "string" } },
  },
  required: [
    "axes",
    "overall",
    "bothHostsSoundLikeOneModel",
    "strengths",
    "weaknesses",
    "evidenceQuotes",
  ],
};

const SYSTEM_PROMPT = `You are a demanding podcast script editor evaluating a two-host sports debate transcript. You did NOT write this script and you have no stake in it.

Score each axis 0-10, where 10 is best. For the negatively-framed axes, 10 means the flaw is ABSENT:
- mechanicalAlternation: 10 = turn-taking is uneven and natural; 0 = rigid A/B/A/B ping-pong.
- repetition: 10 = no point or phrasing is reused; 0 = the same argument circles back repeatedly.
- genericFiller: 10 = no sports-radio boilerplate; 0 = wall-to-wall filler.
- monologueRestraint: 10 = no unearned long speeches; 0 = essay paragraphs read aloud.
- singleModelSmell: 10 = the two hosts clearly have different minds; 0 = one voice with two name tags.

Judge what is on the page. Do not reward a script for containing podcast mannerisms — interruptions, laughs and pauses only count when the moment causes them. Quote verbatim from the transcript to support every weakness you list. Be specific and be hard to please.`;

/** Flatten a script's segments into the transcript the judge reads. */
export function scriptToTranscript(segments: any[]): { text: string; lines: number; words: number } {
  const out: string[] = [];
  let lines = 0;
  let words = 0;
  for (const seg of segments || []) {
    out.push(`\n[${seg?.type || "segment"}] ${seg?.title || ""}`.trimEnd());
    for (const line of seg?.lines || []) {
      if (!line || typeof line.text !== "string") continue;
      const spoken = stripAudioTags(line.text);
      lines++;
      words += spoken.split(/\s+/).filter(Boolean).length;
      out.push(`${line.speakerName}${line.tone ? ` (${line.tone})` : ""}: ${line.text}`);
    }
  }
  return { text: out.join("\n"), lines, words };
}

function clamp10(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

/**
 * One judge call. Returns null on any failure with the reason recorded — a judge
 * that could not run must never be reported as a score of zero.
 */
export async function judgeScriptQuality(
  judge: LLMProvider,
  segments: any[],
  context: { episodeTitle: string; hostNames: string[]; evidenceSummary?: string }
): Promise<{ verdict: JudgeVerdict | null; error?: string }> {
  const { text } = scriptToTranscript(segments);
  if (!text.trim()) return { verdict: null, error: "Script is empty — nothing to judge." };

  const prompt = `EPISODE: ${context.episodeTitle}
HOSTS: ${context.hostNames.join(" and ")}
${context.evidenceSummary ? `\nEVIDENCE THE SCRIPT WAS SUPPOSED TO USE:\n${context.evidenceSummary}\n` : ""}
TRANSCRIPT:
${text}

Return valid JSON only:
{
  "axes": { ${JUDGE_AXES.map((a) => `"${a}": 0-10`).join(", ")} },
  "overall": 0-100,
  "bothHostsSoundLikeOneModel": true|false,
  "strengths": ["..."],
  "weaknesses": ["..."],
  "evidenceQuotes": ["verbatim quote from the transcript"]
}`;

  try {
    const raw = await withLlmStage("quality:judge", () =>
      judge.generateStructuredOutput<any>({
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        temperature: 0,
        maxTokens: 4000,
        jsonSchema: JUDGE_SCHEMA,
        validate: (v) =>
          v && typeof (v as { axes?: unknown }).axes === "object"
            ? null
            : "Judge response is missing the 'axes' object.",
      })
    );

    const axes = {} as Record<JudgeAxis, number>;
    for (const a of JUDGE_AXES) axes[a] = clamp10(raw?.axes?.[a]);
    const overall = Number.isFinite(Number(raw?.overall))
      ? Math.max(0, Math.min(100, Number(raw.overall)))
      : Math.round((Object.values(axes).reduce((s, v) => s + v, 0) / (JUDGE_AXES.length * 10)) * 100);

    return {
      verdict: {
        axes,
        overall,
        bothHostsSoundLikeOneModel: raw?.bothHostsSoundLikeOneModel === true,
        strengths: Array.isArray(raw?.strengths) ? raw.strengths.map(String).slice(0, 8) : [],
        weaknesses: Array.isArray(raw?.weaknesses) ? raw.weaknesses.map(String).slice(0, 8) : [],
        evidenceQuotes: Array.isArray(raw?.evidenceQuotes) ? raw.evidenceQuotes.map(String).slice(0, 8) : [],
      },
    };
  } catch (err: any) {
    return { verdict: null, error: err?.message || String(err) };
  }
}

/**
 * Deterministic score + cross-model judge + human excerpts, reported side by
 * side. The deterministic scorer is untouched; the judge never overrides it.
 */
export async function assessScriptQuality(
  judge: LLMProvider | null,
  segments: any[],
  context: { episodeTitle: string; hostNames: string[]; evidenceSummary?: string }
): Promise<CombinedQualityReport> {
  const deterministic = scoreScriptQuality({ segments });
  const { lines, words } = scriptToTranscript(segments);

  // Excerpts: the opening exchange and the closing exchange, which is where a
  // cold open that isn't cold and a payoff that never lands are both visible.
  const flat: string[] = [];
  for (const seg of segments || []) {
    for (const line of seg?.lines || []) {
      if (line && typeof line.text === "string") flat.push(`${line.speakerName}: ${stripAudioTags(line.text)}`);
    }
  }
  const excerpts = [...flat.slice(0, 6), "…", ...flat.slice(-4)];

  if (!judge) {
    return {
      deterministic,
      judge: null,
      judgeError: "No quality_judge provider available (skipped, not scored zero).",
      excerpts,
      lineCount: lines,
      wordCount: words,
    };
  }

  const { verdict, error } = await judgeScriptQuality(judge, segments, context);
  return { deterministic, judge: verdict, judgeError: error, excerpts, lineCount: lines, wordCount: words };
}
