import type { LLMProvider } from "../providers/llm/interface";
import { withLlmStage } from "../providers/llm/costLedger";
import { stripAudioTags } from "../audio/speechText";
import { COLD_OPEN_MIN_WORDS, COLD_OPEN_MAX_WORDS } from "./productionInvariants";

export interface PrivateHostAgenda {
  speakerName: string;
  exclusiveFactResponsibility: string;
  protectedBelief: string;
  avoidedConcession: string;
  behavioralTrigger: string;
  misconceptionAboutOtherHost: string;
  genuineQuestion: string;
  privateObjective: string;
}

export interface CreativeScriptLine {
  lineIndex: number;
  speakerName: string;
  text: string;
  tone?: string;
  energy?: string;
  evidenceRefs?: unknown[];
  isFactualClaim?: boolean;
  [key: string]: unknown;
}

export interface CreativeScriptSegment {
  type?: string;
  title?: string;
  lines: CreativeScriptLine[];
  [key: string]: unknown;
}

export interface ColdOpenVariant {
  id: "accusation" | "consequence" | "contradiction";
  lines: CreativeScriptLine[];
  textScore: number;
  judgeReasons: string[];
}

export interface ColdOpenTournamentResult {
  version: number;
  targetSeconds: 45;
  selectedId: ColdOpenVariant["id"];
  variants: ColdOpenVariant[];
  selectionBasis: "independent_text_judge";
  /** The band every finalist was held to, persisted so a later rewrite that
   *  expanded the cold open can be identified after the fact. */
  wordBand?: { min: number; max: number };
  /** Why the other two candidates lost. */
  rejected?: Array<{ id: string; textScore: number; reasons: string[] }>;
  /**
   * Which route WROTE each candidate, and which route judged them.
   *
   * Persisted because "three candidates" only means something if they are
   * genuinely three. One model asked for three openings in one call produces
   * three angles on one sensibility; three providers produce three sensibilities.
   * Both are legitimate, and the difference has to be readable after the fact —
   * otherwise a tournament between three near-identical drafts looks exactly
   * like a real one in the artifact.
   */
  authorship?: {
    mode: "single_writer" | "multi_provider";
    /** variantId → provider/model that wrote it. */
    writers: Record<string, string>;
    /** Distinct writer routes that produced the field. */
    distinctWriters: string[];
    judge: string;
    /** Candidates a writer failed to produce, with the reason. Never hidden. */
    failures: Array<{ variantId: string; writer: string; error: string }>;
  };
}

/**
 * One cold-open candidate and the route asked to write it.
 *
 * The pool is how "candidates must support generation by multiple configured
 * providers" is satisfied: hand this function more than one writer and the
 * field is genuinely diverse; hand it one and nothing about today's behaviour
 * changes.
 */
export interface ColdOpenWriterAssignment {
  variantId: (typeof IDS)[number];
  provider: LLMProvider;
  /** provider/model, for provenance. Never a credential. */
  label: string;
}

const IDS = ["accusation", "consequence", "contradiction"] as const;

function validateAgendas(value: unknown): string | null {
  const parsed = value as { agendas?: PrivateHostAgenda[] };
  if (!Array.isArray(parsed?.agendas)) return "Missing agendas array.";
  for (const agenda of parsed.agendas) {
    if (!agenda || typeof agenda.speakerName !== "string") return "Every agenda needs speakerName.";
    for (const key of ["exclusiveFactResponsibility", "protectedBelief", "avoidedConcession", "behavioralTrigger", "misconceptionAboutOtherHost", "genuineQuestion", "privateObjective"] as const) {
      if (typeof agenda[key] !== "string" || !agenda[key].trim()) return `Agenda ${agenda.speakerName} is missing ${key}.`;
    }
  }
  return null;
}

export async function generatePrivateHostAgendas(input: {
  llm: LLMProvider;
  episodeTitle: string;
  speakerNames: string[];
  outline: unknown;
  topicsEvidence: string;
  systemPrompt: string;
}): Promise<PrivateHostAgenda[]> {
  const result = await withLlmStage("script:private-agendas", () =>
    input.llm.generateStructuredOutput<{ agendas: PrivateHostAgenda[] }>({
      systemPrompt: `${input.systemPrompt}\n\nYou are now the private showrunner. These agenda packets are NEVER spoken, shown to the other character, or treated as facts. They create asymmetric knowledge, wants, mistakes and pressure. Never invent an exclusive fact: assign responsibility for introducing only a fact present in the supplied evidence.`,
      prompt: `Build one PRIVATE agenda for each of ${input.speakerNames.join(" and ")} for episode ${JSON.stringify(input.episodeTitle)}.\n\nSTORY SPINE:\n${JSON.stringify(input.outline)}\n\nEVIDENCE:\n${input.topicsEvidence}\n\nThe agendas must conflict without turning either host into a designated straight man. Their genuine questions must be answerable by the conversation, while the misconceptions may be corrected. Return JSON only: {"agendas":[{"speakerName":"...","exclusiveFactResponsibility":"...","protectedBelief":"...","avoidedConcession":"...","behavioralTrigger":"...","misconceptionAboutOtherHost":"...","genuineQuestion":"...","privateObjective":"..."}]}`,
      temperature: 0.45,
      maxTokens: 4500,
      validate: validateAgendas,
    })
  );
  // Every active host must have a REAL packet. Substituting boilerplate for a
  // host the model failed to name destroys the asymmetry this stage exists to
  // create, while leaving a persisted `privateAgendas` blob that looks fully
  // populated — the agendas were the one thing nobody could tell had gone
  // missing. A missing packet is now a stage failure, which the caller turns
  // into a retry and then an editorial hold.
  const byName = new Map((result.agendas || []).map((a) => [a.speakerName.toLowerCase(), a]));
  const resolved = input.speakerNames.map((speakerName) => ({
    speakerName,
    agenda: byName.get(speakerName.toLowerCase()) || null,
  }));
  const missing = resolved.filter((r) => !r.agenda).map((r) => r.speakerName);
  if (missing.length) {
    throw new Error(
      `Private agenda generation did not return a packet for: ${missing.join(", ")}. ` +
        `Returned packets: ${(result.agendas || []).map((a) => a.speakerName).join(", ") || "none"}.`
    );
  }
  return resolved.map((r) => r.agenda!);
}

function spokenWords(lines: CreativeScriptLine[]): number {
  return lines.reduce((sum, line) => sum + stripAudioTags(String(line?.text || "")).split(/\s+/).filter(Boolean).length, 0);
}

/**
 * The bar ONE candidate has to clear. Shared by the single-call path and the
 * per-provider path so a multi-provider field is held to exactly the same
 * standard as a single writer's three — a diverse field of bad openings is not
 * an improvement.
 */
function validateOneColdOpen(variant: { id?: string; lines?: CreativeScriptLine[] }): string | null {
  if (!Array.isArray(variant.lines) || variant.lines.length < 3) return `${variant.id} needs at least three lines.`;
  const words = spokenWords(variant.lines);
  if (words < COLD_OPEN_MIN_WORDS || words > COLD_OPEN_MAX_WORDS) {
    return `${variant.id} has ${words} words; required range is ${COLD_OPEN_MIN_WORDS}-${COLD_OPEN_MAX_WORDS}.`;
  }
  // A cold open that greets, introduces, or summarises is not a cold open at
  // any word count.
  const joined = variant.lines.map((l) => String(l?.text || "")).join(" ").toLowerCase();
  if (/\b(welcome (back )?to|you're listening to|thanks for (tuning|joining)|hello and welcome|i'm your host|on today's (show|episode)|coming up on)\b/.test(joined)) {
    return `${variant.id} opens with a greeting or show description; it must start mid-argument.`;
  }
  return null;
}

function validateColdOpenDraft(value: unknown): string | null {
  const parsed = value as { variants?: Array<{ id?: string; lines?: CreativeScriptLine[] }> };
  if (!Array.isArray(parsed?.variants) || parsed.variants.length !== 3) return "Exactly three cold-open variants are required.";
  const seen = new Set(parsed.variants.map((v) => v.id));
  if (IDS.some((id) => !seen.has(id))) return "Cold opens must be accusation, consequence and contradiction.";
  for (const variant of parsed.variants) {
    const failure = validateOneColdOpen(variant);
    if (failure) return failure;
  }
  return null;
}

/** What each of the three angles is asked to do. One place, both paths. */
const COLD_OPEN_ANGLES: Record<(typeof IDS)[number], string> = {
  accusation: "one host directly challenges the other's judgment",
  consequence: "begin with the most concrete human cost",
  contradiction: "begin with two evidence-backed facts that should not comfortably coexist",
};

function coldOpenSystemPrompt(base: string): string {
  return `${base}\n\nThis is a dedicated cold-open room. Write only the first 45 seconds. No greeting, show description, throat-clearing, scene label, or "today we're discussing". Start in motion. Each host owns only their private agenda; do not make either character recite the other's internal objective.`;
}

function coldOpenLineContract(speakerNames: string[]): string {
  return `Use ${COLD_OPEN_MIN_WORDS}-${COLD_OPEN_MAX_WORDS} spoken words and at least three turns. Every line must contain lineIndex, speakerName, text, tone, energy, pauseBefore, isInterruption, evidenceRefs, isFactualClaim and needsHumanReview. An evidenceRefs entry is a typed record pointer — {"type":"newsItem","id":"..."} — copied EXACTLY from the evidenceRefs already attached to the facts in the supplied evidence. A quoted phrase, a number, or a source name in that field is NOT a reference: the pipeline deletes anything that is not a {type,id} object it recognises, leaving the claim unsupported. Any line with "isFactualClaim":true must carry at least one such object; if you cannot point a specific at one, do not state that specific and leave "isFactualClaim":false. Legal speakers: ${speakerNames.join(", ")}.`;
}

/**
 * ONE candidate from ONE route.
 *
 * Used only on the multi-provider path. The prompt is the single-call prompt
 * narrowed to a single angle — deliberately the same instructions, so a
 * difference between two candidates is a difference between two models rather
 * than a difference between two prompts.
 */
async function generateOneColdOpenVariant(
  assignment: ColdOpenWriterAssignment,
  input: {
    episodeTitle: string;
    coldOpenBeat: unknown;
    topicsEvidence: string;
    speakerNames: string[];
    agendas: PrivateHostAgenda[];
    systemPrompt: string;
  }
): Promise<{ id: (typeof IDS)[number]; lines: CreativeScriptLine[] }> {
  // Same cache-stable split as the host writers: the beat, the agendas and the
  // evidence packet are identical across all three angles, and only the angle
  // itself and the output contract vary. The saving is CONDITIONAL here — the
  // three angles are deliberately spread across different routes when a writer
  // pool is configured, and a cache is per-model, so a read only lands when two
  // angles happen to share a route. Structuring it correctly costs nothing and
  // pays whenever they do.
  const cacheableStatic = `COLD-OPEN BEAT:\n${JSON.stringify(input.coldOpenBeat)}\n\nPRIVATE AGENDAS (keep separate):\n${input.agendas
    .map((a) => `${a.speakerName}: ${JSON.stringify(a)}`)
    .join("\n")}\n\nEVIDENCE:\n${input.topicsEvidence}`;

  const result = await withLlmStage(`script:cold-open-variant:${assignment.variantId}`, () =>
    assignment.provider.generateStructuredOutput<{ lines: CreativeScriptLine[] }>({
      systemPrompt: coldOpenSystemPrompt(input.systemPrompt),
      cacheableContext: cacheableStatic,
      prompt: `Write ONE 45-second opening for ${JSON.stringify(input.episodeTitle)} on this angle:\n${assignment.variantId} — ${COLD_OPEN_ANGLES[assignment.variantId]}.\n\n${coldOpenLineContract(input.speakerNames)} Return JSON only: {"lines":[]}`,
      temperature: 0.9,
      maxTokens: 4000,
      validate: (value) =>
        validateOneColdOpen({ id: assignment.variantId, lines: (value as { lines?: CreativeScriptLine[] })?.lines }),
    })
  );
  return { id: assignment.variantId, lines: result.lines };
}

interface ColdOpenJudgment { id: string; score: number; reasons: string[] }

export async function runColdOpenTextTournament(input: {
  writer: LLMProvider;
  /**
   * OPTIONAL distinct routes to spread the three candidates across.
   *
   * Omitted or holding fewer than two distinct labels, the single-call path runs
   * and nothing about today's behaviour changes. With two or more, each angle is
   * written by its own route — which is the only way three candidates are three
   * opinions rather than one model's three moods.
   */
  writerPool?: ColdOpenWriterAssignment[];
  /** provider/model of `writer`, for the authorship record. */
  writerLabel?: string;
  judge: LLMProvider;
  /** provider/model of `judge`, for the authorship record. */
  judgeLabel?: string;
  episodeTitle: string;
  coldOpenBeat: unknown;
  topicsEvidence: string;
  speakerNames: string[];
  agendas: PrivateHostAgenda[];
  systemPrompt: string;
  learningPolicy?: unknown;
}): Promise<{ segment: CreativeScriptSegment; tournament: ColdOpenTournamentResult }> {
  const distinctPoolLabels = [...new Set((input.writerPool ?? []).map((a) => a.label))];
  const multiProvider = distinctPoolLabels.length >= 2;

  const writers: Record<string, string> = {};
  const failures: Array<{ variantId: string; writer: string; error: string }> = [];
  let variantDrafts: Array<{ id: ColdOpenVariant["id"]; lines: CreativeScriptLine[] }>;

  if (multiProvider) {
    // One call per angle, so a candidate that fails is that ROUTE's failure and
    // is recorded as such. Settled rather than raced: one provider being down
    // must cost its own candidate, never the whole tournament.
    const assignments = input.writerPool!;
    const settled = await Promise.all(
      assignments.map(async (assignment) => {
        try {
          const variant = await generateOneColdOpenVariant(assignment, input);
          return { assignment, variant, error: null as string | null };
        } catch (err) {
          return { assignment, variant: null, error: (err as Error).message };
        }
      })
    );
    variantDrafts = [];
    for (const outcome of settled) {
      if (outcome.variant) {
        variantDrafts.push(outcome.variant);
        writers[outcome.variant.id] = outcome.assignment.label;
      } else {
        failures.push({
          variantId: outcome.assignment.variantId,
          writer: outcome.assignment.label,
          error: String(outcome.error),
        });
      }
    }
    // Two survivors is the floor. A "tournament" with one entrant is a single
    // draft wearing a rosette, and persisting it as a tournament result would
    // make the selection look contested when nothing was compared.
    if (variantDrafts.length < 2) {
      throw new Error(
        `The cold-open tournament needs at least two candidates; ${variantDrafts.length} survived. ` +
          failures.map((f) => `${f.variantId} (${f.writer}): ${f.error}`).join(" | ")
      );
    }
  } else {
    const draft = await withLlmStage("script:cold-open-variants", () =>
      input.writer.generateStructuredOutput<{ variants: Array<{ id: ColdOpenVariant["id"]; lines: CreativeScriptLine[] }> }>({
        systemPrompt: coldOpenSystemPrompt(input.systemPrompt),
        prompt: `Create three COMPLETELY DIFFERENT 45-second openings for ${JSON.stringify(input.episodeTitle)}:\n1. accusation — ${COLD_OPEN_ANGLES.accusation};\n2. consequence — ${COLD_OPEN_ANGLES.consequence};\n3. contradiction — ${COLD_OPEN_ANGLES.contradiction}.\n\nCOLD-OPEN BEAT:\n${JSON.stringify(input.coldOpenBeat)}\n\nPRIVATE AGENDAS (keep separate):\n${input.agendas.map((a) => `${a.speakerName}: ${JSON.stringify(a)}`).join("\n")}\n\nEVIDENCE:\n${input.topicsEvidence}\n\n${coldOpenLineContract(input.speakerNames)} Return JSON only: {"variants":[{"id":"accusation","lines":[]},{"id":"consequence","lines":[]},{"id":"contradiction","lines":[]}]}`,
        temperature: 0.9,
        maxTokens: 8000,
        validate: validateColdOpenDraft,
      })
    );
    variantDrafts = draft.variants;
    const label = input.writerLabel || "(unlabelled writer)";
    for (const variant of variantDrafts) writers[variant.id] = label;
  }

  const draft = { variants: variantDrafts };

  const judgments = await withLlmStage("script:cold-open-judge", () =>
    input.judge.generateStructuredOutput<{ judgments: ColdOpenJudgment[] }>({
      systemPrompt: "You are an independent podcast cold-open judge. You do not reward volume, famous names, greetings, or generic drama. Reward an immediate open loop, specific consequence, unmistakable characters, causal back-and-forth, evidence integrity, and lines that will perform well aloud.",
      // The candidates go to the judge as bare {id, lines} — no writer label,
      // no provider name, no ordering signal. Telling a judge which lab wrote
      // which opening would turn a craft comparison into a brand preference,
      // and that matters far more now that the field can come from three
      // different providers.
      prompt: `Blind-rank these ${draft.variants.length} openings. Score each 0-100. Penalize any unsupported claim, exposition, interchangeable host voice, or answer revealed too early.\n\nSHOW-SPECIFIC LEARNING POLICY (soft prior only; never force a winner, never override this episode's evidence or character fit):\n${JSON.stringify(input.learningPolicy || null)}\n\n${JSON.stringify(draft.variants)}\n\nReturn JSON only: {"judgments":[{"id":"accusation","score":0,"reasons":["..."]}]}`,
      temperature: 0,
      maxTokens: 3000,
      validate: (value) => {
        const parsed = value as { judgments?: ColdOpenJudgment[] };
        if (!Array.isArray(parsed?.judgments)) return "A judgments array is required.";
        // One judgement per SURVIVING candidate. Hardcoding three would fail the
        // whole tournament whenever one provider in the pool was down, which is
        // the moment the other two candidates matter most.
        if (parsed.judgments.length !== draft.variants.length) {
          return `Exactly ${draft.variants.length} judgments are required, one per candidate.`;
        }
        const ids = new Set(parsed.judgments.map((j) => j?.id));
        const missing = draft.variants.filter((v) => !ids.has(v.id)).map((v) => v.id);
        return missing.length ? `No judgment returned for: ${missing.join(", ")}.` : null;
      },
    })
  );
  const judged = new Map(judgments.judgments.map((j) => [j.id, j]));
  const variants: ColdOpenVariant[] = draft.variants.map((variant) => ({
    ...variant,
    textScore: Math.max(0, Math.min(100, Number(judged.get(variant.id)?.score) || 0)),
    judgeReasons: judged.get(variant.id)?.reasons || [],
  }));
  variants.sort((a, b) => b.textScore - a.textScore);
  const selected = variants[0];
  return {
    // The title carries the selected variant so a finished artifact can be
    // traced back to the tournament. A generic hardcoded "Cold open" was what
    // made episode e7867729 ambiguous: its artifact read "Cold Open: The Empty
    // Seats", which no tournament path can produce, and that mismatch was the
    // only visible sign the creative pipeline had been bypassed entirely.
    segment: { type: "cold_open", title: `Cold open (${selected.id})`, lines: selected.lines },
    tournament: {
      version: 2,
      targetSeconds: 45,
      selectedId: selected.id,
      variants,
      selectionBasis: "independent_text_judge",
      wordBand: { min: COLD_OPEN_MIN_WORDS, max: COLD_OPEN_MAX_WORDS },
      rejected: variants.slice(1).map((v) => ({
        id: v.id,
        textScore: v.textScore,
        reasons: v.judgeReasons,
      })),
      authorship: {
        mode: multiProvider ? "multi_provider" : "single_writer",
        writers,
        distinctWriters: [...new Set(Object.values(writers))],
        judge: input.judgeLabel || "(unlabelled judge)",
        failures,
      },
    },
  };
}

// =====================================================================
// SEVEN-ROLE PIPELINE STAGE HELPERS
//
// One exported function per LLM-calling role. They compose prompts and validate
// responses; they do NOT decide whether a stage passed. Every structural
// guarantee — authorship filtering, brief isolation, the director's bounds —
// lives in scriptSevenRolePipeline.ts, where it can be enforced on the returned
// data instead of requested in a prompt.
// =====================================================================

export interface EpisodeSpine {
  /** What this episode is actually about, in one sentence. */
  aboutInOneSentence: string;
  /** The one question the hosts cannot settle by agreeing. */
  unresolvedQuestion: string;
  whyItMattersToAListener: string;
  /** What evidence or event would actually settle the question. */
  whatWouldSettleIt: string;
  hostStakes: Array<{ speakerName: string; stake: string }>;
  /** Framings the story editor rejected, so the architect cannot drift back. */
  rejectedFrames: string[];
}

function validateSpine(value: unknown): string | null {
  const spine = (value as { spine?: Partial<EpisodeSpine> })?.spine;
  if (!spine || typeof spine !== "object") return "Missing 'spine' object.";
  for (const key of ["aboutInOneSentence", "unresolvedQuestion", "whyItMattersToAListener", "whatWouldSettleIt"] as const) {
    if (typeof spine[key] !== "string" || !String(spine[key]).trim()) return `Spine is missing ${key}.`;
  }
  if (!Array.isArray(spine.hostStakes) || spine.hostStakes.length < 2) {
    return "Spine needs a stake for each host.";
  }
  return null;
}

/**
 * ROLE 1 — STORY EDITOR.
 *
 * Deliberately produces NO structure and NO dialogue. Its entire output is the
 * decision every later role is held to: what the episode is about, and what is
 * unresolved. Merging this into the outline call is what let episodes become a
 * competent list of beats about nothing in particular.
 */
export async function pickStorySpine(input: {
  llm: LLMProvider;
  episodeTitle: string;
  speakerNames: string[];
  topicsEvidence: string;
  targetDuration: number;
  systemPrompt: string;
}): Promise<EpisodeSpine> {
  const result = await withLlmStage("script:story-spine", () =>
    input.llm.generateStructuredOutput<{ spine: EpisodeSpine }>({
      systemPrompt: `${input.systemPrompt}\n\nYou are the STORY EDITOR. You do not write dialogue, beats, or jokes. You decide what this episode is about and what it refuses to resolve. A story whose question can be answered by both hosts agreeing is not a story.`,
      prompt: `Episode ${JSON.stringify(input.episodeTitle)} runs roughly ${input.targetDuration} minutes with ${input.speakerNames.join(" and ")}.

EVIDENCE AVAILABLE:
${input.topicsEvidence}

Decide:
- What this episode is ACTUALLY about — not the headline, the thing underneath it.
- The ONE unresolved question. It must be answerable in principle and unanswerable tonight.
- Why a listener who does not already care should care.
- What would actually settle it, so the hosts can name what they do not have.
- What is personally at stake for each host. The stakes must differ; if both hosts want the same thing there is no episode.
- Framings you are REJECTING, so nobody downstream drifts back into them.

Return valid JSON only:
{"spine":{"aboutInOneSentence":"...","unresolvedQuestion":"...","whyItMattersToAListener":"...","whatWouldSettleIt":"...","hostStakes":[{"speakerName":"...","stake":"..."}],"rejectedFrames":["..."]}}`,
      temperature: 0.5,
      maxTokens: 2500,
      validate: validateSpine,
    })
  );
  const spine = result.spine;
  return {
    aboutInOneSentence: String(spine.aboutInOneSentence).trim(),
    unresolvedQuestion: String(spine.unresolvedQuestion).trim(),
    whyItMattersToAListener: String(spine.whyItMattersToAListener).trim(),
    whatWouldSettleIt: String(spine.whatWouldSettleIt).trim(),
    hostStakes: (spine.hostStakes || []).map((s) => ({
      speakerName: String(s?.speakerName || "").trim(),
      stake: String(s?.stake || "").trim(),
    })),
    rejectedFrames: Array.isArray(spine.rejectedFrames) ? spine.rejectedFrames.map(String).slice(0, 6) : [],
  };
}

/** One planned turn. Public: both host writers see the whole plan, because a
 *  writer who cannot see what the other host is about to DO cannot write a
 *  causal reply. What they never see is the other host's PRIVATE brief. */
export interface TurnPlanEntry {
  turnIndex: number;
  beatIndex: number;
  speakerName: string;
  /** What this turn does to the conversation. Not the words — the action. */
  intent: string;
  factRefs: Array<{ type: string; id: string }>;
  targetWords: number;
}

/**
 * Words per turn assumed when converting an episode's word target into a turn
 * count. A real two-host argument mixes four-word interruptions with sixty-word
 * arguments; this is the blended average, not a per-turn instruction.
 *
 * WHY IT IS DELIBERATELY LOW: the alternative to more turns is longer turns, and
 * longer turns are how a conversation becomes two monologues. Filling eight
 * minutes with fifteen speeches is worse than filling it with forty exchanges,
 * even though both hit the word count.
 *
 * 27 IS MEASURED, NOT CHOSEN. Two full runs on 2026-08-06 landed within a word
 * of each other — 411 words over 15 turns (27.4) and 720 over 27 (26.7) — with
 * different models on each host. The first value here was a guessed 40, which
 * under-planned the turn count by a third and produced an episode that died at
 * the word floor after every role had run.
 *
 * It also agrees with the clock, which is the real constraint: 27 words at
 * ordinary speech pace is about eleven seconds, and an eight-minute episode is
 * roughly forty-three eleven-second exchanges. If a future change makes the
 * writers verbose, re-measure rather than re-guess.
 */
const ASSUMED_WORDS_PER_TURN = 27;

/**
 * Most a turn plan may be strict A/B alternation.
 *
 * The production invariant `mechanicalAlternation` holds an episode at 0.65.
 * This is tighter on purpose: the plan is upstream of the host writers and the
 * dialogue director, both of which can shift the ratio, so the plan needs
 * headroom rather than sitting exactly on the line it must not cross.
 */
const PLAN_ALTERNATION_CEILING = 0.55;

/** The turn floor an episode's word target implies. */
export function minimumTurnsFor(totalWordTarget: number): number {
  return Math.max(8, Math.ceil(totalWordTarget / ASSUMED_WORDS_PER_TURN));
}

/**
 * Output allowance for the turn plan, sized from how many turns it must contain.
 *
 * A plan is one JSON object per turn — turnIndex, beatIndex, speakerName, an
 * intent sentence, factRefs, targetWords — which runs about 160 tokens once a
 * real intent is written. The floor is generous because the cost of being too
 * low is not a shorter plan but a TRUNCATED one: invalid JSON, a wasted repair,
 * and then the router walking its entire fallback chain.
 *
 * 30% headroom over the floor, because the model may plan more turns than the
 * minimum and should not be punished for it.
 */
export function turnPlanMaxTokens(totalWordTarget: number): number {
  const turns = minimumTurnsFor(totalWordTarget);
  // 340 tokens per turn is MEASURED, not estimated. claude-opus-5 emitted 15,192
  // output tokens for a ~43-turn plan in production on 2026-08-08 — it writes
  // long, specific intents, which is the behaviour we want and roughly double
  // what a first estimate of 160 assumed.
  //
  // Erring high is nearly free and erring low is ruinous: an over-generous cap
  // costs nothing when the model stops early, while a cap one token short
  // produces invalid JSON, a wasted repair, and a walk down the whole fallback
  // chain. That asymmetry is why this is set from the largest observation
  // rather than the average.
  return Math.max(7000, Math.ceil(turns * 340 * 1.25) + 2000);
}

/**
 * One sentence. See the enforcement in makeTurnPlanValidator for why this is a
 * hard limit rather than prompt advice.
 */
export const MAX_INTENT_WORDS = 25;

export interface TurnPlanValidatorOptions {
  /**
   * How many attempts the RHYTHM STATISTICS get to be fatal before they become
   * a recorded warning. Default Infinity — they never stop being fatal, which
   * is what every direct test of this function asserts.
   *
   * WHY A BUDGET EXISTS AT ALL. The rhythm rules below are a joint constraint on
   * the speaker sequence: mean run length at least 1.82, no run length over 70%
   * of the plan, threes at most one in five. The feasible band is narrow (see
   * test:conversation-rhythm, which had to construct a passing fixture by hand),
   * and hitting it is arithmetic rather than authorship. A frontier model lands
   * in it; gpt-oss-120b, which is what the FREE tier has for this role, often
   * does not.
   *
   * The comment further down says these rules are enforced here because "a
   * repair costs one call, and there it costs a whole episode". That was true
   * when the chain below this role ended in a paid model. On the free tier the
   * chain is two free rungs and then nothing — so a rhythm statistic the model
   * cannot hit does not cost one call, it costs the episode, after every earlier
   * role has already run. That is a worse outcome than a plan whose pacing is
   * uneven, which the dialogue director and the downstream mechanical-alternation
   * invariant both still see.
   *
   * So: the model gets a real, honest attempt plus its repair. After that a
   * structurally sound plan is taken, and the violation is logged rather than
   * thrown. Nothing about CONTENT is relaxed — turn count, intent length, legal
   * speakers and the four-in-a-row rule stay fatal on every attempt, because
   * each of those breaks the episode itself rather than its pacing.
   */
  rhythmAttempts?: number;
}

export function makeTurnPlanValidator(totalWordTarget: number, opts: TurnPlanValidatorOptions = {}) {
  const minTurns = minimumTurnsFor(totalWordTarget);
  const rhythmAttempts = opts.rhythmAttempts ?? Number.POSITIVE_INFINITY;
  let attempt = 0;
  return function validateTurnPlan(value: unknown): string | null {
    attempt++;
    const turns = (value as { turns?: unknown })?.turns;
    if (!Array.isArray(turns) || turns.length === 0) return "Missing non-empty 'turns' array.";
    for (const turn of turns as Array<Record<string, unknown>>) {
      if (typeof turn?.speakerName !== "string" || !turn.speakerName.trim()) return "Every turn needs a speakerName.";
      if (typeof turn?.intent !== "string" || !turn.intent.trim()) return "Every turn needs an intent.";

      // INTENT LENGTH IS ENFORCED, and it is a cost AND a craft control.
      //
      // MEASURED 2026-08-10: the turn plan emitted 24,486 output tokens for one
      // episode — 28% of that episode's entire model output, for an artefact
      // that ships ZERO words. turnPlanMaxTokens' own comment records 340 output
      // tokens per turn as the observed rate: roughly 255 words of prose for a
      // field specified as "the conversational ACTION".
      //
      // It costs twice over, because the plan is not just output here — it is
      // INPUT to both host writers on every movement call, so a bloated intent
      // is billed once when written and again on each read.
      //
      // The craft argument is the stronger one. A 255-word instruction for a
      // single beat is padding, and padding is where the flat AI cadence comes
      // from: a writer handed a paragraph tends to render the paragraph instead
      // of playing the beat. "Concede the attendance point, then press on who
      // signed off" is eleven words and leaves the writer somewhere to go.
      const intentWords = turn.intent.trim().split(/\s+/).length;
      if (intentWords > MAX_INTENT_WORDS) {
        return (
          `A turn intent runs ${intentWords} words; the limit is ${MAX_INTENT_WORDS}. ` +
          `An intent is the conversational ACTION this turn performs on the one before it — ` +
          `one sentence, not a paragraph. Write "concede the attendance point, then press on who ` +
          `signed off", not an essay about why the turn matters. The offending intent begins: ` +
          `"${turn.intent.trim().slice(0, 80)}..."`
        );
      }
    }
    // ENFORCED, not merely requested. An under-planned turn count cannot be
    // recovered downstream: the host writers each write only the turns they were
    // given, so a short plan guarantees a short episode and the whole run dies
    // at the word floor after every role has already been paid for. Observed
    // 2026-08-06: an 8-minute episode planned with 15 turns produced 411 spoken
    // words against a 951 floor, and every candidate model failed the same way.
    // No speaker holds the floor three times running.
    //
    // The prompt says a host "may hold two or three consecutive turns when the
    // pressure warrants it", and three is one too many. OBSERVED 2026-08-06:
    // Mulkey took three in a row and the third one asked ZABALA a question —
    // the character interrogating himself, because there was no turn between
    // them for Zabala to answer in. Two consecutive turns is a person pressing
    // a point; three is a monologue that forgot the other chair.
    // THE TWO RULES BELOW USED TO HAVE EXACTLY ONE SOLUTION.
    //
    // A hard cap of two consecutive turns, combined with the alternation
    // ceiling further down, is not two independent constraints — it is a
    // simultaneous equation. If every run has length r, alternation is 1/r, so
    // an alternation ceiling of 0.55 demands r >= 1.82. With r capped at 2 the
    // only satisfying plan is runs of EXACTLY TWO, forever. The prompt then
    // said so out loud ("EXACTLY TWO in a row is the tool") and the architect
    // obliged: episode 0c90db5b ran 28 of its 39 speaker runs at length two,
    // AA BB AA BB for sixty straight lines. Fixing one-line ping-pong had
    // simply moved the metronome down an octave, and the owner heard it.
    //
    // Runs of three are allowed again, but kept RARE — the original objection
    // to them was real (a host took three turns and used the third to ask the
    // absent host a question). Rare threes are what let the plan hit the
    // alternation ceiling with VARIED run lengths instead of uniform pairs.
    const runLengths: number[] = [];
    let run = 1;
    for (let i = 1; i < turns.length; i++) {
      const prev = String((turns[i - 1] as Record<string, unknown>).speakerName || "").toLowerCase();
      const here = String((turns[i] as Record<string, unknown>).speakerName || "").toLowerCase();
      if (here === prev) {
        run += 1;
        if (run > 3) {
          return (
            `${(turns[i] as Record<string, unknown>).speakerName} holds four consecutive turns ` +
            `(around turn ${i}). Give the other host a turn — by the fourth there is nobody in the other chair.`
          );
        }
      } else {
        runLengths.push(run);
        run = 1;
      }
    }
    runLengths.push(run);

    // THE THREE RULES BELOW ARE STATISTICS ABOUT PACING, not statements about
    // whether the plan is usable — see TurnPlanValidatorOptions.rhythmAttempts
    // for why that distinction is now load-bearing. They are grouped into one
    // function so the decision "fatal, or logged?" is made once, in one place,
    // instead of being spread across three early returns.
    const rhythmViolation = (): string | null => {
      const threeRuns = runLengths.filter((r) => r === 3).length;
      if (runLengths.length >= 6 && threeRuns > Math.ceil(runLengths.length * 0.2)) {
        return (
          `${threeRuns} of ${runLengths.length} speaker runs are three turns long; keep three-turn runs to at ` +
          `most one in five. Three consecutive turns is a rare escalation, not a default.`
        );
      }

      // Rhythm must VARY. This is the rule whose absence let the plan collapse
      // into uniform pairs while satisfying every other constraint perfectly.
      if (runLengths.length >= 8) {
        const histogram = new Map<number, number>();
        for (const r of runLengths) histogram.set(r, (histogram.get(r) ?? 0) + 1);
        let modalLength = 0;
        let modalCount = 0;
        for (const [length, count] of histogram) {
          if (count > modalCount) { modalLength = length; modalCount = count; }
        }
        if (modalCount / runLengths.length > 0.7) {
          return (
            `${modalCount} of ${runLengths.length} speaker runs are exactly ${modalLength} turn(s) long — ` +
            `that is a metronome, not a conversation. Vary the rhythm: mix single sharp reactions, pairs that ` +
            `land a claim and press it, and the occasional third turn when the pressure genuinely warrants it. ` +
            `No single run length may cover more than 70% of the plan.`
          );
        }
      }

      // ...and no speaker may merely PING-PONG either.
      //
      // The no-three-in-a-row rule above, alone, pushed the architect straight
      // into the opposite wall: it produced 95.3% strict A/B alternation, which
      // trips the mechanicalAlternation production invariant (ceiling 65%) and put
      // a finished episode on editorial hold AFTER all seven roles had run.
      //
      // Two rules of mine were fighting: one forbade runs of three, and nothing
      // said that never running two was equally wrong. A plan of pure alternation
      // satisfies "no three in a row" perfectly while being exactly the mechanical
      // ping-pong the show is trying not to sound like.
      //
      // Enforced HERE rather than left to the downstream gate because here a
      // repair costs one call, and there it costs a whole episode. The plan
      // ceiling is deliberately tighter than the invariant's 0.65 so the writers
      // and the dialogue director have room to move without crossing it.
      if (turns.length > 1) {
        let switches = 0;
        for (let i = 1; i < turns.length; i++) {
          const prev = String((turns[i - 1] as Record<string, unknown>).speakerName || "").toLowerCase();
          const here = String((turns[i] as Record<string, unknown>).speakerName || "").toLowerCase();
          if (here !== prev) switches++;
        }
        const alternation = switches / (turns.length - 1);
        if (alternation > PLAN_ALTERNATION_CEILING) {
          return (
            `${(alternation * 100).toFixed(0)}% of this plan is strict A/B alternation; keep it at or under ` +
            `${(PLAN_ALTERNATION_CEILING * 100).toFixed(0)}%. Let a host hold the floor for a second turn — ` +
            `land a claim, then press it — instead of trading single lines. Vary the run lengths rather than ` +
            `converting every run to a pair: uniform pairs are the same metronome one octave down.`
          );
        }
      }

      return null;
    };

    const rhythm = rhythmViolation();
    if (rhythm) {
      if (attempt <= rhythmAttempts) return rhythm;
      // The model has had its attempt and its repair and still cannot land in
      // the band. Taking the plan is the lesser failure: pacing is visible to
      // the dialogue director and to the mechanicalAlternation invariant further
      // down, while a rejection here ends the episode with nothing to look at.
      console.warn(
        `[TurnPlan] ACCEPTING a plan that misses the rhythm band after ${attempt} attempts — ${rhythm} ` +
          `The plan is structurally sound (turn count, intents and speakers all valid), so it is used rather ` +
          `than failing the episode over pacing. Expect a flatter conversation from this one.`
      );
    }

    if (turns.length < minTurns) {
      return (
        `The plan has ${turns.length} turns, but this episode needs at least ${minTurns} to reach ` +
        `${totalWordTarget} spoken words at a natural conversational pace. Add turns — do not make the ` +
        `existing ones longer, which produces monologues rather than an argument.`
      );
    }
    return null;
  };
}

/**
 * ROLE 2 — DEBATE ARCHITECT, turn allocation half.
 *
 * The output is the contract between the two host writers: who speaks when,
 * what each turn has to accomplish, and which evidence that turn is allowed to
 * introduce. Without it, two writers working from separate briefs produce two
 * monologues that never meet.
 */
export async function planDebateTurns(input: {
  llm: LLMProvider;
  episodeTitle: string;
  speakerNames: string[];
  spine: EpisodeSpine;
  beats: unknown[];
  topicsEvidence: string;
  systemPrompt: string;
  totalWordTarget: number;
}): Promise<TurnPlanEntry[]> {
  const result = await withLlmStage("script:turn-plan", () =>
    input.llm.generateStructuredOutput<{ turns: TurnPlanEntry[] }>({
      systemPrompt: `${input.systemPrompt}\n\nYou are the DEBATE ARCHITECT. You allocate turns and evidence. You never write spoken words — an "intent" that contains a quotable sentence is a failure of this role, because two different writers have to be able to write that turn in their own character's voice.`,
      prompt: `Allocate the turns for ${JSON.stringify(input.episodeTitle)}.

SPINE (already decided — serve it, do not replace it):
${JSON.stringify(input.spine, null, 2)}

BEATS (each turn belongs to exactly one):
${JSON.stringify(input.beats, null, 2)}

EVIDENCE:
${input.topicsEvidence}

RULES:
- Speakers are exactly: ${input.speakerNames.join(", ")}. Beat 0 (the cold open) is already written — start at beat 1.
- RHYTHM MUST VARY, and this is measured three ways. (a) No more than ${(PLAN_ALTERNATION_CEILING * 100).toFixed(0)}% of adjacent turns may change speaker — trading single lines back and forth for a whole episode is ping-pong, not an argument. (b) No single run length may cover more than 70% of the plan: a script where almost every run is one turn is a metronome, and so is a script where almost every run is two. Both are rejected. (c) At most one run in five may be three turns long, and no host may hold four. Mix them: a single sharp reaction, a pair that lands a claim then presses it, occasionally a third turn when the pressure genuinely warrants it. When you do write three, the third turn must still be aimed at the other host — never a question the absent host is expected to answer. A one-word reaction is a legitimate turn.
- The two hosts must NOT end up with the same number of turns. Turn count follows who has something to say.
- Assign each evidence fact to at most ONE turn, on the beat that already owns it.
- "intent" is the conversational ACTION: what this turn does to the previous one and what it changes. Never dialogue, never a quotable line. ONE SENTENCE, ${MAX_INTENT_WORDS} WORDS MAXIMUM — this is validated and a longer intent fails the whole plan. An intent is a direction for the writer, not a description of the turn: "concede the attendance point, then press on who signed off" is the shape. Do not explain why the turn matters, do not restate the beat, do not summarise the spine.
- PLAN AT LEAST ${minimumTurnsFor(input.totalWordTarget)} TURNS. This is arithmetic, not a style note: ${input.totalWordTarget} spoken words at a natural mix of short reactions and full arguments averages about ${ASSUMED_WORDS_PER_TURN} words a turn. Fewer turns than that cannot fill the episode however long you make each one, and stretching turns to compensate produces two monologues instead of an argument. Count the turns before you return them.
- Total spoken words across all turns should land near ${input.totalWordTarget}; set targetWords per turn accordingly (short reactions 4-15, arguments 35-90).

Return valid JSON only:
{"turns":[{"turnIndex":0,"beatIndex":1,"speakerName":"...","intent":"...","factRefs":[{"type":"...","id":"..."}],"targetWords":45}]}`,
      temperature: 0.6,
      // SIZED FROM THE TURN COUNT, not a fixed number.
      //
      // 7000 was set when a plan was ~15 turns. The turn floor now demands ~43
      // for an 8-minute episode, and each turn is a JSON object carrying an
      // intent sentence, factRefs and targetWords — call it 160 tokens. 43 turns
      // is over 5,000 tokens of pure payload, and a reasoning model spends more
      // before it writes any.
      //
      // OBSERVED IN PRODUCTION 2026-08-08: the plan came back truncated_json,
      // the single repair truncated too, and the router then walked the whole
      // fallback chain — 1,134,739ms on one call, then another 198,048ms hitting
      // output_limit on the next candidate. Nineteen minutes to produce nothing,
      // caused by raising the turn floor without raising the budget it has to
      // fit in.
      maxTokens: turnPlanMaxTokens(input.totalWordTarget),
      // TWO ATTEMPTS AT THE RHYTHM BAND, then the plan is taken as it stands.
      //
      // That is exactly the first candidate's initial call plus its one repair.
      // A model that has been shown the arithmetic twice and still cannot hit it
      // is not going to hit it on the second provider either — and on the free
      // tier the second provider is the last one, so continuing to reject costs
      // the episode rather than a call. Content rules stay fatal on every
      // attempt; only the pacing statistics soften. See TurnPlanValidatorOptions.
      validate: makeTurnPlanValidator(input.totalWordTarget, { rhythmAttempts: 2 }),
    })
  );

  const legal = new Map(input.speakerNames.map((n) => [n.toLowerCase(), n]));
  const turns: TurnPlanEntry[] = [];
  for (const raw of result.turns) {
    const speakerName = legal.get(String(raw.speakerName).trim().toLowerCase());
    if (!speakerName) continue; // a speaker nobody cast cannot be allocated turns
    turns.push({
      turnIndex: turns.length,
      beatIndex: Number.isInteger(raw.beatIndex) ? Number(raw.beatIndex) : 1,
      speakerName,
      intent: String(raw.intent).trim(),
      factRefs: Array.isArray(raw.factRefs)
        ? raw.factRefs.filter((r) => r && r.type && r.id).map((r) => ({ type: String(r.type), id: String(r.id) }))
        : [],
      targetWords: Math.max(3, Math.min(140, Number(raw.targetWords) || 40)),
    });
  }
  return turns;
}

export interface HostWrittenLine {
  turnIndex: number;
  speakerName: string;
  text: string;
  tone?: string;
  energy?: string;
  pauseBefore?: string;
  isInterruption?: boolean;
  evidenceRefs?: unknown[];
  isFactualClaim?: boolean;
}

export interface HostWriterChunkResult {
  lines: HostWrittenLine[];
  /** Foreign-brief phrases that were REDACTED out of the composed prompt, and
   *  the exact strings that reached the model — the isolation evidence. */
  isolation: {
    redactedTerms: string[];
    sentSystemPrompt: string;
    /** The per-(episode, host) static block sent as a cached prefix. */
    sentCacheableContext: string;
    sentPrompt: string;
    /** All three parts joined in render order — use this for isolation checks. */
    composed: string;
  };
}

/**
 * The isolation guarantee, implemented rather than requested.
 *
 * Every phrase from the OTHER host's private brief is removed from the composed
 * prompt before it is sent. This matters because the architect writes the turn
 * intents, and an architect that paraphrases host B's protected belief into host
 * B's turn intent would leak the brief into host A's prompt through the back
 * door. Redaction closes that door; the count of redactions is reported so the
 * leak is visible rather than silently patched.
 */
function redactForeignBrief(text: string, terms: string[]): { text: string; redacted: string[] } {
  let out = text;
  const redacted: string[] = [];
  for (const term of terms) {
    const needle = term.trim();
    if (needle.length < 12) continue; // too short to be a distinctive brief phrase
    let index = out.toLowerCase().indexOf(needle.toLowerCase());
    let hit = false;
    while (index >= 0) {
      hit = true;
      out = `${out.slice(0, index)}[REDACTED: the other host's private brief]${out.slice(index + needle.length)}`;
      index = out.toLowerCase().indexOf(needle.toLowerCase());
    }
    if (hit) redacted.push(needle);
  }
  return { text: out, redacted };
}

/**
 * ROLES 3 and 4 — HOST WRITERS.
 *
 * One call writes one movement's worth of ONE host's turns. The other host's
 * turns appear as INTENTS (and, once written, as text) so the reply can be
 * causal; the other host's private brief never appears at all.
 */
export async function writeHostLines(input: {
  llm: LLMProvider;
  hostName: string;
  otherHostName: string;
  privateBrief: PrivateHostAgenda;
  /** Distinctive phrases from the OTHER host's brief. Removed before sending. */
  foreignBriefTerms: string[];
  spine: unknown;
  beats: unknown;
  chunkTurns: TurnPlanEntry[];
  ownTurnIndexes: number[];
  /** Everything already on the page, in order. Cold open + earlier movements. */
  writtenSoFar: Array<{ turnIndex: number; speakerName: string; text: string }>;
  topicsEvidence: string;
  systemPrompt: string;
  movementNumber: number;
  movementCount: number;
  temperature: number;
  maxTokens: number;
}): Promise<HostWriterChunkResult> {
  const ownTurns = input.chunkTurns.filter((t) => input.ownTurnIndexes.includes(t.turnIndex));
  const planView = input.chunkTurns
    .map((t) =>
      t.speakerName.toLowerCase() === input.hostName.toLowerCase()
        ? `>>> TURN ${t.turnIndex} — YOURS (${input.hostName}) — intent: ${t.intent} — target ${t.targetWords} words — facts: ${JSON.stringify(t.factRefs)}`
        : `    TURN ${t.turnIndex} — ${t.speakerName} (NOT yours) — intent: ${t.intent}`
    )
    .join("\n");
  const transcriptSoFar = input.writtenSoFar.length
    ? input.writtenSoFar.map((l) => `${l.speakerName}: ${l.text}`).join("\n")
    : "(the episode opens here)";

  const rawSystemPrompt = `${input.systemPrompt}

You are the private writer for ${input.hostName}, and ONLY for ${input.hostName}.

- You write ${input.hostName}'s turns. You do not write ${input.otherHostName}'s turns, not even as a setup, not even to show what you are replying to. Lines you return for anyone other than ${input.hostName} are discarded by the pipeline and recorded as an authorship violation against you.
- You have ${input.hostName}'s private brief. You do NOT have ${input.otherHostName}'s. You are not supposed to. Write a person who is guessing at the other one's motives and sometimes guessing wrong.
- Your character's sentence shapes, evasions, humour, vulnerabilities and aggression are yours to own. Do not converge on a neutral house voice — another writer is writing the other host and the difference between you is the show.
- Never speak the brief aloud, never name your objective, never explain your own psychology.`;

  // ---------------------------------------------------------------------------
  // CACHE-STABLE SPLIT.
  //
  // A host writer is called once per movement, so roughly six times an episode,
  // and every one of those calls used to resend the private brief, the spine and
  // the whole evidence packet interleaved with the movement number, the turn
  // plan and the transcript so far. Interleaved is the operative word: prompt
  // caching is a PREFIX match, so a single changing byte early in the text makes
  // every byte after it uncacheable. The static material sat behind the movement
  // header, so none of it ever cached and the packet was re-billed at full input
  // price on every call.
  //
  // Everything below `cacheableStatic` is identical for a given (episode, host)
  // and goes to the provider as a cached block; everything in `rawPrompt` varies
  // per movement and follows it. BEATS stays dynamic because it genuinely is:
  // the caller passes `movements[m]`, one movement's beats, not the episode's.
  //
  // The providers render systemPrompt → cacheableContext → prompt, so "the
  // EVIDENCE block above" further down still refers to text that precedes it.
  const cacheableStatic = `YOUR PRIVATE BRIEF (${input.hostName} only):
${JSON.stringify(input.privateBrief, null, 2)}

EPISODE SPINE:
${JSON.stringify(input.spine, null, 2)}

EVIDENCE — only the facts assigned to your own turns may be newly introduced, and every specific number, date, result, quote or named-person action you state as true must be in that evidence and carry its ref. With no evidence, argue vividly without a fabricated specific:
${input.topicsEvidence}`;

  const rawPrompt = `MOVEMENT ${input.movementNumber} of ${input.movementCount}.

BEATS IN PLAY:
${JSON.stringify(input.beats, null, 2)}

THE TURN PLAN FOR THIS MOVEMENT (the architect's allocation — you write only the ones marked YOURS):
${planView}

WHAT IS ALREADY ON THE PAGE — continue its emotional and conversational logic. READ IT, RESPOND TO IT, NEVER REPRODUCE IT: any line below has already been spoken aloud, including lines of your own. Repeating one — verbatim or lightly reworded — is the single most obvious sign a script was assembled by a machine, and such a line is dropped without being replaced, leaving your character silent on that turn:
${transcriptSoFar}

Write ${ownTurns.length} line(s): exactly the turns marked YOURS, no more and no fewer. Each must respond to what precedes it — a line that could be moved anywhere in the episode is a failed line. Hit the intent first. Then hit targetWords: it is a FLOOR, not a ceiling, and a turn that lands well under it starves the episode — the whole script is rejected outright if the totals come up short, which no amount of good intent recovers.

EVIDENCE REFS ARE NOT DECORATION, AND THEY ARE NOT QUOTES. An evidenceRefs entry is a typed record pointer, copied EXACTLY as an object: {"type":"newsItem","id":"..."} . Your own turns in the plan above already carry the refs assigned to them — the "facts" array on each line marked YOURS. Copy those objects across, unchanged. Do not invent an id, do not retype it from memory, do not substitute a quoted phrase, a source name or a summary: anything that is not one of the objects handed to you is DELETED by the pipeline before the script is saved, which leaves the claim standing with no support at all.

${ownTurns.some((t) => t.factRefs.length > 0)
  ? `The refs available to you in this movement are exactly: ${JSON.stringify(
      Array.from(new Map(ownTurns.flatMap((t) => t.factRefs).map((r) => [`${r.type}:${r.id}`, r])).values())
    )}. Every line you mark "isFactualClaim":true must carry at least one of them.`
  : `No facts were assigned to your turns in this movement. That means you may not state a specific number, date, result or named-person action as true here — argue vividly without one, and leave "isFactualClaim":false on every line.`}

If you cannot point a specific at one of those refs, do not state that specific.

Return valid JSON only. The two lines below show both shapes — an ordinary line, and a line making a factual claim:
{"lines":[{"turnIndex":0,"speakerName":${JSON.stringify(input.hostName)},"text":"spoken words","tone":"heated|sarcastic|analytical|dismissive|amused|incredulous|conceding|excited|reflective|setup|transition","energy":"low|medium|high","pauseBefore":"none|beat|breath|long","isInterruption":false,"evidenceRefs":[],"isFactualClaim":false},{"turnIndex":1,"speakerName":${JSON.stringify(input.hostName)},"text":"spoken words that assert a specific number or result","tone":"analytical","energy":"medium","pauseBefore":"beat","isInterruption":false,"evidenceRefs":[{"type":"teamStat","id":"copy-an-id-from-your-facts-array"}],"isFactualClaim":true}]}`;

  // REDACTION RUNS OVER ALL THREE PARTS, and that is load-bearing rather than
  // tidy. Splitting the prompt in two would have silently halved the isolation
  // guarantee if the new static block were left out — the brief and the spine,
  // the two places a foreign phrase is most likely to surface, both live there
  // now. redactForeignBrief is deterministic (a fixed term list, ordered
  // case-insensitive replacement, a constant replacement string), so redacting
  // the static block does not make it vary between calls: identical input and
  // identical terms give byte-identical output, which is what keeps the cache
  // prefix stable. testPromptCacheStability asserts exactly that.
  const redactedSystem = redactForeignBrief(rawSystemPrompt, input.foreignBriefTerms);
  const redactedStatic = redactForeignBrief(cacheableStatic, input.foreignBriefTerms);
  const redactedPrompt = redactForeignBrief(rawPrompt, input.foreignBriefTerms);
  const sentSystemPrompt = redactedSystem.text;
  const sentCacheableContext = redactedStatic.text;
  const sentPrompt = redactedPrompt.text;

  // The refs this writer is permitted to cite: exactly those the architect
  // assigned to the turns it owns in this movement. Anything else would be
  // deleted by scriptService's sanitiser, so accepting it here would only move
  // the failure somewhere it cannot be repaired.
  const allowedRefKeys = new Set(ownTurns.flatMap((t) => t.factRefs.map((r) => `${r.type}:${r.id}`)));

  const result = await withLlmStage(`script:host-writer:${input.hostName}`, () =>
    input.llm.generateStructuredOutput<{ lines: HostWrittenLine[] }>({
      systemPrompt: sentSystemPrompt,
      cacheableContext: sentCacheableContext,
      prompt: sentPrompt,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      validate: (value) => {
        const lines = (value as { lines?: unknown })?.lines;
        if (!Array.isArray(lines)) return "Missing 'lines' array.";
        if (lines.length === 0) return "Returned zero lines.";
        for (const line of lines as Array<Record<string, unknown>>) {
          if (!Number.isInteger(line?.turnIndex)) return "Every line needs an integer turnIndex.";
          if (typeof line?.text !== "string" || !line.text.trim()) return "Every line needs text.";

          // EVIDENCE REFS ARE VALIDATED HERE, WHERE THEY CAN STILL BE FIXED.
          //
          // This prompt used to ask for a verbatim text fragment
          // (`["31 of 44 on third down"]`) while every consumer downstream
          // required a typed record pointer. scriptService's sanitiser drops
          // any ref that is not `{type,id}` present in the episode's allowed
          // source refs, SILENTLY and without a violation — so a writer that
          // did exactly as it was told had 100% of its citations deleted, and
          // the fact-check gate then counted the stripped lines as
          // unsupported claims.
          //
          // MEASURED on the 2026-08-11 episode: factualLines=17,
          // unsupportedClaims=17, and zero evidenceRefs survived into the
          // saved script for either host. That is not a model failing to
          // comply — it is the prompt asking for the wrong data type.
          //
          // Validating here rather than tightening the sanitiser is the point:
          // the writer still has the plan in front of it and a rejection comes
          // back as a repair it can act on. A ref deleted three stages later
          // is unrecoverable, because nothing downstream knows which record
          // the line was supposed to point at.
          const refs = Array.isArray(line.evidenceRefs) ? line.evidenceRefs : [];
          for (const ref of refs as Array<Record<string, unknown>>) {
            if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
              return (
                `evidenceRefs entries must be objects of the form {"type":"...","id":"..."} copied from ` +
                `your turn's facts array. Got ${JSON.stringify(ref)} on turn ${line.turnIndex}. ` +
                `A quoted phrase is not a reference and is discarded by the pipeline.`
              );
            }
            const key = `${String(ref.type)}:${String(ref.id)}`;
            if (!allowedRefKeys.has(key)) {
              return (
                `evidenceRefs entry ${JSON.stringify(ref)} on turn ${line.turnIndex} was not assigned to any ` +
                `of your turns in this movement. Use only the refs in the facts array of a turn marked YOURS: ` +
                `${allowedRefKeys.size ? [...allowedRefKeys].join(", ") : "(none were assigned — do not mark lines factual)"}.`
              );
            }
          }
          if (line.isFactualClaim === true && refs.length === 0) {
            return (
              `Turn ${line.turnIndex} is marked "isFactualClaim":true with an empty evidenceRefs. ` +
              `Either carry one of the refs assigned to your turns, or set "isFactualClaim":false and ` +
              `remove the specific figure, date, result or named-person action from the line. An unsupported ` +
              `claim can block the episode from publishing.`
            );
          }
        }
        return null;
      },
    })
  );

  return {
    lines: (result.lines || []).map((line) => ({
      ...line,
      turnIndex: Number(line.turnIndex),
      speakerName: String(line.speakerName ?? "").trim(),
      text: String(line.text ?? ""),
    })),
    isolation: {
      redactedTerms: [
        ...new Set([...redactedSystem.redacted, ...redactedStatic.redacted, ...redactedPrompt.redacted]),
      ],
      sentSystemPrompt,
      sentCacheableContext,
      sentPrompt,
      // Every part, in the order the providers render them. Exposed so an
      // isolation check cannot pass by inspecting only two thirds of what was
      // actually sent — which is precisely how splitting this prompt could have
      // weakened the guarantee without any test noticing.
      composed: [sentSystemPrompt, sentCacheableContext, sentPrompt].join("\n\n"),
    },
  };
}

export interface DirectorRepair {
  lineIndex: number;
  text: string;
  reason: string;
}

/**
 * ROLE 5 — DIALOGUE DIRECTOR.
 *
 * Two writers worked without each other's words, so the seams are real: replies
 * that answer a question nobody asked, transitions that skip a step, a
 * concession offered before it was earned. The director repairs the JOINS.
 *
 * It is explicitly told it may not rewrite characters — and, more importantly,
 * the caller measures whether it did anyway and reverts the whole pass if so.
 */
export async function directDialogueTransitions(input: {
  llm: LLMProvider;
  lines: Array<{ lineIndex: number; speakerName: string; text: string }>;
  hostNames: string[];
  systemPrompt: string;
  maxChangedFraction: number;
  temperature: number;
  maxTokens: number;
}): Promise<{ repairs: DirectorRepair[]; notes: string[] }> {
  const transcript = input.lines
    .map((l) => `${l.lineIndex}\t${l.speakerName}: ${l.text}`)
    .join("\n");

  const result = await withLlmStage("script:dialogue-director", () =>
    input.llm.generateStructuredOutput<{ repairs: DirectorRepair[]; notes?: string[] }>({
      systemPrompt: `${input.systemPrompt}

You are the DIALOGUE DIRECTOR. Two different writers wrote ${input.hostNames.join(" and ")} separately, from private briefs neither shared. Your job is the JOINS between their turns, and nothing else.

You MAY: repair a reply that does not answer what was actually said; add or remove the small connective move that makes a transition follow; fix a reference to something that was never said; reorder nothing but fix the line that assumes a missing step.

You MAY NOT: improve a line you merely dislike; make either host wittier, calmer, more articulate, or more balanced; harmonise their sentence shapes, vocabulary, or rhythm; move a fact; introduce a fact; touch a line that already lands.

Two different minds is the product. If your pass makes both hosts sound like one careful writer, it will be measured, rejected wholesale, and recorded as a homogenization violation. Repair at most ${Math.round(input.maxChangedFraction * 100)}% of either host's lines, and change as few words in each as the repair needs.`,
      prompt: `TRANSCRIPT (lineIndex, speaker, text):
${transcript}

Return ONLY the lines that genuinely need a causal or transitional repair, with the smallest edit that fixes them. Preserve the speaker's voice, their facts, and their evidence. If nothing needs repair, return an empty array — that is a valid and common answer.

Return valid JSON only:
{"repairs":[{"lineIndex":0,"text":"the repaired line","reason":"what did not follow, and what the edit fixes"}],"notes":["optional observation"]}`,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      validate: (value) => {
        const repairs = (value as { repairs?: unknown })?.repairs;
        if (!Array.isArray(repairs)) return "Missing 'repairs' array (an empty array is valid).";
        for (const repair of repairs as Array<Record<string, unknown>>) {
          if (!Number.isInteger(repair?.lineIndex)) return "Every repair needs an integer lineIndex.";
          if (typeof repair?.text !== "string" || !repair.text.trim()) return "Every repair needs text.";
        }
        return null;
      },
    })
  );

  return {
    repairs: (result.repairs || []).map((r) => ({
      lineIndex: Number(r.lineIndex),
      text: String(r.text),
      reason: String(r.reason ?? "").trim() || "(no reason given)",
    })),
    notes: Array.isArray(result.notes) ? result.notes.map(String).slice(0, 10) : [],
  };
}

export interface ContinuityEditorReport {
  callbacksLanded: Array<{ phrase: string; setupLineIndex: number; payoffLineIndex: number }>;
  callbacksAttemptedButFlat: string[];
  characterHistoryConflicts: Array<{ lineIndex: number; detail: string }>;
  runningBitsUsed: string[];
  /** Issues that a human should read. Advisory: this role does not rewrite. */
  issues: Array<{ lineIndex: number | null; severity: "note" | "warn"; detail: string }>;
}

/**
 * ROLE 6 — CONTINUITY EDITOR.
 *
 * Reports. Never rewrites. Optional by design: continuity in this show is
 * topic-gated and nothing is required per episode, so a continuity outage must
 * not be able to hold a sound script.
 */
export async function reviewContinuity(input: {
  llm: LLMProvider;
  transcript: string;
  hostNames: string[];
  priorContext?: unknown;
  systemPrompt: string;
}): Promise<ContinuityEditorReport> {
  const result = await withLlmStage("script:continuity-editor", () =>
    input.llm.generateStructuredOutput<Partial<ContinuityEditorReport>>({
      systemPrompt: `${input.systemPrompt}\n\nYou are the CONTINUITY EDITOR. You report only what is literally on the page. You never rewrite a line and never invent a callback that is not there. A callback counts only when a concrete earlier phrase or image genuinely returns and does new work; a topic mentioned twice is not a callback.`,
      prompt: `HOSTS: ${input.hostNames.join(" and ")}
${input.priorContext ? `\nESTABLISHED HISTORY AND RUNNING BITS:\n${JSON.stringify(input.priorContext, null, 2)}\n` : ""}
TRANSCRIPT (lineIndex, speaker, text):
${input.transcript}

Report:
- callbacks that LANDED (name the exact phrase, the setup line and the payoff line)
- callbacks that were attempted and fell flat
- lines that contradict a host's established history or an earlier statement in this same episode
- running bits actually used

Return valid JSON only:
{"callbacksLanded":[{"phrase":"...","setupLineIndex":0,"payoffLineIndex":0}],"callbacksAttemptedButFlat":["..."],"characterHistoryConflicts":[{"lineIndex":0,"detail":"..."}],"runningBitsUsed":["..."],"issues":[{"lineIndex":0,"severity":"note|warn","detail":"..."}]}`,
      temperature: 0,
      maxTokens: 3000,
      validate: (value) =>
        value && typeof value === "object" ? null : "Continuity report must be an object.",
    })
  );

  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    callbacksLanded: arr<ContinuityEditorReport["callbacksLanded"][number]>(result.callbacksLanded),
    callbacksAttemptedButFlat: arr<string>(result.callbacksAttemptedButFlat).map(String),
    characterHistoryConflicts: arr<ContinuityEditorReport["characterHistoryConflicts"][number]>(
      result.characterHistoryConflicts
    ),
    runningBitsUsed: arr<string>(result.runningBitsUsed).map(String),
    issues: arr<ContinuityEditorReport["issues"][number]>(result.issues),
  };
}

/** Distinctive phrases from a private brief — what must never cross to the
 *  other host's writer. Short values are dropped: they are not distinctive
 *  enough to be a leak and redacting them would mangle ordinary prose. */
export function privateBriefTerms(agenda: PrivateHostAgenda): string[] {
  const fields: Array<keyof PrivateHostAgenda> = [
    "exclusiveFactResponsibility",
    "protectedBelief",
    "avoidedConcession",
    "behavioralTrigger",
    "misconceptionAboutOtherHost",
    "genuineQuestion",
    "privateObjective",
  ];
  return fields
    .map((f) => String(agenda[f] ?? "").trim())
    .filter((v) => v.length >= 12);
}

function validateCharacterRewrite(value: unknown): string | null {
  const parsed = value as { lines?: Array<{ lineIndex?: number; text?: string }> };
  if (!Array.isArray(parsed?.lines)) return "Missing lines array.";
  if (parsed.lines.some((l) => !Number.isInteger(l.lineIndex) || !String(l.text || "").trim())) return "Every rewritten line needs lineIndex and text.";
  return null;
}

/** Separate character pass: one request owns one character and may alter only
 * that character's lines. The merge preserves speaker ownership and lets the
 * later conversation/fact gates repair interaction without creating a single
 * polished house voice. */
export async function rewriteMovementByCharacter(input: {
  llm: LLMProvider;
  segments: CreativeScriptSegment[];
  agendas: PrivateHostAgenda[];
  systemPrompt: string;
}): Promise<CreativeScriptSegment[]> {
  let current = input.segments;
  for (const agenda of input.agendas) {
    const flat = current.flatMap((segment) => (segment.lines || []).map((line) => ({
      lineIndex: line.lineIndex,
      speakerName: line.speakerName,
      text: line.text,
      tone: line.tone,
      energy: line.energy,
      evidenceRefs: line.evidenceRefs,
      isFactualClaim: line.isFactualClaim,
    })));
    const owned = flat.filter((line) => String(line.speakerName).toLowerCase() === agenda.speakerName.toLowerCase());
    if (!owned.length) continue;
    const result = await withLlmStage(`script:character-pass:${agenda.speakerName}`, () =>
      input.llm.generateStructuredOutput<{ lines: Array<{ lineIndex: number; text: string; tone?: string; energy?: string }> }>({
        systemPrompt: `${input.systemPrompt}\n\nYou are the private writer for ${agenda.speakerName} only. You may rewrite ONLY that character's existing lines. Preserve every fact, number, evidenceRefs assignment, question answered, and lineIndex. Do not polish the other host or make this character sound like a generic house style.`,
        prompt: `PRIVATE AGENDA:\n${JSON.stringify(agenda)}\n\nFULL MOVEMENT FOR REACTION CONTEXT:\n${JSON.stringify(flat)}\n\nRewrite every one of ${agenda.speakerName}'s ${owned.length} lines. Preserve ownership and return no other host's lines. Make sentence shape, avoidance, humor, vulnerability and aggression unmistakably this character's. Return JSON only: {"lines":[{"lineIndex":0,"text":"...","tone":"...","energy":"..."}]}`,
        temperature: 0.75,
        maxTokens: 7000,
        validate: validateCharacterRewrite,
      })
    );
    const byIndex = new Map(result.lines.map((line) => [line.lineIndex, line]));
    current = current.map((segment) => ({ ...segment, lines: (segment.lines || []).map((line) => {
      if (String(line.speakerName).toLowerCase() !== agenda.speakerName.toLowerCase()) return line;
      const rewrite = byIndex.get(line.lineIndex);
      return rewrite ? { ...line, text: rewrite.text, tone: rewrite.tone || line.tone, energy: rewrite.energy || line.energy } : line;
    }) }));
  }
  return current;
}
