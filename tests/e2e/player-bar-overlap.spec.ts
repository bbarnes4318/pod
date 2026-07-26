// D-03 — the fixed player bar must never cover a page's primary action.
//
// The production failure: on the podcast wizard's TEAMS step the player bar
// (position:fixed, bottom:0, 72px tall) sat directly on top of the only forward
// button. Measured at a 1400x950 viewport, scrolled to the very end of the
// document: bar 878-950, button 879-918, and
// document.elementFromPoint(button centre) returned DIV.uPlayerBar. The click
// could not land, so a new customer could not create a podcast at all.
//
// The reservation rule existed but did not work. `.uMain` is a stretched flex
// item of `.userSurface` (min-height:100vh; display:flex), so its
// padding-bottom is laid out INSIDE its 100vh box — a taller column overflows
// straight past the padding and the document's scroll height never grows by it.
// Computed padding-bottom really was 132px while only 32px of space existed
// below the button. The fix is an in-flow ::after spacer, which is part of the
// column's content and therefore always extends the scrollable area.
//
// This test asserts the property that actually matters to a user — "the button
// is the topmost element at its own centre" — rather than any particular CSS
// mechanism, so a future layout rewrite is still covered.

import { test, expect, type Page } from "@playwright/test";

const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop-only flow");

/** Is `selector` the element actually hit at its own centre point? */
async function hitTest(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return { found: false as const };
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      found: true as const,
      covered: !(hit === el || el.contains(hit)),
      hitEl: hit ? `${hit.tagName}.${(hit as HTMLElement).className}`.slice(0, 80) : null,
      rect: { top: Math.round(r.top), bottom: Math.round(r.bottom) },
      viewportH: window.innerHeight,
    };
  }, selector);
}

test.describe("Fixed player bar never covers a primary action", () => {
  test.beforeEach(({}, testInfo) => desktopOnly(testInfo.project.name));

  test("podcast wizard: the forward button is clickable on the long TEAMS step", async ({ page }) => {
    await page.goto("/app/podcasts/new");

    // NAME -> VERTICALS
    await page.locator('input[placeholder*="Monday Night"]').fill("Overlap Probe");
    await page.getByRole("button", { name: /^Next/ }).first().click();

    // Pick two verticals so the TEAMS step renders a long (scrolling) list —
    // the overlap only appeared once the page was taller than the viewport.
    await page.getByText("NFL", { exact: true }).first().click();
    await page.getByText("NBA", { exact: true }).first().click();
    await page.getByRole("button", { name: /^Next/ }).first().click();

    await expect(page.getByText("Follow specific teams?")).toBeVisible();
    // The player bar must actually be mounted, or this proves nothing.
    await expect(page.locator(".uPlayerBar")).toBeVisible();

    // Scroll to the very end, exactly as a customer hunting for the button would.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);

    const probe = await hitTest(page, "button.uWizNext");
    expect(probe.found).toBe(true);
    expect(
      probe.covered,
      `wizard button is covered by ${probe.hitEl} (button ${JSON.stringify(probe.rect)}, viewport ${probe.viewportH})`
    ).toBe(false);

    // The property under test is that the click LANDS. A short timeout keeps a
    // regression as a fast failure rather than a 30s hang.
    await page.locator("button.uWizNext").click({ timeout: 5000 });
    await expect(page.getByText(/How many segments/i)).toBeVisible();
  });
});
