// EXECUTED tests for the seven-role writing pipeline.
//
// Everything here runs against stub providers constructed in this file: no
// network, no API keys, no database. The stubs are not mocks of the pipeline —
// they are LLM providers. Every guard, filter, measurement and provenance record
// under test is the real production code path.
//
//   1 CONTRACT            all seven roles run in order; provenance records seven
//   2 ISOLATION           each host writer's ACTUAL prompt strings are inspected
//   3 AUTHORSHIP          host A cannot author host B
//   4 PROVENANCE          requested != actual is recorded as an attributed fallback
//   5 FALLBACK VISIBILITY provenance never claims the primary model ran
//   6 HOLD                every REQUIRED role, failed in turn, holds the gate
//   7 NON-HOMOGENIZATION  a director that merges the cast is detected and reverted
//   8 CONTROL             a clean run produces no violations and no failed stages

import assert from "node:assert/strict";
import type {
  GenerateStructuredOutputOptions,
  LLMProvider,
} from "../lib/providers/llm/interface";
import {
  REQUIRED_SEVEN_ROLES,
  OPTIONAL_SEVEN_ROLES,
  SEVEN_ROLE_ORDER,
  type ResolvedCallReport,
  type RoleProviderResolver,
  type SevenRole,
} from "../lib/services/scriptRoles";
import {
  DIRECTOR_MAX_CHANGED_FRACTION,
  runIndependentJudgeStage,
  runSevenRolePipeline,
  measureHostDistinctness,
  type SevenRolePipelineResult,
} from "../lib/services/scriptSevenRolePipeline";
import {
  evaluateScriptEditorialGate,
  type ScriptPipelineProvenance,
} from "../lib/services/scriptEditorialGate";
import type { CombinedQualityReport, JudgeVerdict } from "../lib/services/scriptQualityJudge";
import { JUDGE_AXES } from "../lib/services/scriptQualityJudge";
import type { InvariantReport } from "../lib/services/productionInvariants";

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    const message = (error as Error).message;
    failures.push(`${name}: ${message}`);
    console.error(`  FAIL ${name}\n       ${message.split("\n").join("\n       ")}`);
  }
}

// ===================================================================== fixture

const HOST_A = "Zabala";
const HOST_B = "Mercer";

// Two deliberately disjoint vocabularies. Host distinctness in this codebase is
// measured by EXCLUSIVE content words (productionInvariants.detectPositionSwaps
// uses the same idea), so a fixture whose hosts share every noun could not tell
// a homogenizing director from a careful one.
const A_VOCAB = [
  "ledger", "payroll", "arbitration", "luxury", "threshold", "actuarial", "amortized", "escrow",
  "clawback", "deferral", "indemnity", "rebate", "valuation", "liability", "surplus", "prorated",
  "buyout", "guarantee", "incentive", "revenue", "penalty", "spreadsheet", "projection", "forecast",
  "discount", "premium", "extension", "waiver", "allocation", "budget", "margin", "leverage",
  "exposure", "hedge", "ownership", "franchise", "asset", "capital", "invoice", "audit",
  "quarterly", "fiscal", "portfolio", "dividend", "escalator", "rollover", "annuity", "tranche",
];
const B_VOCAB = [
  "dugout", "bullpen", "clubhouse", "rotation", "velocity", "framing", "baserunning", "platoon",
  "matchup", "fatigue", "mechanics", "sequence", "slider", "changeup", "fastball", "command",
  "contact", "launch", "infield", "outfield", "tagging", "stealing", "lineup", "reliever",
  "closer", "starter", "innings", "catcher", "shortstop", "batting", "fielding", "sprint",
  "hamstring", "stride", "tempo", "release", "tunnel", "deception", "sinker", "cutter",
  "pickoff", "rundown", "warmup", "windup", "footwork", "shoulder", "elbow", "forearm",
];
// Shared filler: 17 words, none exclusive to either host.
const FILLER = "and the number does not answer the point about money or risk for the team this season".split(" ");

function synthLine(exclusive: string[], totalWords: number): string {
  const parts = [...exclusive];
  let i = 0;
  while (parts.length < totalWords) parts.push(FILLER[i++ % FILLER.length]);
  return `${parts.slice(0, totalWords).join(" ")}.`;
}

const BEATS = [
  { beatIndex: 0, segmentType: "cold_open", title: "The empty seats", goal: "open mid-argument", angle: "who signed off", factRefs: [] },
  { beatIndex: 1, segmentType: "topic", title: "The number nobody defends", goal: "expose the gap", angle: "the payroll line", factRefs: [{ type: "NewsItem", id: "n1" }] },
  { beatIndex: 2, segmentType: "topic", title: "What the room was told", goal: "shift leverage", angle: "the briefing", factRefs: [{ type: "NewsItem", id: "n2" }] },
  { beatIndex: 3, segmentType: "topic", title: "The player's version", goal: "complicate it", angle: "the other side", factRefs: [{ type: "Injury", id: "i1" }] },
  { beatIndex: 4, segmentType: "topic", title: "Who eats the loss", goal: "raise stakes", angle: "consequence", factRefs: [] },
  { beatIndex: 5, segmentType: "topic", title: "The part nobody planned", goal: "surprise", angle: "the reversal", factRefs: [] },
  { beatIndex: 6, segmentType: "closing", title: "What is still open", goal: "payoff", angle: "unresolved", factRefs: [] },
];

// 24 body turns, deliberately unbalanced (13 / 11) and not strictly alternating.
const TURN_SPEC: Array<{ speakerName: string; beatIndex: number }> = [
  { speakerName: HOST_A, beatIndex: 1 }, { speakerName: HOST_B, beatIndex: 1 },
  { speakerName: HOST_A, beatIndex: 1 }, { speakerName: HOST_A, beatIndex: 2 },
  { speakerName: HOST_B, beatIndex: 2 }, { speakerName: HOST_A, beatIndex: 2 },
  { speakerName: HOST_B, beatIndex: 2 }, { speakerName: HOST_A, beatIndex: 3 },
  { speakerName: HOST_B, beatIndex: 3 }, { speakerName: HOST_A, beatIndex: 3 },
  { speakerName: HOST_B, beatIndex: 3 }, { speakerName: HOST_A, beatIndex: 4 },
  { speakerName: HOST_A, beatIndex: 4 }, { speakerName: HOST_B, beatIndex: 4 },
  { speakerName: HOST_A, beatIndex: 4 }, { speakerName: HOST_B, beatIndex: 5 },
  { speakerName: HOST_A, beatIndex: 5 }, { speakerName: HOST_B, beatIndex: 5 },
  { speakerName: HOST_A, beatIndex: 5 }, { speakerName: HOST_B, beatIndex: 6 },
  { speakerName: HOST_A, beatIndex: 6 }, { speakerName: HOST_B, beatIndex: 6 },
  { speakerName: HOST_A, beatIndex: 6 }, { speakerName: HOST_B, beatIndex: 6 },
];

/** Deterministic per-turn text drawn from that host's exclusive vocabulary. */
function bodyText(host: string, turnIndex: number): string {
  const pool = host === HOST_A ? A_VOCAB : B_VOCAB;
  const nth = TURN_SPEC.slice(0, turnIndex + 1).filter((t) => t.speakerName === host).length - 1;
  const words = [pool[nth * 3], pool[nth * 3 + 1], pool[nth * 3 + 2]];
  return synthLine(words, 20);
}

const COLD_OPEN_A = ["opening", "signature", "memorandum"];
const COLD_OPEN_B = ["footage", "replay", "warmups"];

function coldOpenLines(variant: string): Array<Record<string, unknown>> {
  return [
    { lineIndex: 0, speakerName: HOST_A, text: synthLine([...COLD_OPEN_A, variant], 25), tone: "incredulous", energy: "high", pauseBefore: "none", isInterruption: false, evidenceRefs: [], isFactualClaim: false, needsHumanReview: false },
    { lineIndex: 1, speakerName: HOST_B, text: synthLine(COLD_OPEN_B, 25), tone: "dismissive", energy: "medium", pauseBefore: "beat", isInterruption: false, evidenceRefs: [], isFactualClaim: false, needsHumanReview: false },
    { lineIndex: 2, speakerName: HOST_A, text: synthLine([A_VOCAB[44], A_VOCAB[45]], 25), tone: "heated", energy: "high", pauseBefore: "none", isInterruption: false, evidenceRefs: [], isFactualClaim: false, needsHumanReview: false },
    { lineIndex: 3, speakerName: HOST_B, text: synthLine([B_VOCAB[44], B_VOCAB[45]], 25), tone: "analytical", energy: "medium", pauseBefore: "breath", isInterruption: false, evidenceRefs: [], isFactualClaim: false, needsHumanReview: false },
  ];
}

const SENTINEL_A = "SENTINEL_ZABALA_ONLY_the front office already admitted the shortfall internally";
const SENTINEL_B = "SENTINEL_MERCER_ONLY_the player was cleared to play and chose not to";

function agendaFor(host: string, sentinel: string) {
  return {
    speakerName: host,
    exclusiveFactResponsibility: `${sentinel} exclusive fact responsibility`,
    protectedBelief: `${sentinel} protected belief`,
    avoidedConcession: `${sentinel} avoided concession`,
    behavioralTrigger: `${sentinel} behavioral trigger`,
    misconceptionAboutOtherHost: `${sentinel} misconception about the other host`,
    genuineQuestion: `${sentinel} genuine question`,
    privateObjective: `${sentinel} private objective`,
  };
}

// ================================================================ stub provider

interface StubCall {
  systemPrompt: string;
  prompt: string;
}

interface StubOptions {
  label: string;
  requested: { provider: string; model?: string };
  /** What actually served the call. Defaults to `requested` (no fallback). */
  actual?: { provider: string; model: string };
  fallbackReason?: string;
  fallbackCount?: number;
  /** Set to true to model a provider that reports nothing about itself. */
  silent?: boolean;
  /** Per-call-kind response overrides. Return a value, or throw. */
  respond: (kind: CallKind, options: GenerateStructuredOutputOptions) => unknown;
}

type CallKind =
  | "spine"
  | "outline"
  | "agendas"
  | "cold_open_variants"
  | "cold_open_judge"
  | "turn_plan"
  | "host_lines"
  | "director"
  | "continuity"
  | "unknown";

/** Classify a call by what the real prompt actually asks the model to return. */
function classify(options: GenerateStructuredOutputOptions): CallKind {
  const p = options.prompt || "";
  if (p.includes('"spine"')) return "spine";
  if (p.includes('"variants"')) return "cold_open_variants";
  if (p.includes('"judgments"')) return "cold_open_judge";
  if (p.includes('"agendas"')) return "agendas";
  if (p.includes('"turns"')) return "turn_plan";
  if (p.includes('"repairs"')) return "director";
  if (p.includes('"callbacksLanded"')) return "continuity";
  if (p.includes('"lines"')) return "host_lines";
  if (p.includes('"beats"')) return "outline";
  return "unknown";
}

class StubProvider implements LLMProvider {
  readonly name: string;
  readonly calls: StubCall[] = [];
  readonly kinds: CallKind[] = [];
  private readonly options: StubOptions;

  constructor(options: StubOptions) {
    this.options = options;
    this.name = `stub:${options.label}`;
  }

  async generateText(): Promise<string> {
    throw new Error("The seven-role pipeline only uses structured output.");
  }

  async generateStructuredOutput<T = unknown>(options: GenerateStructuredOutputOptions): Promise<T> {
    this.calls.push({ systemPrompt: options.systemPrompt || "", prompt: options.prompt || "" });
    const kind = classify(options);
    this.kinds.push(kind);
    const value = this.options.respond(kind, options);
    // Run the caller's own validator, exactly as a real provider does — so a
    // fixture that violates the cold-open word band fails here, not silently.
    const problem = options.validate?.(value);
    if (problem) throw new Error(`[${this.name}] validation rejected the ${kind} response: ${problem}`);
    return value as T;
  }

  lastResolvedCall(): ResolvedCallReport | null {
    if (this.options.silent) return null;
    const actual = this.options.actual ?? {
      provider: this.options.requested.provider,
      model: this.options.requested.model ?? "(provider-default)",
    };
    return {
      provider: actual.provider,
      model: actual.model,
      fallbackReason: this.options.fallbackReason ?? null,
      fallbackCount: this.options.fallbackCount ?? 0,
    };
  }
}

// ------------------------------------------------------------ default responses

type Responder = (kind: CallKind, options: GenerateStructuredOutputOptions) => unknown;

const spineValue = {
  spine: {
    aboutInOneSentence: "A front office spent money it cannot account for and nobody wants to sign the memo.",
    unresolvedQuestion: "Did anyone actually authorize the number, or did it just accumulate?",
    whyItMattersToAListener: "Every future signing runs through this line.",
    whatWouldSettleIt: "The internal briefing document nobody will release.",
    hostStakes: [
      { speakerName: HOST_A, stake: "He vouched for the process in public." },
      { speakerName: HOST_B, stake: "He believes the player is being used as cover." },
    ],
    rejectedFrames: ["a simple bad-contract story"],
  },
};

const defaultResponder: Responder = (kind, options) => {
  switch (kind) {
    case "spine":
      return spineValue;
    case "outline":
      return { beats: BEATS };
    case "agendas":
      return { agendas: [agendaFor(HOST_A, SENTINEL_A), agendaFor(HOST_B, SENTINEL_B)] };
    case "cold_open_variants":
      return {
        variants: [
          { id: "accusation", lines: coldOpenLines("accusation") },
          { id: "consequence", lines: coldOpenLines("consequence") },
          { id: "contradiction", lines: coldOpenLines("contradiction") },
        ],
      };
    case "cold_open_judge":
      return {
        judgments: [
          { id: "accusation", score: 88, reasons: ["opens mid-argument"] },
          { id: "consequence", score: 71, reasons: ["slower entry"] },
          { id: "contradiction", score: 64, reasons: ["states the answer too early"] },
        ],
      };
    case "turn_plan":
      return {
        turns: TURN_SPEC.map((turn, index) => ({
          turnIndex: index,
          beatIndex: turn.beatIndex,
          speakerName: turn.speakerName,
          intent: `Turn ${index}: press the point the previous turn left open.`,
          factRefs: [],
          targetWords: 20,
        })),
      };
    case "host_lines": {
      const { host, ownIndexes } = parseHostAssignment(options.prompt || "");
      return { lines: ownIndexes.map((turnIndex) => writtenLine(host, turnIndex)) };
    }
    case "director":
      return { repairs: [], notes: [] };
    case "continuity":
      return {
        callbacksLanded: [],
        callbacksAttemptedButFlat: [],
        characterHistoryConflicts: [],
        runningBitsUsed: [],
        issues: [],
      };
    default:
      throw new Error(`Stub received an unclassified call:\n${(options.prompt || "").slice(0, 400)}`);
  }
};

/** Read the architect's allocation straight out of the composed writer prompt. */
function parseHostAssignment(prompt: string): { host: string; ownIndexes: number[] } {
  const ownIndexes: number[] = [];
  let host = "";
  const re = />>> TURN (\d+) — YOURS \(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(prompt))) {
    ownIndexes.push(Number(match[1]));
    host = match[2];
  }
  if (!host) throw new Error("Writer prompt carried no turn allocation for this host.");
  return { host, ownIndexes };
}

function writtenLine(host: string, turnIndex: number): Record<string, unknown> {
  return {
    turnIndex,
    speakerName: host,
    text: bodyText(host, turnIndex),
    tone: host === HOST_A ? "analytical" : "dismissive",
    energy: "medium",
    pauseBefore: "none",
    isInterruption: false,
    evidenceRefs: [],
    isFactualClaim: false,
  };
}

// ------------------------------------------------------------------- harness

interface StubSetOverrides {
  requested?: Partial<Record<SevenRole, { provider: string; model?: string }>>;
  actual?: Partial<Record<SevenRole, { provider: string; model: string }>>;
  fallbackReason?: Partial<Record<SevenRole, string>>;
  silent?: SevenRole[];
  respond?: Partial<Record<SevenRole, Responder>>;
}

function makeStubs(overrides: StubSetOverrides = {}): {
  stubs: Record<SevenRole, StubProvider>;
  resolver: RoleProviderResolver;
} {
  const stubs = {} as Record<SevenRole, StubProvider>;
  for (const role of SEVEN_ROLE_ORDER) {
    stubs[role] = new StubProvider({
      label: role,
      requested: overrides.requested?.[role] ?? { provider: "zai", model: "glm-4.7-flash" },
      actual: overrides.actual?.[role],
      fallbackReason: overrides.fallbackReason?.[role],
      fallbackCount: overrides.fallbackReason?.[role] ? 1 : 0,
      silent: (overrides.silent ?? []).includes(role),
      respond: overrides.respond?.[role] ?? defaultResponder,
    });
  }
  // The resolver reports what the ROUTER asked for, exactly as the real one does
  // from resolveRolePlan(). Keeping it separate from what the stub ANSWERS with
  // is the whole point: that gap is what a fallback is.
  const resolver: RoleProviderResolver = (role) => ({
    provider: stubs[role],
    requested: overrides.requested?.[role] ?? { provider: "zai", model: "glm-4.7-flash" },
  });
  return { stubs, resolver };
}

async function runPipeline(
  overrides: StubSetOverrides = {}
): Promise<{ result: SevenRolePipelineResult; stubs: Record<SevenRole, StubProvider>; log: string[] }> {
  const { stubs, resolver } = makeStubs(overrides);
  const log: string[] = [];
  const result = await runSevenRolePipeline({
    systemPrompt: "You are two sports hosts. HOW REAL PODCAST SPEECH WORKS: speak like people.",
    episodeTitle: "The number nobody signed",
    topicsPrompts: "EVIDENCE:\n- NewsItem n1: payroll line rose 14 percent.\n- NewsItem n2: the briefing was verbal.\n- Injury i1: the player was listed day-to-day.",
    targetDuration: 4,
    temperature: 0.85,
    maxTokens: 16000,
    speakerNames: [HOST_A, HOST_B],
    resolveProvider: resolver,
    log: (message) => log.push(message),
  });
  return { result, stubs, log };
}

// ------------------------------------------------------- gate fixtures (real)

function cleanJudge(): JudgeVerdict {
  return {
    axes: Object.fromEntries(JUDGE_AXES.map((a) => [a, 8.6])) as JudgeVerdict["axes"],
    overall: 86,
    bothHostsSoundLikeOneModel: false,
    strengths: [],
    weaknesses: [],
    evidenceQuotes: [],
  };
}

function cleanReport(): CombinedQualityReport {
  return {
    deterministic: {
      total: 84,
      axes: {
        repetition: { score: 23, max: 25, detail: "" },
        specificity: { score: 13, max: 15, detail: "" },
        personality: { score: 13, max: 15, detail: "" },
        flow: { score: 17, max: 20, detail: "" },
        arc: { score: 11, max: 15, detail: "" },
        delivery: { score: 7, max: 10, detail: "" },
      },
      conversation: {} as never,
      gate: { enforced: true, passed: true, failures: [], warnings: [] },
    } as never,
    judge: cleanJudge(),
    excerpts: [],
    lineCount: 28,
    wordCount: 580,
  };
}

function cleanInvariants(): InvariantReport {
  return {
    findings: [],
    failedCriticalAxes: [],
    worstSeverity: "pass",
    measurements: {
      lineCount: 28,
      coldOpenWords: 100,
      coldOpenLines: 4,
      strictAlternationRatio: 0.5,
      perSpeakerLines: { [HOST_A]: 16, [HOST_B]: 12 },
      positionSwapCount: 0,
    },
  } as unknown as InvariantReport;
}

const HOLD_ENV = { NODE_ENV: "production", SCRIPT_EDITORIAL_GATE_MODE: "hold" } as unknown as NodeJS.ProcessEnv;

/** The provenance a real generation would carry before the trace is merged in. */
function baseProvenance(): ScriptPipelineProvenance {
  return { path: "outline_driven", fallbackReason: null, stages: [] };
}

function gateFor(provenance: ScriptPipelineProvenance) {
  return evaluateScriptEditorialGate(cleanReport(), HOLD_ENV, {
    invariants: cleanInvariants(),
    provenance,
  });
}

// ======================================================================= tests

async function main(): Promise<void> {
  console.log("\nSeven-role writing pipeline\n");

  // ------------------------------------------------------------ 1. CONTRACT
  await check("CONTRACT: all seven roles run, in order, and provenance records all seven", async () => {
    const { result } = await runPipeline();
    assert.equal(result.ok, true, `pipeline did not complete: ${result.error}`);

    await runIndependentJudgeStage(result.trace, {
      segments: result.segments!,
      episodeTitle: "The number nobody signed",
      hostNames: [HOST_A, HOST_B],
      assess: async () => cleanReport(),
    });

    const records = result.trace.stageRecords;
    assert.equal(records.length, 7, `expected 7 role records, got ${records.length}`);
    assert.deepEqual(
      records.map((r) => r.role),
      SEVEN_ROLE_ORDER,
      "roles are not recorded in execution order"
    );
    assert.deepEqual(
      records.map((r) => r.order),
      [1, 2, 3, 4, 5, 6, 7],
      "role order numbers are wrong"
    );
    for (const record of records) {
      assert.equal(record.status, "ok", `${record.role} did not complete: ${record.error}`);
      assert.ok(record.inputArtifacts.length > 0, `${record.role} recorded no input artifact`);
      assert.ok(record.outputArtifacts.length > 0, `${record.role} recorded no output artifact`);
      assert.ok(record.durationMs >= 0, `${record.role} recorded no timing`);
      assert.ok(record.requestedProvider, `${record.role} recorded no requested provider`);
    }

    // The stages actually ran on their OWN providers — role separation is not a
    // relabelling of one model's calls.
    const trace = result.trace.toTraceRecord();
    assert.equal(trace.allRequiredRolesOk, true);
    assert.deepEqual(trace.requiredRoles, REQUIRED_SEVEN_ROLES);
    assert.deepEqual(trace.holdingRoles, []);

    // And the finished script is real: a cold open plus body segments.
    const segments = result.segments!;
    assert.equal(segments[0].type, "cold_open", "first segment is not the cold open");
    assert.ok(segments.length > 1, "no body segments were assembled");
    const lines = segments.flatMap((s) => s.lines);
    assert.equal(lines.length, 28, `expected 4 cold-open + 24 body lines, got ${lines.length}`);
    assert.ok(
      result.coldOpenTournament && result.coldOpenTournament.variants.length === 3,
      "the cold-open tournament did not survive the restructuring"
    );
    assert.equal(result.coldOpenTournament!.wordBand?.min, 80);
    assert.equal(result.coldOpenTournament!.wordBand?.max, 120);
    assert.equal(result.privateAgendas?.length, 2, "private agendas did not survive the restructuring");
  });

  // ----------------------------------------------------------- 2. ISOLATION
  await check("ISOLATION: neither host writer's prompt contains the other host's private brief", async () => {
    const { result, stubs } = await runPipeline();
    assert.equal(result.ok, true, `pipeline did not complete: ${result.error}`);

    const aCalls = stubs.host_a_writer.calls;
    const bCalls = stubs.host_b_writer.calls;
    assert.ok(aCalls.length > 0, "host A's writer was never called");
    assert.ok(bCalls.length > 0, "host B's writer was never called");

    const aText = aCalls.map((c) => `${c.systemPrompt}\n${c.prompt}`).join("\n");
    const bText = bCalls.map((c) => `${c.systemPrompt}\n${c.prompt}`).join("\n");

    // Each writer got its OWN brief...
    assert.ok(aText.includes(SENTINEL_A), "host A's writer never received host A's private brief");
    assert.ok(bText.includes(SENTINEL_B), "host B's writer never received host B's private brief");
    // ...and not the other's. Asserted on the exact strings that were sent.
    assert.ok(
      !aText.includes(SENTINEL_B),
      "host A's writer prompt CONTAINS host B's private agenda text"
    );
    assert.ok(
      !bText.includes(SENTINEL_A),
      "host B's writer prompt CONTAINS host A's private agenda text"
    );
    // Nothing had to be redacted on the clean path, so the isolation is by
    // construction and not by a last-second scrub.
    assert.equal(
      result.trace.violations.filter((v) => v.kind === "isolation_breach").length,
      0,
      "a brief leaked into the composed prompt and had to be redacted"
    );
  });

  await check("ISOLATION: a leak planted in a turn intent is redacted and recorded", async () => {
    // The architect writes the turn intents, so a leaky architect is the real
    // back door into a host writer's prompt. It must be closed by the pipeline,
    // not by trusting the architect.
    const leakyTurnPlan: Responder = (kind, options) => {
      if (kind !== "turn_plan") return defaultResponder(kind, options);
      return {
        turns: TURN_SPEC.map((turn, index) => ({
          turnIndex: index,
          beatIndex: turn.beatIndex,
          speakerName: turn.speakerName,
          intent:
            index === 0
              ? `Press the point. Remember: ${SENTINEL_B} protected belief`
              : `Turn ${index}: press the point the previous turn left open.`,
          factRefs: [],
          targetWords: 20,
        })),
      };
    };
    const { result, stubs } = await runPipeline({ respond: { debate_architect: leakyTurnPlan } });
    assert.equal(result.ok, true, `pipeline did not complete: ${result.error}`);

    const aText = stubs.host_a_writer.calls.map((c) => `${c.systemPrompt}\n${c.prompt}`).join("\n");
    assert.ok(!aText.includes(SENTINEL_B), "the planted leak reached host A's writer verbatim");
    assert.ok(aText.includes("[REDACTED: the other host's private brief]"), "nothing was redacted");
    const breaches = result.trace.violations.filter((v) => v.kind === "isolation_breach");
    assert.ok(breaches.length > 0, "the leak was scrubbed but never recorded as a violation");
    assert.equal(breaches[0].role, "host_a_writer");
  });

  // ---------------------------------------------------------- 3. AUTHORSHIP
  await check("AUTHORSHIP: host A's writer cannot author host B's lines", async () => {
    const forger: Responder = (kind, options) => {
      if (kind !== "host_lines") return defaultResponder(kind, options);
      const { host, ownIndexes } = parseHostAssignment(options.prompt || "");
      const mine = ownIndexes.map((turnIndex) => writtenLine(host, turnIndex));
      // Host A's writer also returns a line for host B, on a turn allocated to B.
      const stolenTurn = TURN_SPEC.findIndex((t) => t.speakerName === HOST_B);
      return {
        lines: [
          ...mine,
          {
            turnIndex: stolenTurn,
            speakerName: HOST_B,
            text: synthLine([A_VOCAB[0], A_VOCAB[1], A_VOCAB[2]], 20),
            tone: "conceding",
            energy: "low",
          },
        ],
      };
    };
    const { result } = await runPipeline({ respond: { host_a_writer: forger } });
    assert.equal(result.ok, true, `pipeline did not complete: ${result.error}`);

    const violations = result.trace.violations.filter((v) => v.kind === "foreign_authorship");
    assert.ok(violations.length > 0, "host A authored host B and nothing was recorded");
    assert.equal(violations[0].role, "host_a_writer");
    assert.ok(
      String(violations[0].observed?.speakerName) === HOST_B,
      `violation did not name the forged speaker: ${JSON.stringify(violations[0].observed)}`
    );

    // The forged line must not be in the script, and host B's line for that turn
    // must be the one host B's own writer produced.
    const stolenTurn = TURN_SPEC.findIndex((t) => t.speakerName === HOST_B);
    const lines = result.segments!.flatMap((s) => s.lines);
    const forgedText = synthLine([A_VOCAB[0], A_VOCAB[1], A_VOCAB[2]], 20);
    assert.ok(
      !lines.some((l) => String(l.text) === forgedText && l.speakerName === HOST_B),
      "the forged line reached the finished script"
    );
    assert.ok(
      lines.some((l) => l.speakerName === HOST_B && String(l.text) === bodyText(HOST_B, stolenTurn)),
      "host B's own line for the contested turn is missing"
    );
  });

  // ---------------------------------------------------------- 4. PROVENANCE
  await check("PROVENANCE: requested != actual is recorded as an attributed fallback", async () => {
    const { result } = await runPipeline({
      requested: { story_editor: { provider: "nvidia", model: "nemotron-3-ultra" } },
      actual: { story_editor: { provider: "zai", model: "glm-4.7-flash" } },
      fallbackReason: {
        story_editor: "nvidia/nemotron-3-ultra returned 503 ResourceExhausted; the chain advanced.",
      },
    });
    assert.equal(result.ok, true, `pipeline did not complete: ${result.error}`);

    const record = result.trace.stageRecords.find((r) => r.role === "story_editor")!;
    assert.equal(record.requestedProvider, "nvidia");
    assert.equal(record.requestedModel, "nemotron-3-ultra");
    assert.equal(record.actualProvider, "zai");
    assert.equal(record.actualModel, "glm-4.7-flash");
    assert.equal(record.fallbackFired, true, "a served-by-another-model call was not marked as a fallback");
    assert.ok(record.fallbackReason, "a fallback fired with no reason recorded");
    assert.ok(
      record.fallbackReason!.includes("503"),
      `the fallback reason lost its cause: ${record.fallbackReason}`
    );
    assert.equal(record.modelObservation, "provider_report");

    // It is visible in the PERSISTED record, not only in the live object.
    const persisted = JSON.parse(
      JSON.stringify(result.trace.attachTo(baseProvenance()))
    ) as ScriptPipelineProvenance & { roleTrace: { roles: Array<Record<string, unknown>> } };
    const persistedRecord = persisted.roleTrace.roles.find((r) => r.role === "story_editor")!;
    assert.equal(persistedRecord.fallbackFired, true);
    assert.equal(persistedRecord.actualModel, "glm-4.7-flash");
    const stage = (persisted.stages || []).find((s) => s.name === "seven_role:story_editor")!;
    assert.ok(stage.detail?.includes("fallback:"), `the compat stage hid the fallback: ${stage.detail}`);
  });

  // -------------------------------------------------- 5. FALLBACK VISIBILITY
  await check("FALLBACK VISIBILITY: provenance never claims the primary model ran", async () => {
    const { result } = await runPipeline({
      requested: { host_b_writer: { provider: "nvidia", model: "mistral-medium-3.5" } },
      actual: { host_b_writer: { provider: "zai", model: "glm-4.7-flash" } },
      fallbackReason: { host_b_writer: "nvidia/mistral-medium-3.5 timed out after 120s." },
    });
    assert.equal(result.ok, true, `pipeline did not complete: ${result.error}`);
    const record = result.trace.stageRecords.find((r) => r.role === "host_b_writer")!;
    assert.notEqual(
      `${record.actualProvider}/${record.actualModel}`,
      `${record.requestedProvider}/${record.requestedModel}`,
      "the record claims the requested model served the call"
    );
    assert.equal(record.fallbackFired, true);

    // The two host writers converged onto ONE model. That is the exact condition
    // that produces a single-model script, and it must be legible.
    const aRecord = result.trace.stageRecords.find((r) => r.role === "host_a_writer")!;
    assert.equal(
      aRecord.actualModel,
      record.actualModel,
      "fixture error: the writers were meant to converge here"
    );
    assert.equal(aRecord.fallbackFired, false, "host A did not fall back");
    assert.equal(record.fallbackFired, true, "host B's convergence is not attributed to a fallback");

    // A provider that reports NOTHING must produce a null actual model, never a
    // back-filled copy of the requested one.
    const silent = await runPipeline({
      requested: { dialogue_director: { provider: "nvidia", model: "mistral-medium-3.5" } },
      silent: ["dialogue_director"],
    });
    assert.equal(silent.result.ok, true, `pipeline did not complete: ${silent.result.error}`);
    const silentRecord = silent.result.trace.stageRecords.find((r) => r.role === "dialogue_director")!;
    assert.equal(silentRecord.actualModel, null, "an unobserved call reported a model anyway");
    assert.equal(silentRecord.actualProvider, null);
    assert.equal(silentRecord.modelObservation, "unobserved");
    assert.notEqual(silentRecord.actualModel, silentRecord.requestedModel);
    assert.equal(silentRecord.status, "ok", "an unobserved model must not fail the stage");
  });

  // --------------------------------------------------------------- 6. HOLD
  for (const role of REQUIRED_SEVEN_ROLES) {
    await check(`HOLD: required role '${role}' failing produces a failed stage and a gate hold`, async () => {
      const boom = new Error(`${role} exploded on purpose`);
      let provenance: ScriptPipelineProvenance;

      if (role === "independent_judge") {
        // The judge fails by returning no verdict, which is how it fails for real.
        const { result } = await runPipeline();
        assert.equal(result.ok, true, `pipeline did not complete: ${result.error}`);
        await runIndependentJudgeStage(result.trace, {
          segments: result.segments!,
          episodeTitle: "The number nobody signed",
          hostNames: [HOST_A, HOST_B],
          assess: async () => ({ ...cleanReport(), judge: null, judgeError: "judge endpoint 503" }),
        });
        provenance = result.trace.attachTo(baseProvenance());
      } else {
        const exploder: Responder = () => {
          throw boom;
        };
        const { result } = await runPipeline({ respond: { [role]: exploder } as StubSetOverrides["respond"] });
        assert.equal(result.ok, false, `${role} threw but the pipeline reported success`);
        provenance = result.trace.attachTo(baseProvenance());
      }

      const stages = provenance.stages || [];
      const failedStages = stages.filter((s) => s.status === "failed");
      assert.ok(
        failedStages.some((s) => s.name === `seven_role:${role}`),
        `no failed stage for '${role}'; got ${JSON.stringify(stages)}`
      );

      // And the existing editorial gate turns that into a hold, untouched.
      const gate = gateFor(provenance);
      assert.equal(gate.decision, "hold", `gate did not hold on a failed '${role}': ${gate.reasons.join(" | ")}`);
      assert.ok(
        gate.failedCriticalAxes.includes("creativeStageFailure"),
        `gate did not attribute the hold to a creative stage failure: ${gate.failedCriticalAxes.join(", ")}`
      );
    });
  }

  await check("HOLD: an OPTIONAL role failing does NOT hold production", async () => {
    assert.deepEqual(OPTIONAL_SEVEN_ROLES, ["continuity_editor"], "the optional-role list changed");
    const exploder: Responder = () => {
      throw new Error("continuity endpoint unavailable");
    };
    const { result } = await runPipeline({ respond: { continuity_editor: exploder } });
    assert.equal(result.ok, true, "an optional role failure stopped the pipeline");
    await runIndependentJudgeStage(result.trace, {
      segments: result.segments!,
      episodeTitle: "The number nobody signed",
      hostNames: [HOST_A, HOST_B],
      assess: async () => cleanReport(),
    });
    const provenance = result.trace.attachTo(baseProvenance());

    // The TRACE is honest: the role failed.
    const record = result.trace.stageRecords.find((r) => r.role === "continuity_editor")!;
    assert.equal(record.status, "failed");
    assert.ok(record.error?.includes("continuity endpoint unavailable"));
    // The gate projection is non-blocking, and says so in words.
    const stage = (provenance.stages || []).find((s) => s.name === "seven_role:continuity_editor")!;
    assert.equal(stage.status, "skipped");
    assert.ok(stage.detail?.includes("OPTIONAL role FAILED"), `projection hid the failure: ${stage.detail}`);
    assert.equal(gateFor(provenance).decision, "pass", "an optional role failure held production");
  });

  // --------------------------------------------------- 7. NON-HOMOGENIZATION
  await check("NON-HOMOGENIZATION: a director that rewrites every line into one voice is rejected", async () => {
    const oneVoice = synthLine(A_VOCAB.slice(0, 6), 20);
    const homogenizer: Responder = (kind, options) => {
      if (kind !== "director") return defaultResponder(kind, options);
      const indexes = [...(options.prompt || "").matchAll(/^(\d+)\t/gm)].map((m) => Number(m[1]));
      assert.ok(indexes.length > 20, "the director prompt did not carry the transcript");
      return {
        repairs: indexes.map((lineIndex) => ({
          lineIndex,
          text: oneVoice,
          reason: "smoothing the voice",
        })),
        notes: [],
      };
    };
    const { result } = await runPipeline({ respond: { dialogue_director: homogenizer } });

    assert.equal(result.ok, false, "a cast-collapsing director pass was accepted");
    const record = result.trace.stageRecords.find((r) => r.role === "dialogue_director")!;
    assert.equal(record.status, "failed", "the director stage did not fail");
    const kinds = result.trace.violations.map((v) => v.kind);
    assert.ok(kinds.includes("voice_homogenization"), `homogenization not detected; got ${kinds.join(", ")}`);
    assert.ok(kinds.includes("director_overreach"), `the per-host bound did not fire; got ${kinds.join(", ")}`);

    // And it HOLDS, because the director is a required role.
    const gate = gateFor(result.trace.attachTo(baseProvenance()));
    assert.equal(gate.decision, "hold");
  });

  await check("NON-HOMOGENIZATION: detected independently of the per-host change bound", async () => {
    // A director that stays UNDER the change bound but rewrites host B's late
    // lines in host A's exclusive vocabulary. The change-fraction guard cannot
    // see this; the exclusive-vocabulary ledger can.
    const stolenVoice = synthLine(A_VOCAB.slice(0, 6), 18);
    let touched = 0;
    let bTotal = 0;
    const sneaky: Responder = (kind, options) => {
      if (kind !== "director") return defaultResponder(kind, options);
      const rows = [...(options.prompt || "").matchAll(/^(\d+)\t([^:]+): /gm)].map((m) => ({
        lineIndex: Number(m[1]),
        speaker: m[2],
      }));
      bTotal = rows.filter((r) => r.speaker === HOST_B).length;
      const lateB = rows.filter((r) => r.speaker === HOST_B && r.lineIndex >= rows.length / 2);
      const chosen = lateB.slice(0, Math.floor(bTotal * (DIRECTOR_MAX_CHANGED_FRACTION - 0.05)));
      touched = chosen.length;
      return {
        repairs: chosen.map((r) => ({ lineIndex: r.lineIndex, text: stolenVoice, reason: "tightening" })),
        notes: [],
      };
    };
    const { result } = await runPipeline({ respond: { dialogue_director: sneaky } });

    assert.ok(touched > 0, "fixture error: no lines were selected for the sneaky pass");
    assert.ok(
      touched / bTotal <= DIRECTOR_MAX_CHANGED_FRACTION,
      `fixture error: ${touched}/${bTotal} exceeds the change bound, so this is not an independent test`
    );
    assert.equal(result.ok, false, "a voice-stealing director pass was accepted");
    const kinds = result.trace.violations.map((v) => v.kind);
    assert.ok(
      kinds.includes("voice_homogenization"),
      `voice theft under the change bound was not detected; got ${kinds.join(", ") || "no violations"}`
    );
    assert.ok(
      !kinds.includes("director_overreach"),
      "the change bound fired, so this did not test homogenization independently"
    );
  });

  await check("NON-HOMOGENIZATION: the distinctness measure is not vacuous", async () => {
    // Prove the metric moves: two distinct hosts score high, one voice scores 0.
    const distinct = measureHostDistinctness([
      { speakerName: HOST_A, text: synthLine(A_VOCAB.slice(0, 4), 14) },
      { speakerName: HOST_B, text: synthLine(B_VOCAB.slice(0, 4), 14) },
      { speakerName: HOST_A, text: synthLine(A_VOCAB.slice(4, 8), 14) },
      { speakerName: HOST_B, text: synthLine(B_VOCAB.slice(4, 8), 14) },
    ]);
    const merged = measureHostDistinctness([
      { speakerName: HOST_A, text: synthLine(A_VOCAB.slice(0, 4), 14) },
      { speakerName: HOST_B, text: synthLine(A_VOCAB.slice(0, 4), 14) },
      { speakerName: HOST_A, text: synthLine(A_VOCAB.slice(4, 8), 14) },
      { speakerName: HOST_B, text: synthLine(A_VOCAB.slice(4, 8), 14) },
    ]);
    assert.ok(distinct.distinctness > 0.7, `distinct hosts scored ${distinct.distinctness}`);
    assert.equal(merged.distinctness, 0, `one voice scored ${merged.distinctness}`);
  });

  // ------------------------------------------------------------- 8. CONTROL
  await check("CONTROL: a clean run produces no violations and no failed stages", async () => {
    // A director that does real, minimal work — two join repairs inside every
    // bound. If the guards were always-fail, this would fail.
    const tidy: Responder = (kind, options) => {
      if (kind !== "director") return defaultResponder(kind, options);
      const rows = [...(options.prompt || "").matchAll(/^(\d+)\t([^:]+): (.*)$/gm)].map((m) => ({
        lineIndex: Number(m[1]),
        speaker: m[2],
        text: m[3],
      }));
      const targets = rows.filter((r) => r.speaker === HOST_A).slice(1, 3);
      return {
        repairs: targets.map((r) => ({
          lineIndex: r.lineIndex,
          text: `${r.text} ${A_VOCAB[0]} ${A_VOCAB[1]}.`,
          reason: "the reply did not answer the question in the previous turn",
        })),
        notes: ["two joins tightened"],
      };
    };

    const { result } = await runPipeline({ respond: { dialogue_director: tidy } });
    assert.equal(result.ok, true, `clean run did not complete: ${result.error}`);
    await runIndependentJudgeStage(result.trace, {
      segments: result.segments!,
      episodeTitle: "The number nobody signed",
      hostNames: [HOST_A, HOST_B],
      assess: async () => cleanReport(),
    });

    assert.deepEqual(
      result.trace.violations,
      [],
      `clean run recorded violations: ${JSON.stringify(result.trace.violations, null, 2)}`
    );
    const provenance = result.trace.attachTo(baseProvenance());
    const failedStages = (provenance.stages || []).filter((s) => s.status === "failed");
    assert.deepEqual(failedStages, [], `clean run recorded failed stages: ${JSON.stringify(failedStages)}`);
    assert.equal(result.trace.holdingRoles.length, 0);
    assert.equal(gateFor(provenance).decision, "pass", "a clean run was held");

    // The director's repairs were actually applied — the control run proves the
    // guards permit work, not merely that they permit doing nothing.
    const directorRecord = result.trace.stageRecords.find((r) => r.role === "dialogue_director")!;
    assert.equal(directorRecord.status, "ok");
    const applied = result
      .segments!.flatMap((s) => s.lines)
      .filter((l) => String(l.text).includes(`${A_VOCAB[0]} ${A_VOCAB[1]}.`));
    assert.equal(applied.length, 2, `expected 2 applied repairs, found ${applied.length}`);
  });

  await check("CONTROL: the pipeline declines a cast it cannot write", async () => {
    const result = await runSevenRolePipeline({
      systemPrompt: "system",
      episodeTitle: "Three hosts",
      topicsPrompts: "evidence",
      targetDuration: 4,
      temperature: 0.85,
      maxTokens: 16000,
      speakerNames: [HOST_A, HOST_B, "Third"],
      resolveProvider: makeStubs().resolver,
      log: () => {},
    });
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("exactly two hosts"), result.error);
    assert.equal(result.trace.stageRecords.length, 7, "declining still records all seven roles");
    assert.ok(result.trace.stageRecords.every((r) => r.status === "skipped"));
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
