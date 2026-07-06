import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import { accentFor, accentForSport } from "../accent";
import { emojiForTitle, sportFromTitle, fmtMin, fmtDay, friendlyStage } from "../lib";
import { EpisodeCard, CardEpisode } from "../EpisodeCard";
import { getEpisodeScores } from "../scores";
import { currentUser } from "@/lib/currentUser";

export const dynamic = "force-dynamic";

export default async function MyEpisodesPage() {
  const user = await currentUser();
  // The signed-in user's episodes plus legacy (pre-auth, ownerId=null) ones so
  // existing content stays visible; logged-out visitors see only legacy.
  const ownerFilter = user
    ? { OR: [{ ownerId: user.id }, { ownerId: null }] }
    : { ownerId: null };
  const [episodes, scores] = await Promise.all([
    db.episode.findMany({
      where: ownerFilter,
      orderBy: { updatedAt: "desc" },
      take: 60,
      select: { id: true, title: true, audioUrl: true, durationSeconds: true, updatedAt: true, status: true },
    }).catch(() => [] as any[]),
    getEpisodeScores(),
  ]);

  const ready = episodes.filter((e) => e.audioUrl);
  const cooking = episodes.filter((e) => !e.audioUrl && e.status !== "failed");

  const toCard = (e: (typeof episodes)[number]): CardEpisode => {
    const a = accentForSport(sportFromTitle(e.title), e.title);
    return {
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
  };

  return (
    <>
      <div className="uTopbar">
        <h1 className="uPageTitle">My episodes</h1>
        <Link href="/app/create" className="uPlayLg" style={{ background: "var(--u-brand)", textDecoration: "none", padding: "0.6rem 1.3rem", fontSize: "0.88rem" }}>
          ＋ Create
        </Link>
      </div>
      <div className="uContent">
        {episodes.length === 0 && (
          <div style={{ textAlign: "center", padding: "4rem 1rem", color: "var(--u-ink-2)" }}>
            <div style={{ fontSize: "2.4rem", marginBottom: "0.8rem" }}>🎧</div>
            <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--u-ink)", marginBottom: "0.4rem" }}>No episodes yet</div>
            <p style={{ fontSize: "0.9rem", marginBottom: "1.4rem" }}>Pick a hot take and Take Machine produces the whole debate for you.</p>
            <Link href="/app/create" className="uPlayLg" style={{ background: "var(--u-brand)", textDecoration: "none" }}>＋ Create your first episode</Link>
          </div>
        )}

        {ready.length > 0 && (
          <>
            <div className="uSectionHead" style={{ marginTop: "0.5rem" }}>
              <h2 className="uSectionTitle">Ready to listen</h2>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(218px, 1fr))", gap: "1rem" }}>
              {ready.map((e) => (
                <EpisodeCard key={e.id} ep={toCard(e)} />
              ))}
            </div>
          </>
        )}

        {cooking.length > 0 && (
          <>
            <div className="uSectionHead">
              <h2 className="uSectionTitle">In production</h2>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
              {cooking.map((e) => {
                const a = accentFor(e.title);
                const stage = friendlyStage(e.status);
                return (
                  <Link key={e.id} href={`/app/episodes/${e.id}`} className="uTakeCard" style={{ textDecoration: "none" }}>
                    <div className="uTakeScore" style={{ background: a.tint, color: a.deep, fontSize: "1.3rem" }}>
                      {emojiForTitle(e.title)}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div className="uTakeTitle">{e.title}</div>
                      <div className="uTakeMeta">
                        <span className="uHeat" style={{ background: a.soft, color: a.deep }}>{stage.label}</span>
                        <span>started {fmtDay(e.updatedAt)}</span>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}
