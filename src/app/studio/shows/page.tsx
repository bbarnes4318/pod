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

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "all", label: "All shows" },
  { key: "business", label: "Business" },
  { key: "sports", label: "Sports" },
] as const;

const fmtDate = (d: Date | null | undefined) =>
  d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

export default async function StudioShowsPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const user = await currentUser();
  const showBusiness = businessPodcastsEnabledFor(user);
  const { type } = await searchParams;
  const filter = showBusiness && (type === "sports" || type === "business") ? type : "all";
  const all = await db.podcast.findMany({
    where: ownerScope(user),
    orderBy: { createdAt: "desc" },
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
        subtitle="Each show holds its premise, hosts, research, schedule and sound."
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
            A show holds everything an episode inherits — premise, hosts, research and schedule. Build one, then produce its first episode from the same workspace.
          </p>
          <Link href="/studio/shows/new" className="btnPrimary">Build your first show</Link>
        </section>
      ) : (
        <>
          {showBusiness && (
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

          {podcasts.length === 0 ? (
            <div className="emptyState">
              <div className="emptyStateTitle">No {filter} shows</div>
              <p className="emptyStateBody">Switch the filter, or build a new show.</p>
            </div>
          ) : (
            <div className="dataTableWrap">
              <table className="dataTable showTable">
                <thead>
                  <tr>
                    <th scope="col">Show</th>
                    <th scope="col">Type</th>
                    <th scope="col">Schedule</th>
                    <th scope="col" className="num">Episodes</th>
                    <th scope="col">Last activity</th>
                    <th scope="col" className="actions"><span className="srOnly">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {podcasts.map((podcast) => {
                    const isBusiness = podcast.intelligenceType === "BUSINESS";
                    const cadence =
                      podcast.cadence === "recurring" && podcast.scheduleDays.length
                        ? podcast.scheduleDays.map((day) => (WEEKDAY_LABELS[day] || day).slice(0, 3)).join(", ")
                        : "Manual releases";
                    const detail = isBusiness
                      ? [podcast.businessProfile?.businessName, podcast.businessProfile?.industry].filter(Boolean).join(" · ")
                      : [podcast.verticals.join(", ") || "Sports", `${podcast.segmentCount} topic${podcast.segmentCount === 1 ? "" : "s"} per episode`].join(" · ");
                    return (
                      <tr key={podcast.id} className="showRow">
                        <td className="primaryCell">
                          <Link href={`/studio/shows/${podcast.id}`} className="showRowName">{podcast.name}</Link>
                          <span className="subText">{detail}</span>
                        </td>
                        <td><span className={isBusiness ? "statusPill statusPill--live" : "statusPill"}>{isBusiness ? "Business" : "Sports"}</span></td>
                        <td className="showRowCadence">{cadence}</td>
                        <td className="num">{podcast._count.episodes}</td>
                        <td>{fmtDate(podcast.episodes[0]?.updatedAt ?? podcast.createdAt)}</td>
                        <td className="actions">
                          <span className="showRowActions">
                            {!isBusiness && <GenerateShowEpisodeButton podcastId={podcast.id} compact />}
                            <Link href={`/studio/shows/${podcast.id}`} className="btnGhost btnSm">Open</Link>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
