// Acceptance coverage for the Part 5 polish (PR #177), DB-only + UI.
//
// Deterministic fixtures only: no LLM, TTS, research or payment provider is
// called. Briefs are written into the server-side StudioDraft exactly as the
// Executive Producer panel would autosave them; audio rows and render history
// are seeded directly, and the master audio is served by page.route so the
// waveform decodes a real (tiny, generated) WAV without touching a bucket.

import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./seed";
import { e2eDb, waitForDraft, closeE2eDb } from "./db";

const T = E2E.topics;

test.afterAll(async () => { await closeE2eDb(); });
test.beforeEach(({}, ti) => test.skip(ti.project.name !== "desktop", "desktop-only flow"));

// ------------------------------------------------------------------ helpers

async function gotoCreate(page: Page) {
  await page.goto("/studio/create");
  await page.locator('[data-testid="save-status"]').waitFor({ state: "attached", timeout: 30_000 });
  const discard = page.getByTestId("discard-draft");
  if (await discard.isVisible().catch(() => false)) {
    await discard.click();
    await page.getByTestId("discard-confirm").click();
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  await expect(page.getByTestId("podcast-standalone")).toBeVisible();
}

/** A complete, schema-valid brief citing `sourceIds` and assigning `hostIds`. */
function makeBrief(opts: { title: string; sourceIds: string[]; hostIds: string[] }) {
  const r = (value: string) => ({ value, rationale: "Fixture." });
  return {
    v: 1, source: "deterministic", model: null, objective: "Acceptance fixture goal.",
    title: r(opts.title), positioning: r("Positioning."), audience: r("Regular listeners."), angle: r("Angle."),
    thesis: r("Thesis."), hook: r("Hook."), researchNeeds: [],
    evidence: opts.sourceIds.map((sourceId) => ({ sourceId, use: "Fixture evidence." })),
    segments: [{ title: "Segment one", goal: "Make the case.", sourceIds: opts.sourceIds.slice(0, 1) }],
    hostAssignments: opts.hostIds.map((hostId, i) => ({ hostId, perspective: i === 0 ? "For." : "Against.", role: "" })),
    counterarguments: [], disagreements: [], insiderInsights: [], takeaways: [],
    conclusion: r("Conclusion."), targetMinutes: 12, productionStyle: "light", soundDirection: r("Light music."),
    rejected: [],
  };
}

/** Manual rundown of [lead, two], then the brief written into the saved draft
 *  (what the panel autosaves) and the page reloaded so the builder restores it. */
async function rundownWithBrief(page: Page, makeFor: (hostIds: string[]) => ReturnType<typeof makeBrief>) {
  await gotoCreate(page);
  await page.getByTestId("step-topics").click();
  await page.getByTestId("mode-manual").click();
  await page.getByTestId(`pick-${T.lead}`).check();
  await page.getByTestId(`pick-${T.two}`).check();
  const state = await waitForDraft(E2E.userA.id, (s) => Array.isArray(s.selectedTopicIds) && s.selectedTopicIds.length === 2);
  const brief = makeFor(state.hostIds ?? []);
  await e2eDb().studioDraft.update({ where: { ownerId: E2E.userA.id }, data: { state: { ...state, brief } } });
  await page.reload();
  await page.locator('[data-testid="save-status"]').waitFor({ state: "attached", timeout: 30_000 });
  await page.getByTestId("step-review").click();
  await expect(page.getByTestId("create-episode")).toBeVisible();
  return brief;
}

// ------------------------------------------------- Executive Producer brief

test.describe("Executive Producer brief through episode creation", () => {
  test("an approved brief is stored on the created episode, in the same write", async ({ page }) => {
    const title = `Brief fixture ${Date.now()}`;
    await rundownWithBrief(page, (hostIds) => makeBrief({ title, sourceIds: [T.lead, T.two], hostIds: hostIds.slice(0, 2) }));
    await page.getByTestId("create-episode").click();
    await expect(page.getByTestId("result-final-order")).toBeVisible();
    const href = await page.getByRole("link", { name: "Open episode" }).getAttribute("href");
    const episodeId = (href || "").split("/").pop() || "";
    expect(episodeId).toBeTruthy();
    const row = await e2eDb().episode.findUnique({ where: { id: episodeId }, select: { editorialBrief: true } });
    expect((row?.editorialBrief as any)?.title?.value).toBe(title);
    // Successful creation clears the resume draft, brief included.
    expect(await e2eDb().studioDraft.findUnique({ where: { ownerId: E2E.userA.id } })).toBeNull();
  });

  test("a brief citing a story the episode doesn't carry is refused; nothing is created and the draft is kept", async ({ page }) => {
    const title = `Mismatched brief ${Date.now()}`;
    // T.four is not in the rundown; E2E.hostPrivB is never seated for user A.
    await rundownWithBrief(page, () => makeBrief({ title, sourceIds: [T.lead, T.four], hostIds: [E2E.hostPrivB] }));
    const before = await e2eDb().episode.count({ where: { ownerId: E2E.userA.id } });
    await page.getByTestId("create-episode").click();
    const err = page.getByTestId("create-error");
    await expect(err).toBeVisible();
    await expect(err).toContainText(/isn't in this episode/);
    await expect(err).toContainText(/isn't hosting this episode/);
    await expect(err).toContainText(/Your draft and brief are kept/);
    // Still on the builder: no result view, Create usable again.
    await expect(page.getByTestId("result-final-order")).toHaveCount(0);
    await expect(page.getByTestId("create-episode")).toBeEnabled();
    expect(await e2eDb().episode.count({ where: { ownerId: E2E.userA.id } })).toBe(before);
    expect(await e2eDb().episode.count({ where: { title } })).toBe(0);
    const kept = await e2eDb().studioDraft.findUnique({ where: { ownerId: E2E.userA.id } });
    expect((kept?.state as any)?.brief?.title?.value).toBe(title);
    expect((kept?.state as any)?.selectedTopicIds).toEqual([T.lead, T.two]);
  });
});

// ---------------------------------------------------------------- Mix view

const MIX = { id: "acc-ep-mix", A: "https://example.invalid/acc-ep-mix/final-a.wav", B: "https://example.invalid/acc-ep-mix/final-b.wav" };

/** A real, decodable WAV: 0.5s of 440Hz, 16-bit mono at 8kHz. */
function tinyWav(): Buffer {
  const rate = 8000, n = rate / 2, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const L = (lineIndex: number, text: string) => ({
  lineIndex, speakerHostId: lineIndex % 2 === 0 ? E2E.hostAce : E2E.hostBlaze, speakerName: lineIndex % 2 === 0 ? "Ace" : "Blaze",
  text, tone: "neutral", isFactualClaim: false, needsHumanReview: false, evidenceRefs: [],
});

/** A stitch job's output for `file`, carrying ffmpeg-shaped measurements. */
const stitchLog = (scriptId: string, file: string, lufs: number, peak: number) => ({
  jobType: "audio:stitch-final", status: "completed", input: { scriptId },
  output: { finalAudioUrl: file, audioQa: { metrics: { integratedLufs: lufs, truePeakDb: peak, loudnessRangeLu: 6, maxSilenceGapSec: 0.8 }, checks: [] } },
});

/** Scene-voiced (two performed scenes, no per-line clips) and mixed once as A. */
async function seedMixEpisode() {
  const db = e2eDb();
  await db.jobLog.deleteMany({ where: { input: { path: ["episodeFixture"], equals: MIX.id } } });
  await db.episode.deleteMany({ where: { id: MIX.id } });
  await db.episode.create({
    data: {
      id: MIX.id, title: "Mix check: scene-voiced", slug: MIX.id, status: "completed", ownerId: E2E.userA.id, podcastId: E2E.podcastId,
      hostIds: [E2E.hostAce, E2E.hostBlaze], durationSeconds: 60, audioUrl: MIX.A, ttsRenderMode: "scene",
    } as any,
  });
  const content = { segments: [
    { type: "cold_open", title: "Open", lines: [L(0, "Welcome back to the show."), L(1, "Big week for the defence.")] },
    { type: "debate", title: "Close", lines: [L(2, "That schedule was soft."), L(3, "See you Sunday.")] },
  ] };
  const script = await db.script.create({ data: { episodeId: MIX.id, version: 1, status: "approved", content: content as any } });
  for (const [sceneIndex, lineIndexes] of [[0, [0, 1]], [1, [2, 3]]] as [number, number[]][]) {
    await db.dialogueSceneAudio.create({
      data: {
        episodeId: MIX.id, scriptId: script.id, sceneIndex, sceneType: "conversation", firstLineIndex: lineIndexes[0], lastLineIndex: lineIndexes[1], lineIndexes,
        provider: "stub", model: "fixture", renderUnit: "multi_speaker_scene", voiceMap: {}, requestFingerprint: `acc-mix-${sceneIndex}`,
        status: "ready", selected: true, audioUrl: `https://example.invalid/acc-ep-mix/scene-${sceneIndex}.wav`, durationMs: 4000,
      },
    });
  }
  await db.episodeAudioRender.create({
    data: { episodeId: MIX.id, scriptId: script.id, renderVersion: 1, status: "succeeded", renderMode: "initial", outputAudioUrl: MIX.A, completedAt: new Date(Date.now() - 60_000) },
  });
  await db.jobLog.create({ data: { ...stitchLog(script.id, MIX.A, -16.0, -1.5), input: { scriptId: script.id, episodeFixture: MIX.id } } });
  return script.id;
}

/** A second, newer render B (with its own measurements). `live` points the episode at it. */
async function addRenderB(scriptId: string, live: boolean) {
  const db = e2eDb();
  await db.episodeAudioRender.create({
    data: { episodeId: MIX.id, scriptId, renderVersion: 2, status: "succeeded", renderMode: "remix_episode_profile", outputAudioUrl: MIX.B, completedAt: new Date() },
  });
  await db.jobLog.create({ data: { ...stitchLog(scriptId, MIX.B, -14.0, -0.5), input: { scriptId, episodeFixture: MIX.id } } });
  if (live) await db.episode.update({ where: { id: MIX.id }, data: { audioUrl: MIX.B } });
}

/** Serve every fixture audio URL as a real WAV, with CORS, and record waveform reads. */
async function serveAudio(page: Page) {
  const reads: string[] = [];
  const wav = tinyWav();
  await page.route("https://example.invalid/acc-ep-mix/**", async (route) => {
    if (route.request().resourceType() === "fetch") reads.push(route.request().url());
    await route.fulfill({ status: 200, body: wav, headers: { "content-type": "audio/wav", "access-control-allow-origin": "*" } });
  });
  return reads;
}

async function openMix(page: Page) {
  await page.goto(`/studio/episodes/${MIX.id}`);
  await page.getByRole("tab", { name: /Audio and mix/ }).click();
  await expect(page.getByTestId("mix-voicing")).toBeVisible();
}

test.describe("Mix view: scenes, measurements and renders", () => {
  test("a scene-voiced episode reads as voiced, scene by scene", async ({ page }) => {
    await seedMixEpisode();
    await serveAudio(page);
    await openMix(page);
    await expect(page.getByTestId("mix-voicing")).toContainText("Voiced as performed scenes");
    await expect(page.getByTestId("mix-voicing")).toContainText("2 scenes selected");
    const list = page.locator(".mixLineList");
    await expect(list).toContainText("Lines — re-voice a scene");
    await expect(list.getByText("unvoiced", { exact: true })).toHaveCount(0);
    await expect(list.getByRole("button", { name: "scene 1", exact: true })).toHaveCount(2);
    await expect(list.getByRole("button", { name: "scene 2", exact: true })).toHaveCount(2);
    await expect(list.getByRole("button", { name: "↻ Re-voice scene" })).toHaveCount(4);
    await expect(page.locator(".mixSceneBlock")).toHaveCount(2);
    await expect(page.getByText("Re-voicing re-splices the finished mix, so it needs every line voiced first.")).toHaveCount(0);
  });

  test("measurements come only from the render that is playing; a newer render is listed as not live", async ({ page }) => {
    const scriptId = await seedMixEpisode();
    await addRenderB(scriptId, false);
    await serveAudio(page);
    await openMix(page);
    const measured = page.getByRole("region", { name: "Measured audio quality" });
    await expect(measured).toContainText("-16.0 LUFS");
    await expect(measured).toContainText("-1.5 dBFS");
    await expect(measured).not.toContainText("-14.0");
    const renders = page.getByRole("region", { name: "Renders of this episode" });
    await expect(renders).toContainText("A newer render exists than the one playing here");
    const rows = renders.locator("li");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("v2");
    await expect(rows.nth(0)).toContainText("-14.0 LUFS");
    await expect(rows.nth(0)).not.toContainText("playing");
    await expect(rows.nth(1)).toContainText("v1");
    await expect(rows.nth(1)).toContainText("playing");
  });

  test("with no measurement on file for the playing file, none is borrowed from another render", async ({ page }) => {
    const scriptId = await seedMixEpisode();
    await addRenderB(scriptId, false);
    await e2eDb().episode.update({ where: { id: MIX.id }, data: { audioUrl: "https://example.invalid/acc-ep-mix/final-unmeasured.wav" } });
    await serveAudio(page);
    await openMix(page);
    await expect(page.getByText("No measurements on file for the mix playing here.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Measured audio quality" })).toHaveCount(0);
  });

  test("the waveform is read from the playing render and re-read when the render changes", async ({ page }) => {
    const scriptId = await seedMixEpisode();
    const reads = await serveAudio(page);
    await openMix(page);
    await page.getByRole("button", { name: "Show waveform" }).click();
    const wave = page.getByRole("slider", { name: /Waveform of the finished mix/ });
    await expect(wave).toBeVisible();
    expect(reads).toEqual([MIX.A]);
    // Keyboard seek on the waveform moves its value.
    await wave.focus();
    await page.keyboard.press("End");
    await expect(wave).toHaveAttribute("aria-valuenow", "100");

    // Render B goes live. The old picture must not be shown against it.
    await addRenderB(scriptId, true);
    await openMix(page);
    await expect(page.getByRole("button", { name: "Show waveform" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Measured audio quality" })).toContainText("-14.0 LUFS");
    await page.getByRole("button", { name: "Show waveform" }).click();
    await expect(page.getByRole("slider", { name: /Waveform of the finished mix/ })).toBeVisible();
    expect(reads).toEqual([MIX.A, MIX.B]);
  });
});
