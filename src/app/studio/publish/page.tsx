import React from "react";
import StudioPageHeader from "../StudioPageHeader";
import Link from "next/link";
import { db } from "@/lib/db";
import { fmtDate, fmtDuration } from "../lib";

export const dynamic = "force-dynamic";

export default async function PublishPage() {
  const [readyToPublish, published] = await Promise.all([
    db.episode.findMany({
      where: { status: { in: ["audio_ready", "content_ready", "publish_ready"] } },
      orderBy: { updatedAt: "desc" },
      include: { scripts: { orderBy: { version: "desc" }, take: 1, select: { id: true } } },
    }),
    db.episode.findMany({
      where: { status: "published" },
      orderBy: { publishedAt: "desc" },
      take: 12,
    }),
  ]);

  const feedUrl = process.env.PODCAST_RSS_URL || "/rss";

  return (
    <div className="fadeUp">
      <StudioPageHeader title="Publishing" subtitle="Put finished episodes on the public feed." />

      <div className="studioCard pubBar mb-6">
        <div>
          <div className="u-semibold mb-1">Public feed</div>
          <div className="pubFeedUrl">{feedUrl}</div>
        </div>
        <div className="pubActions">
          <a href="/rss" target="_blank" className="btnGhost">Open RSS</a>
          <Link href="/admin/rss" className="btnGhost">Feed console</Link>
        </div>
      </div>

      <div className="sectionHead"><h2 className="sectionTitle">Waiting to go live</h2></div>
      {readyToPublish.length === 0 ? (
        <div className="emptyNote">Nothing queued. Finished episodes appear here once their audio is mixed.</div>
      ) : (
        <div className="pubList">
          {readyToPublish.map((ep) => {
            const sid = ep.scripts[0]?.id;
            const step =
              ep.status === "publish_ready"
                ? { label: "Publish now", href: sid ? `/admin/rss/${sid}` : "/admin/rss" }
                : { label: "Prepare show assets", href: sid ? `/admin/content-assets/${sid}` : "/admin/content-assets" };
            return (
              <div className="studioCard pubBar" key={ep.id}>
                <div className="u-minw0">
                  <div className="epTitle pubEpTitle">{ep.title}</div>
                  <div className="epMeta mt-12">
                    <span className="chip chipAccent">{ep.status === "publish_ready" ? "Ready to publish" : "Needs packaging"}</span>
                    <span>{fmtDuration(ep.durationSeconds)}</span>
                  </div>
                </div>
                <div className="pubActions">
                  <Link href={`/studio/episodes/${ep.id}`} className="btnGhost">▶ Preview</Link>
                  <Link href={step.href} className="btnPrimary">{step.label} →</Link>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="sectionHead"><h2 className="sectionTitle">Live on the feed</h2></div>
      {published.length === 0 ? (
        <div className="emptyNote">No published episodes yet — your first release will show here.</div>
      ) : (
        <div className="grid3">
          {published.map((ep) => (
            <Link key={ep.id} href={`/studio/episodes/${ep.id}`} className="studioCard clickable epCard">
              <span className="chip chipSuccess u-selfStart">Live</span>
              <span className="epTitle">{ep.title}</span>
              <div className="epMeta">
                <span>{fmtDuration(ep.durationSeconds)}</span>
                <span>·</span>
                <span>{ep.publishedAt ? fmtDate(ep.publishedAt) : fmtDate(ep.updatedAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
