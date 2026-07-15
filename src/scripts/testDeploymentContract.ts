// Deployment contract test. Run: npm run test:deployment-contract
//
// THE RULE THIS PROTECTS — "single migration owner":
//   Exactly ONE release step runs `prisma migrate deploy`.
//   Web containers must NOT migrate on startup.
//   Worker containers must NOT migrate on startup.
//
// Why: the topic-lifecycle migration is a COORDINATED database/web/worker
// deploy (see prisma/migrations/20260714120000_topic_lifecycle_and_snapshots/
// SAFETY_REPORT.md). If the web and worker containers both migrate on boot they
// race each other as competing migration owners, and the migrated schema can be
// exposed to old code — which that report explicitly calls unsafe.
//
// This reads the REAL package.json / Dockerfile rather than restating a
// hardcoded copy of them, and asserts BEHAVIOUR (does this command migrate?),
// not formatting — whitespace and extra flags are fine.

import fs from "fs";
import path from "path";

let passed = 0, failed = 0;
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
function ok(n: string) { passed++; console.log(`  ✓ ${n}`); }
function bad(n: string, e: unknown) { failed++; console.error(`  ✗ ${n}\n      ${(e as Error)?.message || e}`); }

const RULE =
  "SINGLE MIGRATION OWNER: exactly one release step may run `prisma migrate deploy`.\n" +
  "      Application startup (web/worker/CMD/ENTRYPOINT) must never migrate — otherwise the\n" +
  "      web and worker containers race as competing migration owners.\n" +
  "      Run migrations once, from the dedicated release command: npm run prisma:migrate:deploy\n" +
  "      See prisma/migrations/20260714120000_topic_lifecycle_and_snapshots/SAFETY_REPORT.md";

const ROOT = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const scripts = pkg.scripts || {};

/** Does this shell command invoke a Prisma migration (in any usual spelling)? */
function invokesMigration(cmd: string): boolean {
  const c = cmd.toLowerCase();
  return (
    /\bprisma\s+migrate\b/.test(c) ||        // prisma migrate deploy|dev|reset
    /\bmigrate\s+deploy\b/.test(c) ||        // ... migrate deploy
    /\bprisma:migrate\b/.test(c)             // npm run prisma:migrate:deploy
  );
}

/** Expand `npm run x` / `yarn x` chains so an indirect migration is still caught. */
function resolvesToMigration(cmd: string, seen = new Set<string>()): boolean {
  if (invokesMigration(cmd)) return true;
  const refs = [...cmd.matchAll(/(?:npm\s+run|yarn|pnpm\s+run)\s+([\w:.-]+)/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const target = scripts[ref];
    if (target && resolvesToMigration(target, seen)) return true;
  }
  return false;
}

/** Production service-start commands that must never migrate. */
const START_SCRIPTS = ["start:web", "start:worker", "start", "worker"];

function run() {
  console.log("Deployment contract (single migration owner):");

  // ---- package.json: the web entrypoint ----
  try {
    assert(typeof scripts["start:web"] === "string", "package.json must define a `start:web` script");
    ok("package.json defines start:web");
  } catch (e) { bad("package.json defines start:web", e); }

  try {
    assert(!resolvesToMigration(scripts["start:web"] ?? ""),
      `start:web must not run migrations (got: "${scripts["start:web"]}").\n      ${RULE}`);
    ok("start:web starts the web app only — no prisma migrate / migrate deploy");
  } catch (e) { bad("start:web starts the web app only — no prisma migrate / migrate deploy", e); }

  // ---- package.json: the worker entrypoint ----
  try {
    assert(typeof scripts["start:worker"] === "string", "package.json must define a `start:worker` script");
    ok("package.json defines start:worker");
  } catch (e) { bad("package.json defines start:worker", e); }

  try {
    assert(!resolvesToMigration(scripts["start:worker"] ?? ""),
      `start:worker must not run migrations (got: "${scripts["start:worker"]}").\n      ${RULE}`);
    ok("start:worker starts the worker only — no prisma migrate / migrate deploy");
  } catch (e) { bad("start:worker starts the worker only — no prisma migrate / migrate deploy", e); }

  // ---- the ONE dedicated migration command ----
  try {
    const migrate = scripts["prisma:migrate:deploy"];
    assert(typeof migrate === "string", "package.json must define the dedicated `prisma:migrate:deploy` script");
    assert(/\bprisma\s+migrate\s+deploy\b/.test(migrate.toLowerCase()),
      `prisma:migrate:deploy must resolve to \`prisma migrate deploy\` (got: "${migrate}")`);
    ok("a dedicated release command exists: prisma:migrate:deploy -> prisma migrate deploy");
  } catch (e) { bad("a dedicated release command exists: prisma:migrate:deploy -> prisma migrate deploy", e); }

  // ---- exactly one owner: no OTHER script may migrate ----
  try {
    const migrators = Object.entries(scripts)
      .filter(([name, cmd]) => name !== "prisma:migrate:deploy" && invokesMigration(cmd))
      .map(([name, cmd]) => `${name}: "${cmd}"`);
    assert(migrators.length === 0,
      `only prisma:migrate:deploy may run a migration; also found:\n      ${migrators.join("\n      ")}\n      ${RULE}`);
    ok("no competing migration command — prisma:migrate:deploy is the single owner");
  } catch (e) { bad("no competing migration command — prisma:migrate:deploy is the single owner", e); }

  // ---- no service-start command combines startup with migration ----
  try {
    const offenders = START_SCRIPTS
      .filter((n) => typeof scripts[n] === "string" && resolvesToMigration(scripts[n]))
      .map((n) => `${n}: "${scripts[n]}"`);
    assert(offenders.length === 0,
      `these service-start commands combine app startup with migration:\n      ${offenders.join("\n      ")}\n      ${RULE}`);
    ok("no production service-start command combines app startup with migration");
  } catch (e) { bad("no production service-start command combines app startup with migration", e); }

  // ---- Dockerfile: CMD/ENTRYPOINT must not migrate, and the build must not either ----
  const dockerfilePath = path.join(ROOT, "Dockerfile");
  try {
    assert(fs.existsSync(dockerfilePath), "Dockerfile must exist");
    const lines = fs.readFileSync(dockerfilePath, "utf8").split(/\r?\n/);

    const startLines = lines.filter((l) => /^\s*(CMD|ENTRYPOINT)\b/i.test(l));
    assert(startLines.length > 0, "Dockerfile must declare a CMD or ENTRYPOINT");
    for (const line of startLines) {
      assert(!invokesMigration(line), `Dockerfile CMD/ENTRYPOINT must not run a migration: "${line.trim()}"\n      ${RULE}`);
      // It may reference an npm script — that script must not migrate either.
      const ref = line.match(/["\s](?:run)["\s,]+["']?([\w:.-]+)/)?.[1];
      if (ref && scripts[ref]) {
        assert(!resolvesToMigration(scripts[ref]),
          `Dockerfile CMD runs "npm run ${ref}", which migrates: "${scripts[ref]}"\n      ${RULE}`);
      }
    }
    ok("Dockerfile CMD/ENTRYPOINT does not run a migration (directly or via its npm script)");
  } catch (e) { bad("Dockerfile CMD/ENTRYPOINT does not run a migration (directly or via its npm script)", e); }

  try {
    const lines = fs.readFileSync(dockerfilePath, "utf8").split(/\r?\n/);
    const buildMigrations = lines.filter((l) => /^\s*RUN\b/i.test(l) && invokesMigration(l));
    assert(buildMigrations.length === 0,
      `image build must not run migrations:\n      ${buildMigrations.map((l) => l.trim()).join("\n      ")}\n      ${RULE}`);
    ok("Docker image build does not run migrations (prisma generate is fine)");
  } catch (e) { bad("Docker image build does not run migrations (prisma generate is fine)", e); }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`\nDEPLOYMENT CONTRACT VIOLATED.\n      ${RULE}`);
    process.exit(1);
  }
}
run();
