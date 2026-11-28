/* eslint-disable @typescript-eslint/no-explicit-any -- e2e fixtures use loose payloads */
// Release integrity in the browser: what the Publishing page and the episode's
// Release panel SHOW for an episode whose recordings still match its script,
// and for one whose script was edited after it was voiced and mixed.
//
// The fixtures are added by THIS spec (not the shared seed). No audio is voiced
// or mixed: the scene and render rows are written here with the same provenance
// helpers the voicing and mixing services call. The gate itself, the pages and
// the Publish button are the real ones.
//
// Screenshots (docs/ux-audit/release-integrity/) are written only with
// RELEASE_SHOTS=1, so an ordinary run does not touch the repository:
//
//   RELEASE_SHOTS=1 npx playwright test tests/e2e/release-integrity.spec.ts --trace off

import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { E2E } from "./seed";
import { e2eDb, closeE2eDb } from "./db";
import { buildMasterProvenance, checkedLineHashes, sceneProvenance, scriptTurns } from "../../src/lib/services/artifactProvenance";

const OUT = path.join(process.cwd(), "docs", "ux-audit", "release-integrity");
const SHOTS = process.env.RELEASE_SHOTS === "1";

const LABELS = [
  "Fact check covers the current script, no open claims",
  "Recorded audio matches the script",
  "Final mix made from the current script and recordings",
];

const RI = { current: "ri-ep-current", stale: "ri-ep-stale" };
const TITLES: Record<string, string> = {
  [RI.current]: "Release check: everything current",
  [RI.stale]: "Release check: edited after recording",
};
/** One per Playwright project: publishing changes the row, so each width gets its own. */
const publishableId = (project: string) => `ri-ep-publishable-${project}`;

function content(line1 = "They won twelve of their last fifteen.") {
  const L = (lineIndex: number, text: string, extra: any = {}) => ({
    lineIndex, speakerHostId: lineIndex % 2 === 0 ? E2E.hostAce : E2E.hostBlaze, speakerName: lineIndex % 2 === 0 ? "Ace" : "Blaze",
    text, tone: "neutral", isFactualClaim: false, needsHumanReview: false, evidenceRefs: [], ...extra,
  });
  return {
    segments: [
      { type: "cold_open", title: "Open", lines: [L(0, "Welcome back to the show."), L(1, line1, { isFactualClaim: true, evidenceRefs: [{ type: "research", id: "research-1" }] })] },
      { type: "debate", title: "Close", lines: [L(2, "That schedule was soft."), L(3, "See you Sunday.")] },
    ],
  };
}

/** An approved, fact-checked, scene-voiced and mixed episode. With `editedLine1`
 *  the script is then changed, exactly as an editor's line edit leaves it. */
async function seedEpisode(id: string, status: string, editedLine1?: string) {
  const db = e2eDb();
  await db.episode.deleteMany({ where: { id } });
  const original = content();
  const audioUrl = `https://example.invalid/${id}/final-v1.mp3`;
  await db.episode.create({
    data: {
      id, title: TITLES[id] ?? "Release check: publish me", slug: id, status, ownerId: E2E.userA.id, podcastId: E2E.podcastId, hostIds: [E2E.hostAce, E2E.hostBlaze],
      description: "Fixture episode for the release integrity check.", rssSummary: "Fixture episode.",
      longShowNotes: "Show notes for the release integrity fixture episode.", durationSeconds: 120, audioUrl,
      transcriptUrl: `https://example.invalid/${id}/transcript.txt`, audioFileSizeBytes: 1_234_567, audioMimeType: "audio/mpeg",
      ttsRenderMode: "scene", rssGuid: status === "content_ready" ? null : `ri-guid-${id}`,
    } as any,
  });
  const script = await db.script.create({ data: { episodeId: id, version: 1, status: "approved", content: original as any } });
  await db.factCheckResult.create({
    data: { scriptId: script.id, episodeId: id, passed: true, status: "passed", warnings: [], errors: [], issues: {}, summary: { totalErrors: 0, checkedLines: checkedLineHashes(original) } },
  });
  const turns = scriptTurns(original);
  const scenes = [];
  for (const [sceneIndex, lineIndexes] of [[0, [0, 1]], [1, [2, 3]]] as [number, number[]][]) {
    scenes.push(await db.dialogueSceneAudio.create({
      data: {
        episodeId: id, scriptId: script.id, sceneIndex, sceneType: "conversation", firstLineIndex: lineIndexes[0], lastLineIndex: lineIndexes[1], lineIndexes,
        provider: "stub", model: "fixture", renderUnit: "multi_speaker_scene", voiceMap: { [E2E.hostAce]: "v", [E2E.hostBlaze]: "v" },
        requestFingerprint: `ri-${id}-${sceneIndex}`, status: "ready", selected: true, audioUrl: `https://example.invalid/${id}/scene-${sceneIndex}.mp3`, durationMs: 4000,
        providerMetadata: { endpoint: "fixture", provenance: sceneProvenance(turns.filter((t) => lineIndexes.includes(t.lineIndex))) },
      },
    }));
  }
  await db.episodeAudioRender.create({
    data: {
      episodeId: id, scriptId: script.id, renderVersion: 1, status: "succeeded", renderMode: "initial", outputAudioUrl: audioUrl, completedAt: new Date(),
      diagnostics: { cues: [], provenance: buildMasterProvenance(script.id, original, { scenes }) } as any,
    },
  });
  if (editedLine1) {
    const edited = content(editedLine1);
    (edited.segments[0].lines[1] as any).dirty = true;
    await db.script.update({ where: { id: script.id }, data: { content: edited as any } });
  }
}

async function settle(page: Page) {
  await page.locator(".studioShell").waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(600);
}

async function shoot(page: Page, name: string) {
  const vp = page.viewportSize()!;
  if (!SHOTS || ![1440, 390].includes(vp.width)) return; // the two audit sizes: 1440x900 and 390x844
  fs.mkdirSync(OUT, { recursive: true });
  const theme = (await page.locator(".studioShell").getAttribute("data-theme")) === "light" ? "light" : "dark";
  await page.screenshot({ path: path.join(OUT, `${name}-${vp.width}x${vp.height}-${theme}.png`) });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedEpisode(RI.current, "content_ready");
  await seedEpisode(RI.stale, "publish_ready", "They won thirteen of their last fifteen.");
});
test.afterAll(async () => {
  await e2eDb().episode.deleteMany({ where: { id: { startsWith: "ri-ep-" } } });
  await closeE2eDb();
});

for (const theme of ["dark", "light"] as const) {
  test.describe(`release integrity, ${theme} theme`, () => {
    test.beforeEach(async ({ context, baseURL }) => {
      if (theme === "light") await context.addCookies([{ name: "tm_theme", value: "light", url: baseURL! }]);
    });

    test("Publishing page: the stale episode lists the three checks as blockers, the current one as met", async ({ page }) => {
      await page.goto("/studio/publish", { waitUntil: "domcontentloaded" });
      await settle(page);
      if (theme === "light") await expect(page.locator(".studioShell")).toHaveAttribute("data-theme", "light");

      const stale = page.locator(`article.relCard[aria-label="${TITLES[RI.stale]}"]`);
      await expect(stale).toHaveAttribute("data-state", "blocked");
      await expect(stale.locator(".relVerdict")).toContainText("3 blockers");
      for (const label of LABELS) {
        await expect(stale.locator('.relItem[data-state="blocker"]', { hasText: label })).toBeVisible();
      }
      await expect(stale.getByRole("link", { name: "Review and publish" })).toHaveCount(0);
      await stale.scrollIntoViewIfNeeded();
      await shoot(page, "publish-stale");

      const current = page.locator(`article.relCard[aria-label="${TITLES[RI.current]}"]`);
      await expect(current).toHaveAttribute("data-state", "ready");
      await expect(current.locator('.relItem[data-state="blocker"]')).toHaveCount(0);
      await current.locator("summary", { hasText: "requirements met" }).click();
      for (const label of LABELS) await expect(current.locator(".relMet li", { hasText: label })).toBeVisible();
      await current.scrollIntoViewIfNeeded();
      await shoot(page, "publish-current");

      // Nothing on the page may scroll sideways.
      const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
      expect(m.doc, "the Publishing page scrolls sideways").toBeLessThanOrEqual(m.win + 1);
    });

    test("Release panel: the stale episode shows why and its Publish button is disabled", async ({ page }) => {
      await page.goto(`/studio/episodes/${RI.stale}#publish`, { waitUntil: "domcontentloaded" });
      await settle(page);
      const button = page.getByTestId("publish-to-feed");
      await expect(button).toBeVisible();
      await expect(button).toBeDisabled();
      await expect(button).toContainText("blocked");
      const blockers = page.getByTestId("publish-blockers");
      await expect(blockers).toContainText("1 line was edited after the last fact check");
      await expect(blockers).toContainText("Scene audio no longer matches the script (scene 1)");
      await expect(blockers).toContainText("The script changed after the final mix was made");
      await blockers.scrollIntoViewIfNeeded();
      await shoot(page, "panel-stale");
      const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
      expect(m.doc, "the Release panel scrolls sideways").toBeLessThanOrEqual(m.win + 1);
    });

    test("Release panel: the current episode has an enabled Publish button and no blockers", async ({ page }) => {
      await page.goto(`/studio/episodes/${RI.current}#publish`, { waitUntil: "domcontentloaded" });
      await settle(page);
      const button = page.getByTestId("publish-to-feed");
      await expect(button).toBeEnabled();
      await expect(button).toHaveText("Publish to feed");
      await expect(page.getByTestId("publish-blockers")).toHaveCount(0);
      await button.scrollIntoViewIfNeeded();
      await shoot(page, "panel-current");
    });
  });
}

test("pressing Publish on a current episode publishes it; the stale one cannot be published from the page", async ({ page }, testInfo) => {
  const id = publishableId(testInfo.project.name);
  await seedEpisode(id, "content_ready");
  await page.goto(`/studio/episodes/${id}#publish`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.getByTestId("publish-to-feed").click();
  await expect(page.getByText("Published & live on the feed")).toBeVisible({ timeout: 60_000 });
  const db = e2eDb();
  expect((await db.episode.findUnique({ where: { id }, select: { status: true } }))?.status).toBe("published");
  expect((await db.episode.findUnique({ where: { id: RI.stale }, select: { status: true } }))?.status).toBe("publish_ready");
});
