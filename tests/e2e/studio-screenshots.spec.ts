// Capture every Studio route at the three audit widths.
//
// Not an assertion spec — it exists to produce the before/after evidence in
// docs/ux-audit/. Point it at a phase with SHOT_DIR:
//   SHOT_PHASE=before npx playwright test tests/e2e/studio-screenshots.spec.ts
//   SHOT_PHASE=after  npx playwright test tests/e2e/studio-screenshots.spec.ts
//
// It never fails on a route that legitimately has no content; a missing route
// is recorded in the filename list rather than silently skipped.

import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { E2E } from "./seed";

const PHASE = process.env.SHOT_PHASE || "before";
const OUT = path.join(process.cwd(), "docs", "ux-audit", PHASE);

/** Every Studio route the audit covers. `slug` becomes the filename stem. */
const ROUTES: { slug: string; url: string }[] = [
  { slug: "board", url: "/studio" },
  { slug: "shows", url: "/studio/shows" },
  { slug: "shows-detail", url: `/studio/shows/${E2E.podcastId}` },
  { slug: "shows-new", url: "/studio/shows/new" },
  { slug: "create", url: "/studio/create" },
  { slug: "episodes", url: "/studio/episodes" },
  { slug: "episode-detail", url: `/studio/episodes/${E2E.episodeAwaitingApprovalId}` },
  { slug: "takes", url: "/studio/takes" },
  { slug: "hosts", url: "/studio/hosts" },
  { slug: "auditions", url: "/studio/auditions" },
  { slug: "audio", url: "/studio/audio" },
  { slug: "publish", url: "/studio/publish" },
  { slug: "analytics", url: "/studio/analytics" },
  { slug: "plan", url: "/studio/plan" },
  { slug: "settings", url: "/studio/settings" },
];

test.describe(`Studio screenshots — ${PHASE}`, () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT, { recursive: true });
  });

  for (const route of ROUTES) {
    test(`${route.slug}`, async ({ page }, testInfo) => {
      const width = testInfo.project.use.viewport?.width ?? 0;
      const label = width >= 1440 ? "1440" : width >= 768 ? "768" : "390";

      const res = await page.goto(route.url, { waitUntil: "domcontentloaded" });
      // A route that 404s or 500s is worth SEEING in the audit, so it is still
      // captured; only a hard navigation failure is an error.
      expect(res, `navigation to ${route.url} produced no response`).toBeTruthy();

      // Studio pages are force-dynamic and several stream skeletons first.
      // Settle on the shell being present rather than on networkidle, which
      // never fires while the production console polls.
      await page.locator(".studioShell").waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForTimeout(1200);

      await page.screenshot({
        path: path.join(OUT, `${route.slug}-${label}.png`),
        fullPage: true,
      });
    });
  }
});
