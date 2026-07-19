// Sound & Branding UI (PR 2): sonic identity, variant pools, preview resolution.
// DB-only + UI — no LLM/TTS/network/paid APIs. Desktop project only.

import { test, expect, type Page } from "@playwright/test";
import { e2eDb, closeE2eDb } from "./db";
import { E2E } from "./seed";

const desktopOnly = (t: { project: { name: string } }) => t.project.name === "desktop";

async function seedAssets() {
  const db = e2eDb();
  const mk = (id: string, kind: string, name: string) =>
    db.audioAsset.upsert({
      where: { id },
      update: {},
      create: { id, name, kind, tags: [], audioUrl: `http://x.test/${id}`, license: "x", scope: "shared_system", processingStatus: "ready", isActive: true, licenseStatus: "licensed", rightsStatus: "not_required" },
    });
  await mk("e2e-intro-a", "theme_intro", "Brand Intro A");
  await mk("e2e-intro-b", "theme_intro", "Brand Intro B");
  await mk("e2e-outro-a", "theme_outro", "Brand Outro A");
  await mk("e2e-sting-a", "stinger", "Transition A");
}

async function gotoSound(page: Page) {
  await page.goto(`/app/podcasts/${E2E.podcastId}/sound`);
  await expect(page.getByTestId("sound-branding")).toBeVisible();
}

test.afterAll(async () => { await closeE2eDb(); });

test.describe("Sound & Branding", () => {
  test("Test 55/46: existing config loads; custom reveals identity + variant pools", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await seedAssets();
    await gotoSound(page);
    await page.getByTestId("mode-custom").check();
    await expect(page.getByTestId("sonic-identity")).toBeVisible();
    for (const id of ["pool-intro", "pool-outro", "pool-bed", "pool-stinger", "pool-reaction"]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });

  test("Tests 46-50: configure identity, add/reorder/weight variants, set cue family", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await seedAssets();
    await gotoSound(page);
    await page.getByTestId("mode-custom").check();
    // identity
    await page.getByTestId("identity-broadcast").selectOption("sports_radio");
    await page.getByTestId("identity-pace").selectOption("fast");
    // add two intro variants
    await page.getByTestId("pool-intro-add").selectOption("e2e-intro-a");
    await page.getByTestId("pool-intro-add").selectOption("e2e-intro-b");
    await expect(page.getByTestId("pool-intro-row-e2e-intro-a")).toBeVisible();
    await expect(page.getByTestId("pool-intro-row-e2e-intro-b")).toBeVisible();
    // add outro
    await page.getByTestId("pool-outro-add").selectOption("e2e-outro-a");
    // set a cue family + weight on the first intro
    const introRow = page.getByTestId("pool-intro-row-e2e-intro-a");
    await introRow.getByRole("combobox").first().selectOption("brand_high_energy");
    await introRow.getByRole("spinbutton").first().fill("5");
    // reorder intro-a down
    await introRow.getByRole("button", { name: /Move .* down/ }).click();
    // save
    await page.getByTestId("sound-save").dispatchEvent("click");
    await expect(page.getByTestId("sound-status")).toContainText(/Saved|attention/i, { timeout: 15000 });
    // persisted: two enabled intro variants
    const db = e2eDb();
    const introCount = await db.podcastSoundAssignment.count({ where: { podcastId: E2E.podcastId, role: "intro" } });
    expect(introCount).toBe(2);
  });

  test("Test 51: enabling intro with no variant is a blocking validation error", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await seedAssets();
    // reset to a clean slate for this podcast
    await e2eDb().podcastSoundAssignment.deleteMany({ where: { podcastId: E2E.podcastId } });
    await gotoSound(page);
    await page.getByTestId("mode-custom").check();
    // intro enabled (default) but assign only an outro + a stinger, no intro
    await page.getByTestId("pool-outro-add").selectOption("e2e-outro-a");
    await page.getByTestId("pool-stinger-add").selectOption("e2e-sting-a");
    await page.getByTestId("sound-save").dispatchEvent("click");
    await expect(page.getByTestId("sound-status")).toContainText(/enabled an intro\/outro but assigned no variant/i, { timeout: 15000 });
  });

  test("Test 53: Preview Resolution shows three deterministic examples without creating episodes", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await seedAssets();
    await gotoSound(page);
    const before = await e2eDb().episode.count({ where: { podcastId: E2E.podcastId } });
    await page.getByTestId("sound-preview").dispatchEvent("click");
    await expect(page.getByTestId("preview-examples")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("preview-example-0")).toBeVisible();
    await expect(page.getByTestId("preview-example-2")).toBeVisible();
    const after = await e2eDb().episode.count({ where: { podcastId: E2E.podcastId } });
    expect(after).toBe(before); // no episode created by preview
  });

  test("Test 54: clean mode hides all sound pools", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await gotoSound(page);
    await page.getByTestId("mode-custom").check();
    await expect(page.getByTestId("pool-intro")).toBeVisible();
    await page.getByTestId("mode-clean").check();
    await expect(page.getByTestId("pool-intro")).toHaveCount(0);
    await expect(page.getByTestId("sonic-identity")).toHaveCount(0);
  });

  test("Tests 40-42: no storage URLs, keys, or rights-doc references reach the page HTML", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await seedAssets();
    await gotoSound(page);
    await page.getByTestId("mode-custom").check();
    await page.getByTestId("pool-intro-add").selectOption("e2e-intro-a");
    const html = await page.content();
    expect(html).not.toContain("x.test");        // seeded storage URL host
    expect(html).not.toMatch(/https?:\/\/[^"'\s]*\.(mp3|wav)/i);
    expect(html).not.toContain("rightsDocumentStorageKey");
    expect(html).not.toMatch(/episodes\/[a-z0-9-]+\/final/i);
  });
});
