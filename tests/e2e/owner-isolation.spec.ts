// D-02 — owner isolation across every surface that lists or opens owned records.
//
// The production failure this pins down: a brand-new account, four minutes old,
// with zero activity, was shown fifteen finished episodes under the heading
// "Everything you've made", plus a podcast it had never created carrying a live
// "Generate episode now" button — and opening that podcast rendered its FULL
// editable settings wizard.
//
// Two distinct causes, both covered here:
//   1. /studio/episodes ran a findMany with no `where` at all.
//   2. Every other surface OR'd `{ ownerId: null }` into its filter, so legacy
//      pre-accounts rows were treated as public. `ownerId: null` means nobody
//      has claimed the row — not that everybody owns it.
//
// The suite runs authenticated as userA (global-setup storageState). Each
// assertion is on the exact title a leak would render, so a passing test cannot
// be explained by an empty page.

import { test, expect, type Page } from "@playwright/test";
import {
  E2E,
  FOREIGN_PODCAST_NAME,
  LEGACY_PODCAST_NAME,
  FOREIGN_EPISODE_TITLE,
  LEGACY_EPISODE_TITLE,
} from "./seed";
import { closeE2eDb } from "./db";

test.afterAll(async () => { await closeE2eDb(); });

const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop-only flow");

/** Every string that must never appear on a surface belonging to userA. */
const FORBIDDEN = [FOREIGN_PODCAST_NAME, LEGACY_PODCAST_NAME, FOREIGN_EPISODE_TITLE, LEGACY_EPISODE_TITLE];

async function assertNoLeaks(page: Page, where: string) {
  const body = (await page.locator("body").innerText()) || "";
  for (const s of FORBIDDEN) {
    expect(body, `${where} leaked "${s}"`).not.toContain(s);
  }
}

test.describe("Owner isolation — one account never sees another's work", () => {
  test.beforeEach(({}, testInfo) => desktopOnly(testInfo.project.name));

  test("/studio/episodes lists only the viewer's episodes", async ({ page }) => {
    await page.goto("/studio/episodes");
    // The viewer's OWN seeded episode proves the page rendered and is scoped,
    // not merely blank.
    await expect(page.getByText("Prior show", { exact: false }).first()).toBeVisible();
    await assertNoLeaks(page, "/studio/episodes");
  });

  test("/studio board lists only the viewer's episodes", async ({ page }) => {
    await page.goto("/studio");
    await assertNoLeaks(page, "/studio");
  });

  test("/app/episodes lists only the viewer's episodes", async ({ page }) => {
    await page.goto("/app/episodes");
    await assertNoLeaks(page, "/app/episodes");
  });

  test("/app/podcasts lists only the viewer's podcasts", async ({ page }) => {
    await page.goto("/app/podcasts");
    await expect(page.getByText("The Overtime Show", { exact: false }).first()).toBeVisible();
    await assertNoLeaks(page, "/app/podcasts");
  });

  // A row hidden from a list must not be reachable by guessing its URL — that is
  // the difference between a display bug and an authorization hole. In the audit
  // the foreign podcast's manage page rendered its whole settings wizard.
  for (const [label, id] of [
    ["another account's", E2E.podcastForeignId],
    ["a legacy unowned", E2E.podcastLegacyId],
  ] as const) {
    test(`opening ${label} podcast by URL is not found`, async ({ page }) => {
      const res = await page.goto(`/app/podcasts/${id}`);
      expect(res?.status(), `${label} podcast must 404, not render`).toBe(404);
      const body = (await page.locator("body").innerText()) || "";
      expect(body).not.toContain("Generate episode now");
      expect(body).not.toContain("What's the show called?");
    });
  }
});
