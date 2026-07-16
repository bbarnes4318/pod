import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./seed";
import { e2eDb, episodeTopicOrder, closeE2eDb } from "./db";

// The complete custom-topic workflow, in a browser, end to end:
//
//   create -> import a source -> approve -> STILL BLOCKED -> grounded research
//   -> eligible -> select in Manual mode -> episode -> snapshot
//
// The only thing stubbed is the research model's OUTPUT. The topic's real
// TopicSource rows, the usability filter, the evidence packet, the claim
// validator, the promotion (which re-checks every ref against the database) and
// every write all run for real. That is what makes the two rejection cases
// meaningful: the topic-self and foreign-source briefs are refused by the same
// code that would refuse a real model, not by an assertion in this file.
//
// No LLM, research provider, TTS, payment or network call happens.

test.use({ httpCredentials: { username: E2E.admin.username, password: E2E.admin.password } });

const desktopOnly = (t: { project: { name: string } }) => t.project.name === "desktop";

test.afterAll(async () => { await closeE2eDb(); });

const uniqueTitle = (s: string) => `${s} ${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

async function gotoAdmin(page: Page) {
  await page.goto("/admin/episodes");
  await expect(page.getByTestId("admin-rundown")).toBeVisible({ timeout: 60_000 });
}

/** Create a pending custom topic with one real imported source. Returns its id. */
async function createTopicWithSource(page: Page, title: string, url = "https://wire.test/grounded"): Promise<string> {
  await gotoAdmin(page);
  await page.getByTestId("add-custom-topic").click();
  await page.getByTestId("ct-title").fill(title);
  await page.getByTestId("ct-urls").fill(url);
  await page.getByTestId("ct-submit").click();
  await expect(page.getByTestId("ct-result")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("ct-imported-count")).toContainText("1 imported");

  const db = e2eDb();
  const topic = await db.topicCandidate.findFirst({ where: { title } });
  expect(topic, "the topic should exist in the database").toBeTruthy();
  return topic!.id;
}

/** Drive the E2E-only research seam. Returns the route's JSON. */
async function runResearch(page: Page, baseURL: string, topicId: string, mode: string, foreignSourceId?: string) {
  const res = await page.request.post(`${baseURL}/api/e2e/run-research`, {
    data: { topicId, mode, foreignSourceId },
  });
  return { status: res.status(), body: await res.json() };
}

test.describe("Admin grounded custom topic -> episode", () => {
  test("CORE: a custom topic becomes eligible ONLY after grounded research, then makes an episode", async ({ page, baseURL }, ti) => {
    test.skip(!desktopOnly(ti));
    const db = e2eDb();
    const title = uniqueTitle("Grounded custom take");
    const topicId = await createTopicWithSource(page, title);

    // --- 3. It starts pending, blocked on APPROVAL -----------------------
    let blocked = page.getByTestId(`blocked-${topicId}`);
    await expect(blocked).toBeVisible({ timeout: 30_000 });
    await expect(blocked).toHaveAttribute("data-code", "pending_approval");

    // --- 4. Approve with the REAL admin action ---------------------------
    await page.getByTestId(`action-approve-${topicId}`).click();
    await expect(async () => {
      const row = await db.topicCandidate.findUnique({ where: { id: topicId } });
      expect(row?.status).toBe("approved");
    }).toPass({ timeout: 30_000 });

    // --- 5. STILL BLOCKED before research --------------------------------
    // The honest state: it has a source, but a fetched URL is not evidence.
    await gotoAdmin(page);
    blocked = page.getByTestId(`blocked-${topicId}`);
    await expect(blocked).toBeVisible({ timeout: 30_000 });
    await expect(blocked).toHaveAttribute("data-code", "insufficient_evidence");
    await expect(page.getByTestId(`pick-${topicId}`)).toBeDisabled();

    // --- 6/7. Grounded research: stubbed OUTPUT, real validation ---------
    const sources = await db.topicSource.findMany({ where: { topicId } });
    expect(sources).toHaveLength(1);
    const research = await runResearch(page, baseURL!, topicId, "grounded");
    expect(research.status, JSON.stringify(research.body)).toBe(200);
    expect(research.body.ok, JSON.stringify(research.body)).toBe(true);

    // It promoted the ACTUAL persisted TopicSource id — not an invention.
    expect(research.body.promoted).toEqual([sources[0].id]);

    const afterResearch = await db.topicCandidate.findUnique({ where: { id: topicId }, include: { researchBrief: true } });
    expect(afterResearch!.researchBrief, "a grounded run persists a brief").toBeTruthy();
    expect(JSON.stringify(afterResearch!.evidenceIds)).toContain(sources[0].id);
    expect(JSON.stringify(afterResearch!.researchBrief!.sourceIds)).toContain(sources[0].id);
    // The topic must never appear as its own source.
    expect(JSON.stringify(afterResearch!.researchBrief!.sourceIds)).not.toContain(topicId);

    // --- 8. NOW eligible, and never before -------------------------------
    await gotoAdmin(page);
    await expect(page.getByTestId(`blocked-${topicId}`)).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId(`pick-${topicId}`)).toBeEnabled();

    // --- 9/10. Select in Manual mode and create the episode --------------
    await page.getByTestId("mode-manual").click();
    await page.getByTestId(`pick-${topicId}`).check();
    await expect(page.locator(`[data-tray-topic="${topicId}"]`)).toBeVisible();
    await page.getByTestId("create-episode").click();
    await expect(page.getByTestId("create-result")).toBeVisible({ timeout: 60_000 });

    // --- 11. The UI shows the final order --------------------------------
    const displayed = await page.$$eval('[data-testid^="final-"]', (els) =>
      els.map((e) => (e.getAttribute("data-testid") || "").replace(/^final-/, "")));
    expect(displayed).toEqual([topicId]);

    // --- 12. The snapshot froze the grounded evidence ---------------------
    const href = await page.getByTestId("open-episode").getAttribute("href");
    const episodeId = (href || "").split("/").pop()!;
    expect(await episodeTopicOrder(episodeId)).toEqual([topicId]);

    const et = await db.episodeTopic.findFirst({ where: { episodeId, topicId } });
    expect(et?.snapshot, "the EpisodeTopic must carry an immutable snapshot").toBeTruthy();
    const snap = et!.snapshot as Record<string, unknown>;
    expect(snap.version).toBe(1);
    expect(snap.source).toBe("creation");
    // Valid topicSource evidence + the source metadata that makes it checkable.
    expect(JSON.stringify(snap.evidenceIds)).toContain(sources[0].id);
    expect(JSON.stringify(snap.evidenceIds)).toContain("topicSource");
    expect(JSON.stringify(snap.sourceIds)).toContain(sources[0].id);
    // A fingerprint, so a later edit to the source cannot silently rewrite history.
    expect(String(snap.evidenceFingerprint)).toMatch(/^[a-f0-9]{64}$/);
    expect(snap.selectionTimestamp).toBeTruthy();
  });

  test("CORE: research citing the topic's OWN id is rejected and promotes nothing", async ({ page, baseURL }, ti) => {
    test.skip(!desktopOnly(ti));
    const db = e2eDb();
    const topicId = await createTopicWithSource(page, uniqueTitle("Self-citing take"));
    await db.topicCandidate.update({ where: { id: topicId }, data: { status: "approved" } });

    const res = await runResearch(page, baseURL!, topicId, "topic_self");
    expect(res.body.ok, `expected rejection, got ${JSON.stringify(res.body)}`).toBe(false);

    const after = await db.topicCandidate.findUnique({ where: { id: topicId }, include: { researchBrief: true } });
    expect(after!.researchBrief, "a rejected run must persist no brief").toBeNull();
    expect(after!.evidenceIds, "a rejected run must promote no evidence").toEqual([]);

    // And the topic stays honestly blocked on the board.
    await gotoAdmin(page);
    const blocked = page.getByTestId(`blocked-${topicId}`);
    await expect(blocked).toBeVisible({ timeout: 30_000 });
    await expect(blocked).toHaveAttribute("data-code", "insufficient_evidence");
  });

  test("CORE: research citing ANOTHER topic's source is rejected and promotes nothing", async ({ page, baseURL }, ti) => {
    test.skip(!desktopOnly(ti));
    const db = e2eDb();

    // A real, usable source that belongs to a DIFFERENT topic.
    const foreignId = await createTopicWithSource(page, uniqueTitle("Foreign owner"), "https://wire2.test/foreign");
    const foreignSources = await db.topicSource.findMany({ where: { topicId: foreignId } });
    expect(foreignSources).toHaveLength(1);

    const topicId = await createTopicWithSource(page, uniqueTitle("Source thief"));
    await db.topicCandidate.update({ where: { id: topicId }, data: { status: "approved" } });

    const res = await runResearch(page, baseURL!, topicId, "foreign_source", foreignSources[0].id);
    expect(res.body.ok, `expected rejection, got ${JSON.stringify(res.body)}`).toBe(false);

    const after = await db.topicCandidate.findUnique({ where: { id: topicId }, include: { researchBrief: true } });
    expect(after!.researchBrief, "a rejected run must persist no brief").toBeNull();
    expect(after!.evidenceIds, "another topic's source must never become this topic's evidence").toEqual([]);

    // The foreign topic is untouched by the attempt.
    const foreign = await db.topicCandidate.findUnique({ where: { id: foreignId } });
    expect(foreign!.evidenceIds).toEqual([]);
  });

  test("research with no valid source leaves the topic blocked", async ({ page, baseURL }, ti) => {
    test.skip(!desktopOnly(ti));
    const db = e2eDb();
    const topicId = await createTopicWithSource(page, uniqueTitle("Ungrounded take"));
    await db.topicCandidate.update({ where: { id: topicId }, data: { status: "approved" } });

    const res = await runResearch(page, baseURL!, topicId, "ungrounded");
    expect(res.body.ok).toBe(false);
    // The claims had no refs at all — the old code would have accepted them and
    // invented a topic-self source.
    expect(["no_grounded_facts", "ungrounded_host_arguments", "no_valid_sources"]).toContain(res.body.failure);

    const after = await db.topicCandidate.findUnique({ where: { id: topicId }, include: { researchBrief: true } });
    expect(after!.researchBrief).toBeNull();
    expect(after!.evidenceIds).toEqual([]);
  });

  test("the E2E research seam does not exist outside E2E, and grants no admin access", async ({ baseURL }) => {
    // It is reachable here only because the harness sets E2E_TEST_MODE=1. What
    // must be true regardless: it grants nothing on the /admin surface.
    const anon = await fetch(`${baseURL}/admin/episodes`);
    expect(anon.status, "the seam must not weaken admin authorization").toBe(401);

    // And it refuses to research a topic that is not approved — the real
    // precondition, not a bypass.
    const db = e2eDb();
    const pending = await db.topicCandidate.create({
      data: {
        title: uniqueTitle("Never approved"), sport: "NFL", controversyScore: 0, starPowerScore: 0,
        bettingRelevanceScore: 0, recencyScore: 0, debateScore: 0, evidenceIds: [], status: "pending",
      },
    });
    const res = await fetch(`${baseURL}/api/e2e/run-research`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ topicId: pending.id, mode: "grounded" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("not approved");
  });
});
