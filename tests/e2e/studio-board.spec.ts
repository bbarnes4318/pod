// The Board's two front doors.
//
// The hottest takes stay in the open at the top; everything else is reached by
// walking League → (Conference) → Team. Both halves depend on data joins that a
// type-check cannot see — a take is attributed to a team through its evidence,
// and a team finds its crest through a name match against a generated manifest —
// so this drives the real page against real rows.
//
// The rows are created here rather than in seed.ts because they are the only
// fixtures that need a REAL league id ("NFL", "NCAAF"): the shared seed uses
// "E2ENFL" deliberately, and changing it would move the ground under every
// other spec. They are removed again in afterAll.

import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./seed";
import { e2eDb, closeE2eDb } from "./db";

const ID = {
  nflLeague: "NFL",
  cfbLeague: "NCAAF",
  chiefs: "e2e-board-kc",
  bills: "e2e-board-buf",
  alabama: "e2e-board-ala",
  game: "e2e-board-g1",
  nflTake: "e2e-board-t-nfl",
  cfbTake: "e2e-board-t-cfb",
};

const NFL_TAKE_TITLE = "Overtime rules cost them the game";
const CFB_TAKE_TITLE = "Alabama's playoff case is thinner than it looks";

const scores = {
  controversyScore: 70,
  starPowerScore: 60,
  bettingRelevanceScore: 30,
  recencyScore: 80,
};

test.beforeAll(async () => {
  const db = e2eDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- e2e fixture rows
  const any = (v: unknown) => v as any;

  await db.league.createMany({
    data: any([
      { id: ID.nflLeague, name: "National Football League", sport: "Football", slug: "nfl-board" },
      { id: ID.cfbLeague, name: "College Football", sport: "Football", slug: "ncaaf-board" },
    ]),
  });
  await db.team.createMany({
    data: any([
      { id: ID.chiefs, leagueId: ID.nflLeague, name: "Kansas City Chiefs", city: "Kansas City", abbreviation: "KC", slug: "board-kc" },
      { id: ID.bills, leagueId: ID.nflLeague, name: "Buffalo Bills", city: "Buffalo", abbreviation: "BUF", slug: "board-buf" },
      // Stored the way the seed stores a college program: school only, no
      // nickname. Finding its crest is the token-prefix match doing real work.
      { id: ID.alabama, leagueId: ID.cfbLeague, name: "Alabama", city: "", abbreviation: "ALA", slug: "board-ala" },
    ]),
  });
  await db.game.create({
    data: any({
      id: ID.game, leagueId: ID.nflLeague, homeTeamId: ID.chiefs, awayTeamId: ID.bills,
      scheduledAt: new Date(), status: "final", raw: {},
    }),
  });

  // Attributed through EVIDENCE: the game names both teams.
  await db.topicCandidate.create({
    data: any({
      id: ID.nflTake, title: NFL_TAKE_TITLE, sport: "NFL", leagueId: ID.nflLeague,
      summary: "The rule change decided a playoff game.", ...scores, debateScore: 70,
      evidenceIds: [{ type: "game", id: ID.game }], status: "approved",
    }),
  });
  // Attributed through the TEXT fallback: news-shaped, no team-bearing evidence.
  await db.topicCandidate.create({
    data: any({
      id: ID.cfbTake, title: CFB_TAKE_TITLE, sport: "NCAAF", leagueId: ID.cfbLeague,
      summary: "Two of those wins look worse every week.", ...scores, debateScore: 65,
      evidenceIds: [{ type: "newsItem", id: "n1" }], status: "approved",
    }),
  });
});

test.afterAll(async () => {
  const db = e2eDb();
  await db.topicCandidate.deleteMany({ where: { id: { in: [ID.nflTake, ID.cfbTake] } } });
  await db.game.deleteMany({ where: { id: ID.game } });
  await db.team.deleteMany({ where: { id: { in: [ID.chiefs, ID.bills, ID.alabama] } } });
  await db.league.deleteMany({ where: { id: { in: [ID.nflLeague, ID.cfbLeague] } } });
  await closeE2eDb();
});

const tile = (page: Page, key: string) => page.locator(`[data-testid="board-tile"][data-tile="${key}"]`);

test.describe("The Board", () => {
  test("the hottest row follows the league you click into", async ({ page }) => {
    await page.goto("/studio");
    await expect(page.locator("h1")).toHaveText("The Board");
    await expect(page.getByRole("heading", { name: "Hottest right now" })).toBeVisible();

    const featured = page.locator('[data-testid="board-featured-take"]');
    await expect(featured).toHaveCount(3);

    await tile(page, "NFL").click();
    await expect(page).toHaveURL(/league=NFL/);
    // The heading names the scope, so a filtered top row is legible rather than
    // looking like the filter silently failed.
    await expect(page.getByRole("heading", { name: "Hottest NFL takes" })).toBeVisible();

    // Exactly one NFL take exists in the pool, so a top row of three becoming a
    // top row of precisely that one take is the scope being applied — and it
    // holds whatever order the heat scores happen to fall in.
    const scopedFeatured = page.locator('[data-testid="board-featured-take"]');
    await expect(scopedFeatured).toHaveCount(1);
    await expect(scopedFeatured.first()).toHaveAttribute("data-take", ID.nflTake);
  });

  test("a college league heading spells itself out rather than abbreviating", async ({ page }) => {
    // "Hottest CBB takes" is jargon where the pro abbreviations are not.
    await page.goto("/studio?league=NCAAF");
    await expect(page.getByRole("heading", { name: "Hottest College Football takes" })).toBeVisible();
  });

  test("walks league to team and filters the board to that team", async ({ page }) => {
    await page.goto("/studio");

    // Every browsable league is offered, with the takes waiting on each.
    await expect(page.locator('[data-testid="board-tile"]')).toHaveCount(5);
    await expect(tile(page, "NFL")).toContainText("1 take");

    await tile(page, "NFL").click();

    // A pro league goes straight to its teams — all of them, not just the ones
    // with takes, because a fan looking for their team needs to find it.
    await expect(page.locator('[data-testid="board-tile"]')).toHaveCount(32);
    await expect(tile(page, "kansas-city-chiefs")).toContainText("1 take");
    await expect(tile(page, "buffalo-bills")).toContainText("1 take");
    await expect(tile(page, "chicago-bears")).toContainText("No takes");

    await tile(page, "kansas-city-chiefs").click();
    await expect(page).toHaveURL(/team=kansas-city-chiefs/);
    await expect(page.getByRole("heading", { name: "Hottest Kansas City Chiefs takes" })).toBeVisible();

    // One take in scope, so it IS the hottest — it belongs in the top row, and
    // must not be repeated in a remainder section below it.
    const shown = page.locator('[data-testid="board-featured-take"]');
    await expect(shown).toHaveCount(1);
    await expect(shown.first()).toContainText(NFL_TAKE_TITLE);
    await expect(page.locator('[data-testid="board-take"]')).toHaveCount(0);
    // The chosen team is marked for anyone the highlight colour does not reach.
    await expect(tile(page, "kansas-city-chiefs")).toHaveAttribute("aria-current", "true");
  });

  test("walks college league to conference to team", async ({ page }) => {
    await page.goto("/studio?league=NCAAF");

    // College adds the conference tier.
    await expect(tile(page, "southeastern-conference")).toContainText("1 take");
    await tile(page, "southeastern-conference").click();

    await expect(page).toHaveURL(/conf=southeastern-conference/);
    await expect(page.getByRole("heading", { name: "Hottest SEC takes" })).toBeVisible();
    await expect(tile(page, "alabama-crimson-tide")).toContainText("1 take");
    await tile(page, "alabama-crimson-tide").click();

    await expect(page.getByRole("heading", { name: "Hottest Alabama Crimson Tide takes" })).toBeVisible();
    const shown = page.locator('[data-testid="board-featured-take"]');
    await expect(shown).toHaveCount(1);
    await expect(shown.first()).toContainText(CFB_TAKE_TITLE);
    // The NFL take must not leak across leagues.
    await expect(shown.first()).not.toContainText(NFL_TAKE_TITLE);

    // The trail walks back up.
    await page.getByRole("link", { name: "SEC" }).first().click();
    await expect(page).toHaveURL(/conf=southeastern-conference/);
    await expect(page).not.toHaveURL(/team=/);
  });

  test("a team with nothing waiting says so instead of showing someone else's takes", async ({ page }) => {
    await page.goto("/studio?league=NFL&team=chicago-bears");
    await expect(page.getByRole("heading", { name: "Hottest Chicago Bears takes" })).toBeVisible();
    // Nothing in scope means nothing anywhere on the page — not the board's
    // hottest three quietly standing in for the team's.
    await expect(page.locator('[data-testid="board-featured-take"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="board-take"]')).toHaveCount(0);
    await expect(page.getByText("Nothing on Chicago Bears in the current pool.")).toBeVisible();
  });

  test("every crest on screen actually loads", async ({ page }) => {
    // A manifest that points at a file that moved renders an empty square and
    // no error, so the check has to be on the decoded pixels.
    for (const url of ["/studio", "/studio?league=NFL", "/studio?league=NCAAF&conf=southeastern-conference"]) {
      await page.goto(url);
      await expect(page.locator('[data-testid="board-tile"]').first()).toBeVisible();
      // Crests are lazily loaded and async-decoded, so settle first — asserting
      // on `complete` alone would fail on timing rather than on a bad path.
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                Array.from(document.querySelectorAll<HTMLImageElement>(".boardTile img")).filter(
                  (img) => !img.complete
                ).length
            ),
          { timeout: 20_000, message: `crests never finished loading on ${url}` }
        )
        .toBe(0);
      // A 404 still reports complete, with no pixels behind it.
      const broken = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLImageElement>(".boardTile img"))
          .filter((img) => img.naturalWidth === 0)
          .map((img) => img.getAttribute("src") ?? "")
      );
      expect(broken, `broken crests on ${url}`).toEqual([]);
    }
  });

  test("the seeded takes are still reachable from the board", async ({ page }) => {
    // The browse tiers must not have hidden the takes that were always here:
    // the shared seed's topics carry no league, so they belong to the whole
    // board and only to the whole board.
    await page.goto("/studio");
    const all = page.locator('[data-testid="board-take"], [data-testid="board-featured-take"]');
    await expect(all.filter({ hasText: "Did the refs decide the title game?" })).toHaveCount(1);
    expect(E2E.topics.lead).toBeTruthy();
  });
});
