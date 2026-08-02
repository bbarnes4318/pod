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
// WHY THIS WAS REWRITTEN. The previous version reported things it had not
// proven and then printed a single word, READY:
//
//   - object storage    an unauthenticated `fetch(S3_ENDPOINT, {method:"HEAD"})`
//                       and ANY HTTP reply counted as proof. A rejected key and
//                       a bucket that never existed both passed.
//   - worker            `getWorkers().length > 0` — registered CONNECTIONS, not
//                       consumption. A wedged worker passed.
//   - commit identity   passed if ANY sha-ish variable existed. It never
//                       compared web to worker, or either to an expected sha.
//   - LLM / semantic QA "a key is present". Never called anything.
//   - TTS               Fish only, while policy requires more engines.
//   - canary            a warning, while the command still said READY.
//   - --skip-live       printed the same unqualified READY as a full run.
//
// FOUR VERDICTS, NEVER COLLAPSED:
//
//   code/configuration ready | infrastructure reachable |
//   live providers verified  | RELEASE ACCEPTED
//
//   npm run verify:production-readiness             config only (default)
//   npm run verify:production-readiness -- --live   + infrastructure + providers
//   npm run verify:production-readiness -- --release --expect-sha <sha>
//   npm run verify:production-readiness -- --json   machine-readable
//
// SECRETS ARE NEVER PRINTED. Every check reports a variable NAME and a
// present/absent/rejected verdict. No check emits a value, a prefix, or a length
// that could narrow a secret, and every rendered string passes the scrubber.

import "dotenv/config";

import {
  WORKER_HEALTH_TIMEOUT_MS,
  createLiveDependencies,
  errText,
  evaluateReadiness,
  renderReport,
  scrubSecrets,
  serializeReport,
  type ReadinessMode,
} from "../lib/services/readinessProbes";

interface Cli {
  mode: ReadinessMode;
  asJson: boolean;
  expectSha: string | null;
  workerTimeoutMs: number;
}

function parseArgs(argv: string[]): Cli {
  const asJson = argv.includes("--json");

  // `--skip-live` predates the four verdicts. It is kept as an explicit alias
  // for config mode so an existing CI invocation keeps working — and it now
  // gets the same qualified verdict as `--config`, never a bare READY.
  const release = argv.includes("--release");
  const live = argv.includes("--live");
  const mode: ReadinessMode = release ? "release" : live ? "live" : "config";

  const shaIndex = argv.indexOf("--expect-sha");
  const expectSha = shaIndex >= 0 && argv[shaIndex + 1] ? argv[shaIndex + 1].trim() : null;

  const timeoutIndex = argv.indexOf("--worker-timeout-ms");
  const parsedTimeout = timeoutIndex >= 0 && argv[timeoutIndex + 1] ? Number(argv[timeoutIndex + 1]) : NaN;
  const workerTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : WORKER_HEALTH_TIMEOUT_MS;

  return { mode, asJson, expectSha, workerTimeoutMs };
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const deps = await createLiveDependencies();

  const report = await evaluateReadiness({
    mode: cli.mode,
    env: process.env,
    deps,
    expectedSha: cli.expectSha,
    workerTimeoutMs: cli.workerTimeoutMs,
  });

  if (cli.asJson) {
    console.log(JSON.stringify(serializeReport(report, process.env), null, 2));
  } else {
    console.log(renderReport(report, process.env));
  }

  process.exit(report.exitCode);
}

main().catch((err) => {
  console.error("Readiness preflight crashed:", scrubSecrets(errText(err), process.env));
  process.exit(1);
});
