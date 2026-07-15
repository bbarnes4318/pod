import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { E2E } from "./seed";

const SHOTS = path.join(process.cwd(), "docs", "screenshots", "studio-rundown");
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

const T = E2E.topics;
const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop-only flow");

async function gotoCreate(page: Page) {
  await page.goto("/studio/create");
  // Clear any draft left by a prior test so we start clean on the Show step.
  const discard = page.getByTestId("discard-draft");
  if (await discard.isVisible().catch(() => false)) {
    await discard.click();
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  await expect(page.getByTestId("mode-manual")).toBeVisible();
}
async function toTopics(page: Page) {
  await page.getByTestId("step-topics").click();
  await expect(page.getByTestId("board-filter-note")).toBeVisible();
}
async function pick(page: Page, id: string) { await page.getByTestId(`pick-${id}`).check(); }

test.describe("Studio rundown — full flows", () => {
  test.beforeEach(({}, testInfo) => desktopOnly(testInfo.project.name));

  test("manual: select, reorder, lead, remove, review, create — final order matches", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId("mode-manual").click();
    await toTopics(page);
    await pick(page, T.lead); await pick(page, T.two); await pick(page, T.three);
    await expect(page.getByTestId("tray-count")).toContainText("3/6");
    await shot(page, "manual");

    // Reorder: move t.three up once; set t.two as lead; remove t.three.
    await page.getByTestId(`tray-up-${T.three}`).click();
    await page.getByTestId(`tray-lead-${T.two}`).click();
    await shot(page, "tray");
    await page.getByTestId(`tray-remove-${T.three}`).click();
    await expect(page.getByTestId("tray-count")).toContainText("2/6");

    // Review shows the rundown; then create.
    await page.getByTestId("step-review").click();
    await expect(page.getByTestId("review-mode")).toHaveText("manual");
    await shot(page, "review");
    await page.getByTestId("create-episode").click();

    // finalOrder from the backend: lead (t.two) first, then t.lead.
    const order = page.getByTestId("result-final-order");
    await expect(order).toBeVisible();
    await expect(page.getByTestId(`final-${T.two}`)).toBeVisible();
    const items = await order.locator("li").allTextContents();
    expect(items[0]).toContain("Lead");
  });

  test("automatic: switching from manual clears stale picks; backend selects topics", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId("mode-manual").click();
    await toTopics(page);
    await pick(page, T.lead); await pick(page, T.two);
    await expect(page.getByTestId("tray-count")).toContainText("2/6");
    // Switch to automatic → picks cleared.
    await page.getByTestId("step-show").click();
    await page.getByTestId("mode-automatic").click();
    await page.getByTestId("step-topics").click();
    await expect(page.getByTestId("tray-count")).toContainText("0/6");
    await expect(page.getByTestId("pick-" + T.lead)).toBeDisabled();
    await shot(page, "automatic");
    await page.getByTestId("step-review").click();
    await page.getByTestId("create-episode").click();
    await expect(page.getByTestId("result-final-order")).toBeVisible();
    await expect(page.getByTestId("result-final-order").locator("li").first()).toContainText(/./);
  });

  test("hybrid: pin topics, set target, see auto slots", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId("mode-hybrid").click();
    await toTopics(page);
    await pick(page, T.lead); await pick(page, T.two);
    await expect(page.getByTestId("hybrid-slots")).toContainText("2 pinned");
    await shot(page, "hybrid");
    await page.getByTestId("step-review").click();
    await page.getByTestId("create-episode").click();
    await expect(page.getByTestId("result-final-order")).toBeVisible();
    // Pinned topic remains first.
    await expect(page.getByTestId("result-final-order").locator("li").first()).toContainText("Did the refs");
  });

  test("podcast inheritance: hosts + target inherit; override persists across reload", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId(`podcast-${E2E.podcastId}`).click();
    await expect(page.getByTestId("inherit-note")).toContainText(/hosts|target/i);
    await page.getByTestId("mode-automatic").click();
    await page.getByTestId("step-topics").click();
    // Inherited segmentCount = 4.
    await expect(page.getByTestId("target-count")).toHaveText("4");
    // Override the target, then reload — the override must persist (autosaved draft).
    await page.locator("#targetCount").fill("2");
    await expect(page.getByTestId("target-count")).toHaveText("2");
    await page.waitForTimeout(1200); // allow debounced autosave
    await page.reload();
    await page.getByTestId("step-topics").click();
    await expect(page.getByTestId("target-count")).toHaveText("2");
  });

  test("resume: a partial rundown is restored after reload and in a second session", async ({ page, context }) => {
    await gotoCreate(page);
    await page.getByTestId("mode-manual").click();
    await toTopics(page);
    await pick(page, T.lead); await pick(page, T.three);
    await page.waitForTimeout(1200);
    await page.reload();
    await page.getByTestId("step-topics").click();
    await expect(page.getByTestId("tray-count")).toContainText("2/6");
    // Second browser context (same authenticated user) sees the server-side draft.
    const page2 = await context.newPage();
    await page2.goto("/studio/create");
    await page2.getByTestId("step-topics").click();
    await expect(page2.getByTestId("tray-count")).toContainText("2/6");
    await page2.close();
    // Clean up the draft so it doesn't leak into other tests.
    await page.getByTestId("discard-draft").click();
  });

  test("accessibility: keyboard selection, reorder, and live-region announcements", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId("mode-manual").click();
    await toTopics(page);
    // Keyboard-select via the checkbox (focus + Space).
    await page.getByTestId(`pick-${T.lead}`).focus();
    await page.keyboard.press("Space");
    await page.getByTestId(`pick-${T.two}`).focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("tray-count")).toContainText("2/6");
    // Keyboard reorder via the visible move control (no drag needed).
    await page.getByTestId(`tray-down-${T.lead}`).focus();
    await page.keyboard.press("Enter");
    // Live region announced the change.
    await expect(page.locator("[aria-live=polite]").first()).toContainText(/position|Moved|Added/i);
    // Tray expansion exposes aria-expanded.
    await page.getByTestId(`tray-expand-${T.two}`).click();
    await expect(page.getByTestId(`tray-expand-${T.two}`)).toHaveAttribute("aria-expanded", "true");
    await page.getByTestId("discard-draft").click();
  });
});

test.describe("Studio rundown — responsive", () => {
  test("layout is usable across viewports; tray reorderable without drag", async ({ page }, testInfo) => {
    await gotoCreate(page);
    await page.getByTestId("mode-manual").click();
    await toTopics(page);
    await pick(page, T.lead); await pick(page, T.two);
    // The rundown tray + its keyboard move controls remain reachable & usable.
    const up = page.getByTestId(`tray-up-${T.two}`);
    await expect(up).toBeVisible();
    await up.click(); // reorder via visible control (touch-friendly, no DnD)
    // No horizontal overflow of the document.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
    expect(overflow).toBeTruthy();
    if (testInfo.project.name === "mobile") {
      await shot(page, "mobile");
    }
    await page.getByTestId("discard-draft").click();
  });
});
