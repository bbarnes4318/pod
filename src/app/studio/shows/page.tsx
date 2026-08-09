import React from "react";
import StudioPageHeader from "../StudioPageHeader";
import Link from "next/link";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { ownerScope } from "@/lib/ownerScope";
import { WEEKDAY_LABELS } from "@/app/app/podcasts/config";
import GenerateShowEpisodeButton from "./GenerateShowEpisodeButton";

export const dynamic = "force-dynamic";

export default async function StudioShowsPage() {
  const user = await currentUser();
  const podcasts = await db.podcast.findMany({
    where: ownerScope(user),
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { episodes: true } } },
  });

  return (
    <div className="fadeUp">
      <StudioPageHeader
        title="Shows"
        subtitle="Build the creative world once: premise, cast, segments, schedule and sound."
        actions={
          <Link href="/studio/shows/new" className="btnPrimary" data-testid="studio-open-show-forge">
            Build a show
          </Link>
        }
      />

      {podcasts.length === 0 ? (
        <section className="studioCard showEmpty">
          <div className="showEmptyGlyph" aria-hidden="true">🎙️</div>
          <h2 className="m-0">No shows yet</h2>
          <p className="showEmptyBody">
            Start with the show bible, assign your hosts, and then generate the premiere inside the same Studio workspace.
          </p>
          <Link href="/studio/shows/new" className="btnPrimary">Build your first show</Link>
        </section>
      ) : (
        <div className="showList">
          {podcasts.map((podcast) => {
            const cadence = podcast.cadence === "recurring"
              ? podcast.scheduleDays.map((day) => (WEEKDAY_LABELS[day] || day).slice(0, 3)).join(" · ")
              : "Manual releases";
            return (
              <article key={podcast.id} className="studioCard showRow">
                <div className="showRowMain">
                  <div className="showRowChips">
                    <span className="statusPill statusPill--ok">Show</span>
                    <span className="showRowCadence">{cadence}</span>
                  </div>
                  <h2 className="showRowName">{podcast.name}</h2>
                  <div className="showRowFacts">
                    <span>{podcast.verticals.join(", ") || "Sports"}</span>
                    <span>{podcast.segmentCount} topic{podcast.segmentCount === 1 ? "" : "s"} per episode</span>
                    <span>{podcast._count.episodes} episode{podcast._count.episodes === 1 ? "" : "s"}</span>
                  </div>
                </div>
                <div className="showRowActions">
                  <GenerateShowEpisodeButton podcastId={podcast.id} />
                  <Link href={`/studio/shows/${podcast.id}`} className="btnPrimary">Open show</Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
