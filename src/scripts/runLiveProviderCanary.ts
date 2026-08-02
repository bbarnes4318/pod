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
// Three rules now hold:
//   1. PREFLIGHT FIRST. Every required variable is checked by NAME before any
//      provider is touched. Missing configuration is reported as a list of
//      names — never a value, never a prefix, never a length.
//   2. A REPORT IS ALWAYS WRITTEN. try/finally, so preflight failure, provider
//      failure, regression and success all leave artifacts/…/report.json on
//      disk. That is what makes `if-no-files-found: error` a real signal.
//   3. THE ALERT CLASS IS EXPLICIT. A missing key is `configuration_failure`,
//      not a generic crash, so the alert says what to go fix.
//
// A fixed audio fixture isolates voice/model drift while a live LLM generation
// on the REAL production writer route catches structured-output and routing
// regressions.

import fs from "node:fs";
import path from "node:path";
import { getRoleLLMProvider, resolveRolePlan, candidateKey } from "../lib/providers/llm/routing";
import { ROUTING_PROFILES } from "../lib/providers/llm/profiles";
import { assessScriptQuality } from "../lib/services/scriptQualityJudge";
import { ElevenLabsTTSProvider } from "../lib/providers/tts/elevenlabs";
import { FishTTSProvider } from "../lib/providers/tts/fish";
import { resolveFishSceneModel } from "../lib/providers/tts/fishDialogue";
import { analyzeSpokenPerformanceBuffer } from "../lib/audio/spokenPerformanceQa";
import { LlmProviderError } from "../lib/providers/llm/errors";
import { SceneGenerationError, type DialogueSceneInput } from "../lib/providers/tts/sceneTypes";
import { FISH_REFERENCE_ID_RE } from "../lib/providers/tts/providerIds";

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
  | "voice_drift";

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

// ---------------------------------------------------------------- preflight

/** Variables required no matter which TTS providers are exercised. */
export const CANARY_REQUIRED_LLM_VARS = [
  "LLM_ROUTING_PROFILE",
  "SCRIPT_MOVEMENT_LLM_PROVIDER",
  "SCRIPT_MOVEMENT_LLM_MODEL",
  "QUALITY_JUDGE_LLM_PROVIDER",
  "QUALITY_JUDGE_LLM_MODEL",
  "ANTHROPIC_API_KEY",
] as const;

/** Variables required per TTS provider under test. */
export const CANARY_REQUIRED_PROVIDER_VARS: Record<CanaryProviderId, string[]> = {
  fish: ["FISH_API_KEY", "CANARY_FISH_VOICE_A", "CANARY_FISH_VOICE_B"],
  elevenlabs: ["ELEVENLABS_API_KEY", "CANARY_ELEVENLABS_VOICE_A", "CANARY_ELEVENLABS_VOICE_B"],
};

/** Credential each LLM provider name needs. Used to add a provider-specific key
 *  to the required list when the canary is pointed somewhere other than
 *  Anthropic. */
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
      missing.push(name);
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

  // ---- LLM routing: the production writer route must be addressable ----
  const knownLlmProvider = (v: string) =>
    LLM_PROVIDER_CREDENTIAL[v.toLowerCase()] || v.toLowerCase() === "stub"
      ? null
      : `unknown LLM provider; supported: ${Object.keys(LLM_PROVIDER_CREDENTIAL).join(", ")}, stub`;

  requireVar("LLM_ROUTING_PROFILE", (v) =>
    (ROUTING_PROFILES as string[]).includes(v.toLowerCase())
      ? null
      : `must be one of ${ROUTING_PROFILES.join(", ")}`
  );
  requireVar("SCRIPT_MOVEMENT_LLM_PROVIDER", knownLlmProvider);
  requireVar("SCRIPT_MOVEMENT_LLM_MODEL");
  requireVar("QUALITY_JUDGE_LLM_PROVIDER", knownLlmProvider);
  requireVar("QUALITY_JUDGE_LLM_MODEL");

  // Anthropic is this project's production writer route, so its key is required
  // unconditionally; a canary pointed at another provider additionally needs
  // that provider's credential.
  requireVar("ANTHROPIC_API_KEY");
  const extraCredentials = new Set<string>();
  for (const roleVar of ["SCRIPT_MOVEMENT_LLM_PROVIDER", "QUALITY_JUDGE_LLM_PROVIDER"]) {
    const credential = LLM_PROVIDER_CREDENTIAL[value(env, roleVar).toLowerCase()];
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

  // ---- optional, shape-checked ----
  optionalVar(
    "FISH_SCENE_MODEL",
    (v) => (/^s2(?:[.-]|$)/i.test(v) ? null : "Fish multi-speaker rendering requires an S2-family model"),
    `defaults to ${CANARY_EXPECTED_FISH_SCENE_MODEL}`
  );
  optionalVar("CANARY_EXPECTED_FISH_SCENE_MODEL", undefined, "explicit acknowledgement of a Fish model promotion");
  optionalVar("CANARY_BASELINE_PATH");
  optionalVar("CANARY_REPORT_DIR");

  const ok = missing.length === 0 && invalid.length === 0;
  const summary = ok
    ? `Preflight OK — ${checks.filter((c) => c.present).length} configured variables; providers: ${requiredProviders.join(", ") || "(none)"}.`
    : [
        missing.length ? `MISSING (${missing.length}): ${missing.join(", ")}` : "",
        invalid.length
          ? `INVALID (${invalid.length}): ${invalid.map((i) => `${i.name} (${i.reason})`).join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join(" | ");

  return { ok, missing, invalid, checks, requiredProviders, summary };
}

// ---------------------------------------------------------------- report

export interface CanaryProviderResult {
  model: string;
  latencyMs: number;
  bytes: number;
  performanceScore: number;
  passed: boolean;
  failures: string[];
  metrics: unknown;
}

export interface CanaryReport {
  version: 2;
  ranAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  private: true;
  published: false;
  /** "ok" only when every stage passed. */
  status: "ok" | "failed";
  /** Machine-readable alert routing key. Always set. */
  alertClass: CanaryAlertClass;
  /** One sentence naming what to go fix. Never contains a secret value. */
  alertReason: string | null;
  preflight: PreflightResult;
  routing: {
    writer: string | null;
    judge: string | null;
    /** False when the judge resolves to the same endpoint as the writer — a
     *  model grading its own homework is not an independent judge. */
    independent: boolean | null;
  };
  fish: {
    expectedSceneModel: string;
    resolvedSceneModel: string | null;
    renderedModel: string | null;
    drifted: boolean;
  };
  llm: { lineCount: number; judgeOverall: number | null } | null;
  providers: Record<string, CanaryProviderResult>;
  comparison: Record<string, { scoreDelta: number; latencyRatio: number }> | null;
  errors: string[];
}

export function emptyCanaryReport(preflight: PreflightResult): CanaryReport {
  return {
    version: 2,
    ranAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    private: true,
    published: false,
    status: "failed",
    // Pessimistic default: if the process is killed before anything is
    // classified, the artifact still says "this run proved nothing".
    alertClass: "configuration_failure",
    alertReason: null,
    preflight,
    routing: { writer: null, judge: null, independent: null },
    fish: {
      expectedSceneModel: CANARY_EXPECTED_FISH_SCENE_MODEL,
      resolvedSceneModel: null,
      renderedModel: null,
      drifted: false,
    },
    llm: null,
    providers: {},
    comparison: null,
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

// ---------------------------------------------------------------- fixture

const FIXED_LINES = [
  { lineIndex: 0, speakerHostId: "a", speakerName: "A", text: "You keep calling it patience. Who paid for that patience?", tone: "incredulous", energy: "high" as const, isInterruption: false },
  { lineIndex: 1, speakerHostId: "b", speakerName: "B", text: "The people who never controlled the decision. That's the problem.", tone: "analytical", energy: "medium" as const, isInterruption: false },
  { lineIndex: 2, speakerHostId: "a", speakerName: "A", text: "Then stop defending the timeline—", tone: "heated", energy: "high" as const, isInterruption: false },
  { lineIndex: 3, speakerHostId: "b", speakerName: "B", text: "I'm not defending it. I'm telling you when the trap closed.", tone: "dismissive", energy: "medium" as const, isInterruption: true },
];

function sceneInput(provider: CanaryProviderId): DialogueSceneInput {
  const voice = (host: "A" | "B") => provider === "fish"
    ? process.env[`CANARY_FISH_VOICE_${host}`] || ""
    : process.env[`CANARY_ELEVENLABS_VOICE_${host}`] || "";
  return {
    episodeId: "private-canary",
    scriptId: "private-canary",
    sceneId: `${provider}-canary`,
    sceneIndex: 0,
    sceneType: "cold_open",
    formatId: "two_host_debate",
    utterances: FIXED_LINES.map((line) => ({ ...line, seatIndex: line.speakerHostId === "a" ? 0 : 1, voiceId: voice(line.speakerHostId === "a" ? "A" : "B"), spokenText: line.text, pauseBefore: "none" })),
    cast: ["a", "b"].map((speakerHostId, i) => ({ speakerHostId, formatRoleId: i ? "chair_b" : "chair_a", direction: "Distinct live podcast host reacting in the moment.", intensityLevel: i ? 6 : 8, angerStyle: i ? "slower_quieter" : "louder_faster", maxCueDensity: 1, profileVersion: 1 })),
    format: "mp3",
    wantTimestamps: provider === "elevenlabs",
  };
}

// ---------------------------------------------------------------- live stages

/**
 * The REAL production writer route — `getRoleLLMProvider("script_movement")`,
 * the same call the script service makes — graded by the REAL judge route. An
 * ad-hoc prompt against a hand-built provider would pass while production's
 * routing was broken, which is the regression this canary exists to catch.
 */
async function liveScriptCheck(): Promise<{ segments: any[]; judgeOverall: number | null; lineCount: number }> {
  const writer = getRoleLLMProvider("script_movement");
  const result = await writer.generateStructuredOutput<{ segments: Array<{ lines?: unknown[]; [key: string]: unknown }> }>({
    systemPrompt: "Write grounded spoken podcast dialogue. Two distinct hosts, no greetings, no invented facts, no generic recap.",
    prompt: `Write a 4-6 turn cold open from this supplied fact only: A team publicly blamed chemistry after losing four consecutive games. Host A thinks leadership shifted blame downward. Host B thinks the public statement hides an earlier decision. Return JSON {"segments":[{"type":"cold_open","lines":[{"lineIndex":0,"speakerName":"A|B","text":"...","tone":"...","energy":"low|medium|high","pauseBefore":"none|beat|breath|long","isInterruption":false,"evidenceRefs":[],"isFactualClaim":false}]}]}`,
    temperature: 0.7,
    maxTokens: 2500,
    validate: (parsedValue) => {
      const parsed = parsedValue as { segments?: Array<{ lines?: unknown[] }> };
      return Array.isArray(parsed?.segments) && parsed.segments.flatMap((segment) => segment.lines || []).length >= 4
        ? null
        : "Canary script needs at least four lines.";
    },
  });
  const judge = getRoleLLMProvider("quality_judge");
  const quality = await assessScriptQuality(judge, result.segments, {
    episodeTitle: "Private provider canary",
    hostNames: ["A", "B"],
  });
  const lineCount = result.segments.flatMap((segment) => segment.lines || []).length;
  return { segments: result.segments, judgeOverall: quality.judge?.overall ?? null, lineCount };
}

/**
 * A key that is PRESENT but REJECTED is still a configuration problem — the
 * provider is up, the account is wrong. Only genuine provider-side trouble
 * (outage, rate limit, malformed output) earns `provider_failure`, so the two
 * alerts keep reaching the right person.
 */
const LLM_CONFIG_CATEGORIES = ["missing_api_key", "authentication_failed", "invalid_model", "unsupported_parameter"];
const SCENE_CONFIG_CATEGORIES = ["authentication", "insufficient_credit", "unsupported_model", "invalid_voice"];

export function classifyProviderError(error: unknown, sceneCategories = SCENE_CONFIG_CATEGORIES): CanaryAlertClass {
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

/** Resolve both role routes without calling anything, for the report. */
function resolveRouteLabels(): { writer: string; judge: string; independent: boolean } {
  const writer = candidateKey(resolveRolePlan("script_movement").candidates[0]);
  const judge = candidateKey(resolveRolePlan("quality_judge").candidates[0]);
  return { writer, judge, independent: writer !== judge };
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const env = process.env as CanaryEnv;
  const startedAt = Date.now();
  const outDir = canaryOutputDir(env);

  // PREFLIGHT FIRST: no provider is constructed until configuration is proven.
  const preflight = preflightCanaryEnv(env);
  const report = emptyCanaryReport(preflight);

  try {
    if (!preflight.ok) {
      throw new CanaryFailure("configuration_failure", `Canary configuration incomplete. ${preflight.summary}`);
    }
    console.log(preflight.summary);

    // Independent judging is a routing property, so it is checked before any
    // spend: one model grading its own output is a configuration defect.
    const routes = resolveRouteLabels();
    report.routing = routes;
    if (!routes.independent) {
      throw new CanaryFailure(
        "configuration_failure",
        `Writer and judge both resolve to ${routes.writer}; the quality_judge route must be independent of script_movement.`
      );
    }
    console.log(`Writer route: ${routes.writer} | judge route: ${routes.judge}`);

    // ---- live LLM on the production writer route ----
    let live: Awaited<ReturnType<typeof liveScriptCheck>>;
    try {
      live = await liveScriptCheck();
    } catch (error) {
      throw new CanaryFailure(classifyProviderError(error), `Live script generation failed: ${(error as Error).message}`);
    }
    report.llm = { lineCount: live.lineCount, judgeOverall: live.judgeOverall };

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

    // ---- real audio + the existing performance QA ----
    for (const provider of preflight.requiredProviders) {
      const adapter = provider === "fish" ? new FishTTSProvider() : new ElevenLabsTTSProvider();
      const started = Date.now();
      let audio: Awaited<ReturnType<typeof adapter.synthesizeDialogueScene>>;
      try {
        audio = await adapter.synthesizeDialogueScene(sceneInput(provider));
      } catch (error) {
        // A rejected MODEL is drift, not an outage — it means the provider no
        // longer serves what this canary is contracted to render on.
        const alertClass =
          error instanceof SceneGenerationError && error.category === "unsupported_model"
            ? "voice_drift"
            : classifyProviderError(error, ["authentication", "insufficient_credit", "invalid_voice"]);
        throw new CanaryFailure(alertClass, `${provider} scene render failed: ${(error as Error).message}`);
      }
      const qa = await analyzeSpokenPerformanceBuffer(audio.audioBuffer, {
        expectedTurnCount: FIXED_LINES.length,
        sceneType: "cold_open",
        format: "mp3",
        strict: true,
      });
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `${provider}.mp3`), audio.audioBuffer);
      report.providers[provider] = {
        model: audio.model,
        latencyMs: Date.now() - started,
        bytes: audio.audioBuffer.length,
        performanceScore: qa.score,
        passed: qa.passed,
        failures: qa.failures,
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

      if (!qa.passed) {
        throw new CanaryFailure("quality_regression", `${provider} live performance QA failed: ${qa.failures.join(" ")}`);
      }
    }

    // ---- baseline comparison (thresholds unchanged) ----
    const baselinePath = value(env, "CANARY_BASELINE_PATH") || path.join(outDir, "../live-provider-canary-baseline/report.json");
    if (fs.existsSync(baselinePath)) {
      const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as { providers?: Record<string, CanaryProviderResult> };
      report.comparison = {};
      for (const [provider, now] of Object.entries(report.providers)) {
        const before = baseline.providers?.[provider];
        if (!before) continue;
        const scoreDelta = now.performanceScore - before.performanceScore;
        const latencyRatio = now.latencyMs / Math.max(1, before.latencyMs);
        report.comparison[provider] = { scoreDelta, latencyRatio };
        if (scoreDelta < -12) {
          throw new CanaryFailure("quality_regression", `${provider} performance score regressed ${Math.abs(scoreDelta)} points.`);
        }
        if (latencyRatio > 2.5) {
          throw new CanaryFailure("latency_regression", `${provider} latency regressed to ${latencyRatio.toFixed(1)}x baseline.`);
        }
      }
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
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    const written = writeCanaryReport(outDir, report, env);
    console.log(`[canary] status=${report.status} alertClass=${report.alertClass} report=${written}`);
  }

  process.exitCode = report.status === "ok" ? 0 : 1;
}

// Run only when this file is the entrypoint, so the preflight can be imported
// by tests without firing a live canary.
if (/runLiveProviderCanary\.(ts|mts|cts|js|mjs|cjs)$/.test(process.argv[1] || "")) {
  void main();
}
