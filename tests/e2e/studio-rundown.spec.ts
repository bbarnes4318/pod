import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { E2E } from "./seed";
import { e2eDb, episodeTopicOrder, episodeRow, waitForDraft, closeE2eDb } from "./db";

const SHOTS = path.join(process.cwd(), "docs", "screenshots", "studio-rundown");
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

const T = E2E.topics;
const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop-only flow");

test.afterAll(async () => { await closeE2eDb(); });

async function gotoCreate(page: Page) {
  await page.goto("/studio/create");
  const discard = page.getByTestId("discard-draft");
  // Discard is only rendered when a draft exists, and now sits behind an
  // explicit confirm step.
  if (await discard.isVisible().catch(() => false)) {
    await discard.click();
    await page.getByTestId("discard-confirm").click();
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

    // Disarm → retry succeeds. Since the live production console (#52),
    // success hands over IN PLACE — no hard navigation; the episode stays
    // reachable via the console's Open link.
    await request.post("/api/e2e/start-debate-failure", { data: { fail: false } });
    await page.getByTestId("start-debate").click();
    await expect(page.getByTestId("production-console")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open episode" })).toHaveAttribute("href", /\/studio\/episodes\//);
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

test.describe("Studio rundown — Phase 1: no silent data loss", () => {
  test.beforeEach(({}, testInfo) => desktopOnly(testInfo.project.name));

  test("step-1 state (title + mode) survives a reload — the default manual/zero-topics draft persists", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId("episode-title").fill("Title typed on step one");
    // The draft must actually land server-side despite zero topics selected.
    const saved = await waitForDraft(E2E.userA.id, (s) => s.title === "Title typed on step one");
    expect(saved.mode).toBe("manual");
    await page.reload();
    await expect(page.getByTestId("episode-title")).toHaveValue("Title typed on step one");
    await page.getByTestId("discard-draft").click();
    await page.getByTestId("discard-confirm").click();
  });

  test("format choice survives a reload (formatId is a persisted draft field)", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId("step-hosts").click();
    await page.getByTestId("format-sports_radio").click();
    await waitForDraft(E2E.userA.id, (s) => s.formatId === "sports_radio");
    await page.reload();
    await page.getByTestId("step-hosts").click();
    await expect(page.getByTestId("format-sports_radio")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("discard-draft").click();
    await page.getByTestId("discard-confirm").click();
  });

  test("a failed save is VISIBLE and retryable — never silent", async ({ page }) => {
    await gotoCreate(page);
    // Kill the network for server-action POSTs on this page.
    await page.route("**/studio/create*", (route) =>
      route.request().method() === "POST" ? route.abort() : route.continue()
    );
    await page.getByTestId("episode-title").fill("Will fail to save");
    await expect(page.getByTestId("save-status")).toContainText(/Couldn't save/i);
    // Restore the network → the offered retry actually works.
    await page.unroute("**/studio/create*");
    await page.getByTestId("save-retry").click();
    await expect(page.getByTestId("save-status")).toContainText(/^Saved/);
    await page.getByTestId("discard-draft").click();
    await page.getByTestId("discard-confirm").click();
  });

  test("discard requires confirmation, cancel keeps the draft, and the button is absent with no draft", async ({ page }) => {
    await gotoCreate(page);
    // Fresh page, no draft yet → no discard button rendered.
    await expect(page.getByTestId("discard-draft")).toHaveCount(0);
    await page.getByTestId("episode-title").fill("Draft to protect");
    await waitForDraft(E2E.userA.id, (s) => s.title === "Draft to protect");
    // Two-step: cancel keeps everything.
    await page.getByTestId("discard-draft").click();
    await expect(page.getByTestId("discard-confirm")).toBeVisible();
    await page.getByTestId("discard-cancel").click();
    await expect(page.getByTestId("episode-title")).toHaveValue("Draft to protect");
    // Confirm actually discards.
    await page.getByTestId("discard-draft").click();
    await page.getByTestId("discard-confirm").click();
    await expect(page.getByTestId("episode-title")).toHaveValue("");
  });

  test("switching to Automatic keeps manual picks and restores them on switch back", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId("mode-manual").click();
    await toTopics(page);
    await pick(page, T.lead); await pick(page, T.two);
    expect(await trayOrder(page)).toEqual([T.lead, T.two]);

    await page.getByTestId("step-show").click();
    await page.getByTestId("mode-automatic").click();
    await page.getByTestId("step-topics").click();
    // Picks are inactive (tray shows the automatic plan) but NOT deleted.
    await expect(page.getByTestId("kept-picks-note")).toContainText("2 picks kept");
    expect(await trayOrder(page)).toEqual([]);

    await page.getByTestId("step-show").click();
    await page.getByTestId("mode-manual").click();
    await page.getByTestId("step-topics").click();
    expect(await trayOrder(page)).toEqual([T.lead, T.two]);
    await page.getByTestId("discard-draft").click();
    await page.getByTestId("discard-confirm").click();
  });
});

test.describe("Studio rundown — Phase 2: honest controls", () => {
  test.beforeEach(({}, testInfo) => desktopOnly(testInfo.project.name));

  test("automatic creation posts NO lead topic (kept picks and lead both stripped)", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId("mode-manual").click();
    await toTopics(page);
    await pick(page, T.lead); await pick(page, T.two);
    await page.getByTestId(`tray-lead-${T.two}`).click(); // explicit lead
    await page.getByTestId("step-show").click();
    await page.getByTestId("mode-automatic").click();
    await page.getByTestId("step-topics").click();
    await page.getByTestId("pref-sport").selectOption("NFL");

    // Capture the create action's POST body.
    const bodies: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/studio/create")) bodies.push(req.postData() ?? "");
    });
    await page.getByTestId("step-review").click();
    await page.getByTestId("create-episode").click();
    await expect(page.getByTestId("result-final-order")).toBeVisible();
    const createBody = bodies.find((b) => b.includes('"mode":"automatic"')) ?? "";
    expect(createBody).toContain('"leadTopicId":null');
    expect(createBody).toContain('"selectedTopicIds":[]');
  });

  test("blocked format is visible, disabled, and says why; selectable big formats cap hosts at 2", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId("step-hosts").click();
    // three_person_panel (min 3 voices) is shown but not selectable.
    const panel = page.getByTestId("format-three_person_panel");
    await expect(panel).toBeVisible();
    await expect(panel).toBeDisabled();
    await expect(panel).toContainText(/3 voices — coming soon/i);
    // sports_radio (2-3 seats) IS selectable — and the host picker refuses a
    // 3rd seat, so "A show supports at most two hosts" is unreachable.
    await page.getByTestId("format-sports_radio").click();
    await expect(page.getByTestId("seat-cap-note")).toBeVisible();
    // Deterministically seat exactly [Ace, Blaze]. The picker's semantics:
    // clicking a pressed host toggles it OFF; adding beyond the cap REPLACES
    // the last seat — so order matters. Clear Coach first, then add.
    const coach = page.getByTestId(`host-${E2E.hostCoach}`);
    if ((await coach.getAttribute("aria-pressed")) === "true") await coach.click();
    await expect(coach).toHaveAttribute("aria-pressed", "false");
    for (const id of [E2E.hostAce, E2E.hostBlaze]) {
      const btn = page.getByTestId(`host-${id}`);
      if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
      await expect(btn).toHaveAttribute("aria-pressed", "true");
    }
    const pressed = page.locator('[data-testid^="host-"][aria-pressed="true"]');
    await expect(pressed).toHaveCount(2);
    // A third DISTINCT host may replace a seat but never grow the cast to 3 —
    // the "at most two hosts" server rejection is unreachable from here.
    await coach.click();
    await expect(pressed).toHaveCount(2);
    await expect(coach).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("discard-draft").click();
    await page.getByTestId("discard-confirm").click();
  });

  test("podcast episode shows the show's format read-only instead of a lying picker", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId(`podcast-${E2E.podcastId}`).click();
    await page.getByTestId("step-hosts").click();
    await expect(page.getByTestId("format-inherited")).toContainText(/this show uses/i);
    await expect(page.getByTestId("format-inherited")).toContainText(/show settings/i);
    // The standalone-only format radiogroup is gone for podcast episodes.
    await expect(page.getByTestId("format-two_host_debate")).toHaveCount(0);
    await page.getByTestId("discard-draft").click();
    await page.getByTestId("discard-confirm").click();
  });

  test("?topic= merges into an EXISTING draft, deep-links to Topics, and confirms", async ({ page }) => {
    await gotoCreate(page);
    // Build a draft first (the case main silently discards the seed in).
    await toTopics(page);
    await pick(page, T.lead);
    await waitForDraft(E2E.userA.id, (s) => s.selectedTopicIds.includes(T.lead));
    await page.goto(`/studio/create?topic=${T.two}`);
    await expect(page.getByTestId("seed-note")).toContainText("Added");
    // Deep-linked straight to the Topics step, seed merged with the draft.
    await expect(page.getByTestId("board-filter-note")).toBeVisible();
    expect(await trayOrder(page)).toEqual([T.lead, T.two]);
    await page.getByTestId("discard-draft").click();
    await page.getByTestId("discard-confirm").click();
  });

  test("an ineligible ?topic= is reported, never silently dropped", async ({ page }) => {
    await gotoCreate(page);
    await page.goto(`/studio/create?topic=${T.noEvidence}`);
    await expect(page.getByTestId("seed-note")).toContainText(/can't be added/i);
    expect(await trayOrder(page)).toEqual([]);
  });

  test("a pick that leaves the pool is dropped EXPLICITLY on show switch, with name and reason", async ({ page }) => {
    // NOTE: under the default TOPIC_REUSE_MODE="allow", recent use by a show
    // only WARNS (the pick stays eligible), so eligibility can't be flipped
    // that way here. Archival removes the topic from the pool entirely — the
    // same editorial event the admin spec exercises.
    const db = e2eDb();
    await gotoCreate(page);
    await toTopics(page);
    await pick(page, T.lead); await pick(page, T.three);
    expect(await trayOrder(page)).toEqual([T.lead, T.three]);
    // An editor archives the topic while the rundown is being built.
    await db.topicCandidate.update({ where: { id: T.three }, data: { status: "archived" } });
    try {
      // Switching shows refetches the pool → the reconcile must REPORT the drop
      // (main silently ghosts it: tray count and validator disagree, and the
      // stale id gets posted).
      await page.getByTestId("step-show").click();
      await page.getByTestId(`podcast-${E2E.podcastId}`).click();
      await expect(page.getByTestId("dropped-note")).toContainText(/no longer in the pool/i);
      await expect(page.getByTestId("dropped-note")).toContainText("Trade deadline: buyers or sellers?");
      await page.getByTestId("step-topics").click();
      expect(await trayOrder(page)).toEqual([T.lead]);
    } finally {
      await db.topicCandidate.update({ where: { id: T.three }, data: { status: "approved" } });
    }
    await page.getByTestId("discard-draft").click();
    await page.getByTestId("discard-confirm").click();
  });

  test("min-debate-score maps 0 to 'any' explicitly (no snap-back surprise)", async ({ page }) => {
    await gotoCreate(page);
    await page.getByTestId("mode-automatic").click();
    await page.getByTestId("step-topics").click();
    await page.getByTestId("pref-mindebate").fill("60");
    await expect(page.getByText("Min debate score: 60")).toBeVisible();
    await page.getByTestId("pref-mindebate").fill("0");
    await expect(page.getByText("Min debate score: any")).toBeVisible();
    await expect(page.getByTestId("pref-mindebate")).toHaveAttribute("aria-valuetext", "any");
    await page.getByTestId("discard-draft").click();
    await page.getByTestId("discard-confirm").click();
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
