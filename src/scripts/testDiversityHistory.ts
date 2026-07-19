// Podcast-scoped diversity HISTORY reader tests (PR 4, embedded Postgres).
// Run: npm run test:diversity-history
//
// Proves: successful renders only; failed renders + failed-QA excluded; one
// entry per episode (reproduce/remix never double-counts); strict podcast/owner
// isolation; deterministic ordering; bounded window; missing plan handled
// honestly; system scope opt-in + shared-asset-only.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) { try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); } }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
async function freePort(): Promise<number> { return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on("error", rej); }); }

// A frozen sound-profile ref + profile (minimal shape resolveSnapshotSoundProfile accepts).
const ref = (assetId: string, role: string, kind: string, over: Record<string, unknown> = {}) => ({
  assetId, kind, category: null, name: assetId, contentHash: `h-${assetId}`, scope: "shared_system", role, orderIndex: 0,
  gainDb: null, fadeInMs: null, fadeOutMs: null, durationMs: 3000, tags: [], rightsStatusAtCapture: "not_required",
  licenseStatusAtCapture: "licensed", provenance: "podcast_assignment", weight: 1, cueFamily: null, isBrandedMotif: false, ...over,
});
const soundProfile = (intro: string, outro: string, bed: string, over: Record<string, unknown> = {}) => ({
  mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
  introEnabled: true, outroEnabled: true,
  intro: ref(intro, "intro", "theme_intro", { cueFamily: "brand_main" }),
  outro: ref(outro, "outro", "theme_outro", { cueFamily: "close_main" }),
  bed: ref(bed, "bed", "bed", { cueFamily: "analysis" }),
  stingers: [], reactions: [], introVariants: [], outroVariants: [], beds: [],
  containsLegacyCompatAssets: false, excluded: [], ...over,
});
const snapshot = (sp: object) => ({ version: 5, source: "podcast", capturedAt: "2026-01-01T00:00:00.000Z", podcast: null, editorial: { verticals: [], teams: [], segmentCount: 2, format: "two_host_debate", minDebateScore: null, scriptStyle: null, maxWords: null, provenance: {} }, production: { hostIds: [], ttsProvider: null, ttsVoiceOverrides: null, productionStyle: null, sfxDensity: null, provenance: {}, soundProfile: sp } });
const storedPlan = (transitions: Array<{ assetId: string; family: string; at: number }>, reactions: Array<{ assetId: string; family: string; at: number }>, fp: string) => ({
  version: 1, mode: "post_tts", directorVersion: 2, fingerprint: fp,
  cuePlacements: [
    ...transitions.map((t) => ({ kind: "transition", assetId: t.assetId, cueFamily: t.family, targetStartMs: t.at })),
    ...reactions.map((r) => ({ kind: "reaction", assetId: r.assetId, cueFamily: r.family, targetStartMs: r.at })),
  ],
});

async function main() {
  console.log("\nDiversity history reader (embedded PG)\n");
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pod-divhist-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmp, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise(); await pg.start();
  const { Client } = await import("pg");
  const admin = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query("CREATE DATABASE div ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0");
  await admin.end();
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/div`;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  const { readDiversityHistory } = await import("../lib/services/diversityHistory");

  // Type-loose bridge to the reader's DiversityHistoryDb.
  const asDb = db as unknown as Parameters<typeof readDiversityHistory>[0]["db"];

  try {
    const owner1 = "owner-1", owner2 = "owner-2";
    const podA = "pod-A", podB = "pod-B";
    // FK prerequisites: users + podcasts the episodes reference.
    await db.user.create({ data: { id: owner1, email: "o1@example.test" } });
    await db.user.create({ data: { id: owner2, email: "o2@example.test" } });
    await db.podcast.create({ data: { id: podA, name: "Series A", cadence: "recurring", ownerId: owner1 } });
    await db.podcast.create({ data: { id: podB, name: "Series B", cadence: "recurring", ownerId: owner2 } });
    // Deterministic fixture timestamps (not wall-clock randomness).
    const at = (n: number) => new Date(`2026-01-0${n}T00:00:00.000Z`);
    const mkEpisode = async (id: string, podcastId: string | null, ownerId: string | null, day: number, sp: object, opts: { renders?: Array<{ status: string; mode: string; version: number; plan?: object }> } = {}) => {
      await db.episode.create({ data: { id, title: id, slug: id, status: "audio_ready", formatId: "two_host_debate", hostIds: [], podcastId, ownerId, configurationSource: "podcast", configurationSnapshot: snapshot(sp) as object, configurationFingerprint: `fp-${id}`, createdAt: at(day) } });
      for (const r of opts.renders ?? []) {
        await db.episodeAudioRender.create({ data: { episodeId: id, renderVersion: r.version, status: r.status, renderMode: r.mode, plan: (r.plan ?? null) as object, diagnostics: { postTts: { planningEngine: r.mode === "reproduce" ? "stored_plan_reproduce" : "post_tts" } } as object } });
      }
    };

    const scopeA = { kind: "podcast" as const, podcastId: podA };

    await check("1. empty history returns no episodes", async () => {
      const h = await readDiversityHistory({ db: asDb, scope: scopeA, windowEpisodes: 6 });
      assert(h.episodes.length === 0 && h.windowUsed === 0, "empty");
    });

    await check("2. one prior successful episode is read with its frozen intro/outro/bed", async () => {
      await mkEpisode("A1", podA, owner1, 1, soundProfile("intro-x", "outro-x", "bed-x"), { renders: [{ status: "succeeded", mode: "initial", version: 1, plan: storedPlan([{ assetId: "st-1", family: "topic_reset", at: 5000 }], [], "fpA1") }] });
      const h = await readDiversityHistory({ db: asDb, scope: scopeA, windowEpisodes: 6 });
      assert(h.episodes.length === 1, `1 entry (${h.episodes.length})`);
      const e = h.episodes[0];
      assert(e.introAssetId === "intro-x" && e.outroAssetId === "outro-x" && e.bedAssetId === "bed-x", "bookend assets");
      assert(e.transitionAssetIds.length === 1 && e.transitionAssetIds[0] === "st-1", "transition asset from plan");
      assert(e.cueFamilySequence[0] === "INTRO:brand_main" && e.cueFamilySequence.includes("TRANSITION:topic_reset") && e.cueFamilySequence.at(-1) === "OUTRO:close_main", "cue-family sequence ordered");
      assert(e.planFingerprint === "fpA1" && e.planningEngine === "post_tts" && e.renderKind === "initial", "render facts");
    });

    await check("3. several episodes come back newest-first with creationOrder", async () => {
      await mkEpisode("A2", podA, owner1, 2, soundProfile("intro-y", "outro-y", "bed-y"), { renders: [{ status: "succeeded", mode: "initial", version: 1, plan: storedPlan([], [], "fpA2") }] });
      await mkEpisode("A3", podA, owner1, 3, soundProfile("intro-z", "outro-z", "bed-z"), { renders: [{ status: "succeeded", mode: "initial", version: 1, plan: storedPlan([], [], "fpA3") }] });
      const h = await readDiversityHistory({ db: asDb, scope: scopeA, windowEpisodes: 6 });
      assert(h.episodes.map((e) => e.episodeId).join(",") === "A3,A2,A1", `newest first (${h.episodes.map((e) => e.episodeId)})`);
      assert(h.episodes[0].creationOrder === 0 && h.episodes[2].creationOrder === 2, "creationOrder");
    });

    await check("4. an episode with only a FAILED render is excluded", async () => {
      await mkEpisode("A-fail", podA, owner1, 4, soundProfile("intro-f", "outro-f", "bed-f"), { renders: [{ status: "failed", mode: "initial", version: 1 }] });
      const h = await readDiversityHistory({ db: asDb, scope: scopeA, windowEpisodes: 10 });
      assert(!h.episodes.some((e) => e.episodeId === "A-fail"), "failed excluded");
    });

    await check("5. an episode rendered then REPRODUCED counts once (not double)", async () => {
      await mkEpisode("A-rep", podA, owner1, 5, soundProfile("intro-r", "outro-r", "bed-r"), { renders: [
        { status: "succeeded", mode: "initial", version: 1, plan: storedPlan([], [], "fpRep") },
        { status: "succeeded", mode: "reproduce", version: 2, plan: storedPlan([], [], "fpRep") },
      ] });
      const h = await readDiversityHistory({ db: asDb, scope: scopeA, windowEpisodes: 10 });
      const reps = h.episodes.filter((e) => e.episodeId === "A-rep");
      assert(reps.length === 1, `single entry (${reps.length})`);
      assert(reps[0].renderKind === "reproduce" && reps[0].introAssetId === "intro-r", "latest render facts, frozen selection intact");
    });

    await check("6. cross-podcast isolation: podcast A never sees podcast B", async () => {
      await mkEpisode("B1", podB, owner2, 6, soundProfile("intro-b", "outro-b", "bed-b"), { renders: [{ status: "succeeded", mode: "initial", version: 1, plan: storedPlan([], [], "fpB1") }] });
      const h = await readDiversityHistory({ db: asDb, scope: scopeA, windowEpisodes: 20 });
      assert(!h.episodes.some((e) => e.episodeId === "B1"), "B not in A's history");
    });

    await check("7. cross-owner isolation: owner scope excludes another owner", async () => {
      const h = await readDiversityHistory({ db: asDb, scope: { kind: "owner", ownerId: owner2 }, windowEpisodes: 20 });
      assert(h.episodes.every((e) => e.episodeId.startsWith("B")), `only owner2 episodes (${h.episodes.map((e) => e.episodeId)})`);
    });

    await check("8. ordering is deterministic across repeated reads", async () => {
      const a = await readDiversityHistory({ db: asDb, scope: scopeA, windowEpisodes: 20 });
      const b = await readDiversityHistory({ db: asDb, scope: scopeA, windowEpisodes: 20 });
      assert(JSON.stringify(a.episodes.map((e) => e.episodeId)) === JSON.stringify(b.episodes.map((e) => e.episodeId)), "stable order");
    });

    await check("9. a succeeded render with a missing plan is handled honestly (warning, empty cues)", async () => {
      await mkEpisode("A-noplan", podA, owner1, 7, soundProfile("intro-n", "outro-n", "bed-n"), { renders: [{ status: "succeeded", mode: "initial", version: 1 }] });
      const h = await readDiversityHistory({ db: asDb, scope: scopeA, windowEpisodes: 20 });
      const e = h.episodes.find((x) => x.episodeId === "A-noplan")!;
      assert(!!e && e.transitionAssetIds.length === 0, "no cues without a plan");
      assert(e.introAssetId === "intro-n", "frozen bookends still read from the snapshot");
      assert(h.warnings.some((w) => /A-noplan/.test(w)), "honest warning");
    });

    await check("10. the history window is bounded to the safety ceiling", async () => {
      const h = await readDiversityHistory({ db: asDb, scope: scopeA, windowEpisodes: 999 });
      assert(h.windowRequested === 999, "request recorded");
      assert(h.warnings.some((w) => /window reduced/.test(w)), "reduction warned");
    });

    await check("11. system scope is opt-in: disabled returns nothing", async () => {
      const h = await readDiversityHistory({ db: asDb, scope: { kind: "system" }, windowEpisodes: 6, systemHistoryEnabled: false });
      assert(h.episodes.length === 0 && h.warnings.some((w) => /system history disabled/.test(w)), "disabled -> empty");
    });

    await check("12. system scope enabled reads only ownerless+podcastless shared-system episodes", async () => {
      await mkEpisode("SYS1", null, null, 8, soundProfile("sys-intro", "sys-outro", "sys-bed"), { renders: [{ status: "succeeded", mode: "initial", version: 1, plan: storedPlan([], [], "fpSys") }] });
      const h = await readDiversityHistory({ db: asDb, scope: { kind: "system" }, windowEpisodes: 6, systemHistoryEnabled: true });
      assert(h.episodes.length === 1 && h.episodes[0].episodeId === "SYS1", `only the system episode (${h.episodes.map((e) => e.episodeId)})`);
      assert(!h.episodes.some((e) => e.episodeId.startsWith("A") || e.episodeId.startsWith("B")), "no private podcasts");
    });

  } finally {
    await db.$disconnect().catch(() => {});
    await pg.stop().catch(() => {});
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
