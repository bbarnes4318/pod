// EXECUTED proof that the readiness preflight proves what it claims.
//
// The first version reported things it had never checked and then printed one
// word, READY. Each scenario below is one of those FALSE POSITIVES, and each
// now has to fail. Every probe is injected, so this runs offline: no S3, no
// Redis, no provider, no network.

import assert from "node:assert/strict";
import {
  evaluateReadiness,
  parseReadinessArgs,
  renderReport,
  serializeReport,
  verdictsEvaluatedIn,
  containsUnqualifiedReady,
  type BuildIdentityResult,
  type CredentialProbeResult,
  type LlmRouteProbeResult,
  type ReadinessDependencies,
  type ReadinessMode,
  type SimpleProbeResult,
  type StorageProbeResult,
  type WorkerHealthResult,
} from "../lib/services/readinessProbes";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

const FAKE_SECRET = "SUPERSECRET_S3_KEY_VALUE";
const GOOD_SHA = "abc123def456";

/** A fully healthy production environment. */
function healthyEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://u:p@db:5432/x",
    REDIS_URL: "redis://:p@redis:6379",
    ANTHROPIC_API_KEY: "k",
    FISH_API_KEY: "k",
    ELEVENLABS_API_KEY: "k",
    DEEPGRAM_API_KEY: "k",
    S3_BUCKET: "b",
    S3_ENDPOINT: "https://s3.example",
    S3_REGION: "r",
    S3_ACCESS_KEY_ID: "id",
    S3_SECRET_ACCESS_KEY: FAKE_SECRET,
    TTS_TRANSCRIPT_QA_ENABLED: "true",
    TRANSCRIPT_QA_PROVIDER: "deepgram",
    SCRIPT_GATE_ENFORCEMENT_FROM: "2026-08-02T00:00:00Z",
    SCRIPT_EDITORIAL_GATE_MODE: "hold",
    GIT_COMMIT_SHA: GOOD_SHA,
    CANARY_LLM_PROVIDER: "anthropic",
    CANARY_LLM_MODEL: "claude-opus-5",
    CANARY_JUDGE_PROVIDER: "anthropic",
    CANARY_JUDGE_MODEL: "claude-sonnet-5",
    CANARY_FISH_VOICE_A: "36780e7121b84d5c9c24cbd2f15eaaa4",
    CANARY_FISH_VOICE_B: "46780e7121b84d5c9c24cbd2f15eaaa4",
    CANARY_ELEVENLABS_VOICE_A: "va",
    CANARY_ELEVENLABS_VOICE_B: "vb",
    ...over,
  } as NodeJS.ProcessEnv;
}

const okSimple = (): SimpleProbeResult => ({ ok: true, detail: "ok" });
const storage = (over: Partial<StorageProbeResult> = {}): StorageProbeResult => ({
  ok: true, code: "ok", operation: "HeadBucket", bucket: "b", detail: "HeadBucket succeeded", ...over,
});
const okStorage = (): StorageProbeResult => storage();
const worker = (over: Partial<WorkerHealthResult> = {}): WorkerHealthResult => ({
  ok: true,
  code: "processed",
  queue: "podcast-production",
  jobId: "readiness-health-1",
  waitedMs: 42,
  timeoutMs: 500,
  registeredWorkers: 1,
  reportedSha: GOOD_SHA,
  versionReported: true,
  detail: "processed",
  ...over,
});
const okWorker = (): WorkerHealthResult => worker();
const okLlm = (role: string): LlmRouteProbeResult => ({
  ok: true, code: "ok", role, requested: `anthropic/${role === "quality_judge" ? "claude-sonnet-5" : "claude-opus-5"}`,
  actual: `anthropic/${role === "quality_judge" ? "claude-sonnet-5" : "claude-opus-5"}`, detail: "ok",
});
const cred = (over: Partial<CredentialProbeResult> = {}): CredentialProbeResult => ({
  ok: true, code: "ok", status: 200, detail: "authenticated", ...over,
});
const okCred = (): CredentialProbeResult => cred();
const okBuild = (): BuildIdentityResult => ({ sha: GOOD_SHA, source: "build-info", detail: "web build-info" });

/** Healthy dependencies; override one probe per scenario. */
function healthyDeps(over: Partial<ReadinessDependencies["probes"]> = {}): ReadinessDependencies {
  return {
    resolvers: {
      semanticQaRequirement: (env) => ({
        required: env.NODE_ENV === "production",
        enabled: env.TTS_TRANSCRIPT_QA_ENABLED === "true",
        missing: env.TTS_TRANSCRIPT_QA_ENABLED === "true" ? [] : ["TTS_TRANSCRIPT_QA_ENABLED"],
        provider: (env.TRANSCRIPT_QA_PROVIDER || "deepgram") as string,
        providerSupported: true,
      }),
      editorialGateMode: (env) => (env.SCRIPT_EDITORIAL_GATE_MODE as string) || "hold",
      gateEnforcementVar: "SCRIPT_GATE_ENFORCEMENT_FROM",
      gateEnforcementCutover: (env) => {
        const raw = (env.SCRIPT_GATE_ENFORCEMENT_FROM || "").trim();
        if (!raw) return null;
        const d = new Date(raw);
        return Number.isFinite(d.getTime()) ? d : null;
      },
      gateEnforcementRawSet: (env) => Boolean((env.SCRIPT_GATE_ENFORCEMENT_FROM || "").trim()),
      llmRoutes: () => ({
        writer: "anthropic/claude-opus-5",
        judge: "anthropic/claude-sonnet-5",
        judgeHasRealProvider: true,
      }),
      fishSceneModel: () => "s2.1-pro-free",
    },
    probes: {
      database: async () => okSimple(),
      redis: async () => okSimple(),
      migrations: async () => okSimple(),
      storage: async () => okStorage(),
      workerHealth: async () => okWorker(),
      llmRoute: async (role) => okLlm(role),
      transcription: async () => okCred(),
      ttsProvider: async () => okCred(),
      webBuildIdentity: async () => okBuild(),
      ...over,
    },
  };
}

function run(mode: ReadinessMode, deps: ReadinessDependencies, env = healthyEnv(), expectedSha: string | null = GOOD_SHA) {
  return evaluateReadiness({ mode, env, deps, expectedSha, workerTimeoutMs: 500 });
}

async function main() {
  console.log("\nProduction readiness preflight\n");

  console.log("  -- CONTROL: a fully healthy environment is accepted --");
  await check("release mode accepts a healthy environment", async () => {
    const r = await run("release", healthyDeps());
    assert.equal(r.exitCode, 0, `expected acceptance; blocking: ${JSON.stringify(r.verdicts)}`);
    assert.equal(r.verdicts.releaseAccepted.state, "accepted", r.verdicts.releaseAccepted.reason);
  });

  console.log("  -- storage: an HTTP reply is not proof --");
  await check("credentials REJECTED by the bucket => storage fails", async () => {
    const r = await run("release", healthyDeps({
      storage: async () => storage({ ok: false, code: "credentials_rejected", detail: "403 from HeadBucket" }),
    }));
    assert.notEqual(r.exitCode, 0, "a rejected credential must refuse the release");
    assert.ok(
      r.checks.some((c) => c.category === "storage" && c.status === "fail"),
      "the storage check must be the one that fails"
    );
  });
  await check("a bucket that does not exist => storage fails", async () => {
    const r = await run("release", healthyDeps({
      storage: async () => storage({ ok: false, code: "bucket_missing", detail: "NoSuchBucket" }),
    }));
    assert.notEqual(r.exitCode, 0, "a missing bucket must refuse the release");
  });

  console.log("  -- worker: registered is not consuming --");
  await check("a worker that never picks the job up => worker fails", async () => {
    const r = await run("release", healthyDeps({
      workerHealth: async () => worker({ ok: false, code: "timeout", reportedSha: null, versionReported: false, registeredWorkers: 1, detail: "no worker consumed the health job within 500ms" }),
    }));
    assert.notEqual(r.exitCode, 0, "a queue nothing drains must refuse the release");
    assert.ok(r.checks.some((c) => c.category === "queue" && c.status === "fail"), "the queue check must fail");
  });

  console.log("  -- commit identity: any sha is not the RIGHT sha --");
  await check("worker on a DIFFERENT commit than web => identity fails", async () => {
    const r = await run("release", healthyDeps({
      workerHealth: async () => worker({ reportedSha: "0000000different" }),
    }));
    assert.notEqual(r.exitCode, 0, "a web/worker commit mismatch must refuse the release");
  });
  await check("web+worker agree but do NOT match the expected sha => identity fails", async () => {
    const other = "ffffffffffff";
    const r = await evaluateReadiness({
      mode: "release",
      env: healthyEnv({ GIT_COMMIT_SHA: other }),
      deps: healthyDeps({
        webBuildIdentity: async () => ({ sha: other, source: "build-info", detail: "" }),
        workerHealth: async () => worker({ reportedSha: other }),
      }),
      expectedSha: GOOD_SHA,
      workerTimeoutMs: 500,
    });
    assert.notEqual(r.exitCode, 0, "agreeing on the WRONG commit is still wrong");
  });

  console.log("  -- providers: a present key is not a working key --");
  await check("a REJECTED LLM key => release refused", async () => {
    const r = await run("release", healthyDeps({
      llmRoute: async (role) => ({
        ok: false, code: "rejected", role, requested: "anthropic/claude-opus-5", actual: null,
        detail: "401 invalid x-api-key",
      }),
    }));
    assert.notEqual(r.exitCode, 0, "a rejected LLM credential must refuse the release");
  });
  await check("a route served by a DIFFERENT model than requested => release refused", async () => {
    const r = await run("release", healthyDeps({
      llmRoute: async (role) => ({
        ok: false, code: "drifted", role, requested: "anthropic/claude-opus-5",
        actual: "anthropic/claude-haiku-4-5", detail: "served by a fallback rung",
      }),
    }));
    assert.notEqual(r.exitCode, 0, "silent model drift must refuse the release");
  });
  await check("a REJECTED Deepgram key => release refused", async () => {
    const r = await run("release", healthyDeps({
      transcription: async () => cred({ ok: false, code: "rejected", status: 401, detail: "401 from Deepgram" }),
    }));
    assert.notEqual(r.exitCode, 0, "a rejected transcription credential must refuse the release");
  });
  await check("a TTS provider required by policy but unconfigured => release refused", async () => {
    const r = await run("release", healthyDeps({
      ttsProvider: async (p) => (p === "fish" ? okCred() : cred({ ok: false, code: "rejected", status: 401, detail: `${p} rejected` })),
    }));
    assert.notEqual(r.exitCode, 0, "every provider the policy requires must authenticate");
  });

  console.log("  -- canary config is mandatory for a RELEASE --");
  await check("missing canary config refuses --release", async () => {
    const env = healthyEnv({ CANARY_FISH_VOICE_A: undefined, CANARY_LLM_PROVIDER: undefined });
    const r = await evaluateReadiness({ mode: "release", env, deps: healthyDeps(), expectedSha: GOOD_SHA, workerTimeoutMs: 500 });
    assert.notEqual(r.exitCode, 0, "a release without a working canary must be refused");
  });
  await check("...but it is only a warning in config mode", async () => {
    const env = healthyEnv({ CANARY_FISH_VOICE_A: undefined, CANARY_LLM_PROVIDER: undefined });
    const r = await evaluateReadiness({ mode: "config", env, deps: healthyDeps(), expectedSha: null, workerTimeoutMs: 500 });
    assert.equal(r.exitCode, 0, "config mode must not be blocked by canary configuration");
  });

  console.log("  -- quality gates cannot be waived --");
  await check("a standing global waiver refuses the release", async () => {
    const r = await evaluateReadiness({
      mode: "release",
      env: healthyEnv({ TTS_TRANSCRIPT_QA_WAIVED: "true" }),
      deps: healthyDeps(),
      expectedSha: GOOD_SHA,
      workerTimeoutMs: 500,
    });
    assert.notEqual(r.exitCode, 0, "a waiver is not production semantic QA");
  });
  await check("an unset gate-enforcement cutover refuses the release", async () => {
    const r = await evaluateReadiness({
      mode: "release",
      env: healthyEnv({ SCRIPT_GATE_ENFORCEMENT_FROM: undefined }),
      deps: healthyDeps(),
      expectedSha: GOOD_SHA,
      workerTimeoutMs: 500,
    });
    assert.notEqual(r.exitCode, 0, "the rollout cutover must be an explicit decision");
  });

  console.log("  -- four verdicts, never collapsed --");
  await check("config mode evaluates ONLY the configuration verdict", () => {
    assert.deepEqual([...verdictsEvaluatedIn("config")], ["codeConfiguration"]);
  });
  await check("live mode adds infrastructure and providers but NOT release", () => {
    const live = verdictsEvaluatedIn("live");
    assert.ok(live.has("infrastructureReachable"), "live must evaluate infrastructure");
    assert.ok(!live.has("releaseAccepted"), "live must NOT claim a release verdict");
  });
  await check("a config run leaves the later verdicts NOT-EVALUATED, not passed", async () => {
    const r = await evaluateReadiness({ mode: "config", env: healthyEnv(), deps: healthyDeps(), expectedSha: null, workerTimeoutMs: 500 });
    assert.equal(r.verdicts.releaseAccepted.state, "not-evaluated", "an unevaluated verdict must not read as accepted");
    assert.equal(r.verdicts.liveProvidersVerified.state, "not-evaluated");
  });
  await check("infrastructure failing does not silently accept the release verdict", async () => {
    const r = await run("release", healthyDeps({ database: async () => ({ ok: false, detail: "connection refused" }) }));
    assert.equal(r.verdicts.infrastructureReachable.state, "refused");
    assert.notEqual(r.verdicts.releaseAccepted.state, "accepted");
  });

  console.log("  -- --skip-live can never print an unqualified READY --");
  await check("--skip-live maps to config mode", () => {
    assert.equal(parseReadinessArgs(["--skip-live"]).mode, "config");
  });
  await check("no config/live render contains an unqualified READY", async () => {
    for (const mode of ["config", "live"] as ReadinessMode[]) {
      const r = await evaluateReadiness({ mode, env: healthyEnv(), deps: healthyDeps(), expectedSha: null, workerTimeoutMs: 500 });
      const text = renderReport(r, healthyEnv());
      assert.ok(!containsUnqualifiedReady(text), `${mode} mode printed an unqualified READY:\n${r.headline}`);
    }
  });

  console.log("  -- secrets never appear --");
  await check("a secret VALUE never reaches the JSON or the rendered text", async () => {
    const env = healthyEnv();
    const r = await run("release", healthyDeps({
      storage: async () => storage({ ok: false, code: "credentials_rejected", detail: `403 using key ${FAKE_SECRET}` }),
    }), env);
    const json = JSON.stringify(serializeReport(r, env));
    const text = renderReport(r, env);
    assert.ok(!json.includes(FAKE_SECRET), "the serialized report leaked a secret value");
    assert.ok(!text.includes(FAKE_SECRET), "the rendered report leaked a secret value");
  });

  console.log(
    failed === 0 ? "\nAll production readiness checks passed.\n" : `\n${failed} readiness check(s) FAILED.\n`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
