// Outline-driven progressive script generation.
//
// Each movement is generated, measured, and—when necessary—repaired in place
// before the expensive whole-episode verification stages run. A provider may
// return perfectly valid JSON that is still far too short, repetitive, or
// mechanically shaped; structural validity alone is not movement completion.

import { LLMProvider } from "../providers/llm/interface";
import { withLlmStage } from "../providers/llm/costLedger";
import { stripAudioTags } from "../audio/speechText";
import { RewriteContext } from "./scriptSelfVerify";
import { evaluateMovementQuality, type MovementQualityReport } from "./scriptMovementQuality";
import {
  generatePrivateHostAgendas,
  rewriteMovementByCharacter,
  runColdOpenTextTournament,
  type ColdOpenTournamentResult,
  type PrivateHostAgenda,
} from "./scriptCreativePipeline";

export interface OutlineBeat {
  beatIndex: number;
  segmentType: "cold_open" | "intro" | "topic" | "transition" | "closing";
  title: string;
  goal: string;
  angle: string;
  topicId?: string;
  factRefs: { type: string; id: string }[];
  escalation?: string;
  callback?: string;
}

export interface OutlineDrivenArgs {
  systemPrompt: string;
  episodeTitle: string;
  topicsPrompts: string;
  targetDuration: number;
  version: number;
  temperature: number;
  maxTokens: number;
  speakerNames: string[];
  learningPolicy?: unknown;
  outlineLlm?: LLMProvider;
  challengerLlm?: LLMProvider;
  challengerLabel?: string;
  onMovementComplete?: (info: {
    movement: number;
    msSinceStart: number;
    msForMovement: number;
    lines: number;
    words: number;
  }) => void;
  log: (msg: string) => void;
}

export function validateScriptShape(value: unknown): string | null {
  const segments = (value as { segments?: unknown })?.segments;
  if (!Array.isArray(segments)) return "Response is missing the required 'segments' array.";
  if (segments.length === 0) return "Response contains zero segments.";
  let lines = 0;
  for (const segment of segments) {
    const segmentLines = (segment as { lines?: unknown })?.lines;
    if (!Array.isArray(segmentLines)) return "A segment is missing its 'lines' array.";
    lines += segmentLines.length;
  }
  if (lines === 0) return "Every segment is empty — the script has no lines.";
  return null;
}

export interface ChallengerMovementResult {
  movement: number;
  label: string;
  ok: boolean;
  lines: number;
  words: number;
  ms: number;
  error?: string;
  segments?: any[];
}

interface ConversationState {
  emotionalTemperature: "cool" | "warming" | "hot" | "settling";
  unresolvedThreads: string[];
  positionShifts: string[];
  callbacksAvailable: string[];
  relationshipChange: string;
}

const EMPTY_STATE: ConversationState = {
  emotionalTemperature: "cool",
  unresolvedThreads: [],
  positionShifts: [],
  callbacksAvailable: [],
  relationshipChange: "Nothing has happened between the hosts yet.",
};

export function compactCreativeSystemPrompt(systemPrompt: string): string {
  const speechRulesAt = systemPrompt.indexOf("HOW REAL PODCAST SPEECH WORKS");
  const personaPrefix = (speechRulesAt >= 0 ? systemPrompt.slice(0, speechRulesAt) : systemPrompt).trim();
  const continuityAt = systemPrompt.indexOf("=== SHOW CONTINUITY");
  const continuity = continuityAt >= 0 ? systemPrompt.slice(continuityAt).trim() : "";

  return `${personaPrefix}

CREATIVE PRIORITY:
Write people reacting to each other, not a model demonstrating podcast mannerisms. Every turn must be caused by what was just said: answer it, resist it, misunderstand it, sharpen it, or reveal why it matters. If a line could be moved anywhere in the episode without changing the surrounding exchange, it is generic and must be rewritten.

Do not sprinkle interruptions, filler, false starts, laughs, tangents, concessions, or callbacks to satisfy a quota. Use one only when the thought or relationship causes it. Do not make both hosts equally polished. Let a point breathe. Let one host hold the floor when the other is genuinely listening. A surprising quiet line is more valuable than another manufactured argument.

The listener needs an unresolved question, personal stakes, changing leverage, and a payoff. The hosts may disagree, agree, miss each other, get embarrassed, become curious, or change position. They must not merely trade prepared takes.

Write spoken language. No essay paragraphs, no debate-club signposting, no greetings before the cold-open hook, no summary of what the episode is about, and no artificial "human" tic repeated on schedule.${continuity ? `\n\n${continuity}` : ""}`;
}

export async function generateOutlineDrivenScript(
  llm: LLMProvider,
  args: OutlineDrivenArgs
): Promise<{
  segments: any[];
  challenger?: ChallengerMovementResult[];
  privateAgendas: PrivateHostAgenda[];
  coldOpenTournament: ColdOpenTournamentResult;
}> {
  const creativeSystemPrompt = compactCreativeSystemPrompt(args.systemPrompt);
  const outlineLlm = args.outlineLlm ?? llm;
  const beats = await generateEpisodeOutline(outlineLlm, args, creativeSystemPrompt);
  const privateAgendas = await generatePrivateHostAgendas({
    llm: outlineLlm,
    episodeTitle: args.episodeTitle,
    speakerNames: args.speakerNames,
    outline: beats,
    topicsEvidence: args.topicsPrompts,
    systemPrompt: creativeSystemPrompt,
  });
  const coldOpen = await runColdOpenTextTournament({
    writer: llm,
    judge: outlineLlm,
    episodeTitle: args.episodeTitle,
    coldOpenBeat: beats[0],
    topicsEvidence: args.topicsPrompts,
    speakerNames: args.speakerNames,
    agendas: privateAgendas,
    systemPrompt: creativeSystemPrompt,
    learningPolicy: args.learningPolicy,
  });
  args.log(
    `Story spine: ${beats.length} beats; private agendas for ${privateAgendas.length} hosts; ` +
    `cold-open tournament selected ${coldOpen.tournament.selectedId} ` +
    `(${coldOpen.tournament.variants.find((v) => v.id === coldOpen.tournament.selectedId)?.textScore ?? 0}/100).`
  );

  const challengerResults: ChallengerMovementResult[] = [];
  const startedAt = Date.now();
  const acts = groupIntoMovements(beats.slice(1));
  const rawSegments: any[] = [coldOpen.segment];
  const claimsSoFar: string[] = [];
  const coldLines = coldOpen.segment.lines || [];
  const priorDialogueLines: string[] = coldLines.map((line) => stripAudioTags(String(line.text || "")).trim()).filter(Boolean);
  const lastLines: { speakerName: string; text: string }[] = coldLines.slice(-8).map((line) => ({ speakerName: line.speakerName, text: line.text }));
  let state: ConversationState = {
    ...EMPTY_STATE,
    emotionalTemperature: "warming",
    unresolvedThreads: [beats[0]?.angle || beats[0]?.goal || "The cold-open question remains unresolved."],
  };
  const totalWordTarget = Math.max(550, Math.round(args.targetDuration * 145));
  const episodeMinimumWords = Math.max(500, Math.round(totalWordTarget * 0.82));
  let wordsWritten = countMovement([coldOpen.segment]).words;

  for (let actIndex = 0; actIndex < acts.length; actIndex++) {
    const remainingActs = acts.length - actIndex;
    const remainingWords = Math.max(180, totalWordTarget - wordsWritten);
    const softWordTarget = Math.max(180, Math.round(remainingWords / remainingActs));
    const actArgs: ActArgs = {
      creativeSystemPrompt,
      episodeTitle: args.episodeTitle,
      topicsPrompts: args.topicsPrompts,
      beats,
      actBeats: acts[actIndex],
      actNumber: actIndex + 1,
      actCount: acts.length,
      claimsSoFar,
      lastLines,
      state,
      softWordTarget,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      speakerNames: args.speakerNames,
      privateAgendas,
    };

    const movementStartedAt = Date.now();
    let result = await generateInitialMovement(llm, actArgs);
    let quality = evaluateMovementQuality({
      segments: result.segments,
      softWordTarget,
      priorClaims: priorDialogueLines,
    });

    for (let repairRound = 1; !quality.passed && repairRound <= 2; repairRound++) {
      args.log(
        `Movement ${actIndex + 1} repair ${repairRound}: ${quality.failures.join("; ")} ` +
        `(words=${quality.words}/${quality.minimumWords}, repeats=${quality.repeatedCurrentLines}, alternation=${Math.round(quality.strictAlternationRatio * 100)}%).`
      );
      result = await repairActSegments(llm, actArgs, result, quality, repairRound);
      quality = evaluateMovementQuality({
        segments: result.segments,
        softWordTarget,
        priorClaims: priorDialogueLines,
      });
    }

    if (!quality.passed) {
      throw new Error(
        `Movement ${actIndex + 1} remained unusable after two targeted repairs: ${quality.failures.join("; ")}. ` +
        `The whole episode was not sent to verification.`
      );
    }

    // Run the private character writers after structural repair. Otherwise a
    // repair pass can silently overwrite the distinct character prose with a
    // single-model house voice.
    if (process.env.SCRIPT_CHARACTER_WRITER_PASSES !== "false") {
      result = {
        ...result,
        segments: await rewriteMovementByCharacter({
          llm,
          segments: result.segments,
          agendas: privateAgendas,
          systemPrompt: creativeSystemPrompt,
        }),
      };
      quality = evaluateMovementQuality({
        segments: result.segments,
        softWordTarget,
        priorClaims: priorDialogueLines,
      });
      if (!quality.passed) {
        throw new Error(
          `Movement ${actIndex + 1} character-separated rewrite violated production structure: ${quality.failures.join("; ")}.`
        );
      }
      args.log(`Movement ${actIndex + 1}: completed ${privateAgendas.length} character-separated writer pass(es).`);
    }

    if (args.challengerLlm) {
      const label = args.challengerLabel || "challenger";
      const challengerStartedAt = Date.now();
      try {
        const alternate = await generateActSegments(args.challengerLlm, actArgs);
        const alternateQuality = evaluateMovementQuality({
          segments: alternate.segments,
          softWordTarget,
          priorClaims: priorDialogueLines,
        });
        if (!alternateQuality.passed) {
          throw new Error(alternateQuality.failures.join("; "));
        }
        const stats = countMovement(alternate.segments);
        challengerResults.push({
          movement: actIndex + 1,
          label,
          ok: true,
          lines: stats.lines,
          words: stats.words,
          ms: Date.now() - challengerStartedAt,
          segments: alternate.segments,
        });
        args.log(`Challenger ${label} movement ${actIndex + 1}: ${stats.lines} lines / ${stats.words} words.`);
      } catch (error: any) {
        challengerResults.push({
          movement: actIndex + 1,
          label,
          ok: false,
          lines: 0,
          words: 0,
          ms: Date.now() - challengerStartedAt,
          error: error?.message || String(error),
        });
        args.log(`Challenger ${label} movement ${actIndex + 1} FAILED: ${error?.message || String(error)}`);
      }
    }

    let movementWords = 0;
    for (const segment of result.segments) {
      if (!segment || !Array.isArray(segment.lines)) continue;
      for (const line of segment.lines) {
        if (!line || typeof line.text !== "string") continue;
        const spoken = stripAudioTags(line.text).trim();
        if (!spoken) continue;
        movementWords += spoken.split(/\s+/).filter(Boolean).length;
        lastLines.push({ speakerName: line.speakerName, text: line.text });
        priorDialogueLines.push(spoken.slice(0, 220));
        if (line.isFactualClaim || spoken.length > 65) claimsSoFar.push(spoken.slice(0, 180));
      }
    }

    wordsWritten += movementWords;
    while (lastLines.length > 18) lastLines.shift();
    if (claimsSoFar.length > 80) claimsSoFar.splice(0, claimsSoFar.length - 80);
    if (priorDialogueLines.length > 140) priorDialogueLines.splice(0, priorDialogueLines.length - 140);
    state = normalizeState(result.stateAfter, state);
    rawSegments.push(...result.segments);

    args.onMovementComplete?.({
      movement: actIndex + 1,
      msSinceStart: Date.now() - startedAt,
      msForMovement: Date.now() - movementStartedAt,
      lines: quality.lines,
      words: movementWords,
    });

    args.log(
      `Movement ${actIndex + 1}/${acts.length}: ${movementWords} words; ` +
      `repeats=${quality.repeatedCurrentLines}; alternation=${Math.round(quality.strictAlternationRatio * 100)}%; ` +
      `state=${state.emotionalTemperature}; unresolved=${state.unresolvedThreads.length}.`
    );
  }

  if (wordsWritten < episodeMinimumWords) {
    throw new Error(
      `Movement-level generation completed with only ${wordsWritten} spoken words; ` +
      `the ${args.targetDuration}-minute episode requires at least ${episodeMinimumWords}.`
    );
  }

  return {
    segments: rawSegments,
    challenger: challengerResults.length > 0 ? challengerResults : undefined,
    privateAgendas,
    coldOpenTournament: coldOpen.tournament,
  };
}

async function generateInitialMovement(
  llm: LLMProvider,
  args: ActArgs
): Promise<{ segments: any[]; stateAfter: ConversationState }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await generateActSegments(llm, args);
    } catch (error) {
      lastError = error;
      console.warn(
        `[ScriptOutline] Movement ${args.actNumber} structural attempt ${attempt} failed: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  throw new Error(
    `Movement ${args.actNumber} generation failed twice: ` +
    `${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

export function countMovement(segments: any[]): { lines: number; words: number } {
  let lines = 0;
  let words = 0;
  for (const segment of segments || []) {
    for (const line of segment?.lines || []) {
      if (!line || typeof line.text !== "string") continue;
      lines++;
      words += stripAudioTags(line.text).split(/\s+/).filter(Boolean).length;
    }
  }
  return { lines, words };
}

/** Body beats grouped into three movements. Shared with the seven-role pipeline
 *  so both paths cut the episode into acts identically. */
export function groupIntoMovements(beats: OutlineBeat[]): OutlineBeat[][] {
  if (beats.length <= 3) return [beats];
  const closing = beats[beats.length - 1];
  const body = beats.slice(0, -1);
  const firstCut = Math.max(1, Math.ceil(body.length * 0.34));
  const secondCut = Math.max(firstCut + 1, Math.ceil(body.length * 0.72));
  return [
    body.slice(0, firstCut),
    body.slice(firstCut, secondCut),
    [...body.slice(secondCut), closing],
  ].filter((movement) => movement.length > 0);
}

function normalizeState(value: any, previous: ConversationState): ConversationState {
  const strings = (candidate: unknown) =>
    Array.isArray(candidate)
      ? candidate.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).slice(0, 6)
      : [];
  const allowed = new Set(["cool", "warming", "hot", "settling"]);
  return {
    emotionalTemperature: allowed.has(value?.emotionalTemperature)
      ? value.emotionalTemperature
      : previous.emotionalTemperature,
    unresolvedThreads: strings(value?.unresolvedThreads),
    positionShifts: strings(value?.positionShifts),
    callbacksAvailable: strings(value?.callbacksAvailable),
    relationshipChange:
      typeof value?.relationshipChange === "string" && value.relationshipChange.trim()
        ? value.relationshipChange.trim().slice(0, 300)
        : previous.relationshipChange,
  };
}

export async function rewriteLinesForGrounding(
  llm: LLMProvider,
  items: RewriteContext[],
  systemPrompt: string
): Promise<Map<number, { text: string; evidenceRefs?: any[]; isFactualClaim?: boolean }>> {
  const output = new Map<number, { text: string; evidenceRefs?: any[]; isFactualClaim?: boolean }>();
  if (items.length === 0) return output;

  const chunkSize = 15;
  for (let index = 0; index < items.length; index += chunkSize) {
    const chunk = items.slice(index, index + chunkSize);
    const lineBlocks = chunk.map((context) => {
      const figures = context.unsupportedFigures
        .map(
          (figure) =>
            `  - "${figure.surface}" (${figure.value}) is NOT in the evidence${
              figure.evidenceSays.length ? `; the evidence's numbers are: ${figure.evidenceSays.join(", ")}` : ""
            }`
        )
        .join("\n");
      const attributions = context.unsupportedAttributions
        .map((name) => `  - "${name}" is presented as saying/doing something specific, but is NOT in the evidence`)
        .join("\n");
      const semantic = context.semanticReason
        ? `\n  SEMANTIC REVIEWER FLAG: ${context.semanticReason}`
        : "";
      return `LINE ${context.line.lineIndex} — SPEAKER: ${context.line.speakerName}
  CURRENT TEXT: ${JSON.stringify(context.line.text)}
  VIOLATIONS:
${figures || "  (no figure violations)"}
${attributions}${semantic}
  EVIDENCE FOR THIS LINE:
  ${context.evidenceText || "(no specific evidence — keep the point qualitative)"}`;
    });

    const prompt = `Rewrite each listed line so every factual detail is supported, or make the line qualitative. Preserve the speaker's intent and the conversational action the line performs on the line before it. Do not polish it into an essay. Keep fragments, pressure, humor, and an ending em dash when present. Introduce no new fact and touch no unlisted line.

${lineBlocks.join("\n\n")}

A line kept as "isFactualClaim":true MUST carry at least one evidenceRefs entry copied VERBATIM from that line's EVIDENCE above — an exact phrase or number as written, never a paraphrase or a source name. If the evidence will not support the specific, the correct fix is to make the line qualitative and set "isFactualClaim":false with empty evidenceRefs. A true claim with empty refs is the defect this stage exists to remove, not an acceptable output.

Return valid JSON only. Both shapes:
{ "rewrites": [ { "lineIndex": 0, "text": "...", "isFactualClaim": true, "evidenceRefs": ["an exact phrase copied from that line's EVIDENCE"] }, { "lineIndex": 1, "text": "...", "isFactualClaim": false, "evidenceRefs": [] } ] }`;

    try {
      const result = await withLlmStage("script:selfverify-rewrite", () =>
        llm.generateStructuredOutput<any>({
          prompt,
          systemPrompt,
          temperature: 0.5,
          maxTokens: Math.min(300 * chunk.length + 600, 8000),
        })
      );
      const rewrites = Array.isArray(result?.rewrites) ? result.rewrites : [];
      const requested = new Set(chunk.map((context) => context.line.lineIndex));
      for (const rewrite of rewrites) {
        if (!requested.has(rewrite?.lineIndex)) continue;
        if (typeof rewrite?.text !== "string" || !rewrite.text.trim()) continue;
        output.set(rewrite.lineIndex, {
          text: rewrite.text,
          evidenceRefs: Array.isArray(rewrite.evidenceRefs) ? rewrite.evidenceRefs : undefined,
          isFactualClaim: typeof rewrite.isFactualClaim === "boolean" ? rewrite.isFactualClaim : undefined,
        });
      }
    } catch (error: any) {
      console.warn(`[SelfVerify] batched rewrite failed: ${error?.message}`);
    }
  }
  return output;
}

/**
 * The beat sheet.
 *
 * Exported because the seven-role pipeline's DEBATE ARCHITECT owns this job and
 * must not re-implement it: the beat contract (6-8 beats, one cold open, one
 * closing, every fact assigned once, no scheduled jokes) is the same contract
 * whichever pipeline asks for it. When `spine` is supplied — the story editor's
 * output in the seven-role pipeline — the beats are built to serve that spine
 * instead of inventing a second, competing one.
 */
export async function generateEpisodeOutline(
  llm: LLMProvider,
  args: OutlineDrivenArgs,
  creativeSystemPrompt: string,
  spine?: unknown
): Promise<OutlineBeat[]> {
  const prompt = [
    `You are showrunning episode "${args.episodeTitle}" (roughly ${args.targetDuration} minutes).`,
    "",
    ...(spine
      ? [
          "THE STORY EDITOR HAS ALREADY DECIDED WHAT THIS EPISODE IS ABOUT.",
          "Do not replace the spine, soften it, or add a competing central question.",
          "Every beat must serve it:",
          JSON.stringify(spine, null, 2),
          "",
        ]
      : []),
    "TOPICS & EVIDENCE:",
    args.topicsPrompts,
    "",
    "Build a SMALL story spine, not a rundown checklist.",
    "- Use 6 to 8 beats total. Beat 1 is a cold open already in motion. The final beat is a closing payoff.",
    "- Organize the episode around one unresolved central question. Additional topics must deepen, complicate, or unexpectedly answer it; do not merely move to the next headline.",
    "- Every beat changes something: leverage, emotional temperature, a host's position, what the listener believes, or the relationship between the hosts.",
    "- Plan at least one genuine position shift or newly exposed stake. It may be small; it must be caused by the discussion, not scheduled as a ceremonial concession.",
    "- Assign each evidence fact to at most one beat. Facts are ammunition, not the plot.",
    "- Do not schedule jokes, filler, interruptions, tangents, catchphrases, callbacks, or audio tags. A callback note is allowed only when a concrete earlier phrase or image could naturally return.",
    "- Prefer fewer, deeper movements over exhaustive coverage. It is acceptable to leave a weak topic out.",
    "",
    "Return valid JSON only:",
    `{ "beats": [ { "beatIndex": 0, "segmentType": "cold_open|intro|topic|transition|closing", "title": "...", "goal": "what changes", "angle": "specific pressure/question", "topicId": "optional", "factRefs": [], "escalation": "how stakes or understanding change", "callback": "optional concrete phrase/image" } ] }`,
  ].join("\n");

  const result = await withLlmStage("script:outline", () =>
    llm.generateStructuredOutput<any>({
      prompt,
      systemPrompt: creativeSystemPrompt,
      temperature: Math.min(args.temperature, 0.7),
      maxTokens: Math.min(args.maxTokens, 7000),
      validate: (value) =>
        Array.isArray((value as { beats?: unknown })?.beats)
          ? null
          : "Outline is missing the required 'beats' array.",
    })
  );

  const beats: OutlineBeat[] = Array.isArray(result?.beats) ? result.beats.slice(0, 8) : [];
  if (beats.length < 5) throw new Error(`Outline returned only ${beats.length} beats.`);
  beats.forEach((beat, index) => (beat.beatIndex = index));
  beats[0].segmentType = "cold_open";
  beats[beats.length - 1].segmentType = "closing";

  const seenFacts = new Set<string>();
  for (const beat of beats) {
    beat.factRefs = (Array.isArray(beat.factRefs) ? beat.factRefs : []).filter((reference) => {
      if (!reference || !reference.type || !reference.id) return false;
      const key = `${reference.type}:${reference.id}`;
      if (seenFacts.has(key)) return false;
      seenFacts.add(key);
      return true;
    });
  }
  return beats;
}

interface ActArgs {
  creativeSystemPrompt: string;
  episodeTitle: string;
  topicsPrompts: string;
  beats: OutlineBeat[];
  actBeats: OutlineBeat[];
  actNumber: number;
  actCount: number;
  claimsSoFar: string[];
  lastLines: { speakerName: string; text: string }[];
  state: ConversationState;
  softWordTarget: number;
  temperature: number;
  maxTokens: number;
  speakerNames: string[];
  privateAgendas: PrivateHostAgenda[];
}

function actContext(args: ActArgs): {
  outlineRecap: string;
  beatsDetail: string;
  claimsBlock: string;
  lastExchange: string;
} {
  const firstNow = args.actBeats[0]?.beatIndex ?? 0;
  const lastNow = args.actBeats[args.actBeats.length - 1]?.beatIndex ?? firstNow;
  const outlineRecap = args.beats
    .map((beat, index) => `${index < firstNow ? "[DONE]" : index > lastNow ? "[LATER]" : ">>> NOW"} ${index + 1}. ${beat.segmentType} — ${beat.title}: ${beat.angle}`)
    .join("\n");
  const beatsDetail = args.actBeats
    .map((beat) => `Beat ${beat.beatIndex + 1} (${beat.segmentType}) — ${beat.title}\n  Change: ${beat.goal}\n  Pressure: ${beat.angle}\n  Escalation: ${beat.escalation || "n/a"}\n  Optional callback seed: ${beat.callback || "none"}\n  TopicId: ${beat.topicId || "n/a"}\n  Assigned facts: ${JSON.stringify(beat.factRefs)}`)
    .join("\n\n");
  const claimsBlock = args.claimsSoFar.length
    ? args.claimsSoFar.map((claim) => `- ${claim}`).join("\n")
    : "(nothing yet)";
  const lastExchange = args.lastLines.length
    ? args.lastLines.map((line) => `${line.speakerName}: ${line.text}`).join("\n")
    : "(start cold, already in motion)";
  return { outlineRecap, beatsDetail, claimsBlock, lastExchange };
}

async function generateActSegments(
  llm: LLMProvider,
  args: ActArgs
): Promise<{ segments: any[]; stateAfter: ConversationState }> {
  const { outlineRecap, beatsDetail, claimsBlock, lastExchange } = actContext(args);
  const minimumWords = Math.max(160, Math.round(args.softWordTarget * 0.82));
  const idealWords = Math.max(minimumWords, Math.round(args.softWordTarget));
  const maximumWords = Math.max(idealWords + 80, Math.round(args.softWordTarget * 1.18));

  const prompt = `Write MOVEMENT ${args.actNumber} of ${args.actCount} of "${args.episodeTitle}".

FULL STORY SPINE:
${outlineRecap}

BEATS TO WRITE NOW:
${beatsDetail}

CURRENT RELATIONSHIP / ARGUMENT STATE:
${JSON.stringify(args.state, null, 2)}

PRIVATE HOST AGENDAS — keep them asymmetric; never have one host explain the
other host's agenda or speak these labels aloud:
${args.privateAgendas.map((agenda) => `${agenda.speakerName}: ${JSON.stringify(agenda)}`).join("\n")}

LAST EXCHANGE — continue its emotional and conversational logic:
${lastExchange}

ALREADY ESTABLISHED — do not restate:
${claimsBlock}

TOPIC EVIDENCE — only facts assigned to the current beats may be newly introduced:
${args.topicsPrompts}

LENGTH CONTRACT:
- Write at least ${minimumWords} spoken words and aim for roughly ${idealWords}.
- Do not exceed roughly ${maximumWords} words.
- The minimum is required. Do not stop merely because the headline take has been stated; deepen the human disagreement, consequence, uncertainty, and response until every assigned beat changes something.
- Do not pad with recaps, repeated facts, generic filler, or a second version of the same point.

NON-NEGOTIABLE CONVERSATIONAL TESTS:
- Each turn must visibly respond to the previous turn. Generic lines that could be relocated fail.
- Do not alternate mechanically. Let a host build a thought across consecutive lines when the pressure warrants it, and use short reactions only when they are specific to what was just said.
- Do not insert filler, false starts, interruptions, laughter, agreement, tangents, callbacks, catchphrases, or dramatic pauses because podcasts supposedly contain them.
- Do not force conflict. Curiosity, embarrassment, recognition, partial agreement, and a quiet correction can be more gripping than shouting.
- Preserve asymmetry: the hosts have different motives, sentence shapes, vulnerabilities, and ways of avoiding a point.
- A factual correction must still sound like a person answering a person, not a fact-check note.
- Delivery fields annotate the line you already wrote. Never write a line merely to create metadata variety.

GROUNDING:
Every specific number, date, result, record, quote, named-person action, injury or transaction stated as true must be present in the assigned evidence and carry its ref. When evidence is absent, argue vividly without a fabricated specific.

Return valid JSON only:
{
  "segments": [
    {
      "type": "cold_open|intro|topic|transition|closing",
      "title": "...",
      "topicId": "optional",
      "lines": [
        {
          "lineIndex": 0,
          "speakerName": ${args.speakerNames.map((name) => JSON.stringify(name)).join(" | ")},
          "text": "spoken words",
          "tone": "heated|sarcastic|analytical|dismissive|amused|incredulous|conceding|excited|reflective|setup|transition",
          "energy": "low|medium|high",
          "pauseBefore": "none|beat|breath|long",
          "isInterruption": false,
          "evidenceRefs": [],
          "isFactualClaim": false,
          "needsHumanReview": false
        }
      ]
    }
  ],
  "stateAfter": {
    "emotionalTemperature": "cool|warming|hot|settling",
    "unresolvedThreads": ["specific question still alive"],
    "positionShifts": ["what changed and why"],
    "callbacksAvailable": ["exact phrase/image that could naturally return"],
    "relationshipChange": "one sentence describing how the hosts now stand relative to each other"
  }
}`;

  const result = await withLlmStage("script:acts", () =>
    llm.generateStructuredOutput<any>({
      prompt,
      systemPrompt: args.creativeSystemPrompt,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      validate: validateScriptShape,
    })
  );

  const segments = Array.isArray(result?.segments) ? result.segments : [];
  const lineCount = segments.reduce(
    (total: number, segment: any) => total + (Array.isArray(segment?.lines) ? segment.lines.length : 0),
    0
  );
  if (lineCount === 0) throw new Error("Movement returned zero lines.");
  return { segments, stateAfter: normalizeState(result?.stateAfter, args.state) };
}

async function repairActSegments(
  llm: LLMProvider,
  args: ActArgs,
  draft: { segments: any[]; stateAfter: ConversationState },
  quality: MovementQualityReport,
  repairRound: number
): Promise<{ segments: any[]; stateAfter: ConversationState }> {
  const { outlineRecap, beatsDetail, claimsBlock, lastExchange } = actContext(args);
  const prompt = `Repair MOVEMENT ${args.actNumber} of ${args.actCount}. Return the entire corrected movement, not a patch.

WHY THIS DRAFT FAILED:
${quality.failures.map((failure) => `- ${failure}`).join("\n")}

MEASURED DRAFT:
- ${quality.words} spoken words; minimum ${quality.minimumWords}
- ${quality.repeatedCurrentLines} repeated current line(s)
- ${Math.round(quality.strictAlternationRatio * 100)}% strict speaker alternation
- ${quality.sameSpeakerBuilds} same-speaker build(s)
- ${Math.round(quality.shortReactionRatio * 100)}% short reactions

REPAIR RULES:
- Preserve the same assigned beats, speakers, evidence references, factual claims, and overall argument direction.
- Reach at least ${quality.minimumWords} spoken words by deepening consequences, motives, uncertainty, rebuttals, and reactions—not by recapping or repeating facts.
- Replace every duplicated or portable line with a response caused by the line before it.
- Vary turn shape naturally. A host may continue for a second line; a short reaction must refer to the exact preceding point.
- Add no new fact, number, date, quote, injury, transaction, result, or named-person action.
- Keep this spoken and emotionally specific. Do not polish it into an essay.

FULL STORY SPINE:
${outlineRecap}

BEATS FOR THIS MOVEMENT:
${beatsDetail}

LAST EXCHANGE BEFORE THIS MOVEMENT:
${lastExchange}

ALREADY ESTABLISHED — do not repeat:
${claimsBlock}

CURRENT DRAFT:
${JSON.stringify(draft, null, 2)}

Return valid JSON only with the same schema as the draft: { "segments": [...], "stateAfter": {...} }`;

  const result = await withLlmStage("script:acts", () =>
    llm.generateStructuredOutput<any>({
      prompt,
      systemPrompt: args.creativeSystemPrompt,
      temperature: Math.max(0.45, args.temperature - repairRound * 0.08),
      maxTokens: args.maxTokens,
      validate: validateScriptShape,
    })
  );

  const segments = Array.isArray(result?.segments) ? result.segments : [];
  return { segments, stateAfter: normalizeState(result?.stateAfter, draft.stateAfter) };
}
