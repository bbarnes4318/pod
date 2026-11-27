import React from "react";
import StudioPageHeader from "../StudioPageHeader";
import Link from "next/link";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { ownerScope } from "@/lib/ownerScope";
import { WEEKDAY_LABELS } from "@/app/app/podcasts/config";
import GenerateShowEpisodeButton from "./GenerateShowEpisodeButton";
import { businessPodcastsEnabledFor } from "@/lib/business/intelligenceType";
import { Icon } from "../StudioIcons";
import { agoLabel, showHue, showInitials } from "../lib";

export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ *
 * Shows — your media properties.
 *
 * Each show is a masthead, not a table row: its face, its name, what it
 * is for, and the two things you come here to do — open it, or make its
 * next episode. Sports and business shows sit in the same list; the
 * filter appears only when the account actually has both.
 * ------------------------------------------------------------------ */

const FILTERS = [
  { key: "all", label: "All shows" },
  { key: "business", label: "Business" },
  { key: "sports", label: "Sports" },
] as const;

export default async function StudioShowsPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const user = await currentUser();
  const showBusiness = businessPodcastsEnabledFor(user);
  const { type } = await searchParams;
  const filter = showBusiness && (type === "sports" || type === "business") ? type : "all";
  const all = await db.podcast.findMany({
    where: ownerScope(user),
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { episodes: true } },
      episodes: { orderBy: { updatedAt: "desc" }, take: 1, select: { updatedAt: true } },
      businessProfile: { select: { businessName: true, industry: true } },
    },
  });
  const counts = {
    all: all.length,
    business: all.filter((p) => p.intelligenceType === "BUSINESS").length,
    sports: all.filter((p) => p.intelligenceType !== "BUSINESS").length,
  };
  const podcasts = all.filter((p) =>
    filter === "all" ? true : filter === "business" ? p.intelligenceType === "BUSINESS" : p.intelligenceType !== "BUSINESS"
  );

  return (
    <div className="fadeUp">
      <StudioPageHeader
        title="Shows"
        subtitle="Everything an episode inherits lives in its show."
        actions={
          <Link href="/studio/shows/new" className="btnPrimary" data-testid="studio-open-show-forge">
            {Icon.plus}
            New show
          </Link>
        }
      />

      {all.length === 0 ? (
        <section className="emptyState showEmpty">
          <span className="emptyStateIcon">{Icon.shows}</span>
          <h2 className="emptyStateTitle m-0">No shows yet</h2>
          <p className="emptyStateBody showEmptyBody">
            A show holds what every episode inherits: the premise, the hosts, the research and the schedule. Create one, then make its first episode from the same place.
          </p>
          <Link href="/studio/shows/new" className="btnPrimary">Create your first show</Link>
        </section>
      ) : (
        <>
          {showBusiness && counts.business > 0 && counts.sports > 0 && (
            <div className="listToolbar">
              <nav aria-label="Filter shows by type" className="segmented bizFilter">
                {FILTERS.map((f) => (
                  <Link
                    key={f.key}
                    href={f.key === "all" ? "/studio/shows" : `/studio/shows?type=${f.key}`}
                    aria-current={filter === f.key ? "page" : undefined}
                  >
                    {f.label}
                    <span className="segCount">{counts[f.key]}</span>
                  </Link>
                ))}
              </nav>
            </div>
          )}

          <ul className="showList">
            {podcasts.map((podcast) => {
              const isBusiness = podcast.intelligenceType === "BUSINESS";
              const cadence =
                podcast.cadence === "recurring" && podcast.scheduleDays.length
                  ? `Releases ${podcast.scheduleDays.map((day) => (WEEKDAY_LABELS[day] || day).slice(0, 3)).join(", ")}`
                  : "Released by hand";
              const about = isBusiness
                ? [podcast.businessProfile?.businessName, podcast.businessProfile?.industry].filter(Boolean).join(" · ")
                : podcast.verticals.join(", ");
              const last = podcast.episodes[0]?.updatedAt ?? null;
              return (
                <li key={podcast.id} className="showMast showRow">
                  <Link href={`/studio/shows/${podcast.id}`} className="showMastMain">
                    {podcast.coverImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={podcast.coverImageUrl} alt="" className="showArt showArt--lg showArt--img" />
                    ) : (
                      <span className="showArt showArt--lg" data-hue={showHue(podcast.id)} aria-hidden="true">{showInitials(podcast.name)}</span>
                    )}
                    <span className="showMastText">
                      <span className="overline">{isBusiness ? "Business" : "Sports"}{about ? ` · ${about}` : ""}</span>
                      <span className="showMastName showRowName">{podcast.name}</span>
                      {podcast.description?.trim() && <span className="showMastAbout">{podcast.description.trim()}</span>}
                      <span className="showMastFacts">
                        <span>{podcast._count.episodes} episode{podcast._count.episodes === 1 ? "" : "s"}</span>
                        <span aria-hidden="true">·</span>
                        <span className="showRowCadence">{cadence}</span>
                        <span aria-hidden="true">·</span>
                        <span>{last ? `Active ${agoLabel(last)}` : "No episodes yet"}</span>
                      </span>
                    </span>
                  </Link>
                  <span className="showMastDo showRowActions">
                    {/* A business episode starts from an approved research topic;
                        a sports episode from the rundown. Each goes to its own start. */}
                    <Link
                      href={isBusiness ? `/studio/desk?desk=business&show=${podcast.id}` : `/studio/create?show=${podcast.id}`}
                      className="btnGhost"
                    >
                      {Icon.plus}
                      New episode
                    </Link>
                    {!isBusiness && <GenerateShowEpisodeButton podcastId={podcast.id} compact />}
                  </span>
                </li>
              );
            })}
          </ul>

          {podcasts.length === 0 && (
            <div className="emptyState">
              <div className="emptyStateTitle">No {filter} shows</div>
              <p className="emptyStateBody">Switch the filter, or create a new show.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
