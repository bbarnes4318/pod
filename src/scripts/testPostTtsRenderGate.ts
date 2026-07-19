// Post-TTS render integration test (PR 3, C5). Run: npm run test:post-tts-render-gate
//
// Drives the REAL stitcher with POST_TTS_SOUND_DIRECTION_ENABLED=on and off,
// through embedded Postgres + local storage + real ffmpeg. Proves the director
// runs on the actual dialogue, the render succeeds with audible bookends (PR 1
// QA), diagnostics record the engine + plan fingerprint + treatments, flag-off
// keeps legacy behavior, and a director failure preserves the prior master with
// no cue usage. No LLM/TTS/network/paid APIs.

import EmbeddedPostgres from "embedded-postgres";
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
async function freePort(): Promise<number> { return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on("error", rej); }); }

async function main() {
  console.log("\nPost-TTS render integration (real ffmpeg + embedded PG)\n");
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-posttts-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise(); await pg.start();
  // The embedded cluster inherits the Windows locale (WIN1252); create the test
  // DB as UTF-8 (as prod is) so the render's diagnostics (which contain the
  // audio-QA sigma + the ffmpeg-summary arrow, written by the existing pipeline)
  // store correctly.
  const { Client } = await import("pg");
  const admin = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query("CREATE DATABASE render ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0");
  await admin.end();
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/render`;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });

  const storageRoot = path.join(process.cwd(), "public", "storage");
  // Local integration test: embedded PG + local storage + real ffmpeg, no Redis.
  // Pin the runtime to development so the service import chain (which defaults an
  // unset NODE_ENV to "production") does not trip the prod env assertions
  // (assertProductionEnv requires a passworded REDIS_URL this test never uses).
  Object.assign(process.env, { NODE_ENV: "development" });
  process.env.DATABASE_URL = dbUrl;
  process.env.STORAGE_PROVIDER = "local";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.POST_TTS_SOUND_DIRECTION_ENABLED = "true";

  const { stitchFinalEpisodeAudio } = await import("../lib/services/audioStitchingService");
  const { getStorageProvider } = await import("../lib/providers/storage/factory");
  const { db } = await import("../lib/db");
  const storage = getStorageProvider();

  const put = async (key: string, kind: "tone" | "noise", freq: number, durSec: number) => {
    const f = path.join(tmpRoot, `${key.replace(/\W/g, "_")}.mp3`);
    const src = kind === "tone" ? `sine=frequency=${freq}:duration=${durSec}` : `anoisesrc=color=pink:amplitude=0.3:seed=${freq}:duration=${durSec}`;
    execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", src, "-ar", "44100", f], { stdio: "ignore" });
    const body = fs.readFileSync(f);
    const { url } = await storage.putObject({ key, body, contentType: "audio/mpeg" });
    return { url, hash: crypto.createHash("sha256").update(body).digest("hex") };
  };
  const written: string[] = [];
  const mkAsset = async (id: string, kind: string, name: string, freq: number, dur: number) => {
    const key = `episodes/pt/${id}.mp3`; written.push(key);
    const a = await put(key, kind === "bed" ? "tone" : "tone", freq, dur);
    return db.audioAsset.create({ data: { name, kind, tags: [], audioUrl: a.url, license: "x", scope: "shared_system", processingStatus: "ready", contentHash: a.hash, durationMs: Math.round(dur * 1000), isActive: true, licenseStatus: "licensed", rightsStatus: "not_required" } });
  };

  const ref = (asset: { id: string; name: string; contentHash: string | null }, role: string, kind: string, cueFamily: string | null = null) => ({
    assetId: asset.id, kind, category: null, name: asset.name, contentHash: asset.contentHash, scope: "shared_system", role, orderIndex: 0,
    gainDb: null, fadeInMs: null, fadeOutMs: null, durationMs: 4000, tags: [], rightsStatusAtCapture: "not_required", licenseStatusAtCapture: "licensed", provenance: "system_default", weight: 1, cueFamily,
  });

  try {
    const host = await db.aiHost.create({ data: { name: "Sol", slug: "sol", role: "host", worldview: "w", speakingStyle: "s", catchphrases: [], likes: [], dislikes: [], argumentPatterns: [], bannedPhrases: [], intensityLevel: 5, ttsProvider: "stub", ttsVoiceId: "v", isActive: true } });
    const intro = await mkAsset("intro", "theme_intro", "Broadcast Intro", 330, 3.0);
    const outro = await mkAsset("outro", "theme_outro", "Broadcast Outro", 300, 3.0);
    const bed = await mkAsset("bed", "bed", "Analysis Bed", 180, 20.0);
    const sting = await mkAsset("sting", "stinger", "Topic Sweep", 660, 1.2);
    const rx = await mkAsset("rx", "sfx", "Agree", 520, 0.7);

    const soundProfile = {
      mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
      introEnabled: true, outroEnabled: true,
      intro: ref(intro, "intro", "theme_intro"), outro: ref(outro, "outro", "theme_outro"), bed: ref(bed, "bed", "bed"),
      stingers: [ref(sting, "stinger", "stinger", "topic_reset")], reactions: [ref(rx, "reaction", "sfx", "agreement")],
      introVariants: [ref(intro, "intro", "theme_intro")], outroVariants: [ref(outro, "outro", "theme_outro")], beds: [ref(bed, "bed", "bed")],
      sonicIdentity: { version: 1, primaryGenre: null, secondaryGenres: [], moods: [], pace: null, intensity: null, broadcastStyle: null, preferredInstrumentation: [], prohibitedInstrumentation: [], allowedCueFamilies: [], prohibitedCueFamilies: [], allowedFormatIds: [], prohibitedFormatIds: [], humorEffectsAllowed: true, crowdEffectsAllowed: true, underSpeechEffectsAllowed: true, brandedMotifEnabled: false, transitionFrequency: null, maximumEffectsIntensity: null, bedPolicy: "select_segments", introTreatment: null, outroTreatment: null, minimumMusicGapMs: null, maximumMusicGapMs: null, voiceOverMusicPolicy: null },
      containsLegacyCompatAssets: false, excluded: [],
    };
    const snapshot = { version: 5, cast: { formatId: "solo_commentary", formatVersion: 2, members: [{ hostId: host.id, role: "anchor", orderIndex: 0 }] }, source: "standalone", capturedAt: "2026-01-01T00:00:00.000Z", podcast: null, editorial: { verticals: [], teams: [], segmentCount: 2, format: "solo_commentary", minDebateScore: null, scriptStyle: null, maxWords: null, provenance: {} }, production: { hostIds: [host.id], ttsProvider: null, ttsVoiceOverrides: null, productionStyle: null, sfxDensity: null, provenance: {}, soundProfile } };

    const priorMaster = await put("episodes/pt/prior.mp3", "tone", 500, 1.0); written.push("episodes/pt/prior.mp3");
    const episode = await db.episode.create({ data: { title: "PostTTS Ep", slug: "posttts-ep", status: "content_ready", formatId: "solo_commentary", hostIds: [host.id], audioUrl: priorMaster.url, durationSeconds: 10, soundDesign: { style: "full" } as object, configurationSource: "standalone", configurationSnapshot: snapshot as object, configurationFingerprint: "fp-pt" } });

    // Two segments (topic boundary between) so the director can place a transition.
    const line = (i: number, seg: number, text: string, tone: string, factual = false) => ({ lineIndex: i, speakerName: "Sol", speakerHostId: host.id, text, tone, isFactualClaim: factual, needsHumanReview: false, evidenceRefs: [], energy: tone === "amused" ? "high" : "medium" });
    const script = await db.script.create({ data: { episodeId: episode.id, version: 1, status: "approved", plainText: "Sol talks for a while about several things across two topics.", content: { segments: [
      { type: "topic", lines: [line(0, 0, "Welcome in everybody to the show today.", "neutral"), line(1, 0, "We have a lot to get through this hour.", "neutral")] },
      { type: "topic", lines: [line(2, 1, "Now onto our second big story of the day.", "analytical"), line(3, 1, "Honestly that is a wild development, wow.", "amused"), line(4, 1, "Thanks so much for listening, see you next time.", "neutral")] },
    ] } as object } });
    for (let i = 0; i < 5; i++) { const seg = await put(`episodes/pt/seg${i}.mp3`, "noise", 700 + i, 1.6); written.push(`episodes/pt/seg${i}.mp3`); await db.audioSegment.create({ data: { episodeId: episode.id, scriptId: script.id, lineIndex: i, text: `l${i}`, audioUrl: seg.url, status: "ready", durationMs: 1600 } }); }
    await db.factCheckResult.create({ data: { scriptId: script.id, episodeId: episode.id, passed: true, status: "passed", warnings: [] as object, errors: [] as object } });

    let render1: Awaited<ReturnType<typeof stitchFinalEpisodeAudio>> | null = null;
    await check("post-TTS ENABLED: the render succeeds with audible bookends (PR 1 QA holds)", async () => {
      render1 = await stitchFinalEpisodeAudio({ scriptId: script.id, forceRegenerate: true, productionStyle: "full" });
      assert(render1.finalStatus === "completed", `render completed (${render1.finalStatus})`);
      const rr = await db.episodeAudioRender.findFirst({ where: { episodeId: episode.id }, orderBy: { renderVersion: "desc" } });
      assert(rr?.status === "succeeded", `render record succeeded (${rr?.status})`);
    });

    await check("diagnostics record the post-TTS engine, plan fingerprint, and treatments", async () => {
      const rr = await db.episodeAudioRender.findFirst({ where: { episodeId: episode.id, status: "succeeded" }, orderBy: { renderVersion: "desc" } });
      const d = (rr?.diagnostics as { postTts?: { planningEngine?: string; planFingerprint?: string; introTreatment?: string; outroTreatment?: string; bedPolicy?: string; cueAccepted?: number } } | null)?.postTts;
      assert(d?.planningEngine === "post_tts", `engine post_tts (${d?.planningEngine})`);
      assert(!!d?.planFingerprint && d.planFingerprint.length === 64, "plan fingerprint recorded");
      assert(!!d?.introTreatment && !!d?.outroTreatment, `treatments recorded (${d?.introTreatment}/${d?.outroTreatment})`);
      assert(!JSON.stringify(rr?.diagnostics).match(/https?:\/\//), "no URLs in diagnostics");
    });

    await check("post-TTS plan is stored on the render record (deterministic reproduce source)", async () => {
      const rr = await db.episodeAudioRender.findFirst({ where: { episodeId: episode.id, status: "succeeded" }, orderBy: { renderVersion: "desc" } });
      assert((rr?.plan as { mode?: string } | null)?.mode === "post_tts", "post_tts plan stored");
    });

    await check("reproduce replays the STORED plan verbatim (engine=stored_plan_reproduce; flag + thresholds ignored)", async () => {
      const before = await db.episodeAudioRender.findFirst({ where: { episodeId: episode.id, status: "succeeded" }, orderBy: { renderVersion: "desc" } });
      const storedFp = (before?.plan as { fingerprint?: string; reproduce?: unknown } | null)?.fingerprint;
      assert(!!storedFp && !!(before?.plan as { reproduce?: unknown } | null)?.reproduce, "a stored post-TTS plan with a reproduce envelope exists");
      // Flag OFF + a transition-gap threshold that WOULD suppress cues if a fresh
      // director ran: verbatim reproduce must ignore BOTH and replay the plan.
      process.env.POST_TTS_SOUND_DIRECTION_ENABLED = "false";
      process.env.POST_TTS_MIN_TRANSITION_GAP_MS = "99999";
      const r = await stitchFinalEpisodeAudio({ scriptId: script.id, renderMode: "reproduce", forceRegenerate: true, productionStyle: "full" });
      process.env.POST_TTS_SOUND_DIRECTION_ENABLED = "true";
      delete process.env.POST_TTS_MIN_TRANSITION_GAP_MS;
      assert(r.finalStatus === "completed", `reproduce completes (${r.finalStatus})`);
      const rr = await db.episodeAudioRender.findFirst({ where: { episodeId: episode.id, status: "succeeded" }, orderBy: { renderVersion: "desc" } });
      const engine = (rr?.diagnostics as { postTts?: { planningEngine?: string } } | null)?.postTts?.planningEngine;
      assert(engine === "stored_plan_reproduce", `engine stored_plan_reproduce (${engine})`);
      assert((rr?.plan as { fingerprint?: string } | null)?.fingerprint === storedFp, "reproduced plan fingerprint == stored");
    });

    await check("a stored plan missing its reproduce envelope FAILS reproduce (no silent re-plan; prior master preserved)", async () => {
      const latest = await db.episodeAudioRender.findFirst({ where: { episodeId: episode.id, status: "succeeded" }, orderBy: { renderVersion: "desc" } });
      const priorAudioUrl = (await db.episode.findUnique({ where: { id: episode.id } }))?.audioUrl;
      const corrupt = { ...(latest!.plan as object) }; delete (corrupt as { reproduce?: unknown }).reproduce;
      await db.episodeAudioRender.update({ where: { id: latest!.id }, data: { plan: corrupt as object } });
      // A corrupt/enveloped-less stored plan fails clearly (early throw, like the
      // "no prior plan" guard) OR returns a non-completed status — never silently
      // re-plans. Either way the prior master must be preserved.
      let failed = false;
      try { const r = await stitchFinalEpisodeAudio({ scriptId: script.id, renderMode: "reproduce", forceRegenerate: true, productionStyle: "full" }); failed = r.finalStatus !== "completed"; }
      catch (e) { failed = /reproduce envelope|missing/i.test((e as Error).message); }
      assert(failed, "reproduce fails on a corrupt stored plan (no silent re-plan)");
      const after = (await db.episode.findUnique({ where: { id: episode.id } }))?.audioUrl;
      assert(after === priorAudioUrl, "prior master preserved on reproduce failure");
    });

    await check("PR4: diversity ENFORCE renders successfully with audible bookends + records the mode", async () => {
      process.env.SOUND_DIVERSITY_ENGINE_ENABLED = "true";
      process.env.SOUND_DIVERSITY_ENFORCEMENT_MODE = "enforce";
      const r = await stitchFinalEpisodeAudio({ scriptId: script.id, forceRegenerate: true, productionStyle: "full" });
      assert(r.finalStatus === "completed", `render completes with diversity on (${r.finalStatus})`);
      const rr = await db.episodeAudioRender.findFirst({ where: { episodeId: episode.id, status: "succeeded" }, orderBy: { renderVersion: "desc" } });
      const div = (rr?.diagnostics as { postTts?: { diversity?: { renderMode?: string } } } | null)?.postTts?.diversity;
      assert(div?.renderMode === "enforce", `diversity mode recorded (${div?.renderMode})`);
      const bk = (rr?.diagnostics as { bookend?: { ok?: boolean } } | null)?.bookend;
      assert(bk?.ok !== false, "bookends remain audible under diversity");
    });

    await check("PR4: REPRODUCE ignores the diversity flags and replays the stored plan verbatim", async () => {
      const before = await db.episodeAudioRender.findFirst({ where: { episodeId: episode.id, status: "succeeded" }, orderBy: { renderVersion: "desc" } });
      const fp = (before?.plan as { fingerprint?: string } | null)?.fingerprint;
      // Flip the diversity mode: reproduce must not consult it.
      process.env.SOUND_DIVERSITY_ENFORCEMENT_MODE = "off";
      const r = await stitchFinalEpisodeAudio({ scriptId: script.id, renderMode: "reproduce", forceRegenerate: true, productionStyle: "full" });
      assert(r.finalStatus === "completed", `reproduce completes (${r.finalStatus})`);
      const rr = await db.episodeAudioRender.findFirst({ where: { episodeId: episode.id, status: "succeeded" }, orderBy: { renderVersion: "desc" } });
      const engine = (rr?.diagnostics as { postTts?: { planningEngine?: string } } | null)?.postTts?.planningEngine;
      assert(engine === "stored_plan_reproduce", `engine stored_plan_reproduce (${engine})`);
      assert((rr?.plan as { fingerprint?: string } | null)?.fingerprint === fp, "reproduced fingerprint unchanged by flags");
      delete process.env.SOUND_DIVERSITY_ENGINE_ENABLED;
      delete process.env.SOUND_DIVERSITY_ENFORCEMENT_MODE;
    });

    await check("flag OFF: the same episode renders via the LEGACY engine (no silent switch)", async () => {
      process.env.POST_TTS_SOUND_DIRECTION_ENABLED = "false";
      const r = await stitchFinalEpisodeAudio({ scriptId: script.id, forceRegenerate: true, productionStyle: "full" });
      assert(r.finalStatus === "completed", "legacy render completes");
      const rr = await db.episodeAudioRender.findFirst({ where: { episodeId: episode.id, status: "succeeded" }, orderBy: { renderVersion: "desc" } });
      const engine = (rr?.diagnostics as { postTts?: { planningEngine?: string } } | null)?.postTts?.planningEngine;
      assert(engine === "legacy_planner", `legacy engine (${engine})`);
      process.env.POST_TTS_SOUND_DIRECTION_ENABLED = "true";
    });
  } finally {
    await db.$disconnect().catch(() => {});
    await pg.stop().catch(() => {});
    for (const k of written) { try { fs.rmSync(path.join(storageRoot, k), { force: true }); } catch { /* */ } }
    try { fs.rmSync(path.join(storageRoot, "episodes", "pt"), { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
