import React from "react";
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
      <header style={{ display: "flex", justifyContent: "space-between", gap: 18, alignItems: "flex-start", flexWrap: "wrap", marginBottom: "1.5rem" }}>
        <div>
          <div style={{ color: "var(--accent)", fontSize: ".72rem", fontWeight: 900, letterSpacing: ".13em", textTransform: "uppercase", marginBottom: 5 }}>Show Studio</div>
          <h1 className="pageTitle">Shows</h1>
          <p className="pageSub" style={{ marginBottom: 0, maxWidth: 720 }}>
            Build the creative world once: premise, cast chemistry, recurring segments, storylines, schedule, sound, and every episode that belongs to it.
          </p>
        </div>
        <Link href="/studio/shows/new" className="btnPrimary" data-testid="studio-open-show-forge">
          Build a show
        </Link>
      </header>

      {podcasts.length === 0 ? (
        <section className="studioCard" style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
          <div style={{ fontSize: "2.6rem", marginBottom: 10 }} aria-hidden="true">🎙️</div>
          <h2 style={{ margin: 0 }}>No shows yet</h2>
          <p style={{ color: "var(--text-secondary)", maxWidth: 520, margin: ".65rem auto 1.25rem", lineHeight: 1.55 }}>
            Start with the show bible, assign your hosts, and then generate the premiere inside the same Studio workspace.
          </p>
          <Link href="/studio/shows/new" className="btnPrimary">Build your first show</Link>
        </section>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {podcasts.map((podcast) => {
            const cadence = podcast.cadence === "recurring"
              ? podcast.scheduleDays.map((day) => (WEEKDAY_LABELS[day] || day).slice(0, 3)).join(" · ")
              : "Manual releases";
            return (
              <article key={podcast.id} className="studioCard" style={{ padding: "1.1rem 1.2rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0, flex: "1 1 420px" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                    <span className="statusPill statusPill--ok">Show</span>
                    <span style={{ color: "var(--text-muted)", fontSize: ".76rem" }}>{cadence}</span>
                  </div>
                  <h2 style={{ margin: 0, fontSize: "1.08rem" }}>{podcast.name}</h2>
                  <div style={{ color: "var(--text-secondary)", fontSize: ".8rem", marginTop: 7, display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <span>{podcast.verticals.join(", ") || "Sports"}</span>
                    <span>{podcast.segmentCount} topic{podcast.segmentCount === 1 ? "" : "s"} per episode</span>
                    <span>{podcast._count.episodes} episode{podcast._count.episodes === 1 ? "" : "s"}</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
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
