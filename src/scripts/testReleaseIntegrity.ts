// Release integrity: nothing stale can pass the release gate, by any route.
// Pure (no database, no provider). Run: npm run test:release-integrity
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  buildMasterProvenance, checkedLineHashes, contentSha256, evaluateArtifactIntegrity, immutableStorageKey, releaseCandidate, sceneProvenance, scriptTurns, uncheckedLineIndexes,
  type LineAudioRow, type RenderRow, type SceneAudioRow,
} from "../lib/services/artifactProvenance";
import { sceneRequestFingerprint } from "../lib/audio/dialogueScenePlanner";
import { PERFORMANCE_PROFILE_VERSION } from "../lib/hosts/performanceProfile";
import { scriptContentHash } from "../lib/services/scriptLock";

let passed = 0;
const ok = (cond: unknown, name: string) => { assert.ok(cond, name); passed++; };

const script = (l1 = "They won 12 of their last 15.") => ({
  segments: [
    { lines: [{ lineIndex: 0, speakerHostId: "a", text: "Welcome back." }, { lineIndex: 1, speakerHostId: "b", text: l1 }] },
    { lines: [{ lineIndex: 2, speakerHostId: "a", text: "Soft schedule." }, { lineIndex: 3, speakerHostId: "b", text: "See you Sunday." }] },
  ],
});
const T0 = new Date("2026-11-01T10:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const MASTER = "https://s3/final-v1.mp3";

function scene(id: string, sceneIndex: number, idx: number[], content: unknown, over: Partial<SceneAudioRow> = {}): SceneAudioRow {
  const turns = scriptTurns(content).filter((t) => idx.includes(t.lineIndex));
  return {
    id, sceneIndex, lineIndexes: idx, status: "ready", selected: true, audioUrl: `https://s3/${id}.mp3`,
    provider: "fish", model: "s2-pro", renderUnit: "multi_speaker_scene", voiceMap: { a: "va", b: "vb" },
    requestFingerprint: "unused", plannerVersion: 1, providerMetadata: { provenance: sceneProvenance(turns) }, createdAt: at(0), ...over,
  };
}
/** A scene row exactly as rows were written BEFORE provenance existed. */
function legacyScene(id: string, sceneIndex: number, idx: number[], content: unknown, over: Partial<SceneAudioRow> = {}): SceneAudioRow {
  const turns = scriptTurns(content).filter((t) => idx.includes(t.lineIndex));
  const base = scene(id, sceneIndex, idx, content, { providerMetadata: { endpoint: "x" } });
  const requestFingerprint = sceneRequestFingerprint({
    scene: { lineIndexes: idx, lines: turns as never }, provider: base.provider, model: base.model, renderUnit: base.renderUnit,
    voiceMap: base.voiceMap as Record<string, string>, seed: 0, plannerVersion: 1, profileVersion: PERFORMANCE_PROFILE_VERSION,
  });
  return { ...base, requestFingerprint, ...over };
}
const render = (over: Partial<RenderRow> = {}): RenderRow => ({ renderVersion: 1, status: "succeeded", scriptId: "s1", outputAudioUrl: MASTER, diagnostics: {}, startedAt: at(5), completedAt: at(6), ...over });
const run = (content: unknown, o: { scenes?: SceneAudioRow[]; lines?: LineAudioRow[]; renders?: RenderRow[]; audioUrl?: string | null }) =>
  evaluateArtifactIntegrity({
    scriptId: "s1", content, ttsRenderMode: o.scenes ? "scene" : "legacy_line",
    episodeAudioUrl: o.audioUrl === undefined ? `${MASTER}?v=3` : o.audioUrl, lineAudio: o.lines ?? [], sceneAudio: o.scenes ?? [], renders: o.renders ?? [], now: at(120),
  });

// ---------------------------------------------------------------- scenes
{
  const c = script();
  const scenes = [scene("r1", 0, [0, 1], c), scene("r2", 1, [2, 3], c)];
  const master = render({ diagnostics: { provenance: buildMasterProvenance("s1", c, { scenes }) } });
  const good = run(c, { scenes, renders: [master] });
  ok(good.blockers.length === 0 && good.master === "current" && good.masterProof === "recorded", "current scene episode passes, proven by recorded fingerprints");

  // STALE SCENE AUDIO: one line edited after voicing.
  const edited = script("They won 14 of their last 15.");
  const stale = run(edited, { scenes, renders: [master] });
  ok(stale.staleScenes.join() === "0", "only the scene containing the edited line is stale");
  ok(stale.blockers.some((b) => /Scene audio no longer matches/.test(b)), "stale scene audio blocks release");
  ok(stale.master === "stale", "the final mix of the old script is stale too");

  // Affected scene re-voiced (a new row), but the master NOT re-mixed.
  const r1b = scene("r1b", 0, [0, 1], edited, { createdAt: at(30) });
  const revoiced = [{ ...scenes[0], selected: false }, r1b, scenes[1]];
  const noRemix = run(edited, { scenes: revoiced, renders: [master] });
  ok(noRemix.staleScenes.length === 0, "re-voicing the one affected scene clears scene staleness");
  ok(noRemix.master === "stale" && noRemix.blockers.length === 1, "STALE FINAL MASTER: regenerated audio does not make the old mix current");

  // Re-mixed from the edited script and the new scene.
  const V2 = "https://s3/final-v2.mp3";
  const master2 = render({ renderVersion: 2, outputAudioUrl: V2, diagnostics: { provenance: buildMasterProvenance("s1", edited, { scenes: [r1b, scenes[1]] }) } });
  ok(run(edited, { scenes: revoiced, renders: [master, master2], audioUrl: V2 }).blockers.length === 0, "after re-voice and re-mix the episode passes again");
  ok(run(edited, { scenes: revoiced, renders: [master, master2] }).master === "stale", "an episode still pointing at the OLD file is refused");

  // A scene being re-voiced: prior candidate deselected, new one not ready.
  const mid = run(c, { scenes: [{ ...scenes[0], selected: false }, scene("r1c", 0, [0, 1], c, { status: "processing", audioUrl: null }), scenes[1]], renders: [master] });
  ok(mid.unvoicedLines.join() === "0,1" && mid.blockers.length > 0, "publishing during a scene re-voice is refused");
  // An old FAILED candidate beside a good selected one must not block.
  ok(run(c, { scenes: [...scenes, scene("old", 0, [0, 1], c, { status: "failed", selected: false, audioUrl: null })], renders: [master] }).blockers.length === 0, "a failed spare candidate does not block a good episode");

  // Rebuild in progress / crashed rebuild.
  const running = render({ renderVersion: 2, status: "running", startedAt: at(118), completedAt: null, outputAudioUrl: null });
  ok(run(c, { scenes, renders: [master, running] }).master === "rebuilding", "publishing during a re-mix is refused");
  ok(run(c, { scenes, renders: [master, { ...running, startedAt: at(10) }] }).master === "current", "a render stuck 'running' for hours is a dead job, not a rebuild");
  ok(run(c, { scenes, renders: [render({ scriptId: "s0", diagnostics: master.diagnostics })] }).master === "stale", "a mix of another script version is refused");
}

// ------------------------------------------------- legacy scene episodes
{
  const c = script();
  const scenes = [legacyScene("l1", 0, [0, 1], c), legacyScene("l2", 1, [2, 3], c)];
  const legacyMaster = render(); // no provenance recorded
  const good = run(c, { scenes, renders: [legacyMaster] });
  ok(good.blockers.length === 0 && good.masterProof === "timestamps", "untouched legacy scene episode passes, and says its proof is timestamps (no recorded fingerprint is claimed)");
  ok(run(script("Changed."), { scenes, renders: [legacyMaster] }).staleScenes.join() === "0", "legacy scene rows still detect an edited line (requestFingerprint)");
  const late = [{ ...scenes[0], selected: false }, legacyScene("l1b", 0, [0, 1], c, { createdAt: at(30) }), scenes[1]];
  ok(run(c, { scenes: late, renders: [legacyMaster] }).master === "stale", "legacy: a scene made after the mix means the mix is stale");
  ok(run(c, { scenes, renders: [] }).master === "unproven", "no render record at all is never called current");
}

// ------------------------------------------------------------ line audio
{
  const c = script();
  const lines: LineAudioRow[] = scriptTurns(c).map((t) => ({ lineIndex: t.lineIndex, text: t.text, status: "ready", audioUrl: `https://s3/l${t.lineIndex}.mp3`, durationMs: 1000 + t.lineIndex }));
  const master = render({ diagnostics: { provenance: buildMasterProvenance("s1", c, { lines }) } });
  ok(run(c, { lines, renders: [master] }).blockers.length === 0, "current line-voiced episode passes");

  const edited = script("They won 14 of their last 15.");
  const stale = run(edited, { lines, renders: [master] });
  ok(stale.staleLines.join() === "1" && stale.blockers.some((b) => /recorded line no longer matches/.test(b)), "STALE LINE AUDIO blocks release, naming only the edited line");

  const revoiced = lines.map((l) => (l.lineIndex === 1 ? { ...l, text: "They won 14 of their last 15.", durationMs: 1100 } : l));
  const noRemix = run(edited, { lines: revoiced, renders: [master] });
  ok(noRemix.staleLines.length === 0 && noRemix.master === "stale", "a re-voiced line without a re-mix leaves the master stale");
  ok(run(c, { lines, renders: [render()] }).master === "unproven", "legacy line mix with no recorded provenance is refused, not assumed current");
}

// ------------------------------------------------------------ fact check
{
  const c = script();
  const checked = checkedLineHashes(c);
  ok(uncheckedLineIndexes(c, checked).length === 0, "a script identical to what was checked has no unchecked lines");
  ok(uncheckedLineIndexes(script("They won 14 of their last 15."), checked).join() === "1", "STALE FACT CHECK: an edit after the check is caught by content, not by a flag");
  const withNew = script();
  withNew.segments[1].lines.push({ lineIndex: 4, speakerHostId: "a", text: "New line." });
  ok(uncheckedLineIndexes(withNew, checked).join() === "4", "a line added after the check is unchecked");
  // Legacy check (nothing recorded): the edit mark is all there is.
  const marked = script();
  (marked.segments[0].lines[1] as Record<string, unknown>).dirty = true;
  ok(uncheckedLineIndexes(marked, undefined).join() === "1", "legacy fact check falls back to the edit mark");
  ok(uncheckedLineIndexes(marked, checkedLineHashes(marked)).length === 0, "re-running the fact check clears edited lines");
}

// ------------------------------ every release route goes through the gate
{
  const srcRoot = path.join(__dirname, "..");
  const read = (p: string) => fs.readFileSync(path.join(srcRoot, p), "utf8");
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
  // Any database write that sets a release status, anywhere outside test scripts.
  const writers = walk(srcRoot)
    .filter((f) => !f.includes(`${path.sep}scripts${path.sep}`))
    .filter((f) => /data:\s*\{[^}]*status:\s*"(published|publish_ready)"/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.basename(f));
  ok(writers.join() === "rssPublishingService.ts", `only the publishing service may write a release status (found: ${writers.join(", ")})`);

  const svc = read("lib/services/rssPublishingService.ts");
  for (const fn of ["prepareEpisodeForPublishing", "publishEpisode"]) {
    const start = svc.indexOf(`export async function ${fn}`);
    const body = svc.slice(start, svc.indexOf("export async function", start + 20));
    ok(/withReleaseLock\([\s\S]*validateEpisodeForRss\([\s\S]*tx\.episode\.update/.test(body), `${fn} validates and writes inside one release lock`);
  }
  ok(/evaluateArtifactIntegrity\(/.test(svc) && /uncheckedLineIndexes\(/.test(svc) && /vm\.gate\.unresolvedCount/.test(svc), "the gate itself checks artifacts, fact-check currency and open claims");

  const actions = read("app/app/create/actions.ts");
  const a = actions.indexOf("export async function attemptPublish");
  ok(/return publishOwnedEpisode\(episodeId\)/.test(actions.slice(a, a + 200)), "the editor's publish button uses the Release panel's action");
  const admin = read("app/admin/publish-episode/route.ts");
  ok(/prepareEpisodeForPublishing\(/.test(admin) && /publishEpisode\(/.test(admin) && !/episode\.update\(/.test(admin), "the admin route only calls the gated service");
}

// ------------------------------ A. immutable recording identity
{
  const take1 = Buffer.from("take one bytes"), take2 = Buffer.from("take two bytes");
  const k = "episodes/e/scripts/s/segments/1-zabala.mp3";
  ok(immutableStorageKey(k, take1) !== immutableStorageKey(k, take2), "different audio bytes never share a storage key");
  ok(immutableStorageKey(k, take1) === immutableStorageKey(k, Buffer.from("take one bytes")), "identical bytes keep one key (same recording)");
  ok(/segments\/1-zabala-[0-9a-f]{16}\.mp3$/.test(immutableStorageKey(k, take1)), "the content hash sits before the extension");
  ok(contentSha256(take1).length === 64, "content hash is a full sha256");

  // A re-voiced line with the SAME text and duration but new bytes: the old
  // fingerprint inputs (index, text, duration) are identical, the URL is not.
  const c = script();
  const url = (b: Buffer) => `https://s3/${immutableStorageKey(k, b)}`;
  const line = (b: Buffer, i: number, text: string): LineAudioRow => ({ lineIndex: i, text, status: "ready", audioUrl: i === 1 ? url(b) : `https://s3/l${i}.mp3`, durationMs: 1000 });
  const lines = (b: Buffer) => scriptTurns(c).map((t) => line(b, t.lineIndex, t.text));
  const mixedFromTake1 = render({ diagnostics: { provenance: buildMasterProvenance("s1", c, { lines: lines(take1) }) } });
  ok(run(c, { lines: lines(take1), renders: [mixedFromTake1] }).master === "current", "a mix of take one is current while take one is the recording");
  ok(run(c, { lines: lines(take2), renders: [mixedFromTake1] }).master === "stale", "a regenerated take (same words, same length, new bytes) makes the old mix stale");

  const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  ok(/immutableStorageKey\(`episodes\/\$\{episodeId\}\/scripts\/\$\{scriptId\}\/segments\//.test(src("lib/services/ttsSegmentService.ts")), "line recordings are stored content-addressed");
  ok(/immutableStorageKey\(`episodes\/\$\{episodeId\}\/scripts\/\$\{scriptId\}\/scenes\//.test(src("lib/services/ttsSceneService.ts")), "scene recordings (every candidate) are stored content-addressed");
  ok(/immutableStorageKey\(episodeSlug/.test(src("lib/services/audioStitchingService.ts")), "line-mode final masters are stored content-addressed");
  ok(/immutableStorageKey\(`episodes\/\$\{episodeRow\.id\}/.test(src("lib/services/sceneStitchingService.ts")), "scene-mode final masters are stored content-addressed");
}

// ------------------------------ C. a re-mix never replaces published audio
{
  const pub = { status: "published", audioUrl: "https://s3/final-aaaa.mp3", durationSeconds: 600, audioFileSizeBytes: 9 };
  const newer = { renderVersion: 2, status: "succeeded", outputAudioUrl: "https://s3/final-bbbb.mp3", diagnostics: { provenance: { durationSeconds: 610, fileSizeBytes: 12 } } };
  const older = { renderVersion: 1, status: "succeeded", outputAudioUrl: pub.audioUrl, diagnostics: {} };
  const cand = releaseCandidate(pub, [older, newer]);
  ok(cand.promoted && cand.audioUrl === newer.outputAudioUrl && cand.durationSeconds === 610 && cand.fileSizeBytes === 12, "a newer master of a published episode is a release CANDIDATE with its own duration and size");
  ok(!releaseCandidate(pub, [older]).promoted, "with no newer master the published audio is the candidate");
  ok(!releaseCandidate({ ...pub, status: "publish_ready" }, [older, newer]).promoted, "only published episodes have a separate candidate");
  ok(!releaseCandidate(pub, [older, { ...newer, status: "failed" }]).promoted, "a failed render is never a candidate");

  const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  ok(/previousStatus === "published" \? \{\} : \{\s*audioUrl: uploadResult\.url/.test(src("lib/services/audioStitchingService.ts")), "line stitcher leaves a published episode's audio alone");
  ok(/previousStatus === "published"\s*\? \{ status: finalEpisodeStatus \}/.test(src("lib/services/sceneStitchingService.ts")), "scene stitcher leaves a published episode's audio alone");
  const svc = src("lib/services/rssPublishingService.ts");
  const pubFn = svc.slice(svc.indexOf("export async function publishEpisode"));
  ok(/withReleaseLock\([\s\S]*val\.release\?\.promoted[\s\S]*audioUrl: val\.release\.audioUrl/.test(pubFn), "only publishEpisode promotes a new master, after the gate, inside the release lock");
  ok(/episodeAudioUrl: release\.audioUrl/.test(svc), "the gate judges the candidate file, not the live one");
}

// ------------------------------ B. every script write takes the script lock
{
  const srcRoot = path.join(__dirname, "..");
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
  // Any update of an existing Script row that writes content. Creating a new
  // version is not a mutation and is not listed.
  const offenders: string[] = [];
  for (const f of walk(srcRoot).filter((f) => !f.includes(`${path.sep}scripts${path.sep}`))) {
    const text = fs.readFileSync(f, "utf8");
    // Each write must have taken the lock in the same function, shortly before.
    for (const m of text.matchAll(/\b(?:db|tx)\.script\.update\(\{[\s\S]{0,400}?\bcontent:/g)) {
      const before = text.slice(Math.max(0, m.index! - 2500), m.index);
      const fnStart = before.lastIndexOf("export async function");
      if (!/lockScriptRow\(|lockScriptUnchanged\(/.test(fnStart >= 0 ? before.slice(fnStart) : before)) offenders.push(`${path.basename(f)}@${text.slice(0, m.index).split("\n").length}`);
    }
  }
  ok(offenders.length === 0, `every file that rewrites Script.content takes the script lock (unlocked: ${offenders.join(", ")})`);
  const admin = fs.readFileSync(path.join(srcRoot, "app/admin/scripts/actions.ts"), "utf8");
  const save = admin.slice(admin.indexOf("export async function saveScriptEdits"), admin.indexOf("export async function saveScriptAsNewVersion"));
  ok(/lockScriptUnchanged\(tx, scriptId, baseContentHash\)/.test(save) && /SCRIPT_LOCK_TX/.test(save), "admin save is refused when the script changed since the editor loaded it, and waits out a release");
  const approve = admin.slice(admin.indexOf("export async function approveScript"), admin.indexOf("export async function rejectScript"));
  ok(/lockScriptUnchanged\(tx, scriptId, scriptContentHash\(script\.content\)\)/.test(approve), "admin approval refuses content that changed after it was validated");
  ok(scriptContentHash({ a: 1 }) !== scriptContentHash({ a: 2 }) && scriptContentHash(null) === scriptContentHash(undefined), "content hash tells versions apart");
}

console.log(`ok  release integrity: ${passed} passed, 0 failed`);
