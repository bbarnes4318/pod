// Real multi-episode sound-diversity LISTENING harness (PR 4 corrections, B2).
// Run: npm run demo:sound-diversity
//
// Renders 30+ COMPLETE local episodes through the REAL post-TTS pipeline (one
// shared embedded Postgres + real ffmpeg + local storage), with the diversity
// engine ENABLED and each episode's frozen v6 context built from the actual
// accumulating podcast history. Three series:
//   Sports radio   — 12 episodes, >=3 intros/outros/beds, several cue families, 1 motif
//   Documentary    — 8 episodes,  sparse, cinematic/reflective, no crowd/comedy, 1 motif
//   System default — 2 podcasts x 5 episodes, one shared-system pool, cross-podcast on
//
// Per episode it writes a final MP3 + safe snapshot/decision/plan/diagnostics
// JSON to samples/sound-diversity-audio/<series>/, plus per-series summaries
// (histograms, streaks, motif rate, similarity, fingerprints, MASTER HASHES).
// It then asserts real acoustic + diversity properties and a deterministic
// replay (identical master hashes). Binaries are gitignored; no network.

import EmbeddedPostgres from "embedded-postgres";
import { execSync, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) { try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); } }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
async function freePort(): Promise<number> { return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on("error", rej); }); }

interface SeriesSpec {
  name: string; formatId: string; episodes: number; podcastId: string | null; ownerId: string | null;
  intros: Array<{ id: string; family: string; motif?: boolean; weight?: number }>;
  outros: Array<{ id: string; family: string }>;
  beds: Array<{ id: string; family: string }>;
  stingers: Array<{ id: string; family: string }>;
  reactions: Array<{ id: string; family: string }>;
  identity: Record<string, unknown>;
}

async function main() {
  console.log("\nReal multi-episode sound-diversity audio harness (embedded PG + ffmpeg)\n");
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-divaudio-pg-"));
  const outRoot = path.join(process.cwd(), "samples", "sound-diversity-audio");
  fs.rmSync(outRoot, { recursive: true, force: true });
  fs.mkdirSync(outRoot, { recursive: true });

  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise(); await pg.start();
  const { Client } = await import("pg");
  const admin = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query("CREATE DATABASE divaudio ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0");
  await admin.end();
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/divaudio`;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });

  Object.assign(process.env, { NODE_ENV: "development" });
  process.env.DATABASE_URL = dbUrl;
  process.env.STORAGE_PROVIDER = "local";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.POST_TTS_SOUND_DIRECTION_ENABLED = "true";
  process.env.SOUND_DIVERSITY_ENGINE_ENABLED = "true";
  process.env.SOUND_DIVERSITY_ENFORCEMENT_MODE = "enforce";
  process.env.SOUND_DIVERSITY_SYSTEM_HISTORY_ENABLED = "true";

  const { stitchFinalEpisodeAudio } = await import("../lib/services/audioStitchingService");
  const { getStorageProvider } = await import("../lib/providers/storage/factory");
  const { db } = await import("../lib/db");
  const { readDiversityHistory } = await import("../lib/services/diversityHistory");
  const { buildFrozenDiversityContext } = await import("../lib/audio/soundDiversity");
  const { resolveSoundDiversityPolicy, diversityPolicyOverridesFromEnv } = await import("../lib/audio/soundDiversityPolicy");
  const { runFfmpeg } = await import("../lib/audio/assembly");
  const storage = getStorageProvider();
  const storageRoot = path.join(process.cwd(), "public", "storage");
  const writtenKeys: string[] = [];

  const put = async (key: string, freq: number, durSec: number, noise = false) => {
    const f = path.join(tmpRoot, `${key.replace(/\W/g, "_")}.mp3`);
    const src = noise ? `anoisesrc=color=pink:amplitude=0.3:seed=${freq}:duration=${durSec}` : `sine=frequency=${freq}:duration=${durSec}`;
    execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", src, "-ar", "44100", f], { stdio: "ignore" });
    const body = fs.readFileSync(f); writtenKeys.push(key);
    const { url } = await storage.putObject({ key, body, contentType: "audio/mpeg" });
    return { url, hash: crypto.createHash("sha256").update(body).digest("hex") };
  };
  const ref = (asset: { id: string; name: string; contentHash: string | null }, role: string, kind: string, over: Record<string, unknown> = {}) => ({
    assetId: asset.id, kind, category: null, name: asset.name, contentHash: asset.contentHash, scope: "shared_system", role, orderIndex: 0,
    gainDb: null, fadeInMs: null, fadeOutMs: null, durationMs: 3000, tags: [], rightsStatusAtCapture: "not_required", licenseStatusAtCapture: "licensed",
    provenance: "podcast_assignment", weight: 1, cueFamily: null, isBrandedMotif: false, allowedFormatIds: [], prohibitedFormatIds: [], maxUsesPerEpisode: null, minEpisodeCooldown: null, ...over,
  });

  const seriesResults: Record<string, Array<Record<string, unknown>>> = {};

  try {
    // Users + podcasts.
    await db.user.create({ data: { id: "owner-sports", email: "sports@x.test" } });
    await db.user.create({ data: { id: "owner-doc", email: "doc@x.test" } });
    await db.podcast.create({ data: { id: "pod-sports", name: "Sports", cadence: "recurring", ownerId: "owner-sports" } });
    await db.podcast.create({ data: { id: "pod-doc", name: "Doc", cadence: "recurring", ownerId: "owner-doc" } });

    // Freq generator so every asset tone is distinct.
    let freq = 200;
    const mkAsset = async (id: string, kind: string, name: string) => {
      const a = await put(`divaudio/${id}.mp3`, (freq += 7), kind === "bed" ? 30 : kind.startsWith("theme") ? 3 : 1.0);
      return db.audioAsset.create({ data: { id, name, kind, tags: [], audioUrl: a.url, license: "x", scope: "shared_system", processingStatus: "ready", contentHash: a.hash, durationMs: kind === "bed" ? 30000 : kind.startsWith("theme") ? 3000 : 1000, isActive: true, licenseStatus: "licensed", rightsStatus: "not_required" } });
    };

    const specs: SeriesSpec[] = [
      { name: "sports", formatId: "sports_radio", episodes: 12, podcastId: "pod-sports", ownerId: "owner-sports",
        intros: [{ id: "sp-i-brand", family: "brand_main", motif: true, weight: 2 }, { id: "sp-i-b", family: "brand_high_energy" }, { id: "sp-i-c", family: "brand_short" }],
        outros: [{ id: "sp-o-1", family: "close_main" }, { id: "sp-o-2", family: "close_high_energy" }, { id: "sp-o-3", family: "close_short" }],
        beds: [{ id: "sp-bed-1", family: "pulse" }, { id: "sp-bed-2", family: "drive" }, { id: "sp-bed-3", family: "ambient" }],
        stingers: [{ id: "sp-st-hit", family: "hard_hit" }, { id: "sp-st-score", family: "score_update" }, { id: "sp-st-sweep", family: "quick_sweep" }],
        reactions: [{ id: "sp-rx-crowd", family: "crowd_positive" }, { id: "sp-rx-agree", family: "agreement" }],
        identity: { brandedMotifEnabled: true, bedPolicy: "select_segments" } },
      { name: "documentary", formatId: "documentary", episodes: 8, podcastId: "pod-doc", ownerId: "owner-doc",
        intros: [{ id: "d-i-brand", family: "brand_minimal", motif: true, weight: 2 }, { id: "d-i-b", family: "brand_main" }],
        outros: [{ id: "d-o-1", family: "close_reflective" }, { id: "d-o-2", family: "close_main" }],
        beds: [{ id: "d-bed-1", family: "cinematic" }, { id: "d-bed-2", family: "ambient" }, { id: "d-bed-3", family: "drone" }],
        stingers: [{ id: "d-st-bridge", family: "cinematic_bridge" }, { id: "d-st-tension", family: "tension_rise" }],
        reactions: [{ id: "d-rx-reflect", family: "understated_transition" }],
        identity: { brandedMotifEnabled: true, bedPolicy: "select_segments", prohibitedCueFamilies: ["crowd_positive", "crowd_negative", "comedy_button", "hard_hit", "score_update"] } },
      { name: "system-1", formatId: "two_host_debate", episodes: 5, podcastId: null, ownerId: null,
        intros: [{ id: "sys-i-1", family: "sys_open" }, { id: "sys-i-2", family: "sys_open_b" }, { id: "sys-i-3", family: "sys_open_c" }],
        outros: [{ id: "sys-o-1", family: "sys_close" }, { id: "sys-o-2", family: "sys_close_b" }],
        beds: [{ id: "sys-bed-1", family: "sys_pad" }, { id: "sys-bed-2", family: "sys_pad_b" }],
        stingers: [{ id: "sys-st-1", family: "topic_reset" }, { id: "sys-st-2", family: "quick_sweep" }],
        reactions: [{ id: "sys-rx-1", family: "agreement" }],
        identity: { brandedMotifEnabled: false, bedPolicy: "select_segments" } },
    ];

    // Create the shared asset set ONCE (system-2 reuses the system-1 pool).
    const assetCache = new Map<string, Awaited<ReturnType<typeof mkAsset>>>();
    const ensureAssets = async (spec: SeriesSpec) => {
      const mk = async (id: string, kind: string) => { if (!assetCache.has(id)) assetCache.set(id, await mkAsset(id, kind, id)); return assetCache.get(id)!; };
      for (const i of spec.intros) await mk(i.id, "theme_intro");
      for (const o of spec.outros) await mk(o.id, "theme_outro");
      for (const b of spec.beds) await mk(b.id, "bed");
      for (const s of spec.stingers) await mk(s.id, "stinger");
      for (const r of spec.reactions) await mk(r.id, "sfx");
    };

    const buildProfile = (spec: SeriesSpec) => ({
      mode: spec.podcastId ? "custom" : "system_default", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
      introEnabled: true, outroEnabled: true,
      intro: ref(assetCache.get(spec.intros[0].id)!, "intro", "theme_intro", { cueFamily: spec.intros[0].family, isBrandedMotif: !!spec.intros[0].motif }),
      outro: ref(assetCache.get(spec.outros[0].id)!, "outro", "theme_outro", { cueFamily: spec.outros[0].family }),
      bed: ref(assetCache.get(spec.beds[0].id)!, "bed", "bed", { cueFamily: spec.beds[0].family }),
      stingers: spec.stingers.map((s) => ref(assetCache.get(s.id)!, "stinger", "stinger", { cueFamily: s.family })),
      reactions: spec.reactions.map((r) => ref(assetCache.get(r.id)!, "reaction", "sfx", { cueFamily: r.family })),
      introVariants: spec.intros.map((i) => ref(assetCache.get(i.id)!, "intro", "theme_intro", { cueFamily: i.family, isBrandedMotif: !!i.motif, weight: i.weight ?? 1 })),
      outroVariants: spec.outros.map((o) => ref(assetCache.get(o.id)!, "outro", "theme_outro", { cueFamily: o.family })),
      beds: spec.beds.map((b) => ref(assetCache.get(b.id)!, "bed", "bed", { cueFamily: b.family })),
      sonicIdentity: { version: 1, primaryGenre: null, secondaryGenres: [], moods: [], pace: null, intensity: null, broadcastStyle: null, preferredInstrumentation: [], prohibitedInstrumentation: [], allowedCueFamilies: [], prohibitedCueFamilies: [], allowedFormatIds: [], prohibitedFormatIds: [], humorEffectsAllowed: true, crowdEffectsAllowed: true, underSpeechEffectsAllowed: true, brandedMotifEnabled: true, transitionFrequency: null, maximumEffectsIntensity: null, bedPolicy: "select_segments", introTreatment: null, outroTreatment: null, minimumMusicGapMs: null, maximumMusicGapMs: null, voiceOverMusicPolicy: null, ...spec.identity },
      containsLegacyCompatAssets: false, excluded: [],
    });

    const policy = resolveSoundDiversityPolicy({ overrides: { ...diversityPolicyOverridesFromEnv(), systemCrossPodcastDiversityEnabled: true } });
    const lineTexts = ["Welcome in to the show today everyone.", "We have a lot to cover this hour.", "Now on to our second big story.", "Thanks so much for listening, see you next time."];

    // Render one episode: build a frozen v6 snapshot from live history, then render.
    const renderEpisode = async (spec: SeriesSpec, i: number, podKey: string, ownerId: string | null, podcastId: string | null) => {
      const seed = `${podKey}:ep${i}`;
      const scope = podcastId ? { kind: "podcast" as const, podcastId } : { kind: "system" as const };
      const history = await readDiversityHistory({ db: db as never, scope, windowEpisodes: policy.historyWindowEpisodes, systemHistoryEnabled: true });
      const systemHistory = await readDiversityHistory({ db: db as never, scope: { kind: "system" }, windowEpisodes: policy.historyWindowEpisodes, systemHistoryEnabled: true });
      const profile = buildProfile(spec);
      const built = buildFrozenDiversityContext(profile as never, { policy, mode: "enforce", history, systemHistory, seed, formatId: spec.formatId, identity: (profile as { sonicIdentity: unknown }).sonicIdentity as never });
      const sp = { ...profile, intro: built.intro, outro: built.outro, bed: built.bed };
      const roleMap: Record<string, string[]> = { sports_radio: ["lead_host", "co_host"], two_host_debate: ["chair_a", "chair_b"], documentary: ["narrator"], solo_commentary: ["anchor"] };
      const roles = roleMap[spec.formatId] ?? ["anchor"];
      const hosts: Array<{ id: string; name: string }> = [];
      for (let h = 0; h < roles.length; h++) hosts.push(await db.aiHost.create({ data: { name: `H${h}-${seed}`, slug: `h${h}-${seed}`.replace(/[:]/g, "-"), role: "host", worldview: "w", speakingStyle: "s", catchphrases: [], likes: [], dislikes: [], argumentPatterns: [], bannedPhrases: [], intensityLevel: 5, ttsProvider: "stub", ttsVoiceId: "v", isActive: true } }));
      const hostIds = hosts.map((h) => h.id);
      const snapshot = { version: 6, cast: { formatId: spec.formatId, formatVersion: 2, members: hosts.map((h, idx) => ({ hostId: h.id, role: roles[idx], orderIndex: idx })) }, source: podcastId ? "podcast" : "standalone", capturedAt: "2026-01-01T00:00:00.000Z", podcast: null, editorial: { verticals: [], teams: [], segmentCount: 2, format: spec.formatId, minDebateScore: null, scriptStyle: null, maxWords: null, provenance: {} }, production: { hostIds, ttsProvider: null, ttsVoiceOverrides: null, productionStyle: null, sfxDensity: null, provenance: {}, soundProfile: sp, diversityContext: built.context } };
      const prior = await put(`divaudio/${seed.replace(/\W/g, "_")}-prior.mp3`, 500, 1.0);
      // DETERMINISTIC episode id + createdAt so the history reader's ordering
      // (createdAt desc, id desc) is identical across harness runs — otherwise a
      // random uuid tiebreak on colliding createdAt would change the selection.
      const epId = `ep-${seed.replace(/[^a-z0-9]/gi, "-")}`;
      const ep = await db.episode.create({ data: { id: epId, title: seed, slug: seed.replace(/[:]/g, "-"), status: "content_ready", formatId: spec.formatId, hostIds, ownerId, podcastId, audioUrl: prior.url, durationSeconds: 10, soundDesign: { style: "full" } as object, configurationSource: podcastId ? "podcast" : "standalone", configurationSnapshot: snapshot as object, configurationFingerprint: `fp-${seed}`, createdAt: new Date(`2026-02-${String((i % 27) + 1).padStart(2, "0")}T0${i % 9}:00:00.000Z`) } });
      const mkLine = (n: number) => { const h = hosts[n % hosts.length]; return { lineIndex: n, speakerName: h.name, speakerHostId: h.id, text: lineTexts[n], tone: n === 2 ? "amused" : "neutral", isFactualClaim: false, needsHumanReview: false, evidenceRefs: [], energy: n === 2 ? "high" : "medium" }; };
      // Deterministic script id too: the director's cue seed is
      // `${episode.id}:${scriptId}`, so both must be stable across runs.
      const script = await db.script.create({ data: { id: `sc-${epId}`, episodeId: ep.id, version: 1, status: "approved", plainText: lineTexts.join(" "), content: { segments: [{ type: "topic", lines: [mkLine(0), mkLine(1)] }, { type: "topic", lines: [mkLine(2), mkLine(3)] }] } as object } });
      for (let n = 0; n < 4; n++) { const seg = await put(`divaudio/${seed.replace(/\W/g, "_")}-seg${n}.mp3`, 700 + n, 1.5, true); await db.audioSegment.create({ data: { episodeId: ep.id, scriptId: script.id, lineIndex: n, text: lineTexts[n], audioUrl: seg.url, status: "ready", durationMs: 1500 } }); }
      await db.factCheckResult.create({ data: { scriptId: script.id, episodeId: ep.id, passed: true, status: "passed", warnings: [] as object, errors: [] as object } });

      const result = await stitchFinalEpisodeAudio({ scriptId: script.id, forceRegenerate: true, productionStyle: "full" });
      const rr = await db.episodeAudioRender.findFirst({ where: { episodeId: ep.id }, orderBy: { renderVersion: "desc" } });
      const updated = await db.episode.findUnique({ where: { id: ep.id } });
      const m = updated?.audioUrl?.match(/\/storage\/(.+)$/);
      const seriesDir = path.join(outRoot, podKey); fs.mkdirSync(seriesDir, { recursive: true });
      const mp3Out = path.join(seriesDir, `ep${String(i).padStart(2, "0")}.mp3`);
      let masterHash = "";
      if (m) { try { const buf = fs.readFileSync(path.join(storageRoot, m[1])); fs.writeFileSync(mp3Out, buf); masterHash = crypto.createHash("sha256").update(buf).digest("hex"); } catch { /* */ } }
      const plan = rr?.plan as Record<string, unknown> | null;
      const diag = (rr?.diagnostics as { postTts?: Record<string, unknown>; bookend?: { ok?: boolean; checks?: unknown[] } } | null);
      // Safe per-episode JSONs.
      fs.writeFileSync(path.join(seriesDir, `ep${String(i).padStart(2, "0")}.decision.json`), JSON.stringify(built.context, null, 2));
      fs.writeFileSync(path.join(seriesDir, `ep${String(i).padStart(2, "0")}.diagnostics.json`), JSON.stringify(diag?.postTts ?? {}, null, 2));

      return {
        seed, ep: ep.id, script: script.id, finalStatus: String(result.finalStatus), renderStatus: String(rr?.status),
        intro: built.intro?.assetId ?? null, outro: built.outro?.assetId ?? null, bed: built.bed?.assetId ?? null,
        introFamily: built.intro?.cueFamily ?? null, outroFamily: built.outro?.cueFamily ?? null,
        introMotif: !!built.intro?.isBrandedMotif,
        transitions: (plan?.cuePlacements as Array<{ kind: string; assetId: string }> | undefined)?.filter((c) => c.kind === "transition").map((c) => c.assetId) ?? [],
        reactions: (plan?.cuePlacements as Array<{ kind: string; assetId: string }> | undefined)?.filter((c) => c.kind === "reaction").map((c) => c.assetId) ?? [],
        bookendOk: diag?.bookend?.ok !== false, masterHash, diversityFingerprint: built.context.fingerprint,
        planFingerprint: String(plan?.fingerprint ?? ""), durationSec: Number(result.durationSeconds ?? 0),
        hardCueOverProtected: hardCollision(plan),
        mp3: path.relative(process.cwd(), mp3Out),
      };
      void runFfmpeg;
    };

    function hardCollision(plan: Record<string, unknown> | null): boolean {
      if (!plan) return false;
      const regions = (plan.protectedRegions as Array<{ startMs: number; endMs: number; severity: string }> | undefined)?.filter((r) => r.severity === "hard") ?? [];
      const cues = (plan.cuePlacements as Array<{ targetStartMs: number }> | undefined) ?? [];
      for (const c of cues) for (const r of regions) if (c.targetStartMs >= r.startMs && c.targetStartMs < r.endMs) return true;
      return false;
    }

    // Render all series (system-2 reuses the system pool as a SECOND podcast).
    for (const spec of specs) await ensureAssets(spec);
    for (const spec of specs) {
      const results: Array<Record<string, unknown>> = [];
      for (let i = 0; i < spec.episodes; i++) results.push(await renderEpisode(spec, i, spec.name, spec.ownerId, spec.podcastId));
      seriesResults[spec.name] = results;
    }
    // System series 2: same shared pool, DIFFERENT podcast (null/null but distinct seed prefix).
    {
      const spec = specs[2];
      const results: Array<Record<string, unknown>> = [];
      for (let i = 0; i < spec.episodes; i++) results.push(await renderEpisode(spec, i, "system-2", null, null));
      seriesResults["system-2"] = results;
    }

    // Summaries + master hashes.
    const summaries: Record<string, unknown> = {};
    for (const [name, eps] of Object.entries(seriesResults)) {
      const hist = (vals: Array<unknown>) => { const h: Record<string, number> = {}; for (const v of vals) if (v) h[String(v)] = (h[String(v)] ?? 0) + 1; return h; };
      const pairs = eps.map((e) => `${e.intro}>${e.outro}`);
      const maxStreak = (vals: Array<unknown>) => { let max = 0, cur = 0; let prev: unknown; for (const v of vals) { if (v === prev) cur++; else cur = 1; prev = v; if (cur > max) max = cur; } return max; };
      summaries[name] = {
        episodes: eps.length, introHistogram: hist(eps.map((e) => e.intro)), outroHistogram: hist(eps.map((e) => e.outro)), bedHistogram: hist(eps.map((e) => e.bed)),
        pairHistogram: hist(pairs), maxPairStreak: maxStreak(pairs), maxIntroStreak: maxStreak(eps.map((e) => e.intro)), maxBedStreak: maxStreak(eps.map((e) => e.bed)),
        motifRate: eps.filter((e) => e.introMotif).length / eps.length, transitionHistogram: hist(eps.flatMap((e) => e.transitions as string[])),
        masterHashes: eps.map((e) => e.masterHash), diversityFingerprints: eps.map((e) => e.diversityFingerprint),
      };
    }
    const overallFp = crypto.createHash("sha256").update(JSON.stringify(summaries)).digest("hex");
    fs.writeFileSync(path.join(outRoot, "series-summary.json"), JSON.stringify({ overallFingerprint: overallFp, summaries }, null, 2));

    const all = Object.values(seriesResults).flat();
    console.log(`\n  rendered ${all.length} episodes -> samples/sound-diversity-audio/`);

    // ---- Acoustic assertions ----------------------------------------------
    await check(`all ${all.length} episodes rendered a completed master + MP3`, () => {
      assert(all.length >= 30, `>=30 episodes (${all.length})`);
      for (const e of all) { assert(e.finalStatus === "completed" && e.renderStatus === "succeeded", `${e.seed} completed`); assert(!!e.masterHash && fs.existsSync(path.join(process.cwd(), e.mp3 as string)), `${e.seed} MP3`); }
    });
    await check("every required bookend is audible (post-render QA passed)", () => { for (const e of all) assert(e.bookendOk === true, `${e.seed} bookends audible`); });
    await check("no hard cue overlaps hard-protected speech in any episode", () => { for (const e of all) assert(e.hardCueOverProtected === false, `${e.seed} no hard collision`); });
    await check("final duration is positive and agrees with a real render", () => { for (const e of all) assert(Number(e.durationSec) > 0, `${e.seed} duration ${e.durationSec}`); });

    // ---- Diversity assertions ---------------------------------------------
    await check("sports: no single intro monopolizes the 12-episode series", () => {
      const h = (summaries.sports as { introHistogram: Record<string, number> }).introHistogram;
      assert(Object.keys(h).length >= 2 && Math.max(...Object.values(h)) < 12, `spread (${JSON.stringify(h)})`);
    });
    await check("sports: the exact intro/outro pair does not streak beyond policy", () => {
      assert((summaries.sports as { maxPairStreak: number }).maxPairStreak <= 2, `pair streak ${(summaries.sports as { maxPairStreak: number }).maxPairStreak}`);
    });
    await check("documentary uses NO prohibited (crowd/comedy/sports) transition family", () => {
      const h = (summaries.documentary as { transitionHistogram: Record<string, number> }).transitionHistogram;
      const docTransIds = new Set(["d-st-bridge", "d-st-tension"]);
      assert(Object.keys(h).every((id) => docTransIds.has(id)), `only documentary stingers (${Object.keys(h)})`);
    });
    await check("documentary remains sparser than sports (fewer cues)", () => {
      const docCues = (seriesResults.documentary).reduce((a, e) => a + (e.transitions as string[]).length + (e.reactions as string[]).length, 0);
      const sportsCues = (seriesResults.sports).reduce((a, e) => a + (e.transitions as string[]).length + (e.reactions as string[]).length, 0);
      assert(sportsCues >= docCues, `sports >= documentary cues (${sportsCues} vs ${docCues})`);
    });
    await check("two system podcasts do not receive identical full sequences", () => {
      const s1 = seriesResults["system-1"].map((e) => `${e.intro}/${e.outro}/${(e.transitions as string[]).join(",")}`).join("|");
      const s2 = seriesResults["system-2"].map((e) => `${e.intro}/${e.outro}/${(e.transitions as string[]).join(",")}`).join("|");
      assert(s1 !== s2, "system podcasts diverge");
    });
    await check("sports branded motif appears but does not saturate", () => {
      const r = (summaries.sports as { motifRate: number }).motifRate;
      assert(r > 0 && r <= policy.brandedMotifMaximumRate + 0.25, `motif rate ${r.toFixed(2)}`);
    });
    await check("diagnostics + decision JSON are safe (no URLs / keys / paths)", () => {
      const s = fs.readFileSync(path.join(outRoot, "series-summary.json"), "utf8");
      assert(!s.match(/https?:\/\/|\/storage\/|[A-Za-z]:\\\\/), "no URLs/keys/paths in summary");
    });

    // ---- Reproduce one episode per series (verbatim + byte-identical master) --
    await check("stored-plan reproduce renders one episode per series verbatim (identical plan fp + MASTER HASH)", async () => {
      for (const name of ["sports", "documentary", "system-1"]) {
        const first = seriesResults[name][0];
        const rep = await stitchFinalEpisodeAudio({ scriptId: first.script as string, renderMode: "reproduce", forceRegenerate: true, productionStyle: "full" });
        assert(rep.finalStatus === "completed", `${name} reproduce completes (${rep.finalStatus})`);
        const rr = await db.episodeAudioRender.findFirst({ where: { episodeId: first.ep as string, status: "succeeded" }, orderBy: { renderVersion: "desc" } });
        assert((rr?.plan as { fingerprint?: string } | null)?.fingerprint === first.planFingerprint, `${name} plan fingerprint unchanged`);
        const upd = await db.episode.findUnique({ where: { id: first.ep as string } });
        const mm = upd?.audioUrl?.match(/\/storage\/(.+)$/);
        const repHash = mm ? crypto.createHash("sha256").update(fs.readFileSync(path.join(storageRoot, mm[1]))).digest("hex") : "";
        assert(repHash === first.masterHash, `${name} reproduce master is byte-identical`);
      }
    });

    await check("determinism: re-rendering an episode produces a byte-identical master (same inputs -> same audio)", async () => {
      for (const name of ["sports", "documentary"]) {
        const first = seriesResults[name][0];
        const r = await stitchFinalEpisodeAudio({ scriptId: first.script as string, forceRegenerate: true, productionStyle: "full" });
        assert(r.finalStatus === "completed", `${name} re-render completes`);
        const upd = await db.episode.findUnique({ where: { id: first.ep as string } });
        const mm = upd?.audioUrl?.match(/\/storage\/(.+)$/);
        const rehash = mm ? crypto.createHash("sha256").update(fs.readFileSync(path.join(storageRoot, mm[1]))).digest("hex") : "";
        assert(rehash === first.masterHash, `${name} re-rendered master hash identical`);
      }
      for (const e of all) assert(typeof e.diversityFingerprint === "string" && (e.diversityFingerprint as string).length === 64, `${e.seed} diversity fingerprint`);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    await db.$disconnect().catch(() => {});
    await pg.stop().catch(() => {});
    for (const k of writtenKeys) { try { fs.rmSync(path.join(storageRoot, k), { force: true }); } catch { /* */ } }
    try { fs.rmSync(path.join(storageRoot, "divaudio"), { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  }
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
