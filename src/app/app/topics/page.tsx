import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import { accentForSport } from "../accent";
import { emojiForTitle, fmtDay } from "../lib";
import TopicFilters from "./TopicFilters";

export const dynamic = "force-dynamic";

interface TopicsSearchParams {
  sport?: string;
  minScore?: string;
  recency?: string;
  focus?: string;
  sort?: string;
}

const RECENCY_MS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

// bettingRelevanceScore at/above this reads as a betting-angle topic
const BETTING_THRESHOLD = 60;

function orderFor(sort?: string) {
  switch (sort) {
    case "newest": return { createdAt: "desc" as const };
    case "controversy": return { controversyScore: "desc" as const };
    case "stars": return { starPowerScore: "desc" as const };
    case "betting": return { bettingRelevanceScore: "desc" as const };
    default: return { debateScore: "desc" as const };
  }
}

export default async function HotTopicsPage({ searchParams }: { searchParams: Promise<TopicsSearchParams> }) {
  const sp = await searchParams;
  const minScore = Math.max(0, Math.min(100, Number(sp.minScore) || 0));
  const recencyMs = sp.recency ? RECENCY_MS[sp.recency] : undefined;

  const where: any = { status: { in: ["pending", "approved"] } };
  if (sp.sport) where.sport = { equals: sp.sport, mode: "insensitive" };
  if (minScore > 0) where.debateScore = { gte: minScore };
  if (recencyMs) where.createdAt = { gte: new Date(Date.now() - recencyMs) };
  if (sp.focus === "betting") where.bettingRelevanceScore = { gte: BETTING_THRESHOLD };
  if (sp.focus === "general") where.bettingRelevanceScore = { lt: BETTING_THRESHOLD };

  const [topics, sportRows] = await Promise.all([
    db.topicCandidate.findMany({
      where,
      orderBy: orderFor(sp.sort),
      take: 60,
      select: {
        id: true, title: true, sport: true, summary: true, createdAt: true, status: true,
        debateScore: true, controversyScore: true, starPowerScore: true, bettingRelevanceScore: true, recencyScore: true,
      },
    }).catch(() => [] as any[]),
    db.topicCandidate.findMany({
      where: { status: { in: ["pending", "approved"] } },
      distinct: ["sport"],
      select: { sport: true },
      orderBy: { sport: "asc" },
    }).catch(() => [] as any[]),
  ]);

  const sports = sportRows.map((r: any) => r.sport).filter(Boolean);
  const filtersActive = !!(sp.sport || minScore || sp.recency || sp.focus);

  return (
    <>
      <div className="uTopbar">
        <h1 className="uPageTitle">Hot topics</h1>
      </div>
      <div className="uContent">
        <p style={{ color: "var(--u-ink-2)", fontSize: "0.9rem", marginBottom: "1.1rem", maxWidth: 560 }}>
          The stories people are arguing about right now, ranked by debate heat. Spin any of them
          into a one-off episode or a whole podcast.
        </p>

        <TopicFilters sports={sports} />

        {topics.length === 0 ? (
          <div style={{ textAlign: "center", padding: "3rem", color: "var(--u-ink-2)" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.6rem" }}>🔥</div>
            {filtersActive ? "Nothing matches those filters — loosen them up." : "No topics on the board right now — check back soon."}
          </div>
        ) : (
          <div className="uTopicGrid">
            {topics.map((t: any, rank: number) => {
              const a = accentForSport(t.sport, t.title);
              const hot = t.debateScore >= 75;
              const betting = t.bettingRelevanceScore >= BETTING_THRESHOLD;
              const meters: { label: string; icon: string; value: number }[] = [
                { label: "Controversy", icon: "⚡", value: t.controversyScore },
                { label: "Star power", icon: "⭐", value: t.starPowerScore },
                { label: "Betting heat", icon: "🎲", value: t.bettingRelevanceScore },
                { label: "Freshness", icon: "🕐", value: t.recencyScore },
              ];
              return (
                <article key={t.id} className={`uTopicCard ${hot ? "uTopicHot" : ""}`} style={{ ["--topic-accent" as any]: a.solid, ["--topic-soft" as any]: a.soft, ["--topic-deep" as any]: a.deep }}>
                  <header className="uTopicHead">
                    <div className="uTakeScore" style={{ background: a.solid, color: "#fff" }}>
                      {Math.round(t.debateScore)}
                      <small>DEBATE</small>
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="uTopicMetaTop">
                        <span style={{ color: a.deep, fontWeight: 750 }}>{emojiForTitle(t.title, t.sport)} {t.sport}</span>
                        {hot && <span className="uHeat" style={{ background: a.soft, color: a.deep }}>🔥 Hot</span>}
                        {betting && <span className="uHeat" style={{ background: "var(--u-brand-soft)", color: "var(--u-brand)" }}>🎲 Betting angle</span>}
                        <span style={{ color: "var(--u-ink-3)" }}>#{rank + 1} · {fmtDay(t.createdAt)}</span>
                      </div>
                      <h3 className="uTopicTitle">{t.title}</h3>
                    </div>
                  </header>

                  {t.summary && <p className="uTopicSummary">{t.summary}</p>}

                  <div className="uTopicMeters" aria-label="Topic scores">
                    {meters.map((m) => (
                      <div key={m.label} className="uTopicMeter" title={`${m.label}: ${Math.round(m.value)}/100`}>
                        <span className="uTopicMeterLabel">{m.icon} {m.label}</span>
                        <span className="uTopicMeterTrack"><span style={{ width: `${Math.round(m.value)}%`, background: a.solid }} /></span>
                        <span className="uTopicMeterNum">{Math.round(m.value)}</span>
                      </div>
                    ))}
                  </div>

                  <footer className="uTopicActions">
                    <Link href={`/app/create?topic=${t.id}`} className="uPlayLg" style={{ background: a.solid, padding: "0.5rem 1.1rem", fontSize: "0.82rem", textDecoration: "none" }}>
                      🎬 Create episode
                    </Link>
                    <Link href={`/app/podcasts/new?topic=${t.id}`} className="uRecordBtn" style={{ textDecoration: "none" }}>
                      ➕ Create podcast
                    </Link>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
