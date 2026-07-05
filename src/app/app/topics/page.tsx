import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import { accentForSport } from "../accent";
import { emojiForTitle, fmtDay } from "../lib";

export const dynamic = "force-dynamic";

export default async function HotTopicsPage() {
  const topics = await db.topicCandidate.findMany({
    where: { status: { in: ["pending", "approved"] } },
    orderBy: { debateScore: "desc" },
    take: 30,
    select: {
      id: true, title: true, sport: true, summary: true, createdAt: true, status: true,
      debateScore: true, controversyScore: true, starPowerScore: true, bettingRelevanceScore: true, recencyScore: true,
    },
  }).catch(() => [] as any[]);

  return (
    <>
      <div className="uTopbar">
        <h1 className="uPageTitle">Hot topics</h1>
      </div>
      <div className="uContent">
        <p style={{ color: "var(--u-ink-2)", fontSize: "0.9rem", marginBottom: "1.5rem", maxWidth: 560 }}>
          The stories people are arguing about right now, ranked by debate heat. Pick one and
          Take Machine turns it into a full episode.
        </p>

        {topics.length === 0 ? (
          <div style={{ textAlign: "center", padding: "3rem", color: "var(--u-ink-2)" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.6rem" }}>🔥</div>
            No topics on the board right now — check back soon.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.8rem", maxWidth: 860 }}>
            {topics.map((t, rank) => {
              const a = accentForSport(t.sport, t.title);
              const hot = t.debateScore >= 75;
              return (
                <div key={t.id} className="uTakeCard" style={{ alignItems: "flex-start", padding: "1.1rem 1.2rem" }}>
                  <div className="uTakeScore" style={{ background: a.solid, color: "#fff" }}>
                    {Math.round(t.debateScore)}
                    <small>DEBATE</small>
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="uTakeTitle" style={{ fontSize: "0.98rem", WebkitLineClamp: 3 }}>
                      <span style={{ color: "var(--u-ink-3)", fontWeight: 700, marginRight: 8 }}>#{rank + 1}</span>
                      {t.title}
                    </div>
                    {t.summary && (
                      <p style={{ fontSize: "0.82rem", color: "var(--u-ink-2)", margin: "0.35rem 0 0.55rem", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                        {t.summary}
                      </p>
                    )}
                    <div className="uTakeMeta" style={{ flexWrap: "wrap", rowGap: "0.35rem" }}>
                      <span style={{ color: a.deep, fontWeight: 700 }}>{emojiForTitle(t.title, t.sport)} {t.sport}</span>
                      {hot && <span className="uHeat" style={{ background: a.soft, color: a.deep }}>🔥 Hot</span>}
                      <span>{fmtDay(t.createdAt)}</span>
                      <span style={{ display: "inline-flex", gap: "0.6rem", color: "var(--u-ink-3)" }}>
                        <span title="Controversy">⚡ {Math.round(t.controversyScore)}</span>
                        <span title="Star power">⭐ {Math.round(t.starPowerScore)}</span>
                        <span title="Betting heat">🎲 {Math.round(t.bettingRelevanceScore)}</span>
                        <span title="Freshness">🕐 {Math.round(t.recencyScore)}</span>
                      </span>
                    </div>
                  </div>
                  <Link href={`/app/create?topic=${t.id}`} className="uRecordBtn" style={{ textDecoration: "none", alignSelf: "center" }}>
                    Record this
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
