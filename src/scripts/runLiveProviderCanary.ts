// Private scheduled live-provider canary. It publishes nothing.
//
// WHAT BROKE BEFORE, AND WHY THIS FILE IS SHAPED LIKE THIS
// --------------------------------------------------------
// The first scheduled run died in 28 seconds because the repository has no
// Actions secrets: every variable arrived empty, the script walked straight
// into a live LLM call, and the failure surfaced as an opaque provider error.
// Worse, the report was written on the LAST line, so an early throw left the
// artifact directory empty and `actions/upload-artifact` failed with
// "No files were found" — the diagnosis (a missing key) never reached anyone.
//
// Four rules now hold:
//   1. PREFLIGHT FIRST. Every required variable is checked by NAME before any
//      provider is touched. Missing configuration is reported as a list of
//      names — never a value, never a prefix, never a length.
//   2. A REPORT IS ALWAYS WRITTEN. try/finally, so preflight failure, provider
//      failure, regression and success all leave artifacts/…/report.json on
//      disk. That is what makes `if-no-files-found: error` a real signal.
//   3. THE ALERT CLASS IS EXPLICIT. A missing key is `configuration_failure`,
//      not a generic crash, so the alert says what to go fix.
//   4. NOTHING SILENT. A role served by a model other than the one requested is
//      `model_drift` with the role named, never a run that quietly passed on a
//      cheaper model. A provider that cannot be observed at all is also
//      `model_drift`: the canary will not record an unverified model as the
//      requested one.
//
// WHAT ONE RUN NOW EXERCISES, END TO END
// --------------------------------------
//   1  a CURRENT story, taken from live news feeds and selected by the real
//      event-clustering + diversity code (storyClustering)
//   2  a NEW research brief on the real `research_brief` route, validated by the
//      real validator (researchBriefService.validateBriefResult)
//   3  ALL SEVEN writing roles through the real orchestrator
//      (scriptSevenRolePipeline), each with its own route and provenance
//   4  the independent judge, on a route proven distinct from every authoring
//      role BEFORE a token is spent
//   5  real Fish AND real ElevenLabs renders of the freshly written cold open
//   6  transcript- and speaker-aware semantic QA on those bytes (Deepgram)
//   7  a PRIVATE ffmpeg mix, written to the artifact directory and nowhere else
//   8  comparison against a durable last-known-good baseline
//   9  latency, provider/model drift, voice drift, semantic QA and COST
//  10  no publication of any kind: private:true, published:false, and no upload
//      path is ever constructed
//
// ONE TRADE-OFF, STATED RATHER THAN HIDDEN: the earlier canary rendered a FIXED
// four-line fixture, which made acoustic comparison against a baseline
// meaningful. Rendering the freshly written script instead buys genuine
// end-to-end coverage and costs that: pitch and pace now legitimately differ run
// to run, so voice drift is detected by IDENTITY (rendered model, endpoint, and
// a digest of the voice configuration) rather than by acoustics. The acoustic
// numbers are still reported — they are just not a gate, because a gate that
// fires on ordinary variation is a gate everyone learns to ignore.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { getRoleLLMProvider, resolveRolePlan, candidateKey, endpointIdentity } from "../lib/providers/llm/routing";
import { ROUTING_PROFILES } from "../lib/providers/llm/profiles";
import { ROLE_DEFINITIONS, type LLMRole } from "../lib/providers/llm/roles";
import { llmCostMark, llmCostSince, withLlmStage } from "../lib/providers/llm/costLedger";
import { LlmProviderError } from "../lib/providers/llm/errors";

import { ElevenLabsTTSProvider } from "../lib/providers/tts/elevenlabs";
import { FishTTSProvider } from "../lib/providers/tts/fish";
import { resolveFishSceneModel } from "../lib/providers/tts/fishDialogue";
import { SceneGenerationError, type DialogueSceneInput, type SceneUtterance } from "../lib/providers/tts/sceneTypes";
import { FISH_REFERENCE_ID_RE } from "../lib/providers/tts/providerIds";

import { analyzeSpokenPerformanceBuffer } from "../lib/audio/spokenPerformanceQa";
import { getFileDurationMs, runFfmpeg } from "../lib/audio/assembly";
import {
  runAudioSemanticQa,
  resolveSemanticQaRequirement,
  SemanticQaUnavailableError,
  SEMANTIC_QA_PROVIDERS,
  type AudioSemanticQaReport,
  type ExpectedSpokenLine,
} from "../lib/audio/audioSemanticQa";

import { RssNewsProvider } from "../lib/providers/sports/rss";
import {
  clusterTopicsByEvent,
  enforceEventDiversity,
  scoreRundownDiversity,
  type ClusterableTopic,
} from "../lib/services/storyClustering";
import {
  buildAllowedKeys,
  selectUsableSources,
  serializeSourceForPacket,
  sourceRulesBlock,
  validateBriefResult,
  type PacketTopicSource,
} from "../lib/services/researchBriefService";
import { runSevenRolePipeline, runIndependentJudgeStage } from "../lib/services/scriptSevenRolePipeline";
import { SEVEN_ROLE_ORDER, type RoleStageRecord, type SevenRole } from "../lib/services/scriptRoles";
import { SEED_HOSTS } from "../lib/hosts/roster";
import {
  compareToBaseline,
  emptyComparison,
  loadCanaryBaseline,
  voiceFingerprint,
  type BaselineComparison,
  type CanaryBaselineRecord,
} from "../lib/services/canaryBaseline";

// ---------------------------------------------------------------- alert classes

/**
 * Every terminal state this canary can reach. Alert routing keys on these
 * strings, so "the model got worse" never pages the same person as "nobody set
 * FISH_API_KEY".
 */
export type CanaryAlertClass =
  | "ok"
  | "configuration_failure"
  | "provider_failure"
  | "quality_regression"
  | "latency_regression"
  | "voice_drift"
  /** A role was served by something other than the model it asked for, or by
   *  something the run could not observe at all. */
  | "model_drift";

export type CanaryEnv = Record<string, string | undefined>;

export type CanaryProviderId = "fish" | "elevenlabs";

/** Fish model policy. The free S2.1 tier is the canary's contract, not a default
 *  that may drift upward silently: a promotion to `s2.1-pro` changes both the
 *  voice and the bill, so it must be an explicit, reviewed decision. */
export const CANARY_EXPECTED_FISH_SCENE_MODEL = "s2.1-pro-free";

class CanaryFailure extends Error {
  readonly alertClass: CanaryAlertClass;
  constructor(alertClass: CanaryAlertClass, message: string) {
    super(message);
    this.name = "CanaryFailure";
    this.alertClass = alertClass;
  }
}

// ---------------------------------------------------------------- the routes

/**
 * Every LLM role this canary actually calls, in call order.
 *
 * Derived requirements, not a hand-kept list: the preflight asks
 * ROLE_DEFINITIONS for each role's env prefix, so adding a role to this array is
 * the only edit needed to make its route mandatory.
 */
export const CANARY_LLM_ROLES: LLMRole[] = [
  "topic_generation",
  "research_brief",
  "script_story_editor",
  "script_debate_architect",
  "script_host_a_writer",
  "script_host_b_writer",
  "script_dialogue_director",
  "script_continuity_editor",
  "quality_judge",
];

/**
 * The roles that WRITE text the judge later scores.
 *
 * story_editor and continuity_editor are excluded on purpose: the spine is not
 * dialogue and the continuity editor only reports. The other four put words in
 * the finished script, so a judge sharing any of their endpoints is grading its
 * own homework.
 */
export const CANARY_AUTHORING_ROLES: LLMRole[] = [
  "script_debate_architect",
  "script_host_a_writer",
  "script_host_b_writer",
  "script_dialogue_director",
];

export const CANARY_JUDGE_ROLE: LLMRole = "quality_judge";

/** Env variable pair an operator must set to pin a role's route. */
export function roleEnvVars(role: LLMRole): [string, string] {
  const prefix = ROLE_DEFINITIONS[role].envPrefix;
  return [`${prefix}_LLM_PROVIDER`, `${prefix}_LLM_MODEL`];
}

// ---------------------------------------------------------------- preflight

/** Variables required no matter which TTS providers are exercised. */
export const CANARY_REQUIRED_LLM_VARS = [
  "LLM_ROUTING_PROFILE",
  "ANTHROPIC_API_KEY",
  ...CANARY_LLM_ROLES.flatMap(roleEnvVars),
] as const;

/** Variables required per TTS provider under test. */
export const CANARY_REQUIRED_PROVIDER_VARS: Record<CanaryProviderId, string[]> = {
  fish: ["FISH_API_KEY", "CANARY_FISH_VOICE_A", "CANARY_FISH_VOICE_B"],
  elevenlabs: ["ELEVENLABS_API_KEY", "CANARY_ELEVENLABS_VOICE_A", "CANARY_ELEVENLABS_VOICE_B"],
};

/**
 * Semantic QA is not optional here.
 *
 * Production episode e7867729 published with `TTS_TRANSCRIPT_QA_ENABLED=false`
 * and nothing noticed, because `not_run` was an accepted outcome. A canary whose
 * meaning-aware QA is allowed to not run is a canary that cannot tell you the
 * audio said the wrong number in the wrong voice — so these are required
 * variables with required VALUES, checked by name.
 */
export const CANARY_REQUIRED_SEMANTIC_QA_VARS = [
  "TTS_TRANSCRIPT_QA_ENABLED",
  "TRANSCRIPT_QA_PROVIDER",
] as const;

/** Credential each semantic-QA backend needs, by provider name. */
const SEMANTIC_QA_CREDENTIAL: Record<string, string> = {
  deepgram: "DEEPGRAM_API_KEY",
  openai: "TRANSCRIPT_QA_OPENAI_API_KEY",
};

/** The backend the canary contracts to use when TRANSCRIPT_QA_PROVIDER has not
 *  been set yet — named so the preflight can still tell an operator WHICH key to
 *  go configure instead of only saying "pick a provider first". */
const CANARY_DEFAULT_SEMANTIC_QA_PROVIDER = "deepgram";

/** Credential each LLM provider name needs. Used to add a provider-specific key
 *  to the required list when a role is pointed somewhere other than Anthropic. */
const LLM_PROVIDER_CREDENTIAL: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  zai: "ZAI_API_KEY",
};

/** Names whose VALUES must never appear in the report, a log line, or an error. */
export const CANARY_SECRET_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "NVIDIA_API_KEY",
  "ZAI_API_KEY",
  "FISH_API_KEY",
  "ELEVENLABS_API_KEY",
  "DEEPGRAM_API_KEY",
  "TRANSCRIPT_QA_DEEPGRAM_API_KEY",
  "TRANSCRIPT_QA_OPENAI_API_KEY",
  "CANARY_FISH_VOICE_A",
  "CANARY_FISH_VOICE_B",
  "CANARY_ELEVENLABS_VOICE_A",
  "CANARY_ELEVENLABS_VOICE_B",
];

export interface PreflightCheck {
  name: string;
  /** Present and non-empty. NEVER the value. */
  present: boolean;
  /** Shape accepted. Only meaningful when `present`. */
  valid: boolean;
  /** Why the shape was rejected. Describes the RULE, never the value. */
  note?: string;
  /** Optional variables are reported but do not fail the preflight. */
  optional?: boolean;
}

export interface PreflightResult {
  ok: boolean;
  /** Required variable NAMES with no value set. */
  missing: string[];
  /** Required variable NAMES set to something structurally unusable. */
  invalid: { name: string; reason: string }[];
  checks: PreflightCheck[];
  /** TTS providers this run intends to exercise. */
  requiredProviders: CanaryProviderId[];
  /** LLM roles whose routes this run pins. */
  requiredRoles: LLMRole[];
  /** Human summary, safe to print in a public CI log. */
  summary: string;
}

function value(env: CanaryEnv, name: string): string {
  const raw = env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

/** ElevenLabs voice ids are opaque; only reject values that could not possibly
 *  be one (empty, whitespace-bearing, absurdly short or long). */
const ELEVENLABS_VOICE_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * THE FIRST THING THAT RUNS. Pure over an env record so it is directly testable
 * and so it cannot accidentally read the ambient process.
 *
 * Contract: reports NAMES and booleans. It never returns, logs or embeds a
 * value from any variable — a canary that leaks a key into a downloadable CI
 * artifact is a worse outage than the one it was watching for.
 */
export function preflightCanaryEnv(env: CanaryEnv): PreflightResult {
  const checks: PreflightCheck[] = [];
  const missing: string[] = [];
  const invalid: { name: string; reason: string }[] = [];

  const requireVar = (name: string, validate?: (v: string) => string | null) => {
    const v = value(env, name);
    if (!v) {
      checks.push({ name, present: false, valid: false });
      if (!missing.includes(name)) missing.push(name);
      return;
    }
    const reason = validate ? validate(v) : null;
    checks.push({ name, present: true, valid: !reason, note: reason ?? undefined });
    if (reason) invalid.push({ name, reason });
  };

  const optionalVar = (name: string, validate?: (v: string) => string | null, note?: string) => {
    const v = value(env, name);
    if (!v) {
      checks.push({ name, present: false, valid: true, optional: true, note });
      return;
    }
    const reason = validate ? validate(v) : null;
    checks.push({ name, present: true, valid: !reason, note: reason ?? note, optional: true });
    if (reason) invalid.push({ name, reason });
  };

  // Which TTS providers this run covers. An unknown name is a configuration
  // error, not a silently skipped provider.
  const rawProviders = value(env, "CANARY_REQUIRED_PROVIDERS") || "fish,elevenlabs";
  const requiredProviders: CanaryProviderId[] = [];
  const unknownProviders: string[] = [];
  for (const p of rawProviders.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    if (p === "fish" || p === "elevenlabs") requiredProviders.push(p);
    else unknownProviders.push(p);
  }
  if (unknownProviders.length) {
    invalid.push({
      name: "CANARY_REQUIRED_PROVIDERS",
      reason: `names ${unknownProviders.length} provider(s) the canary cannot build; supported: fish, elevenlabs`,
    });
    checks.push({ name: "CANARY_REQUIRED_PROVIDERS", present: true, valid: false, optional: true });
  } else {
    checks.push({
      name: "CANARY_REQUIRED_PROVIDERS",
      present: Boolean(value(env, "CANARY_REQUIRED_PROVIDERS")),
      valid: true,
      optional: true,
      note: "defaults to fish,elevenlabs",
    });
  }

  // ---- LLM routing: EVERY role this canary calls must be pinned ----
  //
  // A role left unpinned resolves down the profile chain to whatever happens to
  // be reachable, which is exactly the silent substitution this canary exists to
  // catch. Requiring the pair by name turns "the judge quietly ran on the
  // writer's model" into a preflight failure that names the variable.
  const knownLlmProvider = (v: string) =>
    LLM_PROVIDER_CREDENTIAL[v.toLowerCase()] || v.toLowerCase() === "stub"
      ? null
      : `unknown LLM provider; supported: ${Object.keys(LLM_PROVIDER_CREDENTIAL).join(", ")}, stub`;

  requireVar("LLM_ROUTING_PROFILE", (v) =>
    (ROUTING_PROFILES as string[]).includes(v.toLowerCase())
      ? null
      : `must be one of ${ROUTING_PROFILES.join(", ")}`
  );
  for (const role of CANARY_LLM_ROLES) {
    const [providerVar, modelVar] = roleEnvVars(role);
    requireVar(providerVar, knownLlmProvider);
    requireVar(modelVar);
  }

  // Anthropic is this project's production writer route, so its key is required
  // unconditionally; a canary pointed at another provider additionally needs
  // that provider's credential.
  requireVar("ANTHROPIC_API_KEY");
  const extraCredentials = new Set<string>();
  for (const role of CANARY_LLM_ROLES) {
    const credential = LLM_PROVIDER_CREDENTIAL[value(env, roleEnvVars(role)[0]).toLowerCase()];
    if (credential && credential !== "ANTHROPIC_API_KEY") extraCredentials.add(credential);
  }
  for (const credential of [...extraCredentials].sort()) requireVar(credential);

  // ---- TTS providers ----
  if (requiredProviders.includes("fish")) {
    requireVar("FISH_API_KEY");
    for (const name of ["CANARY_FISH_VOICE_A", "CANARY_FISH_VOICE_B"]) {
      requireVar(name, (v) => (FISH_REFERENCE_ID_RE.test(v) ? null : "must be a 32-character hex Fish reference id"));
    }
  }
  if (requiredProviders.includes("elevenlabs")) {
    requireVar("ELEVENLABS_API_KEY");
    for (const name of ["CANARY_ELEVENLABS_VOICE_A", "CANARY_ELEVENLABS_VOICE_B"]) {
      requireVar(name, (v) =>
        ELEVENLABS_VOICE_RE.test(v) ? null : "must be an opaque ElevenLabs voice id (8-64 url-safe characters)"
      );
    }
  }

  // ---- meaning-aware audio QA: required, with required VALUES ----
  requireVar("TTS_TRANSCRIPT_QA_ENABLED", (v) =>
    v.toLowerCase() === "true"
      ? null
      : "must be exactly 'true' — the canary has to actually run transcript- and speaker-aware QA, not report not_run"
  );
  requireVar("TRANSCRIPT_QA_PROVIDER", (v) =>
    (SEMANTIC_QA_PROVIDERS as readonly string[]).includes(v.toLowerCase())
      ? null
      : `must be one of ${SEMANTIC_QA_PROVIDERS.join(", ")}`
  );
  const semanticProvider = (value(env, "TRANSCRIPT_QA_PROVIDER") || CANARY_DEFAULT_SEMANTIC_QA_PROVIDER).toLowerCase();
  if (semanticProvider === "deepgram") {
    // Accept either spelling, but NAME the canonical one when neither is set —
    // "configure something" is not an actionable alert.
    if (!value(env, "DEEPGRAM_API_KEY") && !value(env, "TRANSCRIPT_QA_DEEPGRAM_API_KEY")) {
      checks.push({ name: "DEEPGRAM_API_KEY", present: false, valid: false });
      if (!missing.includes("DEEPGRAM_API_KEY")) missing.push("DEEPGRAM_API_KEY");
    } else {
      checks.push({ name: "DEEPGRAM_API_KEY", present: true, valid: true, note: "TRANSCRIPT_QA_DEEPGRAM_API_KEY is accepted in its place" });
    }
  } else if (SEMANTIC_QA_CREDENTIAL[semanticProvider]) {
    if (!value(env, "TRANSCRIPT_QA_OPENAI_API_KEY") && !value(env, "OPENAI_API_KEY")) {
      checks.push({ name: "TRANSCRIPT_QA_OPENAI_API_KEY", present: false, valid: false });
      if (!missing.includes("TRANSCRIPT_QA_OPENAI_API_KEY")) missing.push("TRANSCRIPT_QA_OPENAI_API_KEY");
    } else {
      checks.push({ name: "TRANSCRIPT_QA_OPENAI_API_KEY", present: true, valid: true, note: "OPENAI_API_KEY is accepted in its place" });
    }
  }
  // A deliberate waiver would let semantic QA be skipped in production. The
  // canary refuses it: a run that skipped the only meaning-aware check proves
  // nothing about meaning.
  optionalVar(
    "TTS_TRANSCRIPT_QA_WAIVED",
    (v) => (v.toLowerCase() === "true" ? "the canary may not run under a semantic-QA waiver" : null),
    "must not be 'true' for a canary run"
  );

  // ---- optional, shape-checked ----
  optionalVar(
    "FISH_SCENE_MODEL",
    (v) => (/^s2(?:[.-]|$)/i.test(v) ? null : "Fish multi-speaker rendering requires an S2-family model"),
    `defaults to ${CANARY_EXPECTED_FISH_SCENE_MODEL}`
  );
  optionalVar("CANARY_EXPECTED_FISH_SCENE_MODEL", undefined, "explicit acknowledgement of a Fish model promotion");
  optionalVar("CANARY_BASELINE_PATH");
  optionalVar("CANARY_REPORT_DIR");
  optionalVar("CANARY_NEWS_FEEDS", undefined, "comma-separated feed override; defaults to the app's news feeds");
  optionalVar("CANARY_TARGET_DURATION_MIN", (v) =>
    Number.isFinite(Number(v)) && Number(v) >= 2 && Number(v) <= 20 ? null : "must be a number of minutes between 2 and 20"
  );
  optionalVar("FFMPEG_PATH");
  optionalVar("FFPROBE_PATH");

  const ok = missing.length === 0 && invalid.length === 0;
  const summary = ok
    ? `Preflight OK — ${checks.filter((c) => c.present).length} configured variables; providers: ${requiredProviders.join(", ") || "(none)"}; roles: ${CANARY_LLM_ROLES.length}.`
    : [
        missing.length ? `MISSING (${missing.length}): ${missing.join(", ")}` : "",
        invalid.length
          ? `INVALID (${invalid.length}): ${invalid.map((i) => `${i.name} (${i.reason})`).join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join(" | ");

  return { ok, missing, invalid, checks, requiredProviders, requiredRoles: CANARY_LLM_ROLES, summary };
}

// ---------------------------------------------------------------- route independence

export interface CanaryRoute {
  role: string;
  /** provider/model, for humans. */
  label: string;
  /** provider + normalized base URL + model. Two routes are the SAME endpoint
   *  when these match, even if the labels differ. */
  identity: string;
}

export interface RouteIndependence {
  independent: boolean;
  /** Authoring roles that share the judge's endpoint. */
  collisions: string[];
  reason: string | null;
}

/**
 * PURE. Decide whether the judge is genuinely independent of the writers.
 *
 * Run BEFORE any spend: a model grading its own output is a configuration
 * defect, and discovering it after paying for a full seven-role script means
 * paying for a verdict that was never worth anything.
 */
export function assessRouteIndependence(authoring: CanaryRoute[], judge: CanaryRoute): RouteIndependence {
  const collisions = authoring.filter((r) => r.identity === judge.identity).map((r) => r.role);
  if (!collisions.length) return { independent: true, collisions: [], reason: null };
  return {
    independent: false,
    collisions,
    reason:
      `The independent judge (${CANARY_JUDGE_ROLE}) resolves to ${judge.label}, the same endpoint as ` +
      `${collisions.length} authoring role(s): ${collisions.join(", ")}. A model cannot independently judge ` +
      `dialogue it wrote. Point ${roleEnvVars(CANARY_JUDGE_ROLE).join(" / ")} at a different provider or model.`,
  };
}

/** Resolve every canary route without calling anything. */
function resolveCanaryRoutes(): { all: CanaryRoute[]; authoring: CanaryRoute[]; judge: CanaryRoute } {
  const route = (role: LLMRole): CanaryRoute => {
    const first = resolveRolePlan(role).candidates[0];
    const candidate = first ?? { provider: "(no candidate)", model: undefined };
    return { role, label: candidateKey(candidate), identity: endpointIdentity(candidate) };
  };
  const all = CANARY_LLM_ROLES.map(route);
  const byRole = new Map(all.map((r) => [r.role, r]));
  return {
    all,
    authoring: CANARY_AUTHORING_ROLES.map((r) => byRole.get(r)!),
    judge: byRole.get(CANARY_JUDGE_ROLE)!,
  };
}

// ---------------------------------------------------------------- role drift

export interface CanaryRoleRow {
  role: string;
  order: number;
  label: string;
  status: "ok" | "failed" | "skipped";
  required: boolean;
  /** The provider the router ASKED for. */
  provider: string;
  requestedModel: string;
  /** What actually served the call. `null` means nothing could be observed —
   *  never back-filled from the request. */
  actualProvider: string | null;
  actualModel: string | null;
  modelObservation: "cost_ledger" | "provider_report" | "unobserved";
  fellBack: boolean;
  fallbackReason: string | null;
  latencyMs: number;
  violations: number;
  error: string | null;
}

export interface RoleDriftVerdict {
  ok: boolean;
  /** Roles served by something other than what they asked for. */
  drifted: string[];
  /** Roles that ran but whose serving model could not be observed at all. */
  unobserved: string[];
  alertClass: CanaryAlertClass | null;
  reason: string | null;
}

function sameEndpointName(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * PURE. Turn the seven-role provenance into an explicit alert.
 *
 * The rule the seven-role trace already enforces internally is enforced again
 * here as a RUN OUTCOME: a role whose actual model differs from the requested
 * one is `model_drift`, not a footnote in a passing report. And a role that ran
 * with `modelObservation: "unobserved"` is also `model_drift` — the canary's
 * only job is to prove what served the call, and "we could not tell" is not a
 * proof, it is the absence of one.
 *
 * `(provider-default)` on either side is treated as a wildcard, matching how
 * scriptRoles decides divergence: a provider that reports its own default model
 * has not substituted anything.
 */
export function classifyRoleDrift(rows: CanaryRoleRow[]): RoleDriftVerdict {
  const drifted: string[] = [];
  const unobserved: string[] = [];
  const details: string[] = [];

  for (const row of rows) {
    if (row.status !== "ok") continue;
    const wildcard = row.requestedModel === "(provider-default)" || row.actualModel === "(provider-default)";
    const modelDiverged = row.actualModel !== null && !wildcard && !sameEndpointName(row.actualModel, row.requestedModel);
    const providerDiverged = row.actualProvider !== null && !sameEndpointName(row.actualProvider, row.provider);

    if (row.fellBack || modelDiverged || providerDiverged) {
      drifted.push(row.role);
      details.push(
        `${row.role} requested ${row.provider}/${row.requestedModel} but was served by ` +
          `${row.actualProvider ?? "unobserved"}/${row.actualModel ?? "unobserved"}` +
          `${row.fallbackReason ? ` (${row.fallbackReason})` : ""}`
      );
      continue;
    }
    if (row.actualModel === null || row.modelObservation === "unobserved") {
      unobserved.push(row.role);
      details.push(
        `${row.role} completed but nothing observed which model served it; the canary will not record ` +
          `${row.provider}/${row.requestedModel} as having run on the strength of having asked for it`
      );
    }
  }

  if (!drifted.length && !unobserved.length) {
    return { ok: true, drifted, unobserved, alertClass: null, reason: null };
  }
  return {
    ok: false,
    drifted,
    unobserved,
    alertClass: "model_drift",
    reason:
      `${drifted.length} role(s) were served by a different provider/model than requested and ` +
      `${unobserved.length} could not be observed at all. ${details.join(". ")}.`,
  };
}

// ---------------------------------------------------------------- report

export interface CanaryProviderResult {
  model: string;
  endpoint: string;
  latencyMs: number;
  bytes: number;
  durationMs: number | null;
  performanceScore: number;
  passed: boolean;
  failures: string[];
  /** Digest of the voice ids used. The ids themselves never reach the report. */
  voiceFingerprint: string;
  metrics: unknown;
}

export interface CanarySemanticQaResult {
  status: "pass" | "fail" | "not_run";
  provider: string | null;
  model: string | null;
  wordErrorRate: number | null;
  speakerAttributionErrorRate: number | null;
  criticalTokenMissRate: number | null;
  interruptionErrorRate: number | null;
  segmentCount: number;
  speakerMap: Record<string, string>;
  failures: string[];
  warnings: string[];
}

export interface CanaryStageRecord {
  name: string;
  status: "ok" | "failed";
  ms: number;
  detail?: string;
}

export interface CanaryCostBlock {
  stages: Array<{
    stage: string;
    calls: number;
    models: string[];
    roles: string[];
    tkIn: number;
    tkOut: number;
    tkCacheRead: number;
    tkCacheWrite: number;
    tkReasoning: number;
    wallMs: number;
    fallbacks: number;
    retries: number;
    failures: number;
    estimatedCostUsd: number | null;
  }>;
  totals: {
    calls: number;
    tkIn: number;
    tkOut: number;
    tkCacheRead: number;
    tkCacheWrite: number;
    tkReasoning: number;
    wallMs: number;
    fallbacks: number;
    retries: number;
    failures: number;
    /** null when NOTHING in the run was priced. Never a confident $0.00 —
     *  LLM_PRICE_<PROVIDER>_IN/_OUT is what makes this a number. */
    estimatedCostUsd: number | null;
  };
  /** Stated so a null dollar figure is never mistaken for "it was free". */
  pricingNote: string;
}

export interface CanaryReport {
  version: 3;
  ranAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  private: true;
  published: false;
  /** No artifact of this run is uploaded anywhere but the private CI artifact. */
  uploadedAnywhere: false;
  /** "ok" only when every stage passed. */
  status: "ok" | "failed";
  /** Machine-readable alert routing key. Always set. */
  alertClass: CanaryAlertClass;
  /** One sentence naming what to go fix. Never contains a secret value. */
  alertReason: string | null;
  preflight: PreflightResult;
  routing: {
    routes: CanaryRoute[];
    writer: string | null;
    judge: string | null;
    /** False when the judge shares an endpoint with a role that wrote dialogue. */
    independent: boolean | null;
    independenceReason: string | null;
  };
  /** Wall time per live stage, in execution order. */
  stages: CanaryStageRecord[];
  story: {
    feedsQueried: number;
    itemsFetched: number;
    candidates: number;
    clusters: number;
    selectedTopicId: string | null;
    selectedTitle: string | null;
    /** The real rundown-diversity score of the selected set. */
    diversityScore: number | null;
    skipped: number;
    deferred: number;
    /** Live generation of the episode angle, on the real topic_generation route. */
    generatedAngle: string | null;
    latencyMs: number | null;
  } | null;
  brief: {
    ok: boolean;
    failure: string | null;
    sourcesInPacket: number;
    factCount: number;
    statCount: number;
    counterArgumentCount: number;
    unsafeClaimCount: number;
    citedSourceCount: number;
    latencyMs: number | null;
  } | null;
  roles: CanaryRoleRow[];
  roleDrift: RoleDriftVerdict;
  script: {
    segmentCount: number;
    lineCount: number;
    wordCount: number;
    judgeOverall: number | null;
    judgeError: string | null;
    violations: number;
  } | null;
  fish: {
    expectedSceneModel: string;
    resolvedSceneModel: string | null;
    renderedModel: string | null;
    drifted: boolean;
  };
  providers: Record<string, CanaryProviderResult>;
  semanticQa: Record<string, CanarySemanticQaResult>;
  mix: {
    path: string;
    bytes: number;
    durationMs: number | null;
    published: false;
    uploaded: false;
  } | null;
  cost: CanaryCostBlock | null;
  baseline: { path: string; present: boolean; ranAt: string | null; error: string | null };
  comparison: BaselineComparison;
  errors: string[];
}

const PRICING_NOTE =
  "Dollar figures are null unless LLM_PRICE_<PROVIDER>_IN / _OUT are configured. Token counts are provider-reported and always real.";

/**
 * Every block exists from the first line of the run.
 *
 * Not cosmetic: `if-no-files-found: error` and the step summary both read this
 * file, and a report whose `semanticQa` key only appears on success means a
 * failed run silently answers "no" to "did semantic QA run?" by omission. Empty
 * is a fact; missing is ambiguous.
 */
export function emptyCanaryReport(preflight: PreflightResult): CanaryReport {
  return {
    version: 3,
    ranAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    private: true,
    published: false,
    uploadedAnywhere: false,
    status: "failed",
    // Pessimistic default: if the process is killed before anything is
    // classified, the artifact still says "this run proved nothing".
    alertClass: "configuration_failure",
    alertReason: null,
    preflight,
    routing: { routes: [], writer: null, judge: null, independent: null, independenceReason: null },
    stages: [],
    story: null,
    brief: null,
    roles: [],
    roleDrift: { ok: false, drifted: [], unobserved: [], alertClass: null, reason: "the seven roles were never reached" },
    script: null,
    fish: {
      expectedSceneModel: CANARY_EXPECTED_FISH_SCENE_MODEL,
      resolvedSceneModel: null,
      renderedModel: null,
      drifted: false,
    },
    providers: {},
    semanticQa: {},
    mix: null,
    cost: null,
    baseline: { path: "", present: false, ranAt: null, error: null },
    comparison: emptyComparison(),
    errors: [],
  };
}

/** The report for a run that never reached a provider. */
export function configurationFailureReport(preflight: PreflightResult): CanaryReport {
  const report = emptyCanaryReport(preflight);
  report.status = "failed";
  report.alertClass = "configuration_failure";
  report.alertReason = `Canary configuration incomplete. ${preflight.summary}`;
  report.errors.push(preflight.summary);
  report.finishedAt = report.ranAt;
  report.durationMs = 0;
  return report;
}

/**
 * Belt-and-braces redaction. The report is built from names and booleans, but a
 * provider SDK can echo a key inside an error message and this artifact is
 * downloadable. Any configured secret value is scrubbed from the serialized
 * text before it touches the disk.
 */
export function serializeCanaryReport(report: CanaryReport, env: CanaryEnv): string {
  let json = JSON.stringify(report, null, 2);
  for (const name of CANARY_SECRET_VARS) {
    const secret = value(env, name);
    if (secret.length < 6) continue;
    json = json.split(secret).join("[redacted]");
    // Also scrub the JSON-escaped spelling, so a value containing quotes or
    // backslashes cannot survive serialization.
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) json = json.split(escaped).join("[redacted]");
  }
  return json;
}

/** Write report.json (creating the directory). Returns the path written. */
export function writeCanaryReport(outDir: string, report: CanaryReport, env: CanaryEnv): string {
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, "report.json");
  fs.writeFileSync(target, serializeCanaryReport(report, env));
  return target;
}

export function canaryOutputDir(env: CanaryEnv): string {
  return path.resolve(process.cwd(), value(env, "CANARY_REPORT_DIR") || "artifacts/live-provider-canary");
}

/** The durable record this run leaves behind for tomorrow's comparison. */
export function baselineFromReport(report: CanaryReport): CanaryBaselineRecord {
  return {
    ranAt: report.ranAt,
    status: report.status,
    providers: Object.fromEntries(
      Object.entries(report.providers).map(([name, p]) => [
        name,
        {
          model: p.model,
          endpoint: p.endpoint,
          latencyMs: p.latencyMs,
          performanceScore: p.performanceScore,
          voiceFingerprint: p.voiceFingerprint,
        },
      ])
    ),
    roles: report.roles.map((r) => ({
      role: r.role,
      requestedModel: r.requestedModel,
      actualProvider: r.actualProvider,
      actualModel: r.actualModel,
    })),
    cost: report.cost
      ? { tokens: report.cost.totals.tkIn + report.cost.totals.tkOut, estimatedCostUsd: report.cost.totals.estimatedCostUsd }
      : null,
  };
}

// ---------------------------------------------------------------- classification

/**
 * A key that is PRESENT but REJECTED is still a configuration problem — the
 * provider is up, the account is wrong. Only genuine provider-side trouble
 * (outage, rate limit, malformed output) earns `provider_failure`, so the two
 * alerts keep reaching the right person.
 */
const LLM_CONFIG_CATEGORIES = ["missing_api_key", "authentication_failed", "invalid_model", "unsupported_parameter"];
const SCENE_CONFIG_CATEGORIES = ["authentication", "insufficient_credit", "unsupported_model", "invalid_voice"];

export function classifyProviderError(error: unknown, sceneCategories = SCENE_CONFIG_CATEGORIES): CanaryAlertClass {
  if (error instanceof SemanticQaUnavailableError) return "configuration_failure";
  if (error instanceof LlmProviderError) {
    if (LLM_CONFIG_CATEGORIES.includes(error.category)) return "configuration_failure";
    // The chain reports the LAST category, so a run whose real cause was a
    // rejected key can end on "unknown". The aggregated message still names
    // every category it saw.
    if (LLM_CONFIG_CATEGORIES.some((c) => error.message.includes(`(${c})`))) return "configuration_failure";
  }
  if (error instanceof SceneGenerationError && sceneCategories.includes(error.category)) return "configuration_failure";
  return "provider_failure";
}

// ---------------------------------------------------------------- live stages

const HOST_A = SEED_HOSTS[0]?.name || "Host A";
const HOST_B = SEED_HOSTS[1]?.name || "Host B";

function shortId(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 12);
}

interface LiveNewsItem {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: Date;
  summary: string | null;
}

/**
 * STAGE 1 — a CURRENT story, selected by the real selection code.
 *
 * The feeds are the application's own news feeds, fetched with the application's
 * own provider (browser headers and all — see providers/sports/rss.ts, which
 * exists because header-less datacenter requests get soft-blocked). The
 * selection is `clusterTopicsByEvent` + `enforceEventDiversity` +
 * `scoreRundownDiversity`, unchanged, because a canary that reimplements
 * selection proves the reimplementation works.
 */
async function selectCurrentStory(env: CanaryEnv): Promise<{
  story: ClusterableTopic;
  clusterMembers: LiveNewsItem[];
  itemsFetched: number;
  feedsQueried: number;
  candidates: number;
  clusters: number;
  diversityScore: number | null;
  skipped: number;
  deferred: number;
}> {
  const feedOverride = value(env, "CANARY_NEWS_FEEDS");
  if (feedOverride) process.env.NEWS_RSS_FEEDS = feedOverride;

  const provider = new RssNewsProvider();
  const raw = (await provider.getNews("")) as Array<{
    title?: string;
    source?: string;
    url?: string;
    publishedAt?: Date;
    summary?: string | null;
  }>;
  const feedsQueried = provider.lastRunIssues.length;

  const items: LiveNewsItem[] = raw
    .filter((r) => (r.title || "").trim().length > 12 && (r.url || "").trim())
    .map((r) => ({
      id: `news-${shortId(String(r.url))}`,
      title: String(r.title).trim(),
      source: String(r.source || "unknown"),
      url: String(r.url).trim(),
      publishedAt: r.publishedAt instanceof Date ? r.publishedAt : new Date(),
      summary: r.summary ? String(r.summary).trim() : null,
    }));

  if (items.length < 3) {
    throw new CanaryFailure(
      "provider_failure",
      `Live news feeds returned ${items.length} usable item(s); the canary needs at least 3 to select a current story. ` +
        `Feed diagnostics: ${provider.lastRunIssues.slice(0, 4).join(" | ") || "(none reported)"}`
    );
  }

  // Freshest first — the same ordering assumption enforceEventDiversity is
  // designed around (it walks an ALREADY-RANKED list).
  const ranked: ClusterableTopic[] = [...items]
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, 40)
    .map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      createdAt: item.publishedAt,
      sources: [
        {
          canonicalUrl: item.url,
          originalUrl: item.url,
          title: item.title,
          publishedAt: item.publishedAt,
        },
      ],
      eventContext: {
        newsItems: [{ id: item.id, title: item.title, url: item.url, publishedAt: item.publishedAt }],
      },
    }));

  const clustering = clusterTopicsByEvent(ranked);
  const enforced = enforceEventDiversity(ranked, 5);
  if (!enforced.chosen.length) {
    throw new CanaryFailure(
      "provider_failure",
      `Event-diversity enforcement rejected all ${ranked.length} live candidates; no current story could be selected.`
    );
  }
  const story = enforced.chosen[0];
  const rundown = scoreRundownDiversity(enforced.chosen);

  const clusterId = clustering.clusterIdByTopicId[story.id];
  const memberIds = new Set(
    clustering.clusters.find((c) => c.id === clusterId)?.topicIds ?? [story.id]
  );
  const byId = new Map(items.map((i) => [i.id, i]));
  const clusterMembers = [...memberIds].map((id) => byId.get(id)).filter((i): i is LiveNewsItem => Boolean(i));

  return {
    story,
    clusterMembers: clusterMembers.length ? clusterMembers : [byId.get(story.id)!],
    itemsFetched: items.length,
    feedsQueried,
    candidates: ranked.length,
    clusters: clustering.clusters.length,
    diversityScore: rundown.score ?? null,
    skipped: enforced.skipped.length,
    deferred: enforced.deferred.length,
  };
}

/**
 * STAGE 1b — turn the selected event into an episode angle on the REAL
 * `topic_generation` route. This is the live LLM call the story-selection path
 * makes in production; running it here is what proves that route still returns
 * parseable structured output.
 */
async function generateEpisodeAngle(story: ClusterableTopic, sources: LiveNewsItem[]): Promise<{
  title: string;
  angle: string;
  disagreement: string;
}> {
  const llm = getRoleLLMProvider("topic_generation");
  return withLlmStage("canary:topic-generation", () =>
    llm.generateStructuredOutput<{ title: string; angle: string; disagreement: string }>({
      systemPrompt:
        "You turn a real news event into one episode angle two hosts can genuinely disagree about. " +
        "Use only the supplied material. Invent no facts, no numbers, no quotes.",
      prompt:
        `Event: ${story.title}\n\nSupplied material:\n` +
        sources.map((s) => `- ${s.title} (${s.source}) :: ${s.summary || "(no summary supplied)"}`).join("\n") +
        `\n\nReturn JSON {"title":"episode title","angle":"one sentence on what this episode is about",` +
        `"disagreement":"one sentence naming the question the two hosts cannot settle by agreeing"}`,
      temperature: 0.4,
      validate: (parsed) => {
        const v = parsed as { title?: unknown; angle?: unknown; disagreement?: unknown };
        return typeof v?.title === "string" && typeof v?.angle === "string" && typeof v?.disagreement === "string"
          ? null
          : "topic_generation must return title, angle and disagreement as strings.";
      },
    })
  );
}

/**
 * STAGE 2 — a NEW research brief on the real `research_brief` route, graded by
 * the real validator.
 *
 * The packet is built with the production helpers (`selectUsableSources`,
 * `buildAllowedKeys`, `serializeSourceForPacket`, `sourceRulesBlock`) and the
 * result goes through `validateBriefResult`, so a model that cites an id it was
 * never given fails here exactly as it would in the worker. The database write
 * is the only part not exercised — the canary has no database, and inventing one
 * would test the fixture rather than the route.
 */
async function generateResearchBrief(
  topicId: string,
  episodeTitle: string,
  sources: LiveNewsItem[]
): Promise<{
  validated: ReturnType<typeof validateBriefResult>;
  packetSize: number;
  evidenceText: string;
}> {
  const packetRows: PacketTopicSource[] = sources.map((s, i) => ({
    id: `canary-src-${i + 1}-${shortId(s.url)}`,
    canonicalUrl: s.url,
    title: s.title,
    publisher: s.source,
    author: null,
    publishedAt: s.publishedAt,
    excerpt: s.summary && s.summary.length >= 40 ? s.summary : `${s.title}. Reported by ${s.source}.`.padEnd(40, " "),
    contentHash: shortId(`${s.url}|${s.summary ?? ""}`),
    retrievedAt: new Date(),
    fetchStatus: "imported",
    topicId,
  }));
  const usable = selectUsableSources(packetRows, topicId);
  if (!usable.length) {
    throw new CanaryFailure(
      "provider_failure",
      `No live source survived packet selection for '${episodeTitle}'; a brief with an empty packet is invention by definition.`
    );
  }
  const allowedKeys = buildAllowedKeys({ evidenceIds: [], sources: usable, researchCount: 0 });
  const packet = usable.map(serializeSourceForPacket);

  const systemPrompt = [
    "You prepare a structured research brief for a two-host sports podcast.",
    sourceRulesBlock(),
    `Return JSON {"keyFactsContext":[{"text":"...","evidenceRefs":[{"type":"topicSource","id":"..."}]}],`,
    `"keyStats":[],"counterArguments":[],"unsafeClaims":[{"claim":"...","reason":"..."}],`,
    `"argumentForHostA":{"text":"...","evidenceRefs":[{"type":"topicSource","id":"..."}]},`,
    `"argumentForHostB":{"text":"...","evidenceRefs":[{"type":"topicSource","id":"..."}]},`,
    `"sourceIds":[{"type":"topicSource","id":"..."}]}`,
  ].join("\n");

  const llm = getRoleLLMProvider("research_brief");
  const llmResult = await withLlmStage("canary:research-brief", () =>
    llm.generateStructuredOutput<Record<string, unknown>>({
      systemPrompt,
      prompt: `Topic: ${episodeTitle}\n\nEvidence packet:\n${JSON.stringify(packet, null, 2)}`,
      temperature: 0.2,
    })
  );

  const validated = validateBriefResult({
    llmResult,
    allowedKeys,
    topicId,
    hostAName: HOST_A,
    hostBName: HOST_B,
  });

  const evidenceText = [
    `TOPIC: ${episodeTitle}`,
    "",
    "VERIFIED FACTS (each carries the source it came from):",
    ...validated.facts.map((f, i) => `F${i + 1}. ${f.text}  [${f.evidenceRefs.map((r) => `${r.type}:${r.id}`).join(", ")}]`),
    ...(validated.stats.length ? ["", "FIGURES:"] : []),
    ...validated.stats.map((s, i) => `S${i + 1}. ${s.text}`),
    ...(validated.counterArguments.length ? ["", "COUNTER-ARGUMENTS:"] : []),
    ...validated.counterArguments.map((c, i) => `C${i + 1}. ${c.text}`),
    "",
    `${HOST_A}'s line of argument: ${validated.argumentForHostA}`,
    `${HOST_B}'s line of argument: ${validated.argumentForHostB}`,
    "",
    "SOURCES:",
    ...usable.map((s) => `- ${s.id}: ${s.title} (${s.publisher}) ${s.canonicalUrl}`),
  ].join("\n");

  return { validated, packetSize: usable.length, evidenceText };
}

// ---------------------------------------------------------------- rendering

function voiceFor(env: CanaryEnv, provider: CanaryProviderId, seat: "A" | "B"): string {
  return provider === "fish"
    ? value(env, `CANARY_FISH_VOICE_${seat}`)
    : value(env, `CANARY_ELEVENLABS_VOICE_${seat}`);
}

interface RenderableLine {
  lineIndex: number;
  speakerHostId: "a" | "b";
  speakerName: string;
  text: string;
  tone?: string;
  energy?: "low" | "medium" | "high";
  isInterruption: boolean;
}

/** The freshly written cold open, capped so one canary render stays small. */
function renderableColdOpen(segments: Array<{ lines?: unknown[] }>, maxLines: number): RenderableLine[] {
  const lines = (segments[0]?.lines || []) as Array<Record<string, unknown>>;
  return lines.slice(0, maxLines).map((line, i): RenderableLine => {
    const speakerName = String(line.speakerName || (i % 2 === 0 ? HOST_A : HOST_B));
    const energy = String(line.energy || "medium");
    return {
      lineIndex: i,
      speakerHostId: speakerName === HOST_A ? "a" : "b",
      speakerName,
      text: String(line.text || "").trim(),
      tone: typeof line.tone === "string" ? line.tone : undefined,
      energy: energy === "low" || energy === "high" ? energy : "medium",
      isInterruption: line.isInterruption === true,
    };
  }).filter((l) => l.text.length > 0);
}

function sceneInput(env: CanaryEnv, provider: CanaryProviderId, lines: RenderableLine[]): DialogueSceneInput {
  const utterances: SceneUtterance[] = lines.map((line) => ({
    lineIndex: line.lineIndex,
    speakerHostId: line.speakerHostId,
    speakerName: line.speakerName,
    seatIndex: line.speakerHostId === "a" ? 0 : 1,
    voiceId: voiceFor(env, provider, line.speakerHostId === "a" ? "A" : "B"),
    spokenText: line.text,
    tone: line.tone,
    energy: line.energy,
    isInterruption: line.isInterruption,
    pauseBefore: "none",
  }));
  return {
    episodeId: "private-canary",
    scriptId: "private-canary",
    sceneId: `${provider}-canary`,
    sceneIndex: 0,
    sceneType: "cold_open",
    formatId: "two_host_debate",
    utterances,
    cast: ["a", "b"].map((speakerHostId, i) => ({
      speakerHostId,
      formatRoleId: i ? "chair_b" : "chair_a",
      direction: "Distinct live podcast host reacting in the moment.",
      intensityLevel: i ? 6 : 8,
      angerStyle: i ? "slower_quieter" : "louder_faster",
      maxCueDensity: 1,
      profileVersion: 1,
    })),
    format: "mp3",
    wantTimestamps: provider === "elevenlabs",
  };
}

function expectedSpokenLines(lines: RenderableLine[]): ExpectedSpokenLine[] {
  return lines.map((line) => ({
    lineIndex: line.lineIndex,
    speakerHostId: line.speakerHostId,
    speakerName: line.speakerName,
    text: line.text,
    isInterruption: line.isInterruption,
  }));
}

function toSemanticResult(report: AudioSemanticQaReport): CanarySemanticQaResult {
  return {
    status: report.status,
    provider: report.provider,
    model: report.model,
    wordErrorRate: report.wordErrorRate,
    speakerAttributionErrorRate: report.speakerAttributionErrorRate,
    criticalTokenMissRate: report.criticalTokenMissRate,
    interruptionErrorRate: report.interruptionErrorRate,
    segmentCount: report.segments.length,
    speakerMap: report.speakerMap,
    failures: report.failures,
    warnings: report.warnings,
    // The TRANSCRIPT is deliberately not copied into the report: it is the
    // spoken content of an unpublished episode and the artifact is downloadable.
  };
}

/**
 * STAGE 7 — the PRIVATE mix.
 *
 * ffmpeg joins the provider renders into one mastered file inside the artifact
 * directory. No storage client is imported by this module, so there is no code
 * path that could upload it; the report records `published:false, uploaded:false`
 * as a statement of that fact rather than a hope.
 */
async function mixPrivateArtifact(outDir: string, inputs: string[]): Promise<{ path: string; bytes: number; durationMs: number | null }> {
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
  const target = path.join(outDir, "canary-mix.mp3");
  const filter = `${inputs.map((_, i) => `[${i}:a]`).join("")}concat=n=${inputs.length}:v=0:a=1[joined];[joined]loudnorm=I=-16:TP=-1.5:LRA=11[mixed]`;
  await runFfmpeg(ffmpegPath, [
    "-y",
    ...inputs.flatMap((input) => ["-i", input]),
    "-filter_complex", filter,
    "-map", "[mixed]",
    "-ar", "44100",
    "-ac", "2",
    "-b:a", "128k",
    target,
  ]);
  const bytes = fs.statSync(target).size;
  let durationMs: number | null = null;
  try {
    durationMs = await getFileDurationMs(ffprobePath, target);
  } catch {
    // ffprobe absence must not lose the mix that already rendered.
    durationMs = null;
  }
  return { path: target, bytes, durationMs };
}

// ---------------------------------------------------------------- cost

function summarizeCost(mark: number): CanaryCostBlock {
  const since = llmCostSince(mark);
  return {
    stages: since.stages.map((s) => ({
      stage: s.stage,
      calls: s.calls,
      models: s.models,
      roles: s.roles,
      tkIn: s.tkIn,
      tkOut: s.tkOut,
      tkCacheRead: s.tkCacheRead,
      tkCacheWrite: s.tkCacheWrite,
      tkReasoning: s.tkReasoning,
      wallMs: s.wallMs,
      fallbacks: s.fallbacks,
      retries: s.retries,
      failures: s.failures,
      estimatedCostUsd: s.estimatedCostUsd,
    })),
    totals: {
      calls: since.totals.calls,
      tkIn: since.totals.tkIn,
      tkOut: since.totals.tkOut,
      tkCacheRead: since.totals.tkCacheRead,
      tkCacheWrite: since.totals.tkCacheWrite,
      tkReasoning: since.totals.tkReasoning,
      wallMs: since.totals.wallMs,
      fallbacks: since.totals.fallbacks,
      retries: since.totals.retries,
      failures: since.totals.failures,
      estimatedCostUsd: since.totals.estimatedCostUsd,
    },
    pricingNote: PRICING_NOTE,
  };
}

function roleRow(record: RoleStageRecord): CanaryRoleRow {
  return {
    role: record.role,
    order: record.order,
    label: record.label,
    status: record.status,
    required: record.required,
    provider: record.requestedProvider,
    requestedModel: record.requestedModel,
    actualProvider: record.actualProvider,
    actualModel: record.actualModel,
    modelObservation: record.modelObservation,
    fellBack: record.fallbackFired,
    fallbackReason: record.fallbackReason,
    latencyMs: record.durationMs,
    violations: record.violations.length,
    error: record.error ?? null,
  };
}

function countWords(segments: Array<{ lines?: unknown[] }>): number {
  let total = 0;
  for (const segment of segments) {
    for (const line of (segment.lines || []) as Array<{ text?: unknown }>) {
      if (typeof line?.text === "string") total += line.text.split(/\s+/).filter(Boolean).length;
    }
  }
  return total;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const env = process.env as CanaryEnv;
  const startedAt = Date.now();
  const outDir = canaryOutputDir(env);

  // PREFLIGHT FIRST: no provider is constructed until configuration is proven.
  const preflight = preflightCanaryEnv(env);
  const report = emptyCanaryReport(preflight);
  const costMark = llmCostMark();

  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      const result = await fn();
      report.stages.push({ name, status: "ok", ms: Date.now() - t0 });
      return result;
    } catch (error) {
      report.stages.push({ name, status: "failed", ms: Date.now() - t0, detail: (error as Error).message });
      throw error;
    }
  };

  try {
    if (!preflight.ok) {
      throw new CanaryFailure("configuration_failure", `Canary configuration incomplete. ${preflight.summary}`);
    }
    console.log(preflight.summary);

    // ---- independence, BEFORE any spend ----
    const routes = resolveCanaryRoutes();
    const independence = assessRouteIndependence(routes.authoring, routes.judge);
    report.routing = {
      routes: routes.all,
      writer: routes.authoring.find((r) => r.role === "script_host_a_writer")?.label ?? null,
      judge: routes.judge.label,
      independent: independence.independent,
      independenceReason: independence.reason,
    };
    if (!independence.independent) {
      throw new CanaryFailure("configuration_failure", independence.reason!);
    }
    console.log(`Routes: ${routes.all.map((r) => `${r.role}=${r.label}`).join(", ")}`);

    // ---- 1. a CURRENT story, via the real selection path ----
    const storyStart = Date.now();
    const selection = await stage("story_selection", () => selectCurrentStory(env));
    const angle = await stage("topic_generation", () => generateEpisodeAngle(selection.story, selection.clusterMembers));
    report.story = {
      feedsQueried: selection.feedsQueried,
      itemsFetched: selection.itemsFetched,
      candidates: selection.candidates,
      clusters: selection.clusters,
      selectedTopicId: selection.story.id,
      selectedTitle: selection.story.title,
      diversityScore: selection.diversityScore,
      skipped: selection.skipped,
      deferred: selection.deferred,
      generatedAngle: angle.angle,
      latencyMs: Date.now() - storyStart,
    };
    console.log(`Story: "${angle.title}" — ${angle.angle}`);

    // ---- 2. a NEW research brief, on the real route ----
    const briefStart = Date.now();
    const brief = await stage("research_brief", () =>
      generateResearchBrief(selection.story.id, angle.title, selection.clusterMembers)
    );
    report.brief = {
      ok: brief.validated.ok,
      failure: brief.validated.failure ?? null,
      sourcesInPacket: brief.packetSize,
      factCount: brief.validated.facts.length,
      statCount: brief.validated.stats.length,
      counterArgumentCount: brief.validated.counterArguments.length,
      unsafeClaimCount: brief.validated.unsafeClaims.length,
      citedSourceCount: brief.validated.sourceIds.length,
      latencyMs: Date.now() - briefStart,
    };
    if (!brief.validated.ok) {
      // A brief that fails the REAL validator is a genuine regression in the
      // research route, not a canary inconvenience.
      throw new CanaryFailure(
        "quality_regression",
        `The live research brief failed the production validator (${brief.validated.failure}). ` +
          `${brief.validated.facts.length} grounded fact(s), ${brief.validated.unsafeClaims.length} unsafe claim(s).`
      );
    }

    // ---- 3 & 4. ALL SEVEN roles, then the independent judge ----
    const targetDuration = Number(value(env, "CANARY_TARGET_DURATION_MIN")) || 4;
    const pipeline = await stage("seven_role_pipeline", async () =>
      runSevenRolePipeline({
        systemPrompt:
          `Two-host sports podcast. ${HOST_A} and ${HOST_B} disagree honestly and never recap. ` +
          `Every factual claim must come from the supplied evidence.`,
        episodeTitle: angle.title,
        topicsPrompts: `${brief.evidenceText}\n\nUNRESOLVED QUESTION: ${angle.disagreement}`,
        targetDuration,
        temperature: 0.8,
        maxTokens: 4000,
        speakerNames: [HOST_A, HOST_B],
        log: (message) => console.log(`  ${message}`),
      })
    );
    report.roles = pipeline.trace.stageRecords.map(roleRow);

    if (!pipeline.ok || !pipeline.segments) {
      throw new CanaryFailure(
        "quality_regression",
        `The seven-role pipeline did not produce a script: ${pipeline.error || "no reason recorded"}`
      );
    }

    const verdict = await stage("independent_judge", () =>
      runIndependentJudgeStage(pipeline.trace, {
        segments: pipeline.segments!,
        episodeTitle: angle.title,
        hostNames: [HOST_A, HOST_B],
        evidenceSummary: brief.evidenceText.slice(0, 4000),
      })
    );
    report.roles = pipeline.trace.stageRecords.map(roleRow);
    const lineCount = pipeline.segments.reduce((n, s) => n + (s.lines?.length || 0), 0);
    report.script = {
      segmentCount: pipeline.segments.length,
      lineCount,
      wordCount: countWords(pipeline.segments),
      judgeOverall: verdict.judge?.overall ?? null,
      judgeError: verdict.judgeError ?? null,
      violations: pipeline.trace.violations.length,
    };

    // A missing verdict is not a soft outcome. The whole point of role 7 is that
    // somebody other than the writer said the script was good enough.
    if (!verdict.judge) {
      throw new CanaryFailure(
        "quality_regression",
        `The independent judge returned no verdict: ${verdict.judgeError || "no reason recorded"}`
      );
    }

    // ---- 5. NOTHING SILENT: drift is a run outcome, not a footnote ----
    report.roleDrift = classifyRoleDrift(report.roles);
    if (!report.roleDrift.ok) {
      throw new CanaryFailure(report.roleDrift.alertClass!, report.roleDrift.reason!);
    }

    // ---- Fish model policy, recorded before any render ----
    if (preflight.requiredProviders.includes("fish")) {
      const expected = value(env, "CANARY_EXPECTED_FISH_SCENE_MODEL") || CANARY_EXPECTED_FISH_SCENE_MODEL;
      report.fish.expectedSceneModel = expected;
      try {
        report.fish.resolvedSceneModel = resolveFishSceneModel();
      } catch (error) {
        throw new CanaryFailure("voice_drift", `Fish scene model is unusable: ${(error as Error).message}`);
      }
      if (report.fish.resolvedSceneModel !== expected) {
        report.fish.drifted = true;
        throw new CanaryFailure(
          "voice_drift",
          `Fish scene model resolved to '${report.fish.resolvedSceneModel}' but the canary contract is '${expected}'.`
        );
      }
    }

    // ---- 6 & 7. real audio, performance QA, semantic QA ----
    const spoken = renderableColdOpen(pipeline.segments, 6);
    if (spoken.length < 2) {
      throw new CanaryFailure(
        "quality_regression",
        `The written cold open yielded ${spoken.length} speakable line(s); there is nothing to render.`
      );
    }
    fs.mkdirSync(outDir, { recursive: true });
    const renderedPaths: string[] = [];

    for (const provider of preflight.requiredProviders) {
      const adapter = provider === "fish" ? new FishTTSProvider() : new ElevenLabsTTSProvider();
      const started = Date.now();
      let audio: Awaited<ReturnType<typeof adapter.synthesizeDialogueScene>>;
      try {
        audio = await stage(`render:${provider}`, () => adapter.synthesizeDialogueScene(sceneInput(env, provider, spoken)));
      } catch (error) {
        // A rejected MODEL is drift, not an outage — it means the provider no
        // longer serves what this canary is contracted to render on.
        const alertClass =
          error instanceof SceneGenerationError && error.category === "unsupported_model"
            ? "voice_drift"
            : classifyProviderError(error, ["authentication", "insufficient_credit", "invalid_voice"]);
        throw new CanaryFailure(alertClass, `${provider} scene render failed: ${(error as Error).message}`);
      }
      const latencyMs = Date.now() - started;
      const qa = await stage(`performance_qa:${provider}`, () =>
        analyzeSpokenPerformanceBuffer(audio.audioBuffer, {
          expectedTurnCount: spoken.length,
          sceneType: "cold_open",
          format: "mp3",
          strict: true,
        })
      );
      const filePath = path.join(outDir, `${provider}.mp3`);
      fs.writeFileSync(filePath, audio.audioBuffer);
      renderedPaths.push(filePath);

      report.providers[provider] = {
        model: audio.model,
        endpoint: audio.endpoint,
        latencyMs,
        bytes: audio.audioBuffer.length,
        durationMs: audio.durationMs ?? null,
        performanceScore: qa.score,
        passed: qa.passed,
        failures: qa.failures,
        voiceFingerprint: voiceFingerprint([
          provider,
          audio.model,
          voiceFor(env, provider, "A"),
          voiceFor(env, provider, "B"),
        ]),
        metrics: qa.metrics,
      };

      if (provider === "fish") {
        report.fish.renderedModel = audio.model;
        if (audio.model && audio.model !== report.fish.expectedSceneModel) {
          report.fish.drifted = true;
          throw new CanaryFailure(
            "voice_drift",
            `Fish rendered on '${audio.model}' but the canary contract is '${report.fish.expectedSceneModel}'.`
          );
        }
      }

      // Meaning-aware QA on the bytes that were actually produced.
      let semantic: AudioSemanticQaReport;
      try {
        semantic = await stage(`semantic_qa:${provider}`, () =>
          runAudioSemanticQa({
            audio: audio.audioBuffer,
            mimeType: audio.contentType || "audio/mpeg",
            expected: expectedSpokenLines(spoken),
          })
        );
      } catch (error) {
        throw new CanaryFailure(
          classifyProviderError(error),
          `${provider} semantic QA could not run: ${(error as Error).message}`
        );
      }
      report.semanticQa[provider] = toSemanticResult(semantic);

      if (semantic.status === "not_run") {
        const requirement = resolveSemanticQaRequirement(process.env);
        throw new CanaryFailure(
          "configuration_failure",
          `Semantic QA reported not_run for ${provider}; the canary must never accept that outcome. ` +
            `Missing: ${requirement.missing.join(", ") || "(nothing named — check TTS_TRANSCRIPT_QA_ENABLED)"}.`
        );
      }
      if (semantic.status === "fail") {
        throw new CanaryFailure(
          "quality_regression",
          `${provider} semantic QA failed: ${semantic.failures.join(" ")}`
        );
      }
      if (!qa.passed) {
        throw new CanaryFailure("quality_regression", `${provider} live performance QA failed: ${qa.failures.join(" ")}`);
      }
    }

    // ---- 8. the PRIVATE mix ----
    if (renderedPaths.length) {
      const mixed = await stage("private_mix", () => mixPrivateArtifact(outDir, renderedPaths));
      report.mix = { ...mixed, published: false, uploaded: false };
      console.log(`[canary] private mix: ${mixed.path} (${mixed.durationMs ?? "unknown"}ms) — never uploaded, never published.`);
    }

    // ---- 9. the durable baseline ----
    const baselinePath =
      value(env, "CANARY_BASELINE_PATH") || path.join(outDir, "../live-provider-canary-baseline/report.json");
    const loaded = loadCanaryBaseline(baselinePath);
    report.baseline = {
      path: baselinePath,
      present: loaded.present,
      ranAt: loaded.record?.ranAt ?? null,
      error: loaded.error,
    };
    report.cost = summarizeCost(costMark);
    report.comparison = compareToBaseline(baselineFromReport(report), loaded.record);
    if (report.comparison.regressions.length) {
      const first = report.comparison.regressions[0];
      throw new CanaryFailure(first.alertClass, first.message);
    }

    report.status = "ok";
    report.alertClass = "ok";
    report.alertReason = null;
  } catch (error) {
    const failure = error as CanaryFailure;
    report.status = "failed";
    // An unexpected throw is still a provider-side surprise, never "ok"; a
    // CanaryFailure carries the class the failing stage decided on.
    report.alertClass = failure instanceof CanaryFailure ? failure.alertClass : classifyProviderError(error);
    report.alertReason = failure?.message || String(error);
    report.errors.push(failure?.message || String(error));
    console.error(`[canary] ${report.alertClass}: ${report.alertReason}`);
  } finally {
    // ALWAYS. This is what keeps `if-no-files-found: error` meaningful and what
    // gets the diagnosis out of the runner and into the uploaded artifact.
    // Cost is measured here too, so a run that died halfway still reports what
    // it spent getting there.
    report.cost = summarizeCost(costMark);
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    const written = writeCanaryReport(outDir, report, env);
    console.log(
      `[canary] status=${report.status} alertClass=${report.alertClass} ` +
        `roles=${report.roles.filter((r) => r.status === "ok").length}/${SEVEN_ROLE_ORDER.length} ` +
        `tokens=${report.cost?.totals.tkIn ?? 0}in/${report.cost?.totals.tkOut ?? 0}out report=${written}`
    );
  }

  process.exitCode = report.status === "ok" ? 0 : 1;
}

// Run only when this file is the entrypoint, so the preflight can be imported
// by tests without firing a live canary.
if (/runLiveProviderCanary\.(ts|mts|cts|js|mjs|cjs)$/.test(process.argv[1] || "")) {
  void main();
}
