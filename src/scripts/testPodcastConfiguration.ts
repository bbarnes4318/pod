// Canonical podcast-configuration resolver + snapshot tests.
//   Run: npm run test:podcast-configuration
//
// Two layers:
//   1. PURE — slug rules, precedence/provenance, standalone isolation, format /
//      provider / host validation, fingerprint determinism, and the hard rule
//      that a snapshot never carries ownerEmail. No database, no providers.
//   2. DB — load (the compatibility adapter), and save with optimistic
//      concurrency (compare-and-swap on configVersion, one increment, conflict,
//      slug uniqueness, owner isolation, no partial writes). Embedded Postgres,
//      migrated with `prisma migrate deploy`. No LLM/TTS/network calls.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

import {
  slugifyPodcastName,
  validateSlug,
  resolveEpisodeConfiguration,
  fingerprintPodcastConfiguration,
  loadPodcastConfiguration,
  savePodcastConfiguration,
  type LoadedPodcastConfiguration,
} from "../lib/services/podcastConfiguration";
import {
  buildEpisodeConfigurationSnapshot,
  fingerprintEpisodeSnapshot,
} from "../lib/services/episodeConfigurationSnapshot";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

function baseConfig(over: Partial<LoadedPodcastConfiguration> = {}): LoadedPodcastConfiguration {
  return {
    id: "pod-1",
    ownerId: "owner-1",
    configVersion: 3,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    identity: {
      name: "The Debate Desk", slug: "the-debate-desk", description: "Hot takes.",
      author: "Studio", ownerName: "Jamie Owner", ownerEmail: "secret@owner.example",
      websiteUrl: "https://example.test", language: "en", category: "Sports", subcategory: "Football",
      explicit: false, copyright: "(c) 2026", coverImageUrl: "https://example.test/cover.png", visibility: "public",
    },
    editorial: { verticals: ["NFL"], teams: ["team-1"], segmentCount: 5, format: "two_host_debate", minDebateScore: 60, scriptStyle: "punchy", maxWords: 4000 },
    production: {
      hostIds: ["host-a", "host-b"], ttsProvider: "elevenlabs", ttsVoiceOverrides: null, productionStyle: "full", sfxDensity: "medium",
      soundProfileMode: "system_default", targetLoudnessLufs: null, cooldownScope: "podcast",
      stingerCooldownEpisodes: null, reactionCooldownEpisodes: null, defaultIntroEnabled: true, defaultOutroEnabled: true,
      soundAssignments: [],
    },
    publishing: { autoGenerateChapters: true, autoGenerateShowNotes: true, autoGenerateCover: true, includeTranscript: true, downloadsEnabled: true },
    usedLegacyFallback: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// PURE tests
// ---------------------------------------------------------------------------
async function pureTests() {
  console.log("\nPure: slugs, precedence, provenance, validation, fingerprints\n");

  await check("slugify normalizes case, spaces, punctuation and diacritics", () => {
    assert(slugifyPodcastName("The Bést Show!!") === "the-best-show", `got ${slugifyPodcastName("The Bést Show!!")}`);
    assert(slugifyPodcastName("  Multiple   Spaces  ") === "multiple-spaces", "collapses spaces");
  });

  await check("validateSlug rejects empty, too-short, bad chars, and reserved names", () => {
    assert(!validateSlug("").ok, "empty rejected");
    assert(!validateSlug("ab").ok, "too short rejected");
    assert(!validateSlug("Bad Slug").ok, "spaces/upper rejected");
    const admin = validateSlug("admin");
    assert(!admin.ok && admin.error === "slug_reserved", "reserved rejected");
    assert(validateSlug("cool-show").ok, "valid accepted");
  });

  await check("PODCAST episode precedence: override > podcast > default, with provenance", () => {
    const r = resolveEpisodeConfiguration({
      podcast: baseConfig(),
      overrides: { verticals: ["NBA"] }, // override editorial.verticals only
    });
    assert(r.ok, "resolves");
    if (!r.ok) return;
    assert(JSON.stringify(r.resolved.editorial.verticals.value) === JSON.stringify(["NBA"]), "override wins");
    assert(r.resolved.editorial.verticals.provenance === "episode_override", "override provenance");
    // Untouched fields inherit from the podcast with 'podcast' provenance.
    assert(r.resolved.editorial.segmentCount.value === 5, "inherits segmentCount");
    assert(r.resolved.editorial.segmentCount.provenance === "podcast", "podcast provenance");
    assert(r.resolved.production.hostIds.provenance === "podcast", "hosts from podcast");
    assert(r.resolved.source === "podcast", "source podcast");
    assert(r.resolved.podcastConfigurationVersion === 3, "captures version");
  });

  await check("STANDALONE never inherits any podcast values", () => {
    const r = resolveEpisodeConfiguration({ podcast: null, overrides: { segmentCount: 4 } });
    assert(r.ok, "resolves");
    if (!r.ok) return;
    assert(r.resolved.source === "standalone", "standalone source");
    assert(r.resolved.podcastId === null && r.resolved.podcastConfigurationVersion === null, "no podcast linkage");
    assert(r.resolved.editorial.segmentCount.value === 4 && r.resolved.editorial.segmentCount.provenance === "episode_override", "override applied");
    // A field the episode did NOT set falls to the SYSTEM default, never a podcast.
    assert(r.resolved.production.hostIds.value.length === 0 && r.resolved.production.hostIds.provenance === "system_default", "no host inheritance");
    assert(r.resolved.identity === null, "no identity for standalone");
  });

  await check("empty-array override is treated as 'not provided' (inherits), matching legacy behaviour", () => {
    const r = resolveEpisodeConfiguration({ podcast: baseConfig(), overrides: { verticals: [] } });
    assert(r.ok && JSON.stringify(r.resolved.editorial.verticals.value) === JSON.stringify(["NFL"]), "empty array does not override");
  });

  await check("resolution validates the FINAL value: an unsupported inherited format is rejected", () => {
    const bad = baseConfig({ editorial: { ...baseConfig().editorial, format: "solo_monologue" } });
    const r = resolveEpisodeConfiguration({ podcast: bad, overrides: {} });
    assert(!r.ok && r.error.code === "unsupported_format", "unsupported format rejected");
  });

  await check("resolution rejects unknown provider, bad style, and >2 hosts", () => {
    const r1 = resolveEpisodeConfiguration({ podcast: null, overrides: { ttsProvider: "nope" } });
    assert(!r1.ok && r1.error.code === "unknown_tts_provider", "provider");
    const r2 = resolveEpisodeConfiguration({ podcast: null, overrides: { productionStyle: "sparkle" } });
    assert(!r2.ok && r2.error.code === "invalid_production_style", "style");
    const r3 = resolveEpisodeConfiguration({ podcast: null, overrides: { hostIds: ["a", "b", "c"] } });
    assert(!r3.ok && r3.error.code === "too_many_hosts", "host cap");
  });

  await check("podcast fingerprint is deterministic and excludes ownerEmail", () => {
    const a = fingerprintPodcastConfiguration(baseConfig());
    const b = fingerprintPodcastConfiguration(baseConfig({ updatedAt: new Date("2030-09-09T00:00:00Z") }));
    assert(a === b, "timestamp does not affect fingerprint");
    // Changing only ownerEmail must NOT change the fingerprint (it is excluded).
    const c = fingerprintPodcastConfiguration(baseConfig({ identity: { ...baseConfig().identity, ownerEmail: "different@x.example" } }));
    assert(a === c, "ownerEmail excluded from fingerprint");
    // Changing a real setting MUST change it.
    const d = fingerprintPodcastConfiguration(baseConfig({ editorial: { ...baseConfig().editorial, segmentCount: 9 } }));
    assert(a !== d, "a real setting change moves the fingerprint");
  });

  await check("SNAPSHOT carries no ownerEmail/ownerName and is deterministic (fingerprint excludes capturedAt)", () => {
    const r = resolveEpisodeConfiguration({ podcast: baseConfig(), overrides: {} });
    assert(r.ok, "resolves"); if (!r.ok) return;
    const s1 = buildEpisodeConfigurationSnapshot(r.resolved, new Date("2026-01-01T00:00:00Z"));
    const s2 = buildEpisodeConfigurationSnapshot(r.resolved, new Date("2027-05-05T00:00:00Z"));
    const json = JSON.stringify(s1.configurationSnapshot);
    assert(!json.includes("secret@owner.example"), "ownerEmail must never appear in a snapshot");
    assert(!json.includes("Jamie Owner"), "ownerName must never appear in a snapshot");
    assert(s1.configurationFingerprint === s2.configurationFingerprint, "fingerprint independent of capturedAt");
    assert(fingerprintEpisodeSnapshot(s1.configurationSnapshot) === s1.configurationFingerprint, "fingerprint reproducible");
    assert(s1.configurationSource === "podcast" && s1.podcastConfigurationVersion === 3, "source + version captured");
    // Provenance is recorded per field.
    assert(s1.configurationSnapshot.editorial.provenance.segmentCount === "podcast", "provenance recorded");
  });
}

// ---------------------------------------------------------------------------
// DB tests
// ---------------------------------------------------------------------------
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

async function dbTests() {
  console.log("\nDB: compatibility adapter + optimistic-concurrency save\n");
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-cfg-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("cfg");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/cfg`;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  try {
    // Seed an owner + a podcast WITH its three config rows (as the app would).
    const owner = await db.user.create({ data: { email: "o@x.test", name: "Owner", passwordHash: "x" } });
    const other = await db.user.create({ data: { email: "e@x.test", name: "Enemy", passwordHash: "x" } });
    const pod = await db.podcast.create({
      data: {
        name: "Config Show", cadence: "recurring", slug: "config-show",
        verticals: ["NFL"], teams: [], segmentCount: 4, hostIds: ["h1", "h2"], ownerId: owner.id,
        editorialConfig: { create: { verticals: ["NFL"], teams: [], segmentCount: 4 } },
        productionConfig: { create: { hostIds: ["h1", "h2"] } },
        publishingConfig: { create: {} },
      },
    });

    await check("loadPodcastConfiguration reads the config rows (no legacy fallback)", async () => {
      const cfg = await loadPodcastConfiguration(db, pod.id);
      assert(!!cfg, "loaded");
      assert(cfg!.editorial.segmentCount === 4 && cfg!.production.hostIds.length === 2, "reads config-table values");
      assert(cfg!.usedLegacyFallback === false, "no fallback when rows present");
      assert(cfg!.configVersion === 1, "starts at version 1");
    });

    await check("adapter falls back to legacy columns when a config row is missing", async () => {
      // Simulate a not-yet-backfilled podcast: row with legacy columns, no configs.
      const legacy = await db.podcast.create({ data: { name: "Legacy", cadence: "one_time", slug: "legacy-x", verticals: ["NBA"], segmentCount: 7, hostIds: ["z"] } });
      const cfg = await loadPodcastConfiguration(db, legacy.id);
      assert(!!cfg && cfg!.usedLegacyFallback === true, "fallback flagged");
      assert(cfg!.editorial.segmentCount === 7 && JSON.stringify(cfg!.editorial.verticals) === JSON.stringify(["NBA"]), "reads legacy columns");
      assert(JSON.stringify(cfg!.production.hostIds) === JSON.stringify(["z"]), "legacy hostIds");
    });

    await check("save increments configVersion EXACTLY once and persists all sections", async () => {
      const before = (await db.podcast.findUnique({ where: { id: pod.id } }))!.configVersion;
      const res = await savePodcastConfiguration({
        db, podcastId: pod.id, expectedVersion: before,
        canEdit: (p) => p.ownerId === owner.id,
        input: {
          identity: { name: "Config Show", slug: "config-show", ownerEmail: "owner@x.test", visibility: "public" },
          editorial: { verticals: ["NFL", "NBA"], segmentCount: 6 },
          production: { hostIds: ["h1", "h2"], ttsProvider: "fish" },
          publishing: { downloadsEnabled: false },
        },
      });
      assert(res.ok, `save ok: ${JSON.stringify(res)}`);
      if (!res.ok) return;
      assert(res.configVersion === before + 1, `version bumped once: ${before} -> ${res.configVersion}`);
      const reloaded = await loadPodcastConfiguration(db, pod.id);
      assert(reloaded!.editorial.segmentCount === 6, "editorial saved");
      assert(reloaded!.production.ttsProvider === "fish", "production saved");
      assert(reloaded!.publishing.downloadsEnabled === false, "publishing saved");
      assert(reloaded!.identity.visibility === "public", "identity saved");
    });

    await check("stale expectedVersion is a structured conflict, and writes NOTHING", async () => {
      const current = (await db.podcast.findUnique({ where: { id: pod.id } }))!;
      const res = await savePodcastConfiguration({
        db, podcastId: pod.id, expectedVersion: current.configVersion - 1, // stale
        canEdit: () => true,
        input: { identity: { name: "SHOULD NOT LAND", slug: "config-show" } },
      });
      assert(!res.ok && res.error.code === "podcast_configuration_changed", "conflict returned");
      const after = (await db.podcast.findUnique({ where: { id: pod.id } }))!;
      assert(after.name !== "SHOULD NOT LAND", "no partial write on conflict");
      assert(after.configVersion === current.configVersion, "version unchanged on conflict");
    });

    await check("another account cannot edit (owner isolation)", async () => {
      const current = (await db.podcast.findUnique({ where: { id: pod.id } }))!;
      const res = await savePodcastConfiguration({
        db, podcastId: pod.id, expectedVersion: current.configVersion,
        canEdit: (p) => p.ownerId === other.id, // the enemy
        input: { identity: { name: "Config Show", slug: "config-show" } },
      });
      assert(!res.ok && res.error.code === "podcast_forbidden", "forbidden for non-owner");
    });

    await check("a reserved or taken slug is rejected structurally", async () => {
      const current = (await db.podcast.findUnique({ where: { id: pod.id } }))!;
      const reserved = await savePodcastConfiguration({
        db, podcastId: pod.id, expectedVersion: current.configVersion, canEdit: () => true,
        input: { identity: { name: "X", slug: "admin" } },
      });
      assert(!reserved.ok && reserved.error.code === "invalid_slug", "reserved slug rejected");
      // 'legacy-x' belongs to the other podcast.
      const taken = await savePodcastConfiguration({
        db, podcastId: pod.id, expectedVersion: current.configVersion, canEdit: () => true,
        input: { identity: { name: "X", slug: "legacy-x" } },
      });
      assert(!taken.ok && taken.error.code === "slug_taken", "taken slug rejected");
    });

    await check("the creation path resolves ONLY through the adapter (no direct legacy column reads)", () => {
      for (const f of ["rundownCreation.ts", "episodeCreation.ts"]) {
        const src = fs.readFileSync(path.join(process.cwd(), "src", "lib", "services", f), "utf8");
        assert(!/segmentCount:\s*true/.test(src), `${f} selects Podcast.segmentCount directly; it must use loadPodcastConfiguration`);
        assert(!/podcast\.findUnique\([^)]*verticals/.test(src), `${f} reads legacy Podcast.verticals directly`);
      }
    });

  } finally {
    await db.$disconnect();
    await pg.stop().catch(() => {});
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function main() {
  await pureTests();
  await dbTests();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
main().catch((err) => { console.error(err); process.exit(1); });
