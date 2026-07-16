// Seeds a temporary Postgres with the exact brief-corruption shapes the repair
// command must handle, runs the audit in DRY RUN, asserts it changed nothing,
// then runs --apply and asserts it repaired only what was invalid.
//
// Run via: npm run test:repair-fixture   (spins up its own throwaway database)

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

async function main() {
  console.log("\nRepair command — fixtures on a throwaway Postgres\n");

  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-repair-pg-"));
  const dataDir = path.join(tmpRoot, "data");
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password: "postgres", port, persistent: false });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase("repair");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/repair`;
  const env = { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" as const };

  try {
    // Build the schema from scratch with `db push`, exactly as the Playwright
    // harness does (tests/e2e/global-setup.ts).
    //
    // NOT `migrate deploy`, and that is a pre-existing repo fact worth naming:
    // there is no BASELINE migration. The history starts at
    // 20260705000000_add_episode_tts_provider, which ALTERs "Episode" — a table
    // no migration ever creates. So `migrate deploy` against an empty database
    // fails with `relation "Episode" does not exist`, and no fixture can prove
    // "applies from all 18 migrations" until a baseline exists. `db push`
    // reproduces the same final schema, which is what these fixtures need.
    execSync("npx prisma db push --skip-generate --accept-data-loss", { env, stdio: "ignore" });

    const { PrismaClient } = await import("@prisma/client");
    const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

    // --- Fixtures -------------------------------------------------------
    const news = await db.newsItem.create({
      data: { title: "Real article", source: "Wire", url: "https://wire.test/a", publishedAt: new Date(), entities: [], raw: {} },
    });
    const mk = async (id: string, sourceIds: unknown, facts: unknown = [{ text: "f", evidenceRefs: [{ type: "newsItem", id: news.id }] }]) => {
      const t = await db.topicCandidate.create({
        data: {
          id, title: `Topic ${id}`, sport: "NFL", controversyScore: 1, starPowerScore: 1, bettingRelevanceScore: 1,
          recencyScore: 1, debateScore: 80, evidenceIds: [{ type: "newsItem", id: news.id }], status: "approved",
        },
      });
      await db.researchBrief.create({
        data: {
          topicId: t.id, facts: facts as object[], stats: [], argumentForHostA: "A", argumentForHostB: "B",
          counterArguments: [], unsafeClaims: [], sourceIds: sourceIds as object[],
        },
      });
      return t;
    };

    const valid = await mk("fx-valid", [{ type: "newsItem", id: news.id }]);
    const selfCited = await mk("fx-self", [{ type: "topic", id: "fx-self" }]);
    const missing = await mk("fx-missing", [{ type: "newsItem", id: "00000000-0000-0000-0000-000000000000" }]);
    const unsupported = await mk("fx-unsupported", [{ type: "vibes", id: "x" }]);
    const dupes = await mk("fx-dupes", [{ type: "newsItem", id: news.id }, { type: "newsItem", id: news.id }]);
    const mixed = await mk("fx-mixed", [{ type: "newsItem", id: news.id }, { type: "topic", id: "fx-mixed" }]);
    const nogrounding = await mk("fx-nogrounding", [{ type: "research", id: "research-1" }], [{ text: "f", evidenceRefs: [] }]);

    // An episode whose snapshot must never be touched.
    const ep = await db.episode.create({ data: { title: "Frozen", slug: "frozen-ep", status: "published" } });
    const frozen = { version: 1, source: "creation", title: "Frozen topic", sourceIds: [{ type: "topic", id: valid.id }] };
    await db.episodeTopic.create({ data: { episodeId: ep.id, topicId: valid.id, orderIndex: 0, snapshot: frozen } });

    const before = await db.researchBrief.findMany({ orderBy: { topicId: "asc" } });
    const snapBefore = await db.episodeTopic.findFirst({ where: { episodeId: ep.id } });

    // --- DRY RUN --------------------------------------------------------
    const dry = execSync("npx tsx --conditions=react-server src/scripts/repairResearchEvidence.ts", { env, encoding: "utf8" });
    console.log(dry.split("\n").filter((l) => /\.{3}|inspected|INELIGIBLE|DRY RUN/.test(l)).join("\n"));

    check("dry run reports every corruption class", () => {
      assert(/briefs inspected \.+ 7/.test(dry), "should inspect all 7 briefs");
      assert(/already valid \.+ 1/.test(dry), "fx-valid should be the only clean one");
      assert(/cite the topic itself \.+ 2/.test(dry), "fx-self + fx-mixed cite themselves");
      assert(/reference missing records \.+ 1/.test(dry), "fx-missing has a dangling ref");
      assert(/unsupported \/ malformed refs \.+ 1/.test(dry), "fx-unsupported has a bogus type");
      assert(/transient research refs \.+ 1/.test(dry), "fx-nogrounding is research-only");
      assert(/duplicate refs \.+ 1/.test(dry), "fx-dupes has a repeat");
    });

    check("dry run identifies topics that would become ineligible", () => {
      // Only fx-nogrounding. The other corrupt briefs each cite a REAL newsItem
      // in their facts, so rebuilding from accepted claims recovers a genuine
      // source — repairing them without inventing anything. Only the brief with
      // nothing real behind it loses eligibility, which is the honest outcome:
      // it was never grounded, the old length-only gate just couldn't tell.
      assert(/would become INELIGIBLE: 1/.test(dry), `expected 1 (fx-nogrounding), got:\n${dry.match(/INELIGIBLE.*/)?.[0]}`);
      assert(/DRY RUN — nothing was written/.test(dry), "it must say it changed nothing");
    });

    const afterDry = await db.researchBrief.findMany({ orderBy: { topicId: "asc" } });
    check("CORE: a dry run leaves every brief byte-identical", () => {
      assert(JSON.stringify(before) === JSON.stringify(afterDry), "a dry run must not write");
    });

    // --- APPLY ----------------------------------------------------------
    const applied = execSync("npx tsx --conditions=react-server src/scripts/repairResearchEvidence.ts -- --apply", { env, encoding: "utf8" });
    assert(/Applied: rebuilt sourceIds/.test(applied), "apply should report what it did");

    const get = async (id: string) => (await db.researchBrief.findUnique({ where: { topicId: id } }))!;

    // Compare by CONTENT, not by serialized string: Postgres jsonb normalizes
    // object key order, so {type,id} comes back as {id,type} and a string
    // compare would fail on a row nothing touched.
    const sameRefs = (a: unknown, b: unknown) => {
      const norm = (v: unknown) => (Array.isArray(v) ? v.map((r) => `${(r as { type: string }).type}:${(r as { id: string }).id}`).sort().join("|") : String(v));
      return norm(a) === norm(b);
    };
    const vb = await get(valid.id);
    check("apply leaves an already-valid brief untouched", () => {
      assert(sameRefs(vb.sourceIds, [{ type: "newsItem", id: news.id }]), `valid brief was altered: ${JSON.stringify(vb.sourceIds)}`);
      assert(!JSON.stringify(vb.sourceIds).includes('"topic"'), "nothing bogus should appear");
    });

    const sb = await get(selfCited.id);
    check("CORE: the topic-self reference is removed and NOT replaced with an invention", () => {
      assert(!JSON.stringify(sb.sourceIds).includes(selfCited.id), "the self-citation must be gone");
      // The brief cites a real newsItem in its facts, so the rebuild recovers it.
      assert(JSON.stringify(sb.sourceIds).includes(news.id), "a genuinely cited source should be recovered from the facts");
    });

    const mb = await get(missing.id);
    check("a dangling reference is removed", () => {
      assert(!JSON.stringify(mb.sourceIds).includes("00000000"), "the missing ref must be dropped");
    });

    const ub = await get(unsupported.id);
    check("an unsupported reference is removed", () => {
      assert(!JSON.stringify(ub.sourceIds).includes("vibes"), "the bogus type must be dropped");
    });

    const db2 = await get(dupes.id);
    check("duplicates are collapsed", () => {
      assert((db2.sourceIds as unknown[]).length === 1, `expected 1 after dedupe, got ${(db2.sourceIds as unknown[]).length}`);
    });

    const mx = await get(mixed.id);
    check("a mixed list keeps the valid ref and drops the invalid one", () => {
      assert(JSON.stringify(mx.sourceIds).includes(news.id), "the real ref must survive");
      assert(!JSON.stringify(mx.sourceIds).includes("topic"), "the self-citation must go");
    });

    const ng = await get(nogrounding.id);
    check("CORE: with nothing valid, apply leaves it EMPTY rather than inventing a source", () => {
      assert((ng.sourceIds as unknown[]).length === 0, `expected an empty list, got ${JSON.stringify(ng.sourceIds)}`);
    });

    const factsAfter = await get(selfCited.id);
    check("apply never edits facts — only sourceIds", () => {
      assert(JSON.stringify(factsAfter.facts).includes("evidenceRefs"), "the editorial record must be left alone");
    });

    const snapAfter = await db.episodeTopic.findFirst({ where: { episodeId: ep.id } });
    check("CORE: an existing episode snapshot is NOT rewritten", () => {
      assert(JSON.stringify(snapAfter!.snapshot) === JSON.stringify(snapBefore!.snapshot), "a published episode's frozen evidence must never be edited");
      assert(JSON.stringify(snapAfter!.snapshot).includes("topic"), "even a snapshot containing the old fallback stays as it was — history is not rewritten");
    });

    const eps = await db.episode.count();
    check("apply deletes no episodes", () => { assert(eps === 1, `expected the episode to survive, got ${eps}`); });

    await db.$disconnect();
  } finally {
    await pg.stop().catch(() => {});
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
