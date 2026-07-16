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

  // =====================================================================
  // MIGRATION HISTORY INTEGRITY
  //
  // The repository must be able to rebuild its own database. It could not:
  // the history began by ALTERing "Episode", a table no migration created, so
  // `migrate deploy` against an empty database failed outright. These guard
  // the baseline that fixed it.
  // =====================================================================

  const migrationsDir = path.join(process.cwd(), "prisma", "migrations");
  const migrationDirs = fs.readdirSync(migrationsDir).filter((d) => fs.statSync(path.join(migrationsDir, d)).isDirectory()).sort();

  try {
    assert(migrationDirs.length > 0, "no migrations found");
    assert(migrationDirs[0] === "20260704000000_baseline",
      `the baseline must sort FIRST — every later migration assumes its tables exist. Earliest is "${migrationDirs[0]}".`);
    ok("exactly one baseline sorts before every incremental migration");
  } catch (e) { bad("exactly one baseline sorts before every incremental migration", e); }

  try {
    // A second "baseline" would be ambiguous: which one does a fresh database
    // start from, and which does an adoption plan mark applied?
    const baselines = migrationDirs.filter((d) => /baseline/i.test(d));
    assert(baselines.length === 1, `expected exactly 1 baseline migration, found ${baselines.length}: ${baselines.join(", ")}`);
    ok("there is exactly one baseline migration");
  } catch (e) { bad("there is exactly one baseline migration", e); }

  try {
    // The baseline must be the PRE-first-migration schema, not a snapshot of
    // today's. If it were the latter, every later migration would try to
    // re-create what already exists and a fresh deploy would fail on
    // duplicates instead of missing relations.
    const sql = fs.readFileSync(path.join(migrationsDir, "20260704000000_baseline", "migration.sql"), "utf8");
    assert(!/CREATE TABLE "Podcast"/.test(sql), 'the baseline must NOT create "Podcast" — 20260706150000 does');
    assert(!/CREATE TABLE "TopicSource"/.test(sql), 'the baseline must NOT create "TopicSource" — 20260715160000 does');
    assert(!/CREATE TABLE "AdminDraft"/.test(sql), 'the baseline must NOT create "AdminDraft" — 20260715140000 does');
    assert(!/CREATE TYPE "TopicEditorialStatus"/.test(sql), "the baseline must NOT create the status enum — 20260714120000 does");
    assert(/CREATE TABLE "Episode"/.test(sql), 'the baseline MUST create "Episode" — that missing table is the whole bug');
    ok("the baseline is the pre-first-migration schema, not a copy of the current one");
  } catch (e) { bad("the baseline is the pre-first-migration schema, not a copy of the current one", e); }

  try {
    // A migration.sql must be encodable in the CLIENT ENCODING, or the whole
    // migration fails to apply — not on the SQL, on a comment. Postgres clients
    // on Windows negotiate WIN1252, where a character like "->" (U+2192) has no
    // representation and produces:
    //   ERROR: character with byte sequence 0xe2 0x86 0x92 in encoding "UTF8"
    //          has no equivalent in encoding "WIN1252"
    //
    // The rule is representability, not plain ASCII: an em-dash (U+2014) IS in
    // WIN1252 at 0x97 and applies fine, and one of the existing migrations
    // legitimately uses one. Checking for ASCII would fail that file for no
    // reason and tempt someone to edit a migration that already shipped.
    const WIN1252_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
    const encodable = (c: string) => {
      const cp = c.codePointAt(0)!;
      if (cp <= 0x7f) return true;                    // ASCII
      if (cp >= 0xa0 && cp <= 0xff) return true;      // Latin-1 supplement
      return WIN1252_EXTRA.includes(c);               // the 0x80-0x9F specials
    };
    for (const d of migrationDirs) {
      const p = path.join(migrationsDir, d, "migration.sql");
      if (!fs.existsSync(p)) continue;
      const bad = [...fs.readFileSync(p, "utf8")].filter((c) => !encodable(c));
      assert(bad.length === 0,
        `${d}/migration.sql contains ${JSON.stringify([...new Set(bad)].slice(0, 3))}, which cannot be encoded in a WIN1252 client and will make the migration fail to apply`);
    }
    ok("every migration.sql is encodable in the client encoding (applies on any platform)");
  } catch (e) { bad("every migration.sql is encodable in the client encoding (applies on any platform)", e); }

  try {
    // db push syncs a schema WITHOUT recording history — it is what left this
    // project unable to rebuild itself. It is a local convenience only.
    const offenders = Object.entries(scripts).filter(([name, cmd]) =>
      /prisma\s+db\s+push/.test(String(cmd)) && !/^test:|^e2e|^dev/.test(name));
    assert(offenders.length === 0,
      `these non-test scripts use \`db push\`, which must never touch production/staging: ${offenders.map(([n]) => n).join(", ")}`);
    const df = fs.readFileSync(dockerfilePath, "utf8");
    assert(!/db\s+push/.test(df), "the Dockerfile must never run `prisma db push`");
    ok("no production script or image uses `prisma db push`");
  } catch (e) { bad("no production script or image uses `prisma db push`", e); }

  try {
    // `migrate resolve` records a CLAIM that a migration ran. Automating it in
    // a deploy path would let a release silently certify work that never
    // happened — exactly what the adoption auditor exists to prevent.
    const autoResolve = Object.entries(scripts).filter(([name, cmd]) =>
      /migrate\s+resolve/.test(String(cmd)) && !/^test:|^audit:/.test(name));
    assert(autoResolve.length === 0,
      `these scripts run \`migrate resolve\`, which silently marks migrations applied: ${autoResolve.map(([n]) => n).join(", ")}`);
    const df = fs.readFileSync(dockerfilePath, "utf8");
    assert(!/migrate\s+resolve/.test(df), "the Dockerfile must never run `migrate resolve`");
    ok("no deployment command silently marks a migration applied");
  } catch (e) { bad("no deployment command silently marks a migration applied", e); }

  try {
    // The auditor runs against databases nobody trusts yet. It must be inert.
    const src = fs.readFileSync(path.join(process.cwd(), "src", "scripts", "auditMigrationAdoption.ts"), "utf8");
    assert(!/execSync\([^)]*migrate\s+resolve/.test(src), "the auditor must never EXECUTE migrate resolve (printing it in a plan is fine)");
    assert(!/execSync\([^)]*migrate\s+deploy/.test(src), "the auditor must never EXECUTE migrate deploy");
    assert(!/execSync\([^)]*db\s+push/.test(src), "the auditor must never EXECUTE db push");
    assert(!/\$executeRaw/.test(src), "the auditor must never run a write query");
    assert(/PROPOSED ONLY -- NOT EXECUTED/.test(src), "the auditor's plan must be labelled as proposed only");
    ok("the migration-adoption auditor is read-only");
  } catch (e) { bad("the migration-adoption auditor is read-only", e); }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`\nDEPLOYMENT CONTRACT VIOLATED.\n      ${RULE}`);
    process.exit(1);
  }
}
run();
