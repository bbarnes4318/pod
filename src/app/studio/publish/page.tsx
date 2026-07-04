import React from "react";
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
      <h1 className="pageTitle">Publish</h1>
      <p className="pageSub">Get finished episodes onto the public feed, and see what&apos;s already live.</p>

      <div className="studioCard" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap", marginBottom: "1.5rem" }}>
        <div>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Public feed</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.82rem", color: "var(--text-secondary)", wordBreak: "break-all" }}>{feedUrl}</div>
        </div>
        <div style={{ display: "flex", gap: "0.6rem" }}>
          <a href="/rss" target="_blank" className="btnGhost">Open RSS</a>
          <Link href="/admin/rss" className="btnGhost">Feed console</Link>
        </div>
      </div>

      <div className="sectionHead"><h2 className="sectionTitle">Waiting to go live</h2></div>
      {readyToPublish.length === 0 ? (
        <div className="emptyNote">Nothing queued. Finished episodes appear here once their audio is mixed.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.8rem" }}>
          {readyToPublish.map((ep) => {
            const sid = ep.scripts[0]?.id;
            const step =
              ep.status === "publish_ready"
                ? { label: "Publish now", href: sid ? `/admin/rss/${sid}` : "/admin/rss" }
                : { label: "Prepare show assets", href: sid ? `/admin/content-assets/${sid}` : "/admin/content-assets" };
            return (
              <div key={ep.id} className="studioCard" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="epTitle" style={{ fontSize: "1rem" }}>{ep.title}</div>
                  <div className="epMeta" style={{ marginTop: 4 }}>
                    <span className="chip chipAccent">{ep.status === "publish_ready" ? "Ready to publish" : "Needs packaging"}</span>
                    <span>{fmtDuration(ep.durationSeconds)}</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.6rem" }}>
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
              <span className="chip chipSuccess" style={{ alignSelf: "flex-start" }}>Live</span>
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
