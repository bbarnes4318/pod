import React from "react";
import { db } from "@/lib/db";
import { accentForSport } from "../accent";
import { emojiForTitle, sportFromTitle, fmtMin } from "../lib";
import { EpisodeCard, CardEpisode } from "../EpisodeCard";
import { getEpisodeScores } from "../scores";

export const dynamic = "force-dynamic";

export default async function PublishedPage() {
  const [episodes, scores] = await Promise.all([
    db.episode.findMany({
      where: { status: "published" },
      orderBy: { publishedAt: "desc" },
      take: 40,
      select: { id: true, title: true, audioUrl: true, durationSeconds: true, publishedAt: true, updatedAt: true },
    }).catch(() => [] as any[]),
    getEpisodeScores(),
  ]);

  const feedUrl = process.env.PODCAST_RSS_URL || "/rss";

  return (
    <>
      <div className="uTopbar">
        <h1 className="uPageTitle">Published</h1>
        <a href="/rss" target="_blank" className="uGhostBtn" style={{ textDecoration: "none", padding: "0.55rem 1.1rem", fontSize: "0.85rem" }}>
          RSS feed ↗
        </a>
      </div>
      <div className="uContent">
        <div style={{ background: "var(--u-brand-soft)", border: "1px solid #dfe5ff", borderRadius: 14, padding: "0.9rem 1.2rem", marginBottom: "1.6rem", display: "flex", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "1.1rem" }}>📡</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--u-brand)" }}>Your show is live</div>
            <div style={{ fontSize: "0.75rem", color: "var(--u-ink-2)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{feedUrl}</div>
          </div>
        </div>

        {episodes.length === 0 ? (
          <div style={{ textAlign: "center", padding: "3rem", color: "var(--u-ink-2)" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.6rem" }}>📡</div>
            Nothing live yet — your first published episode lands here.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(218px, 1fr))", gap: "1rem" }}>
            {episodes.map((e) => {
              const a = accentForSport(sportFromTitle(e.title), e.title);
              const card: CardEpisode = {
                id: e.id,
                title: e.title,
                audioUrl: e.audioUrl,
                meta: fmtMin(e.durationSeconds),
                emoji: emojiForTitle(e.title),
                accentSolid: a.solid,
                accentSoft: a.soft,
                accentTint: a.tint,
                accentDeep: a.deep,
                score: scores.get(e.id) ?? null,
              };
              return <EpisodeCard key={e.id} ep={card} />;
            })}
          </div>
        )}
      </div>
    </>
  );
}
