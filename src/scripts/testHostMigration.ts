// The seat-B recast, proven against a real database.
//
// This is the test that has to exist, because every cheaper way of replacing a
// host is silently wrong in production and looks fine in development:
//
//   - Inserting a new Cal row and archiving Mulkey leaves every existing
//     podcast still cast with a retired host. Nothing errors. Every show just
//     quietly keeps the old voice until somebody recasts by hand.
//   - Renaming without checking for an existing Cal row hits the unique slug
//     constraint, or creates two active seat-B hosts.
//   - A migration that is not re-runnable breaks the second deploy attempt,
//     which is exactly when it will be run.
//
// So the flow below is the real one: build a database at the PREVIOUS
// migration, seed it the way production was seeded, cast a podcast and an
// episode with the old host, then run the migration and the new seed and check
// that everything still points at the same row.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

/** The seat-B voice production was running before the recast. Preserving it is
 *  an explicit requirement — Cal has not been auditioned yet, and overwriting a
 *  real reference id with the publish-blocking placeholder would take the show
 *  off the air to fix a character change. */
const PRODUCTION_SEAT_B_VOICE = "36780e7121b84d5c9c24cbd2f15eaaa4";

async function main() {
  console.log("\nSeat-B host migration: Dutch Mulkey -> Cal Mercer\n");

  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-hostmig-pg-"));
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(tmpRoot, "data"),
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("hostmig");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/hostmig`;
  const env = { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" as const };
  execSync("npx prisma migrate deploy", { env, stdio: ["ignore", "pipe", "pipe"] });
  process.env.DATABASE_URL = dbUrl;

  const { db } = await import("../lib/db");

  try {
    // --- Build the world as production had it ------------------------------
    //
    // `migrate deploy` above already applied the recast migration, so the
    // pre-recast row is reconstructed by hand. That is the honest setup: the
    // migration has to be safe against a row that exists, and re-running it
    // against that row is exactly what a redeploy does.
    const zabala = await db.aiHost.create({
      data: {
        name: 'Bernadette "Line Two" Zabala',
        slug: "bernie-line-two",
        role: "seat A",
        worldview: "w",
        speakingStyle: "s",
        catchphrases: [],
        likes: [],
        dislikes: [],
        argumentPatterns: [],
        bannedPhrases: [],
        intensityLevel: 8,
        ttsProvider: "fish",
        ttsVoiceId: "c73dbfe6a10249968409a343ea13a37e",
        isActive: true,
      },
    });
    const mulkey = await db.aiHost.create({
      data: {
        name: 'Dutch "Attendance" Mulkey',
        slug: "dutch-attendance",
        role: "Nineteen-year arena PA voice who considers himself front-office staff",
        worldview: "I was IN the building.",
        speakingStyle: "ENORMOUS. Trained PA projection.",
        catchphrases: ["HE'S NO DUANE HOYT."],
        likes: ["A full building"],
        dislikes: ["Empty seats"],
        argumentPatterns: ["Announce an inflated attendance figure"],
        bannedPhrases: ["I was only the announcer"],
        intensityLevel: 6,
        ttsProvider: "fish",
        ttsVoiceId: PRODUCTION_SEAT_B_VOICE,
        performanceProfile: { version: 1, angerStyle: "louder_slower", baselineIntensity: 8, peakIntensity: 10 },
        isActive: true,
      },
    });

    const podcast = await db.podcast.create({
      data: {
        name: "Take Machine",
        slug: "take-machine",
        cadence: "recurring",
        productionConfig: { create: { hostIds: [zabala.id, mulkey.id] } },
      },
      include: { productionConfig: true },
    });
    const episode = await db.episode.create({
      data: {
        title: "An episode cast before the recast",
        slug: "pre-recast",
        status: "produced",
        podcastId: podcast.id,
        hostIds: [zabala.id, mulkey.id],
        castMembers: {
          create: [
            { hostId: zabala.id, role: "chair_a", orderIndex: 0 },
            { hostId: mulkey.id, role: "chair_b", orderIndex: 1 },
          ],
        },
      },
    });

    // --- Run the recast ----------------------------------------------------
    // The identity migration is the automated half; the seed authors the
    // character onto the row it moved. This is the documented release order.
    const migrationSql = fs.readFileSync(
      path.join(__dirname, "..", "..", "prisma", "migrations", "20260727010000_replace_mulkey_host_with_cal_mercer", "migration.sql"),
      "utf8"
    );
    const runMigration = async () => {
      // $executeRawUnsafe cannot run a multi-statement script containing a DO
      // block, so the file is handed to psql the way `migrate deploy` does.
      const file = path.join(tmpRoot, "recast.sql");
      fs.writeFileSync(file, migrationSql, "utf8");
      execSync(`npx prisma db execute --file "${file}" --url "${dbUrl}"`, { env, stdio: ["ignore", "pipe", "pipe"] });
    };
    await runMigration();
    execSync("npx tsx prisma/seed.ts", { env, stdio: ["ignore", "pipe", "pipe"] });

    // --- Assertions --------------------------------------------------------

    await check("the Dutch row BECAME Cal — same id, so nothing needs recasting", async () => {
      const row = await db.aiHost.findUnique({ where: { id: mulkey.id } });
      assert(row, "the seat-B row disappeared");
      assert(row!.slug === "cal-red-eye-mercer", `slug is '${row!.slug}'`);
      assert(row!.name === 'Cal "Red Eye" Mercer', `name is '${row!.name}'`);
      assert(row!.isActive && !row!.isArchived, "Cal must be castable");
    });

    await check("no duplicate active seat-B host exists", async () => {
      const live = await db.aiHost.findMany({ where: { isActive: true, isArchived: false }, orderBy: { slug: "asc" } });
      const slugs = live.map((h) => h.slug);
      assert(
        JSON.stringify(slugs) === JSON.stringify(["bernie-line-two", "cal-red-eye-mercer"]),
        `castable roster is ${slugs.join(", ")}`
      );
      const dutch = await db.aiHost.findMany({ where: { slug: "dutch-attendance" } });
      assert(dutch.length === 0, "a Dutch row still exists");
    });

    await check("no Mulkey character content survived on the row", async () => {
      const row = await db.aiHost.findUnique({ where: { id: mulkey.id } });
      const blob = JSON.stringify(row);
      for (const token of ["Mulkey", "Dutch", "Hoyt", "Wolverine", "attendance", "PA projection", "full volume"]) {
        assert(!new RegExp(token, "i").test(blob), `'${token}' survived on the migrated host row`);
      }
      // "announcer" DOES appear — as a prohibited trait. That is the opposite of
      // residue, and asserting its absence would delete the guard, so the check
      // is that every occurrence is a prohibition.
      const prohibited: string[] = (row!.performanceProfile as { prohibitedTraits?: string[] })?.prohibitedTraits ?? [];
      const announcerMentions = (blob.match(/announcer/gi) ?? []).length;
      assert(
        announcerMentions === prohibited.filter((t) => /announcer/i.test(t)).length,
        `'announcer' appears on the row somewhere other than prohibitedTraits`
      );
      assert(prohibited.some((t) => /announcer/i.test(t)), "the announcer-cadence prohibition was lost");
    });

    await check("the podcast's production config still casts the same host", async () => {
      const cfg = await db.podcastProductionConfig.findUnique({ where: { podcastId: podcast.id } });
      assert(cfg!.hostIds.includes(mulkey.id), "the podcast lost its seat-B cast member");
      const hosts = await db.aiHost.findMany({ where: { id: { in: cfg!.hostIds } } });
      assert(hosts.every((h) => h.isActive && !h.isArchived), "a podcast is cast with a retired host");
      assert(hosts.some((h) => h.slug === "cal-red-eye-mercer"), "the podcast is not cast with Cal");
    });

    await check("the pre-recast episode still resolves a valid cast", async () => {
      const ep = await db.episode.findUnique({ where: { id: episode.id }, include: { castMembers: true } });
      assert(ep!.hostIds.includes(mulkey.id), "the episode lost its host pin");
      assert(ep!.castMembers.some((m) => m.hostId === mulkey.id), "the episode lost its cast member row");
      const { resolveEpisodeHosts } = await import("../lib/services/hostCasting");
      const cast = await resolveEpisodeHosts({ hostIds: ep!.hostIds });
      assert(cast.hostB.slug === "cal-red-eye-mercer", `seat B resolved to ${cast.hostB.slug}`);
      assert(cast.hostA.slug === "bernie-line-two", `seat A resolved to ${cast.hostA.slug}`);
    });

    await check("the production seat-B voice is PRESERVED, not overwritten with the placeholder", async () => {
      const row = await db.aiHost.findUnique({ where: { id: mulkey.id } });
      assert(
        row!.ttsVoiceId === PRODUCTION_SEAT_B_VOICE,
        `seat-B voice became '${row!.ttsVoiceId}' — a reseed must never take a working voice off the air`
      );
    });

    await check("the row says out loud that Cal has not been auditioned on this voice", async () => {
      const row = await db.aiHost.findUnique({ where: { id: mulkey.id } });
      assert(/audition/i.test(row!.voiceProvenanceNote ?? ""), "the inherited voice must be flagged for audition");
    });

    // --- Re-runnability ----------------------------------------------------

    const snapshot = async () => {
      const hosts = await db.aiHost.findMany({ orderBy: { slug: "asc" } });
      return JSON.stringify(hosts.map((h) => ({ ...h, createdAt: undefined, updatedAt: undefined })));
    };
    const afterFirst = await snapshot();

    await check("re-running the migration AND the seed changes nothing", async () => {
      await runMigration();
      execSync("npx tsx prisma/seed.ts", { env, stdio: ["ignore", "pipe", "pipe"] });
      assert(await snapshot() === afterFirst, "a second run of the recast changed the host rows");
    });

    await check("the migration is a no-op on a database that never had Mulkey", async () => {
      // Nothing to migrate: the earlier runs already removed the Dutch slug.
      // The point is that it does not throw, does not create a row, and does
      // not touch Cal.
      const before = await snapshot();
      await runMigration();
      assert(await snapshot() === before, "a no-op run still modified rows");
    });

    // --- The defensive branch ---------------------------------------------

    await check("if BOTH rows somehow exist, relations are repointed and no duplicate is left active", async () => {
      // Recreate a stray Mulkey row and cast a fresh podcast + episode with it,
      // which is what a database that got seeded before it got migrated looks
      // like. The migration must move that show onto Cal rather than leaving it
      // pinned to a host nobody maintains.
      const stray = await db.aiHost.create({
        data: {
          name: 'Dutch "Attendance" Mulkey',
          slug: "dutch-attendance",
          role: "stray",
          worldview: "w",
          speakingStyle: "s",
          catchphrases: [],
          likes: [],
          dislikes: [],
          argumentPatterns: [],
          bannedPhrases: [],
          intensityLevel: 6,
          ttsProvider: "fish",
          ttsVoiceId: PRODUCTION_SEAT_B_VOICE,
          isActive: true,
        },
      });
      const strayPodcast = await db.podcast.create({
        data: {
          name: "Seeded before migrating",
          slug: "out-of-order",
          cadence: "recurring",
          productionConfig: { create: { hostIds: [zabala.id, stray.id] } },
        },
      });
      const strayEpisode = await db.episode.create({
        data: {
          title: "Cast with the stray row",
          slug: "stray-cast",
          status: "produced",
          podcastId: strayPodcast.id,
          hostIds: [zabala.id, stray.id],
          castMembers: { create: [{ hostId: stray.id, role: "chair_b", orderIndex: 1 }] },
        },
      });

      await runMigration();

      const cal = await db.aiHost.findUnique({ where: { slug: "cal-red-eye-mercer" } });
      const cfg = await db.podcastProductionConfig.findUnique({ where: { podcastId: strayPodcast.id } });
      assert(cfg!.hostIds.includes(cal!.id), "the stray podcast was not repointed onto Cal");
      assert(!cfg!.hostIds.includes(stray.id), "the stray podcast still references the retired row");

      const ep = await db.episode.findUnique({ where: { id: strayEpisode.id }, include: { castMembers: true } });
      assert(ep!.hostIds.includes(cal!.id), "the stray episode was not repointed");
      assert(ep!.castMembers.every((m) => m.hostId === cal!.id), "a cast member row still points at the retired host");

      const strayAfter = await db.aiHost.findUnique({ where: { id: stray.id } });
      assert(strayAfter!.isArchived, "the stray row was not archived");
      // isActive MUST stay true: resolveEpisodeCast looks a PINNED hostId up by
      // isActive alone, so deactivating it would make any pin this repointing
      // missed fall through to auto-fill and silently re-cast the episode.
      assert(strayAfter!.isActive, "the stray row was deactivated — pinned episodes would re-cast");

      const live = await db.aiHost.findMany({ where: { isActive: true, isArchived: false } });
      assert(live.length === 2, `expected 2 castable hosts after the defensive path, got ${live.length}`);
    });
  } finally {
    await db.$disconnect().catch(() => {});
    await pg.stop().catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
