// PRODUCTION READINESS PREFLIGHT
//
// One command that answers: "if I deploy this commit right now, will production
// ship episodes with its mandatory quality gates actually working?"
//
// This exists because the quality gates in this branch FAIL CLOSED. Meaning-aware
// audio QA now throws rather than reporting NOT_RUN and continuing, and the
// editorial gate refuses unmeasured scripts. Both are correct — and both turn a
// missing environment variable into a stalled pipeline. The remedy is not to
// weaken the gate or to set a waiver; it is to refuse to deploy into a
// configuration where the gate cannot run.
//
//   npm run verify:production-readiness          human-readable, exits nonzero on failure
//   npm run verify:production-readiness -- --json machine-readable for CI
//   npm run verify:production-readiness -- --skip-live   config only, no network
//
// SECRETS ARE NEVER PRINTED. Every check reports a variable NAME and a
// present/absent/invalid verdict. No check emits a value, a prefix, or a length
// that could narrow a secret.

import "dotenv/config";

type Status = "pass" | "fail" | "warn" | "skip";

interface Check {
  name: string;
  category:
    | "infrastructure"
    | "migrations"
    | "llm"
    | "quality-gates"
    | "tts"
    | "storage"
    | "queue"
    | "canary"
    | "deployment";
  status: Status;
  /** A mandatory check failing means production must not ship. */
  mandatory: boolean;
  detail: string;
  /** Variable NAMES only — never values. */
  missingVars?: string[];
}

const checks: Check[] = [];
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const skipLive = args.includes("--skip-live");

function add(c: Check) {
  checks.push(c);
}

/** Presence test that never reveals anything about the value. */
function present(name: string): boolean {
  return Boolean((process.env[name] || "").trim());
}

function missingOf(names: string[]): string[] {
  return names.filter((n) => !present(n));
}

const isProd = process.env.NODE_ENV === "production";

// ---------------------------------------------------------------------------
// 1. Infrastructure reachability
// ---------------------------------------------------------------------------
async function checkDatabase() {
  const missing = missingOf(["DATABASE_URL"]);
  if (missing.length) {
    return add({ name: "Database URL configured", category: "infrastructure", status: "fail", mandatory: true, detail: "DATABASE_URL is not set.", missingVars: missing });
  }
  if (skipLive) {
    return add({ name: "Database reachable", category: "infrastructure", status: "skip", mandatory: true, detail: "--skip-live" });
  }
  try {
    const { db } = await import("../lib/db");
    await db.$queryRaw`SELECT 1`;
    add({ name: "Database reachable", category: "infrastructure", status: "pass", mandatory: true, detail: "SELECT 1 succeeded." });
  } catch (err) {
    add({ name: "Database reachable", category: "infrastructure", status: "fail", mandatory: true, detail: `Connection failed: ${errText(err)}` });
  }
}

async function checkRedis() {
  const missing = missingOf(["REDIS_URL"]);
  if (missing.length) {
    return add({ name: "Redis URL configured", category: "infrastructure", status: "fail", mandatory: true, detail: "REDIS_URL is not set.", missingVars: missing });
  }
  if (skipLive) {
    return add({ name: "Redis reachable", category: "infrastructure", status: "skip", mandatory: true, detail: "--skip-live" });
  }
  try {
    const { getRedisClient } = await import("../lib/redis");
    const client = getRedisClient();
    const pong = await (client as unknown as { ping: () => Promise<string> }).ping();
    add({ name: "Redis reachable", category: "infrastructure", status: pong ? "pass" : "fail", mandatory: true, detail: `PING -> ${pong || "no reply"}` });
  } catch (err) {
    add({ name: "Redis reachable", category: "infrastructure", status: "fail", mandatory: true, detail: `Connection failed: ${errText(err)}` });
  }
}

// ---------------------------------------------------------------------------
// 2. Migration consistency
// ---------------------------------------------------------------------------
async function checkMigrations() {
  if (skipLive) {
    return add({ name: "Migrations applied", category: "migrations", status: "skip", mandatory: true, detail: "--skip-live" });
  }
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(process.cwd(), "prisma/migrations");
    const onDisk = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory())
      : [];

    const { db } = await import("../lib/db");
    const rows = await db.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null }>>(
      `SELECT migration_name, finished_at FROM "_prisma_migrations"`
    );
    const applied = new Set(rows.filter((r) => r.finished_at).map((r) => r.migration_name));
    const failed = rows.filter((r) => !r.finished_at).map((r) => r.migration_name);
    const pending = onDisk.filter((m) => !applied.has(m));

    if (failed.length) {
      add({ name: "Migrations applied", category: "migrations", status: "fail", mandatory: true, detail: `Migrations recorded but never finished: ${failed.join(", ")}.` });
    } else if (pending.length) {
      add({ name: "Migrations applied", category: "migrations", status: "fail", mandatory: true, detail: `${pending.length} migration(s) on disk not applied to this database: ${pending.join(", ")}. Run prisma migrate deploy on BOTH web and worker.` });
    } else {
      add({ name: "Migrations applied", category: "migrations", status: "pass", mandatory: true, detail: `${applied.size} migration(s) applied; none pending.` });
    }
  } catch (err) {
    add({ name: "Migrations applied", category: "migrations", status: "fail", mandatory: true, detail: `Could not read migration state: ${errText(err)}` });
  }
}

// ---------------------------------------------------------------------------
// 3. LLM credentials + production model routing
// ---------------------------------------------------------------------------
async function checkLlm() {
  // This project is Anthropic-only for LLMs; OpenAI is deliberately unfunded.
  const missing = missingOf(["ANTHROPIC_API_KEY"]);
  add({
    name: "LLM credential present",
    category: "llm",
    status: missing.length ? "fail" : "pass",
    mandatory: true,
    detail: missing.length ? "No LLM credential configured; no script can be written." : "ANTHROPIC_API_KEY is set.",
    missingVars: missing,
  });

  try {
    const { roleHasRealProvider, roleProviderLabel } = await import("../lib/providers/llm/routing");
    // The writer and the judge must not be the same route, or "independent"
    // judging is a fiction.
    const writer = roleProviderLabel("script_movement");
    const judge = roleProviderLabel("quality_judge");
    add({
      name: "Independent judge routed separately from writer",
      category: "llm",
      status: judge && writer && judge !== writer ? "pass" : "fail",
      mandatory: true,
      detail: `writer=${writer || "unresolved"} judge=${judge || "unresolved"}${judge === writer ? " — identical routes defeat independent judging." : ""}`,
    });
    add({
      name: "Quality judge has a real provider",
      category: "quality-gates",
      status: roleHasRealProvider("quality_judge") ? "pass" : "fail",
      mandatory: true,
      detail: roleHasRealProvider("quality_judge")
        ? "quality_judge resolves to a real provider."
        : "quality_judge resolves to a stub. A missing judge is a HOLD in production, so every script would stall.",
    });
  } catch (err) {
    add({ name: "Production model routing", category: "llm", status: "fail", mandatory: true, detail: `Routing could not be resolved: ${errText(err)}` });
  }
}

// ---------------------------------------------------------------------------
// 4. Mandatory quality gates
// ---------------------------------------------------------------------------
async function checkQualityGates() {
  // 4a. Meaning-aware transcript QA. THIS is the check that makes this branch
  // safe to deploy: audioSemanticQa now throws in production when it cannot run.
  try {
    const { resolveSemanticQaRequirement } = await import("../lib/audio/audioSemanticQa");
    const req = resolveSemanticQaRequirement();
    const waived = process.env.TTS_TRANSCRIPT_QA_WAIVED === "true";
    if (waived) {
      add({
        name: "Semantic transcript QA configured",
        category: "quality-gates",
        status: "fail",
        mandatory: true,
        detail:
          "TTS_TRANSCRIPT_QA_WAIVED=true. A waiver is not production semantic QA — it disables the only check " +
          "that verifies speaker attribution, names and numbers on rendered audio. Configure a transcript provider instead.",
      });
    } else if (req.missing.length) {
      add({
        name: "Semantic transcript QA configured",
        category: "quality-gates",
        status: "fail",
        mandatory: true,
        detail:
          "Meaning-aware audio QA cannot run. In production it fails closed, so final audio stitching WILL stop. " +
          "Configure these before deploying.",
        missingVars: req.missing,
      });
    } else {
      add({ name: "Semantic transcript QA configured", category: "quality-gates", status: "pass", mandatory: true, detail: `Enabled, provider=${req.provider}.` });
    }
  } catch (err) {
    add({ name: "Semantic transcript QA configured", category: "quality-gates", status: "fail", mandatory: true, detail: errText(err) });
  }

  // 4b. Editorial gate must be enforcing in production.
  try {
    const { resolveScriptEditorialGateMode } = await import("../lib/services/scriptEditorialGate");
    const mode = resolveScriptEditorialGateMode();
    add({
      name: "Editorial gate is enforcing",
      category: "quality-gates",
      status: mode === "hold" ? "pass" : isProd ? "fail" : "warn",
      mandatory: isProd,
      detail: `SCRIPT_EDITORIAL_GATE_MODE resolves to "${mode}". Production must resolve to "hold".`,
    });
  } catch (err) {
    add({ name: "Editorial gate is enforcing", category: "quality-gates", status: "fail", mandatory: true, detail: errText(err) });
  }

  // 4c. Rollout policy must be an explicit decision, not an accident.
  try {
    const { resolveGateEnforcementCutover, GATE_ENFORCEMENT_FROM_VAR } = await import("../lib/queue/rolloutPolicy");
    const cutover = resolveGateEnforcementCutover();
    const raw = (process.env[GATE_ENFORCEMENT_FROM_VAR] || "").trim();
    if (cutover) {
      add({ name: "Editorial-gate rollout cutover set", category: "quality-gates", status: "pass", mandatory: true, detail: `Scripts created before ${cutover.toISOString()} may finish without a verdict, attributably.` });
    } else if (raw) {
      add({ name: "Editorial-gate rollout cutover set", category: "quality-gates", status: "fail", mandatory: true, detail: `${GATE_ENFORCEMENT_FROM_VAR} is set but is not a parseable ISO 8601 instant.`, missingVars: [GATE_ENFORCEMENT_FROM_VAR] });
    } else {
      add({
        name: "Editorial-gate rollout cutover set",
        category: "quality-gates",
        status: "fail",
        mandatory: true,
        detail:
          `${GATE_ENFORCEMENT_FROM_VAR} is unset, so NO pre-existing script is grandfathered and any script ` +
          `written before this deploy will be refused at the TTS boundary. Set it to the deploy instant.`,
        missingVars: [GATE_ENFORCEMENT_FROM_VAR],
      });
    }
  } catch (err) {
    add({ name: "Editorial-gate rollout cutover set", category: "quality-gates", status: "fail", mandatory: true, detail: errText(err) });
  }

  // 4d. No standing global waiver may be in force.
  const bannedWaivers = ["SCRIPT_EDITORIAL_HOLD_OVERRIDE", "TTS_TRANSCRIPT_QA_WAIVED"];
  const active = bannedWaivers.filter((v) => (process.env[v] || "").trim() === "true");
  add({
    name: "No global quality waiver in force",
    category: "quality-gates",
    status: active.length ? "fail" : "pass",
    mandatory: true,
    detail: active.length ? `Global waiver(s) active: ${active.join(", ")}. Quality gates must not be disabled process-wide.` : "No global waiver set.",
    missingVars: active.length ? active : undefined,
  });
}

// ---------------------------------------------------------------------------
// 5. TTS credentials + voice model policy
// ---------------------------------------------------------------------------
async function checkTts() {
  const missing = missingOf(["FISH_API_KEY"]);
  add({
    name: "TTS provider credential present",
    category: "tts",
    status: missing.length ? "fail" : "pass",
    mandatory: true,
    detail: missing.length ? "No Fish credential; no speech can be rendered." : "FISH_API_KEY is set.",
    missingVars: missing,
  });
  try {
    const { resolveFishSceneModel } = await import("../lib/providers/tts/fishDialogue");
    const model = resolveFishSceneModel();
    add({
      name: "Fish scene model policy",
      category: "tts",
      status: model === "s2.1-pro-free" ? "pass" : "warn",
      mandatory: false,
      detail: `Resolved scene model is "${model}". Policy default is s2.1-pro-free; anything else must be a deliberate operator override.`,
    });
  } catch (err) {
    add({ name: "Fish scene model policy", category: "tts", status: "fail", mandatory: false, detail: errText(err) });
  }
}

// ---------------------------------------------------------------------------
// 6. Object storage
// ---------------------------------------------------------------------------
async function checkStorage() {
  const required = ["S3_BUCKET", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
  const missing = missingOf(required);
  if (missing.length) {
    return add({ name: "Object storage configured", category: "storage", status: "fail", mandatory: true, detail: "Storage credentials incomplete.", missingVars: missing });
  }
  if (skipLive) {
    return add({ name: "Object storage reachable", category: "storage", status: "skip", mandatory: true, detail: "--skip-live" });
  }
  try {
    const endpoint = (process.env.S3_ENDPOINT || "").trim();
    const res = await fetch(endpoint, { method: "HEAD" }).catch((e) => { throw e; });
    // Any HTTP reply proves reachability; auth is exercised by the real upload path.
    add({ name: "Object storage reachable", category: "storage", status: res ? "pass" : "fail", mandatory: true, detail: `Endpoint answered HTTP ${res?.status}.` });
  } catch (err) {
    add({ name: "Object storage reachable", category: "storage", status: "fail", mandatory: true, detail: `Endpoint unreachable: ${errText(err)}` });
  }
}

// ---------------------------------------------------------------------------
// 7. Worker queue consumption — is anything actually draining the queue?
// ---------------------------------------------------------------------------
async function checkQueueConsumption() {
  if (skipLive) {
    return add({ name: "Worker consuming production queue", category: "queue", status: "skip", mandatory: true, detail: "--skip-live" });
  }
  try {
    const { Queue } = await import("bullmq");
    const { getRedisClient } = await import("../lib/redis");
    const { PRODUCTION_QUEUE_NAME } = await import("../lib/queue/podcastQueue");
    const q = new Queue(PRODUCTION_QUEUE_NAME, { connection: getRedisClient() as never });
    const workers = await q.getWorkers();
    const counts = await q.getJobCounts("waiting", "active", "failed", "delayed");
    await q.close();
    const ok = workers.length > 0;
    add({
      name: "Worker consuming production queue",
      category: "queue",
      status: ok ? "pass" : "fail",
      mandatory: true,
      detail: ok
        ? `${workers.length} worker(s) attached; waiting=${counts.waiting} active=${counts.active} failed=${counts.failed}.`
        : `No worker is attached to "${PRODUCTION_QUEUE_NAME}". Jobs would queue forever. Deploy/restart the worker service.`,
    });
  } catch (err) {
    add({ name: "Worker consuming production queue", category: "queue", status: "fail", mandatory: true, detail: errText(err) });
  }
}

// ---------------------------------------------------------------------------
// 8. Canary configuration
// ---------------------------------------------------------------------------
async function checkCanary() {
  const required = [
    "CANARY_LLM_PROVIDER", "CANARY_LLM_MODEL", "CANARY_JUDGE_PROVIDER", "CANARY_JUDGE_MODEL",
    "ANTHROPIC_API_KEY", "FISH_API_KEY", "ELEVENLABS_API_KEY",
    "CANARY_FISH_VOICE_A", "CANARY_FISH_VOICE_B",
    "CANARY_ELEVENLABS_VOICE_A", "CANARY_ELEVENLABS_VOICE_B",
  ];
  const missing = missingOf(required);
  add({
    name: "Live-provider canary configured",
    category: "canary",
    status: missing.length ? "warn" : "pass",
    // Not mandatory for the app to RUN, but mandatory for the release process
    // to have any early warning. Reported loudly either way.
    mandatory: false,
    detail: missing.length
      ? `${missing.length} canary variable(s) unset. The scheduled canary cannot run, so provider/voice/quality drift will go undetected.`
      : "All canary variables present.",
    missingVars: missing.length ? missing : undefined,
  });
}

// ---------------------------------------------------------------------------
// 9. Deployment commit identity — is web running what you think it is?
// ---------------------------------------------------------------------------
async function checkDeploymentIdentity() {
  const candidates = ["GIT_COMMIT_SHA", "SOURCE_COMMIT", "COOLIFY_GIT_COMMIT_SHA", "VERCEL_GIT_COMMIT_SHA"];
  const found = candidates.find((v) => present(v));
  if (!found) {
    return add({
      name: "Deployment commit identity",
      category: "deployment",
      status: "fail",
      mandatory: true,
      detail:
        "No build-stamped commit variable is set, so there is no way to prove web and worker are running the " +
        "SAME tested commit. Stamp one at build time.",
      missingVars: candidates,
    });
  }
  const sha = (process.env[found] || "").trim();
  add({
    name: "Deployment commit identity",
    category: "deployment",
    status: "pass",
    mandatory: true,
    // A commit SHA is public information, not a secret.
    detail: `${found}=${sha.slice(0, 12)}. Compare this between the web and worker services; they must match.`,
  });
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Defensive: never let a connection string with embedded credentials escape.
  return msg.replace(/[a-z]+:\/\/[^\s]*@/gi, "<redacted>://");
}

async function main() {
  await checkDatabase();
  await checkRedis();
  await checkMigrations();
  await checkLlm();
  await checkQualityGates();
  await checkTts();
  await checkStorage();
  await checkQueueConsumption();
  await checkCanary();
  await checkDeploymentIdentity();

  const blocking = checks.filter((c) => c.mandatory && c.status === "fail");
  const skipped = checks.filter((c) => c.status === "skip");

  if (asJson) {
    console.log(JSON.stringify({ ok: blocking.length === 0, nodeEnv: process.env.NODE_ENV || null, checks, blocking: blocking.map((b) => b.name) }, null, 2));
  } else {
    console.log("\n==========================================================");
    console.log(" PRODUCTION READINESS PREFLIGHT");
    console.log(` NODE_ENV=${process.env.NODE_ENV || "(unset)"}${skipLive ? "   [--skip-live]" : ""}`);
    console.log("==========================================================\n");
    let category = "";
    for (const c of checks) {
      if (c.category !== category) {
        category = c.category;
        console.log(`  ${category.toUpperCase()}`);
      }
      const icon = c.status === "pass" ? "PASS" : c.status === "fail" ? (c.mandatory ? "FAIL" : "warn") : c.status === "warn" ? "warn" : "skip";
      console.log(`    [${icon}] ${c.name}`);
      if (c.detail) console.log(`           ${c.detail}`);
      if (c.missingVars?.length) console.log(`           missing: ${c.missingVars.join(", ")}`);
    }
    console.log("\n----------------------------------------------------------");
    if (blocking.length) {
      console.log(` NOT READY — ${blocking.length} mandatory check(s) failed:`);
      for (const b of blocking) console.log(`   - ${b.name}`);
      console.log("\n Deploying now would ship without a mandatory quality gate.");
    } else {
      console.log(" READY — every mandatory quality gate is configured and reachable.");
    }
    if (skipped.length) console.log(` (${skipped.length} live check(s) skipped via --skip-live)`);
    console.log("----------------------------------------------------------\n");
  }

  process.exit(blocking.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Readiness preflight crashed:", errText(err));
  process.exit(1);
});
