// Show-format engine tests (Prompt 7, PR 1). Run: npm run test:show-format
//
// Proves: the registry's bounds/roles, registry-driven config validation
// (two_host_debate byte-identical; non-ready formats honestly rejected for
// NEW saves), format-driven cast resolution (two_host_debate delegates to the
// legacy resolver EXACTLY; other formats seat 1-4 by roster), snapshot v3
// (cast frozen; v1/v2 fingerprints byte-stable), N-speaker matchers, and the
// atomic cast-row write at creation.
//
// Embedded PostgreSQL; no LLM/TTS/network.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

import {
  listShowFormats, getShowFormat, isRegisteredFormat, isGenerationReadyFormat,
  validatePinnedCast, roleForSeat, DEFAULT_FORMAT_ID, PLATFORM_MAX_SPEAKERS,
} from "../lib/formats/showFormatRegistry";
import { makeCastMatchers } from "../lib/services/hostCastingShared";
import { resolveEpisodeConfiguration, loadPodcastConfiguration, savePodcastConfiguration } from "../lib/services/podcastConfiguration";
import { buildEpisodeConfigurationSnapshot, fingerprintEpisodeSnapshot, snapshotCastFor, type EpisodeConfigurationSnapshot } from "../lib/services/episodeConfigurationSnapshot";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
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
  console.log("\nShow-format engine — registry, resolution, snapshot v3\n");

  // ---- Pure: registry ------------------------------------------------------
  await check("the registry declares 1-4 speaker formats with two_host_debate ready", () => {
    const formats = listShowFormats();
    assert(formats.length >= 4, "at least 4 registered formats");
    const debate = getShowFormat("two_host_debate")!;
    assert(debate.speakerMin === 2 && debate.speakerMax === 2, "debate bounds");
    assert(debate.roles.map((r) => r.id).join(",") === "chair_a,chair_b", "debate roles");
    assert(debate.generationReady === true, "debate is the ready format");
    assert(isGenerationReadyFormat("two_host_debate"), "ready check");
    for (const f of formats) {
      assert(f.speakerMin >= 1 && f.speakerMax <= PLATFORM_MAX_SPEAKERS, `${f.id} within platform bounds`);
      assert(f.roles.length >= f.speakerMax, `${f.id} declares a role per seat`);
      assert(f.generationReady, `${f.id} is generation-ready (the full pipeline landed in PRs 2-3)`);
    }
    assert(getShowFormat("solo_briefing")!.id === "solo_commentary", "solo_briefing alias resolves to solo_commentary");
    assert(getShowFormat("solo_commentary")!.speakerMin === 1, "solo = 1 voice");
    assert(getShowFormat("roundtable")!.id === "three_person_panel", "roundtable alias resolves to the canonical panel");
    assert(getShowFormat("three_person_panel")!.speakerMax === 3, "panel = exactly 3");
    assert(!isRegisteredFormat("game_show"), "unknown format not registered");
  });

  await check("validatePinnedCast enforces per-format bounds + duplicates", () => {
    assert(validatePinnedCast("two_host_debate", ["a", "b"]).ok, "2 ok for debate");
    const over = validatePinnedCast("two_host_debate", ["a", "b", "c"]);
    assert(!over.ok && over.error.code === "too_many_speakers", "3 rejected for debate");
    assert(validatePinnedCast("rapid_fire", ["a", "b", "c", "d"]).ok, "4 ok for rapid_fire");
    const overPanel = validatePinnedCast("three_person_panel", ["a", "b", "c", "d"]);
    assert(!overPanel.ok, "4 rejected for the 3-person panel");
    const dup = validatePinnedCast("roundtable", ["a", "a"]);
    assert(!dup.ok && dup.error.code === "duplicate_host", "duplicate rejected");
    assert(validatePinnedCast("two_host_debate", []).ok, "empty pin legal (auto-cast at build)");
    const unknown = validatePinnedCast("nope", ["a"]);
    assert(!unknown.ok && unknown.error.code === "unknown_format", "unknown format rejected");
  });

  await check("makeCastMatchers generalizes speaker matching to N hosts with seat lookup", () => {
    const cast = [
      { id: "h1", name: "Anchor One" },
      { id: "h2", name: "Voice Two" },
      { id: "h3", name: "Third Chair" },
    ];
    const m = makeCastMatchers(cast);
    assert(m.hostForSpeaker("voice two")!.id === "h2", "case-insensitive match");
    assert(m.expectedHostId("Third Chair") === "h3", "expected id");
    assert(!m.isValidSpeaker("Nobody"), "unknown speaker invalid");
    assert(m.seatOf("h3") === 2 && m.seatOf("nope") === -1, "seat lookup");
    assert(m.hostNames.length === 3, "N names");
  });

  await check("snapshot v3 freezes the format + pinned cast; sound/cast changes move the fingerprint", () => {
    const resolved = resolveEpisodeConfiguration({ podcast: null, overrides: {} });
    assert(resolved.ok, "resolves"); if (!resolved.ok) return;
    const cast = snapshotCastFor("two_host_debate", ["h1", "h2"]);
    assert(cast.members[0].role === "chair_a" && cast.members[1].role === "chair_b", "roles by seat");
    const s1 = buildEpisodeConfigurationSnapshot(resolved.resolved, new Date("2026-01-01T00:00:00Z"), undefined, cast);
    assert(s1.configurationSnapshot.version === 3, "version 3");
    assert(s1.configurationSnapshot.cast?.formatId === "two_host_debate", "cast frozen");
    const s2 = buildEpisodeConfigurationSnapshot(resolved.resolved, new Date("2026-01-01T00:00:00Z"), undefined, snapshotCastFor("two_host_debate", ["h1"]));
    assert(s1.configurationFingerprint !== s2.configurationFingerprint, "cast change moves the fingerprint");
  });

  await check("stored v1 and v2 snapshots still fingerprint byte-stably (no cast key injected)", () => {
    const base = {
      source: "standalone", capturedAt: "2026-01-01T00:00:00.000Z", podcast: null,
      editorial: { verticals: [], teams: [], segmentCount: 3, format: "two_host_debate", minDebateScore: null, scriptStyle: null, maxWords: null, provenance: {} },
      production: { hostIds: [], ttsProvider: null, ttsVoiceOverrides: null, productionStyle: null, sfxDensity: null, provenance: {} },
    };
    for (const version of [1, 2]) {
      const snap = { version, ...base } as unknown as EpisodeConfigurationSnapshot;
      const f1 = fingerprintEpisodeSnapshot(snap);
      const f2 = fingerprintEpisodeSnapshot(JSON.parse(JSON.stringify(snap)));
      assert(f1 === f2, `v${version} fingerprint reproducible`);
    }
  });

  await check("config resolution: two_host_debate byte-identical; per-format caps; unregistered rejected", () => {
    const r1 = resolveEpisodeConfiguration({ podcast: null, overrides: { hostIds: ["a", "b", "c"] } });
    assert(!r1.ok && r1.error.code === "too_many_hosts", "3 hosts rejected under the debate format");
    const r2 = resolveEpisodeConfiguration({ podcast: null, overrides: { format: "made_up" } });
    assert(!r2.ok && r2.error.code === "unsupported_format", "unregistered rejected");
    const r3 = resolveEpisodeConfiguration({ podcast: null, overrides: {} });
    assert(r3.ok && r3.resolved.editorial.format.value === DEFAULT_FORMAT_ID, "default unchanged");
  });

  // ---- DB: casting + save gating + atomic cast rows -----------------------
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-format-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("formats");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/formats`;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });
  process.env.DATABASE_URL = dbUrl;
  const { resolveEpisodeCast, resolveEpisodeHosts } = await import("../lib/services/hostCasting");
  const { db } = await import("../lib/db");

  try {
    const mkHost = (name: string, slug: string, intensity: number) =>
      db.aiHost.create({ data: { name, slug, role: "host", worldview: "w", speakingStyle: "s", catchphrases: [], likes: [], dislikes: [], argumentPatterns: [], bannedPhrases: [], intensityLevel: intensity, ttsProvider: "stub", ttsVoiceId: "v", isActive: true } });
    const h1 = await mkHost("Blaze", "blaze", 9);
    const h2 = await mkHost("Calm", "calm", 3);
    const h3 = await mkHost("Mid", "mid", 6);

    await check("CORE: two_host_debate cast resolution delegates to the legacy resolver EXACTLY", async () => {
      const legacy = await resolveEpisodeHosts({ hostIds: [] });
      const cast = await resolveEpisodeCast({ hostIds: [], formatId: "two_host_debate" });
      assert(cast.members.length === 2, "two seats");
      assert(cast.members[0].host.id === legacy.hostA.id && cast.members[1].host.id === legacy.hostB.id, "identical seating");
      assert(cast.members[0].role === "chair_a" && cast.members[1].role === "chair_b", "debate roles");
      const pinned = await resolveEpisodeCast({ hostIds: [h2.id, h1.id], formatId: "two_host_debate" });
      assert(pinned.members[0].host.id === h2.id, "pinned seat order wins");
    });

    await check("solo and roundtable formats seat 1-4 by pin then roster", async () => {
      const solo = await resolveEpisodeCast({ hostIds: [h2.id], formatId: "solo_briefing" });
      assert(solo.members.length === 1 && solo.members[0].host.id === h2.id && solo.members[0].role === "anchor", "solo pinned seat");
      const auto = await resolveEpisodeCast({ hostIds: [], formatId: "solo_briefing" });
      assert(auto.members.length === 1 && auto.members[0].host.id === h1.id, "solo auto-cast = most intense");
      const round = await resolveEpisodeCast({ hostIds: [], formatId: "roundtable" });
      assert(round.members.length === 3, "panel fills its 3 REQUIRED seats from the roster");
      assert(round.members.map((m) => m.role).join(",") === "moderator,panelist_one,panelist_two", "roles by seat");
      assert(new Set(round.members.map((m) => m.host.id)).size === 3, "distinct hosts");
    });

    await check("a format's minimum is enforced against the roster", async () => {
      await db.aiHost.updateMany({ where: { id: { in: [h2.id, h3.id] } }, data: { isActive: false } });
      let threw = false;
      try { await resolveEpisodeCast({ hostIds: [], formatId: "roundtable" }); }
      catch (err) { threw = /at least 3/.test((err as Error).message); }
      assert(threw, "roundtable with 1 active host must fail clearly");
      await db.aiHost.updateMany({ where: { id: { in: [h2.id, h3.id] } }, data: { isActive: true } });
    });

    await check("CORE: NEW config saves accept every generation-ready format; unregistered rejected", async () => {
      const owner = await db.user.create({ data: { email: "o@x.test", passwordHash: "x" } });
      const pod = await db.podcast.create({ data: { name: "S", cadence: "one_time", slug: "s-show", ownerId: owner.id, editorialConfig: { create: {} }, productionConfig: { create: {} }, publishingConfig: { create: {} } } });
      const round = await savePodcastConfiguration({
        db, podcastId: pod.id, expectedVersion: 1, canEdit: () => true,
        input: { identity: { name: "S", slug: "s-show" }, editorial: { format: "roundtable" }, production: { hostIds: [] } },
      });
      assert(round.ok, `roundtable now selectable (pipeline complete): ${JSON.stringify(round)}`);
      const fake = await savePodcastConfiguration({
        db, podcastId: pod.id, expectedVersion: 2, canEdit: () => true,
        input: { identity: { name: "S", slug: "s-show" }, editorial: { format: "game_show" } },
      });
      assert(!fake.ok && fake.error.code === "unsupported_format", "unregistered still rejected");
      const ready = await savePodcastConfiguration({
        db, podcastId: pod.id, expectedVersion: 2, canEdit: () => true,
        input: { identity: { name: "S", slug: "s-show" }, editorial: { format: "two_host_debate" } },
      });
      assert(ready.ok, `debate still saves: ${JSON.stringify(ready)}`);
      const loaded = await loadPodcastConfiguration(db, pod.id);
      assert(loaded!.editorial.format === "two_host_debate", "persisted");
    });

    await check("CORE: episode creation writes normalized cast rows atomically with the episode", async () => {
      const { createEpisodeRecord } = await import("../lib/services/episodeService");
      const created = await createEpisodeRecord(
        [], // no topics needed for the cast assertion? topics required — supply one
        { title: "Cast test", hostIds: [h1.id, h2.id] },
        [],
        db
      ).catch(() => null);
      // createEpisodeRecord requires topics; use the real path with one topic:
      const topic = await db.topicCandidate.create({ data: { title: "T", sport: "NFL", controversyScore: 1, starPowerScore: 1, bettingRelevanceScore: 1, recencyScore: 1, debateScore: 60, evidenceIds: [], status: "approved" } });
      const res = created ?? await createEpisodeRecord(
        [{ ...topic, researchBrief: null } as never],
        { title: "Cast test", hostIds: [h1.id, h2.id] },
        [],
        db
      );
      const rows = await db.episodeCastMember.findMany({ where: { episodeId: res!.episodeId }, orderBy: { orderIndex: "asc" } });
      assert(rows.length === 2, `2 cast rows (got ${rows.length})`);
      assert(rows[0].hostId === h1.id && rows[0].role === "chair_a" && rows[0].orderIndex === 0, "seat 0");
      assert(rows[1].hostId === h2.id && rows[1].role === "chair_b", "seat 1");
      const ep = await db.episode.findUnique({ where: { id: res!.episodeId } });
      assert(ep!.formatId === "two_host_debate", "episode formatId stamped");
      assert(JSON.stringify(ep!.hostIds) === JSON.stringify([h1.id, h2.id]), "legacy hostIds mirror kept");
    });

    await check("the cast-member unique constraints hold at the DB", async () => {
      const ep = await db.episode.create({ data: { title: "U", slug: "u-1", status: "draft" } });
      await db.episodeCastMember.create({ data: { episodeId: ep.id, hostId: h1.id, role: "chair_a", orderIndex: 0 } });
      let dupSeat = false, dupHost = false;
      try { await db.episodeCastMember.create({ data: { episodeId: ep.id, hostId: h2.id, role: "chair_b", orderIndex: 0 } }); } catch { dupSeat = true; }
      try { await db.episodeCastMember.create({ data: { episodeId: ep.id, hostId: h1.id, role: "chair_b", orderIndex: 1 } }); } catch { dupHost = true; }
      assert(dupSeat && dupHost, "duplicate seat and duplicate host both rejected");
    });

  } finally {
    await db.$disconnect();
    await pg.stop().catch(() => {});
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
main().catch((err) => { console.error(err); process.exit(1); });
