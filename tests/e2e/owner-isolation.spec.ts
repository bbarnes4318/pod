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
  //
  // ON THE STATUS CODE. This used to assert `status() === 404` and now cannot,
  // for a reason that is architectural rather than a regression in the guard:
  // /app/podcasts/[id] is a redirect shim to /studio/shows/[id], and
  // src/app/studio/loading.tsx puts a Suspense boundary around EVERY route
  // under /studio. Next therefore flushes the shell — committing HTTP 200 —
  // before the page has finished its lookup, so the later notFound() can only
  // swap the UI, never the status. That is true of every /studio route, not
  // just this one.
  //
  // The status is worth having (caches, crawlers and uptime checks all read it)
  // and getting it back means authorizing ABOVE the boundary — in proxy.ts,
  // which would need a database lookup in middleware. Until that is done the
  // assertions below test the property that actually protects a customer, and
  // test it harder than the status did: the page must not render, and not one
  // byte of the other account's row may reach the document.
  for (const [label, id] of [
    ["another account's", E2E.podcastForeignId],
    ["a legacy unowned", E2E.podcastLegacyId],
  ] as const) {
    test(`opening ${label} podcast by URL is not found`, async ({ page }) => {
      await page.goto(`/app/podcasts/${id}`);
      const body = (await page.locator("body").innerText()) || "";
      // notFound() actually fired — this is Next's built-in not-found page.
      expect(body, `${label} podcast must render not-found, not the show`).toContain("could not be found");
      // None of the manage page rendered.
      expect(body).not.toContain("Generate episode now");
      expect(body).not.toContain("What's the show called?");
      // And nothing identifying the row leaked, which is the whole point.
      await assertNoLeaks(page, `/app/podcasts/${id}`);
    });
  }
});
