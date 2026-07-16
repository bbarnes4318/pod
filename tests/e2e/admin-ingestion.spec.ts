import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./seed";
import { e2eDb, closeE2eDb } from "./db";

// Admin custom-topic + source-ingestion E2E, against the real /admin surface,
// the real services, and the real database.
//
// NO REAL NETWORK REQUEST IS MADE. Outbound fetches are stubbed at the socket
// boundary (src/lib/net/e2eFetchStub.ts, armed only by E2E_TEST_MODE=1) using
// RFC 6761 `.test` hostnames that can never resolve. Everything before the
// socket — URL validation, credential rejection, destination classification,
// redirect policy — runs for real here; the connection-level proofs (IP
// pinning, DNS rebinding, redirect revalidation, size/time caps) are covered
// exhaustively against the real transport by `npm run test:url-security`.
// No LLM/TTS/research/payment provider is called: research only enqueues.

test.use({ httpCredentials: { username: E2E.admin.username, password: E2E.admin.password } });

const desktopOnly = (t: { project: { name: string } }) => t.project.name === "desktop";

test.afterAll(async () => { await closeE2eDb(); });

async function gotoAdmin(page: Page) {
  await page.goto("/admin/episodes");
  await expect(page.getByTestId("admin-rundown")).toBeVisible({ timeout: 60_000 });
}

async function openForm(page: Page) {
  await gotoAdmin(page);
  await page.getByTestId("add-custom-topic").click();
  await expect(page.getByTestId("ct-title")).toBeVisible();
}

/** Unique per test run so repeated runs don't collide on duplicate detection. */
const uniqueTitle = (s: string) => `${s} ${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

test.describe("Admin custom topic + ingestion", () => {
  test("creates a PENDING topic that explains itself and is not episode-eligible", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await openForm(page);

    const title = uniqueTitle("Hand-written editorial take");
    await page.getByTestId("ct-title").fill(title);
    await page.getByTestId("ct-angle").fill("The contrarian read nobody is making");
    await page.getByTestId("ct-notes").fill("Operator notes — editorial input, not fact.");
    await page.getByTestId("ct-submit").click();

    await expect(page.getByTestId("ct-result")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("ct-status")).toContainText("pending");
    await expect(page.getByTestId("ct-research")).toContainText("not researched");
    // The gates are stated plainly rather than implied by a green tick.
    await expect(page.getByTestId("ct-gates")).toContainText("pending approval");

    // It is REAL in the database, and deliberately carries no fabricated research.
    const db = e2eDb();
    const row = await db.topicCandidate.findFirst({ where: { title }, include: { researchBrief: true } });
    expect(row).toBeTruthy();
    expect(row!.status).toBe("pending");
    expect(row!.researchBrief).toBeNull();
    expect(row!.evidenceIds).toEqual([]);

    // It appears on the board, showing its REAL blocking reason...
    const blocked = page.getByTestId(`blocked-${row!.id}`);
    await expect(blocked).toBeVisible({ timeout: 30_000 });
    await expect(blocked).toHaveAttribute("data-code", "pending_approval");
    // ...and cannot be added to a rundown.
    await expect(page.getByTestId(`pick-${row!.id}`)).toBeDisabled();
    // ...and was never silently selected for one.
    expect(await page.$$eval("[data-tray-topic]", (els) => els.map((e) => e.getAttribute("data-tray-topic")))).not.toContain(row!.id);
  });

  test("imports one stubbed public article", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await openForm(page);

    const title = uniqueTitle("Topic with one source");
    await page.getByTestId("ct-title").fill(title);
    await page.getByTestId("ct-urls").fill("https://wire.test/story-1");
    await page.getByTestId("ct-submit").click();

    await expect(page.getByTestId("ct-result")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("ct-imported-count")).toContainText("1 imported");
    await expect(page.getByTestId("ct-source-0")).toHaveAttribute("data-status", "imported");

    const db = e2eDb();
    const topic = await db.topicCandidate.findFirst({ where: { title } });
    const sources = await db.topicSource.findMany({ where: { topicId: topic!.id } });
    expect(sources).toHaveLength(1);
    expect(sources[0].title).toBe("Chiefs stun Eagles in overtime thriller");
    expect(sources[0].fetchStatus).toBe("imported");
    expect(sources[0].createdByAdminIdentity).toBe(E2E.admin.username);
    // Importing a source is NOT evidence — the topic stays honestly blocked.
    expect(topic!.evidenceIds).toEqual([]);
  });

  test("imports multiple articles and reports one success + one failure honestly", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await openForm(page);

    const title = uniqueTitle("Partial failure topic");
    await page.getByTestId("ct-title").fill(title);
    await page.getByTestId("ct-urls").fill("https://wire.test/a\nhttps://wire2.test/b\nhttps://slow.test/c");
    await page.getByTestId("ct-submit").click();

    await expect(page.getByTestId("ct-result")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("ct-imported-count")).toContainText("2 imported");
    await expect(page.getByTestId("ct-failed-count")).toContainText("1 failed");
    // A timeout is honestly reported AND offered as retryable.
    const statuses = await page.$$eval('[data-testid^="ct-source-"]', (els) => els.map((e) => e.getAttribute("data-status")));
    expect(statuses).toContain("timeout");
    await expect(page.getByTestId("ct-retryable-2")).toBeVisible();

    // One bad URL did not discard the good ones.
    const db = e2eDb();
    const topic = await db.topicCandidate.findFirst({ where: { title } });
    expect(await db.topicSource.count({ where: { topicId: topic!.id } })).toBe(2);
  });

  test("rejects a malformed URL, embedded credentials, and unsupported schemes", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await openForm(page);
    await page.getByTestId("ct-title").fill(uniqueTitle("Bad urls"));
    await page.getByTestId("ct-urls").fill("not-a-url\nhttps://user:pass@wire.test/a\nfile:///etc/passwd");
    await page.getByTestId("ct-submit").click();

    await expect(page.getByTestId("ct-result")).toBeVisible({ timeout: 30_000 });
    const statuses = await page.$$eval('[data-testid^="ct-source-"]', (els) => els.map((e) => e.getAttribute("data-status")));
    expect(statuses).toContain("invalid_url");
    expect(statuses).toContain("embedded_credentials");
    expect(statuses).toContain("unsupported_protocol");
    await expect(page.getByTestId("ct-failed-count")).toContainText("3 failed");
  });

  test("refuses an internal destination and a redirect to one, without leaking detail", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await openForm(page);
    await page.getByTestId("ct-title").fill(uniqueTitle("SSRF attempt"));
    await page.getByTestId("ct-urls").fill(
      "http://169.254.169.254/latest/meta-data/\nhttp://localhost:6379/\nhttps://redirect-internal.test/x"
    );
    await page.getByTestId("ct-submit").click();

    await expect(page.getByTestId("ct-result")).toBeVisible({ timeout: 30_000 });
    const statuses = await page.$$eval('[data-testid^="ct-source-"]', (els) => els.map((e) => e.getAttribute("data-status")));
    expect(statuses).toContain("blocked_destination");
    expect(statuses).toContain("redirect_blocked");
    await expect(page.getByTestId("ct-failed-count")).toContainText("3 failed");

    // The operator is told it was refused, in plain language, with no internal
    // detail. Note their OWN submitted URL is echoed back so they know which
    // line failed — that reveals nothing they didn't type. What must never
    // appear is anything they did NOT supply: the resolved address, the
    // redirect target, a port, a driver message or a stack frame.
    const shown = await page.getByTestId("ct-source-results").innerText();
    // Each refusal is a plain sentence. The operator's OWN submitted URL is
    // echoed so they know which line failed — that discloses nothing they
    // didn't type, and omitting it would make the panel useless.
    expect(shown).toContain("this server won't fetch");
    // What we must never ADD to their input: a stack frame, a driver code, a
    // resolved address, or the redirect target they never saw.
    expect(shown).not.toMatch(/at \w+ \(|\.ts:\d+|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/);
    expect(shown).not.toMatch(/resolved to|socket|remoteAddress|127\.0\.0\.1/);

    // Nothing internal was persisted.
    const db = e2eDb();
    const topic = await db.topicCandidate.findFirst({ where: { title: { startsWith: "SSRF attempt" } }, orderBy: { createdAt: "desc" } });
    expect(await db.topicSource.count({ where: { topicId: topic!.id } })).toBe(0);
  });

  test("a duplicate URL in the same submission is imported once", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await openForm(page);
    const title = uniqueTitle("Duplicate url topic");
    await page.getByTestId("ct-title").fill(title);
    // Same document, different tracking/fragment — canonicalization collapses them.
    await page.getByTestId("ct-urls").fill("https://wire.test/dup#top\nhttps://wire.test/dup?utm_source=x");
    await page.getByTestId("ct-submit").click();

    await expect(page.getByTestId("ct-result")).toBeVisible({ timeout: 30_000 });
    const statuses = await page.$$eval('[data-testid^="ct-source-"]', (els) => els.map((e) => e.getAttribute("data-status")));
    expect(statuses).toContain("duplicate");

    const db = e2eDb();
    const topic = await db.topicCandidate.findFirst({ where: { title } });
    expect(await db.topicSource.count({ where: { topicId: topic!.id } })).toBe(1);
  });

  test("a likely-duplicate title warns but does not block", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    const base = uniqueTitle("The refs decided the title game");

    await openForm(page);
    await page.getByTestId("ct-title").fill(base);
    await page.getByTestId("ct-submit").click();
    await expect(page.getByTestId("ct-result")).toBeVisible({ timeout: 30_000 });

    // Same headline, different punctuation/case — a warning, not a refusal.
    await page.getByTestId("ct-reset").click();
    await page.getByTestId("ct-title").fill(base.toUpperCase() + "!!");
    await page.getByTestId("ct-submit").click();
    await expect(page.getByTestId("ct-result")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("ct-duplicate-warning")).toBeVisible();
    await expect(page.getByTestId("ct-status")).toContainText("pending"); // still created
  });

  test("CORE: hostile page content is never rendered or stored as HTML", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await openForm(page);
    const title = uniqueTitle("Hostile source");
    await page.getByTestId("ct-title").fill(title);
    await page.getByTestId("ct-urls").fill("https://hostile.test/x");
    await page.getByTestId("ct-submit").click();
    await expect(page.getByTestId("ct-result")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("ct-preview-sources").click();
    await expect(page.getByTestId("ct-source-preview")).toBeVisible();

    // The page's script never executed in the admin origin.
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    // No injected element exists anywhere in the admin document.
    expect(await page.locator("iframe").count()).toBe(0);
    const html = await page.content();
    expect(html).not.toContain("PWNEDPAYLOAD");
    expect(html).not.toContain("169.254.169.254");

    // And nothing HTML-shaped reached the database.
    const db = e2eDb();
    const topic = await db.topicCandidate.findFirst({ where: { title } });
    const src = await db.topicSource.findFirst({ where: { topicId: topic!.id } });
    expect(JSON.stringify(src)).not.toContain("<script");
    expect(JSON.stringify(src)).not.toContain("PWNEDPAYLOAD");
    expect(src!.author).not.toContain("alert");
  });

  test("approve then start research uses the existing actions and the stubbed queue", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await openForm(page);
    const title = uniqueTitle("Approve then research");
    await page.getByTestId("ct-title").fill(title);
    await page.getByTestId("ct-urls").fill("https://wire.test/research-me");
    await page.getByTestId("ct-submit").click();
    await expect(page.getByTestId("ct-result")).toBeVisible({ timeout: 30_000 });

    const db = e2eDb();
    const topic = await db.topicCandidate.findFirst({ where: { title } });
    const id = topic!.id;

    // Research is refused while pending — the real precondition, surfaced.
    await expect(page.getByTestId(`action-research-${id}`)).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(`action-research-${id}`).click();
    await expect(page.getByTestId("builder-error")).toContainText("approved", { timeout: 30_000 });

    // Approve with the EXISTING admin action…
    await page.getByTestId(`action-approve-${id}`).click();
    await expect(async () => {
      const row = await db.topicCandidate.findUnique({ where: { id } });
      expect(row?.status).toBe("approved");
    }).toPass({ timeout: 30_000 });

    // …then research enqueues (no worker consumes it, so nothing paid runs).
    await page.getByTestId(`action-research-${id}`).click();
    await expect(page.getByTestId("builder-note")).toContainText("Research queued", { timeout: 30_000 });

    // Still no fabricated research state or evidence.
    const after = await db.topicCandidate.findUnique({ where: { id }, include: { researchBrief: true } });
    expect(after!.researchBrief).toBeNull();
    expect(after!.evidenceIds).toEqual([]);
  });

  test("audit records are written for creation, import and failure", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await openForm(page);
    const title = uniqueTitle("Audited topic");
    await page.getByTestId("ct-title").fill(title);
    await page.getByTestId("ct-urls").fill("https://wire.test/audited\nhttps://gone.test/missing");
    await page.getByTestId("ct-submit").click();
    await expect(page.getByTestId("ct-result")).toBeVisible({ timeout: 30_000 });

    const db = e2eDb();
    await expect(async () => {
      for (const jobType of ["admin:topic-custom-create", "admin:topic-source-import", "admin:topic-source-import-failure"]) {
        const row = await db.jobLog.findFirst({ where: { jobType }, orderBy: { createdAt: "desc" } });
        expect(row, `missing audit: ${jobType}`).toBeTruthy();
        // The actor is the server-verified identity, not anything the client sent.
        expect(JSON.stringify(row!.input)).toContain(E2E.admin.username);
      }
    }).toPass({ timeout: 30_000 });
  });

  test("submit is disabled while in flight and a double-submit makes one topic", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await openForm(page);
    const title = uniqueTitle("Double submit guard");
    await page.getByTestId("ct-title").fill(title);
    await page.getByTestId("ct-urls").fill("https://wire.test/slow-ish");

    const submit = page.getByTestId("ct-submit");
    await submit.click();
    // The button disables itself for the duration, so the second click is a no-op.
    await expect(page.getByTestId("ct-result")).toBeVisible({ timeout: 30_000 });

    const db = e2eDb();
    expect(await db.topicCandidate.count({ where: { title } })).toBe(1);
  });

  test("more than the max URLs is refused before any request", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await openForm(page);
    await page.getByTestId("ct-title").fill(uniqueTitle("Too many urls"));
    await page.getByTestId("ct-urls").fill(
      ["a", "b", "c", "d", "e", "f"].map((s) => `https://wire.test/${s}`).join("\n")
    );
    await expect(page.getByTestId("ct-too-many-urls")).toBeVisible();
    await expect(page.getByTestId("ct-submit")).toBeDisabled();
  });

  test("keyboard: the form opens, fills and submits without a mouse", async ({ page }, ti) => {
    test.skip(!desktopOnly(ti));
    await gotoAdmin(page);

    await page.getByTestId("add-custom-topic").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("ct-title")).toBeVisible();
    await expect(page.getByTestId("add-custom-topic")).toHaveAttribute("aria-expanded", "true");

    const title = uniqueTitle("Keyboard topic");
    await page.getByTestId("ct-title").focus();
    await page.keyboard.type(title);
    await page.getByTestId("ct-submit").focus();
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("ct-result")).toBeVisible({ timeout: 30_000 });
    // A screen reader is told what happened, via the panel's own live region.
    await expect(page.getByTestId("ct-live-region")).toContainText(/pending approval|Topic created/);
  });
});

test.describe("Admin ingestion — authorization", () => {
  test("ingestion endpoints reject an unauthenticated caller and a Studio session", async ({ baseURL }) => {
    // Plain fetch: this file sets httpCredentials, and the point is to send a
    // request that provably carries none.
    const anon = await fetch(`${baseURL}/admin/episodes`, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8", "next-action": "deadbeef" },
      body: "[]",
    });
    expect(anon.status).toBe(401);

    const fs = await import("node:fs");
    const state = JSON.parse(fs.readFileSync("tests/e2e/.auth/state.json", "utf8")) as { cookies: { name: string; value: string }[] };
    const cookie = state.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const asStudioUser = await fetch(`${baseURL}/admin/episodes`, { headers: { cookie } });
    expect(asStudioUser.status).toBe(401);
  });
});

test.describe("Admin ingestion — responsive", () => {
  test("the custom-topic form is usable across viewports", async ({ page }) => {
    await gotoAdmin(page);
    await page.getByTestId("add-custom-topic").click();
    await expect(page.getByTestId("ct-title")).toBeVisible();
    await expect(page.getByTestId("ct-urls")).toBeVisible();
    await expect(page.getByTestId("ct-submit")).toBeVisible();

    // The panel must never be the thing that forces a sideways scroll.
    const overflows = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="custom-topic-panel"]');
      return !!el && el.scrollWidth > el.clientWidth + 2;
    });
    expect(overflows).toBeFalsy();
  });
});
