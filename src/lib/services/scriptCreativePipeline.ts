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

function validateColdOpenDraft(value: unknown): string | null {
  const parsed = value as { variants?: Array<{ id?: string; lines?: CreativeScriptLine[] }> };
  if (!Array.isArray(parsed?.variants) || parsed.variants.length !== 3) return "Exactly three cold-open variants are required.";
  const seen = new Set(parsed.variants.map((v) => v.id));
  if (IDS.some((id) => !seen.has(id))) return "Cold opens must be accusation, consequence and contradiction.";
  for (const variant of parsed.variants) {
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
  }
  return null;
}

interface ColdOpenJudgment { id: string; score: number; reasons: string[] }

export async function runColdOpenTextTournament(input: {
  writer: LLMProvider;
  judge: LLMProvider;
  episodeTitle: string;
  coldOpenBeat: unknown;
  topicsEvidence: string;
  speakerNames: string[];
  agendas: PrivateHostAgenda[];
  systemPrompt: string;
  learningPolicy?: unknown;
}): Promise<{ segment: CreativeScriptSegment; tournament: ColdOpenTournamentResult }> {
  const draft = await withLlmStage("script:cold-open-variants", () =>
    input.writer.generateStructuredOutput<{ variants: Array<{ id: ColdOpenVariant["id"]; lines: CreativeScriptLine[] }> }>({
      systemPrompt: `${input.systemPrompt}\n\nThis is a dedicated cold-open room. Write only the first 45 seconds. No greeting, show description, throat-clearing, scene label, or \"today we're discussing\". Start in motion. Each host owns only their private agenda; do not make either character recite the other's internal objective.`,
      prompt: `Create three COMPLETELY DIFFERENT 45-second openings for ${JSON.stringify(input.episodeTitle)}:\n1. accusation — one host directly challenges the other's judgment;\n2. consequence — begin with the most concrete human cost;\n3. contradiction — begin with two evidence-backed facts that should not comfortably coexist.\n\nCOLD-OPEN BEAT:\n${JSON.stringify(input.coldOpenBeat)}\n\nPRIVATE AGENDAS (keep separate):\n${input.agendas.map((a) => `${a.speakerName}: ${JSON.stringify(a)}`).join("\n")}\n\nEVIDENCE:\n${input.topicsEvidence}\n\nUse 80-120 spoken words per variant and at least three turns. Every line must contain lineIndex, speakerName, text, tone, energy, pauseBefore, isInterruption, evidenceRefs, isFactualClaim and needsHumanReview. Legal speakers: ${input.speakerNames.join(", ")}. Return JSON only: {"variants":[{"id":"accusation","lines":[]},{"id":"consequence","lines":[]},{"id":"contradiction","lines":[]}]}`,
      temperature: 0.9,
      maxTokens: 8000,
      validate: validateColdOpenDraft,
    })
  );

  const judgments = await withLlmStage("script:cold-open-judge", () =>
    input.judge.generateStructuredOutput<{ judgments: ColdOpenJudgment[] }>({
      systemPrompt: "You are an independent podcast cold-open judge. You do not reward volume, famous names, greetings, or generic drama. Reward an immediate open loop, specific consequence, unmistakable characters, causal back-and-forth, evidence integrity, and lines that will perform well aloud.",
      prompt: `Blind-rank these three openings. Score each 0-100. Penalize any unsupported claim, exposition, interchangeable host voice, or answer revealed too early.\n\nSHOW-SPECIFIC LEARNING POLICY (soft prior only; never force a winner, never override this episode's evidence or character fit):\n${JSON.stringify(input.learningPolicy || null)}\n\n${JSON.stringify(draft.variants)}\n\nReturn JSON only: {"judgments":[{"id":"accusation","score":0,"reasons":["..."]}]}`,
      temperature: 0,
      maxTokens: 3000,
      validate: (value) => {
        const parsed = value as { judgments?: ColdOpenJudgment[] };
        return Array.isArray(parsed?.judgments) && parsed.judgments.length === 3 ? null : "Exactly three judgments are required.";
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
    },
  };
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
