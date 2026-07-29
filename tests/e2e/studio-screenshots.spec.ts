import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { E2E } from "./seed";

const shots = [
  ["board", "/studio"],
  ["episodes", "/studio/episodes"],
  ["takes", "/studio/takes"],
  ["hosts", "/studio/hosts"],
  ["publishing", "/studio/publish"],
  ["episode-detail", `/studio/episodes/${E2E.episodeAwaitingApprovalId}`],
  ["show-forge", "/studio/shows/new"],
  ["analytics", "/studio/analytics"],
  ["plan", "/studio/plan"],
  ["settings", "/studio/settings"],
] as const;

const output = path.join(process.cwd(), "test-results", "studio-screenshots");

test.describe("Studio visual acceptance captures", () => {
  test("desktop, wide, and mobile screenshots", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    fs.mkdirSync(output, { recursive: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [name, route] of shots) {
      await page.goto(route);
      await expect(page.locator("main.studioMain")).toBeVisible();
      await page.screenshot({ path: path.join(output, `${name}-1440x900.png`), fullPage: true });
    }

    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/studio");
    await page.screenshot({ path: path.join(output, "board-1920x1080.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    for (const [name, route] of shots) {
      await page.goto(route);
      await expect(page.locator("main.studioMain")).toBeVisible();
      await page.screenshot({ path: path.join(output, `${name}-390x844.png`), fullPage: true });
    }
  });
});
