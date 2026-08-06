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
  return `Use ${COLD_OPEN_MIN_WORDS}-${COLD_OPEN_MAX_WORDS} spoken words and at least three turns. Every line must contain lineIndex, speakerName, text, tone, energy, pauseBefore, isInterruption, evidenceRefs, isFactualClaim and needsHumanReview. Any line with "isFactualClaim":true must also carry at least one evidenceRefs entry copied VERBATIM from the supplied evidence — an exact phrase or number as written there, never a paraphrase or a source name. A claim with empty evidenceRefs counts as unsupported. Legal speakers: ${speakerNames.join(", ")}.`;
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
  const result = await withLlmStage(`script:cold-open-variant:${assignment.variantId}`, () =>
    assignment.provider.generateStructuredOutput<{ lines: CreativeScriptLine[] }>({
      systemPrompt: coldOpenSystemPrompt(input.systemPrompt),
      prompt: `Write ONE 45-second opening for ${JSON.stringify(input.episodeTitle)} on this angle:\n${assignment.variantId} — ${COLD_OPEN_ANGLES[assignment.variantId]}.\n\nCOLD-OPEN BEAT:\n${JSON.stringify(input.coldOpenBeat)}\n\nPRIVATE AGENDAS (keep separate):\n${input.agendas.map((a) => `${a.speakerName}: ${JSON.stringify(a)}`).join("\n")}\n\nEVIDENCE:\n${input.topicsEvidence}\n\n${coldOpenLineContract(input.speakerNames)} Return JSON only: {"lines":[]}`,
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
 * minutes with fifteen speeches is worse than filling it with thirty-five
 * exchanges, even though both hit the word count.
 */
const ASSUMED_WORDS_PER_TURN = 40;

/** The turn floor an episode's word target implies. */
export function minimumTurnsFor(totalWordTarget: number): number {
  return Math.max(8, Math.ceil(totalWordTarget / ASSUMED_WORDS_PER_TURN));
}

function makeTurnPlanValidator(totalWordTarget: number) {
  const minTurns = minimumTurnsFor(totalWordTarget);
  return function validateTurnPlan(value: unknown): string | null {
    const turns = (value as { turns?: unknown })?.turns;
    if (!Array.isArray(turns) || turns.length === 0) return "Missing non-empty 'turns' array.";
    for (const turn of turns as Array<Record<string, unknown>>) {
      if (typeof turn?.speakerName !== "string" || !turn.speakerName.trim()) return "Every turn needs a speakerName.";
      if (typeof turn?.intent !== "string" || !turn.intent.trim()) return "Every turn needs an intent.";
    }
    // ENFORCED, not merely requested. An under-planned turn count cannot be
    // recovered downstream: the host writers each write only the turns they were
    // given, so a short plan guarantees a short episode and the whole run dies
    // at the word floor after every role has already been paid for. Observed
    // 2026-08-06: an 8-minute episode planned with 15 turns produced 411 spoken
    // words against a 951 floor, and every candidate model failed the same way.
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
- Do NOT alternate mechanically. A host may hold two or three consecutive turns when the pressure warrants it; a one-word reaction is a legitimate turn.
- The two hosts must NOT end up with the same number of turns. Turn count follows who has something to say.
- Assign each evidence fact to at most ONE turn, on the beat that already owns it.
- "intent" is the conversational ACTION: what this turn does to the previous one and what it changes. Never dialogue, never a quotable line.
- PLAN AT LEAST ${minimumTurnsFor(input.totalWordTarget)} TURNS. This is arithmetic, not a style note: ${input.totalWordTarget} spoken words at a natural mix of short reactions and full arguments averages about ${ASSUMED_WORDS_PER_TURN} words a turn. Fewer turns than that cannot fill the episode however long you make each one, and stretching turns to compensate produces two monologues instead of an argument. Count the turns before you return them.
- Total spoken words across all turns should land near ${input.totalWordTarget}; set targetWords per turn accordingly (short reactions 4-15, arguments 35-90).

Return valid JSON only:
{"turns":[{"turnIndex":0,"beatIndex":1,"speakerName":"...","intent":"...","factRefs":[{"type":"...","id":"..."}],"targetWords":45}]}`,
      temperature: 0.6,
      maxTokens: 7000,
      validate: makeTurnPlanValidator(input.totalWordTarget),
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
    sentPrompt: string;
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

  const rawPrompt = `MOVEMENT ${input.movementNumber} of ${input.movementCount}.

YOUR PRIVATE BRIEF (${input.hostName} only):
${JSON.stringify(input.privateBrief, null, 2)}

EPISODE SPINE:
${JSON.stringify(input.spine, null, 2)}

BEATS IN PLAY:
${JSON.stringify(input.beats, null, 2)}

THE TURN PLAN FOR THIS MOVEMENT (the architect's allocation — you write only the ones marked YOURS):
${planView}

WHAT IS ALREADY ON THE PAGE — continue its emotional and conversational logic:
${transcriptSoFar}

EVIDENCE — only the facts assigned to your own turns may be newly introduced, and every specific number, date, result, quote or named-person action you state as true must be in that evidence and carry its ref. With no evidence, argue vividly without a fabricated specific:
${input.topicsEvidence}

Write ${ownTurns.length} line(s): exactly the turns marked YOURS, no more and no fewer. Each must respond to what precedes it — a line that could be moved anywhere in the episode is a failed line. Hit the intent first. Then hit targetWords: it is a FLOOR, not a ceiling, and a turn that lands well under it starves the episode — the whole script is rejected outright if the totals come up short, which no amount of good intent recovers.

EVIDENCE REFS ARE NOT DECORATION. Every line you mark "isFactualClaim":true must carry at least one evidenceRefs entry copied VERBATIM from the EVIDENCE block above — an exact phrase or number as written there. Not a paraphrase, not a source name, not a summary. A factual claim with an empty evidenceRefs is treated downstream as UNSUPPORTED and can block the episode from publishing. If you cannot quote the evidence for a specific, do not state that specific.

KEEP EACH REF SHORT: the shortest exact fragment that pins the fact, TWELVE WORDS AT MOST — usually just the figure and its subject. One ref per claim is enough. These are lookup keys, not citations, and long quotations blow the output budget and truncate the script into unparseable JSON.

Return valid JSON only. The two lines below show both shapes — an ordinary line, and a line making a factual claim:
{"lines":[{"turnIndex":0,"speakerName":${JSON.stringify(input.hostName)},"text":"spoken words","tone":"heated|sarcastic|analytical|dismissive|amused|incredulous|conceding|excited|reflective|setup|transition","energy":"low|medium|high","pauseBefore":"none|beat|breath|long","isInterruption":false,"evidenceRefs":[],"isFactualClaim":false},{"turnIndex":1,"speakerName":${JSON.stringify(input.hostName)},"text":"spoken words that assert a specific number or result","tone":"analytical","energy":"medium","pauseBefore":"beat","isInterruption":false,"evidenceRefs":["31 of 44 on third down"],"isFactualClaim":true}]}`;

  const redactedSystem = redactForeignBrief(rawSystemPrompt, input.foreignBriefTerms);
  const redactedPrompt = redactForeignBrief(rawPrompt, input.foreignBriefTerms);
  const sentSystemPrompt = redactedSystem.text;
  const sentPrompt = redactedPrompt.text;

  const result = await withLlmStage(`script:host-writer:${input.hostName}`, () =>
    input.llm.generateStructuredOutput<{ lines: HostWrittenLine[] }>({
      systemPrompt: sentSystemPrompt,
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
      redactedTerms: [...new Set([...redactedSystem.redacted, ...redactedPrompt.redacted])],
      sentSystemPrompt,
      sentPrompt,
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
