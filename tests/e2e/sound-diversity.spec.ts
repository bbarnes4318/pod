// Sound diversity operator UI (PR 4): the bounded diversity-policy config +
// recent-usage summary on the Sound & Branding screen, and the diversity panel
// on the studio episode Produce surface. DB-only + UI — no LLM/TTS/network.
// ORDINARY interactions only: real .click()/.fill()/keyboard — never force:true,
// dispatchEvent, or direct handler invocation.

import { test, expect, type Page } from "@playwright/test";
import { e2eDb, closeE2eDb } from "./db";
import { E2E } from "./seed";

const desktopOnly = (t: { project: { name: string } }) => t.project.name === "desktop";

async function gotoSound(page: Page) {
  await page.goto(`/app/podcasts/${E2E.podcastId}/sound`);
  await expect(page.getByTestId("sound-branding")).toBeVisible();
  await expect(page.getByRole("region", { name: "Player" })).toBeVisible();
}

test.afterAll(async () => { await closeE2eDb(); });

test.describe("Sound diversity — operator config UI", () => {
  test("1/6: owner sees the diversity policy fieldset, rollout mode, and recent-usage summary", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await gotoSound(page);
    await expect(page.getByTestId("diversity-policy")).toBeVisible();
    await expect(page.getByTestId("diversity-rollout-mode")).toBeVisible();
    await expect(page.getByTestId("div-historyWindowEpisodes")).toBeVisible();
    await expect(page.getByTestId("div-maximumSameIntroStreak")).toBeVisible();
    await expect(page.getByTestId("diversity-summary")).toBeVisible();
  });

  test("3: saving the diversity policy persists atomically and bumps the version", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    // Reset to a known version.
    await e2eDb().podcastProductionConfig.upsert({ where: { podcastId: E2E.podcastId }, update: { diversityPolicy: undefined }, create: { podcastId: E2E.podcastId } }).catch(() => {});
    await gotoSound(page);
    const before = (await e2eDb().podcast.findUnique({ where: { id: E2E.podcastId }, select: { configVersion: true } }))!.configVersion;
    await page.getByTestId("div-maximumSameBedStreak").fill("3");
    await page.getByTestId("div-systemCrossPodcastDiversityEnabled").check();
    await page.getByTestId("sound-save").click();
    await expect(page.getByTestId("sound-status")).toContainText(/Saved/i, { timeout: 15000 });
    const cfg = await e2eDb().podcastProductionConfig.findUnique({ where: { podcastId: E2E.podcastId }, select: { diversityPolicy: true } });
    const stored = cfg?.diversityPolicy as { maximumSameBedStreak?: number; systemCrossPodcastDiversityEnabled?: boolean } | null;
    expect(stored?.maximumSameBedStreak).toBe(3);
    expect(stored?.systemCrossPodcastDiversityEnabled).toBe(true);
    const after = (await e2eDb().podcast.findUnique({ where: { id: E2E.podcastId }, select: { configVersion: true } }))!.configVersion;
    expect(after).toBe(before + 1);
  });

  test("4/5: an out-of-bounds value is CLAMPED to its bound on save (never takes effect raw)", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await gotoSound(page);
    await page.getByTestId("div-hardAssetCooldownEpisodes").fill("9999"); // bound is 20
    await page.getByTestId("sound-save").click();
    await expect(page.getByTestId("sound-status")).toContainText(/Saved/i, { timeout: 15000 });
    const cfg = await e2eDb().podcastProductionConfig.findUnique({ where: { podcastId: E2E.podcastId }, select: { diversityPolicy: true } });
    const stored = cfg?.diversityPolicy as { hardAssetCooldownEpisodes?: number } | null;
    expect(stored?.hardAssetCooldownEpisodes).toBe(20);
  });

  test("Blocker: a STALE diversity save surfaces the concurrency conflict (no clobber)", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await gotoSound(page);
    // Advance the DB version behind the loaded UI, then save with the stale version.
    await e2eDb().podcast.update({ where: { id: E2E.podcastId }, data: { configVersion: { increment: 1 } } });
    await page.getByTestId("div-maximumSameIntroStreak").fill("2");
    await page.getByTestId("sound-save").click();
    await expect(page.getByTestId("sound-conflict")).toBeVisible({ timeout: 15000 });
  });

  test("Blocker: the diversity policy is reachable + activatable by keyboard", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await gotoSound(page);
    const input = page.getByTestId("div-familyCooldownEpisodes");
    await input.focus();
    await expect(input).toBeFocused();
    await input.fill("2");
    const save = page.getByTestId("sound-save");
    await save.focus();
    await expect(save).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sound-status")).toContainText(/Saved|attention|changed/i, { timeout: 15000 });
  });

  test("2/6: another owner's podcast is not accessible (owner-scoped)", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    // A podcast owned by a DIFFERENT user; userA (the authed session) must not read it.
    const other = `e2e-other-${Date.now()}`;
    await e2eDb().user.upsert({ where: { id: E2E.userB.id }, update: {}, create: { id: E2E.userB.id, email: E2E.userB.email } }).catch(() => {});
    await e2eDb().podcast.upsert({ where: { id: other }, update: {}, create: { id: other, name: "Not Yours", cadence: "recurring", ownerId: E2E.userB.id } });
    await page.goto(`/app/podcasts/${other}/sound`);
    await expect(page.getByTestId("sound-error")).toBeVisible({ timeout: 15000 });
  });

  test("7/10: no URLs, storage keys, or another podcast's private usage reach the HTML", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await gotoSound(page);
    await expect(page.getByTestId("diversity-policy")).toBeVisible();
    const html = await page.content();
    expect(html).not.toMatch(/https?:\/\/[^"'\s]*\.(mp3|wav)/i);
    expect(html).not.toContain("/storage/");
    expect(html).not.toContain("rightsDocumentStorageKey");
    // Another owner's episode ids must never appear (private usage isolation).
    expect(html).not.toContain("e2e-user-b");
  });

  // ---- Blocker 2: per-podcast rollout-mode override -----------------------
  test("Rollout 1/6: owner can select a rollout mode; it persists after reload", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await gotoSound(page);
    await page.getByTestId("div-rolloutModeOverride").selectOption("soft");
    await page.getByTestId("sound-save").click();
    await expect(page.getByTestId("sound-status")).toContainText(/Saved/i, { timeout: 15000 });
    const cfg = await e2eDb().podcastProductionConfig.findUnique({ where: { podcastId: E2E.podcastId }, select: { diversityPolicy: true } });
    expect((cfg?.diversityPolicy as { rolloutModeOverride?: string } | null)?.rolloutModeOverride).toBe("soft");
    await page.reload();
    await expect(page.getByTestId("div-rolloutModeOverride")).toHaveValue("soft");
  });

  test("Rollout 2: effective mode is displayed alongside the configured override", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await gotoSound(page);
    await expect(page.getByTestId("diversity-effective-mode")).toBeVisible();
    for (const m of ["inherit", "off", "observe", "soft", "enforce"]) {
      await page.getByTestId("div-rolloutModeOverride").selectOption(m); // every valid mode selectable
    }
  });

  test("Rollout 13: rollout mode is keyboard-selectable and saves", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await gotoSound(page);
    const sel = page.getByTestId("div-rolloutModeOverride");
    await sel.focus();
    await expect(sel).toBeFocused();
    await sel.selectOption("enforce");
    await page.getByTestId("sound-save").click();
    await expect(page.getByTestId("sound-status")).toContainText(/Saved|changed/i, { timeout: 15000 });
  });

  // ---- Blocker 3: render-detail diversity panel --------------------------
  test("Render detail: the diversity panel shows engine, mode, source, selections, and sequence", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    const db = e2eDb();
    const epId = `e2e-div-ep-${Date.now()}`;
    const decision = { version: 1, policyVersion: 1, mode: "enforce", seed: "s", historyWindow: 2,
      selectedIntro: { role: "intro", selectedAssetId: "brand-a", reason: "avoided recent intro", poolSize: 3, eligibleCount: 3, assetStreak: 0, familyStreak: 0, relaxations: [], candidates: [{ assetId: "brand-b", excluded: true, exclusionReason: "hard cooldown" }] },
      selectedOutro: { role: "outro", selectedAssetId: "close-a", reason: "weighted pick", poolSize: 2, eligibleCount: 2, assetStreak: 0, familyStreak: 0, relaxations: [], candidates: [] },
      selectedBed: null, motifDecision: { role: "intro", action: "prefer", recentRate: 0.2, minimumRate: 0.34, maximumRate: 0.75, reason: "below minimum" }, relaxations: ["single_item_pool"], warnings: [], fingerprint: "f".repeat(64) };
    const ctx = { version: 1, policyVersion: 1, rolloutMode: "enforce", historyWindow: 2, historyFingerprint: "h".repeat(64), transitionHistory: { recentAssetIds: [], recentFamilies: [] }, reactionHistory: { recentAssetIds: [], recentFamilies: [] }, systemTransitionHistory: null, systemReactionHistory: null, historyCueSequences: [], decision, fingerprint: "d".repeat(64) };
    const snapshot = { version: 6, source: "podcast", capturedAt: "2026-01-01T00:00:00.000Z", podcast: null, editorial: { verticals: [], teams: [], segmentCount: 2, format: "two_host_debate", minDebateScore: null, scriptStyle: null, maxWords: null, provenance: {} }, production: { hostIds: [], ttsProvider: null, ttsVoiceOverrides: null, productionStyle: null, sfxDensity: null, provenance: {}, diversityContext: ctx } };
    await db.episode.create({ data: { id: epId, title: "Div Detail", slug: epId, status: "audio_ready", formatId: "two_host_debate", hostIds: [], ownerId: E2E.userA.id, podcastId: E2E.podcastId, configurationSource: "podcast", configurationSnapshot: snapshot as object, configurationFingerprint: "fp" } });
    const sc = await db.script.create({ data: { episodeId: epId, version: 1, status: "approved", plainText: "hello world", content: { segments: [{ type: "topic", lines: [{ lineIndex: 0, speakerName: "A", text: "hi" }] }] } as object } });
    await db.episodeAudioRender.create({ data: { episodeId: epId, scriptId: sc.id, renderVersion: 1, status: "succeeded", renderMode: "initial",
      plan: { mode: "post_tts", fingerprint: "p".repeat(64), cueSequence: ["INTRO:brand_main", "TRANSITION:topic_reset", "OUTRO:close_main"], sequenceSimilarity: { maxSimilarity: 0.3, threshold: 0.7, overThreshold: false, comparisons: 2, relaxation: null }, cueDiversityDecisions: [{ role: "transition", lineIndex: 1, selectedAssetId: "st-1", selectedFamily: "topic_reset", reason: "least recently used", relaxations: [] }] } as object,
      diagnostics: { postTts: { planningEngine: "post_tts", diversity: { renderMode: "enforce", contextSource: "frozen", diversityFingerprint: "d".repeat(64) } } } as object } });

    await page.goto(`/studio/episodes/${epId}`);
    await page.getByRole("tab", { name: /Produce/ }).click();
    await expect(page.getByTestId("episode-diversity")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("diversity-engine")).toContainText("post_tts");
    await expect(page.getByTestId("diversity-config-source")).toContainText(/frozen/i);
    await expect(page.getByTestId("diversity-role-intro")).toContainText(/avoided recent intro/i);
    await expect(page.getByTestId("diversity-role-intro")).toContainText(/hard cooldown/i);
    await expect(page.getByTestId("diversity-motif")).toContainText(/prefer/i);
    await expect(page.getByTestId("diversity-cue-decisions")).toBeVisible();
    await expect(page.getByTestId("diversity-sequence")).toContainText(/0.30/);
    const html = await page.content();
    expect(html).not.toContain("/storage/");
    expect(html).not.toMatch(/https?:\/\/[^"'\s]*\.(mp3|wav)/i);
  });
});
