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
  type CanaryVerificationResult,
  type CredentialProbeResult,
  type MigrationPlanResult,
  type LlmRouteProbeResult,
  type ReadinessDependencies,
  type ReadinessMode,
  type SimpleProbeResult,
  type StorageProbeResult,
  type WorkerHealthResult,
} from "../lib/services/readinessProbes";
import { describeEvidenceAge, STALENESS_LIMIT_DAYS } from "../lib/providers/llm/routingEvidence";
import { currentRoutingStaleness } from "./routingStaleness";

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

/** Migration PLAN. Pending migrations are the NORMAL pre-deploy state. */
const plan = (over: Partial<MigrationPlanResult> = {}): MigrationPlanResult => ({
  ok: true,
  pending: [
    "20260802000000_add_blind_voice_audition",
    "20260802010000_add_listener_learning",
    "20260802020000_add_script_legacy_release",
    "20260802030000_learning_event_dedupe_index",
  ],
  failed: [],
  unknown: [],
  detail: "37 applied, 4 pending.",
  ...over,
});

const canary = (over: Partial<CanaryVerificationResult> = {}): CanaryVerificationResult => ({
  ok: true,
  code: "ok",
  sha: GOOD_SHA,
  conclusion: "success",
  runUrl: "https://github.com/example/pod/actions/runs/1",
  completedAt: new Date().toISOString(),
  ageHours: 2,
  detail: "Canary green for this commit 2h ago.",
  ...over,
});

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
      // HEALTHY means the judge is on a DIFFERENT PROVIDER. This fixture used to
      // read anthropic/claude-opus-5 vs anthropic/claude-sonnet-5 and call it
      // healthy — the same-lab configuration the repository was actually
      // running. A fixture that encodes the defect cannot catch it.
      llmRoutes: () => ({
        writer: "anthropic/claude-opus-5",
        judge: "nvidia/nemotron-3-ultra",
        judgeHasRealProvider: true,
      }),
      routingAudit: () => ({
        rowCount: 9,
        judgeIndependence: {
          level: "provider",
          independent: true,
          acceptable: true,
          judgeRole: "quality_judge",
          judgeLabel: "nvidia/nemotron-3-ultra",
          providerCollisions: [],
          endpointCollisions: [],
          alternativesAvailable: ["anthropic"],
          reason: null,
          remedy: null,
        },
        hostWriters: {
          separate: true,
          sameEndpoint: false,
          sameProvider: false,
          hostA: "anthropic/claude-opus-5",
          hostB: "nvidia/mistral-medium-3.5",
          reason: null,
          remedy: null,
        },
        concentration: [
          { provider: "anthropic", roles: ["script_story_editor", "script_debate_architect", "script_host_a_writer"] },
          { provider: "nvidia", roles: ["script_host_b_writer", "quality_judge", "cold_open_judge"] },
        ],
        singleProvider: false,
      }),
      fishSceneModel: () => "s2.1-pro-free",
    },
    probes: {
      database: async () => okSimple(),
      redis: async () => okSimple(),
      migrations: async () => okSimple(),
      migrationPlan: async () => plan(),
      canaryRun: async () => canary(),
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

  // =======================================================================
  // THE CIRCULARITY THIS SPLIT REMOVES.
  //
  // Before a deploy: migrations are PENDING, and web and worker are still on
  // the OLD build. Release mode verifies exactly those things, so demanding it
  // beforehand could never pass. Pre-deploy must pass in that state; release
  // must refuse it.
  // =======================================================================
  console.log("  -- pre-deploy vs release, in the REAL pre-deploy state --");

  /** Production as it actually looks moments before the deploy. */
  function preDeployWorld() {
    const OLD_SHA = "0000oldbuild";
    return healthyDeps({
      // Four migrations written but not yet applied.
      migrationPlan: async () => plan(),
      migrations: async () => ({ ok: false, detail: "4 migration(s) on disk are not applied to this database." }),
      // Both services still running the previous release.
      webBuildIdentity: async () => ({ sha: OLD_SHA, source: "build-info", detail: "old build" }),
      workerHealth: async () => worker({ reportedSha: OLD_SHA }),
    });
  }

  await check("PRE-DEPLOY passes while migrations are pending and services are old", async () => {
    const env = healthyEnv({ DEPLOY_BACKUP_REFERENCE: "pg_dump-2026-08-02" });
    const r = await evaluateReadiness({
      mode: "predeploy", env, deps: preDeployWorld(), expectedSha: GOOD_SHA, workerTimeoutMs: 500,
    });
    assert.equal(r.exitCode, 0, `pre-deploy must pass before the deploy; blocking: ${JSON.stringify(r.verdicts.predeployValidated)}`);
    assert.equal(r.verdicts.predeployValidated.state, "accepted");
  });

  await check("...and RELEASE fails in that exact same state", async () => {
    const env = healthyEnv({ DEPLOY_BACKUP_REFERENCE: "pg_dump-2026-08-02" });
    const r = await evaluateReadiness({
      mode: "release", env, deps: preDeployWorld(), expectedSha: GOOD_SHA, workerTimeoutMs: 500,
    });
    assert.notEqual(r.exitCode, 0, "release must refuse before the deploy has happened");
  });

  await check("pre-deploy does NOT claim a release verdict", async () => {
    const env = healthyEnv({ DEPLOY_BACKUP_REFERENCE: "b" });
    const r = await evaluateReadiness({ mode: "predeploy", env, deps: preDeployWorld(), expectedSha: GOOD_SHA, workerTimeoutMs: 500 });
    assert.equal(r.verdicts.releaseAccepted.state, "not-evaluated", "pre-deploy must not imply the release is accepted");
  });

  await check("release does NOT re-claim the pre-deploy verdict", async () => {
    const r = await run("release", healthyDeps());
    assert.equal(r.verdicts.predeployValidated.state, "not-evaluated");
  });

  await check("a HALF-APPLIED migration blocks pre-deploy", async () => {
    const env = healthyEnv({ DEPLOY_BACKUP_REFERENCE: "b" });
    const deps = healthyDeps({
      migrationPlan: async () => plan({ ok: false, failed: ["20260714120000_topic_lifecycle_and_snapshots"] }),
    });
    const r = await evaluateReadiness({ mode: "predeploy", env, deps, expectedSha: GOOD_SHA, workerTimeoutMs: 500 });
    assert.notEqual(r.exitCode, 0, "a migration that died mid-run must be resolved before deploying");
  });

  await check("no recorded backup blocks pre-deploy", async () => {
    const r = await evaluateReadiness({
      mode: "predeploy", env: healthyEnv(), deps: preDeployWorld(), expectedSha: GOOD_SHA, workerTimeoutMs: 500,
    });
    assert.notEqual(r.exitCode, 0, "four additive migrations without a backup is not a release plan");
  });

  console.log("  -- canary evidence is per-commit, green, and fresh --");
  for (const [label, over] of [
    ["no run for this sha", { ok: false, code: "no_run_for_sha" as const }],
    ["a cancelled/failed run", { ok: false, code: "not_successful" as const, conclusion: "cancelled" }],
    ["a stale green run", { ok: false, code: "stale" as const, ageHours: 200 }],
    ["no read token configured", { ok: false, code: "unverifiable" as const }],
  ] as Array<[string, Partial<CanaryVerificationResult>]>) {
    await check(`pre-deploy refuses ${label}`, async () => {
      const env = healthyEnv({ DEPLOY_BACKUP_REFERENCE: "b" });
      const deps = healthyDeps({ canaryRun: async () => canary(over) });
      const r = await evaluateReadiness({ mode: "predeploy", env, deps, expectedSha: GOOD_SHA, workerTimeoutMs: 500 });
      assert.notEqual(r.exitCode, 0, `${label} must not count as a green canary`);
    });
  }

  await check("the canary is verified against the EXPECTED sha, not any sha", async () => {
    const env = healthyEnv({ DEPLOY_BACKUP_REFERENCE: "b" });
    let asked: string | null = null;
    const deps = healthyDeps({
      canaryRun: async (sha: string) => {
        asked = sha;
        return canary({ sha });
      },
    });
    await evaluateReadiness({ mode: "predeploy", env, deps, expectedSha: GOOD_SHA, workerTimeoutMs: 500 });
    assert.equal(asked, GOOD_SHA, "the canary probe must be asked about the commit being shipped");
  });

  await check("pre-deploy does NOT require GitHub-only canary secrets in the container env", async () => {
    // The whole point: these live in GitHub Actions, not in Coolify.
    const env = healthyEnv({
      DEPLOY_BACKUP_REFERENCE: "b",
      CANARY_LLM_PROVIDER: undefined,
      CANARY_LLM_MODEL: undefined,
      CANARY_JUDGE_PROVIDER: undefined,
      CANARY_JUDGE_MODEL: undefined,
      CANARY_FISH_VOICE_A: undefined,
      CANARY_FISH_VOICE_B: undefined,
      CANARY_ELEVENLABS_VOICE_A: undefined,
      CANARY_ELEVENLABS_VOICE_B: undefined,
    });
    const r = await evaluateReadiness({ mode: "predeploy", env, deps: preDeployWorld(), expectedSha: GOOD_SHA, workerTimeoutMs: 500 });
    assert.equal(r.exitCode, 0, `container env must not need the workflow's own secrets: ${JSON.stringify(r.verdicts.predeployValidated)}`);
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
    // "Required by policy" now means NAMED in PRODUCTION_REQUIRED_TTS_PROVIDERS.
    const r = await evaluateReadiness({
      mode: "release",
      env: healthyEnv({ PRODUCTION_REQUIRED_TTS_PROVIDERS: "fish,elevenlabs" }),
      deps: healthyDeps({
        ttsProvider: async (p) => (p === "fish" ? okCred() : cred({ ok: false, code: "rejected", status: 401, detail: `${p} rejected` })),
      }),
      expectedSha: GOOD_SHA,
      workerTimeoutMs: 500,
    });
    assert.notEqual(r.exitCode, 0, "every provider the policy requires must authenticate");
  });

  await check("...but a failing OPTIONAL adapter does NOT refuse a Fish release", async () => {
    // The regression that refused release SHA 2172f718: ElevenLabs is a
    // supported adapter, not something production renders on.
    const r = await run("release", healthyDeps({
      ttsProvider: async (p) => (p === "fish" ? okCred() : cred({ ok: false, code: "rejected", status: 401, detail: `${p} rejected` })),
    }));
    assert.equal(r.exitCode, 0, `a Fish release must not be blocked by an adapter production does not use: ${JSON.stringify(r.verdicts.liveProvidersVerified)}`);
  });

  console.log("  -- canary evidence belongs to PRE-DEPLOY, not to the container --");
  // CONTRACT CHANGE. This used to assert that --release fails when the
  // CANARY_* variables are absent from the process environment. That was wrong
  // on two counts: those secrets belong to the GitHub workflow, and by release
  // time the canary question was already settled. The gate is now "was the
  // canary GREEN FOR THIS COMMIT", asked during pre-deploy.
  await check("a missing green canary refuses PRE-DEPLOY", async () => {
    const env = healthyEnv({ DEPLOY_BACKUP_REFERENCE: "b" });
    const deps = healthyDeps({ canaryRun: async () => canary({ ok: false, code: "no_run_for_sha" }) });
    const r = await evaluateReadiness({ mode: "predeploy", env, deps, expectedSha: GOOD_SHA, workerTimeoutMs: 500 });
    assert.notEqual(r.exitCode, 0, "deploying a commit with no green canary must be refused");
  });
  await check("config mode is not blocked by canary evidence", async () => {
    const r = await evaluateReadiness({ mode: "config", env: healthyEnv(), deps: healthyDeps(), expectedSha: null, workerTimeoutMs: 500 });
    assert.equal(r.exitCode, 0, "config mode must not require a canary run");
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

  // ---- routing-evidence freshness: reported, never enforced ---------------
  //
  // Stale evidence is a reason to re-measure, not a reason to stop shipping.
  // A staleness check that blocks a release gets suppressed within a week, and
  // a suppressed check is worse than no check — so this prints and moves on.
  // `npm run routing:staleness` is the same evaluation with a nonzero exit, for
  // anyone who wants it to be enforcing somewhere.
  console.log("\n  -- routing evidence freshness (WARNING only — never fails this suite) --");
  {
    const ages = currentRoutingStaleness();
    for (const age of ages) console.log(`  ${describeEvidenceAge(age)}`);
    const stale = ages.filter((a) => a.stale);
    if (stale.length) {
      console.log(
        `\n  WARNING: ${stale.length} of ${ages.length} routing-evidence sources are older than ` +
          `${STALENESS_LIMIT_DAYS} days. The assignments they justify are not wrong — nothing has\n` +
          `  re-checked them. Refresh with: ${[...new Set(stale.map((s) => s.source.refreshWith))].join(" ; ")}\n` +
          `  Run \`npm run routing:staleness\` for the full breakdown.`
      );
    } else {
      console.log(`\n  All ${ages.length} routing-evidence sources are within ${STALENESS_LIMIT_DAYS} days.`);
    }
  }

  console.log(
    failed === 0 ? "\nAll production readiness checks passed.\n" : `\n${failed} readiness check(s) FAILED.\n`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
