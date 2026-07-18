import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./seed";
import { e2eDb, closeE2eDb } from "./db";

// Prompt 7 browser proof: the show-format engine in the real Studio UI.
//   The format picker offers every generation-ready format; picking SOLO
//   creates an episode whose formatId, normalized cast row, and snapshot-v3
//   cast are all frozen correctly; the default remains the two-host debate.
// No LLM/TTS/network — episode creation is the same DB-only path the
// existing studio-rundown spec exercises.

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
  test("CORE: solo format -> episode with formatId, one cast row, snapshot v3 cast", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    const db = e2eDb();

    await gotoCreate(page);
    // Manual mode with one topic so creation succeeds.
    await page.getByTestId("mode-manual").click();
    await page.getByTestId("step-topics").click();
    await expect(page.getByTestId("board-filter-note")).toBeVisible();
    const firstPick = page.locator('[data-testid^="pick-"]:not([disabled])').first();
    await firstPick.check();

    // Format & hosts step: every ready format is offered; pick SOLO.
    await page.getByTestId("step-hosts").click();
    for (const f of ["solo_commentary", "two_host_debate", "sports_radio", "news_roundup", "host_and_expert", "three_person_panel", "interview", "documentary", "betting_desk", "rapid_fire"]) {
      await expect(page.getByTestId(`format-${f}`)).toBeVisible();
    }
    await page.getByTestId("format-solo_commentary").click();
    // Deprecated aliases never appear as separate options:
    await expect(page.getByTestId("format-solo_briefing")).toHaveCount(0);
    await expect(page.getByTestId("format-roundtable")).toHaveCount(0);

    // The picker caps at ONE seat for solo: picking a second replaces seat 1.
    const hostButtons = page.locator('[data-testid^="host-"]');
    const count = await hostButtons.count();
    expect(count).toBeGreaterThanOrEqual(1);
    await hostButtons.first().click(); // may toggle the default selection…
    // Deterministically select exactly the first host:
    const pressed = page.locator('[data-testid^="host-"][aria-pressed="true"]');
    if ((await pressed.count()) === 0) await hostButtons.first().click();
    await expect(pressed).toHaveCount(1);
    const soloHostTestId = await pressed.first().getAttribute("data-testid");
    const soloHostId = soloHostTestId!.replace(/^host-/, "");

    // Create (the button lives on the review step).
    await page.getByTestId("step-review").click();
    await page.getByTestId("create-episode").click();
    await expect(page.getByTestId("create-result").or(page.locator('[data-testid^="final-"]').first())).toBeVisible({ timeout: 60_000 });

    // Newest episode for user A carries the solo format end to end.
    const ep = await db.episode.findFirst({ where: { ownerId: E2E.userA.id }, orderBy: { createdAt: "desc" }, include: { castMembers: true } });
    expect(ep, "episode created").toBeTruthy();
    expect(ep!.formatId).toBe("solo_commentary");
    expect(ep!.hostIds).toEqual([soloHostId]);
    expect(ep!.castMembers.length).toBe(1);
    expect(ep!.castMembers[0].role).toBe("anchor");
    expect(ep!.castMembers[0].orderIndex).toBe(0);
    const snap = ep!.configurationSnapshot as { version?: number; cast?: { formatId: string; members: Array<{ role: string }> } } | null;
    expect(snap?.version).toBe(3);
    expect(snap?.cast?.formatId).toBe("solo_commentary");
    expect(snap?.cast?.members?.[0]?.role).toBe("anchor");
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

    const ep = await db.episode.findFirst({ where: { ownerId: E2E.userA.id }, orderBy: { createdAt: "desc" }, include: { castMembers: true } });
    expect(ep!.formatId).toBe("two_host_debate");
    expect(ep!.castMembers.length).toBe(2);
    expect(ep!.castMembers.map((c) => c.role).sort().join(",")).toBe("chair_a,chair_b");
  });
});
