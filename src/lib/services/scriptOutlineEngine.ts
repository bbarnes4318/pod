// Outline-driven progressive script generation.
//
// The previous engine treated natural conversation as a checklist: a target
// number of lines, scheduled interruptions, required reaction fragments and
// metadata variety. That produced scripts which *displayed* human mannerisms
// without the conversational cause-and-effect that makes people sound alive.
//
// This version plans a small story spine, writes three large movements, and
// carries relationship state between calls. Word-count ranges are soft; line
// counts are never targeted. Delivery metadata describes what naturally
// happened in the dialogue instead of driving the writing.

import { LLMProvider } from "../providers/llm/interface";
import { withLlmStage } from "../providers/llm/costLedger";
import { stripAudioTags } from "../audio/speechText";
import { RewriteContext } from "./scriptSelfVerify";

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
  /** The cast host names in seat order (1-4) — the only valid speakerName values. */
  speakerNames: string[];
  /** Model for the OUTLINE call (script_outline role). Defaults to the movement
   *  model when absent, which is what the single-provider callers rely on. */
  outlineLlm?: LLMProvider;
  /** Second dialogue model for a challenger comparison run. When present, each
   *  movement is generated twice from IDENTICAL inputs and both results are
   *  reported; the challenger's segments are NEVER mixed into the episode. */
  challengerLlm?: LLMProvider;
  /** Label for the challenger in logs, e.g. "nvidia/moonshotai/kimi-k2.6". */
  challengerLabel?: string;
  /**
   * Called as each movement completes, with the wall time SINCE THE CALL BEGAN.
   *
   * Exists so a comparison can report time-to-first-completed-movement, which is
   * the number that actually matters for a slow dialogue model: an episode that
   * needs three sequential movements at 80s each is a different product decision
   * from one that needs three at 8s, and a single total hides which movement was
   * slow.
   */
  onMovementComplete?: (info: {
    movement: number;
    msSinceStart: number;
    msForMovement: number;
    lines: number;
    words: number;
  }) => void;
  log: (msg: string) => void;
}

/**
 * Structural check for a generated script object, applied at the provider edge
 * so a broken shape triggers the one allowed repair (and then the role's next
 * model) instead of surfacing three services later as a mysteriously short
 * episode. Returns an error message, or null when the shape is usable.
 */
export function validateScriptShape(value: unknown): string | null {
  const segments = (value as { segments?: unknown })?.segments;
  if (!Array.isArray(segments)) return "Response is missing the required 'segments' array.";
  if (segments.length === 0) return "Response contains zero segments.";
  let lines = 0;
  for (const seg of segments) {
    const segLines = (seg as { lines?: unknown })?.lines;
    if (!Array.isArray(segLines)) return "A segment is missing its 'lines' array.";
    lines += segLines.length;
  }
  if (lines === 0) return "Every segment is empty — the script has no lines.";
  return null;
}

/** One movement's result, plus which model produced it. */
export interface ChallengerMovementResult {
  movement: number;
  label: string;
  ok: boolean;
  lines: number;
  words: number;
  ms: number;
  /** Honest failure reporting — an incomplete generation is reported, not hidden. */
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

/**
 * Keep the actual cast/persona material and persistent-show continuity, while
 * dropping the giant mechanics checklist. Evidence and factual rules stay in
 * the act prompt, where they are concrete and relevant.
 */
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
): Promise<{ segments: any[]; challenger?: ChallengerMovementResult[] }> {
  const creativeSystemPrompt = compactCreativeSystemPrompt(args.systemPrompt);
  // The outline is its own role. A caller that passes only one provider (the
  // A/B harness, the local test scripts) keeps the old single-model behavior.
  const outlineLlm = args.outlineLlm ?? llm;
  const beats = await generateEpisodeOutline(outlineLlm, args, creativeSystemPrompt);
  args.log(`Story spine: ${beats.length} beats across three conversational movements.`);
  const challengerResults: ChallengerMovementResult[] = [];
  const startedAt = Date.now();

  const acts = groupIntoMovements(beats);
  const rawSegments: any[] = [];
  const claimsSoFar: string[] = [];
  const lastLines: { speakerName: string; text: string }[] = [];
  let state: ConversationState = { ...EMPTY_STATE };
  const totalWordTarget = Math.max(550, Math.round(args.targetDuration * 145));
  let wordsWritten = 0;

  for (let actIdx = 0; actIdx < acts.length; actIdx++) {
    const remainingActs = acts.length - actIdx;
    const remainingWords = Math.max(180, totalWordTarget - wordsWritten);
    const softWordTarget = Math.max(180, Math.round(remainingWords / remainingActs));

    // IDENTICAL INPUTS for the primary and (optionally) the challenger: same
    // outline, same evidence, same prior-movement context, same relationship
    // state, same character prompt, same word target, same token allowance.
    // Anything else would make the comparison meaningless.
    const actArgs: ActArgs = {
      creativeSystemPrompt,
      episodeTitle: args.episodeTitle,
      topicsPrompts: args.topicsPrompts,
      beats,
      actBeats: acts[actIdx],
      actNumber: actIdx + 1,
      actCount: acts.length,
      claimsSoFar,
      lastLines,
      state,
      softWordTarget,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      speakerNames: args.speakerNames,
    };

    let result: { segments: any[]; stateAfter: ConversationState } | null = null;
    let lastErr: any = null;
    const movementStartedAt = Date.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        result = await generateActSegments(llm, actArgs);
        break;
      } catch (err: any) {
        lastErr = err;
        console.warn(`[ScriptOutline] Movement ${actIdx + 1} attempt ${attempt} failed: ${err.message}`);
      }
    }
    if (!result) {
      throw new Error(`Movement ${actIdx + 1} generation failed twice: ${lastErr?.message}`);
    }

    // Challenger run. Its output is SCORED and STORED, never spliced into this
    // episode — one episode is written by one dialogue model.
    if (args.challengerLlm) {
      const label = args.challengerLabel || "challenger";
      const startedAt = Date.now();
      try {
        const alt = await generateActSegments(args.challengerLlm, actArgs);
        const stats = countMovement(alt.segments);
        challengerResults.push({
          movement: actIdx + 1,
          label,
          ok: true,
          lines: stats.lines,
          words: stats.words,
          ms: Date.now() - startedAt,
          segments: alt.segments,
        });
        args.log(`Challenger ${label} movement ${actIdx + 1}: ${stats.lines} lines / ${stats.words} words.`);
      } catch (err: any) {
        // Reported, never swallowed: a challenger that cannot complete the
        // movement is exactly the finding the comparison exists to produce.
        challengerResults.push({
          movement: actIdx + 1,
          label,
          ok: false,
          lines: 0,
          words: 0,
          ms: Date.now() - startedAt,
          error: err?.message || String(err),
        });
        args.log(`Challenger ${label} movement ${actIdx + 1} FAILED: ${err?.message}`);
      }
    }

    let movementWords = 0;
    for (const seg of result.segments) {
      if (!seg || !Array.isArray(seg.lines)) continue;
      for (const line of seg.lines) {
        if (!line || typeof line.text !== "string") continue;
        const spoken = stripAudioTags(line.text);
        movementWords += spoken.split(/\s+/).filter(Boolean).length;
        lastLines.push({ speakerName: line.speakerName, text: line.text });
        if (line.isFactualClaim || spoken.length > 65) claimsSoFar.push(spoken.slice(0, 180));
      }
    }
    wordsWritten += movementWords;
    while (lastLines.length > 18) lastLines.shift();
    if (claimsSoFar.length > 80) claimsSoFar.splice(0, claimsSoFar.length - 80);
    state = normalizeState(result.stateAfter, state);
    rawSegments.push(...result.segments);

    args.onMovementComplete?.({
      movement: actIdx + 1,
      msSinceStart: Date.now() - startedAt,
      msForMovement: Date.now() - movementStartedAt,
      lines: result.segments.reduce((n: number, s: any) => n + (Array.isArray(s?.lines) ? s.lines.length : 0), 0),
      words: movementWords,
    });

    args.log(
      `Movement ${actIdx + 1}/${acts.length}: ${movementWords} words; state=${state.emotionalTemperature}; unresolved=${state.unresolvedThreads.length}.`
    );
  }

  return {
    segments: rawSegments,
    challenger: challengerResults.length > 0 ? challengerResults : undefined,
  };
}

/** Lines and spoken words in a movement's segments. */
function countMovement(segments: any[]): { lines: number; words: number } {
  let lines = 0;
  let words = 0;
  for (const seg of segments || []) {
    for (const line of seg?.lines || []) {
      if (!line || typeof line.text !== "string") continue;
      lines++;
      words += stripAudioTags(line.text).split(/\s+/).filter(Boolean).length;
    }
  }
  return { lines, words };
}

function groupIntoMovements(beats: OutlineBeat[]): OutlineBeat[][] {
  if (beats.length <= 3) return [beats];
  const closing = beats[beats.length - 1];
  const body = beats.slice(0, -1);
  const firstCut = Math.max(1, Math.ceil(body.length * 0.34));
  const secondCut = Math.max(firstCut + 1, Math.ceil(body.length * 0.72));
  return [
    body.slice(0, firstCut),
    body.slice(firstCut, secondCut),
    [...body.slice(secondCut), closing],
  ].filter((a) => a.length > 0);
}

function normalizeState(value: any, previous: ConversationState): ConversationState {
  const arr = (v: unknown) =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 6)
      : [];
  const allowed = new Set(["cool", "warming", "hot", "settling"]);
  return {
    emotionalTemperature: allowed.has(value?.emotionalTemperature)
      ? value.emotionalTemperature
      : previous.emotionalTemperature,
    unresolvedThreads: arr(value?.unresolvedThreads),
    positionShifts: arr(value?.positionShifts),
    callbacksAvailable: arr(value?.callbacksAvailable),
    relationshipChange:
      typeof value?.relationshipChange === "string" && value.relationshipChange.trim()
        ? value.relationshipChange.trim().slice(0, 300)
        : previous.relationshipChange,
  };
}

/** Ask the model to rewrite ALL flagged ungrounded lines in ONE batched call. */
export async function rewriteLinesForGrounding(
  llm: LLMProvider,
  items: RewriteContext[],
  systemPrompt: string
): Promise<Map<number, { text: string; evidenceRefs?: any[]; isFactualClaim?: boolean }>> {
  const out = new Map<number, { text: string; evidenceRefs?: any[]; isFactualClaim?: boolean }>();
  if (items.length === 0) return out;

  const CHUNK = 15;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const lineBlocks = chunk.map((ctx) => {
      const figs = ctx.unsupportedFigures
        .map(
          (f) =>
            `  - "${f.surface}" (${f.value}) is NOT in the evidence${
              f.evidenceSays.length ? `; the evidence's numbers are: ${f.evidenceSays.join(", ")}` : ""
            }`
        )
        .join("\n");
      const attrs = ctx.unsupportedAttributions
        .map((n) => `  - "${n}" is presented as saying/doing something specific, but is NOT in the evidence`)
        .join("\n");
      const semantic = ctx.semanticReason
        ? `\n  SEMANTIC REVIEWER FLAG: ${ctx.semanticReason}`
        : "";
      return `LINE ${ctx.line.lineIndex} — SPEAKER: ${ctx.line.speakerName}
  CURRENT TEXT: ${JSON.stringify(ctx.line.text)}
  VIOLATIONS:
${figs || "  (no figure violations)"}
${attrs}${semantic}
  EVIDENCE FOR THIS LINE:
  ${ctx.evidenceText || "(no specific evidence — keep the point qualitative)"}`;
    });

    const prompt = `Rewrite each listed line so every factual detail is supported, or make the line qualitative. Preserve the speaker's intent and the conversational action the line performs on the line before it. Do not polish it into an essay. Keep fragments, pressure, humor, and an ending em dash when present. Introduce no new fact and touch no unlisted line.

${lineBlocks.join("\n\n")}

Return valid JSON only:
{ "rewrites": [ { "lineIndex": 0, "text": "...", "isFactualClaim": true, "evidenceRefs": [] } ] }`;

    try {
      const res = await withLlmStage("script:selfverify-rewrite", () =>
        llm.generateStructuredOutput<any>({
          prompt,
          systemPrompt,
          temperature: 0.5,
          maxTokens: Math.min(300 * chunk.length + 600, 8000),
        })
      );
      const rewrites = Array.isArray(res?.rewrites) ? res.rewrites : [];
      const requested = new Set(chunk.map((c) => c.line.lineIndex));
      for (const rw of rewrites) {
        if (!requested.has(rw?.lineIndex)) continue;
        if (typeof rw?.text !== "string" || !rw.text.trim()) continue;
        out.set(rw.lineIndex, {
          text: rw.text,
          evidenceRefs: Array.isArray(rw.evidenceRefs) ? rw.evidenceRefs : undefined,
          isFactualClaim: typeof rw.isFactualClaim === "boolean" ? rw.isFactualClaim : undefined,
        });
      }
    } catch (err: any) {
      console.warn(`[SelfVerify] batched rewrite failed: ${err?.message}`);
    }
  }
  return out;
}

async function generateEpisodeOutline(
  llm: LLMProvider,
  args: OutlineDrivenArgs,
  creativeSystemPrompt: string
): Promise<OutlineBeat[]> {
  const prompt = [
    `You are showrunning episode "${args.episodeTitle}" (roughly ${args.targetDuration} minutes).`,
    ``,
    `TOPICS & EVIDENCE:`,
    args.topicsPrompts,
    ``,
    `Build a SMALL story spine, not a rundown checklist.`,
    `- Use 6 to 8 beats total. Beat 1 is a cold open already in motion. The final beat is a closing payoff.`,
    `- Organize the episode around one unresolved central question. Additional topics must deepen, complicate, or unexpectedly answer it; do not merely move to the next headline.`,
    `- Every beat changes something: leverage, emotional temperature, a host's position, what the listener believes, or the relationship between the hosts.`,
    `- Plan at least one genuine position shift or newly exposed stake. It may be small; it must be caused by the discussion, not scheduled as a ceremonial concession.`,
    `- Assign each evidence fact to at most one beat. Facts are ammunition, not the plot.`,
    `- Do not schedule jokes, filler, interruptions, tangents, catchphrases, callbacks, or audio tags. A callback note is allowed only when a concrete earlier phrase or image could naturally return.`,
    `- Prefer fewer, deeper movements over exhaustive coverage. It is acceptable to leave a weak topic out.`,
    ``,
    `Return valid JSON only:`,
    `{ "beats": [ { "beatIndex": 0, "segmentType": "cold_open|intro|topic|transition|closing", "title": "...", "goal": "what changes", "angle": "specific pressure/question", "topicId": "optional", "factRefs": [], "escalation": "how stakes or understanding change", "callback": "optional concrete phrase/image" } ] }`,
  ].join("\n");

  const res = await withLlmStage("script:outline", () =>
    llm.generateStructuredOutput<any>({
      prompt,
      systemPrompt: creativeSystemPrompt,
      temperature: Math.min(args.temperature, 0.7),
      // The outline allowance stays at 7,000 — unchanged by role routing.
      maxTokens: Math.min(args.maxTokens, 7000),
      // The outline is the plan every later movement is written against, so a
      // beat-less outline is rejected at the edge rather than after the
      // five-beat floor check below has already discarded the whole call.
      validate: (v) =>
        Array.isArray((v as { beats?: unknown })?.beats)
          ? null
          : "Outline is missing the required 'beats' array.",
    })
  );

  const beats: OutlineBeat[] = Array.isArray(res?.beats) ? res.beats.slice(0, 8) : [];
  if (beats.length < 5) throw new Error(`Outline returned only ${beats.length} beats.`);
  beats.forEach((b, i) => (b.beatIndex = i));
  beats[0].segmentType = "cold_open";
  beats[beats.length - 1].segmentType = "closing";

  const seenFacts = new Set<string>();
  for (const beat of beats) {
    beat.factRefs = (Array.isArray(beat.factRefs) ? beat.factRefs : []).filter((ref) => {
      if (!ref || !ref.type || !ref.id) return false;
      const key = `${ref.type}:${ref.id}`;
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
}

async function generateActSegments(
  llm: LLMProvider,
  args: ActArgs
): Promise<{ segments: any[]; stateAfter: ConversationState }> {
  const firstNow = args.actBeats[0]?.beatIndex ?? 0;
  const lastNow = args.actBeats[args.actBeats.length - 1]?.beatIndex ?? firstNow;
  const outlineRecap = args.beats
    .map((b, i) => `${i < firstNow ? "[DONE]" : i > lastNow ? "[LATER]" : ">>> NOW"} ${i + 1}. ${b.segmentType} — ${b.title}: ${b.angle}`)
    .join("\n");
  const beatsDetail = args.actBeats
    .map((b) => `Beat ${b.beatIndex + 1} (${b.segmentType}) — ${b.title}\n  Change: ${b.goal}\n  Pressure: ${b.angle}\n  Escalation: ${b.escalation || "n/a"}\n  Optional callback seed: ${b.callback || "none"}\n  TopicId: ${b.topicId || "n/a"}\n  Assigned facts: ${JSON.stringify(b.factRefs)}`)
    .join("\n\n");
  const claimsBlock = args.claimsSoFar.length ? args.claimsSoFar.map((c) => `- ${c}`).join("\n") : "(nothing yet)";
  const lastExchange = args.lastLines.length ? args.lastLines.map((l) => `${l.speakerName}: ${l.text}`).join("\n") : "(start cold, already in motion)";

  const prompt = `Write MOVEMENT ${args.actNumber} of ${args.actCount} of "${args.episodeTitle}".

FULL STORY SPINE:
${outlineRecap}

BEATS TO WRITE NOW:
${beatsDetail}

CURRENT RELATIONSHIP / ARGUMENT STATE:
${JSON.stringify(args.state, null, 2)}

LAST EXCHANGE — continue its emotional and conversational logic:
${lastExchange}

ALREADY ESTABLISHED — do not restate:
${claimsBlock}

TOPIC EVIDENCE — only facts assigned to the current beats may be newly introduced:
${args.topicsPrompts}

Write a continuous conversation of roughly ${Math.round(args.softWordTarget * 0.75)}-${Math.round(args.softWordTarget * 1.2)} spoken words. This is a soft range, never a reason to pad. End the movement when its change has landed.

NON-NEGOTIABLE CONVERSATIONAL TESTS:
- Each turn must visibly respond to the previous turn. Generic lines that could be relocated fail.
- Do not alternate mechanically. A speaker may hold the floor; the other may answer with one word, a question, silence implied by a pause, or a full counterargument.
- Do not insert filler, false starts, interruptions, laughter, agreement, tangents, callbacks, catchphrases, or dramatic pauses because podcasts supposedly contain them. Include one only when this exact moment causes it.
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
          "speakerName": ${args.speakerNames.map((n) => JSON.stringify(n)).join(" | ")},
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

  const res = await withLlmStage("script:acts", () =>
    llm.generateStructuredOutput<any>({
      prompt,
      systemPrompt: args.creativeSystemPrompt,
      temperature: args.temperature,
      // The caller's movement allowance, passed through untouched (16,000 in
      // production). A provider that cannot honor it must fail loudly, not
      // quietly return half a movement.
      maxTokens: args.maxTokens,
      validate: validateScriptShape,
    })
  );

  const segments = Array.isArray(res?.segments) ? res.segments : [];
  const lineCount = segments.reduce((n: number, s: any) => n + (Array.isArray(s?.lines) ? s.lines.length : 0), 0);
  if (lineCount === 0) throw new Error("Movement returned zero lines.");
  return { segments, stateAfter: normalizeState(res?.stateAfter, args.state) };
}
