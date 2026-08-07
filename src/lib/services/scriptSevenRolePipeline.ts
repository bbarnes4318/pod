// The SEVEN-ROLE writing pipeline.
//
// This is a restructuring of generateOutlineDrivenScript, not a replacement for
// what it did well. The outline, the private agendas, the cold-open tournament
// (three candidates in an 80-120 word band, chosen by an independent text judge)
// and the character-separated writing all survive. What changes is that they
// stop being phases of one model's job and become SEVEN roles with seven
// separately routed providers, seven provenance records, and structural
// enforcement between them:
//
//   1 story_editor       the spine: what this is about, what stays unresolved
//   2 debate_architect   beats + evidence assignment + turn plan + private briefs
//                        + the cold-open tournament that opens the episode
//   3 host_a_writer      host A's lines. Filtered to host A's turns.
//   4 host_b_writer      host B's lines. Filtered to host B's turns.
//   5 dialogue_director   the JOINS between turns two writers wrote separately
//   6 continuity_editor  callbacks, character history, running bits (report only)
//   7 independent_judge  scores the finished script (existing quality_judge)
//
// THE THREE STRUCTURAL GUARANTEES, none of which is a prompt instruction:
//
//   ISOLATION      Each host writer's composed prompt is scanned for the OTHER
//                  host's private brief and any occurrence is redacted before
//                  the call, with the redaction recorded as a violation. A
//                  leak through an architect-written turn intent is therefore
//                  caught rather than trusted away.
//   AUTHORSHIP     Each host writer's returned lines are filtered to lines whose
//                  speakerName AND turnIndex belong to that host. Anything else
//                  is dropped and recorded. Host A cannot author host B.
//   DISTINCTNESS   The director's pass is measured before it is applied. If it
//                  wants more than a bounded fraction of a host's lines, or if
//                  the result collapses the two hosts' exclusive vocabularies
//                  toward one voice, the WHOLE pass is reverted and the stage
//                  fails — which holds production.

import type { LLMProvider } from "../providers/llm/interface";
import { stripAudioTags } from "../audio/speechText";
import {
  detectPositionSwaps,
  spokenWords,
  type ScriptSegmentLike,
} from "./productionInvariants";
import {
  compactCreativeSystemPrompt,
  generateEpisodeOutline,
  groupIntoMovements,
  type OutlineBeat,
  type OutlineDrivenArgs,
} from "./scriptOutlineEngine";
import {
  directDialogueTransitions,
  generatePrivateHostAgendas,
  pickStorySpine,
  planDebateTurns,
  privateBriefTerms,
  reviewContinuity,
  runColdOpenTextTournament,
  writeHostLines,
  type ColdOpenTournamentResult,
  type ContinuityEditorReport,
  type CreativeScriptLine,
  type CreativeScriptSegment,
  type EpisodeSpine,
  type PrivateHostAgenda,
  type TurnPlanEntry,
} from "./scriptCreativePipeline";
import {
  SevenRoleTrace,
  artifactRef,
  type ArtifactRef,
  type RoleProviderResolver,
  type RoleStageRecord,
  type RoleViolation,
  type SevenRole,
} from "./scriptRoles";
import { assessScriptQuality, type CombinedQualityReport } from "./scriptQualityJudge";
import { getRoleLLMProvider, resolveRolePlan, candidateKey } from "../providers/llm/routing";
import { planColdOpenWriterRoutes } from "../providers/llm/routingAudit";
import { readRoutingEnv, roleOverrideKeys } from "../providers/llm/routingEnv";
import type { LLMRole } from "../providers/llm/roles";

/** Has an operator actually routed the cold-open judge? Unset means "inherit". */
function coldOpenJudgeIsRouted(): boolean {
  return Boolean(readRoutingEnv(roleOverrideKeys("cold_open_judge").providerKey));
}

/** provider/model for a role, for the tournament's authorship record. Never a key. */
function coldOpenRouteLabel(role: LLMRole): string {
  try {
    const first = resolveRolePlan(role).candidates[0];
    return first ? candidateKey(first) : "(unresolved)";
  } catch {
    return "(unresolved)";
  }
}

// ---------------------------------------------------------------- thresholds
//
// These are the bounds the director is held to. They are deliberately module
// constants rather than env-tunable: an operator who can widen the bound at
// deploy time can disable the guarantee without a code review, and "we turned
// the threshold down until it went green" is exactly the failure this file is
// supposed to make impossible.

/** No more than this fraction of any ONE host's lines may be touched. */
export const DIRECTOR_MAX_CHANGED_FRACTION = 0.35;
/** A repaired line must keep at least this much of its original vocabulary. */
export const DIRECTOR_MIN_LINE_SIMILARITY = 0.5;
/** Host distinctness may not fall below this fraction of its pre-director value. */
export const MIN_RETAINED_DISTINCTNESS = 0.75;
/** No single host may lose more than this fraction of its exclusive vocabulary. */
export const MIN_RETAINED_HOST_EXCLUSIVITY = 0.6;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "for", "with", "at", "by",
  "from", "is", "are", "was", "were", "be", "been", "being", "it", "its", "that", "this", "these",
  "those", "you", "your", "i", "im", "ive", "me", "my", "we", "our", "they", "them", "their", "he",
  "she", "his", "her", "not", "no", "so", "as", "than", "then", "there", "here", "what", "which",
  "who", "when", "where", "how", "why", "all", "any", "just", "like", "get", "got", "do", "does",
  "did", "have", "has", "had", "can", "could", "would", "should", "will", "about", "into", "out",
  "up", "down", "over", "under", "thats", "youre", "dont", "hes", "shes", "theyre",
]);

function contentTokens(text: string): Set<string> {
  return new Set(spokenWords(text).filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

// ---------------------------------------------------------------- distinctness

export interface HostDistinctness {
  /** Share of the cast's whole vocabulary that belongs to exactly one host. */
  distinctness: number;
  exclusiveCounts: Record<string, number>;
  positionSwaps: number;
}

/**
 * How separable the two hosts are, measured the same way
 * productionInvariants.detectPositionSwaps decides who owns a position: by
 * EXCLUSIVE vocabulary. Shared topic words ("game", "pitching") say nothing
 * about who is speaking; the words only one host ever reaches for are the
 * character. When those sets collapse, two voices have become one.
 */
export function measureHostDistinctness(
  lines: Array<{ speakerName: string; text: string }>
): HostDistinctness {
  const speakers = Array.from(new Set(lines.map((l) => l.speakerName)));
  const bags = new Map<string, Set<string>>();
  for (const speaker of speakers) bags.set(speaker, new Set());
  for (const line of lines) {
    const bag = bags.get(line.speakerName);
    if (!bag) continue;
    for (const token of contentTokens(line.text)) bag.add(token);
  }
  const union = new Set<string>();
  for (const bag of bags.values()) for (const token of bag) union.add(token);

  const exclusiveCounts: Record<string, number> = {};
  let exclusiveTotal = 0;
  for (const speaker of speakers) {
    const mine = bags.get(speaker)!;
    let count = 0;
    for (const token of mine) {
      let othersHaveIt = false;
      for (const other of speakers) {
        if (other === speaker) continue;
        if (bags.get(other)!.has(token)) {
          othersHaveIt = true;
          break;
        }
      }
      if (!othersHaveIt) count += 1;
    }
    exclusiveCounts[speaker] = count;
    exclusiveTotal += count;
  }

  return {
    distinctness: union.size ? exclusiveTotal / union.size : 0,
    exclusiveCounts,
    positionSwaps: detectPositionSwaps(
      lines.map((l) => ({ speaker: l.speakerName, text: l.text }))
    ).length,
  };
}

/** Token-level overlap between an original line and its repair. */
export function lineSimilarity(before: string, after: string): number {
  const a = contentTokens(before);
  const b = contentTokens(after);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = new Set([...a, ...b]).size;
  return shared / union;
}

// ---------------------------------------------------------------- public API

export interface SevenRolePipelineArgs {
  systemPrompt: string;
  episodeTitle: string;
  topicsPrompts: string;
  targetDuration: number;
  temperature: number;
  maxTokens: number;
  /** Exactly two hosts. The pipeline declines anything else — see below. */
  speakerNames: string[];
  learningPolicy?: unknown;
  /** Established running bits / history for the continuity editor, if any. */
  continuityContext?: unknown;
  resolveProvider?: RoleProviderResolver;
  log: (message: string) => void;
  onRoleComplete?: (record: RoleStageRecord) => void;
}

export interface SevenRolePipelineResult {
  ok: boolean;
  trace: SevenRoleTrace;
  segments?: CreativeScriptSegment[];
  privateAgendas?: PrivateHostAgenda[];
  coldOpenTournament?: ColdOpenTournamentResult;
  spine?: EpisodeSpine;
  turnPlan?: TurnPlanEntry[];
  continuity?: ContinuityEditorReport | null;
  error?: string;
}

interface AssembledLine extends CreativeScriptLine {
  turnIndex: number;
  beatIndex: number;
}

/**
 * Run roles 1-6. Role 7 (the independent judge) runs later, on the FINAL
 * segments, after self-verify and the fact gates have had their say — judging
 * a draft that is still going to be rewritten measures the wrong artifact. Call
 * `runIndependentJudgeStage` with the same trace to complete the seven.
 */
export async function runSevenRolePipeline(
  args: SevenRolePipelineArgs
): Promise<SevenRolePipelineResult> {
  const trace = new SevenRoleTrace({ resolveProvider: args.resolveProvider, log: args.log });
  const done = (record: RoleStageRecord) => args.onRoleComplete?.(record);

  // The two host writers are two roles. Three hosts would need a third writer
  // role, a third brief and a three-way distinctness measure, none of which
  // exist — so the pipeline declines rather than quietly writing one host with
  // the wrong brief.
  if (args.speakerNames.length !== 2) {
    const reason =
      `The seven-role pipeline writes exactly two hosts (one writer role each); this episode casts ` +
      `${args.speakerNames.length} (${args.speakerNames.join(", ") || "none"}).`;
    for (const role of ["story_editor", "debate_architect", "host_a_writer", "host_b_writer", "dialogue_director", "continuity_editor", "independent_judge"] as SevenRole[]) {
      trace.skip(role, reason);
    }
    trace.finish();
    return { ok: false, trace, error: reason };
  }

  const [hostA, hostB] = args.speakerNames;
  const creativeSystemPrompt = compactCreativeSystemPrompt(args.systemPrompt);
  const evidenceArtifact = artifactRef("evidence_packet", args.topicsPrompts);
  const totalWordTarget = Math.max(550, Math.round(args.targetDuration * 145));
  const episodeMinimumWords = Math.max(500, Math.round(totalWordTarget * 0.82));

  // ------------------------------------------------ ROLE 1 — story editor
  const spineStage = await trace.run("story_editor", [evidenceArtifact], async (llm) => {
    const spine = await pickStorySpine({
      llm,
      episodeTitle: args.episodeTitle,
      speakerNames: args.speakerNames,
      topicsEvidence: args.topicsPrompts,
      targetDuration: args.targetDuration,
      systemPrompt: creativeSystemPrompt,
    });
    return { value: spine, outputs: [artifactRef("story_spine", spine, spine.unresolvedQuestion.slice(0, 90))] };
  });
  done(spineStage.record);
  if (!spineStage.ok) return abort(trace, "story_editor", spineStage.error);
  const spine = spineStage.value;
  args.log(`Story editor: "${spine.aboutInOneSentence}" — unresolved: "${spine.unresolvedQuestion}".`);

  // ------------------------------------------------ ROLE 2 — debate architect
  const spineArtifact = spineStage.record.outputArtifacts[0];
  const architectStage = await trace.run(
    "debate_architect",
    [spineArtifact, evidenceArtifact],
    async (llm) => {
      const outlineArgs: OutlineDrivenArgs = {
        systemPrompt: args.systemPrompt,
        episodeTitle: args.episodeTitle,
        topicsPrompts: args.topicsPrompts,
        targetDuration: args.targetDuration,
        version: 0,
        temperature: args.temperature,
        maxTokens: args.maxTokens,
        speakerNames: args.speakerNames,
        learningPolicy: args.learningPolicy,
        log: args.log,
      };
      const beats = await generateEpisodeOutline(llm, outlineArgs, creativeSystemPrompt, spine);

      const agendas = await generatePrivateHostAgendas({
        llm,
        episodeTitle: args.episodeTitle,
        speakerNames: args.speakerNames,
        outline: beats,
        topicsEvidence: args.topicsPrompts,
        systemPrompt: creativeSystemPrompt,
      });

      // The cold open is the architect's: it decides how the episode enters the
      // argument. The tournament is preserved exactly — three candidates, an
      // 80-120 word band, chosen by an INDEPENDENT judge.
      //
      // TWO THINGS ARE NEW, and neither changes a single-provider deployment.
      // The judge is now the dedicated `cold_open_judge` route, which resolves
      // to the same grouped configuration as the final judge until somebody
      // routes it elsewhere. And when two or more DISTINCT writer routes are
      // credentialed, the three candidates are written one per route instead of
      // three-in-one-call — because three openings from one model are three
      // moods, not three opinions, and the tournament was built to compare
      // opinions. With one route configured, `planColdOpenWriterRoutes` returns
      // nothing and the original single-call path runs untouched.
      const coldOpenWriterPlan = planColdOpenWriterRoutes();
      const coldOpen = await runColdOpenTextTournament({
        writer: llm,
        writerLabel: coldOpenRouteLabel("script_debate_architect"),
        writerPool: coldOpenWriterPlan.map((route) => ({
          variantId: route.variantId,
          provider: getRoleLLMProvider(route.llmRole),
          label: route.label,
        })),
        // The dedicated route is used ONLY when an operator has explicitly set
        // it. Unset, the judge stays the provider bound to role 7 through the
        // trace — which is both the old behaviour and the seam the tests inject
        // through. Reaching past the trace to the global router by default would
        // have made every injected-provider test call a real endpoint.
        judge: coldOpenJudgeIsRouted()
          ? getRoleLLMProvider("cold_open_judge")
          : trace.providerFor("independent_judge"),
        judgeLabel: coldOpenJudgeIsRouted()
          ? coldOpenRouteLabel("cold_open_judge")
          : coldOpenRouteLabel("quality_judge"),
        episodeTitle: args.episodeTitle,
        coldOpenBeat: beats[0],
        topicsEvidence: args.topicsPrompts,
        speakerNames: args.speakerNames,
        agendas,
        systemPrompt: creativeSystemPrompt,
        learningPolicy: args.learningPolicy,
      });

      const turns = await planDebateTurns({
        llm,
        episodeTitle: args.episodeTitle,
        speakerNames: args.speakerNames,
        spine,
        beats,
        topicsEvidence: args.topicsPrompts,
        systemPrompt: creativeSystemPrompt,
        totalWordTarget: Math.max(200, totalWordTarget - countWords(coldOpen.segment.lines)),
      });

      const violations: RoleViolation[] = [];
      if (turns.length === 0) throw new Error("Turn plan is empty — no host has anything to say.");
      for (const host of args.speakerNames) {
        if (!turns.some((t) => t.speakerName === host)) {
          throw new Error(`Turn plan allocates no turns to ${host}.`);
        }
      }

      return {
        value: { beats, agendas, coldOpen, turns },
        outputs: [
          artifactRef("beat_sheet", beats, `${beats.length} beats`),
          artifactRef("private_brief", agendas[0], `${hostA} (private)`),
          artifactRef("private_brief", agendas[1], `${hostB} (private)`),
          artifactRef("cold_open", coldOpen.segment, `tournament winner: ${coldOpen.tournament.selectedId}`),
          artifactRef("turn_plan", turns, `${turns.length} turns`),
        ],
        violations,
      };
    }
  );
  done(architectStage.record);
  if (!architectStage.ok) return abort(trace, "debate_architect", architectStage.error);
  const { beats, agendas, coldOpen, turns } = architectStage.value;
  const [briefA, briefB] = agendas;
  const beatArtifact = architectStage.record.outputArtifacts[0];
  const briefArtifactA = architectStage.record.outputArtifacts[1];
  const briefArtifactB = architectStage.record.outputArtifacts[2];
  const coldOpenArtifact = architectStage.record.outputArtifacts[3];
  const turnPlanArtifact = architectStage.record.outputArtifacts[4];
  args.log(
    `Debate architect: ${beats.length} beats, ${turns.length} turns ` +
      `(${turns.filter((t) => t.speakerName === hostA).length}/${turns.filter((t) => t.speakerName === hostB).length}), ` +
      `2 private briefs, cold open "${coldOpen.tournament.selectedId}".`
  );

  // Chunk the turns by movement so no single writer call has to hold the whole
  // episode. Movements come from the same grouping the legacy engine uses.
  const movements = groupIntoMovements(beats.slice(1));
  const movementOf = new Map<number, number>();
  movements.forEach((movementBeats, index) => {
    for (const beat of movementBeats) movementOf.set(beat.beatIndex, index);
  });
  const chunks: TurnPlanEntry[][] = movements.map(() => []);
  for (const turn of turns) {
    const index = movementOf.get(turn.beatIndex);
    chunks[index === undefined ? Math.max(0, chunks.length - 1) : index].push(turn);
  }

  const coldOpenLines: AssembledLine[] = (coldOpen.segment.lines || []).map((line, i) => ({
    ...line,
    turnIndex: -1000 + i,
    beatIndex: 0,
  }));
  const written = new Map<number, AssembledLine>();
  for (const line of coldOpenLines) written.set(line.turnIndex, line);

  // ------------------------------------------------ ROLES 3 & 4 — host writers
  for (const [role, host, other, brief, foreignBrief, briefArtifact] of [
    ["host_a_writer", hostA, hostB, briefA, briefB, briefArtifactA],
    ["host_b_writer", hostB, hostA, briefB, briefA, briefArtifactB],
  ] as Array<[SevenRole, string, string, PrivateHostAgenda, PrivateHostAgenda, ArtifactRef]>) {
    const foreignTerms = privateBriefTerms(foreignBrief);
    const stage = await trace.run(
      role,
      [turnPlanArtifact, briefArtifact, beatArtifact, coldOpenArtifact, evidenceArtifact],
      async (llm) => {
        const violations: RoleViolation[] = [];
        const accepted: AssembledLine[] = [];

        for (let m = 0; m < chunks.length; m++) {
          const chunkTurns = chunks[m];
          const ownTurns = chunkTurns.filter((t) => t.speakerName === host);
          if (ownTurns.length === 0) continue;

          // ONE RETRY for turns the writer skipped.
          //
          // A model that returns 7 of 13 allocated turns is not a model that
          // cannot write them; it is a model that stopped early. Asking again for
          // ONLY the missing turns is a small, cheap call. Failing the episode
          // instead throws away six roles that already ran and were already paid
          // for — which is what happened before this loop existed.
          const seen = new Set<number>();
          let pending = ownTurns;

          for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
          const soFar = [...written.values()]
            .sort((a, b) => a.turnIndex - b.turnIndex)
            .map((l) => ({ turnIndex: l.turnIndex, speakerName: l.speakerName, text: l.text }));

          const result = await writeHostLines({
            llm,
            hostName: host,
            otherHostName: other,
            privateBrief: brief,
            foreignBriefTerms: foreignTerms,
            spine,
            beats: movements[m],
            chunkTurns,
            ownTurnIndexes: pending.map((t) => t.turnIndex),
            writtenSoFar: soFar,
            topicsEvidence: args.topicsPrompts,
            systemPrompt: creativeSystemPrompt,
            movementNumber: m + 1,
            movementCount: chunks.length,
            temperature: args.temperature,
            maxTokens: args.maxTokens,
          });

          // ISOLATION — a redaction means the other host's brief reached the
          // composed prompt and was removed. The script is safe; the leak is not
          // swallowed.
          if (result.isolation.redactedTerms.length) {
            violations.push({
              role,
              kind: "isolation_breach",
              detail:
                `${result.isolation.redactedTerms.length} phrase(s) from ${other}'s private brief appeared in ` +
                `${host}'s composed prompt (almost certainly via an architect-written turn intent) and were ` +
                `redacted before the call.`,
              observed: { movement: m + 1, redactions: result.isolation.redactedTerms.length },
            });
          }

          // AUTHORSHIP — a host writer owns its own turns and nothing else.
          const ownIndexes = new Set(ownTurns.map((t) => t.turnIndex));
          for (const line of result.lines) {
            const wrongSpeaker = line.speakerName.toLowerCase() !== host.toLowerCase();
            const wrongTurn = !ownIndexes.has(line.turnIndex);
            if (wrongSpeaker || wrongTurn) {
              violations.push({
                role,
                kind: "foreign_authorship",
                detail:
                  `${host}'s writer returned a line it does not own ` +
                  `(turn ${line.turnIndex}, attributed to "${line.speakerName || "(unnamed)"}") — dropped. ` +
                  `${wrongSpeaker ? "Wrong speaker." : ""}${wrongTurn ? " Turn not allocated to this host." : ""}`.trim(),
                observed: { turnIndex: line.turnIndex, speakerName: line.speakerName || "(unnamed)" },
              });
              continue;
            }
            if (seen.has(line.turnIndex)) continue;

            // NOVELTY — a writer may not hand back a line that is already on the
            // page. It receives `writtenSoFar` so it can RESPOND to the
            // conversation; a model that treats that context as source material
            // to copy will reproduce its own earlier turns word for word.
            //
            // OBSERVED 2026-08-06: with Host A on grok-4.3, all three of the cold
            // open's lines came back verbatim inside the first movement, four
            // lines after they were first spoken. Host B on nemotron, given the
            // same prompt, did not. Nothing caught it: ISOLATION and AUTHORSHIP
            // were the only structural checks here and neither looks at text.
            //
            // Near-duplicates count too. A line reworded just enough to fall
            // short of an exact match still reads to a listener as the character
            // saying the same thing twice, which is the tell this exists to kill.
            const priorTexts = [...soFar.map((l) => l.text), ...accepted.map((l) => l.text)];
            const echoed = priorTexts.find((prior) => lineSimilarity(prior, line.text) >= 0.9);
            if (echoed) {
              violations.push({
                role,
                kind: "repeated_line",
                detail:
                  `${host}'s writer returned a line already on the page (turn ${line.turnIndex}) — dropped. ` +
                  `A character repeating himself verbatim is the loudest sign a script was assembled rather ` +
                  `than performed. Echoed: ${JSON.stringify(echoed.slice(0, 90))}`,
                observed: { turnIndex: line.turnIndex, echoedFrom: echoed.slice(0, 120) },
              });
              continue;
            }

            seen.add(line.turnIndex);
            const turn = ownTurns.find((t) => t.turnIndex === line.turnIndex)!;
            accepted.push({
              ...line,
              // Speaker attribution comes from the PLAN, never from the model's
              // own claim about itself.
              speakerName: host,
              lineIndex: 0,
              turnIndex: line.turnIndex,
              beatIndex: turn.beatIndex,
              evidenceRefs: Array.isArray(line.evidenceRefs) ? line.evidenceRefs : [],
              isFactualClaim: line.isFactualClaim === true,
            });
          }

            // Whatever is still unwritten goes round once more, and only that.
            pending = pending.filter((t) => !seen.has(t.turnIndex));
          }

          const missing = ownTurns.filter((t) => !seen.has(t.turnIndex));
          if (missing.length) {
            violations.push({
              role,
              kind: "missing_turn",
              detail:
                `${host}'s writer left ${missing.length} allocated turn(s) unwritten in movement ${m + 1}: ` +
                `${missing.map((t) => t.turnIndex).join(", ")}.`,
              observed: { movement: m + 1, missing: missing.length },
            });
          }
        }

        const ownedTurnCount = turns.filter((t) => t.speakerName === host).length;
        if (accepted.length === 0) {
          throw new Error(`${host}'s writer produced no usable lines out of ${ownedTurnCount} allocated turn(s).`);
        }
        // A writer that filled under two-thirds of its allocation did not do the
        // job, and letting it through produces an episode with holes the
        // director would have to invent its way out of.
        if (accepted.length < Math.ceil(ownedTurnCount * 0.67)) {
          throw new Error(
            `${host}'s writer filled only ${accepted.length} of ${ownedTurnCount} allocated turn(s); ` +
              `the movement structure cannot survive that many gaps.`
          );
        }

        for (const line of accepted) written.set(line.turnIndex, line);
        return {
          value: accepted,
          outputs: [artifactRef("host_lines", accepted, `${host}: ${accepted.length} line(s)`)],
          violations,
        };
      }
    );
    done(stage.record);
    if (!stage.ok) return abort(trace, role, stage.error);
  }

  const draftLines = [...written.values()].sort((a, b) => a.turnIndex - b.turnIndex);
  draftLines.forEach((line, i) => (line.lineIndex = i));
  args.log(
    `Host writers: ${draftLines.length} lines assembled ` +
      `(${draftLines.filter((l) => l.speakerName === hostA).length} ${hostA} / ` +
      `${draftLines.filter((l) => l.speakerName === hostB).length} ${hostB}).`
  );

  // ------------------------------------------------ ROLE 5 — dialogue director
  const draftArtifact = artifactRef("draft_transcript", draftLines, `${draftLines.length} lines`);
  const directorStage = await trace.run("dialogue_director", [draftArtifact], async (llm) => {
    const before = draftLines.map((l) => ({
      lineIndex: l.lineIndex,
      speakerName: l.speakerName,
      text: String(l.text),
    }));
    const { repairs, notes } = await directDialogueTransitions({
      llm,
      lines: before,
      hostNames: args.speakerNames,
      systemPrompt: creativeSystemPrompt,
      maxChangedFraction: DIRECTOR_MAX_CHANGED_FRACTION,
      temperature: Math.max(0.4, args.temperature - 0.3),
      maxTokens: args.maxTokens,
    });

    const guard = evaluateDirectorPass(before, repairs, args.speakerNames);
    if (guard.violations.length) {
      for (const violation of guard.violations) violation.role = "dialogue_director";
    }
    if (guard.rejected) {
      // The DRAFT is kept. Reverting is the safe outcome — the script that
      // reaches a human is the two-writer draft, not a homogenised one — and the
      // stage still fails so production is held and somebody looks at why the
      // director tried it.
      throw Object.assign(
        new Error(
          `Dialogue director pass REJECTED and reverted: ${guard.violations.map((v) => v.detail).join(" ")}`
        ),
        { violations: guard.violations }
      );
    }

    for (const repair of guard.applied) {
      const line = draftLines.find((l) => l.lineIndex === repair.lineIndex);
      if (line) line.text = repair.text;
    }
    if (notes.length) args.log(`Dialogue director notes: ${notes.join(" | ")}`);

    return {
      value: { applied: guard.applied.length, requested: repairs.length, distinctness: guard.after },
      outputs: [artifactRef("directed_transcript", draftLines, `${guard.applied.length} repair(s) applied`)],
      violations: guard.violations,
    };
  });
  done(directorStage.record);
  if (!directorStage.ok) {
    // Attach the guard's violations to the failed record so the reason survives
    // in the trace and not only in the error string.
    const carried = (directorStage.error as Error & { violations?: RoleViolation[] }).violations;
    if (carried?.length) directorStage.record.violations.push(...carried);
    return abort(trace, "dialogue_director", directorStage.error);
  }
  args.log(
    `Dialogue director: applied ${directorStage.value.applied}/${directorStage.value.requested} repair(s); ` +
      `host distinctness ${(directorStage.value.distinctness.distinctness * 100).toFixed(1)}%.`
  );

  // ------------------------------------------------ ROLE 6 — continuity editor
  const deInterrupted = resolvePhantomInterruptions(draftLines);
  if (deInterrupted.fixed) {
    args.log(
      `Phantom interruptions repaired: ${deInterrupted.fixed} line(s) ended mid-sentence with nobody cutting in.`
    );
  }
  const segments = assembleSegments(coldOpen.segment, deInterrupted.lines, beats);
  const transcriptArtifact = artifactRef("final_draft", segments, `${draftLines.length} lines`);
  let continuity: ContinuityEditorReport | null = null;
  const continuityStage = await trace.run("continuity_editor", [transcriptArtifact], async (llm) => {
    const report = await reviewContinuity({
      llm,
      transcript: draftLines.map((l) => `${l.lineIndex}\t${l.speakerName}: ${l.text}`).join("\n"),
      hostNames: args.speakerNames,
      priorContext: args.continuityContext,
      systemPrompt: creativeSystemPrompt,
    });
    return { value: report, outputs: [artifactRef("continuity_report", report)] };
  });
  done(continuityStage.record);
  if (continuityStage.ok) {
    continuity = continuityStage.value;
    args.log(
      `Continuity editor: ${continuity.callbacksLanded.length} callback(s) landed, ` +
        `${continuity.characterHistoryConflicts.length} history conflict(s), ` +
        `${continuity.issues.length} issue(s).`
    );
  } else {
    // OPTIONAL role. Recorded as failed in the trace, non-blocking in the gate
    // projection — see SevenRoleTrace.compatStages.
    args.log(`Continuity editor FAILED (optional, not blocking): ${continuityStage.error.message}`);
  }

  // ------------------------------------------------ episode-level floor
  const words = countWords(draftLines);
  if (words < episodeMinimumWords) {
    const reason =
      `The seven-role draft came to ${words} spoken words; a ${args.targetDuration}-minute episode ` +
      `requires at least ${episodeMinimumWords}.`;
    trace.failPipeline(reason);
    trace.skip("independent_judge", "the draft never reached the judge");
    trace.finish();
    return { ok: false, trace, error: reason, spine, turnPlan: turns, continuity };
  }

  trace.finish();
  return {
    ok: true,
    trace,
    segments,
    privateAgendas: agendas,
    coldOpenTournament: coldOpen.tournament,
    spine,
    turnPlan: turns,
    continuity,
  };
}

/**
 * ROLE 7 — the independent judge, wired into the same trace.
 *
 * Runs on the FINAL segments, so it scores what would actually be voiced. A
 * judge that returns no verdict is a FAILED required role: production without an
 * independent judgement is exactly what the editorial gate exists to stop.
 */
export async function runIndependentJudgeStage(
  trace: SevenRoleTrace,
  input: {
    segments: unknown[];
    episodeTitle: string;
    hostNames: string[];
    evidenceSummary?: string;
    /** Injectable for tests; defaults to the real cross-model judge. */
    assess?: (
      judge: LLMProvider | null,
      segments: unknown[]
    ) => Promise<CombinedQualityReport>;
  }
): Promise<CombinedQualityReport> {
  const assess =
    input.assess ??
    ((judge: LLMProvider | null, segments: unknown[]) =>
      assessScriptQuality(judge, segments as unknown[] as Parameters<typeof assessScriptQuality>[1], {
        episodeTitle: input.episodeTitle,
        hostNames: input.hostNames,
        evidenceSummary: input.evidenceSummary,
      }));

  let report: CombinedQualityReport | null = null;
  const stage = await trace.run(
    "independent_judge",
    [artifactRef("final_segments", input.segments)],
    async (llm) => {
      const result = await assess(llm, input.segments);
      report = result;
      if (!result.judge) {
        throw new Error(
          `Independent judge produced no verdict${result.judgeError ? `: ${result.judgeError}` : "."}`
        );
      }
      return {
        value: result,
        outputs: [artifactRef("judge_verdict", result.judge, `overall ${result.judge.overall}/100`)],
      };
    }
  );
  trace.finish();

  if (stage.ok) return stage.value;
  // The deterministic half of the report is still real and still useful; the
  // judge half is null with its reason attached, which is what the gate reads.
  return (
    report ?? {
      deterministic: { total: 0, axes: {}, conversation: {} as never, gate: { enforced: true, passed: false, failures: [stage.error.message], warnings: [] } } as never,
      judge: null,
      judgeError: stage.error.message,
      excerpts: [],
      lineCount: 0,
      wordCount: 0,
    }
  );
}

// ---------------------------------------------------------------- guards

export interface DirectorGuardResult {
  applied: Array<{ lineIndex: number; text: string; reason: string }>;
  rejected: boolean;
  violations: RoleViolation[];
  before: HostDistinctness;
  after: HostDistinctness;
}

/**
 * Measure the director's pass BEFORE deciding whether to apply it.
 *
 * The measurement is on what the director ASKED for, not on what would survive
 * line-level trimming. Judging the trimmed set would let a director that wanted
 * to rewrite the entire episode look restrained, because the trimming itself
 * removed the evidence.
 */
export function evaluateDirectorPass(
  before: Array<{ lineIndex: number; speakerName: string; text: string }>,
  repairs: Array<{ lineIndex: number; text: string; reason: string }>,
  hostNames: string[]
): DirectorGuardResult {
  const byIndex = new Map(before.map((l) => [l.lineIndex, l]));
  const violations: RoleViolation[] = [];
  const role: SevenRole = "dialogue_director";

  const known = repairs.filter((r) => byIndex.has(r.lineIndex));
  for (const repair of repairs) {
    if (!byIndex.has(repair.lineIndex)) {
      violations.push({
        role,
        kind: "director_overreach",
        detail: `Director returned a repair for line ${repair.lineIndex}, which is not in the transcript — ignored.`,
        observed: { lineIndex: repair.lineIndex },
      });
    }
  }

  // 1. PER-HOST BOUND, on the requested set.
  let rejected = false;
  for (const host of hostNames) {
    const total = before.filter((l) => l.speakerName === host).length;
    if (!total) continue;
    const touched = known.filter((r) => byIndex.get(r.lineIndex)!.speakerName === host).length;
    const fraction = touched / total;
    if (fraction > DIRECTOR_MAX_CHANGED_FRACTION) {
      rejected = true;
      violations.push({
        role,
        kind: "director_overreach",
        detail:
          `Director asked to rewrite ${touched} of ${host}'s ${total} lines (${(fraction * 100).toFixed(1)}%); ` +
          `the bound is ${(DIRECTOR_MAX_CHANGED_FRACTION * 100).toFixed(0)}%. Repairing joins does not require ` +
          `that much of one character. The whole pass is reverted.`,
        observed: { host, touched, total, fraction: Number(fraction.toFixed(4)) },
      });
    }
  }

  // 2. HOMOGENIZATION, measured on the fully-applied candidate.
  const candidate = before.map((line) => {
    const repair = known.find((r) => r.lineIndex === line.lineIndex);
    return repair ? { ...line, text: repair.text } : line;
  });
  const beforeMetrics = measureHostDistinctness(before);
  const afterMetrics = measureHostDistinctness(candidate);

  if (known.length > 0 && beforeMetrics.distinctness > 0) {
    const retained = afterMetrics.distinctness / beforeMetrics.distinctness;
    if (retained < MIN_RETAINED_DISTINCTNESS) {
      rejected = true;
      violations.push({
        role,
        kind: "voice_homogenization",
        detail:
          `The director's pass would cut host distinctness from ` +
          `${(beforeMetrics.distinctness * 100).toFixed(1)}% to ${(afterMetrics.distinctness * 100).toFixed(1)}% ` +
          `of the cast's vocabulary (${(retained * 100).toFixed(0)}% retained; the floor is ` +
          `${(MIN_RETAINED_DISTINCTNESS * 100).toFixed(0)}%). Two writers produced two voices and the director ` +
          `is merging them into one. Reverted.`,
        observed: {
          beforeDistinctness: Number(beforeMetrics.distinctness.toFixed(4)),
          afterDistinctness: Number(afterMetrics.distinctness.toFixed(4)),
          retained: Number(retained.toFixed(4)),
        },
      });
    }
    for (const host of hostNames) {
      const had = beforeMetrics.exclusiveCounts[host] ?? 0;
      if (had < 8) continue; // too small a vocabulary for the ratio to mean anything
      const kept = (afterMetrics.exclusiveCounts[host] ?? 0) / had;
      if (kept < MIN_RETAINED_HOST_EXCLUSIVITY) {
        rejected = true;
        violations.push({
          role,
          kind: "voice_homogenization",
          detail:
            `${host} would keep only ${(kept * 100).toFixed(0)}% of the vocabulary no other host uses ` +
            `(${afterMetrics.exclusiveCounts[host] ?? 0} of ${had} words); the floor is ` +
            `${(MIN_RETAINED_HOST_EXCLUSIVITY * 100).toFixed(0)}%. Reverted.`,
          observed: { host, before: had, after: afterMetrics.exclusiveCounts[host] ?? 0 },
        });
      }
    }
    // The exclusive-vocabulary position ledger, reused: a director that pushes
    // lines into the OPPONENT's stance is arguing for the wrong host.
    if (afterMetrics.positionSwaps > beforeMetrics.positionSwaps) {
      rejected = true;
      violations.push({
        role,
        kind: "voice_homogenization",
        detail:
          `The director's pass introduces ${afterMetrics.positionSwaps - beforeMetrics.positionSwaps} new line(s) ` +
          `that argue the opposing host's position without an authored change of mind ` +
          `(${beforeMetrics.positionSwaps} before, ${afterMetrics.positionSwaps} after). Reverted.`,
        observed: { before: beforeMetrics.positionSwaps, after: afterMetrics.positionSwaps },
      });
    }
  }

  // 3. PER-LINE BOUND. Individually dropped, not pass-fatal: one heavy-handed
  // repair is a bad repair, not evidence the director is rewriting the cast.
  const applied: Array<{ lineIndex: number; text: string; reason: string }> = [];
  if (!rejected) {
    for (const repair of known) {
      const original = byIndex.get(repair.lineIndex)!;
      const similarity = lineSimilarity(original.text, repair.text);
      if (similarity < DIRECTOR_MIN_LINE_SIMILARITY) {
        violations.push({
          role,
          kind: "director_overreach",
          detail:
            `Repair to line ${repair.lineIndex} (${original.speakerName}) keeps only ` +
            `${(similarity * 100).toFixed(0)}% of the original wording; the floor is ` +
            `${(DIRECTOR_MIN_LINE_SIMILARITY * 100).toFixed(0)}%. That is a rewrite, not a join repair — dropped.`,
          observed: { lineIndex: repair.lineIndex, similarity: Number(similarity.toFixed(4)) },
        });
        continue;
      }
      applied.push(repair);
    }
  }

  return { applied, rejected, violations, before: beforeMetrics, after: afterMetrics };
}

// ---------------------------------------------------------------- assembly

function countWords(lines: Array<{ text?: unknown }>): number {
  let total = 0;
  for (const line of lines) {
    if (typeof line?.text !== "string") continue;
    total += stripAudioTags(line.text).split(/\s+/).filter(Boolean).length;
  }
  return total;
}

/** Cold open first, then one segment per beat that actually received turns. */
/**
 * An interruption needs an interrupter.
 *
 * A line ending in a dash is a promise to the listener: someone is about to cut
 * in. When the very next line belongs to the SAME speaker, nobody did, and the
 * dash becomes a sentence that just stops.
 *
 * OBSERVED 2026-08-06: "Look, the July first deadline is going to kill three
 * clubs but—" followed by the same host continuing at length. In text it reads
 * as a typo; spoken by a TTS voice it is worse, because the performance commits
 * to being cut off and then isn't.
 *
 * The dash is what gets corrected, not the turn order. The writers are working
 * from a plan they cannot see the whole of, so the punctuation is the thing that
 * turned out to be wrong, and it is the cheapest honest thing to fix.
 */
function resolvePhantomInterruptions(lines: AssembledLine[]): { lines: AssembledLine[]; fixed: number } {
  const ordered = [...lines].sort((a, b) => a.turnIndex - b.turnIndex);
  // Em dash, en dash or a double hyphen. A single trailing hyphen is left alone:
  // it is far more likely to be a hyphenated word than a cut-off.
  const CUT_OFF = /(\s*(?:[—–]|--)\s*)$/;

  let fixed = 0;
  const out = ordered.map((line, i) => {
    const text = String((line as unknown as { text?: unknown }).text ?? "").trimEnd();
    if (!CUT_OFF.test(text)) return line;

    const next = ordered[i + 1];
    const someoneCutIn =
      !!next && String(next.speakerName || "").toLowerCase() !== String(line.speakerName || "").toLowerCase();
    if (someoneCutIn) return line;

    fixed++;
    return {
      ...line,
      text: text.replace(CUT_OFF, "."),
      isInterruption: false,
    } as AssembledLine;
  });

  return { lines: out, fixed };
}

function assembleSegments(
  coldOpenSegment: CreativeScriptSegment,
  lines: AssembledLine[],
  beats: OutlineBeat[]
): CreativeScriptSegment[] {
  const body = lines.filter((l) => l.beatIndex > 0);
  const segments: CreativeScriptSegment[] = [
    { ...coldOpenSegment, lines: lines.filter((l) => l.beatIndex === 0).map(toScriptLine) },
  ];
  const beatOrder = [...new Set(body.map((l) => l.beatIndex))].sort((a, b) => a - b);
  for (const beatIndex of beatOrder) {
    const beat = beats.find((b) => b.beatIndex === beatIndex);
    segments.push({
      type: beat?.segmentType === "cold_open" ? "topic" : beat?.segmentType || "topic",
      title: beat?.title || `Beat ${beatIndex + 1}`,
      topicId: beat?.topicId,
      lines: body.filter((l) => l.beatIndex === beatIndex).map(toScriptLine),
    });
  }
  return segments.filter((s) => s.lines.length > 0);
}

function toScriptLine(line: AssembledLine): CreativeScriptLine {
  const rest: Record<string, unknown> = { ...line };
  // turnIndex and beatIndex are planning coordinates, not script fields.
  delete rest.turnIndex;
  delete rest.beatIndex;
  return rest as unknown as CreativeScriptLine;
}

function abort(
  trace: SevenRoleTrace,
  failedRole: SevenRole,
  error: Error
): SevenRolePipelineResult {
  const order = ["story_editor", "debate_architect", "host_a_writer", "host_b_writer", "dialogue_director", "continuity_editor", "independent_judge"] as SevenRole[];
  const from = order.indexOf(failedRole) + 1;
  for (const role of order.slice(from)) {
    trace.skip(role, `not reached — ${failedRole} failed`);
  }
  trace.finish();
  return { ok: false, trace, error: error.message };
}

/** Convenience for callers that want the segments in the invariant checker's
 *  shape without importing both modules' types. */
export function segmentsForInvariants(segments: CreativeScriptSegment[]): ScriptSegmentLike[] {
  return segments as unknown as ScriptSegmentLike[];
}
