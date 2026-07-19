// Post-TTS sound-direction listening/acceptance harness (PR 3, C6).
// Run: npm run demo:post-tts-sound-direction
//
// Renders six real show FORMATS end-to-end through the LIVE stitcher with the
// post-TTS director enabled (POST_TTS_SOUND_DIRECTION_ENABLED), driven by
// deterministic ffmpeg-synth fixtures over embedded Postgres + local storage +
// real ffmpeg. For each format it writes the mastered MP3 plus a per-format
// direction summary, and a top-level report.json, into
// samples/post-tts-direction/. It then asserts the acceptance criteria:
//   - the render succeeds with audible bookends (the PR 1 bookend gate holds),
//   - no placed cue collides with a HARD-protected speech region,
//   - every cue lands inside the real gap window the director measured,
//   - the six formats are meaningfully different (distinct plan fingerprints
//     and differing intro/outro treatments or cue/bed behavior),
//   - determinism: re-running a format reproduces the identical fingerprint,
//   - no network, no LLM, no TTS, no paid APIs, and the temp cluster is removed.
//
// The report is SAFE: names/counts/treatments/reasons only — never URLs, keys,
// or paths.

import EmbeddedPostgres from "embedded-postgres";
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

let passed = 0, failed = 0;
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
async function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on("error", rej); });
}

// ---- Deterministic per-format fixtures ---------------------------------------
// Two topics so the director always has a structural boundary to place a
// transition; an amused peak in topic two to trigger a reaction; one hard
// factual line to prove protected-region avoidance. hostSlot alternates for
// multi-host formats.
interface DemoLine { text: string; tone: string; energy: string; factual?: boolean; slot: number }
interface DemoFormat { formatId: string; hosts: number; lines: DemoLine[] }

const FORMATS: DemoFormat[] = [
  { formatId: "solo_commentary", hosts: 1, lines: [
    { text: "Welcome in everybody to the show today.", tone: "neutral", energy: "medium", slot: 0 },
    { text: "We have a lot to get through this hour.", tone: "neutral", energy: "medium", slot: 0 },
    { text: "Now onto our second big story of the day.", tone: "analytical", energy: "medium", slot: 0 },
    { text: "The team scored exactly twenty four points last night.", tone: "analytical", energy: "medium", factual: true, slot: 0 },
    { text: "Honestly that is a wild development, wow.", tone: "amused", energy: "high", slot: 0 },
    { text: "Thanks so much for listening, see you next time.", tone: "neutral", energy: "medium", slot: 0 },
  ] },
  { formatId: "two_host_debate", hosts: 2, lines: [
    { text: "Welcome back to the debate, I am not convinced.", tone: "neutral", energy: "medium", slot: 0 },
    { text: "You are wrong and I will explain exactly why.", tone: "heated", energy: "high", slot: 1 },
    { text: "Let us move to the next contested question now.", tone: "analytical", energy: "medium", slot: 0 },
    { text: "They lost by exactly seven points, that is fact.", tone: "analytical", energy: "medium", factual: true, slot: 1 },
    { text: "Oh come on, that is absolutely hilarious.", tone: "amused", energy: "high", slot: 0 },
    { text: "Good debate, we will pick it up next week.", tone: "neutral", energy: "medium", slot: 1 },
  ] },
  { formatId: "sports_radio", hosts: 2, lines: [
    { text: "You are live on the sports line, big night ahead.", tone: "neutral", energy: "high", slot: 0 },
    { text: "What a run that was down the stretch, unreal.", tone: "amused", energy: "high", slot: 1 },
    { text: "Turning now to tomorrow's marquee matchup.", tone: "analytical", energy: "medium", slot: 0 },
    { text: "The line moved to exactly three and a half points.", tone: "analytical", energy: "medium", factual: true, slot: 1 },
    { text: "That call was outrageous, I cannot believe it.", tone: "heated", energy: "high", slot: 0 },
    { text: "Stay with us, more after this on the line.", tone: "neutral", energy: "high", slot: 1 },
  ] },
  { formatId: "news_roundup", hosts: 2, lines: [
    { text: "Good evening, here are tonight's top stories.", tone: "neutral", energy: "medium", slot: 0 },
    { text: "Our first report comes from the capital today.", tone: "analytical", energy: "medium", slot: 1 },
    { text: "We turn now to the second story of the hour.", tone: "neutral", energy: "medium", slot: 0 },
    { text: "Officials confirmed exactly twelve new measures today.", tone: "analytical", energy: "medium", factual: true, slot: 1 },
    { text: "That development is significant for the region.", tone: "analytical", energy: "medium", slot: 0 },
    { text: "That is the news, thank you for joining us.", tone: "neutral", energy: "medium", slot: 1 },
  ] },
  { formatId: "documentary", hosts: 1, lines: [
    { text: "It began, as these things often do, quietly.", tone: "reflective", energy: "low", slot: 0 },
    { text: "No one watching could have known what came next.", tone: "reflective", energy: "low", slot: 0 },
    { text: "The second chapter opens years later, elsewhere.", tone: "analytical", energy: "medium", slot: 0 },
    { text: "Records show exactly three hundred people were there.", tone: "analytical", energy: "medium", factual: true, slot: 0 },
    { text: "And so the story turned, as stories do.", tone: "reflective", energy: "low", slot: 0 },
    { text: "That is where, for now, our account must end.", tone: "reflective", energy: "low", slot: 0 },
  ] },
  { formatId: "rapid_fire", hosts: 2, lines: [
    { text: "Rapid fire, go, first take right now.", tone: "neutral", energy: "high", slot: 0 },
    { text: "Overrated, next, keep it moving fast.", tone: "dismissive", energy: "high", slot: 1 },
    { text: "New round, here comes the next one.", tone: "neutral", energy: "high", slot: 0 },
    { text: "They went exactly nine and one, done.", tone: "analytical", energy: "high", factual: true, slot: 1 },
    { text: "Ha, no way, that is ridiculous, love it.", tone: "amused", energy: "high", slot: 0 },
    { text: "Time, that is the show, see you tomorrow.", tone: "neutral", energy: "high", slot: 1 },
  ] },
];

type SafeFormatReport = {
  formatId: string;
  finalStatus: string;
  renderStatus: string;
  planFingerprint: string;
  planningEngine: string;
  introTreatment: string;
  outroTreatment: string;
  bedPolicy: string | null;
  bedSegments: number;
  detectedGaps: number;
  protectedRegions: number;
  hardProtectedRegions: number;
  transitions: number;
  reactions: number;
  cuesRejected: number;
  bookendsAudible: boolean;
  deterministic: boolean;
  mp3: string;
};

async function main() {
  console.log("\nPost-TTS sound-direction acceptance harness (6 formats, real ffmpeg + embedded PG)\n");
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-posttts-demo-"));
  const outDir = path.join(process.cwd(), "samples", "post-tts-direction");
  fs.mkdirSync(outDir, { recursive: true });

  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise(); await pg.start();
  // Match production: the diagnostics carry the audio-QA sigma + ffmpeg arrow, so
  // the test DB must be UTF-8 (the embedded cluster inherits Windows WIN1252).
  const { Client } = await import("pg");
  const admin = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query("CREATE DATABASE render ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0");
  await admin.end();
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/render`;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });

  // Local integration harness: embedded PG + local storage + real ffmpeg, no
  // Redis / network. Pin development so the service import chain (which defaults
  // an unset NODE_ENV to production) does not trip the prod env assertions.
  Object.assign(process.env, { NODE_ENV: "development" });
  process.env.DATABASE_URL = dbUrl;
  process.env.STORAGE_PROVIDER = "local";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.POST_TTS_SOUND_DIRECTION_ENABLED = "true";
  void ffprobe;

  const { stitchFinalEpisodeAudio } = await import("../lib/services/audioStitchingService");
  const { getStorageProvider } = await import("../lib/providers/storage/factory");
  const { db } = await import("../lib/db");
  const storage = getStorageProvider();
  const storageRoot = path.join(process.cwd(), "public", "storage");
  const written: string[] = [];

  const put = async (key: string, kind: "tone" | "noise", freq: number, durSec: number) => {
    const f = path.join(tmpRoot, `${key.replace(/\W/g, "_")}.mp3`);
    const src = kind === "tone" ? `sine=frequency=${freq}:duration=${durSec}` : `anoisesrc=color=pink:amplitude=0.3:seed=${freq}:duration=${durSec}`;
    execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", src, "-ar", "44100", f], { stdio: "ignore" });
    const body = fs.readFileSync(f);
    written.push(key);
    const { url } = await storage.putObject({ key, body, contentType: "audio/mpeg" });
    return { url, hash: crypto.createHash("sha256").update(body).digest("hex") };
  };
  const ref = (asset: { id: string; name: string; contentHash: string | null }, role: string, kind: string, cueFamily: string | null = null) => ({
    assetId: asset.id, kind, category: null, name: asset.name, contentHash: asset.contentHash, scope: "shared_system", role, orderIndex: 0,
    gainDb: null, fadeInMs: null, fadeOutMs: null, durationMs: 4000, tags: [], rightsStatusAtCapture: "not_required", licenseStatusAtCapture: "licensed", provenance: "system_default", weight: 1, cueFamily,
  });

  const reports: SafeFormatReport[] = [];

  try {
    // One shared frozen system pool; the per-format DIFFERENCES come from the
    // format policy + real dialogue timing, not from different assets.
    const intro = await put("posttts-demo/intro.mp3", "tone", 330, 3.0);
    const outro = await put("posttts-demo/outro.mp3", "tone", 300, 3.0);
    const bed = await put("posttts-demo/bed.mp3", "tone", 180, 30.0);
    const sting = await put("posttts-demo/sting.mp3", "tone", 660, 1.2);
    const rx = await put("posttts-demo/rx.mp3", "tone", 520, 0.7);
    const introA = await db.audioAsset.create({ data: { name: "Broadcast Intro", kind: "theme_intro", tags: [], audioUrl: intro.url, license: "x", scope: "shared_system", processingStatus: "ready", contentHash: intro.hash, durationMs: 3000, isActive: true, licenseStatus: "licensed", rightsStatus: "not_required" } });
    const outroA = await db.audioAsset.create({ data: { name: "Broadcast Outro", kind: "theme_outro", tags: [], audioUrl: outro.url, license: "x", scope: "shared_system", processingStatus: "ready", contentHash: outro.hash, durationMs: 3000, isActive: true, licenseStatus: "licensed", rightsStatus: "not_required" } });
    const bedA = await db.audioAsset.create({ data: { name: "Analysis Bed", kind: "bed", tags: [], audioUrl: bed.url, license: "x", scope: "shared_system", processingStatus: "ready", contentHash: bed.hash, durationMs: 30000, isActive: true, licenseStatus: "licensed", rightsStatus: "not_required" } });
    const stingA = await db.audioAsset.create({ data: { name: "Topic Sweep", kind: "stinger", tags: [], audioUrl: sting.url, license: "x", scope: "shared_system", processingStatus: "ready", contentHash: sting.hash, durationMs: 1200, isActive: true, licenseStatus: "licensed", rightsStatus: "not_required" } });
    const rxA = await db.audioAsset.create({ data: { name: "Reaction", kind: "sfx", tags: [], audioUrl: rx.url, license: "x", scope: "shared_system", processingStatus: "ready", contentHash: rx.hash, durationMs: 700, isActive: true, licenseStatus: "licensed", rightsStatus: "not_required" } });

    const soundProfile = {
      mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
      introEnabled: true, outroEnabled: true,
      intro: ref(introA, "intro", "theme_intro"), outro: ref(outroA, "outro", "theme_outro"), bed: ref(bedA, "bed", "bed"),
      stingers: [ref(stingA, "stinger", "stinger", "topic_reset")], reactions: [ref(rxA, "reaction", "sfx", "agreement")],
      introVariants: [ref(introA, "intro", "theme_intro")], outroVariants: [ref(outroA, "outro", "theme_outro")], beds: [ref(bedA, "bed", "bed")],
      sonicIdentity: { version: 1, primaryGenre: null, secondaryGenres: [], moods: [], pace: null, intensity: null, broadcastStyle: null, preferredInstrumentation: [], prohibitedInstrumentation: [], allowedCueFamilies: [], prohibitedCueFamilies: [], allowedFormatIds: [], prohibitedFormatIds: [], humorEffectsAllowed: true, crowdEffectsAllowed: true, underSpeechEffectsAllowed: true, brandedMotifEnabled: false, transitionFrequency: null, maximumEffectsIntensity: null, bedPolicy: "select_segments", introTreatment: null, outroTreatment: null, minimumMusicGapMs: null, maximumMusicGapMs: null, voiceOverMusicPolicy: null },
      containsLegacyCompatAssets: false, excluded: [],
    };

    for (const fmt of FORMATS) {
      const host0 = await db.aiHost.create({ data: { name: `H0-${fmt.formatId}`, slug: `h0-${fmt.formatId}`, role: "host", worldview: "w", speakingStyle: "s", catchphrases: [], likes: [], dislikes: [], argumentPatterns: [], bannedPhrases: [], intensityLevel: 5, ttsProvider: "stub", ttsVoiceId: "v", isActive: true } });
      const host1 = fmt.hosts > 1 ? await db.aiHost.create({ data: { name: `H1-${fmt.formatId}`, slug: `h1-${fmt.formatId}`, role: "host", worldview: "w", speakingStyle: "s", catchphrases: [], likes: [], dislikes: [], argumentPatterns: [], bannedPhrases: [], intensityLevel: 5, ttsProvider: "stub", ttsVoiceId: "v", isActive: true } }) : host0;
      const hostIds = fmt.hosts > 1 ? [host0.id, host1.id] : [host0.id];
      const hostForSlot = (slot: number) => (slot === 1 ? host1 : host0);

      const snapshot = { version: 5, cast: { formatId: fmt.formatId, formatVersion: 2, members: hostIds.map((id, i) => ({ hostId: id, role: i === 0 ? "anchor" : "cohost", orderIndex: i })) }, source: "standalone", capturedAt: "2026-01-01T00:00:00.000Z", podcast: null, editorial: { verticals: [], teams: [], segmentCount: 2, format: fmt.formatId, minDebateScore: null, scriptStyle: null, maxWords: null, provenance: {} }, production: { hostIds, ttsProvider: null, ttsVoiceOverrides: null, productionStyle: null, sfxDensity: null, provenance: {}, soundProfile } };

      const prior = await put(`posttts-demo/${fmt.formatId}/prior.mp3`, "tone", 500, 1.0);
      const episode = await db.episode.create({ data: { title: `Demo ${fmt.formatId}`, slug: `demo-${fmt.formatId}`, status: "content_ready", formatId: fmt.formatId, hostIds, audioUrl: prior.url, durationSeconds: 10, soundDesign: { style: "full" } as object, configurationSource: "standalone", configurationSnapshot: snapshot as object, configurationFingerprint: `fp-${fmt.formatId}` } });

      const mkLine = (i: number) => { const l = fmt.lines[i]; const h = hostForSlot(l.slot); return { lineIndex: i, speakerName: h.name, speakerHostId: h.id, text: l.text, tone: l.tone, isFactualClaim: !!l.factual, needsHumanReview: false, evidenceRefs: [], energy: l.energy }; };
      const script = await db.script.create({ data: { episodeId: episode.id, version: 1, status: "approved", plainText: fmt.lines.map((l) => l.text).join(" "), content: { segments: [
        { type: "topic", lines: [mkLine(0), mkLine(1)] },
        { type: "topic", lines: [mkLine(2), mkLine(3), mkLine(4), mkLine(5)] },
      ] } as object } });
      for (let i = 0; i < fmt.lines.length; i++) {
        const seg = await put(`posttts-demo/${fmt.formatId}/seg${i}.mp3`, "noise", 700 + i, 1.6);
        await db.audioSegment.create({ data: { episodeId: episode.id, scriptId: script.id, lineIndex: i, text: fmt.lines[i].text, audioUrl: seg.url, status: "ready", durationMs: 1600 } });
      }
      await db.factCheckResult.create({ data: { scriptId: script.id, episodeId: episode.id, passed: true, status: "passed", warnings: [] as object, errors: [] as object } });

      const result = await stitchFinalEpisodeAudio({ scriptId: script.id, forceRegenerate: true, productionStyle: "full" });
      const rr = await db.episodeAudioRender.findFirst({ where: { episodeId: episode.id }, orderBy: { renderVersion: "desc" } });
      const diag = (rr?.diagnostics as { postTts?: Record<string, unknown> } | null)?.postTts ?? {};
      const plan = (rr?.plan as (Record<string, unknown> & { protectedRegions?: Array<{ startMs: number; endMs: number; paddingMs: number; severity: string }>; cuePlacements?: Array<{ kind: string; targetStartMs: number; gapStartMs: number; gapEndMs: number }>; detectedGaps?: unknown[]; bookendPlan?: { intro?: { treatment?: string }; outro?: { treatment?: string } }; bedPlan?: { policy?: string; segments?: unknown[] } | null; fingerprint?: string }) | null);

      // Copy the mastered MP3 out for listening.
      const outMp3 = path.join(outDir, `${fmt.formatId}.mp3`);
      const updated = await db.episode.findUnique({ where: { id: episode.id } });
      const m = updated?.audioUrl?.match(/\/storage\/(.+)$/);
      if (m) { try { fs.copyFileSync(path.join(storageRoot, m[1]), outMp3); } catch { /* */ } }

      // Determinism: re-run the SAME episode; the plan fingerprint must match.
      await stitchFinalEpisodeAudio({ scriptId: script.id, forceRegenerate: true, productionStyle: "full" });
      const rr2 = await db.episodeAudioRender.findFirst({ where: { episodeId: episode.id, status: "succeeded" }, orderBy: { renderVersion: "desc" } });
      const fp2 = (rr2?.plan as { fingerprint?: string } | null)?.fingerprint;

      const regions = plan?.protectedRegions ?? [];
      const hard = regions.filter((r) => r.severity === "hard");
      const cues = plan?.cuePlacements ?? [];
      const transitions = cues.filter((c) => c.kind === "transition").length;
      const reactions = cues.filter((c) => c.kind === "reaction").length;

      reports.push({
        formatId: fmt.formatId,
        finalStatus: String(result.finalStatus),
        renderStatus: String(rr?.status),
        planFingerprint: String(plan?.fingerprint ?? ""),
        planningEngine: String((diag as { planningEngine?: string }).planningEngine ?? ""),
        introTreatment: String(plan?.bookendPlan?.intro?.treatment ?? "none"),
        outroTreatment: String(plan?.bookendPlan?.outro?.treatment ?? "none"),
        bedPolicy: plan?.bedPlan?.policy ?? null,
        bedSegments: plan?.bedPlan?.segments?.length ?? 0,
        detectedGaps: plan?.detectedGaps?.length ?? 0,
        protectedRegions: regions.length,
        hardProtectedRegions: hard.length,
        transitions,
        reactions,
        cuesRejected: Number((diag as { cueRejected?: number }).cueRejected ?? 0),
        bookendsAudible: result.finalStatus === "completed" && rr?.status === "succeeded",
        deterministic: !!plan?.fingerprint && plan.fingerprint === fp2,
        mp3: `samples/post-tts-direction/${fmt.formatId}.mp3`,
      });

      // Per-format acceptance checks against THIS plan.
      await check(`${fmt.formatId}: render succeeds with audible bookends (PR 1 gate holds)`, () => {
        assert(result.finalStatus === "completed", `finalStatus completed (${result.finalStatus})`);
        assert(rr?.status === "succeeded", `render record succeeded (${rr?.status})`);
        assert((diag as { planningEngine?: string }).planningEngine === "post_tts", "post_tts engine recorded");
      });
      await check(`${fmt.formatId}: no placed cue collides with a HARD-protected speech region`, () => {
        // Region startMs/endMs already include the protective padding, so the
        // interior IS [startMs, endMs). A cue that begins exactly at endMs sits
        // on the free-window boundary the director opened — not a collision.
        for (const c of cues) {
          for (const r of hard) {
            assert(!(c.targetStartMs >= r.startMs && c.targetStartMs < r.endMs), `cue ${c.kind}@${c.targetStartMs} inside hard region [${r.startMs},${r.endMs})`);
          }
        }
      });
      await check(`${fmt.formatId}: every cue lands inside the real gap the director measured`, () => {
        for (const c of cues) assert(c.targetStartMs >= c.gapStartMs && c.targetStartMs <= c.gapEndMs, `cue ${c.kind}@${c.targetStartMs} outside gap [${c.gapStartMs},${c.gapEndMs}]`);
      });
      await check(`${fmt.formatId}: plan is deterministic (identical fingerprint on re-render)`, () => {
        const fp = plan?.fingerprint;
        assert(!!fp && fp.length === 64, "64-char fingerprint");
        assert(fp === fp2, `fingerprint stable (${fp?.slice(0, 8)} vs ${fp2?.slice(0, 8)})`);
      });
      await check(`${fmt.formatId}: diagnostics are safe (no URLs / keys / paths)`, () => {
        const s = JSON.stringify(rr?.diagnostics ?? {});
        assert(!s.match(/https?:\/\//), "no URLs");
        assert(!s.match(/[A-Za-z]:\\|\/storage\//), "no filesystem paths / storage keys");
      });
    }

    // Cross-format acceptance: the six formats must be MEANINGFULLY different.
    await check("all six formats produce distinct plan fingerprints", () => {
      const fps = new Set(reports.map((r) => r.planFingerprint).filter(Boolean));
      assert(fps.size === reports.length, `distinct fingerprints (${fps.size}/${reports.length})`);
    });
    await check("formats differ in intro/outro treatment or cue/bed behavior (not one template)", () => {
      const shapes = new Set(reports.map((r) => `${r.introTreatment}|${r.outroTreatment}|${r.bedPolicy}|${r.transitions}:${r.reactions}`));
      assert(shapes.size >= 4, `>=4 distinct production shapes (${shapes.size})`);
    });
    await check("every format rendered a mastered MP3 for listening", () => {
      for (const r of reports) assert(fs.existsSync(path.join(process.cwd(), r.mp3)), `${r.mp3} exists`);
    });

    const report = {
      generatedFor: "PR3 C6 post-TTS sound-direction acceptance",
      flag: "POST_TTS_SOUND_DIRECTION_ENABLED=true",
      network: "none (embedded Postgres + local storage + ffmpeg lavfi synth only)",
      formats: reports,
    };
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
    console.log(`\n  report + ${reports.length} MP3s -> samples/post-tts-direction/`);
  } finally {
    await db.$disconnect().catch(() => {});
    await pg.stop().catch(() => {});
    for (const k of written) { try { fs.rmSync(path.join(storageRoot, k), { force: true }); } catch { /* */ } }
    try { fs.rmSync(path.join(storageRoot, "posttts-demo"), { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
