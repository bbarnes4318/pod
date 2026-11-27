/* eslint-disable @typescript-eslint/no-explicit-any -- e2e fixtures use loose payloads */
// Capture every Studio route at the five audit widths, in both themes.
//
// Not an assertion spec — it exists to produce the before/after evidence in
// docs/ux-audit/. Point it at a phase with SHOT_PHASE (which also switches on
// the 1920 and 1280 projects in playwright.config.ts):
//
//   SHOT_PHASE=after BUSINESS_PODCASTS_ENABLED=1 \
//     npx playwright test tests/e2e/studio-screenshots.spec.ts --trace off
//
// BUSINESS_PODCASTS_ENABLED=1 is needed for the business side of the desk: the
// seeded user is not an operator, and without the flag `?desk=business` falls
// back to the sports board.
//
// Three groups:
//   · every route at 1920 / 1440 / 1280 / 768 / 390 in the default charcoal theme
//   · every route at 1440 in the light theme                (`-1440-light`)
//   · the states a route screenshot cannot show: collapsed rail, the activity
//     menu, the phone drawer, the palette, the player dock    (`state-…`)
//
// It also writes `overflow.json`: every capture whose document was wider than
// its viewport. That file is the cheap, complete answer to "does anything
// scroll sideways", which eyeballing 100 images is not.
//
// The fixtures below are added by THIS spec, not by the shared seed, so the
// assertion suites keep the exact data they were written against.

import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { E2E } from "./seed";
import { e2eDb, closeE2eDb } from "./db";

const PHASE = process.env.SHOT_PHASE || "before";
const OUT = path.join(process.cwd(), "docs", "ux-audit", PHASE);
const OVERFLOW_FILE = path.join(OUT, "overflow.json");

const SHOT = {
  businessShowId: "shot-pod-business",
  readyEpisodeId: "shot-ep-ready",
  topicReady: "shot-opp-ready",
};

/** Every Studio route the audit covers. `slug` becomes the filename stem. */
const ROUTES: { slug: string; url: string }[] = [
  { slug: "home", url: "/studio" },
  { slug: "desk", url: "/studio/desk?desk=sports" },
  { slug: "desk-business", url: "/studio/desk?desk=business" },
  { slug: "shows", url: "/studio/shows" },
  { slug: "shows-detail", url: `/studio/shows/${E2E.podcastId}` },
  { slug: "shows-detail-business", url: `/studio/shows/${SHOT.businessShowId}` },
  { slug: "shows-new", url: "/studio/shows/new" },
  { slug: "create", url: "/studio/create" },
  { slug: "episodes", url: "/studio/episodes" },
  { slug: "episode-detail", url: `/studio/episodes/${E2E.episodeAwaitingApprovalId}` },
  { slug: "episode-detail-ready", url: `/studio/episodes/${SHOT.readyEpisodeId}` },
  { slug: "takes", url: "/studio/takes" },
  { slug: "hosts", url: "/studio/hosts" },
  { slug: "auditions", url: "/studio/auditions" },
  { slug: "audio", url: "/studio/audio" },
  { slug: "publish", url: "/studio/publish" },
  { slug: "analytics", url: "/studio/analytics" },
  { slug: "plan", url: "/studio/plan" },
  { slug: "settings", url: "/studio/settings" },
];

/** A one-second silent WAV, so the dock has something real to load. */
function silentWavDataUrl(): string {
  const rate = 8000;
  const samples = rate;
  const buf = Buffer.alloc(44 + samples);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples, 40);
  buf.fill(128, 44);
  return `data:audio/wav;base64,${buf.toString("base64")}`;
}

async function addFixtures() {
  const db = e2eDb() as any;
  await db.podcast.upsert({
    where: { id: SHOT.businessShowId },
    update: {},
    create: {
      id: SHOT.businessShowId, name: "Margin Notes", cadence: "recurring", ownerId: E2E.userA.id,
      intelligenceType: "BUSINESS", verticals: [], teams: [], segmentCount: 3, hostIds: [E2E.hostAce, E2E.hostCoach],
      description: "What independent HVAC contractors need to know before their competitors do.",
    },
  });
  const opp = (id: string, title: string, over: Record<string, unknown>) => ({
    id, podcastId: SHOT.businessShowId, ownerId: E2E.userA.id, category: "INSIDER_INTELLIGENCE",
    title, normalizedTitle: title.toLowerCase(), businessNiche: "Residential HVAC contracting",
    targetListener: "Owner-operators running two to ten trucks",
    coreQuestion: "Should a small contractor stock up before the refrigerant changeover?",
    listenerProblem: "Equipment prices moved twice this year and nobody explained why.",
    whyItMatters: "A wrong inventory call ties up a season of cash.",
    whyNow: "Distributors published new allocation rules this month.",
    undercoveredInformation: "Regional distributors are rationing by purchase history, not order size.",
    practicalValue: "A checklist for the next supplier call.",
    demandEvidence: { summary: "Asked repeatedly in two trade forums.", independentOrigins: 3 },
    citedSourceIds: ["src-1", "src-2", "src-3", "src-4"],
    keyClaims: [
      { claim: "Allocation is set by the prior twelve months of purchases.", verdict: "SOURCE_SUPPORTED", url: "https://example.invalid/allocation", authority: "Distributor bulletin" },
      { claim: "List prices rose twice in the calendar year.", verdict: "SOURCE_SUPPORTED", url: "https://example.invalid/prices", authority: "Manufacturer notice" },
      { claim: "Small contractors are paying more than large ones for the same unit.", verdict: "UNVERIFIED" },
    ],
    researchLimitations: ["Only two distributors publish their allocation rules."],
    opportunityScore: 82, potentialIas: 74, demandConfidence: 0.7, demandStrength: "HIGH", evidenceQuality: 0.8,
    ...over,
  });
  const opps = [
    opp(SHOT.topicReady, "The refrigerant changeover is rationing small contractors first", { achievedIas: 68 }),
    opp("shot-opp-approved", "Why maintenance plans beat new installs on margin this year", { editorialStatus: "APPROVED", opportunityScore: 77, achievedIas: 61, category: "EVERGREEN" }),
    opp("shot-opp-held", "Heat pump rebates: who actually got paid", { editorialStatus: "HELD", opportunityScore: 64, holdReasons: ["Two claims have no source yet."], category: "TRENDING" }),
    opp("shot-opp-new", "The technician shortage is a scheduling problem, not a hiring one", { opportunityScore: 58, demandStrength: "MODERATE", category: "HIDDEN_OPPORTUNITY" }),
  ];
  for (const data of opps) {
    await db.businessTopicOpportunity.upsert({ where: { id: data.id }, update: {}, create: data });
  }
  for (const [oppId, status] of [[SHOT.topicReady, "READY"], ["shot-opp-approved", "READY"], ["shot-opp-held", "HOLD"]] as const) {
    await db.businessResearchDossier.upsert({
      where: { opportunityId: oppId },
      update: {},
      create: { opportunityId: oppId, podcastId: SHOT.businessShowId, ownerId: E2E.userA.id, status, verifiedClaimCount: 6, unsupportedClaimCount: status === "HOLD" ? 2 : 0 },
    });
  }
  await db.episode.upsert({
    where: { id: SHOT.readyEpisodeId },
    update: {},
    create: {
      id: SHOT.readyEpisodeId, title: "Did the refs decide the title game?", slug: "shot-ready",
      status: "audio_ready", audioUrl: silentWavDataUrl(), durationSeconds: 1,
      ownerId: E2E.userA.id, podcastId: E2E.podcastId, hostIds: [E2E.hostAce, E2E.hostBlaze],
    },
  });
}

async function settle(page: Page) {
  // Studio pages are force-dynamic and several stream skeletons first. Settle
  // on the shell being present rather than on networkidle alone, which never
  // fires while the production console polls.
  await page.locator(".studioShell").waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(800);
}

function recordOverflow(file: string, m: { doc: number; win: number }) {
  if (m.doc <= m.win + 1) return;
  let all: Record<string, { doc: number; win: number }> = {};
  try { all = JSON.parse(fs.readFileSync(OVERFLOW_FILE, "utf8")); } catch { /* first entry */ }
  all[file] = m;
  fs.writeFileSync(OVERFLOW_FILE, JSON.stringify(all, null, 2) + "\n");
}

async function shoot(page: Page, name: string, fullPage = true) {
  const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  recordOverflow(`${name}.png`, m);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
}

test.describe(`Studio screenshots — ${PHASE}`, () => {
  test.beforeAll(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    await addFixtures();
  });
  test.afterAll(async () => { await closeE2eDb(); });

  for (const route of ROUTES) {
    test(`${route.slug}`, async ({ page }, testInfo) => {
      const width = testInfo.project.use.viewport?.width ?? 0;
      const res = await page.goto(route.url, { waitUntil: "domcontentloaded" });
      // A route that 404s or 500s is worth SEEING in the audit, so it is still
      // captured; only a hard navigation failure is an error.
      expect(res, `navigation to ${route.url} produced no response`).toBeTruthy();
      await settle(page);
      await shoot(page, `${route.slug}-${width}`);
    });
  }
});

test.describe(`Studio screenshots, light theme — ${PHASE}`, () => {
  test.beforeEach(async ({ context, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the light theme is captured at 1440 only");
    await context.addCookies([{ name: "tm_theme", value: "light", url: baseURL! }]);
  });

  for (const route of ROUTES) {
    test(`${route.slug} (light)`, async ({ page }) => {
      await page.goto(route.url, { waitUntil: "domcontentloaded" });
      await settle(page);
      await expect(page.locator(".studioShell")).toHaveAttribute("data-theme", "light");
      await shoot(page, `${route.slug}-1440-light`);
    });
  }
});

test.describe(`Studio screenshots, states — ${PHASE}`, () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(!["desktop", "tablet", "mobile"].includes(testInfo.project.name), "states are captured at 1440, 768 and 390");
  });

  test("collapsed sidebar", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the rail only collapses on desktop");
    await page.goto("/studio", { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.getByRole("button", { name: "Collapse navigation" }).click();
    await page.waitForTimeout(400);
    await shoot(page, "state-collapsed-1440", false);
  });

  test("activity menu open", async ({ page }, testInfo) => {
    const width = testInfo.project.use.viewport?.width ?? 0;
    await page.goto("/studio/episodes", { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.locator(".studioTopbar").getByRole("button", { name: /production|activity/i }).first().click();
    await page.waitForTimeout(1200);
    await shoot(page, `state-activity-${width}`, false);
  });

  test("navigation drawer open", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "the drawer exists below the desktop width");
    const width = testInfo.project.use.viewport?.width ?? 0;
    await page.goto("/studio", { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.waitForTimeout(400);
    await shoot(page, `state-drawer-${width}`, false);
  });

  test("command palette with results", async ({ page }, testInfo) => {
    const width = testInfo.project.use.viewport?.width ?? 0;
    await page.goto("/studio", { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.keyboard.press("Control+k");
    await page.keyboard.type("over");
    await page.waitForTimeout(1500);
    await shoot(page, `state-palette-${width}`, false);
  });

  test("player dock over the episode action bar", async ({ page }, testInfo) => {
    const width = testInfo.project.use.viewport?.width ?? 0;
    await page.goto("/studio/episodes", { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.getByRole("button", { name: /^Play / }).first().click();
    await expect(page.locator(".studioDock")).toBeVisible();
    await shoot(page, `state-dock-episodes-${width}`, false);
    // Client navigation, so the dock survives into the episode page.
    await page.locator(".studioMain").getByRole("link", { name: "Awaiting your read" }).first().click();
    await page.waitForURL(/\/studio\/episodes\/e2e-ep-awaiting/);
    await settle(page);
    await expect(page.locator(".studioDock")).toBeVisible();
    await shoot(page, `state-dock-episode-${width}`, false);
  });
});
