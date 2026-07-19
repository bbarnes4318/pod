// Admin system-default variant pools + cue-metadata editor (PR 2 review).
// DB-only + UI, ordinary interactions (no force/dispatchEvent). Basic-Auth /admin.

import { test, expect, type Page } from "@playwright/test";
import { e2eDb, closeE2eDb } from "./db";
import { E2E } from "./seed";

const desktopOnly = (t: { project: { name: string } }) => t.project.name === "desktop";

async function seedSharedAssets() {
  const db = e2eDb();
  const mk = (id: string, kind: string, name: string) =>
    db.audioAsset.upsert({
      where: { id }, update: {},
      create: { id, name, kind, tags: [], audioUrl: `http://sys.test/${id}`, license: "x", scope: "shared_system", processingStatus: "ready", isActive: true, licenseStatus: "licensed", rightsStatus: "not_required" },
    });
  await mk("sys-intro-a", "theme_intro", "Sys Intro A");
  await mk("sys-intro-b", "theme_intro", "Sys Intro B");
  await mk("sys-outro-a", "theme_outro", "Sys Outro A");
  await mk("sys-bed-a", "bed", "Sys Bed A");
}

async function gotoAdmin(page: Page) {
  await page.goto("/admin/sound-design");
  await expect(page.getByTestId("system-sound-pools")).toBeVisible();
}

test.afterAll(async () => { await closeE2eDb(); });

// ---- Authorization (no credentials) ---------------------------------------
test.describe("Admin system sound — authorization", () => {
  test("Blocker 2 #16 / Blocker 3 #1-2: an unauthenticated caller is rejected (401)", async ({ baseURL }) => {
    const res = await fetch(`${baseURL}/admin/sound-design`); // no Basic-Auth header
    expect(res.status).toBe(401);
  });
});

// ---- Admin-authenticated ---------------------------------------------------
test.describe("Admin system sound — authenticated", () => {
  test.use({ httpCredentials: { username: E2E.admin.username, password: E2E.admin.password } });

  test("system pools + metadata editor render", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await seedSharedAssets();
    await gotoAdmin(page);
    for (const id of ["sys-pool-intro", "sys-pool-outro", "sys-pool-bed", "sys-pool-stinger", "sys-pool-reaction"]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await expect(page.getByTestId("cue-metadata-editor")).toBeVisible();
  });

  test("B2: admin configures two system intro variants + saves (persisted)", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await seedSharedAssets();
    await e2eDb().systemSoundAssignment.deleteMany({ where: { configId: "default" } });
    await gotoAdmin(page);
    await page.getByTestId("sys-pool-intro-add").selectOption("sys-intro-a");
    await page.getByTestId("sys-pool-intro-add").selectOption("sys-intro-b");
    await page.getByTestId("sys-pool-outro-add").selectOption("sys-outro-a");
    await page.getByTestId("sys-save").click(); // ordinary click; sticky footer clears any overlay
    await expect(page.getByTestId("sys-status")).toContainText(/saved/i, { timeout: 15000 });
    const count = await e2eDb().systemSoundAssignment.count({ where: { configId: "default", role: "intro" } });
    expect(count).toBe(2);
  });

  test("B2: preview system resolution shows examples without creating episodes", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await seedSharedAssets();
    await gotoAdmin(page);
    const before = await e2eDb().episode.count();
    await page.getByTestId("sys-preview").click();
    await expect(page.getByTestId("sys-preview-examples")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("sys-preview-example-0")).toBeVisible();
    expect(await e2eDb().episode.count()).toBe(before);
  });

  test("B3 #3-7,12: admin edits metadata, marks verified/suggested; state persists + reloads", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await seedSharedAssets();
    await gotoAdmin(page);
    // Edit + mark VERIFIED.
    await page.getByTestId("meta-genre-sys-intro-a").fill("sports");
    await page.getByTestId("meta-family-sys-intro-a").selectOption("brand_high_energy");
    await page.getByTestId("meta-state-sys-intro-a").selectOption("verified");
    await page.getByTestId("meta-save-sys-intro-a").click();
    await expect(page.getByTestId("sys-status")).toContainText(/metadata saved/i, { timeout: 15000 });
    // Another asset stays UNCLASSIFIED by default; mark SUGGESTED (not verified).
    await page.getByTestId("meta-state-sys-outro-a").selectOption("suggested");
    await page.getByTestId("meta-save-sys-outro-a").click();
    await expect(page.getByTestId("sys-status")).toContainText(/metadata saved/i, { timeout: 15000 });
    // Persistence: verified is authoritative; suggested is NOT; unclassified stays.
    const db = e2eDb();
    const a = await db.audioAsset.findUnique({ where: { id: "sys-intro-a" }, select: { metadataState: true, cueMetadata: true } });
    expect(a?.metadataState).toBe("verified");
    expect((a?.cueMetadata as { genre?: string } | null)?.genre).toBe("sports");
    const o = await db.audioAsset.findUnique({ where: { id: "sys-outro-a" }, select: { metadataState: true } });
    expect(o?.metadataState).toBe("suggested");
    const b = await db.audioAsset.findUnique({ where: { id: "sys-bed-a" }, select: { metadataState: true } });
    expect(b?.metadataState).toBe("unclassified");
    // Reload shows the saved values.
    await gotoAdmin(page);
    await expect(page.getByTestId("meta-state-sys-intro-a")).toHaveValue("verified");
    await expect(page.getByTestId("meta-genre-sys-intro-a")).toHaveValue("sports");
  });

  test("B3 #8: the cue-family dropdown is role-scoped (invalid family/kind not offerable)", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await seedSharedAssets();
    await gotoAdmin(page);
    // A theme_intro asset offers intro families, never reaction/transition ones.
    const opts = await page.getByTestId("meta-family-sys-intro-a").locator("option").allInnerTexts();
    expect(opts).toContain("brand_main");
    expect(opts).not.toContain("crowd_positive"); // reaction family
    expect(opts).not.toContain("hard_hit");       // transition family
  });

  test("B3 #9-11: no storage URLs, keys, or rights-doc references reach the admin HTML", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await seedSharedAssets();
    await gotoAdmin(page);
    const html = await page.content();
    expect(html).not.toContain("sys.test");
    expect(html).not.toMatch(/https?:\/\/[^"'\s]*\.(mp3|wav)/i);
    expect(html).not.toContain("rightsDocumentStorageKey");
  });
});
