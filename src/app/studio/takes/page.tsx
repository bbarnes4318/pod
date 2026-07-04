import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import { scoreTopicTalkability } from "@/lib/services/talkabilityService";
import { fmtDate } from "../lib";

export const dynamic = "force-dynamic";

export default async function TakesBoard() {
  const topics = await db.topicCandidate.findMany({
    where: { status: { in: ["pending", "approved", "used"] } },
    include: { researchBrief: true },
    orderBy: { createdAt: "desc" },
    take: 40,
  });

  const ranked = topics
    .map((t) => ({
      t,
      talk: scoreTopicTalkability({
        title: t.title,
        summary: t.summary,
        createdAt: t.createdAt,
        brief: t.researchBrief as any,
      }),
    }))
    .sort((a, b) => b.talk.total - a.talk.total);

  return (
    <div className="fadeUp">
      <h1 className="pageTitle">The takes board</h1>
      <p className="pageSub">
        Every candidate story, ranked by talkability — how argue-worthy it is right now. The bars show
        exactly why each one is hot.
      </p>

      {ranked.length === 0 ? (
        <div className="emptyNote">
          The board is empty. <Link href="/admin/topics" style={{ color: "var(--accent-color)" }}>Generate topics</Link> from
          fresh sports data to fill it.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
          {ranked.map(({ t, talk }, rank) => (
            <div key={t.id} className="studioCard" style={{ display: "flex", gap: "1.25rem", alignItems: "center", flexWrap: "wrap" }}>
              <div className="scoreBadge" style={{ fontSize: "1.9rem", width: 74, textAlign: "center", flexShrink: 0 }}>
                {talk.total}
                <div style={{ fontSize: "0.62rem", color: "var(--text-secondary)", fontFamily: "var(--font-family)", fontWeight: 600, marginTop: 2 }}>
                  #{rank + 1}
                </div>
              </div>

              <div style={{ flex: 1, minWidth: 260 }}>
                <div className="epMeta" style={{ marginBottom: "0.3rem" }}>
                  <span className="chip">{t.sport}</span>
                  {t.status === "used" && <span className="chip">Episode made</span>}
                  {t.status === "approved" && t.researchBrief && <span className="chip chipSuccess">Ready</span>}
                  {t.status === "pending" && <span className="chip chipAccent">New</span>}
                  <span>{fmtDate(t.createdAt)}</span>
                </div>
                <div className="epTitle" style={{ fontSize: "1.05rem" }}>{t.title}</div>
                {t.summary && (
                  <div style={{ fontSize: "0.82rem", color: "var(--text-secondary)", marginTop: "0.3rem", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {t.summary}
                  </div>
                )}
              </div>

              <div style={{ width: 240, flexShrink: 0 }}>
                {[
                  ["Controversy", t.controversyScore],
                  ["Star power", t.starPowerScore],
                  ["Betting heat", t.bettingRelevanceScore],
                  ["Freshness", t.recencyScore],
                ].map(([label, v]) => (
                  <div key={label as string} className="axisRow" style={{ gridTemplateColumns: "80px 1fr 28px", marginTop: "0.3rem" }}>
                    <span style={{ fontSize: "0.7rem" }}>{label}</span>
                    <div className="scoreBarTrack" style={{ height: 5 }}>
                      <div className="scoreBarFill" style={{ width: `${Math.min(100, Number(v))}%` }} />
                    </div>
                    <strong style={{ fontSize: "0.7rem" }}>{Math.round(Number(v))}</strong>
                  </div>
                ))}
              </div>

              {t.status !== "used" && (
                <Link href={`/studio/create?topic=${t.id}`} className="btnPrimary" style={{ flexShrink: 0 }}>
                  Use it →
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
