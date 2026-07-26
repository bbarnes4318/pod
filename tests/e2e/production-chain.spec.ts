// D-01 — the customer must be able to move their own episode forward.
//
// The audit run died here. The production console told the customer:
//   "Nothing is voiced until you approve the draft — read it, edit any line,
//    then approve."
// and no control containing the word "approve" existed anywhere on the episode
// page. Enumerating every <button> and <a href> across all five tabs found only
// "Read the draft →" (href="#transcript", a scroll anchor), plus three links
// labelled "(ops)" under a heading reading "Advanced / ops shortcuts" — all
// pointing at /admin, which is behind HTTP Basic Auth and returned 401 onto a
// blank chrome error page with zero links.
//
// The episode was stranded at script_draft with a 90/100 script, one hour and
// one full Opus-5 generation into the run.
//
// This asserts the customer-facing half: a real, enabled control on the page
// they are actually sent to, which advances the episode. The chain that runs
// after it is covered by src/scripts/testProductionChain.ts.

import { test, expect } from "@playwright/test";
import { E2E } from "./seed";
import { e2eDb, episodeRow, closeE2eDb } from "./db";

test.afterAll(async () => { await closeE2eDb(); });

const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop-only flow");
const EP = () => `/studio/episodes/${E2E.episodeAwaitingApprovalId}`;

test.describe("Approval checkpoint — the customer can advance their episode", () => {
  test.beforeEach(({}, testInfo) => desktopOnly(testInfo.project.name));

  test("the episode page offers an enabled approve control, not only a scroll link", async ({ page }) => {
    await page.goto(EP());

    const cta = page.getByTestId("prod-approve-cta");
    await expect(cta, "the checkpoint must offer an approve control").toBeVisible();
    await expect(cta).toBeEnabled();

    // It must be a real control, not the old anchor that only scrolled.
    expect(await cta.evaluate((el) => el.tagName)).toBe("BUTTON");

    // And the customer must never be routed into the Basic-Auth ops console to
    // make progress. Any /admin link on this page must be an explicitly
    // disclosed extra, never the only way forward.
    const adminHrefs = await page.$$eval('a[href^="/admin"]', (els) => els.map((e) => e.getAttribute("href") || ""));
    const forwardControls = await page.getByTestId("prod-approve-cta").count();
    expect(forwardControls, `no in-studio forward control; only /admin links: ${adminHrefs.join(", ")}`).toBeGreaterThan(0);
  });

  test("approving advances the episode past the checkpoint", async ({ page }) => {
    const before = await episodeRow(E2E.episodeAwaitingApprovalId);
    expect(before?.status, "fixture must start at the checkpoint").toBe("script_draft");

    await page.goto(EP());
    await page.getByTestId("prod-approve-cta").click();

    // The gate's refusal, if any, must be on screen — never a silent no-op.
    // Surfacing it here makes a failure diagnosable instead of a timeout.
    const err = page.getByTestId("prod-approve-error");
    await expect
      .poll(
        async () => {
          if (await err.isVisible().catch(() => false)) return `GATE REFUSED: ${await err.innerText()}`;
          const row = await episodeRow(E2E.episodeAwaitingApprovalId);
          return row?.status ?? "missing";
        },
        { timeout: 60_000, message: "episode should leave script_draft after approval" }
      )
      .not.toBe("script_draft");

    const after = await episodeRow(E2E.episodeAwaitingApprovalId);
    expect(after?.status).toBe("script_approved");

    // The script itself must be marked approved — that is what unlocks voicing.
    const db = e2eDb();
    const script = await db.script.findFirst({
      where: { episodeId: E2E.episodeAwaitingApprovalId },
      orderBy: { version: "desc" },
      select: { status: true },
    });
    expect(script?.status).toBe("approved");
  });
});
