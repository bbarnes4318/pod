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
// These tests assert the property that actually matters to a user — a control
// is the topmost element at its own centre — plus the one structural fact that
// property depends on, so neither a layout rewrite nor a page move can quietly
// take the guard away again. See the note in the describe block below.

import { test, expect } from "@playwright/test";

const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop-only flow");

test.describe("Fixed player bar never covers a primary action", () => {
  test.beforeEach(({}, testInfo) => desktopOnly(testInfo.project.name));

  // WHY THIS NO LONGER DRIVES THE PODCAST WIZARD. The wizard it used to walk
  // was rewritten into Show Forge (eight steps: Spark, Promise, World, Cast,
  // Episode DNA, Storylines, Schedule, Launch) and moved to /studio/shows/new.
  // Five of this test's selectors died with that move — the URL, the name
  // field's placeholder, the "Follow specific teams?" heading, button.uWizNext,
  // and the "How many segments" sentinel — and, decisively, the studio shell
  // renders no player bar at all (PlayerProvider lives only in
  // src/app/app/layout.tsx), so the collision it was written to catch cannot
  // happen on that page any more.
  //
  // The DEFECT is still reachable, though, because the mechanism is still here:
  // any /app page can be taller than the viewport, and the bar is still fixed
  // over the bottom of it. So this now tests the invariant directly rather than
  // through one page's click path — which also means it cannot rot the next
  // time a form is redesigned.

  test("the player bar's height is reserved by an IN-FLOW spacer, not padding", async ({ page }) => {
    // Any /app page will do: the bar is mounted by the layout and open by
    // default, and the spacer rule keys off .userSurface:has(.uPlayerBar).
    await page.goto("/app/episodes");
    await expect(page.locator(".uPlayerBar")).toBeVisible();

    const m = await page.evaluate(() => {
      const main = document.querySelector(".uMain") as HTMLElement | null;
      const bar = document.querySelector(".uPlayerBar") as HTMLElement | null;
      if (!main || !bar) return null;
      const after = getComputedStyle(main, "::after");
      return {
        // The reservation must come from a rendered ::after box...
        spacerContent: after.content,
        spacerDisplay: after.display,
        spacerHeight: parseFloat(after.height) || 0,
        barHeight: Math.round(bar.getBoundingClientRect().height),
      };
    });
    expect(m, ".uMain and .uPlayerBar must both exist").not.toBeNull();

    // ...not from padding-bottom on .uMain, which is what the original bug was:
    // .uMain is a stretched flex item of a min-height:100vh column, so its own
    // padding is laid out INSIDE that box and a taller column overflows straight
    // past it. The document's scroll height never grows, and the last control on
    // a long page ends up under the bar.
    expect(m!.spacerContent, "the spacer ::after must render").not.toBe("none");
    expect(m!.spacerDisplay).toBe("block");
    expect(
      m!.spacerHeight,
      `spacer reserves ${m!.spacerHeight}px but the bar is ${m!.barHeight}px tall`
    ).toBeGreaterThanOrEqual(m!.barHeight);
  });

  test("at maximum scroll, the last control on a long /app page is not under the bar", async ({ page }) => {
    await page.goto("/app/episodes");
    await expect(page.locator(".uPlayerBar")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);

    // The last interactive control in the main column, whatever it happens to
    // be — asserting the property a user feels, not a particular button.
    const last = page.locator(".uMain a, .uMain button").last();
    if ((await last.count()) === 0) test.skip(true, "no interactive control in the main column to probe");
    const sel = ".uMain a, .uMain button";
    const probe = await page.evaluate((s) => {
      const els = Array.from(document.querySelectorAll(s)) as HTMLElement[];
      const el = els.filter((e) => e.getBoundingClientRect().height > 0).pop();
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
    }, sel);

    expect(probe.found).toBe(true);
    expect(
      probe.found && probe.covered,
      `last control is covered by ${probe.found ? probe.hitEl : "?"} ` +
        `(${probe.found ? JSON.stringify(probe.rect) : ""}, viewport ${probe.found ? probe.viewportH : ""})`
    ).toBe(false);
  });
});
