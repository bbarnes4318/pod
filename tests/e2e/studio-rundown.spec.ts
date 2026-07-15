import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { E2E } from "./seed";
import { episodeTopicOrder, episodeRow, waitForDraft, closeE2eDb } from "./db";

const SHOTS = path.join(process.cwd(), "docs", "screenshots", "studio-rundown");
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

const T = E2E.topics;
const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop-only flow");

test.afterAll(async () => { await closeE2eDb(); });

async function gotoCreate(page: Page) {
  await page.goto("/studio/create");
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
const pick = (page: Page, id: string) => page.getByTestId(`pick-${id}`).check();

/** Topic ids in the selected rundown tray, in displayed order. */
const trayOrder = (page: Page) =>
  page.$$eval("[data-tray-topic]", (els) => els.map((e) => e.getAttribute("data-tray-topic") || ""));
/** Topic ids in the RESULT list, in displayed order. */
const displayedFinalOrder = (page: Page) =>
  page.$$eval('[data-testid^="final-"]', (els) => els.map((e) => (e.getAttribute("data-testid") || "").replace(/^final-/, "")));
async function createdEpisodeId(page: Page): Promise<string> {
  const href = await page.getByRole("link", { name: "Open episode" }).getAttribute("href");
  return (href || "").split("/").pop() || "";
}
/** Assert the UI's final order is EXACTLY the ordered EpisodeTopic rows. */
async function assertUiMatchesDb(page: Page, expected?: string[]) {
  const episodeId = await createdEpisodeId(page);
  expect(episodeId).toBeTruthy();
  const displayed = await displayedFinalOrder(page);
  const dbOrder = await episodeTopicOrder(episodeId);
  expect(displayed).toEqual(dbOrder); // displayed === database
  if (expected) expect(dbOrder).toEqual(expected);
  return { episodeId, dbOrder };
}

test.describe("Studio rundown — full flows", () => {
  test.beforeEach(({}, testInfo) => desktopOnly(testInfo.project.name));

  test("manual: exact order through select → reorder → lead → remove → create, UI == DB", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId("mode-manual").click();
    await toTopics(page);

    // 1. Initial selection order.
    await pick(page, T.lead); await pick(page, T.two); await pick(page, T.three);
    expect(await trayOrder(page)).toEqual([T.lead, T.two, T.three]);
    await shot(page, "manual");

    // 2. Reorder: move T.three up one → [lead, three, two].
    await page.getByTestId(`tray-up-${T.three}`).click();
    expect(await trayOrder(page)).toEqual([T.lead, T.three, T.two]);

    // 3. Lead designation: T.two becomes lead → moves to front.
    await page.getByTestId(`tray-lead-${T.two}`).click();
    expect(await trayOrder(page)).toEqual([T.two, T.lead, T.three]);
    await shot(page, "tray");

    // 4. Removal.
    await page.getByTestId(`tray-remove-${T.three}`).click();
    expect(await trayOrder(page)).toEqual([T.two, T.lead]);

    await page.getByTestId("step-review").click();
    await expect(page.getByTestId("review-mode")).toHaveText("manual");
    await shot(page, "review");
    await page.getByTestId("create-episode").click();
    await expect(page.getByTestId("result-final-order")).toBeVisible();

    // Exact final order, and the UI matches the real EpisodeTopic rows.
    await assertUiMatchesDb(page, [T.two, T.lead]);
  });

  test("automatic: clears stale picks, applies a real backend preference, UI == DB", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId("mode-manual").click();
    await toTopics(page);
    await pick(page, T.lead); await pick(page, T.nba);
    expect(await trayOrder(page)).toEqual([T.lead, T.nba]);

    // Switch to Automatic → picks + lead cleared, selection disabled.
    await page.getByTestId("step-show").click();
    await page.getByTestId("mode-automatic").click();
    await page.getByTestId("step-topics").click();
    expect(await trayOrder(page)).toEqual([]);
    await expect(page.getByTestId(`pick-${T.lead}`)).toBeDisabled();

    // Real backend preference: sport = NFL (excludes the seeded NBA topic).
    await page.getByTestId("pref-sport").selectOption("NFL");
    await page.locator("#targetCount").fill("2");
    await shot(page, "automatic");

    await page.getByTestId("step-review").click();
    await expect(page.getByTestId("review-prefs")).toContainText("sport NFL");
    await page.getByTestId("create-episode").click();
    await expect(page.getByTestId("result-final-order")).toBeVisible();

    const { dbOrder } = await assertUiMatchesDb(page);
    // Every returned topic satisfies the preference; the out-of-preference
    // (NBA) topic is absent.
    expect(dbOrder.length).toBeGreaterThan(0);
    expect(dbOrder).not.toContain(T.nba);
    for (const id of dbOrder) expect(id.startsWith("e2e-t-")).toBeTruthy();
  });

  test("hybrid: pinned order preserved, auto-fill marked, count == target, UI == DB", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId("mode-hybrid").click();
    await toTopics(page);

    // Pin two, in this order.
    await pick(page, T.two); await pick(page, T.lead);
    expect(await trayOrder(page)).toEqual([T.two, T.lead]);
    await page.locator("#targetCount").fill("3");
    await expect(page.getByTestId("hybrid-slots")).toContainText("1 will be selected automatically");
    await page.getByTestId("pref-sport").selectOption("NFL");
    await shot(page, "hybrid");

    await page.getByTestId("step-review").click();
    await page.getByTestId("create-episode").click();
    await expect(page.getByTestId("result-final-order")).toBeVisible();

    const { dbOrder } = await assertUiMatchesDb(page);
    // Pinned first, in the requested order.
    expect(dbOrder.slice(0, 2)).toEqual([T.two, T.lead]);
    // Target met, with an auto-filled third that respects the NFL preference.
    expect(dbOrder).toHaveLength(3);
    expect(dbOrder).not.toContain(T.nba);
    // At least one returned topic is marked automatic in the UI.
    await expect(page.getByTestId("result-final-order").getByText("auto").first()).toBeVisible();
  });

  test("automatic: reduced rundown is reported honestly when fewer topics qualify", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId("mode-automatic").click();
    await page.getByTestId("step-topics").click();
    // Only ONE seeded NBA topic exists, but ask for 3 → reduced rundown.
    await page.getByTestId("pref-sport").selectOption("NBA");
    await page.locator("#targetCount").fill("3");
    await page.getByTestId("step-review").click();
    await page.getByTestId("create-episode").click();
    await expect(page.getByTestId("result-final-order")).toBeVisible();
    await expect(page.getByTestId("reduced-notice")).toContainText("you requested 3");
    const { dbOrder } = await assertUiMatchesDb(page, [T.nba]);
    expect(dbOrder).toHaveLength(1);
  });

  // FLOW A — inherited values must stay REPLACEABLE across a reload.
  test("inheritance flow A: Podcast A inherited values survive reload but are replaced by Podcast B", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId(`podcast-${E2E.podcastId}`).click();
    await expect(page.getByTestId("inherit-note")).toContainText("Inherited");

    // A's two saved hosts are visibly selected, in chair order A then B.
    await page.getByTestId("step-hosts").click();
    await expect(page.getByTestId(`host-${E2E.hostAce}`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId(`host-${E2E.hostBlaze}`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId(`host-${E2E.hostAce}`)).toContainText("A");
    await expect(page.getByTestId(`host-${E2E.hostBlaze}`)).toContainText("B");

    // Count + verticals + TEAM NAMES (never raw ids) inherited.
    await page.getByTestId("step-show").click();
    await page.getByTestId("mode-automatic").click();
    await page.getByTestId("step-topics").click();
    await expect(page.getByTestId("target-count")).toHaveText("4");
    await expect(page.getByTestId("pref-vertical-NFL")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("pref-teams")).toHaveValue(new RegExp(E2E.teamChiefsName));
    await expect(page.getByTestId("pref-teams")).not.toHaveValue(new RegExp(E2E.teamChiefsId));

    // The autosaved draft records these as INHERITED, not overrides.
    const saved = await waitForDraft(E2E.userA.id, (s) => s.targetTopicCount === 4 && !!s.overrides);
    expect(saved.overrides).toEqual({ hosts: false, targetTopicCount: false, selectionPreferences: false });
    expect(saved.teams).toEqual([E2E.teamChiefsName, E2E.teamEaglesName]);

    // Reload — values restore, still as inherited.
    await page.reload();
    await page.getByTestId("step-topics").click();
    await expect(page.getByTestId("target-count")).toHaveText("4");
    await expect(page.getByTestId("pref-vertical-NFL")).toHaveAttribute("aria-pressed", "true");

    // Switch to Podcast B (empty verticals/teams/hosts, count 2) — A's inherited
    // values must be REPLACED/CLEARED even though the draft held non-empty ones.
    await page.getByTestId("step-show").click();
    await page.getByTestId(`podcast-${E2E.podcastBId}`).click();
    // Nothing was producer-edited, so no "Kept your override" may appear.
    await expect(page.getByTestId("inherit-note")).not.toContainText("Kept your override");
    await page.getByTestId("step-topics").click();
    await expect(page.getByTestId("target-count")).toHaveText("2");
    await expect(page.getByTestId("pref-teams")).toHaveValue("");
    await expect(page.getByTestId("pref-vertical-NFL")).toHaveAttribute("aria-pressed", "false");
    // A's hosts are gone (B has none → studio defaults; Ace is not among them).
    await page.getByTestId("step-hosts").click();
    await expect(page.getByTestId(`host-${E2E.hostAce}`)).toHaveAttribute("aria-pressed", "false");
    await page.getByTestId("discard-draft").click();
  });

  // FLOW B — real overrides must SURVIVE reload and a podcast switch.
  test("inheritance flow B: explicit overrides survive reload and switching to Podcast B", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId(`podcast-${E2E.podcastId}`).click();
    await page.getByTestId("mode-automatic").click();
    await page.getByTestId("step-topics").click();
    await expect(page.getByTestId("target-count")).toHaveText("4"); // inherited

    // Producer explicitly overrides target count AND selection preferences.
    await page.locator("#targetCount").fill("5");
    await page.getByTestId("pref-vertical-NBA").click(); // add NBA → prefs overridden
    const saved = await waitForDraft(E2E.userA.id, (s) => s.overrides?.targetTopicCount === true && s.overrides?.selectionPreferences === true);
    expect(saved.overrides.hosts).toBe(false); // hosts were never edited
    expect(saved.targetTopicCount).toBe(5);

    // Reload — explicit overrides restore as overrides.
    await page.reload();
    await page.getByTestId("step-topics").click();
    await expect(page.getByTestId("target-count")).toHaveText("5");
    await expect(page.getByTestId("pref-vertical-NBA")).toHaveAttribute("aria-pressed", "true");

    // Switch to Podcast B: ONLY the explicitly-changed settings survive.
    await page.getByTestId("step-show").click();
    await page.getByTestId(`podcast-${E2E.podcastBId}`).click();
    await expect(page.getByTestId("inherit-note")).toContainText("Kept your override");
    await page.getByTestId("step-topics").click();
    await expect(page.getByTestId("target-count")).toHaveText("5");                          // override kept
    await expect(page.getByTestId("pref-vertical-NBA")).toHaveAttribute("aria-pressed", "true"); // override kept
    await expect(page.getByTestId("pref-vertical-NFL")).toHaveAttribute("aria-pressed", "true"); // part of the same overridden prefs
    // Hosts were NOT overridden → they follow Podcast B (which has none).
    await page.getByTestId("step-hosts").click();
    await expect(page.getByTestId(`host-${E2E.hostAce}`)).toHaveAttribute("aria-pressed", "false");
    await page.getByTestId("discard-draft").click();
  });

  test("resume: a GENUINE second browser context restores the server-side draft", async ({ page, context, browser }) => {
    await gotoCreate(page);
    await page.getByTestId("mode-hybrid").click();
    await page.getByTestId("episode-description").fill("Rundown notes that must survive.");
    await toTopics(page);
    await pick(page, T.two); await pick(page, T.lead);
    await page.locator("#targetCount").fill("3");
    await page.getByTestId("pref-sport").selectOption("NFL");
    // Wait for the draft to actually land server-side (no debounce racing).
    const saved = await waitForDraft(E2E.userA.id, (s) => s.mode === "hybrid" && s.sport === "NFL" && s.targetTopicCount === 3);
    expect(saved.selectedTopicIds).toEqual([T.two, T.lead]);
    expect(saved.description).toBe("Rundown notes that must survive.");

    // A real second BROWSER CONTEXT (not just another page/tab).
    const secondContext = await browser.newContext({ storageState: await context.storageState() });
    const secondPage = await secondContext.newPage();
    try {
      await secondPage.goto("/studio/create");
      await secondPage.getByTestId("step-topics").click();
      // Topic order, mode, target count, and preferences all restored.
      expect(await trayOrder(secondPage)).toEqual([T.two, T.lead]);
      await expect(secondPage.getByTestId("target-count")).toHaveText("3");
      await expect(secondPage.getByTestId("hybrid-slots")).toContainText("2 pinned");
      await expect(secondPage.getByTestId("pref-sport")).toHaveValue("NFL");
      await secondPage.getByTestId("step-show").click();
      await expect(secondPage.getByTestId("mode-hybrid")).toHaveAttribute("aria-checked", "true");
      await expect(secondPage.getByTestId("episode-description")).toHaveValue("Rundown notes that must survive.");
    } finally {
      await secondContext.close();
    }
    await page.getByTestId("discard-draft").click();
  });

  test("startDebate failure: error shown, no redirect, button re-enabled; retry succeeds", async ({ page, request }) => {
    await gotoCreate(page);
    await page.getByTestId("mode-manual").click();
    await toTopics(page);
    await pick(page, T.lead);
    await page.getByTestId("step-review").click();
    await page.getByTestId("create-episode").click();
    await expect(page.getByTestId("result-final-order")).toBeVisible();
    const urlBefore = page.url();

    // Arm the E2E-only failure seam (404s unless E2E_TEST_MODE=1).
    const armed = await request.post("/api/e2e/start-debate-failure", { data: { fail: true } });
    expect(armed.status(), "E2E seam route must be reachable in E2E mode").toBe(200);
    await page.getByTestId("start-debate").click();
    await expect(page.getByTestId("start-error")).toBeVisible();
    expect(page.url()).toBe(urlBefore); // no redirect
    await expect(page.getByTestId("start-debate")).toBeEnabled();
    await expect(page.getByTestId("start-debate")).toContainText("Start the debate");

    // Disarm → retry redirects to the episode.
    await request.post("/api/e2e/start-debate-failure", { data: { fail: false } });
    await page.getByTestId("start-debate").click();
    await page.waitForURL(/\/studio\/episodes\//, { timeout: 30000 });
  });

  test("accessibility: keyboard selection, reorder, live region, aria-expanded", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId("mode-manual").click();
    await toTopics(page);
    await page.getByTestId(`pick-${T.lead}`).focus();
    await page.keyboard.press("Space");
    await page.getByTestId(`pick-${T.two}`).focus();
    await page.keyboard.press("Space");
    expect(await trayOrder(page)).toEqual([T.lead, T.two]);
    await page.getByTestId(`tray-down-${T.lead}`).focus();
    await page.keyboard.press("Enter");
    expect(await trayOrder(page)).toEqual([T.two, T.lead]);
    await expect(page.locator("[aria-live=polite]").first()).toContainText(/position|Moved|Added/i);
    await page.getByTestId(`tray-expand-${T.two}`).click();
    await expect(page.getByTestId(`tray-expand-${T.two}`)).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId(`tray-detail-${T.two}`)).toBeVisible();
    await page.getByTestId("discard-draft").click();
  });
});

test.describe("Studio rundown — responsive", () => {
  test("layout usable across viewports; tray reorderable without drag", async ({ page }, testInfo) => {
    await gotoCreate(page);
    await page.getByTestId("mode-manual").click();
    await toTopics(page);
    await pick(page, T.lead); await pick(page, T.two);
    const up = page.getByTestId(`tray-up-${T.two}`);
    await expect(up).toBeVisible();
    await up.click(); // visible control — touch-friendly, no drag needed
    expect(await trayOrder(page)).toEqual([T.two, T.lead]);
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
    expect(noOverflow).toBeTruthy();
    if (testInfo.project.name === "mobile") await shot(page, "mobile");
    await page.getByTestId("discard-draft").click();
  });
});
