import React from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import StudioPageHeader from "./StudioPageHeader";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { ownerScope } from "@/lib/ownerScope";
import { activeTopicCutoff } from "@/lib/services/topicFreshness";
import { loadStudioDraft } from "@/lib/services/studioDraft";
import { businessPodcastsEnabledFor } from "@/lib/business/intelligenceType";
import { getStudioProductions, type ProductionItem } from "./productions";
import { ProductionRow } from "./ActivityMenu";
import { PlayButton } from "./StudioAudio";
import { Icon } from "./StudioIcons";
import { agoLabel, showHue, showInitials } from "./lib";

export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ *
 * Studio Home — the production headquarters.
 *
 * It answers five questions, in this order, and nothing else:
 *   1. What should I do right now?        (the briefing)
 *   2. What needs me?                     (stopped, waiting, stalled)
 *   3. What is being made?                (in production)
 *   4. What is ready to go out?           (finished, unreleased)
 *   5. What could I make next?            (opportunities)
 *
 * The briefing is ONE sentence and ONE button, chosen from the viewer's
 * real situation by a fixed priority: no show yet → something stopped →
 * something waiting on them → an unfinished rundown → something ready to
 * release → work in progress → a clear desk. It is a rule, not a model:
 * the same state always produces the same advice, and every word in it
 * is read from a row.
 *
 * There are no KPI tiles here. A count that does not change what you do
 * next belongs in Analytics.
 * ------------------------------------------------------------------ */

const DRAFT_STEP: Record<string, string> = {
  show: "choosing a show",
  topics: "picking topics",
  hosts: "choosing hosts",
  production: "setting production",
  review: "ready to create",
};

interface Briefing {
  kicker: string;
  headline: string;
  detail: string;
  action: { label: string; href: string };
  tone: "start" | "stopped" | "waiting" | "ready" | "working" | "clear";
}

const quote = (title: string) => `“${title}”`;

export default async function StudioHome({
  searchParams,
}: {
  searchParams: Promise<{ league?: string; conf?: string; team?: string }>;
}) {
  // /studio used to be the sports board, and its drill-down lived in the query
  // string. A bookmark to a league or team still works: it moves to the desk.
  const sp = await searchParams;
  if (sp.league || sp.conf || sp.team) {
    const q = new URLSearchParams();
    for (const key of ["league", "conf", "team"] as const) if (sp[key]) q.set(key, sp[key]!);
    redirect(`/studio/desk?${q.toString()}`);
  }

  const viewer = await currentUser();
  const canBusiness = businessPodcastsEnabledFor(viewer);
  const scope = ownerScope(viewer);

  const [shows, productions, draft, lastPublished] = await Promise.all([
    db.podcast.findMany({
      where: scope,
      orderBy: { updatedAt: "desc" },
      take: 12,
      select: {
        id: true,
        name: true,
        intelligenceType: true,
        cadence: true,
        scheduleDays: true,
        _count: { select: { episodes: true } },
        episodes: { orderBy: { updatedAt: "desc" }, take: 1, select: { updatedAt: true } },
      },
    }),
    getStudioProductions(viewer),
    viewer ? loadStudioDraft(viewer.id) : null,
    db.episode.findFirst({
      where: { ...scope, status: "published" },
      orderBy: { publishedAt: "desc" },
      select: { id: true, title: true, publishedAt: true },
    }),
  ]);

  const hasSports = shows.some((s) => s.intelligenceType !== "BUSINESS");
  const businessShowIds = shows.filter((s) => s.intelligenceType === "BUSINESS").map((s) => s.id);

  // Opportunities, per vertical the viewer actually works in. Sports takes come
  // from the shared, freshness-bounded pool; business topics from the viewer's
  // own research. Ranked by the score each engine already stored.
  const [takes, bizTopics] = await Promise.all([
    hasSports || shows.length === 0
      ? db.topicCandidate.findMany({
          where: { status: "approved", createdAt: { gte: activeTopicCutoff() } },
          orderBy: { debateScore: "desc" },
          take: 4,
          select: { id: true, title: true, sport: true, createdAt: true, researchBrief: { select: { whyMattersNow: true } } },
        })
      : [],
    canBusiness && businessShowIds.length
      ? db.businessTopicOpportunity.findMany({
          where: { podcastId: { in: businessShowIds }, editorialStatus: { in: ["APPROVED", "CANDIDATE"] } },
          orderBy: [{ opportunityScore: "desc" }],
          take: 4,
          select: { id: true, title: true, podcastId: true, editorialStatus: true, whyNow: true, whyItMatters: true },
        })
      : [],
  ]);
  const showNameById = new Map(shows.map((s) => [s.id, s.name]));

  const by = (state: ProductionItem["state"]) => productions.items.filter((i) => i.state === state);
  const stopped = [...by("failed"), ...by("stalled")];
  const waiting = by("needs_you");
  const running = by("running");
  const ready = by("ready");
  const runningCount = running.length + productions.more;

  const briefing: Briefing = (() => {
    if (shows.length === 0) {
      return {
        tone: "start",
        kicker: "Welcome to the studio",
        headline: "Start with a show.",
        detail: "A show holds what every episode inherits: the premise, the hosts and their voices, the sound and the schedule. Describe it once and each episode after is a few clicks.",
        action: { label: "Create your first show", href: "/studio/shows/new" },
      };
    }
    if (stopped.length) {
      const item = stopped[0];
      return {
        tone: "stopped",
        kicker: stopped.length > 1 ? `${stopped.length} episodes stopped` : "An episode stopped",
        headline: `${quote(item.title)} stopped at ${item.stage.toLowerCase()}.`,
        detail: `${item.headline} Nothing is lost: open it and retry from that step.`,
        action: { label: "Open and retry", href: item.href },
      };
    }
    if (waiting.length) {
      const item = waiting[0];
      return {
        tone: "waiting",
        kicker: waiting.length > 1 ? `${waiting.length} episodes are waiting on you` : "Waiting on you",
        headline: `${quote(item.title)} needs your decision.`,
        detail: item.headline,
        action: { label: "Review it now", href: item.href },
      };
    }
    if (draft) {
      return {
        tone: "working",
        kicker: "Unfinished rundown",
        headline: `${quote(draft.title?.trim() || "Untitled episode")} is half built.`,
        detail: `You left off ${DRAFT_STEP[draft.activeStep] ?? "building it"}. It was saved as you went.`,
        action: { label: "Pick up where you left off", href: "/studio/create" },
      };
    }
    if (ready.length) {
      const item = ready[0];
      return {
        tone: "ready",
        kicker: ready.length > 1 ? `${ready.length} episodes are ready to release` : "Ready to release",
        headline: `${quote(item.title)} is finished.`,
        detail: "Listen to it, check the release list, and publish when you are happy.",
        action: { label: "Review and release", href: item.href },
      };
    }
    if (runningCount) {
      return {
        tone: "working",
        kicker: "In production",
        headline: runningCount === 1 ? `${quote(running[0]?.title ?? "An episode")} is being made.` : `${runningCount} episodes are being made.`,
        detail: "Nothing needs you right now. Production carries on if you leave this page, and you will see it here when something is ready or needs a decision.",
        action: { label: "Start another episode", href: "/studio/create" },
      };
    }
    return {
      tone: "clear",
      kicker: "The desk is clear",
      headline: "Nothing in production. What is next?",
      detail: lastPublished?.publishedAt
        ? `Your last release was ${quote(lastPublished.title)}, ${agoLabel(lastPublished.publishedAt)}.`
        : "Pick a topic from the Editorial desk, or let the studio choose one for a show.",
      action: { label: "New episode", href: "/studio/create" },
    };
  })();

  const status = [
    stopped.length + waiting.length ? `${stopped.length + waiting.length} need you` : null,
    runningCount ? `${runningCount} in production` : null,
    ready.length ? `${ready.length} ready to release` : null,
  ].filter(Boolean).join(" · ");

  const attention = [...stopped, ...waiting];

  return (
    <div className="fadeUp home">
      <StudioPageHeader
        title="Home"
        subtitle={viewer?.name ? `${viewer.name.split(" ")[0]}'s production desk` : "Your production desk"}
        status={status ? <span className="sectionCount" role="status">{status}</span> : undefined}
      />

      {/* ---------------- 1. The briefing ---------------------------------- */}
      <section className="homeBrief" data-tone={briefing.tone} aria-labelledby="home-brief-headline" data-testid="home-briefing">
        <div className="homeBriefText">
          <div className="overline homeBriefKicker">{briefing.kicker}</div>
          <h2 className="homeBriefHeadline" id="home-brief-headline">{briefing.headline}</h2>
          <p className="homeBriefDetail">{briefing.detail}</p>
        </div>
        <div className="homeBriefDo">
          <Link href={briefing.action.href} className="btnPrimary homeBriefAction" data-testid="home-primary-action">
            {briefing.action.label}
            {Icon.arrowRight}
          </Link>
          {/* The rundown stays reachable even when something more urgent leads. */}
          {draft && briefing.action.href !== "/studio/create" && (
            <Link href="/studio/create" className="btnGhost" data-testid="board-resume">Resume your rundown</Link>
          )}
        </div>
      </section>

      {shows.length > 0 && (
        <div className="homeGrid">
          <div className="homeMain">
            {/* ---------------- 2. Needs you -------------------------------- */}
            {attention.length > 0 && (
              <section className="homeSection" aria-labelledby="home-attention">
                <div className="homeSectionHead">
                  <h2 className="homeSectionTitle" id="home-attention">Needs you</h2>
                  <span className="sectionCount">{attention.length}</span>
                </div>
                <div className="prodList">
                  {attention.map((item) => <ProductionRow key={item.episodeId} item={item} />)}
                </div>
              </section>
            )}

            {/* ---------------- 3. In production ---------------------------- */}
            <section className="homeSection" aria-labelledby="home-running">
              <div className="homeSectionHead">
                <h2 className="homeSectionTitle" id="home-running">In production</h2>
                <Link href="/studio/episodes?view=progress" className="sectionAction">All in production</Link>
              </div>
              {running.length === 0 ? (
                <p className="homeQuiet">Nothing is being made right now.</p>
              ) : (
                <div className="prodList">
                  {running.map((item) => <ProductionRow key={item.episodeId} item={item} />)}
                </div>
              )}
              {productions.more > 0 && (
                <p className="homeQuiet">And {productions.more} more in production.</p>
              )}
            </section>

            {/* ---------------- 4. Ready to release ------------------------- */}
            {ready.length > 0 && (
              <section className="homeSection" aria-labelledby="home-ready">
                <div className="homeSectionHead">
                  <h2 className="homeSectionTitle" id="home-ready">Ready to release</h2>
                  <Link href="/studio/publish" className="sectionAction">Publishing</Link>
                </div>
                <ul className="readyList">
                  {ready.map((item) => (
                    <li key={item.episodeId} className="readyRow">
                      {item.audioUrl && (
                        <PlayButton track={{ id: item.episodeId, src: item.audioUrl, title: item.title, subtitle: item.showName ?? undefined, href: `/studio/episodes/${item.episodeId}` }} />
                      )}
                      <span className="readyBody">
                        <Link href={`/studio/episodes/${item.episodeId}`} className="readyTitle">{item.title}</Link>
                        <span className="readyMeta">{item.showName ?? "Standalone"} · finished {agoLabel(item.updatedAtIso)}</span>
                      </span>
                      <Link href={item.href} className="btnGhost btnSm">Release</Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ---------------- 5. What to make next ------------------------ */}
            {(takes.length > 0 || bizTopics.length > 0) && (
              <section className="homeSection" aria-labelledby="home-next">
                <div className="homeSectionHead">
                  <h2 className="homeSectionTitle" id="home-next">Worth making next</h2>
                  <Link href="/studio/desk" className="sectionAction">Editorial desk</Link>
                </div>
                <ul className="leadList">
                  {bizTopics.map((t) => (
                    <li key={t.id}>
                      <Link href={`/studio/desk?desk=business&topic=${t.id}`} className="leadRow">
                        <span className="leadKind">{showNameById.get(t.podcastId) ?? "Research"}</span>
                        <span className="leadTitle">{t.title}</span>
                        <span className="leadWhy">{t.whyNow?.trim() || t.whyItMatters}</span>
                        <span className="leadGo">{t.editorialStatus === "APPROVED" ? "Approved. Produce it" : "Review the evidence"}</span>
                      </Link>
                    </li>
                  ))}
                  {takes.map((t) => (
                    <li key={t.id}>
                      <Link href={`/studio/create?topic=${t.id}`} className="leadRow">
                        <span className="leadKind">{t.sport} · {agoLabel(t.createdAt)}</span>
                        <span className="leadTitle">{t.title}</span>
                        {t.researchBrief?.whyMattersNow?.trim() && <span className="leadWhy">{t.researchBrief.whyMattersNow.trim()}</span>}
                        <span className="leadGo">Build an episode on this</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          {/* ---------------- Your shows ------------------------------------ */}
          <aside className="homeSide" aria-labelledby="home-shows">
            <div className="homeSectionHead">
              <h2 className="homeSectionTitle" id="home-shows">Your shows</h2>
              <Link href="/studio/shows/new" className="sectionAction">New show</Link>
            </div>
            <ul className="homeShows">
              {shows.map((show) => {
                const isBusiness = show.intelligenceType === "BUSINESS";
                const last = show.episodes[0]?.updatedAt;
                const live = productions.items.filter((i) => i.showId === show.id && i.state !== "ready").length;
                return (
                  <li key={show.id} className="homeShow">
                    <Link href={`/studio/shows/${show.id}`} className="homeShowMain">
                      <span className="showArt" data-hue={showHue(show.id)} aria-hidden="true">{showInitials(show.name)}</span>
                      <span className="homeShowText">
                        <span className="homeShowName">{show.name}</span>
                        <span className="homeShowMeta">
                          {isBusiness ? "Business" : "Sports"} · {show._count.episodes} episode{show._count.episodes === 1 ? "" : "s"}
                          {last ? ` · active ${agoLabel(last)}` : ""}
                        </span>
                        {live > 0 && <span className="homeShowLive">{live} in production</span>}
                      </span>
                    </Link>
                    {/* A business episode is made from an approved research topic;
                        a sports episode from the rundown. Each goes to its own start. */}
                    <Link
                      href={isBusiness ? `/studio/desk?desk=business&show=${show.id}` : `/studio/create?show=${show.id}`}
                      className="btnGhost btnSm homeShowNew"
                      aria-label={`New episode for ${show.name}`}
                    >
                      {Icon.plus}
                      Episode
                    </Link>
                  </li>
                );
              })}
            </ul>
            <Link href="/studio/shows" className="sectionAction homeSideMore">All shows</Link>
          </aside>
        </div>
      )}

      {/* A first-time creator sees the whole path, not an empty dashboard. */}
      {shows.length === 0 && (
        <ol className="homeStart" aria-label="How an episode gets made">
          <li><span className="homeStartNum">1</span><span><strong>Create a show.</strong> Say what it is about and who it is for.</span></li>
          <li><span className="homeStartNum">2</span><span><strong>Cast your hosts.</strong> Give them personalities and audition real voices.</span></li>
          <li><span className="homeStartNum">3</span><span><strong>Pick a topic.</strong> The Editorial desk ranks what is worth making.</span></li>
          <li><span className="homeStartNum">4</span><span><strong>Approve the script.</strong> Read it, fix it, check the facts.</span></li>
          <li><span className="homeStartNum">5</span><span><strong>Release it.</strong> Listen to the mix, then publish to your feed.</span></li>
        </ol>
      )}
    </div>
  );
}
