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

      // "Interactive" means something the user can act on INSIDE the page —
      // the shell's own nav/Generate/account would trivially satisfy the
      // budget and prove nothing, so they are excluded.
      const y = await page.evaluate(() => {
        const main = document.querySelector("main.studioMain");
        if (!main) return null;
        const candidates = main.querySelectorAll<HTMLElement>(
          "a[href], button, input, select, textarea, [role='button'], [role='tab'], [tabindex]:not([tabindex='-1'])"
        );
        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const visible =
            rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          if (visible) return rect.top;
        }
        return null;
      });

      // A route with no in-page control at all (a pure empty state with no
      // call to action) is a different defect; it is reported, not silently
      // passed.
      expect(y, `${route.name} rendered no interactive control inside main.studioMain`).not.toBeNull();
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
