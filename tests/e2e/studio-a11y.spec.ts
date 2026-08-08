// Accessibility floor for every Studio route.
//
// Scoped to `serious` and `critical` only — deliberately. A zero-violation
// bar across all four impact levels turns into noise that gets suppressed, and
// a suppressed a11y suite protects nobody. These two levels are the ones that
// stop somebody using the product: unlabelled controls, contrast failures,
// keyboard traps, broken landmark/heading structure.
//
// Requires @axe-core/playwright (devDependency — it runs only here, never in
// the app bundle).

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { E2E } from "./seed";

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

test.describe("Studio accessibility floor", () => {
  for (const route of ROUTES) {
    test(`${route.name}: no serious or critical axe violations`, async ({ page }) => {
      await page.goto(route.url, { waitUntil: "domcontentloaded" });
      await page.locator(".studioShell").waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForTimeout(600);

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");

      // Name the offending element, not just the rule — a rule id alone sends
      // the next person hunting through the page for it.
      const detail = blocking
        .map((v) => `${v.impact?.toUpperCase()}  ${v.id}: ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`)
        .join("\n");

      expect(blocking, `${route.name} has ${blocking.length} blocking violation(s):\n${detail}`).toEqual([]);
    });
  }

  test("the document has exactly one h1, and it names the page", async ({ page }) => {
    await page.goto("/studio/create", { waitUntil: "domcontentloaded" });
    await page.locator(".studioShell").waitFor({ state: "visible" });
    // StudioPageHeader emits the real h1 (visually hidden) while the topbar
    // shows a styled <div>, so the heading outline stays correct.
    const h1s = page.locator("h1");
    await expect(h1s).toHaveCount(1);
    await expect(h1s.first()).toHaveText("Create an episode");
  });

  test("every interactive control in the shell takes a visible focus ring", async ({ page }) => {
    await page.goto("/studio", { waitUntil: "domcontentloaded" });
    await page.locator(".studioShell").waitFor({ state: "visible" });

    // `style={{ all: "unset" }}` on the create-flow step buttons removed focus
    // visibility entirely. Any control whose focus state is indistinguishable
    // from its resting state is a keyboard dead end.
    //
    // The focus must be driven by a REAL Tab press. `element.focus()` does not
    // reliably match :focus-visible, so a programmatic version of this test
    // reports every styled control as a failure.
    const invisible: string[] = [];
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const probe = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        const ring =
          (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) ||
          (s.boxShadow !== "none" && s.boxShadow !== "");
        return { ring, id: el.className?.toString() || el.tagName };
      });
      if (probe && !probe.ring) invisible.push(probe.id);
    }
    expect(
      Array.from(new Set(invisible)),
      `Controls with no visible focus ring after a real Tab press:\n${invisible.join("\n")}`
    ).toEqual([]);
  });
});
