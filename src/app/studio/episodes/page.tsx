import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import { qualityOf, fmtDuration, fmtDate, statusChip } from "../lib";

export const dynamic = "force-dynamic";

export default async function EpisodesLibrary() {
  const episodes = await db.episode.findMany({
    orderBy: { updatedAt: "desc" },
    take: 60,
    include: { scripts: { orderBy: { version: "desc" }, take: 1, select: { id: true, content: true } } },
  });

  const finished = episodes.filter((e) => e.audioUrl);
  const inFlight = episodes.filter((e) => !e.audioUrl && e.status !== "failed");

  return (
    <div className="fadeUp">
      <h1 className="pageTitle">Episodes</h1>
      <p className="pageSub">Everything you&apos;ve made — finished shows up top, work-in-progress below.</p>

      {finished.length === 0 && inFlight.length === 0 && (
        <div className="emptyNote">
          Nothing here yet. <Link href="/studio/create" style={{ color: "var(--accent-color)" }}>Create your first episode</Link>.
        </div>
      )}

      {finished.length > 0 && (
        <>
          <div className="sectionHead"><h2 className="sectionTitle">Ready to hear</h2></div>
          <div className="grid3">
            {finished.map((ep) => {
              const q = qualityOf(ep.scripts[0]);
              const chip = statusChip(ep.status);
              return (
                <Link key={ep.id} href={`/studio/episodes/${ep.id}`} className="studioCard clickable epCard">
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem" }}>
                    <span className={`chip ${chip.kind === "accent" ? "chipAccent" : chip.kind === "success" ? "chipSuccess" : ""}`}>{chip.label}</span>
                    {q && <span className="scoreBadge" style={{ fontSize: "1.15rem" }}>{q.total}<small>/100</small></span>}
                  </div>
                  <span className="epTitle">{ep.title}</span>
                  <div className="epMeta">
                    <span className="eq paused" aria-hidden="true"><span /><span /><span /><span /><span /></span>
                    <span>{fmtDuration(ep.durationSeconds)}</span>
                    <span>·</span>
                    <span>{fmtDate(ep.updatedAt)}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}

      {inFlight.length > 0 && (
        <>
          <div className="sectionHead"><h2 className="sectionTitle">In the works</h2></div>
          <div className="grid3">
            {inFlight.map((ep) => {
              const chip = statusChip(ep.status);
              return (
                <Link key={ep.id} href={`/studio/episodes/${ep.id}`} className="studioCard clickable epCard">
                  <span className={`chip ${chip.kind === "accent" ? "chipAccent" : ""}`} style={{ alignSelf: "flex-start" }}>{chip.label}</span>
                  <span className="epTitle">{ep.title}</span>
                  <div className="epMeta">
                    <span>updated {fmtDate(ep.updatedAt)}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
