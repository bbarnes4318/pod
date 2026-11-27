import React from "react";
import StudioPageHeader from "../StudioPageHeader";
import Link from "next/link";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { ownerScope } from "@/lib/ownerScope";
import { scoreTopicTalkability } from "@/lib/services/talkabilityService";
import { activeTopicCutoff } from "@/lib/services/topicFreshness";
import { businessPodcastsEnabledFor } from "@/lib/business/intelligenceType";
import BusinessDesk from "./BusinessDesk";
import SportsInspector from "./SportsInspector";
import { resolveTakeTeams } from "@/lib/services/takeTeamsService";
import {
  SPORTS_LOGO_LEAGUES,
  conferenceOfTeam,
  logoConference,
  logoLeague,
  logoTeam,
} from "@/lib/data/sportsLogoIndex";
import BoardBrowser, { type BrowseCrumb, type BrowseTile } from "../BoardBrowser";
import BoardTakeCard, { type BoardTakeView, type TakeCrest } from "../BoardTakeCard";
import BoardControls from "../BoardControls";

export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ *
 * The Editorial desk — where an episode starts.
 *
 * One desk, two verticals. Sports shows work from the shared take board
 * below; business shows work from their own research, ranked in
 * <BusinessDesk>. Which side opens first follows the shows the viewer
 * actually has, and the switch is a plain link so either is shareable.
 *
 * THE SPORTS BOARD
 *
 * Two ways in, because "what's hot" and "what's happening with MY team"
 * are different questions and the board used to answer only the first:
 *
 *   · The hottest takes stay in the open at the top, one click from the
 *     real generation flow — and they are the hottest takes IN WHATEVER IS
 *     SELECTED. Click into the NFL and that row becomes the NFL's hottest,
 *     with a heading that says so; it used to stay pinned to the whole
 *     board, which read as a filter that had not worked.
 *
 *   · Everything else is reachable by walking League → (Conference) →
 *     Team, with the crest for each. That walk is plain links over query
 *     params: shareable, back-button-correct, and no client-side copy of
 *     a 600-team manifest.
 *
 * No data here is invented: takes, scores, "why now", the team a take is
 * about, episodes and the feed-health read are all derived from rows the
 * pipeline already wrote. See takeTeamsService for how a take is
 * attributed to a team, and what happens when it cannot be.
 *
 * SEARCH / SORT / DENSE VIEW (BoardControls) apply only to the remainder
 * below the hottest row, not to the hottest three or the browse tiles.
 * That is deliberate, not a gap: the hottest row is a fixed 3-item teaser
 * that "stays in the open" regardless of any filter (see FEATURED above),
 * and the browse tiles are their own navigation, not a filterable list.
 * The remainder is where the actual card-fatigue problem lives — it can
 * run to 50+ items — so that is what gets a search box, a sort, and a
 * table view. All three are pure client-side state over data the server
 * already scoped and sorted; the default (no search, heat sort, grid
 * view) renders identically to the un-enhanced list, on purpose, so the
 * server-scoped pool and its heading text stay exactly what they say.
 * ------------------------------------------------------------------ */

// Production surfaces show only topics the pipeline can actually use. Pending
// editorial submissions belong in the review surface, not beside a Generate
// button that will reject them.
const AVAILABLE = ["approved"] as const;

/**
 * The active pool is bounded by the 48-hour freshness window, so this cap is a
 * backstop against a pathological run, not a page size — the tile counts below
 * describe the whole pool precisely because it is not normally truncated.
 */
const POOL_CAP = 240;

/** How many takes stay in the open above the browser. */
const FEATURED = 3;

/** Heat tiers over the 0-100 talkability score. Meaning is carried by an
 *  icon + a text label + color together — never color alone — and Signal
 *  Orange is deliberately NOT used here (it's reserved for Generate / live). */
function heatTier(total: number): { key: string; label: string } {
  if (total >= 70) return { key: "blazing", label: "Blazing" };
  if (total >= 45) return { key: "hot", label: "Hot" };
  return { key: "warm", label: "Warm" };
}

/** Human "3h ago" / "2d ago" from a timestamp. */
function agoLabel(d: Date | string): string {
  const ms = Date.now() - new Date(d).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/** Feed health from the real take pool: how many are available and how fresh
 *  the newest one is. Returned as an icon+label+color status, plus detail. */
function feedHealth(poolCount: number, newestAt: Date | null): {
  tone: "ok" | "warn" | "err";
  label: string;
  detail: string;
} {
  if (poolCount === 0 || !newestAt) {
    return { tone: "err", label: "Feed quiet", detail: "No takes waiting — generate topics to refill the board" };
  }
  const ageHrs = (Date.now() - new Date(newestAt).getTime()) / 3600000;
  const detail = `${poolCount} take${poolCount === 1 ? "" : "s"} ready · newest ${agoLabel(newestAt)}`;
  if (ageHrs <= 24 && poolCount >= 4) return { tone: "ok", label: "Feed healthy", detail };
  if (ageHrs <= 72) return { tone: "warn", label: "Feed cooling", detail };
  return { tone: "warn", label: "Feed stale", detail };
}

/** Board URL for a browse level. Empty levels are simply omitted. */
function boardHref(sel: { league?: string; conf?: string; team?: string }): string {
  const q = new URLSearchParams();
  if (sel.league) q.set("league", sel.league);
  if (sel.conf) q.set("conf", sel.conf);
  if (sel.team) q.set("team", sel.team);
  const s = q.toString();
  return s ? `/studio/desk?${s}` : "/studio/desk";
}

const bump = (m: Map<string, number>, key: string) => m.set(key, (m.get(key) ?? 0) + 1);

/** A take plus everything the board derives about it. */
interface EnrichedTake extends BoardTakeView {
  /** Every league this take touches: its own, plus its teams'. */
  leagueIds: Set<string>;
  /** `leagueId/conferenceSlug` for each conference its teams play in. */
  conferenceKeys: Set<string>;
}

export default async function StudioBoard({
  searchParams,
}: {
  searchParams: Promise<{ league?: string; conf?: string; team?: string; desk?: string; stage?: string; topic?: string; show?: string; take?: string }>;
}) {
  const sp = await searchParams;

  // Which side of the desk? An explicit choice wins; otherwise follow the
  // viewer's shows, so a business-only creator never lands on a sports board.
  const deskViewer = await currentUser();
  const canBusiness = businessPodcastsEnabledFor(deskViewer);
  const kinds = canBusiness
    ? await db.podcast.groupBy({ by: ["intelligenceType"], where: ownerScope(deskViewer), _count: { _all: true } })
    : [];
  const businessShows = kinds.find((k) => k.intelligenceType === "BUSINESS")?._count._all ?? 0;
  const sportsShows = kinds.find((k) => k.intelligenceType === "SPORTS")?._count._all ?? 0;
  const desk: "sports" | "business" =
    canBusiness && (sp.desk === "business" || (sp.desk !== "sports" && businessShows > 0 && sportsShows === 0)) ? "business" : "sports";

  const deskSwitch = canBusiness ? (
    <nav className="segmented deskSwitch" aria-label="Choose a desk">
      <Link href="/studio/desk?desk=sports" aria-current={desk === "sports" ? "page" : undefined}>Sports takes</Link>
      <Link href="/studio/desk?desk=business" aria-current={desk === "business" ? "page" : undefined}>Business research</Link>
    </nav>
  ) : null;

  if (desk === "business") {
    return (
      <div className="fadeUp">
        <StudioPageHeader
          title="Editorial desk"
          subtitle="Every topic your research has found, ranked, with the evidence beside it."
        />
        {deskSwitch}
        <BusinessDesk viewer={deskViewer} stage={sp.stage} topicId={sp.topic} showId={sp.show} />
      </div>
    );
  }

  // The takes pool is deliberately shared: it is the deployment's candidate
  // stories, not anyone's private work.
  const freshAfter = activeTopicCutoff();
  const freshWhere = { status: { in: [...AVAILABLE] }, createdAt: { gte: freshAfter } };
  const [pool, poolCount, newest] = await Promise.all([
    // The ranked take pool — reuse the EXISTING ranking (debateScore desc).
    db.topicCandidate.findMany({
      where: freshWhere,
      include: { researchBrief: true },
      orderBy: { debateScore: "desc" },
      take: POOL_CAP,
    }),
    db.topicCandidate.count({ where: freshWhere }),
    db.topicCandidate.findFirst({
      where: freshWhere,
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  // Which teams each take is about, from its evidence (see takeTeamsService).
  const teamRefs = await resolveTakeTeams(pool);

  const levelHref = boardHref({ league: sp.league, conf: sp.conf, team: sp.team });
  const takes: EnrichedTake[] = pool.map((t) => {
    const talk = scoreTopicTalkability({
      title: t.title,
      summary: t.summary,
      createdAt: t.createdAt,
      brief: t.researchBrief as never,
    });

    const crests: TakeCrest[] = [];
    const leagueIds = new Set<string>();
    const conferenceKeys = new Set<string>();
    if (t.leagueId) leagueIds.add(t.leagueId);
    for (const ref of teamRefs.get(t.id) ?? []) {
      const team = logoTeam(ref.leagueId, ref.teamSlug);
      if (!team) continue;
      crests.push({
        leagueId: ref.leagueId,
        slug: team.slug,
        name: team.name,
        logo: team.logo,
        plate: team.plate,
        opaque: team.opaque,
        primary: team.primary,
      });
      leagueIds.add(ref.leagueId);
      const conf = conferenceOfTeam(ref.leagueId, team.slug);
      if (conf) conferenceKeys.add(`${ref.leagueId}/${conf.slug}`);
    }

    return {
      id: t.id,
      title: t.title,
      sport: t.sport,
      leagueLabel: logoLeague(t.leagueId)?.shortName ?? null,
      heat: talk.total,
      tier: heatTier(talk.total),
      whyNow: t.researchBrief?.whyMattersNow?.trim() || t.summary?.trim() || null,
      crests,
      // ISO, not a Date: this crosses into a Client Component (BoardControls)
      // for the "Newest" sort, and a Date object does not survive that
      // boundary serialization.
      createdAt: t.createdAt.toISOString(),
      // Opens the evidence inspector for this take at the current browse level.
      inspectHref: `${levelHref}${levelHref.includes("?") ? "&" : "?"}take=${t.id}`,
      leagueIds,
      conferenceKeys,
    };
  });

  // Order by the number the cards actually SHOW. The pool is queried by
  // debateScore — a good way to choose which takes to load — but every card
  // displays the talkability heat, so leaving the rows in debateScore order let
  // a heat-45 take sit above a heat-82 one under a heading that says "hottest".
  // /studio/takes has always sorted this way; the board now agrees with it.
  takes.sort((a, b) => b.heat - a.heat);

  /* ---------------- Counts behind every tile ---------------------------- */

  const perLeague = new Map<string, number>();
  const perConference = new Map<string, number>();
  const perTeam = new Map<string, number>();
  for (const take of takes) {
    for (const id of take.leagueIds) bump(perLeague, id);
    for (const key of take.conferenceKeys) bump(perConference, key);
    // A take naming both teams in a matchup counts once for each of them.
    for (const key of new Set(take.crests.map((c) => `${c.leagueId}/${c.slug}`))) bump(perTeam, key);
  }

  /* ---------------- Where the browser currently is ---------------------- */

  const league = logoLeague(sp.league);
  const team = league ? logoTeam(league.id, sp.team) : null;
  // A team link carries its conference, but a hand-typed or older URL may not:
  // derive it so the trail and the sibling grid are always right.
  const conference = league
    ? logoConference(league.id, sp.conf) ?? (team ? conferenceOfTeam(league.id, team.slug) : null)
    : null;

  const scopeLabel = team?.name ?? conference?.name ?? league?.name ?? null;

  // Heading-sized name for the current scope. Pro leagues read better
  // abbreviated ("NFL"), college ones do not — "Hottest CBB takes" is jargon
  // where "Hottest College Basketball takes" is not. Tiered/flat is the real
  // distinction between them and is already in the data, so use it.
  const leagueHeading = league ? (league.conferences.length > 0 ? league.name : league.shortName) : null;
  const scopeHeading = team?.name ?? conference?.shortName ?? leagueHeading ?? null;

  const scoped: EnrichedTake[] = team
    ? takes.filter((t) => t.crests.some((c) => c.leagueId === league!.id && c.slug === team.slug))
    : conference
      ? takes.filter((t) => t.conferenceKeys.has(`${league!.id}/${conference.slug}`))
      : league
        ? takes.filter((t) => t.leagueIds.has(league.id))
        : takes;

  /* ---------------- The browse level on screen -------------------------- */

  const crumbs: BrowseCrumb[] = [{ label: "All leagues", href: league ? "/studio/desk" : undefined }];
  if (league) {
    crumbs.push({
      label: league.shortName,
      href: conference || team ? boardHref({ league: league.id }) : undefined,
      logo: league.logo,
      plate: league.plate,
      opaque: league.opaque,
    });
  }
  if (league && conference) {
    crumbs.push({
      label: conference.shortName,
      href: team ? boardHref({ league: league.id, conf: conference.slug }) : undefined,
      logo: conference.logo,
      plate: conference.plate,
      opaque: conference.opaque,
    });
  }
  if (league && team) {
    crumbs.push({ label: team.name, logo: team.logo, plate: team.plate, opaque: team.opaque });
  }

  const teamTiles = (teams: typeof SPORTS_LOGO_LEAGUES[number]["teams"]): BrowseTile[] =>
    teams.map((t) => ({
      key: t.slug,
      href: boardHref({ league: league!.id, conf: conference?.slug, team: t.slug }),
      label: t.name,
      logo: t.logo,
      plate: t.plate,
      opaque: t.opaque,
      monogram: t.abbr,
      count: perTeam.get(`${league!.id}/${t.slug}`) ?? 0,
      active: team?.slug === t.slug,
      accent: t.primary,
    }));

  let tiles: BrowseTile[];
  let gridLabel: string;
  if (!league) {
    tiles = SPORTS_LOGO_LEAGUES.map((l) => ({
      key: l.id,
      href: boardHref({ league: l.id }),
      label: l.shortName,
      sublabel: l.name,
      logo: l.logo,
      plate: l.plate,
      opaque: l.opaque,
      monogram: l.shortName,
      count: perLeague.get(l.id) ?? 0,
    }));
    gridLabel = "Leagues";
  } else if (league.conferences.length > 0 && !conference) {
    tiles = league.conferences.map((c) => ({
      key: c.slug,
      href: boardHref({ league: league.id, conf: c.slug }),
      label: c.shortName,
      sublabel: `${c.teams.length} teams`,
      logo: c.logo,
      plate: c.plate,
      opaque: c.opaque,
      monogram: c.shortName,
      count: perConference.get(`${league.id}/${c.slug}`) ?? 0,
    }));
    gridLabel = `${league.name} conferences`;
  } else {
    tiles = teamTiles(conference ? conference.teams : league.teams);
    gridLabel = `${conference?.name ?? league.name} teams`;
  }

  // The Board's levels live in the QUERY STRING, so the shell's "drop a path
  // segment" default would send Back to /studio from every one of them —
  // skipping the conference you came through. One level up, precisely.
  const back = team
    ? conference
      ? { label: conference.shortName, href: boardHref({ league: league!.id, conf: conference.slug }) }
      : { label: league!.shortName, href: boardHref({ league: league!.id }) }
    : conference
      ? { label: leagueHeading!, href: boardHref({ league: league!.id }) }
      : league
        ? { label: "All leagues", href: "/studio/desk" }
        : undefined;

  const feed = feedHealth(poolCount, newest?.createdAt ?? null);

  // The hottest takes are the hottest takes IN WHAT YOU ARE LOOKING AT. Pinning
  // them to the whole board meant clicking into the NFL left three unrelated
  // takes sitting at the top of an NFL page, which reads as a filter that did
  // not work. `scoped` is already ordered by debate heat (the pool query is),
  // so the top of it is the answer at every level.
  const featured = scoped.slice(0, FEATURED);
  const featuredIds = new Set(featured.map((t) => t.id));
  // Never list a take twice on one page.
  const listed = scoped.filter((t) => !featuredIds.has(t.id));

  return (
    <div className="fadeUp">
      <StudioPageHeader
        title="Editorial desk"
        subtitle="The hottest takes right now, and every team's, one crest away."
        back={back}
        status={
          <span className={`statusPill statusPill--${feed.tone}`} title={feed.detail} role="status">
            {feed.label}
          </span>
        }
      />

      {deskSwitch}

      {/* Evidence inspector for the take named in ?take= (shareable; Close and
          the browser's Back both return to this same browse level). */}
      {sp.take && <SportsInspector takeId={sp.take} closeHref={levelHref} />}

      {takes.length === 0 ? (
        <div className="emptyNote boardEmpty">
          <div className="boardEmptyTitle">The board is clear</div>
          <p className="boardResumeNote">
            No fresh takes are waiting. New ones arrive as the sports feeds update, so
            check back shortly.
          </p>
          <Link href="/studio/shows" className="btnGhost">Go to your shows</Link>
        </div>
      ) : (
        <>
          {/* ---------------- Hottest, for whatever is selected -------------- */}
          <div className="sectionHead">
            <h2 className="sectionTitle">
              {scopeHeading ? `Hottest ${scopeHeading} takes` : "Hottest right now"}
            </h2>
            <Link href="/studio/takes" className="sectionAction">All takes →</Link>
          </div>

          {scoped.length === 0 ? (
            <div className="emptyNote">
              Nothing on {scopeLabel} in the current pool.{" "}
              {conference && league ? (
                <a href={boardHref({ league: league.id, conf: conference.slug })} className="u-accent">
                  See the whole {conference.shortName} →
                </a>
              ) : league ? (
                <a href="/studio/desk" className="u-accent">Back to every league →</a>
              ) : null}
            </div>
          ) : (
            <div className="boardGrid boardGrid--featured">
              {featured.map((t, i) => (
                <BoardTakeCard key={t.id} take={t} featured rank={i + 1} />
              ))}
            </div>
          )}

          {/* ---------------- Browse by league / conference / team ----------- */}
          {/* Folded into a compact, low-height chip strip rather than a section
              of its own — same crumbs/tiles/hrefs as before (still one click,
              still shareable), just no longer big enough to read as a wall
              between the hottest row and the feed. The "All leagues" crumb
              already clears every level in one link, so a separate "Clear
              filter" control would only repeat it. */}
          <p className="boardBrowseLabel">{gridLabel}</p>
          <BoardBrowser crumbs={crumbs} tiles={tiles} label={gridLabel} />

          {/* ---------------- Everything else in scope ----------------------- */}
          {/* Rendered only when there IS a remainder: with the hottest row now
              scoped too, a team holding three or fewer takes has them all up
              top, and an empty control bar under the browser would be
              searching nothing. */}
          {listed.length > 0 && (
            <BoardControls
              takes={listed}
              scopeHeading={scopeHeading}
              scopeLabel={scopeLabel}
              scopedCount={scoped.length}
              totalCount={takes.length}
            />
          )}
        </>
      )}
    </div>
  );
}
