// PRODUCTION READINESS — THE EVIDENCE LAYER
//
// This module exists because the previous preflight reported things it had not
// proven. It answered "is a variable set?" and printed READY. A set variable is
// not a working credential, a registered worker connection is not a worker that
// consumes jobs, and an endpoint that answers an unauthenticated HEAD is not a
// bucket you can write to.
//
// Everything here is therefore split in two:
//
//   1. PURE EVALUATION — `evaluateReadiness()` turns an environment plus a set
//      of PROBE RESULTS into four independent verdicts. It performs no I/O, so
//      every false positive below can be reproduced offline in a unit test.
//   2. PROBES — the actual authenticated operations, behind an injectable
//      interface (`ReadinessDependencies`). `createLiveDependencies()` returns
//      the real ones; tests pass fakes.
//
// FOUR VERDICTS, NEVER COLLAPSED:
//
//   codeConfiguration       the committed code + variable NAMES are coherent
//   infrastructureReachable database, Redis, migrations, bucket, worker consume
//   liveProvidersVerified   LLM writer, LLM judge, transcription, every TTS
//                           provider answered an AUTHENTICATED call
//   releaseAccepted         all three above, plus mandatory canary config and a
//                           web/worker commit match against an EXPLICIT sha
//
// A mode that does not evaluate a verdict reports `not-evaluated`. It never
// reports "pass by omission", and the word READY is never printed unqualified.
//
// SECRETS ARE NEVER PRINTED. Variable NAMES and booleans only. `scrubSecrets()`
// is a second line of defence over every rendered string.

/* ------------------------------------------------------------------ */
/* 1. Vocabulary                                                        */
/* ------------------------------------------------------------------ */

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

/**
 * What the operator asked to be proven.
 *
 * `predeploy` and `release` are the two REAL deployment phases, and they exist
 * because asking one command to do both was circular: release mode verifies
 * that migrations are applied and that web and worker are already running the
 * new commit, none of which can be true before you deploy.
 *
 *   predeploy  BEFORE touching production. Everything that is knowable in
 *              advance: configuration, credentials, reachability, the migration
 *              PLAN, a backup, and a green canary for the exact commit.
 *   release    AFTER web and worker are deployed. Everything that only becomes
 *              true afterwards: migrations applied, no drift, both services on
 *              the expected commit.
 */
export type ReadinessMode = "config" | "live" | "predeploy" | "release";

export type VerdictKey =
  | "codeConfiguration"
  | "infrastructureReachable"
  | "liveProvidersVerified"
  | "predeployValidated"
  | "releaseAccepted";

export const VERDICT_ORDER: VerdictKey[] = [
  "codeConfiguration",
  "infrastructureReachable",
  "liveProvidersVerified",
  "predeployValidated",
  "releaseAccepted",
];

export const VERDICT_LABELS: Record<VerdictKey, string> = {
  codeConfiguration: "code/configuration ready",
  infrastructureReachable: "infrastructure reachable",
  liveProvidersVerified: "live providers verified",
  predeployValidated: "PRE-DEPLOY VALIDATED",
  releaseAccepted: "RELEASE ACCEPTED",
};

export type VerdictState = "accepted" | "refused" | "not-evaluated";

export interface ReadinessCheck {
  name: string;
  /** Which of the four verdicts this check is evidence for. */
  verdict: VerdictKey;
  category: string;
  status: CheckStatus;
  /** A failing mandatory check refuses its verdict. */
  mandatory: boolean;
  detail: string;
  /** Variable NAMES only — never values. */
  missingVars?: string[];
}

export interface VerdictOutcome {
  key: VerdictKey;
  label: string;
  state: VerdictState;
  /** Names of the mandatory checks that refused this verdict. */
  blocking: string[];
  reason: string;
}

export interface ReadinessReport {
  mode: ReadinessMode;
  nodeEnv: string | null;
  expectedSha: string | null;
  checks: ReadinessCheck[];
  verdicts: Record<VerdictKey, VerdictOutcome>;
  /** 0 only when every verdict the mode asked for was accepted. */
  exitCode: number;
  /** One line, always qualified. Never a bare "READY". */
  headline: string;
}

/** Which verdicts a mode actually evaluates. */
export function verdictsEvaluatedIn(mode: ReadinessMode): Set<VerdictKey> {
  if (mode === "config") return new Set<VerdictKey>(["codeConfiguration"]);
  if (mode === "live") {
    return new Set<VerdictKey>(["codeConfiguration", "infrastructureReachable", "liveProvidersVerified"]);
  }
  if (mode === "predeploy") {
    // Deliberately NOT releaseAccepted: migrations are still pending and the
    // running services are still the OLD build. Asking for those here is the
    // circularity this split exists to remove.
    return new Set<VerdictKey>([
      "codeConfiguration",
      "infrastructureReachable",
      "liveProvidersVerified",
      "predeployValidated",
    ]);
  }
  // release: everything that is only true AFTER the deploy.
  return new Set<VerdictKey>([
    "codeConfiguration",
    "infrastructureReachable",
    "liveProvidersVerified",
    "releaseAccepted",
  ]);
}

/**
 * A bare "READY" is a claim this tool must never make: it collapses four
 * independent verdicts into one word. Only two qualified forms are legitimate —
 * `CONFIGURATION-READY` (explicitly scoped) and `NOT READY` (a refusal).
 * Anything else containing the token is a regression.
 */
export function containsUnqualifiedReady(text: string): boolean {
  const stripped = text.replace(/CONFIGURATION-READY/g, "").replace(/NOT READY/g, "");
  return /\bREADY\b/.test(stripped);
}

/* ------------------------------------------------------------------ */
/* 2. Secret hygiene                                                    */
/* ------------------------------------------------------------------ */

// Substring match, deliberately. An earlier `\b` after the alternation missed
// every name where the marker is not the last word — `S3_ACCESS_KEY_ID` being
// the one that matters here, since the S3 SDK echoes the access key id into
// `SignatureDoesNotMatch` errors. Over-redacting a non-secret is harmless; the
// report's contract is names and booleans, so no VALUE needs to survive.
const SECRET_NAME_RE = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|DSN|_URL$/i;

/**
 * Remove any live secret VALUE that managed to reach a rendered string.
 *
 * Probe errors are the realistic leak path: an SDK can echo a signature, a
 * connection string, or a whole request URL into `err.message`. Names and
 * booleans are the contract, so anything matching a secret-named variable's
 * value is replaced with `<NAME:redacted>` before it can be printed or
 * serialized.
 */
export function scrubSecrets(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length < 6) continue;
    if (!SECRET_NAME_RE.test(name)) continue;
    if (!out.includes(trimmed)) continue;
    out = out.split(trimmed).join(`<${name}:redacted>`);
  }
  // Defensive: any credential embedded in a URL, whether or not we know the name.
  return out.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@/gi, "<redacted>://");
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ */
/* 3. Probe contracts                                                   */
/* ------------------------------------------------------------------ */

export interface SimpleProbeResult {
  ok: boolean;
  detail: string;
}

export type StorageProbeCode =
  | "ok"
  | "credentials_rejected"
  | "bucket_missing"
  | "access_denied"
  | "unreachable"
  | "error";

export interface StorageProbeResult {
  ok: boolean;
  code: StorageProbeCode;
  /** The authenticated operation actually performed, for the report. */
  operation: string;
  bucket: string;
  detail: string;
}

export interface StorageProbeInput {
  bucket: string;
  endpoint: string;
  region: string;
  /** Namespaced prefix so the probe can never enumerate real episode audio. */
  prefix: string;
}

export type WorkerHealthCode = "processed" | "timeout" | "error";

export interface WorkerHealthResult {
  /** True only when a worker actually took the job off the queue. */
  ok: boolean;
  code: WorkerHealthCode;
  queue: string;
  jobId: string;
  waitedMs: number;
  timeoutMs: number;
  /** Number of worker connections registered — context, never proof. */
  registeredWorkers: number;
  /** Release sha the PROCESSING worker echoed back, when it echoes one. */
  reportedSha: string | null;
  /** False when the job round-tripped but carried no version at all. */
  versionReported: boolean;
  detail: string;
}

export interface WorkerHealthInput {
  queue: string;
  timeoutMs: number;
}

export type LlmProbeCode = "ok" | "rejected" | "drifted" | "unroutable" | "error";

export interface LlmRouteProbeResult {
  ok: boolean;
  code: LlmProbeCode;
  role: string;
  /** provider/model the routing layer said it WOULD call. */
  requested: string;
  /** provider/model that actually served the call, from the cost ledger. */
  actual: string | null;
  detail: string;
}

export type CredentialProbeCode = "ok" | "rejected" | "unreachable" | "error";

export interface CredentialProbeResult {
  ok: boolean;
  code: CredentialProbeCode;
  /** HTTP status, when there was one. Never a body, never a header. */
  status: number | null;
  detail: string;
}

export interface BuildIdentityResult {
  sha: string | null;
  /** Where the sha came from: an HTTP build-info endpoint, or a local stamp. */
  source: string;
  detail: string;
}

/** Config facts that live in project modules rather than in raw env. */
export interface ReadinessResolvers {
  semanticQaRequirement: (env: NodeJS.ProcessEnv) => {
    required: boolean;
    enabled: boolean;
    missing: string[];
    provider: string;
    providerSupported: boolean;
  };
  editorialGateMode: (env: NodeJS.ProcessEnv) => string;
  gateEnforcementVar: string;
  gateEnforcementCutover: (env: NodeJS.ProcessEnv) => Date | null;
  /** Raw value presence only — used to tell "unset" from "unparseable". */
  gateEnforcementRawSet: (env: NodeJS.ProcessEnv) => boolean;
  llmRoutes: () => { writer: string; judge: string; judgeHasRealProvider: boolean };
  fishSceneModel: () => string;
}

/**
 * The migration PLAN, read before anything is applied.
 *
 * Pre-deploy must not demand that migrations are already applied — that is the
 * whole point of running it first. What it CAN prove is that the plan is safe:
 * the files are registered, nothing is half-applied from a previous attempt,
 * and the pending set is exactly what the operator expects to run.
 */
export interface MigrationPlanResult {
  ok: boolean;
  /** On disk but not yet applied. Non-empty is NORMAL before a deploy. */
  pending: string[];
  /** Recorded but never finished — a previous run died mid-migration. */
  failed: string[];
  /** Applied to the database but absent from the repo. */
  unknown: string[];
  detail: string;
}

export type CanaryVerificationCode =
  | "ok"
  | "no_run_for_sha"
  | "not_successful"
  | "stale"
  | "unverifiable"
  | "error";

/**
 * Evidence that the LIVE-PROVIDER CANARY passed for the EXACT commit being
 * deployed.
 *
 * This replaced an env-variable presence check. Requiring GitHub-only
 * `CANARY_*` secrets to exist inside the web and worker containers was a
 * category error: those secrets belong to the workflow, and copying them into
 * Coolify only to satisfy a container-side check would widen their blast radius
 * for no gain. What production actually needs is proof the run happened and
 * went green for this SHA.
 */
export interface CanaryVerificationResult {
  ok: boolean;
  code: CanaryVerificationCode;
  /** The commit the canary actually ran against. */
  sha: string | null;
  conclusion: string | null;
  runUrl: string | null;
  completedAt: string | null;
  ageHours: number | null;
  detail: string;
}

export interface ReadinessProbes {
  database: () => Promise<SimpleProbeResult>;
  redis: () => Promise<SimpleProbeResult>;
  migrations: () => Promise<SimpleProbeResult>;
  /** Pre-deploy view: what WOULD run, and whether that is safe. */
  migrationPlan: () => Promise<MigrationPlanResult>;
  /** Was the canary green for this exact commit? */
  canaryRun: (expectedSha: string) => Promise<CanaryVerificationResult>;
  storage: (input: StorageProbeInput) => Promise<StorageProbeResult>;
  workerHealth: (input: WorkerHealthInput) => Promise<WorkerHealthResult>;
  llmRoute: (role: "script_movement" | "quality_judge") => Promise<LlmRouteProbeResult>;
  transcription: (provider: string) => Promise<CredentialProbeResult>;
  ttsProvider: (provider: string) => Promise<CredentialProbeResult>;
  webBuildIdentity: () => Promise<BuildIdentityResult>;
}

export interface ReadinessDependencies {
  resolvers: ReadinessResolvers;
  probes: ReadinessProbes;
}

/* ------------------------------------------------------------------ */
/* 4. Policy constants                                                  */
/* ------------------------------------------------------------------ */

/**
 * The health job name. It is deliberately NOT one of the worker's real job
 * types: `processPodcastJob` returns `{success:false, error:"Unknown job type"}`
 * for an unrecognized name, which touches no database row and spends nothing —
 * so the round-trip is harmless TODAY, before any worker change.
 *
 * A worker.ts handler for this name (see docs/PRODUCTION_ROLLOUT.md §2) upgrades
 * the probe from "a worker consumed it" to "THIS worker, on THIS commit,
 * consumed it" by echoing WORKER_HEALTH_ECHO_KEYS.
 */
export const WORKER_HEALTH_JOB_NAME = "readiness:health-probe";
export const WORKER_HEALTH_JOB_ID_PREFIX = "readiness-health-";
export const WORKER_HEALTH_TIMEOUT_MS = 30_000;

/** Any of these keys on the job's return value is accepted as the worker's sha. */
export const WORKER_HEALTH_ECHO_KEYS = ["sourceCommit", "commit", "sha", "releaseSha"] as const;

/** Probe objects are namespaced so they can never collide with episode audio. */
export const STORAGE_PROBE_PREFIX = "_readiness-probe/";

/** Where an explicit release sha may be declared. */
export const EXPECTED_SHA_VAR = "EXPECTED_RELEASE_SHA";

/** Build-stamped commit variables, in preference order. */
export const COMMIT_SHA_VARS = [
  "SOURCE_COMMIT",
  "GIT_COMMIT_SHA",
  "COOLIFY_GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_SHA",
] as const;

export const STORAGE_VARS = ["S3_BUCKET", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;

/**
 * The canary's OWN secrets. These live in GitHub Actions and are consumed by
 * the workflow — they are listed here for the deployment checklist only, and
 * are deliberately NOT required to exist inside the web or worker containers.
 *
 * Copying them into Coolify purely to satisfy a container-side presence check
 * would widen their blast radius while proving nothing. What production needs
 * is evidence the canary RAN GREEN for the commit being shipped, which is what
 * `probes.canaryRun` verifies.
 */
export const CANARY_WORKFLOW_SECRETS = [
  "CANARY_LLM_PROVIDER",
  "CANARY_LLM_MODEL",
  "CANARY_JUDGE_PROVIDER",
  "CANARY_JUDGE_MODEL",
  "ANTHROPIC_API_KEY",
  "FISH_API_KEY",
  "ELEVENLABS_API_KEY",
  "CANARY_FISH_VOICE_A",
  "CANARY_FISH_VOICE_B",
  "CANARY_ELEVENLABS_VOICE_A",
  "CANARY_ELEVENLABS_VOICE_B",
  "DEEPGRAM_API_KEY",
] as const;

/**
 * A READ-ONLY GitHub token used solely to look up the canary's workflow run.
 * Minimum permission: `actions: read` on this repository (a fine-grained PAT
 * with "Actions: Read-only", or the workflow's own GITHUB_TOKEN when the check
 * runs inside Actions). It never needs write access to anything.
 */
export const CANARY_READ_TOKEN_VAR = "CANARY_READ_GITHUB_TOKEN";

/** Repository the canary runs in, `owner/name`. */
export const CANARY_REPO_VAR = "CANARY_GITHUB_REPO";

/** Workflow file whose run must be green. */
export const CANARY_WORKFLOW_VAR = "CANARY_WORKFLOW_FILE";

/** A green canary older than this is stale evidence, not evidence. */
export const CANARY_MAX_AGE_HOURS = 72;

/** Operator's recorded backup identifier. Checked, never inspected. */
export const BACKUP_CONFIRMED_VAR = "DEPLOY_BACKUP_REFERENCE";

/** Which variable carries each TTS provider's credential. Names only. */
export const TTS_CREDENTIAL_VARS: Record<string, string> = {
  fish: "FISH_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  cartesia: "CARTESIA_API_KEY",
  openai: "OPENAI_API_KEY",
  boson: "BOSON_API_KEY",
};

/**
 * EVERY TTS provider production must be able to reach — not just Fish.
 *
 * The canary contract (`CANARY_REQUIRED_PROVIDERS`, default `fish,elevenlabs`)
 * is the existing declaration of which engines a release is expected to render
 * on, so it is the source of truth here rather than a second, drifting list.
 * The deployment's own default engine (`TTS_PROVIDER`) is added on top: an
 * engine the pipeline will actually select must also be provably reachable.
 */
export function requiredTtsProviders(env: NodeJS.ProcessEnv): string[] {
  const raw = (env.PRODUCTION_REQUIRED_TTS_PROVIDERS || env.CANARY_REQUIRED_PROVIDERS || "fish,elevenlabs").trim();
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const configured = (env.TTS_PROVIDER || "").trim().toLowerCase();
  if (configured && configured !== "stub") set.add(configured);
  return [...set].sort();
}

/* ------------------------------------------------------------------ */
/* 5. Pure classifiers (unit-testable without a network)                */
/* ------------------------------------------------------------------ */

/**
 * Turn an S3 SDK failure into a verdict an operator can act on.
 *
 * The distinction that matters: "the endpoint answered" is worthless, while
 * "the endpoint answered and REJECTED these credentials" and "…and this bucket
 * does not exist" are two different repairs.
 */
export function classifyStorageError(name: string, httpStatus: number | null): StorageProbeCode {
  const n = (name || "").toLowerCase();
  if (n.includes("nosuchbucket") || n.includes("notfound") || httpStatus === 404) return "bucket_missing";
  if (
    n.includes("invalidaccesskeyid") ||
    n.includes("signaturedoesnotmatch") ||
    n.includes("invalidtoken") ||
    n.includes("expiredtoken") ||
    n.includes("unrecognizedclient") ||
    httpStatus === 401
  ) {
    return "credentials_rejected";
  }
  if (n.includes("accessdenied") || n.includes("forbidden") || httpStatus === 403) return "access_denied";
  if (
    n.includes("econnrefused") ||
    n.includes("enotfound") ||
    n.includes("etimedout") ||
    n.includes("networkingerror") ||
    n.includes("timeouterror")
  ) {
    return "unreachable";
  }
  return "error";
}

/** HTTP status → credential verdict, for the provider probes. */
export function classifyCredentialStatus(status: number): CredentialProbeCode {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403 || status === 402) return "rejected";
  if (status >= 500) return "unreachable";
  return "error";
}

/**
 * Two shas are the same release when one is a prefix of the other and the
 * shared prefix is long enough to be unambiguous. Git's own abbreviation is 7.
 */
export function shaMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a || "").trim().toLowerCase();
  const y = (b || "").trim().toLowerCase();
  if (!x || !y) return false;
  const shortest = Math.min(x.length, y.length);
  if (shortest < 7) return false;
  return x.slice(0, shortest) === y.slice(0, shortest);
}

export function shortSha(sha: string | null | undefined): string {
  const s = (sha || "").trim();
  return s ? s.slice(0, 12) : "(none)";
}

/* ------------------------------------------------------------------ */
/* 6. Pure evaluation                                                   */
/* ------------------------------------------------------------------ */

export interface EvaluateReadinessInput {
  mode: ReadinessMode;
  env: NodeJS.ProcessEnv;
  deps: ReadinessDependencies;
  /** The sha this release is CLAIMED to be. Required by --release. */
  expectedSha?: string | null;
  workerTimeoutMs?: number;
}

function present(env: NodeJS.ProcessEnv, name: string): boolean {
  return Boolean((env[name] || "").trim());
}

function missingOf(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  return names.filter((n) => !present(env, n));
}

export async function evaluateReadiness(input: EvaluateReadinessInput): Promise<ReadinessReport> {
  const { mode, env, deps } = input;
  const expectedSha = (input.expectedSha || env[EXPECTED_SHA_VAR] || "").trim() || null;
  const workerTimeoutMs = input.workerTimeoutMs ?? WORKER_HEALTH_TIMEOUT_MS;
  const evaluated = verdictsEvaluatedIn(mode);
  const isProd = env.NODE_ENV === "production";
  const checks: ReadinessCheck[] = [];
  const add = (c: ReadinessCheck) => checks.push(c);

  /* --- VERDICT 1: code / configuration ---------------------------- */

  for (const v of ["DATABASE_URL", "REDIS_URL"] as const) {
    add({
      name: `${v} configured`,
      verdict: "codeConfiguration",
      category: "infrastructure",
      status: present(env, v) ? "pass" : "fail",
      mandatory: true,
      detail: present(env, v) ? `${v} is set.` : `${v} is not set.`,
      missingVars: present(env, v) ? undefined : [v],
    });
  }

  const llmMissing = missingOf(env, ["ANTHROPIC_API_KEY"]);
  add({
    name: "LLM credential present",
    verdict: "codeConfiguration",
    category: "llm",
    status: llmMissing.length ? "fail" : "pass",
    mandatory: true,
    detail: llmMissing.length
      ? "No LLM credential configured; no script can be written. (Presence only — this proves nothing about the key working; --live does that.)"
      : "ANTHROPIC_API_KEY is set. Presence only; --live proves it is accepted.",
    missingVars: llmMissing.length ? llmMissing : undefined,
  });

  try {
    const routes = deps.resolvers.llmRoutes();
    const separate = Boolean(routes.writer && routes.judge && routes.writer !== routes.judge);
    add({
      name: "Independent judge routed separately from writer",
      verdict: "codeConfiguration",
      category: "llm",
      status: separate ? "pass" : "fail",
      mandatory: true,
      detail: `writer=${routes.writer || "unresolved"} judge=${routes.judge || "unresolved"}${
        routes.writer === routes.judge ? " — identical routes defeat independent judging." : ""
      }`,
    });
    add({
      name: "Quality judge has a real provider",
      verdict: "codeConfiguration",
      category: "quality-gates",
      status: routes.judgeHasRealProvider ? "pass" : "fail",
      mandatory: true,
      detail: routes.judgeHasRealProvider
        ? "quality_judge resolves to a real provider."
        : "quality_judge resolves to a stub. A missing judge is a HOLD in production, so every script would stall.",
    });
  } catch (err) {
    add({
      name: "Production model routing",
      verdict: "codeConfiguration",
      category: "llm",
      status: "fail",
      mandatory: true,
      detail: `Routing could not be resolved: ${errText(err)}`,
    });
  }

  // Semantic transcript QA — configuration half. The credential half is a live
  // probe; a set DEEPGRAM_API_KEY has never proven anything on its own.
  try {
    const req = deps.resolvers.semanticQaRequirement(env);
    const waived = (env.TTS_TRANSCRIPT_QA_WAIVED || "").trim() === "true";
    if (waived) {
      add({
        name: "Semantic transcript QA configured",
        verdict: "codeConfiguration",
        category: "quality-gates",
        status: "fail",
        mandatory: true,
        detail:
          "TTS_TRANSCRIPT_QA_WAIVED=true. A waiver is not production semantic QA — it disables the only check " +
          "that verifies speaker attribution, names and numbers on rendered audio.",
      });
    } else if (req.missing.length) {
      add({
        name: "Semantic transcript QA configured",
        verdict: "codeConfiguration",
        category: "quality-gates",
        status: "fail",
        mandatory: true,
        detail: "Meaning-aware audio QA cannot run. In production it fails closed, so final audio stitching WILL stop.",
        missingVars: req.missing,
      });
    } else {
      add({
        name: "Semantic transcript QA configured",
        verdict: "codeConfiguration",
        category: "quality-gates",
        status: "pass",
        mandatory: true,
        detail: `Enabled, provider=${req.provider}. Credential presence only; --live proves it is accepted.`,
      });
    }
  } catch (err) {
    add({
      name: "Semantic transcript QA configured",
      verdict: "codeConfiguration",
      category: "quality-gates",
      status: "fail",
      mandatory: true,
      detail: errText(err),
    });
  }

  try {
    const gateMode = deps.resolvers.editorialGateMode(env);
    add({
      name: "Editorial gate is enforcing",
      verdict: "codeConfiguration",
      category: "quality-gates",
      status: gateMode === "hold" ? "pass" : isProd ? "fail" : "warn",
      mandatory: isProd,
      detail: `SCRIPT_EDITORIAL_GATE_MODE resolves to "${gateMode}". Production must resolve to "hold".`,
    });
  } catch (err) {
    add({
      name: "Editorial gate is enforcing",
      verdict: "codeConfiguration",
      category: "quality-gates",
      status: "fail",
      mandatory: true,
      detail: errText(err),
    });
  }

  try {
    const cutover = deps.resolvers.gateEnforcementCutover(env);
    const rawSet = deps.resolvers.gateEnforcementRawSet(env);
    const varName = deps.resolvers.gateEnforcementVar;
    if (cutover) {
      add({
        name: "Editorial-gate rollout cutover set",
        verdict: "codeConfiguration",
        category: "quality-gates",
        status: "pass",
        mandatory: true,
        detail: `Scripts created before ${cutover.toISOString()} may finish without a verdict, attributably.`,
      });
    } else {
      add({
        name: "Editorial-gate rollout cutover set",
        verdict: "codeConfiguration",
        category: "quality-gates",
        status: "fail",
        mandatory: true,
        detail: rawSet
          ? `${varName} is set but is not a parseable ISO 8601 instant.`
          : `${varName} is unset, so NO pre-existing script is grandfathered and any script written before this deploy will be refused at the TTS boundary.`,
        missingVars: [varName],
      });
    }
  } catch (err) {
    add({
      name: "Editorial-gate rollout cutover set",
      verdict: "codeConfiguration",
      category: "quality-gates",
      status: "fail",
      mandatory: true,
      detail: errText(err),
    });
  }

  const activeWaivers = ["SCRIPT_EDITORIAL_HOLD_OVERRIDE", "TTS_TRANSCRIPT_QA_WAIVED"].filter(
    (v) => (env[v] || "").trim() === "true"
  );
  add({
    name: "No global quality waiver in force",
    verdict: "codeConfiguration",
    category: "quality-gates",
    status: activeWaivers.length ? "fail" : "pass",
    mandatory: true,
    detail: activeWaivers.length
      ? `Global waiver(s) active: ${activeWaivers.join(", ")}. Quality gates must not be disabled process-wide.`
      : "No global waiver set.",
    missingVars: activeWaivers.length ? activeWaivers : undefined,
  });

  // TTS — EVERY provider production requires, not only Fish.
  const ttsProviders = requiredTtsProviders(env);
  for (const provider of ttsProviders) {
    const varName = TTS_CREDENTIAL_VARS[provider];
    if (!varName) {
      add({
        name: `TTS credential present: ${provider}`,
        verdict: "codeConfiguration",
        category: "tts",
        status: "fail",
        mandatory: true,
        detail: `"${provider}" is required by policy but this preflight knows no credential variable for it. Add it to TTS_CREDENTIAL_VARS or remove it from the required set.`,
      });
      continue;
    }
    const ok = present(env, varName);
    add({
      name: `TTS credential present: ${provider}`,
      verdict: "codeConfiguration",
      category: "tts",
      status: ok ? "pass" : "fail",
      mandatory: true,
      detail: ok
        ? `${varName} is set. Presence only; --live proves it is accepted.`
        : `${varName} is not set, so production cannot render on "${provider}".`,
      missingVars: ok ? undefined : [varName],
    });
  }

  try {
    const model = deps.resolvers.fishSceneModel();
    add({
      name: "Fish scene model policy",
      verdict: "codeConfiguration",
      category: "tts",
      status: model === "s2.1-pro-free" ? "pass" : "warn",
      mandatory: false,
      detail: `Resolved scene model is "${model}". Policy default is s2.1-pro-free; anything else must be a deliberate operator override.`,
    });
  } catch (err) {
    add({
      name: "Fish scene model policy",
      verdict: "codeConfiguration",
      category: "tts",
      status: "warn",
      mandatory: false,
      detail: errText(err),
    });
  }

  const storageMissing = missingOf(env, STORAGE_VARS);
  add({
    name: "Object storage configured",
    verdict: "codeConfiguration",
    category: "storage",
    status: storageMissing.length ? "fail" : "pass",
    mandatory: true,
    detail: storageMissing.length
      ? "Storage credentials incomplete."
      : "All storage variables set. Presence only; --live performs an authenticated bucket operation.",
    missingVars: storageMissing.length ? storageMissing : undefined,
  });

  /* --- VERDICT 2: infrastructure reachable ------------------------ */

  let workerHealth: WorkerHealthResult | null = null;

  if (!evaluated.has("infrastructureReachable")) {
    add({
      name: "Infrastructure probes",
      verdict: "infrastructureReachable",
      category: "infrastructure",
      status: "skip",
      mandatory: false,
      detail: `Not evaluated in ${mode} mode. Nothing here has been proven reachable. Re-run with --live or --release from inside the deployment.`,
    });
  } else {
    // PRE-DEPLOY reads the migration PLAN; RELEASE requires them applied. Asking
    // pre-deploy for "migrations applied" is the circularity this split removes.
    if (mode === "predeploy") {
      try {
        const plan = await deps.probes.migrationPlan();
        const blocking = plan.failed.length > 0 || plan.unknown.length > 0;
        add({
          name: "Migration plan is safe to apply",
          verdict: "infrastructureReachable",
          category: "migrations",
          status: blocking || !plan.ok ? "fail" : "pass",
          mandatory: true,
          detail: blocking
            ? `${plan.failed.length} half-applied and ${plan.unknown.length} unknown migration(s) — resolve before deploying. ${plan.detail}`
            : `${plan.pending.length} migration(s) will be applied by web's pre-deployment command: ${plan.pending.join(", ") || "none"}.`,
        });
      } catch (err) {
        add({
          name: "Migration plan is safe to apply",
          verdict: "infrastructureReachable",
          category: "migrations",
          status: "fail",
          mandatory: true,
          detail: errText(err),
        });
      }
    }

    for (const [name, probe] of ([
      ["Database reachable", deps.probes.database],
      ["Redis reachable", deps.probes.redis],
      ...(mode === "predeploy" ? [] : [["Migrations applied", deps.probes.migrations] as const]),
    ] as ReadonlyArray<readonly [string, () => Promise<SimpleProbeResult>]>)) {
      try {
        const r = await probe();
        add({
          name,
          verdict: "infrastructureReachable",
          category: name === "Migrations applied" ? "migrations" : "infrastructure",
          status: r.ok ? "pass" : "fail",
          mandatory: true,
          detail: r.detail,
        });
      } catch (err) {
        add({
          name,
          verdict: "infrastructureReachable",
          category: "infrastructure",
          status: "fail",
          mandatory: true,
          detail: errText(err),
        });
      }
    }

    // OBJECT STORAGE — an AUTHENTICATED, read-only operation against the
    // CONFIGURED BUCKET. The old check called any HTTP reply proof; it could not
    // tell a working bucket from a rejected key or a bucket that never existed.
    if (storageMissing.length) {
      add({
        name: "Object storage authenticated",
        verdict: "infrastructureReachable",
        category: "storage",
        status: "fail",
        mandatory: true,
        detail: "Cannot probe: storage variables are incomplete.",
        missingVars: storageMissing,
      });
    } else {
      try {
        const r = await deps.probes.storage({
          bucket: (env.S3_BUCKET || "").trim(),
          endpoint: (env.S3_ENDPOINT || "").trim(),
          region: (env.S3_REGION || env.AWS_REGION || "us-east-1").trim(),
          prefix: STORAGE_PROBE_PREFIX,
        });
        add({
          name: "Object storage authenticated",
          verdict: "infrastructureReachable",
          category: "storage",
          status: r.ok ? "pass" : "fail",
          mandatory: true,
          detail: `${r.operation} on bucket "${r.bucket}" → ${r.code}. ${r.detail}`,
        });
      } catch (err) {
        add({
          name: "Object storage authenticated",
          verdict: "infrastructureReachable",
          category: "storage",
          status: "fail",
          mandatory: true,
          detail: errText(err),
        });
      }
    }

    // WORKER — a real job round-trip. A registered connection is not a consumer.
    try {
      workerHealth = await deps.probes.workerHealth({
        queue: (env.PRODUCTION_QUEUE_NAME || "podcast-production").trim(),
        timeoutMs: workerTimeoutMs,
      });
      add({
        name: "Worker consumes the production queue",
        verdict: "infrastructureReachable",
        category: "queue",
        status: workerHealth.ok ? "pass" : "fail",
        mandatory: true,
        detail: workerHealth.ok
          ? `Health job ${workerHealth.jobId} was processed in ${workerHealth.waitedMs}ms (${workerHealth.registeredWorkers} worker connection(s) registered).`
          : `Health job ${workerHealth.jobId} was NOT processed within ${workerHealth.timeoutMs}ms on "${workerHealth.queue}" ` +
            `even though ${workerHealth.registeredWorkers} worker connection(s) are registered. A registered connection is not a consumer — jobs would queue forever. ${workerHealth.detail}`,
      });
    } catch (err) {
      add({
        name: "Worker consumes the production queue",
        verdict: "infrastructureReachable",
        category: "queue",
        status: "fail",
        mandatory: true,
        detail: errText(err),
      });
    }
  }

  /* --- VERDICT 3: live providers verified ------------------------- */

  if (!evaluated.has("liveProvidersVerified")) {
    add({
      name: "Live provider probes",
      verdict: "liveProvidersVerified",
      category: "providers",
      status: "skip",
      mandatory: false,
      detail: `Not evaluated in ${mode} mode. No credential has been exercised; only NAMES were checked. Re-run with --live or --release.`,
    });
  } else {
    for (const role of ["script_movement", "quality_judge"] as const) {
      const label = role === "script_movement" ? "writer" : "independent judge";
      try {
        const r = await deps.probes.llmRoute(role);
        add({
          name: `LLM ${label} route answered an authenticated call`,
          verdict: "liveProvidersVerified",
          category: "llm",
          status: r.ok ? "pass" : "fail",
          mandatory: true,
          detail: `role=${r.role} requested=${r.requested} actual=${r.actual ?? "(none)"} → ${r.code}. ${r.detail}`,
        });
      } catch (err) {
        add({
          name: `LLM ${label} route answered an authenticated call`,
          verdict: "liveProvidersVerified",
          category: "llm",
          status: "fail",
          mandatory: true,
          detail: errText(err),
        });
      }
    }

    const qaProvider = (() => {
      try {
        return deps.resolvers.semanticQaRequirement(env).provider;
      } catch {
        return "openai";
      }
    })();
    try {
      const r = await deps.probes.transcription(qaProvider);
      add({
        name: `Semantic QA credential accepted (${qaProvider})`,
        verdict: "liveProvidersVerified",
        category: "quality-gates",
        status: r.ok ? "pass" : "fail",
        mandatory: true,
        detail: `Authenticated probe → ${r.code}${r.status !== null ? ` (HTTP ${r.status})` : ""}. ${r.detail}`,
      });
    } catch (err) {
      add({
        name: `Semantic QA credential accepted (${qaProvider})`,
        verdict: "liveProvidersVerified",
        category: "quality-gates",
        status: "fail",
        mandatory: true,
        detail: errText(err),
      });
    }

    for (const provider of ttsProviders) {
      try {
        const r = await deps.probes.ttsProvider(provider);
        add({
          name: `TTS credential accepted: ${provider}`,
          verdict: "liveProvidersVerified",
          category: "tts",
          status: r.ok ? "pass" : "fail",
          mandatory: true,
          detail: `Authenticated probe → ${r.code}${r.status !== null ? ` (HTTP ${r.status})` : ""}. ${r.detail}`,
        });
      } catch (err) {
        add({
          name: `TTS credential accepted: ${provider}`,
          verdict: "liveProvidersVerified",
          category: "tts",
          status: "fail",
          mandatory: true,
          detail: errText(err),
        });
      }
    }
  }

  /* --- VERDICT 4: release accepted -------------------------------- */

  /* --- VERDICT 4: PRE-DEPLOY VALIDATED ---------------------------- */

  if (evaluated.has("predeployValidated")) {
    // (a) The operator must name the commit being shipped. Everything else in
    //     this phase is checked AGAINST that commit.
    add({
      name: "Expected release sha supplied",
      verdict: "predeployValidated",
      category: "deployment",
      status: expectedSha ? "pass" : "fail",
      mandatory: true,
      detail: expectedSha
        ? `Validating against ${expectedSha.slice(0, 12)}.`
        : `Pass --expect-sha <sha> (or set ${EXPECTED_SHA_VAR}). Without it there is nothing to validate the canary or the deploy against.`,
      missingVars: expectedSha ? undefined : [EXPECTED_SHA_VAR],
    });

    // (b) A GREEN CANARY FOR THIS EXACT COMMIT. Not "the canary is configured",
    //     and not "a canary passed once" — this commit, successfully, recently.
    if (!expectedSha) {
      add({
        name: "Live-provider canary is green for this commit",
        verdict: "predeployValidated",
        category: "canary",
        status: "fail",
        mandatory: true,
        detail: "Cannot verify a canary without an expected sha.",
      });
    } else {
      try {
        const canary = await deps.probes.canaryRun(expectedSha);
        add({
          name: "Live-provider canary is green for this commit",
          verdict: "predeployValidated",
          category: "canary",
          status: canary.ok ? "pass" : "fail",
          mandatory: true,
          detail: canary.detail,
          missingVars: canary.code === "unverifiable" ? [CANARY_READ_TOKEN_VAR] : undefined,
        });
      } catch (err) {
        add({
          name: "Live-provider canary is green for this commit",
          verdict: "predeployValidated",
          category: "canary",
          status: "fail",
          mandatory: true,
          detail: errText(err),
        });
      }
    }

    // (c) A BACKUP. Additive migrations are still migrations, and this is the
    //     only rollback for a data mistake. It is an explicit acknowledgement
    //     rather than something this tool can detect.
    const backup = (env[BACKUP_CONFIRMED_VAR] || "").trim();
    add({
      name: "Database backup confirmed",
      verdict: "predeployValidated",
      category: "deployment",
      status: backup ? "pass" : "fail",
      mandatory: true,
      detail: backup
        ? `Operator recorded a backup reference: ${backup.slice(0, 60)}.`
        : `Take a backup (Coolify snapshot or pg_dump), then set ${BACKUP_CONFIRMED_VAR} to its identifier. Four additive migrations are pending; a backup is the only remedy for a data mistake.`,
      missingVars: backup ? undefined : [BACKUP_CONFIRMED_VAR],
    });
  } else {
    add({
      name: "Pre-deploy validation",
      verdict: "predeployValidated",
      category: "deployment",
      status: "skip",
      mandatory: false,
      detail: `Not evaluated in ${mode} mode. Run \`npm run verify:predeploy -- --expect-sha <sha>\` BEFORE deploying.`,
    });
  }

  if (!evaluated.has("releaseAccepted")) {
    add({
      name: "Release commit identity",
      verdict: "releaseAccepted",
      category: "deployment",
      status: "skip",
      mandatory: false,
      detail: `Not evaluated in ${mode} mode. No release has been accepted. Re-run with --release --expect-sha <sha>.`,
    });
  } else {
    add({
      name: "Expected release sha supplied",
      verdict: "releaseAccepted",
      category: "deployment",
      status: expectedSha ? "pass" : "fail",
      mandatory: true,
      detail: expectedSha
        ? `Expecting ${shortSha(expectedSha)}. (A commit sha is public information, not a secret.)`
        : `No expected sha. Pass --expect-sha <sha> or set ${EXPECTED_SHA_VAR}. Finding "some sha-ish variable" proves nothing about WHICH commit is deployed.`,
      missingVars: expectedSha ? undefined : [EXPECTED_SHA_VAR],
    });

    let webSha: string | null = null;
    try {
      const identity = await deps.probes.webBuildIdentity();
      webSha = identity.sha;
      const ok = Boolean(expectedSha && shaMatches(identity.sha, expectedSha));
      add({
        name: "Web running the expected release",
        verdict: "releaseAccepted",
        category: "deployment",
        status: ok ? "pass" : "fail",
        mandatory: true,
        detail: `web=${shortSha(identity.sha)} expected=${shortSha(expectedSha)} via ${identity.source}. ${
          ok ? "Match." : "MISMATCH — web is not running the commit this release claims to be."
        } ${identity.detail}`,
      });
    } catch (err) {
      add({
        name: "Web running the expected release",
        verdict: "releaseAccepted",
        category: "deployment",
        status: "fail",
        mandatory: true,
        detail: errText(err),
      });
    }

    const workerSha = workerHealth?.reportedSha ?? null;
    if (!workerHealth) {
      add({
        name: "Worker running the expected release",
        verdict: "releaseAccepted",
        category: "deployment",
        status: "fail",
        mandatory: true,
        detail: "The worker health round-trip did not run, so the worker's commit is unknown.",
      });
    } else if (!workerHealth.ok) {
      add({
        name: "Worker running the expected release",
        verdict: "releaseAccepted",
        category: "deployment",
        status: "fail",
        mandatory: true,
        detail: "The worker never processed the health job, so no worker reported a release version.",
      });
    } else if (!workerHealth.versionReported) {
      add({
        name: "Worker running the expected release",
        verdict: "releaseAccepted",
        category: "deployment",
        status: "fail",
        mandatory: true,
        detail:
          `A worker consumed the health job but reported no release version. Add a "${WORKER_HEALTH_JOB_NAME}" handler in ` +
          `src/lib/queue/worker.ts returning { ${WORKER_HEALTH_ECHO_KEYS[0]}: process.env.SOURCE_COMMIT }. ` +
          "Until then the worker's commit cannot be proven and a release must not be accepted.",
      });
    } else {
      const ok = Boolean(expectedSha && shaMatches(workerSha, expectedSha));
      add({
        name: "Worker running the expected release",
        verdict: "releaseAccepted",
        category: "deployment",
        status: ok ? "pass" : "fail",
        mandatory: true,
        detail: `worker=${shortSha(workerSha)} expected=${shortSha(expectedSha)}. ${
          ok ? "Match." : "MISMATCH — the worker that consumed the job is on a different commit."
        }`,
      });
    }

    const agree = shaMatches(webSha, workerSha);
    add({
      name: "Web and worker agree on the release",
      verdict: "releaseAccepted",
      category: "deployment",
      status: agree ? "pass" : "fail",
      mandatory: true,
      detail: agree
        ? `Both report ${shortSha(webSha)}.`
        : `web=${shortSha(webSha)} worker=${shortSha(workerSha)} — a split deployment. One service is enforcing different gates than the other.`,
    });
  }

  /* --- Verdict rollup --------------------------------------------- */

  const verdicts = {} as Record<VerdictKey, VerdictOutcome>;
  for (const key of VERDICT_ORDER) {
    if (!evaluated.has(key)) {
      verdicts[key] = {
        key,
        label: VERDICT_LABELS[key],
        state: "not-evaluated",
        blocking: [],
        reason: `Not evaluated in ${mode} mode.`,
      };
      continue;
    }
    const blocking = checks.filter((c) => c.verdict === key && c.mandatory && c.status === "fail").map((c) => c.name);
    if (blocking.length) {
      verdicts[key] = {
        key,
        label: VERDICT_LABELS[key],
        state: "refused",
        blocking,
        reason: `${blocking.length} mandatory check(s) failed.`,
      };
    } else {
      verdicts[key] = { key, label: VERDICT_LABELS[key], state: "accepted", blocking: [], reason: "All mandatory checks passed." };
    }
  }

  // A release is accepted only when EVERY prerequisite verdict was accepted.
  // Inheriting "not-evaluated" as acceptance is exactly the collapse this
  // rewrite exists to prevent.
  if (evaluated.has("releaseAccepted") && verdicts.releaseAccepted.state === "accepted") {
    // Only verdicts THIS MODE evaluated can be prerequisites. `predeployValidated`
    // is deliberately not evaluated during release — it was proven in the
    // earlier phase, against a world that no longer exists — so treating its
    // "not-evaluated" as a refusal would make release permanently unreachable.
    const unmet = VERDICT_ORDER.filter(
      (k) => k !== "releaseAccepted" && evaluated.has(k) && verdicts[k].state !== "accepted"
    );
    if (unmet.length) {
      verdicts.releaseAccepted = {
        key: "releaseAccepted",
        label: VERDICT_LABELS.releaseAccepted,
        state: "refused",
        blocking: unmet.map((k) => VERDICT_LABELS[k]),
        reason: `Prerequisite verdict(s) not accepted: ${unmet.map((k) => VERDICT_LABELS[k]).join(", ")}.`,
      };
    }
  }

  const refused = VERDICT_ORDER.filter((k) => verdicts[k].state === "refused");
  const exitCode = refused.length ? 1 : 0;

  return {
    mode,
    nodeEnv: env.NODE_ENV || null,
    expectedSha,
    checks,
    verdicts,
    exitCode,
    headline: headlineFor(mode, verdicts),
  };
}

/**
 * The one-line verdict. Every form is explicitly scoped, so `--skip-live` (and
 * default mode) can never emit an unqualified READY: the strongest thing the
 * config mode can say is CONFIGURATION-READY, and it says in the same breath
 * that nothing else was verified.
 */
export function headlineFor(mode: ReadinessMode, verdicts: Record<VerdictKey, VerdictOutcome>): string {
  const refused = VERDICT_ORDER.filter((k) => verdicts[k].state === "refused");
  if (refused.length) {
    return `NOT READY — refused: ${refused.map((k) => VERDICT_LABELS[k]).join(", ")}`;
  }
  if (mode === "release") return "RELEASE ACCEPTED — all four verdicts accepted.";
  const unproven = VERDICT_ORDER.filter((k) => verdicts[k].state === "not-evaluated").map((k) => VERDICT_LABELS[k]);
  if (mode === "live") {
    return `INFRASTRUCTURE AND LIVE PROVIDERS VERIFIED — but NOT a release: ${unproven.join(", ")} not evaluated.`;
  }
  return `CONFIGURATION-READY — nothing else is proven: ${unproven.join(", ")} not evaluated.`;
}

/* ------------------------------------------------------------------ */
/* 7. Rendering                                                         */
/* ------------------------------------------------------------------ */

/** Machine-readable form. Every string passes through the secret scrubber. */
export function serializeReport(report: ReadinessReport, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const clean = (s: string) => scrubSecrets(s, env);
  return {
    mode: report.mode,
    nodeEnv: report.nodeEnv,
    expectedSha: report.expectedSha,
    verdicts: VERDICT_ORDER.map((k) => ({
      key: k,
      label: report.verdicts[k].label,
      state: report.verdicts[k].state,
      blocking: report.verdicts[k].blocking.map(clean),
      reason: clean(report.verdicts[k].reason),
    })),
    headline: clean(report.headline),
    exitCode: report.exitCode,
    checks: report.checks.map((c) => ({
      // Names are authored constants, but they interpolate provider ids that
      // come from the environment, so they go through the scrubber too. Every
      // string that reaches an output stream is scrubbed — no exceptions.
      name: clean(c.name),
      verdict: c.verdict,
      category: c.category,
      status: c.status,
      mandatory: c.mandatory,
      detail: clean(c.detail),
      // NAMES only. A missing-variable list is the whole point of this report.
      missingVars: c.missingVars,
    })),
  };
}

/** Human-readable form. Same scrubbing, same four verdicts, never collapsed. */
export function renderReport(report: ReadinessReport, env: NodeJS.ProcessEnv): string {
  const clean = (s: string) => scrubSecrets(s, env);
  const lines: string[] = [];
  lines.push("");
  lines.push("==========================================================");
  lines.push(" PRODUCTION READINESS PREFLIGHT");
  lines.push(` mode=${report.mode}   NODE_ENV=${report.nodeEnv || "(unset)"}`);
  lines.push("==========================================================");
  lines.push("");

  let category = "";
  for (const c of report.checks) {
    if (c.category !== category) {
      category = c.category;
      lines.push(`  ${category.toUpperCase()}`);
    }
    const icon =
      c.status === "pass" ? "PASS" : c.status === "fail" ? (c.mandatory ? "FAIL" : "warn") : c.status === "warn" ? "warn" : "skip";
    lines.push(`    [${icon}] ${clean(c.name)}`);
    if (c.detail) lines.push(`           ${clean(c.detail)}`);
    if (c.missingVars?.length) lines.push(`           missing: ${c.missingVars.join(", ")}`);
  }

  lines.push("");
  lines.push("----------------------------------------------------------");
  lines.push(" FOUR INDEPENDENT VERDICTS");
  for (const key of VERDICT_ORDER) {
    const v = report.verdicts[key];
    const state =
      v.state === "accepted" ? "ACCEPTED" : v.state === "refused" ? "REFUSED " : "NOT EVALUATED";
    lines.push(`   ${state.padEnd(14)} ${v.label}`);
    lines.push(`                  ${clean(v.reason)}`);
    for (const b of v.blocking) lines.push(`                    - ${clean(b)}`);
  }
  lines.push("----------------------------------------------------------");
  lines.push(` ${clean(report.headline)}`);
  lines.push("----------------------------------------------------------");
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 8. The real probes                                                   */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function liveDatabase(): Promise<SimpleProbeResult> {
  const { db } = await import("../db");
  await db.$queryRaw`SELECT 1`;
  return { ok: true, detail: "SELECT 1 succeeded." };
}

async function liveRedis(): Promise<SimpleProbeResult> {
  const { getRedisClient } = await import("../redis");
  const client = getRedisClient() as unknown as { ping: () => Promise<string> };
  const pong = await client.ping();
  return { ok: Boolean(pong), detail: `PING -> ${pong || "no reply"}` };
}

async function liveMigrations(): Promise<SimpleProbeResult> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.resolve(process.cwd(), "prisma/migrations");
  const onDisk = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory())
    : [];
  const { db } = await import("../db");
  const rows = await db.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null }>>(
    `SELECT migration_name, finished_at FROM "_prisma_migrations"`
  );
  const applied = new Set(rows.filter((r) => r.finished_at).map((r) => r.migration_name));
  const failed = rows.filter((r) => !r.finished_at).map((r) => r.migration_name);
  const pending = onDisk.filter((m) => !applied.has(m));
  if (failed.length) return { ok: false, detail: `Migrations recorded but never finished: ${failed.join(", ")}.` };
  if (pending.length) {
    return {
      ok: false,
      detail: `${pending.length} migration(s) on disk not applied: ${pending.join(", ")}. Run prisma migrate deploy on BOTH web and worker.`,
    };
  }
  return { ok: true, detail: `${applied.size} migration(s) applied; none pending.` };
}

/**
 * AUTHENTICATED, READ-ONLY, against the CONFIGURED BUCKET.
 *
 * `ListObjectsV2` with `MaxKeys=1` under a namespaced prefix is the smallest
 * operation that requires a valid signature AND an existing bucket, and it
 * writes nothing. Credentials are resolved exactly as `S3StorageProvider` does,
 * so a pass here means the pipeline's own client can talk to the same bucket.
 */
async function liveStorage(input: StorageProbeInput): Promise<StorageProbeResult> {
  const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: input.region,
    ...(input.endpoint ? { endpoint: input.endpoint, forcePathStyle: true } : {}),
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "",
    },
  });
  const operation = "ListObjectsV2 MaxKeys=1 (read-only, signed)";
  try {
    await client.send(new ListObjectsV2Command({ Bucket: input.bucket, MaxKeys: 1, Prefix: input.prefix }));
    return { ok: true, code: "ok", operation, bucket: input.bucket, detail: "Signed request accepted by the bucket." };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    const status = e.$metadata?.httpStatusCode ?? null;
    const code = classifyStorageError(e.name || errText(err), status);
    return {
      ok: false,
      code,
      operation,
      bucket: input.bucket,
      detail: `${e.name || "Error"}${status ? ` (HTTP ${status})` : ""}: ${errText(err)}`,
    };
  } finally {
    client.destroy?.();
  }
}

function extractWorkerSha(returnValue: unknown): string | null {
  if (!returnValue || typeof returnValue !== "object") return null;
  const record = returnValue as Record<string, unknown>;
  for (const key of WORKER_HEALTH_ECHO_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() && value.trim() !== "unknown") return value.trim();
  }
  return null;
}

/**
 * A HEALTH JOB ROUND-TRIP.
 *
 * `getWorkers().length > 0` reports registered CONNECTIONS. A worker whose
 * event loop is wedged, whose concurrency slot is occupied forever, or which
 * crashed after registering still shows up there — which is why the old check
 * passed while nothing drained the queue.
 *
 * This enqueues a real job and waits for a real worker to take it. Timing out
 * is a FAIL, not a warning. The job name is unknown to `processPodcastJob`, so
 * today it completes via the harmless unknown-job branch — proving consumption
 * without touching a database row or spending a cent.
 */
async function liveWorkerHealth(input: WorkerHealthInput): Promise<WorkerHealthResult> {
  const { Queue } = await import("bullmq");
  const { getRedisClient } = await import("../redis");
  const crypto = await import("node:crypto");

  const queue = new Queue(input.queue, { connection: getRedisClient() as never });
  const jobId = `${WORKER_HEALTH_JOB_ID_PREFIX}${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  let registeredWorkers = 0;

  try {
    registeredWorkers = (await queue.getWorkers()).length;
    await queue.add(
      WORKER_HEALTH_JOB_NAME,
      { probe: true, requestedAt: new Date().toISOString() },
      { jobId, attempts: 1, removeOnComplete: false, removeOnFail: false }
    );

    while (Date.now() - startedAt < input.timeoutMs) {
      const job = await queue.getJob(jobId);
      const state = job ? await job.getState() : "unknown";
      if (state === "completed" || state === "failed") {
        const reportedSha = extractWorkerSha(job?.returnvalue);
        return {
          ok: true,
          code: "processed",
          queue: input.queue,
          jobId,
          waitedMs: Date.now() - startedAt,
          timeoutMs: input.timeoutMs,
          registeredWorkers,
          reportedSha,
          versionReported: reportedSha !== null,
          detail:
            state === "completed"
              ? "Worker completed the health job."
              : `Worker took the job and failed it (${job?.failedReason || "no reason"}) — consumption is still proven.`,
        };
      }
      await sleep(500);
    }

    return {
      ok: false,
      code: "timeout",
      queue: input.queue,
      jobId,
      waitedMs: Date.now() - startedAt,
      timeoutMs: input.timeoutMs,
      registeredWorkers,
      reportedSha: null,
      versionReported: false,
      detail: "No worker took the job.",
    };
  } catch (err) {
    return {
      ok: false,
      code: "error",
      queue: input.queue,
      jobId,
      waitedMs: Date.now() - startedAt,
      timeoutMs: input.timeoutMs,
      registeredWorkers,
      reportedSha: null,
      versionReported: false,
      detail: errText(err),
    };
  } finally {
    try {
      const job = await queue.getJob(jobId);
      await job?.remove();
    } catch {
      /* leaving one probe job behind is harmless */
    }
    await queue.close().catch(() => undefined);
  }
}

/**
 * A MINIMAL AUTHENTICATED CALL through the role's ACTUAL route, then a
 * comparison of what was REQUESTED against what actually served it. A present
 * key proves nothing: an unfunded account, a revoked key, and a model id this
 * account cannot reach all look identical until something calls them.
 */
async function liveLlmRoute(role: "script_movement" | "quality_judge"): Promise<LlmRouteProbeResult> {
  const { getRoleLLMProvider, resolveRolePlan } = await import("../providers/llm/routing");
  const { llmCostMark, llmCostSince } = await import("../providers/llm/costLedger");

  const plan = resolveRolePlan(role);
  const first = plan.candidates[0];
  const requested = first ? (first.model ? `${first.provider}/${first.model}` : first.provider) : "(no candidate)";
  if (!first) {
    return { ok: false, code: "unroutable", role, requested, actual: null, detail: "The role resolves to no candidate at all." };
  }

  const mark = llmCostMark();
  try {
    const provider = getRoleLLMProvider(role);
    await provider.generateText({ prompt: "Reply with exactly: ok", maxTokens: 8, temperature: 0 });
    const models = [...new Set(llmCostSince(mark).stages.flatMap((s) => s.models))];
    const actual = models[0] ?? null;
    if (first.model && actual && actual !== requested) {
      return {
        ok: false,
        code: "drifted",
        role,
        requested,
        actual,
        detail: "The call succeeded but a DIFFERENT provider/model served it. A release must ship the route it declared.",
      };
    }
    return { ok: true, code: "ok", role, requested, actual, detail: "Authenticated call accepted." };
  } catch (err) {
    return { ok: false, code: "rejected", role, requested, actual: null, detail: errText(err) };
  }
}

async function httpCredentialProbe(url: string, headers: Record<string, string>): Promise<CredentialProbeResult> {
  try {
    const res = await fetch(url, { method: "GET", headers });
    const code = classifyCredentialStatus(res.status);
    return {
      ok: code === "ok",
      code,
      status: res.status,
      // Names and statuses only — a body can echo the key back.
      detail: code === "ok" ? "Credential accepted." : "Credential was not accepted.",
    };
  } catch (err) {
    return { ok: false, code: "unreachable", status: null, detail: errText(err) };
  }
}

/**
 * Deepgram (and OpenAI) credential proof. `/v1/projects` is a read-only account
 * listing: it costs nothing, transcribes nothing, and 401s on a bad key — which
 * is exactly the failure that "the variable is set" could never detect.
 */
async function liveTranscription(provider: string): Promise<CredentialProbeResult> {
  const p = provider.trim().toLowerCase();
  if (p === "deepgram") {
    const key = (process.env.TRANSCRIPT_QA_DEEPGRAM_API_KEY || process.env.DEEPGRAM_API_KEY || "").trim();
    if (!key) return { ok: false, code: "rejected", status: null, detail: "No Deepgram credential variable is set." };
    return httpCredentialProbe("https://api.deepgram.com/v1/projects", { Authorization: `Token ${key}` });
  }
  if (p === "openai") {
    const key = (process.env.TRANSCRIPT_QA_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
    if (!key) return { ok: false, code: "rejected", status: null, detail: "No OpenAI credential variable is set." };
    return httpCredentialProbe("https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` });
  }
  return { ok: false, code: "error", status: null, detail: `Unsupported transcription provider "${provider}".` };
}

/** Read-only, authenticated account/voice listing per TTS provider. */
async function liveTtsProvider(provider: string): Promise<CredentialProbeResult> {
  const p = provider.trim().toLowerCase();
  const varName = TTS_CREDENTIAL_VARS[p];
  const key = varName ? (process.env[varName] || "").trim() : "";
  if (!varName) return { ok: false, code: "error", status: null, detail: `No credential variable is known for "${provider}".` };
  if (!key) return { ok: false, code: "rejected", status: null, detail: `${varName} is not set.` };

  switch (p) {
    case "fish":
      return httpCredentialProbe("https://api.fish.audio/model?page_size=1", { Authorization: `Bearer ${key}` });
    case "elevenlabs":
      return httpCredentialProbe("https://api.elevenlabs.io/v1/user", { "xi-api-key": key });
    case "cartesia":
      return httpCredentialProbe("https://api.cartesia.ai/voices?limit=1", {
        "X-API-Key": key,
        "Cartesia-Version": "2024-06-10",
      });
    case "openai":
      return httpCredentialProbe("https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` });
    case "boson":
      return httpCredentialProbe("https://api.boson.ai/v1/models", { Authorization: `Bearer ${key}` });
    default:
      return { ok: false, code: "error", status: null, detail: `No authenticated probe is implemented for "${provider}".` };
  }
}

/**
 * The WEB service's commit, preferably read over HTTP from the running
 * container (`/api/build-info`), because that is the only source that describes
 * the process actually serving traffic. A local env stamp is accepted as a
 * fallback and is LABELLED as such — it describes this process, not web.
 */
async function liveWebBuildIdentity(): Promise<BuildIdentityResult> {
  const base = (process.env.READINESS_WEB_BASE_URL || process.env.WEB_BASE_URL || process.env.NEXTAUTH_URL || "").trim();
  if (base) {
    const url = `${base.replace(/\/+$/, "")}/api/build-info`;
    try {
      const res = await fetch(url, { headers: { "Cache-Control": "no-store" } });
      if (!res.ok) {
        return { sha: null, source: `${url} (HTTP ${res.status})`, detail: "build-info did not answer successfully." };
      }
      const body = (await res.json()) as { sourceCommit?: string };
      const sha = (body.sourceCommit || "").trim();
      return {
        sha: sha && sha !== "unknown" ? sha : null,
        source: "web /api/build-info",
        detail: sha && sha !== "unknown" ? "Read from the running web container." : "build-info reported 'unknown'.",
      };
    } catch (err) {
      return { sha: null, source: url, detail: errText(err) };
    }
  }
  const found = COMMIT_SHA_VARS.find((v) => (process.env[v] || "").trim());
  if (!found) {
    return {
      sha: null,
      source: "local process stamp",
      detail: `No build-stamped commit variable (${COMMIT_SHA_VARS.join(", ")}) and no READINESS_WEB_BASE_URL to ask web directly.`,
    };
  }
  return {
    sha: (process.env[found] || "").trim(),
    source: `local process stamp ${found}`,
    detail: "Describes THIS process. Set READINESS_WEB_BASE_URL to interrogate the web container itself.",
  };
}

/**
 * The migration PLAN: what would run, and whether the history is sane.
 * Deliberately tolerant of pending migrations — that is the normal pre-deploy
 * state, and demanding otherwise is the circularity this phase removes.
 */
async function liveMigrationPlan(): Promise<MigrationPlanResult> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  try {
    const dir = path.resolve(process.cwd(), "prisma/migrations");
    const onDisk = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).sort()
      : [];

    const { db } = await import("../db");
    const rows = await db.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null }>>(
      `SELECT migration_name, finished_at FROM "_prisma_migrations"`
    );
    const applied = new Set(rows.filter((r) => r.finished_at).map((r) => r.migration_name));
    const failed = rows.filter((r) => !r.finished_at).map((r) => r.migration_name);
    const pending = onDisk.filter((m) => !applied.has(m));
    const unknown = [...applied].filter((m) => !onDisk.includes(m));

    return {
      ok: failed.length === 0 && unknown.length === 0,
      pending,
      failed,
      unknown,
      detail:
        `${applied.size} applied, ${pending.length} pending` +
        `${failed.length ? `, ${failed.length} HALF-APPLIED (${failed.join(", ")})` : ""}` +
        `${unknown.length ? `, ${unknown.length} applied-but-missing-from-repo (${unknown.join(", ")})` : ""}.`,
    };
  } catch (err) {
    return { ok: false, pending: [], failed: [], unknown: [], detail: errText(err) };
  }
}

/**
 * Verify the live-provider canary went GREEN for the exact commit being shipped.
 *
 * Read-only: it asks the GitHub Actions API for workflow runs at that SHA. The
 * token needs `actions: read` and nothing else, and its value is never printed.
 */
async function liveCanaryRun(expectedSha: string): Promise<CanaryVerificationResult> {
  const token = (process.env[CANARY_READ_TOKEN_VAR] || process.env.GITHUB_TOKEN || "").trim();
  const repo = (process.env[CANARY_REPO_VAR] || "").trim();
  const workflow = (process.env[CANARY_WORKFLOW_VAR] || "live-provider-canary.yml").trim();
  const empty = { sha: null, conclusion: null, runUrl: null, completedAt: null, ageHours: null };

  if (!token || !repo) {
    return {
      ok: false,
      code: "unverifiable",
      ...empty,
      detail:
        `Cannot verify the canary: set ${CANARY_REPO_VAR} (owner/name) and ${CANARY_READ_TOKEN_VAR} ` +
        `(a read-only token with "actions: read" and no other permission). Its value is never printed.`,
    };
  }

  try {
    const url =
      `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs` +
      `?head_sha=${encodeURIComponent(expectedSha)}&per_page=10`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      return { ok: false, code: "error", ...empty, detail: `GitHub API ${res.status} querying canary runs.` };
    }
    const body = (await res.json()) as {
      workflow_runs?: Array<{ head_sha: string; status: string; conclusion: string | null; html_url: string; updated_at: string }>;
    };
    const runs = body.workflow_runs || [];
    // Only this exact commit counts. A green run on a neighbouring commit is a
    // different build.
    const forSha = runs.filter((r) => r.head_sha === expectedSha);
    if (!forSha.length) {
      return {
        ok: false,
        code: "no_run_for_sha",
        ...empty,
        detail: `No ${workflow} run found for ${expectedSha.slice(0, 12)}. Run the canary against this exact commit before deploying.`,
      };
    }
    const success = forSha.find((r) => r.status === "completed" && r.conclusion === "success");
    if (!success) {
      const worst = forSha[0];
      return {
        ok: false,
        code: "not_successful",
        sha: worst.head_sha,
        conclusion: worst.conclusion ?? worst.status,
        runUrl: worst.html_url,
        completedAt: worst.updated_at,
        ageHours: null,
        detail: `The canary for ${expectedSha.slice(0, 12)} is "${worst.conclusion ?? worst.status}", not success. Cancelled, skipped and failed runs are all refused.`,
      };
    }
    const ageHours = (Date.now() - new Date(success.updated_at).getTime()) / 3_600_000;
    if (ageHours > CANARY_MAX_AGE_HOURS) {
      return {
        ok: false,
        code: "stale",
        sha: success.head_sha,
        conclusion: "success",
        runUrl: success.html_url,
        completedAt: success.updated_at,
        ageHours,
        detail: `The green canary for this commit is ${ageHours.toFixed(0)}h old (limit ${CANARY_MAX_AGE_HOURS}h). Providers drift; re-run it.`,
      };
    }
    return {
      ok: true,
      code: "ok",
      sha: success.head_sha,
      conclusion: "success",
      runUrl: success.html_url,
      completedAt: success.updated_at,
      ageHours,
      detail: `Canary green for ${expectedSha.slice(0, 12)} ${ageHours.toFixed(1)}h ago: ${success.html_url}`,
    };
  } catch (err) {
    return { ok: false, code: "error", ...empty, detail: errText(err) };
  }
}

/**
 * The real resolvers + probes.
 *
 * Async because every project module is imported here rather than at file
 * scope: this module has to stay importable by an offline unit test that has no
 * database, no Redis and no credentials.
 */
export async function createLiveDependencies(): Promise<ReadinessDependencies> {
  const semanticQa = await import("../audio/audioSemanticQa");
  const editorialGate = await import("./scriptEditorialGate");
  const rollout = await import("../queue/rolloutPolicy");
  const routing = await import("../providers/llm/routing");
  const fishDialogue = await import("../providers/tts/fishDialogue");

  return {
    resolvers: {
      semanticQaRequirement: (env) => semanticQa.resolveSemanticQaRequirement(env),
      editorialGateMode: () => editorialGate.resolveScriptEditorialGateMode(),
      gateEnforcementVar: rollout.GATE_ENFORCEMENT_FROM_VAR,
      gateEnforcementCutover: () => rollout.resolveGateEnforcementCutover(),
      gateEnforcementRawSet: (env) => Boolean((env[rollout.GATE_ENFORCEMENT_FROM_VAR] || "").trim()),
      llmRoutes: () => ({
        writer: routing.roleProviderLabel("script_movement"),
        judge: routing.roleProviderLabel("quality_judge"),
        judgeHasRealProvider: routing.roleHasRealProvider("quality_judge"),
      }),
      fishSceneModel: () => fishDialogue.resolveFishSceneModel(),
    },
    probes: {
      database: liveDatabase,
      redis: liveRedis,
      migrations: liveMigrations,
      migrationPlan: liveMigrationPlan,
      canaryRun: liveCanaryRun,
      storage: liveStorage,
      workerHealth: liveWorkerHealth,
      llmRoute: liveLlmRoute,
      transcription: liveTranscription,
      ttsProvider: liveTtsProvider,
      webBuildIdentity: liveWebBuildIdentity,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 9. Command line                                                      */
/* ------------------------------------------------------------------ */

export interface ReadinessCliOptions {
  mode: ReadinessMode;
  asJson: boolean;
  expectSha: string | null;
  workerTimeoutMs: number;
  /** True when the operator explicitly refused the live probes. */
  skipLive: boolean;
}

/**
 * Pure, so the flag-to-mode mapping is testable without running the command.
 *
 * `--skip-live` predates the four verdicts and is kept as an explicit alias for
 * config mode. It WINS over `--live`/`--release`: those flags ask for evidence
 * and `--skip-live` refuses to gather it, and the only safe reading of a
 * contradiction is the one that cannot over-claim. A `--skip-live --release`
 * run therefore reports CONFIGURATION-READY at best and never accepts a release.
 */
export function parseReadinessArgs(argv: string[]): ReadinessCliOptions {
  const asJson = argv.includes("--json");
  const skipLive = argv.includes("--skip-live") || argv.includes("--config");
  const release = !skipLive && argv.includes("--release");
  const predeploy = !skipLive && !release && argv.includes("--predeploy");
  const live = !skipLive && !release && !predeploy && argv.includes("--live");
  const mode: ReadinessMode = release ? "release" : predeploy ? "predeploy" : live ? "live" : "config";

  const shaIndex = argv.indexOf("--expect-sha");
  const rawSha = shaIndex >= 0 ? (argv[shaIndex + 1] || "").trim() : "";
  const expectSha = rawSha && !rawSha.startsWith("--") ? rawSha : null;

  const timeoutIndex = argv.indexOf("--worker-timeout-ms");
  const parsedTimeout = timeoutIndex >= 0 && argv[timeoutIndex + 1] ? Number(argv[timeoutIndex + 1]) : NaN;
  const workerTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : WORKER_HEALTH_TIMEOUT_MS;

  return { mode, asJson, expectSha, workerTimeoutMs, skipLive };
}
