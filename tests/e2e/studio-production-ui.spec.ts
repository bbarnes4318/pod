import { expect, test } from "@playwright/test";

const ROUTES = [
  "/studio",
  "/studio/shows",
  "/studio/shows/new",
  "/studio/create",
  "/studio/episodes",
  "/studio/takes",
  "/studio/hosts",
  "/studio/publish",
  "/studio/analytics",
  "/studio/plan",
  "/studio/settings",
];

async function assertOverflowContract(page: import("@playwright/test").Page) {
  const horizontal = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  expect(horizontal, "document has horizontal overflow").toBe(true);
  const offenders = await page.locator("*").evaluateAll(elements => elements.filter(element => {
    if (element.hasAttribute("data-scroll-allow")) return false;
    if (["TEXTAREA", "SELECT"].includes(element.tagName)) return false;
    if (element.getAttribute("role") === "dialog") return false;
    const style = window.getComputedStyle(element);
    const scrollableY = ["auto", "scroll"].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 2;
    return scrollableY;
  }).map(element => ({ tag: element.tagName, id: element.id, className: typeof element.className === "string" ? element.className : "" })));
  expect(offenders, `unexpected nested vertical scroll regions: ${JSON.stringify(offenders)}`).toEqual([]);
}

test.describe("production Studio shell", () => {
  for (const route of ROUTES) {
    test(`${route} renders without overflow`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator("main.studioMain")).toBeVisible();
      await expect(page.locator("h1")).toBeVisible();
      await assertOverflowContract(page);
    });
  }

  test("sidebar collapse persists on desktop", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await page.goto("/studio");
    const shell = page.locator(".studioShell");
    const toggle = page.getByRole("button", { name: "Collapse navigation" });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(shell).toHaveAttribute("data-collapsed", "true");
    await page.reload();
    await expect(shell).toHaveAttribute("data-collapsed", "true");
    await page.getByRole("button", { name: "Expand navigation" }).click();
  });

  test("mobile drawer traps the task and closes with Escape", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile");
    await page.goto("/studio");
    const open = page.getByRole("button", { name: "Open navigation" });
    await open.click();
    await expect(page.locator(".studioShell")).toHaveAttribute("data-mobile-open", "true");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".studioShell")).toHaveAttribute("data-mobile-open", "false");
  });

  test("account menu is keyboard accessible", async ({ page }) => {
    await page.goto("/studio");
    const account = page.locator(".studioAccountBtn");
    await account.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(account).toBeFocused();
  });

  test("mobile operational pages use cards instead of a wide table", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile");
    for (const route of ["/studio/episodes", "/studio/takes", "/studio/publish"]) {
      await page.goto(route);
      await expect(page.locator("table")).toBeHidden();
      await assertOverflowContract(page);
    }
  });

  test("Show Forge exposes one focused workspace and live summary", async ({ page }) => {
    await page.goto("/studio/shows/new");
    await expect(page.getByRole("heading", { name: "Build a show" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Show Forge steps" })).toBeVisible();
    await expect(page.getByText("Live summary")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
  });
});
