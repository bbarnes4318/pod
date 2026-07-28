// Proves prisma/seed.ts is idempotent and that retirement preserves the cast
// association of episodes that pinned a now-retired host.
//
// The seed is the only place the roster is defined, and a second run must land
// on byte-identical rows. The archive step also has to keep isActive true:
// resolveEpisodeCast looks a PINNED hostId up with `isActive: true` alone, and
// only the auto-fill roster additionally requires `isArchived: false`. A
// retired host that goes inactive drops out of the pinned lookup, and the
// episode quietly re-casts itself with the current roster.

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

async function main() {
  console.log("\nSeed idempotency + retirement safety\n");

  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-seed-pg-"));
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(tmpRoot, "data"),
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("seedcheck");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/seedcheck`;
  const env = { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" as const };
  execSync("npx prisma migrate deploy", { env, stdio: ["ignore", "pipe", "pipe"] });
  process.env.DATABASE_URL = dbUrl;

  const { db } = await import("../lib/db");

  const snapshot = async () => {
    const hosts = await db.aiHost.findMany({ orderBy: { slug: "asc" } });
    return hosts.map((h) => ({ ...h, createdAt: undefined, updatedAt: undefined }));
  };

  try {
    execSync("npx tsx prisma/seed.ts", { env, stdio: ["ignore", "pipe", "pipe"] });
    const first = await snapshot();

    await check("run 1 seeds exactly two active, unarchived hosts", async () => {
      const live = first.filter((h) => h.isActive && !h.isArchived);
      assert(live.length === 2, `expected 2 castable hosts, got ${live.length}`);
      const slugs = live.map((h) => h.slug).sort();
      assert(
        JSON.stringify(slugs) === JSON.stringify(["bernie-line-two", "cal-red-eye-mercer"]),
        `castable roster is ${slugs.join(", ")}`
      );
    });

    // Seating is decided by intensityLevel DESC (hostCasting.ts) plus an
    // explicit chair-A swap (hostCastingShared.ts). The gap is what pins Zabala
    // to seat A on every episode that does not pin hostIds — raising Mercer
    // above her would silently move him into chair A, so this is a structural
    // assertion, not a taste one.
    await check("seat order: Zabala intensity 8 outranks Mercer 5 by at least 2", async () => {
      const z = first.find((h) => h.slug === "bernie-line-two");
      const m = first.find((h) => h.slug === "cal-red-eye-mercer");
      assert(z?.intensityLevel === 8, `Zabala intensity is ${z?.intensityLevel}`);
      assert(m?.intensityLevel === 5, `Mercer intensity is ${m?.intensityLevel}`);
      assert(
        (z!.intensityLevel - m!.intensityLevel) >= 2,
        `chairs must differ by at least 2, got ${z!.intensityLevel} vs ${m!.intensityLevel}`
      );
    });

    // Mercer's restraint lives in the performance profile, NOT in
    // intensityLevel. A silently-derived profile (the failure mode when the
    // stored one does not parse) would read his rank rather than his style.
    // Pin the authored values — angerStyle in particular, because it is the
    // mechanical guarantee that his fury renders quieter instead of louder.
    await check("Mercer's authored performance profile survives the write", async () => {
      const m = first.find((h) => h.slug === "cal-red-eye-mercer");
      const p: any = m?.performanceProfile;
      assert(p && typeof p === "object", "Mercer has no stored performance profile");
      assert(p.angerStyle === "slower_quieter", `angerStyle is '${p.angerStyle}', expected slower_quieter`);
      assert(p.baselineIntensity === 4, `baselineIntensity is ${p.baselineIntensity}, expected 4`);
      assert(p.peakIntensity === 7, `peakIntensity is ${p.peakIntensity}, expected 7`);
      assert(p.baselineIntensity < p.peakIntensity, "he must open below his ceiling, not at it");
      assert(p.laughBehavior === "rare", `laughBehavior is '${p.laughBehavior}' — never a performed laugh`);
      assert(p.interruptionBehavior === "rare", `interruptionBehavior is '${p.interruptionBehavior}'`);
      assert(p.maxEscalationPace > p.baselinePace, "he may pick up slightly; he never slows to a crawl");
      assert(p.maxEscalationPace <= 1.15, `escalation ceiling ${p.maxEscalationPace} is a sprint, not a lean-in`);
      // The pair must not share a behavioral value where a contrast exists.
      const z: any = first.find((h) => h.slug === "bernie-line-two")?.performanceProfile;
      assert(z.angerStyle !== p.angerStyle, "both hosts share an anger signature — no acoustic separation");
      assert(z.preferredPauseStyle !== p.preferredPauseStyle, "both hosts share a pause style");
      assert(z.peakIntensity > p.peakIntensity, "seat B must not out-peak seat A");
    });

    await check("Mercer's voice is either a real 32-hex Fish id or the publish-blocking placeholder", async () => {
      const m = first.find((h) => h.slug === "cal-red-eye-mercer");
      assert(m?.ttsProvider === "fish", `provider is ${m?.ttsProvider}`);
      const v = m?.ttsVoiceId ?? "";
      const real = /^[0-9a-f]{32}$/i.test(v);
      const placeholder = /^PLACEHOLDER[_-]/i.test(v);
      assert(real || placeholder, `voice id '${v}' is neither a 32-hex Fish id nor a recognised placeholder`);
      // A placeholder must NOT look like a valid provider id, or the publish
      // gate would never see it and a wrong voice would ship.
      if (placeholder) assert(!real, "the placeholder must not be mistakable for a real reference id");
    });

    execSync("npx tsx prisma/seed.ts", { env, stdio: ["ignore", "pipe", "pipe"] });
    const second = await snapshot();

    await check("run 2 produces an identical roster", async () => {
      assert(
        JSON.stringify(second) === JSON.stringify(first),
        "second seed run changed the host rows"
      );
    });

    // Retirement safety: pin a retired host on an episode and confirm the cast
    // still resolves to that host rather than silently swapping in the roster.
    await check("an episode pinned to a retired host still resolves that host", async () => {
      const retired = await db.aiHost.create({
        data: {
          name: 'Otis "Laminate" Kemp',
          slug: "otis-laminate",
          role: "retired seat B",
          worldview: "w",
          speakingStyle: "s",
          catchphrases: [],
          likes: [],
          dislikes: [],
          argumentPatterns: [],
          bannedPhrases: [],
          intensityLevel: 6,
          ttsProvider: "fish",
          ttsVoiceId: "36780e7121b84d5c9c24cbd2f15eaaa4",
          isActive: true,
        },
      });
      execSync("npx tsx prisma/seed.ts", { env, stdio: ["ignore", "pipe", "pipe"] });

      const after = await db.aiHost.findUnique({ where: { id: retired.id } });
      assert(after?.isArchived === true, "retired host was not archived");
      assert(after?.isActive === true, "retired host was deactivated — pinned episodes would re-cast");

      const zabala = await db.aiHost.findUnique({ where: { slug: "bernie-line-two" } });
      const { resolveEpisodeHosts } = await import("../lib/services/hostCasting");
      const cast = await resolveEpisodeHosts({ hostIds: [zabala!.id, retired.id] });
      assert(cast.hostB.id === retired.id, `seat B resolved to ${cast.hostB.name}, losing the pin`);
    });

    await check("the retired host stays out of auto-casting", async () => {
      const { resolveEpisodeHosts } = await import("../lib/services/hostCasting");
      const cast = await resolveEpisodeHosts({ hostIds: [] });
      const slugs = [cast.hostA.slug, cast.hostB.slug].sort();
      assert(
        JSON.stringify(slugs) === JSON.stringify(["bernie-line-two", "cal-red-eye-mercer"]),
        `auto-cast picked ${slugs.join(", ")}`
      );
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
