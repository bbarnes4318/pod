// Sound & Branding UI (PR 2): sonic identity, variant pools, preview resolution.
// DB-only + UI — no LLM/TTS/network/paid APIs. Uses ORDINARY browser
// interactions only: real .click() / keyboard — never force:true,
// dispatchEvent, or direct handler invocation, so a control that something
// else covers fails these tests rather than being poked through the covering.
//
// This page MOVED from /app to /studio. /app/podcasts/[id]/sound is now a
// redirect shim, and the studio shell — unlike the /app one — renders no
// persistent player bar (PlayerProvider lives only in src/app/app/layout.tsx).
// The old precondition here asserted that bar was visible and therefore failed
// every test in the file at the first line of gotoSound. What it was really
// protecting is unchanged and still covered: Save and Preview must be
// reachable and clickable by ordinary mouse and keyboard, under whatever
// chrome the surface has.

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
  // Straight to where the page actually lives, rather than through the shim.
  await page.goto(`/studio/shows/${E2E.podcastId}/sound`);
  await expect(page.getByTestId("sound-branding")).toBeVisible();
  // The sticky action footer is what has to stay reachable; assert it is there
  // before any test relies on clicking Save inside it.
  await expect(page.getByTestId("sound-actions")).toBeVisible();
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

  // Runs on ALL projects (desktop + tablet + mobile): proves a NORMAL mouse
  // click on Save works on every viewport, including the narrow ones where the
  // sticky footer and the page content compete for the same pixels.
  test("Blocker 1: Save is clickable with a normal click", async ({ page }) => {
    await seedAssets();
    await gotoSound(page);
    await page.getByTestId("mode-custom").check();
    await page.getByTestId("pool-intro-add").selectOption("e2e-intro-a");
    await page.getByTestId("pool-outro-add").selectOption("e2e-outro-a");
    // No force, no dispatchEvent — an ordinary click, which only passes strict
    // actionability if nothing is covering the button.
    await page.getByTestId("sound-save").click();
    await expect(page.getByTestId("sound-status")).toContainText(/Saved|attention/i, { timeout: 15000 });
    await expect(page.getByTestId("sound-status")).toBeInViewport();
    await expect(page.getByTestId("sound-preview")).toBeVisible();
    const introCount = await e2eDb().podcastSoundAssignment.count({ where: { podcastId: E2E.podcastId, role: "intro" } });
    expect(introCount).toBe(1);
  });

  test("Blocker 1: Save is reachable and activatable by keyboard", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await seedAssets();
    await gotoSound(page);
    await page.getByTestId("mode-custom").check();
    await page.getByTestId("pool-intro-add").selectOption("e2e-intro-a");
    await page.getByTestId("pool-outro-add").selectOption("e2e-outro-a");
    const save = page.getByTestId("sound-save");
    await save.focus();
    await expect(save).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sound-status")).toContainText(/Saved|attention/i, { timeout: 15000 });
  });

  test("Tests 46-50: configure identity, add/reorder/weight variants, set cue family", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await seedAssets();
    await e2eDb().podcastSoundAssignment.deleteMany({ where: { podcastId: E2E.podcastId } });
    await gotoSound(page);
    await page.getByTestId("mode-custom").check();
    await page.getByTestId("identity-broadcast").selectOption("sports_radio");
    await page.getByTestId("identity-pace").selectOption("fast");
    await page.getByTestId("pool-intro-add").selectOption("e2e-intro-a");
    await page.getByTestId("pool-intro-add").selectOption("e2e-intro-b");
    await expect(page.getByTestId("pool-intro-row-e2e-intro-a")).toBeVisible();
    await expect(page.getByTestId("pool-intro-row-e2e-intro-b")).toBeVisible();
    await page.getByTestId("pool-outro-add").selectOption("e2e-outro-a");
    const introRow = page.getByTestId("pool-intro-row-e2e-intro-a");
    await introRow.getByRole("combobox").first().selectOption("brand_high_energy");
    await introRow.getByRole("spinbutton").first().fill("5");
    await introRow.getByRole("button", { name: /Move .* down/ }).click();
    await page.getByTestId("sound-save").click();
    await expect(page.getByTestId("sound-status")).toContainText(/Saved|attention/i, { timeout: 15000 });
    const introCount = await e2eDb().podcastSoundAssignment.count({ where: { podcastId: E2E.podcastId, role: "intro" } });
    expect(introCount).toBe(2);
  });

  test("Test 51: enabling intro with no variant is a blocking validation error", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await seedAssets();
    await e2eDb().podcastSoundAssignment.deleteMany({ where: { podcastId: E2E.podcastId } });
    await gotoSound(page);
    await page.getByTestId("mode-custom").check();
    await page.getByTestId("pool-outro-add").selectOption("e2e-outro-a");
    await page.getByTestId("pool-stinger-add").selectOption("e2e-sting-a");
    await page.getByTestId("sound-save").click();
    await expect(page.getByTestId("sound-status")).toContainText(/enabled an intro\/outro but assigned no variant/i, { timeout: 15000 });
    await expect(page.getByTestId("sound-status")).toBeInViewport();
  });

  test("Test 53: Preview Resolution shows three deterministic examples without creating episodes", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await seedAssets();
    await gotoSound(page);
    const before = await e2eDb().episode.count({ where: { podcastId: E2E.podcastId } });
    await page.getByTestId("sound-preview").click();
    await expect(page.getByTestId("preview-examples")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("preview-example-0")).toBeVisible();
    await expect(page.getByTestId("preview-example-2")).toBeVisible();
    const after = await e2eDb().episode.count({ where: { podcastId: E2E.podcastId } });
    expect(after).toBe(before);
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
    expect(html).not.toContain("x.test");
    expect(html).not.toMatch(/https?:\/\/[^"'\s]*\.(mp3|wav)/i);
    expect(html).not.toContain("rightsDocumentStorageKey");
    expect(html).not.toMatch(/episodes\/[a-z0-9-]+\/final/i);
  });
});
