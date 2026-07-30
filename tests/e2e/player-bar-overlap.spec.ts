// The Studio creation footer must never cover or intercept its primary action.
//
// Show creation now belongs in /studio, not the listener /app shell. This test
// keeps the original user-facing guarantee — a long team-selection step can be
// completed with an ordinary click — while validating the canonical Show Forge
// workspace rather than requiring the listener audio player to exist there.

import { test, expect, type Page } from "@playwright/test";

const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop-only flow");

async function hitTest(page: Page, x: number, y: number) {
  return page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    return hit ? `${hit.tagName}.${hit.className}`.slice(0, 100) : null;
  }, { x, y });
}

test.describe("Studio action footer never covers a primary action", () => {
  test.beforeEach(({}, testInfo) => desktopOnly(testInfo.project.name));

  test("Show Forge Continue remains clickable on the long World step", async ({ page }) => {
    await page.goto("/studio/shows/new");

    await page.getByLabel("Show name").fill("Overlap Probe");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Promise" })).toBeVisible();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "World" })).toBeVisible();

    // Two sports worlds render a deliberately long team list from the seed
    // catalog, exercising the sticky action footer on a page taller than the
    // viewport.
    await page.getByRole("button", { name: "NFL", exact: true }).click();
    await page.getByRole("button", { name: "NBA", exact: true }).click();

    const forward = page.getByRole("button", { name: "Continue", exact: true });
    await forward.scrollIntoViewIfNeeded();
    const box = await forward.boundingBox();
    expect(box, "Continue button must have a visible box").not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    const hit = await hitTest(page, x, y);
    expect(hit, `Continue centre was intercepted by ${hit}`).toMatch(/^BUTTON\./);

    // No force and no direct handler invocation: this is the exact click a
    // customer makes after choosing sports and teams.
    await forward.click({ timeout: 5000 });
    await expect(page.getByRole("heading", { name: "Cast" })).toBeVisible();
  });
});
