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
});
