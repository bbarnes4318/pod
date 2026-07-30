import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./seed";
import { e2eDb, closeE2eDb } from "./db";
import { EPISODE_CONFIGURATION_SNAPSHOT_VERSION_BASE } from "../../src/lib/services/episodeConfigurationSnapshot";

// Browser proof for the show-format engine in the real Studio UI. The format
// picker offers every generation-ready format; picking SOLO creates an episode
// whose formatId, normalized cast row, and current immutable base snapshot are
// all frozen correctly. No LLM/TTS/network calls are made.

const desktopOnly = (t: { project: { name: string } }) => t.project.name === "desktop";
test.afterAll(async () => { await closeE2eDb(); });

async function gotoCreate(page: Page) {
  await page.goto("/studio/create");
  const discard = page.getByTestId("discard-draft");
  if (await discard.isVisible().catch(() => false)) {
    await discard.click();
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  await expect(page.getByTestId("mode-manual")).toBeVisible({ timeout: 60_000 });
}

test.describe("Show-format engine in the browser", () => {
  test("CORE: solo format freezes format, one cast row, and the current snapshot cast", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    const db = e2eDb();

    await gotoCreate(page);
    await page.getByTestId("mode-manual").click();
    await page.getByTestId("step-topics").click();
    await expect(page.getByTestId("board-filter-note")).toBeVisible();
    await page.locator('[data-testid^="pick-"]:not([disabled])').first().check();

    await page.getByTestId("step-hosts").click();
    for (const format of ["solo_commentary", "two_host_debate", "sports_radio", "news_roundup", "host_and_expert", "three_person_panel", "interview", "documentary", "betting_desk", "rapid_fire"]) {
      await expect(page.getByTestId(`format-${format}`)).toBeVisible();
    }
    await page.getByTestId("format-solo_commentary").click();
    await expect(page.getByTestId("format-solo_briefing")).toHaveCount(0);
    await expect(page.getByTestId("format-roundtable")).toHaveCount(0);

    const hostButtons = page.locator('[data-testid^="host-"]');
    const count = await hostButtons.count();
    expect(count).toBeGreaterThanOrEqual(1);
    await hostButtons.first().click();
    const pressed = page.locator('[data-testid^="host-"][aria-pressed="true"]');
    if ((await pressed.count()) === 0) await hostButtons.first().click();
    await expect(pressed).toHaveCount(1);
    const soloHostTestId = await pressed.first().getAttribute("data-testid");
    const soloHostId = soloHostTestId!.replace(/^host-/, "");

    await page.getByTestId("step-review").click();
    await page.getByTestId("create-episode").click();
    await expect(page.getByTestId("create-result").or(page.locator('[data-testid^="final-"]').first())).toBeVisible({ timeout: 60_000 });

    const episode = await db.episode.findFirst({ where: { ownerId: E2E.userA.id }, orderBy: { createdAt: "desc" }, include: { castMembers: true } });
    expect(episode, "episode created").toBeTruthy();
    expect(episode!.formatId).toBe("solo_commentary");
    expect(episode!.hostIds).toEqual([soloHostId]);
    expect(episode!.castMembers.length).toBe(1);
    expect(episode!.castMembers[0].role).toBe("anchor");
    expect(episode!.castMembers[0].orderIndex).toBe(0);
    const snapshot = episode!.configurationSnapshot as { version?: number; cast?: { formatId: string; members: Array<{ role: string }> } } | null;
    expect(snapshot?.version).toBe(EPISODE_CONFIGURATION_SNAPSHOT_VERSION_BASE);
    expect(snapshot?.cast?.formatId).toBe("solo_commentary");
    expect(snapshot?.cast?.members?.[0]?.role).toBe("anchor");
  });

  test("the default flow still creates a two-host debate", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    const db = e2eDb();
    await gotoCreate(page);
    await page.getByTestId("mode-manual").click();
    await page.getByTestId("step-topics").click();
    await expect(page.getByTestId("board-filter-note")).toBeVisible();
    await page.locator('[data-testid^="pick-"]:not([disabled])').first().check();
    await page.getByTestId("step-review").click();
    await page.getByTestId("create-episode").click();
    await expect(page.getByTestId("create-result").or(page.locator('[data-testid^="final-"]').first())).toBeVisible({ timeout: 60_000 });

    const episode = await db.episode.findFirst({ where: { ownerId: E2E.userA.id }, orderBy: { createdAt: "desc" }, include: { castMembers: true } });
    expect(episode!.formatId).toBe("two_host_debate");
    expect(episode!.castMembers.length).toBe(2);
    expect(episode!.castMembers.map(member => member.role).sort().join(",")).toBe("chair_a,chair_b");
  });
});
