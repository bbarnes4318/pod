// The chrome budget, enforced by measurement rather than by intention.
//
// Every Studio route used to spend roughly 194px before the first control:
// a 60px topbar carrying no page context, 36px of main padding, a 2.4rem
// uppercase .pageTitle, and a .pageSub with a 2rem margin below it. On a
// 1440x900 screen that pushed the actual work below the fold on most routes.
//
// These assertions are deliberately about geometry, not markup: they would
// still catch a regression that reintroduced the cost through a different
// element.

import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./seed";

/** The first control budget, in CSS pixels from the top of the viewport. */
const FIRST_CONTROL_MAX_Y = 160;

const ROUTES: { name: string; url: string }[] = [
  { name: "The Board", url: "/studio" },
  { name: "Shows", url: "/studio/shows" },
  { name: "Show detail", url: `/studio/shows/${E2E.podcastId}` },
  { name: "New show", url: "/studio/shows/new" },
  { name: "Create", url: "/studio/create" },
  { name: "Episodes", url: "/studio/episodes" },
  { name: "Episode detail", url: `/studio/episodes/${E2E.episodeAwaitingApprovalId}` },
  { name: "Takes", url: "/studio/takes" },
  { name: "Hosts", url: "/studio/hosts" },
  { name: "Auditions", url: "/studio/auditions" },
  { name: "Audio", url: "/studio/audio" },
  { name: "Publish", url: "/studio/publish" },
  { name: "Analytics", url: "/studio/analytics" },
  { name: "Plan", url: "/studio/plan" },
  { name: "Settings", url: "/studio/settings" },
];

async function gotoStudio(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(".studioShell").waitFor({ state: "visible", timeout: 30_000 });
  // The page header is set from the page during hydration; wait for the shell
  // to be interactive so the measurement reflects the settled layout.
  await page.locator(".studioTopbar").waitFor({ state: "visible" });
  await page.waitForTimeout(400);
}

test.describe("Studio chrome budget", () => {
  for (const route of ROUTES) {
    test(`${route.name}: first interactive control is within ${FIRST_CONTROL_MAX_Y}px of the top`, async ({ page }) => {
      await gotoStudio(page, route.url);

      // The question this measures is "how far must the user travel before
      // they can DO something", so the roots are everything the PAGE owns:
      // its body, plus the two chrome slots a page publishes into through
      // <StudioPageHeader actions/status>. The shell's own furniture — nav,
      // brand, the global Generate button, the account menu — is persistent
      // across every route and would satisfy the budget everywhere while
      // proving nothing, so it stays excluded.
      //
      // The first version of this looked only inside main.studioMain, which
      // was wrong the moment Part 1 moved page actions into the topbar: on
      // Show detail the page's own "Generate an episode" sits at y≈20 and the
      // test could not see it, so the route was reported as 400px over budget
      // while the primary action was in fact the first thing on the screen.
      // Five routes were mismeasured that way. Note this does NOT excuse the
      // rest: a page with no early control still fails, which is why Episode
      // detail, Episodes, New show, Plan, Settings and Publish are not fixed
      // by this change.
      //
      // Lowest y wins rather than first-in-DOM: a control the user can reach
      // is a control the user can reach, wherever it sits in source order.
      const y = await page.evaluate(() => {
        const roots = [
          document.querySelector("main.studioMain"),
          document.getElementById("studio-topbar-actions"),
          document.getElementById("studio-subbar-status"),
        ].filter(Boolean) as HTMLElement[];
        if (roots.length === 0) return null;
        const SELECTOR =
          "a[href], button, input, select, textarea, [role='button'], [role='tab'], [tabindex]:not([tabindex='-1'])";
        let best: number | null = null;
        for (const root of roots) {
          for (const el of root.querySelectorAll<HTMLElement>(SELECTOR)) {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const visible =
              rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
            if (visible && (best === null || rect.top < best)) best = rect.top;
          }
        }
        return best;
      });

      // A route with no page-owned control at all (a pure empty state with no
      // call to action) is a different defect; it is reported, not silently
      // passed.
      expect(y, `${route.name} rendered no interactive control the page owns`).not.toBeNull();
      expect(
        y as number,
        `${route.name}: first control sits ${Math.round(y as number)}px down. Budget is ${FIRST_CONTROL_MAX_Y}px.`
      ).toBeLessThanOrEqual(FIRST_CONTROL_MAX_Y);
    });
  }

  test("the chrome bands are exactly the budgeted heights", async ({ page }) => {
    await gotoStudio(page, "/studio");
    const isMobile = (page.viewportSize()?.width ?? 1440) <= 720;

    const topbar = await page.locator(".studioTopbar").boundingBox();
    expect(topbar).toBeTruthy();
    expect(Math.round(topbar!.height)).toBe(isMobile ? 52 : 56);

    const subbar = await page.locator(".studioSubbar").boundingBox();
    expect(subbar).toBeTruthy();
    expect(Math.round(subbar!.height)).toBe(isMobile ? 28 : 32);
  });

  test("no studio card spends more than 32px of vertical padding", async ({ page }) => {
    await gotoStudio(page, "/studio");
    const fat = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll<HTMLElement>("main.studioMain section, main.studioMain .studioCard").forEach((el) => {
        const s = getComputedStyle(el);
        const top = parseFloat(s.paddingTop);
        const bottom = parseFloat(s.paddingBottom);
        if (top > 32 || bottom > 32) out.push(`${el.className || el.tagName}: ${top}px / ${bottom}px`);
      });
      return out;
    });
    expect(fat, `Cards over the 32px vertical padding ceiling:\n${fat.join("\n")}`).toEqual([]);
  });

  test("nothing scrolls horizontally", async ({ page }) => {
    await gotoStudio(page, "/studio/create");
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
    }));
    expect(
      overflow.doc,
      `Document scrolls horizontally: ${overflow.doc}px of content in a ${overflow.win}px viewport.`
    ).toBeLessThanOrEqual(overflow.win + 1);
  });
});
