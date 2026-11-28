// Release integrity against a REAL PostgreSQL.
//
// testReleaseIntegrity.ts proves the provenance rules on plain objects. This
// proves what only a database can: that the real gate (validateEpisodeForRss),
// the real publish paths (prepareEpisodeForPublishing / publishEpisode /
// unpublishEpisode) and the real row lock (withReleaseLock, editScriptContent)
// behave on real rows, with real `SELECT ... FOR UPDATE` statements.
//
// What is NOT real here, said plainly: no audio is voiced or mixed. The scene,
// line and render rows are written by this file, with their provenance built
// by the same helpers the voicing and mixing services call (sceneProvenance,
// buildMasterProvenance, checkedLineHashes). The audio URLs point at nothing;
// `audioFileSizeBytes` is stored so the gate never asks storage.
//
// Run: npm run test:integration-release-integrity
// Needs DATABASE_URL pointing at a throwaway, migrated PostgreSQL. Never a
// production URL: this creates and deletes rows.

import { PrismaClient } from "@prisma/client";
import { check, requireEnv, summarize, uid } from "./integration/helpers";

const DB_URL = requireEnv("DATABASE_URL");
if (!/@(127\.0\.0\.1|localhost|db)[:/]/.test(DB_URL)) {
  console.error("Refusing to run: DATABASE_URL is not a local throwaway database.");
  process.exit(2);
}

// The gate reads these at call time. Test-only values, nothing is fetched.
Object.assign(process.env, {
  PODCAST_TITLE: "Release Integrity Test Show",
  PODCAST_DESCRIPTION: "Fixture show for the release integrity database test.",
  PODCAST_LANGUAGE: "en",
  PODCAST_AUTHOR: "Test Author",
  PODCAST_OWNER_NAME: "Test Owner",
  PODCAST_OWNER_EMAIL: "owner@example.test",
  PODCAST_SITE_URL: "https://example.test",
  PODCAST_RSS_URL: "https://example.test/rss.xml",
  PODCAST_IMAGE_URL: "https://example.test/cover.png",
});

type Line = { lineIndex: number; speakerHostId: string; speakerName: string; text: string; isFactualClaim?: boolean; needsHumanReview?: boolean; evidenceRefs?: { type: string; id: string }[]; dirty?: boolean };
type Content = { segments: { title: string; type: string; lines: Line[] }[] };

/** Four lines, two segments. Scene 0 = lines 0,1. Scene 1 = lines 2,3. */
function freshContent(): Content {
  const L = (lineIndex: number, text: string, extra: Partial<Line> = {}): Line => ({
    lineIndex, speakerHostId: lineIndex % 2 === 0 ? "host-a" : "host-b", speakerName: lineIndex % 2 === 0 ? "Alex" : "Blake", text, ...extra,
  });
  return {
    segments: [
      { title: "Open", type: "cold_open", lines: [L(0, "Welcome back to the show."), L(1, "They won twelve of their last fifteen.", { isFactualClaim: true, evidenceRefs: [{ type: "research", id: "research-1" }] })] },
      { title: "Close", type: "conversation", lines: [L(2, "That schedule was soft."), L(3, "See you Sunday.")] },
    ],
  };
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
async function rejects(p: Promise<unknown>, pattern: RegExp, label: string): Promise<string> {
  try {
    await p;
  } catch (err) {
    const msg = (err as Error).message;
    assert(pattern.test(msg), `${label}: refused, but for the wrong reason: ${msg}`);
    return msg;
  }
  throw new Error(`${label}: expected a refusal, but it went through`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("\nRelease integrity (real PostgreSQL)\n");

  // Imported after the env above is set. `db` is the app's own client.
  const { db } = await import("../lib/db");
  const rss = await import("../lib/services/rssPublishingService");
  const prov = await import("../lib/services/artifactProvenance");
  const { validateEpisodeForRss, prepareEpisodeForPublishing, publishEpisode, unpublishEpisode, editScriptContent, staleAudioLineIndexes } = rss;

  // A second, independent connection pool: plays "someone else" in lock tests.
  const other = new PrismaClient();
  const episodeIds: string[] = [];

  /* ------------------------------ fixtures ------------------------------ */

  const audioUrlFor = (slug: string, v: number) => `https://storage.example.test/${slug}/final-v${v}.mp3`;

  async function recordFactCheck(scriptId: string, episodeId: string, opts: { withCheckedLines?: boolean } = {}) {
    const script = await db.script.findUniqueOrThrow({ where: { id: scriptId }, select: { content: true } });
    await db.factCheckResult.create({
      data: {
        scriptId, episodeId, passed: true, status: "passed", warnings: [], errors: [], issues: {},
        summary: opts.withCheckedLines === false ? { totalErrors: 0 } : { totalErrors: 0, checkedLines: prov.checkedLineHashes(script.content) },
      },
    });
  }

  /** Voice one scene: a NEW selected row (older candidates are deselected), as ttsSceneService does. */
  async function voiceScene(scriptId: string, episodeId: string, sceneIndex: number, lineIndexes: number[]) {
    const script = await db.script.findUniqueOrThrow({ where: { id: scriptId }, select: { content: true } });
    const turns = prov.scriptTurns(script.content).filter((t) => lineIndexes.includes(t.lineIndex));
    await db.dialogueSceneAudio.updateMany({ where: { scriptId, sceneIndex }, data: { selected: false } });
    const candidateIndex = await db.dialogueSceneAudio.count({ where: { scriptId, sceneIndex } });
    return db.dialogueSceneAudio.create({
      data: {
        episodeId, scriptId, sceneIndex, sceneType: "conversation", firstLineIndex: lineIndexes[0], lastLineIndex: lineIndexes[lineIndexes.length - 1],
        lineIndexes, provider: "fish", model: "s2-pro", renderUnit: "multi_speaker_scene", voiceMap: { "host-a": "voice-a", "host-b": "voice-b" },
        requestFingerprint: uid("fixture-fp"), candidateIndex, status: "ready", selected: true,
        audioUrl: `https://storage.example.test/scene-${sceneIndex}-${candidateIndex}.mp3`, durationMs: 4000,
        providerMetadata: { endpoint: "fixture", provenance: prov.sceneProvenance(turns) },
      },
    });
  }

  /** Voice (or re-voice) one line in place, as the line TTS path does. */
  async function voiceLine(scriptId: string, episodeId: string, lineIndex: number) {
    const script = await db.script.findUniqueOrThrow({ where: { id: scriptId }, select: { content: true } });
    const turn = prov.scriptTurns(script.content).find((t) => t.lineIndex === lineIndex)!;
    const data = { text: turn.text, status: "ready", audioUrl: `https://storage.example.test/line-${lineIndex}-${uid("v")}.mp3`, durationMs: 2000 };
    const existing = await db.audioSegment.findFirst({ where: { scriptId, lineIndex } });
    if (existing) await db.audioSegment.update({ where: { id: existing.id }, data });
    else await db.audioSegment.create({ data: { episodeId, scriptId, lineIndex, hostId: turn.speakerHostId, ...data } });
  }

  /** Final mix: a succeeded render over the current script and current recordings. */
  async function mix(scriptId: string, episodeId: string, slug: string, opts: { provenance?: boolean; status?: string } = {}) {
    const script = await db.script.findUniqueOrThrow({ where: { id: scriptId }, select: { content: true } });
    const scenes = await db.dialogueSceneAudio.findMany({ where: { scriptId, selected: true, status: "ready" } });
    const lines = await db.audioSegment.findMany({ where: { scriptId, status: "ready" } });
    const renderVersion = (await db.episodeAudioRender.count({ where: { episodeId } })) + 1;
    const running = opts.status === "running";
    const outputAudioUrl = audioUrlFor(slug, renderVersion);
    const provenance = prov.buildMasterProvenance(scriptId, script.content, scenes.length ? { scenes } : { lines });
    await db.episodeAudioRender.create({
      data: {
        episodeId, scriptId, renderVersion, status: running ? "running" : "succeeded", renderMode: "initial",
        diagnostics: opts.provenance === false ? { cues: [] } : { cues: [], provenance },
        outputAudioUrl: running ? null : outputAudioUrl, completedAt: running ? null : new Date(),
      },
    });
    if (!running) await db.episode.update({ where: { id: episodeId }, data: { audioUrl: outputAudioUrl } });
  }

  /** An approved, fact-checked, voiced and mixed episode that should be releasable. */
  async function makeEpisode(mode: "scene" | "legacy_line", opts: { content?: Content; mixProvenance?: boolean } = {}) {
    const slug = uid(`release-integrity-${mode}`);
    const episode = await db.episode.create({
      data: {
        title: `Release integrity fixture ${slug}`, slug, status: "content_ready", description: "Fixture episode.",
        longShowNotes: "Show notes for the release integrity fixture episode.", durationSeconds: 120,
        transcriptUrl: `https://storage.example.test/${slug}/transcript.txt`, audioFileSizeBytes: 1_234_567, audioMimeType: "audio/mpeg",
        ttsRenderMode: mode,
      },
    });
    episodeIds.push(episode.id);
    const script = await db.script.create({ data: { episodeId: episode.id, version: 1, status: "approved", content: opts.content ?? freshContent() } });
    await recordFactCheck(script.id, episode.id);
    if (mode === "scene") {
      await voiceScene(script.id, episode.id, 0, [0, 1]);
      await voiceScene(script.id, episode.id, 1, [2, 3]);
    } else {
      for (const i of [0, 1, 2, 3]) await voiceLine(script.id, episode.id, i);
    }
    await mix(script.id, episode.id, slug, { provenance: opts.mixProvenance });
    return { episodeId: episode.id, scriptId: script.id, slug };
  }

  /** Edit one line exactly as the Studio editor does (mutateLatestScriptLine): locked, and marked dirty. */
  const editLine = (scriptId: string, lineIndex: number, text: string) =>
    editScriptContent(scriptId, (content) => {
      let hit = false;
      for (const seg of content.segments ?? []) for (const line of seg.lines ?? []) if (line.lineIndex === lineIndex) { line.text = text; line.dirty = true; hit = true; }
      return hit ? { content, result: true } : { content: null, result: false };
    });

  const statusOf = async (episodeId: string) => (await db.episode.findUniqueOrThrow({ where: { id: episodeId }, select: { status: true } })).status;
  const lineText = async (scriptId: string, lineIndex: number) => {
    const s = await db.script.findUniqueOrThrow({ where: { id: scriptId }, select: { content: true } });
    return prov.scriptTurns(s.content).find((t) => t.lineIndex === lineIndex)?.text;
  };

  /* -------------------- 1. scene-voiced, everything current -------------------- */

  const scene = await makeEpisode("scene");

  await check("scene-voiced: a current episode with recorded provenance passes the three new checks", async () => {
    const val = await validateEpisodeForRss(scene.scriptId, "prepare");
    assert(val.checks.factCheckCurrent, `factCheckCurrent is false: ${val.errorReasons.join("; ")}`);
    assert(val.checks.audioMatchesScript, `audioMatchesScript is false: ${val.errorReasons.join("; ")}`);
    assert(val.checks.finalMixCurrent, `finalMixCurrent is false: ${val.errorReasons.join("; ")}`);
    assert(val.integrity?.mode === "scene" && val.integrity.master === "current" && val.integrity.masterProof === "recorded", `integrity was ${JSON.stringify(val.integrity)}`);
    assert(val.eligible, `gate refused a current episode: ${val.errorReasons.join("; ")}`);
  });

  await check("scene-voiced: prepare then publish go through, and the publish log records what went out", async () => {
    await prepareEpisodeForPublishing(scene.scriptId);
    assert((await statusOf(scene.episodeId)) === "publish_ready", "prepare did not set publish_ready");
    const out = await publishEpisode(scene.scriptId);
    assert((await statusOf(scene.episodeId)) === "published", "publish did not set published");
    const script = await db.script.findUniqueOrThrow({ where: { id: scene.scriptId }, select: { content: true } });
    assert(out.released.scriptFingerprint === prov.scriptFingerprint(script.content), "released.scriptFingerprint is not the published script's fingerprint");
    assert(out.released.masterProof === "recorded", `released.masterProof was ${out.released.masterProof}`);
    const log = await db.jobLog.findFirst({ where: { jobType: "rss:publish-episode", status: "completed", input: { path: ["scriptId"], equals: scene.scriptId } } });
    assert((log?.output as { released?: { audioUrl?: string } } | null)?.released?.audioUrl === out.released.audioUrl, "JobLog.output.released was not stored");
  });

  /* ---------- 2. unpublish is never blocked, even when everything is stale ---------- */

  await check("unpublish is never blocked: a published episode whose script was edited still unpublishes", async () => {
    await editLine(scene.scriptId, 1, "They won thirteen of their last fifteen.");
    const val = await validateEpisodeForRss(scene.scriptId, "unpublish");
    assert(val.checks.factCheckCurrent && val.checks.audioMatchesScript && val.checks.finalMixCurrent, "an integrity check blocked unpublish");
    assert(val.eligible, `the gate refused unpublish: ${val.errorReasons.join("; ")}`);
    await unpublishEpisode(scene.scriptId);
    assert((await statusOf(scene.episodeId)) === "publish_ready", "unpublish did not return the episode to publish_ready");
  });

  /* ----------------- 3. an edit after voicing blocks every route ----------------- */

  await check("scene-voiced: after a line edit the gate reports stale fact check, stale scene audio and a stale final mix", async () => {
    const val = await validateEpisodeForRss(scene.scriptId, "publish");
    assert(!val.eligible, "the gate still says eligible after an edit");
    assert(!val.checks.factCheckCurrent, "factCheckCurrent stayed true");
    assert(!val.checks.audioMatchesScript, "audioMatchesScript stayed true");
    assert(!val.checks.finalMixCurrent, "finalMixCurrent stayed true");
    assert(JSON.stringify(val.integrity?.staleScenes) === "[0]", `staleScenes was ${JSON.stringify(val.integrity?.staleScenes)}, expected only the edited scene`);
    const all = val.errorReasons.join(" | ");
    assert(/edited after the last fact check/.test(all), `no fact-check reason in: ${all}`);
    assert(/Scene audio no longer matches the script \(scene 1\)/.test(all), `no scene-audio reason in: ${all}`);
    assert(/The script changed after the final mix was made/.test(all), `no final-mix reason in: ${all}`);
  });

  await check("scene-voiced: publishEpisode called directly (the admin path) refuses the edited episode and changes nothing", async () => {
    await rejects(publishEpisode(scene.scriptId), /Publishing failed\. Blockers: .*Scene audio no longer matches/, "publishEpisode");
    await rejects(publishEpisode(scene.scriptId, { forceRepublish: true }), /Publishing failed\. Blockers:/, "publishEpisode with forceRepublish");
    await rejects(prepareEpisodeForPublishing(scene.scriptId), /Publishing preparation failed\. Blockers:/, "prepareEpisodeForPublishing");
    assert((await statusOf(scene.episodeId)) === "publish_ready", "a refused publish changed the episode status");
  });

  await check("staleAudioLineIndexes returns one line per stale scene (two edits in one scene, one in the other -> 2 lines)", async () => {
    const one = await staleAudioLineIndexes(scene.scriptId);
    assert(JSON.stringify(one) === "[0]", `one stale scene gave ${JSON.stringify(one)}, expected [0]`);
    await editLine(scene.scriptId, 0, "Welcome back to the program.");
    await editLine(scene.scriptId, 3, "See you Monday.");
    const two = await staleAudioLineIndexes(scene.scriptId);
    assert(JSON.stringify(two) === "[0,2]", `two stale scenes gave ${JSON.stringify(two)}, expected [0,2]`);
  });

  /* --------------- 4. re-voice without a re-mix still blocks --------------- */

  await check("scene-voiced: re-voicing the scenes and re-checking facts WITHOUT a re-mix still blocks (stale master)", async () => {
    await voiceScene(scene.scriptId, scene.episodeId, 0, [0, 1]);
    await voiceScene(scene.scriptId, scene.episodeId, 1, [2, 3]);
    await recordFactCheck(scene.scriptId, scene.episodeId);
    const val = await validateEpisodeForRss(scene.scriptId, "publish");
    assert(val.checks.factCheckCurrent, `factCheckCurrent should be true after a new fact check: ${val.errorReasons.join("; ")}`);
    assert(val.checks.audioMatchesScript, `audioMatchesScript should be true after re-voicing: ${val.errorReasons.join("; ")}`);
    assert(!val.checks.finalMixCurrent && val.integrity?.master === "stale", `final mix was ${val.integrity?.master}, expected stale`);
    assert((await staleAudioLineIndexes(scene.scriptId)).length === 0, "re-voiced scenes are still reported stale");
    await rejects(publishEpisode(scene.scriptId), /Re-mix the episode/, "publishEpisode with a stale master");
    assert((await statusOf(scene.episodeId)) === "publish_ready", "a refused publish changed the episode status");
  });

  await check("scene-voiced: a mix that is still running blocks; the finished re-mix makes the episode publishable again", async () => {
    await mix(scene.scriptId, scene.episodeId, scene.slug, { status: "running" });
    const during = await validateEpisodeForRss(scene.scriptId, "publish");
    assert(during.integrity?.master === "rebuilding" && !during.eligible, `during a running mix master was ${during.integrity?.master}`);
    await db.episodeAudioRender.updateMany({ where: { episodeId: scene.episodeId, status: "running" }, data: { status: "failed", completedAt: new Date() } });
    await mix(scene.scriptId, scene.episodeId, scene.slug);
    const after = await validateEpisodeForRss(scene.scriptId, "publish");
    assert(after.eligible, `still refused after the re-mix: ${after.errorReasons.join("; ")}`);
    await publishEpisode(scene.scriptId);
    assert((await statusOf(scene.episodeId)) === "published", "publish after the re-mix did not go through");
  });

  await check("scene-voiced: a mix made before provenance was recorded is accepted on timestamps, and refused once a scene is re-voiced after it", async () => {
    const legacy = await makeEpisode("scene", { mixProvenance: false });
    const val = await validateEpisodeForRss(legacy.scriptId, "prepare");
    assert(val.eligible && val.integrity?.masterProof === "timestamps", `expected proof by timestamps, got ${JSON.stringify(val.integrity)} ${val.errorReasons.join("; ")}`);
    await sleep(20);
    await voiceScene(legacy.scriptId, legacy.episodeId, 1, [2, 3]);
    const later = await validateEpisodeForRss(legacy.scriptId, "prepare");
    assert(!later.checks.finalMixCurrent && later.integrity?.master === "stale", `after a later re-voice master was ${later.integrity?.master}`);
  });

  /* ------------------------------ 5. line-voiced ------------------------------ */

  const line = await makeEpisode("legacy_line");

  await check("line-voiced: a current episode passes; editing a line makes that one line stale and blocks publish", async () => {
    const ok = await validateEpisodeForRss(line.scriptId, "prepare");
    assert(ok.eligible && ok.integrity?.mode === "line" && ok.integrity.masterProof === "recorded", `current line-voiced episode refused: ${ok.errorReasons.join("; ")}`);
    await prepareEpisodeForPublishing(line.scriptId);
    await editLine(line.scriptId, 2, "That schedule was brutal.");
    const val = await validateEpisodeForRss(line.scriptId, "publish");
    assert(!val.checks.audioMatchesScript && JSON.stringify(val.integrity?.staleLines) === "[2]", `staleLines was ${JSON.stringify(val.integrity?.staleLines)}`);
    assert(!val.checks.finalMixCurrent && !val.checks.factCheckCurrent, "final mix or fact check stayed current after the edit");
    assert(JSON.stringify(await staleAudioLineIndexes(line.scriptId)) === "[2]", "staleAudioLineIndexes did not return the edited line");
    await rejects(publishEpisode(line.scriptId), /1 recorded line no longer matches the script \(line 2\)/, "publishEpisode with stale line audio");
    assert((await statusOf(line.episodeId)) === "publish_ready", "a refused publish changed the episode status");
  });

  await check("line-voiced: re-voicing the line without a re-mix still blocks; re-mix then publishes", async () => {
    await voiceLine(line.scriptId, line.episodeId, 2);
    await recordFactCheck(line.scriptId, line.episodeId);
    const val = await validateEpisodeForRss(line.scriptId, "publish");
    assert(val.checks.audioMatchesScript && val.checks.factCheckCurrent, `audio or facts still stale: ${val.errorReasons.join("; ")}`);
    assert(!val.checks.finalMixCurrent && val.integrity?.master === "stale", `master was ${val.integrity?.master}, expected stale`);
    await rejects(publishEpisode(line.scriptId), /Re-mix the episode/, "publishEpisode with a stale line master");
    await mix(line.scriptId, line.episodeId, line.slug);
    await publishEpisode(line.scriptId);
    assert((await statusOf(line.episodeId)) === "published", "publish after the re-mix did not go through");
  });

  await check("line-voiced: a legacy mix with no provenance is refused as unproven, by the gate and by publishEpisode", async () => {
    const legacy = await makeEpisode("legacy_line", { mixProvenance: false });
    const val = await validateEpisodeForRss(legacy.scriptId, "prepare");
    assert(val.integrity?.master === "unproven" && !val.checks.finalMixCurrent, `master was ${val.integrity?.master}, expected unproven`);
    assert(val.checks.audioMatchesScript && val.checks.factCheckCurrent, "only the final mix should be in question");
    assert(val.errorReasons.some((r) => /made before the app recorded what each mix contains/.test(r)), `no 'unproven' reason in: ${val.errorReasons.join("; ")}`);
    await rejects(prepareEpisodeForPublishing(legacy.scriptId), /cannot be shown to match the script/, "prepare on an unproven mix");
    await db.episode.update({ where: { id: legacy.episodeId }, data: { status: "publish_ready" } });
    await rejects(publishEpisode(legacy.scriptId), /cannot be shown to match the script/, "publish on an unproven mix");
    assert((await statusOf(legacy.episodeId)) === "publish_ready", "an unproven mix got published");
  });

  /* ------------------- 6. open sports claim, "passed" fact check ------------------- */

  await check("an unresolved sports claim blocks even when the latest FactCheckResult.status is 'passed'", async () => {
    const content = freshContent();
    content.segments[0].lines[1].needsHumanReview = true; // a factual claim flagged for review
    const claim = await makeEpisode("scene", { content });
    const val = await validateEpisodeForRss(claim.scriptId, "prepare");
    assert(val.checks.factCheckPassed, "fixture error: the latest fact check should read 'passed'");
    assert(!val.checks.factCheckCurrent && !val.eligible, "an open claim did not block");
    assert(val.checks.audioMatchesScript && val.checks.finalMixCurrent, "only the fact check should block here");
    assert(val.errorReasons.some((r) => /1 claim is not verified/.test(r)), `no claim reason in: ${val.errorReasons.join("; ")}`);
    await db.episode.update({ where: { id: claim.episodeId }, data: { status: "publish_ready" } });
    await rejects(publishEpisode(claim.scriptId), /1 claim is not verified/, "publishEpisode with an open claim");
    assert((await statusOf(claim.episodeId)) === "publish_ready", "an episode with an open claim got published");
  });

  await check("a fact check made before checked lines were recorded falls back to the edit mark", async () => {
    const old = await makeEpisode("scene");
    await db.factCheckResult.deleteMany({ where: { scriptId: old.scriptId } });
    await recordFactCheck(old.scriptId, old.episodeId, { withCheckedLines: false });
    assert((await validateEpisodeForRss(old.scriptId, "prepare")).checks.factCheckCurrent, "an unedited script with an older fact check was refused");
    await editLine(old.scriptId, 3, "See you next week.");
    assert(!(await validateEpisodeForRss(old.scriptId, "prepare")).checks.factCheckCurrent, "an edited line under an older fact check was not caught");
  });

  /* ------------------------------ 7. the row lock ------------------------------ */

  // Publish is held INSIDE its lock by an outside transaction that owns a table
  // only the gate reads (EpisodeAudioRender). Nothing in the product is changed
  // or mocked to do this.
  await check("withReleaseLock: both FOR UPDATE statements hold on Postgres; an edit started mid-publish waits and lands after it", async () => {
    const ep = await makeEpisode("scene");
    await prepareEpisodeForPublishing(ep.scriptId);
    const before = await db.script.findUniqueOrThrow({ where: { id: ep.scriptId }, select: { content: true } });
    const fingerprintBefore = prov.scriptFingerprint(before.content);

    const order: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let tableHeld!: () => void;
    const holding = new Promise<void>((r) => (tableHeld = r));
    const blocker = other.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "EpisodeAudioRender" IN ACCESS EXCLUSIVE MODE`);
      tableHeld();
      await released;
    }, { timeout: 30_000, maxWait: 10_000 });
    await holding;

    const waitingOn = async (pattern: string) => {
      for (let i = 0; i < 100; i++) {
        const rows = await other.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1 AND pid <> pg_backend_pid()`, pattern);
        if (Number(rows[0].n) > 0) return true;
        await sleep(50);
      }
      return false;
    };
    const rowIsLocked = async (table: "Script" | "Episode", id: string) => {
      try {
        await other.$transaction(async (tx) => { await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE NOWAIT`, id); });
        return false;
      } catch (err) {
        if (/55P03|could not obtain lock/.test((err as Error).message)) return true;
        throw err;
      }
    };

    const pending: Promise<unknown>[] = [];
    try {
      const publish = publishEpisode(ep.scriptId).then((out) => { order.push("publish"); return out; });
      pending.push(publish);
      assert(await waitingOn('%"EpisodeAudioRender"%'), "the gate never reached the held table, so publish was not caught inside its lock");
      assert(await rowIsLocked("Script", ep.scriptId), "the Script row is NOT locked while publish is validating");
      assert(await rowIsLocked("Episode", ep.episodeId), "the Episode row is NOT locked while publish is validating");

      const edit = editLine(ep.scriptId, 0, "Edited while a publish was in flight.").then((r) => { order.push("edit"); return r; });
      pending.push(edit);
      assert(await waitingOn('%FROM "Script"%FOR UPDATE%'), "the edit did not queue on the Script row lock");
      assert(order.length === 0, `something finished while the lock was held: ${order.join(", ")}`);
      assert((await lineText(ep.scriptId, 0)) === "Welcome back to the show.", "the edit was written while publish held the lock");

      release();
      await blocker;
      const [out, edited] = await Promise.all([publish, edit]);
      assert(edited === true, "the waiting edit did not apply");
      assert(order.join(",") === "publish,edit", `finish order was ${order.join(",")}, expected publish,edit`);
      assert(out.released.scriptFingerprint === fingerprintBefore, "publish released a script fingerprint other than the one it validated");
    } finally {
      release();
      await blocker.catch(() => undefined);
      await Promise.allSettled(pending);
    }

    assert((await statusOf(ep.episodeId)) === "published", "the publish did not complete");
    assert((await lineText(ep.scriptId, 0)) === "Edited while a publish was in flight.", "the edit was lost");
    const next = await validateEpisodeForRss(ep.scriptId, "publish");
    assert(!next.eligible && !next.checks.audioMatchesScript && !next.checks.finalMixCurrent, "the next gate read did not see the edit that landed after publish");
  });

  await check("editScriptContent: two edits to different lines queued behind a held row lock both survive", async () => {
    const ep = await makeEpisode("scene");
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const blocker = other.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "Script" WHERE "id" = $1 FOR UPDATE`, ep.scriptId);
      held();
      await released;
    }, { timeout: 30_000, maxWait: 10_000 });
    await holding;
    const pending: Promise<unknown>[] = [];
    try {
      const a = editLine(ep.scriptId, 0, "First editor's line.");
      const b = editLine(ep.scriptId, 3, "Second editor's line.");
      pending.push(a, b);
      let queued = 0;
      for (let i = 0; i < 100 && queued < 2; i++) {
        const rows = await other.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM "Script"%FOR UPDATE%' AND pid <> pg_backend_pid()`);
        queued = Number(rows[0].n);
        if (queued < 2) await sleep(50);
      }
      assert(queued === 2, `${queued} of 2 edits were waiting on the row lock`);
      release();
      await blocker;
      assert((await a) === true && (await b) === true, "an edit did not apply");
    } finally {
      release();
      await blocker.catch(() => undefined);
      await Promise.allSettled(pending);
    }
    assert((await lineText(ep.scriptId, 0)) === "First editor's line.", "the first edit was overwritten");
    assert((await lineText(ep.scriptId, 3)) === "Second editor's line.", "the second edit was overwritten");
  });

  // A release may hold the lock for up to 60s (withReleaseLock's own limit). An
  // edit queued behind it must wait that long, not give up at a client default.
  await check("editScriptContent: an edit that waits 6 seconds for the row lock still lands (it does not time out)", async () => {
    const ep = await makeEpisode("scene");
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const blocker = other.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "Script" WHERE "id" = $1 FOR UPDATE`, ep.scriptId);
      held();
      await sleep(6000);
    }, { timeout: 30_000, maxWait: 10_000 });
    await holding;
    const [edit] = await Promise.allSettled([editLine(ep.scriptId, 2, "Patient edit."), blocker]);
    assert(edit.status === "fulfilled", `the waiting edit failed: ${edit.status === "rejected" ? String((edit.reason as Error).message).split("\n").pop() : ""}`);
    assert(edit.value === true && (await lineText(ep.scriptId, 2)) === "Patient edit.", "the waiting edit did not apply");
  });

  await check("editScriptContent: four simultaneous edits to four different lines, no outside help, all survive", async () => {
    const ep = await makeEpisode("scene");
    const results = await Promise.all([0, 1, 2, 3].map((i) => editLine(ep.scriptId, i, `Concurrent edit ${i}.`)));
    assert(results.every((r) => r === true), `results were ${JSON.stringify(results)}`);
    for (const i of [0, 1, 2, 3]) assert((await lineText(ep.scriptId, i)) === `Concurrent edit ${i}.`, `edit to line ${i} was lost`);
  });

  await check("editScriptContent: a script that does not exist returns null and writes nothing", async () => {
    assert((await editScriptContent("00000000-0000-0000-0000-000000000000", (c) => ({ content: c, result: true }))) === null, "expected null");
  });

  /* ------------------------------- cleanup ------------------------------- */
  await db.episode.deleteMany({ where: { id: { in: episodeIds } } });
  await other.$disconnect();
  await db.$disconnect();
  summarize("Release integrity (database)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
