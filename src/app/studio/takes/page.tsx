import React from "react";
import StudioPageHeader from "../StudioPageHeader";
import Link from "next/link";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { scoreTopicTalkability } from "@/lib/services/talkabilityService";
import { getTopicUsage } from "@/lib/services/topicUsageService";
import { fmtDate } from "../lib";
import TakesFilters, { LeagueOption } from "./TakesFilters";
import type { TopicEditorialStatus } from "@prisma/client";
import { activeTopicCutoff } from "@/lib/services/topicFreshness";

export const dynamic = "force-dynamic";

// Editorial-readiness statuses only — "used" is no longer a status; usage is
// derived from EpisodeTopic and shown as a reuse-friendly count.
const BOARD_STATUSES: TopicEditorialStatus[] = ["approved"];

export default async function TakesBoard({
  searchParams,
}: {
  searchParams: Promise<{ sport?: string; league?: string }>;
}) {
  const sp = await searchParams;
  const freshAfter = activeTopicCutoff();

  // Server-side Sport / League filtering — applied in the query so the
  // talkability ranking below runs over the filtered universe, not just the
  // loaded page.
  const where: any = { status: { in: BOARD_STATUSES }, createdAt: { gte: freshAfter } };
  if (sp.sport) where.sport = { equals: sp.sport, mode: "insensitive" };
  if (sp.league) where.leagueId = sp.league;

  const [topics, sportRows, leagueRows] = await Promise.all([
    db.topicCandidate.findMany({
      where,
      include: { researchBrief: true },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
    // Filter options come from the whole board (unfiltered), so a chosen sport
    // never removes the other sports from the dropdown.
    db.topicCandidate.findMany({
      where: { status: { in: BOARD_STATUSES }, createdAt: { gte: freshAfter } },
      distinct: ["sport"],
      select: { sport: true },
      orderBy: { sport: "asc" },
    }),
    db.topicCandidate.findMany({
      where: { status: { in: BOARD_STATUSES }, createdAt: { gte: freshAfter }, leagueId: { not: null } },
      distinct: ["leagueId"],
      select: { leagueId: true, league: { select: { id: true, name: true } } },
      orderBy: { leagueId: "asc" },
    }),
  ]);

  const sports = sportRows.map((r) => r.sport).filter(Boolean);
  const leagues: LeagueOption[] = leagueRows
    .map((r) => (r.league ? { id: r.league.id, name: r.league.name } : null))
    .filter((l): l is LeagueOption => l !== null);
  const filtersActive = !!(sp.sport || sp.league);

  // Derived usage (from EpisodeTopic) — every board topic stays selectable;
  // usage is informational, not a gate. SCOPED to the signed-in owner: the
  // takes board is not podcast-specific, so we show only "used by you" — never
  // another customer's aggregate. Signed-out (shouldn't happen; layout gates)
  // gets no usage rather than a global count.
  const user = await currentUser();
  const usage = user
    ? await getTopicUsage(topics.map((t) => t.id), { ownerId: user.id })
    : new Map();

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
      <StudioPageHeader
        title="Takes"
        subtitle="Every candidate story, ranked by how argue-worthy it is right now."
      />

      {(sports.length > 0 || leagues.length > 0) && (
        <TakesFilters sports={sports} leagues={leagues} />
      )}

      {ranked.length === 0 ? (
        <div className="emptyNote">
          {filtersActive ? (
            <>No takes match these filters. Clear them, or <Link href="/admin/topics" className="u-accent">generate more topics</Link>.</>
          ) : (
            <>The board is empty. <Link href="/admin/topics" className="u-accent">Generate topics</Link> from fresh sports data to fill it.</>
          )}
        </div>
      ) : (
        <div className="takeList">
          {ranked.map(({ t, talk }, rank) => (
            <div key={t.id} className="studioCard takeRow">
              <div className="scoreBadge takeScore">
                {talk.total}
                <div className="takeScoreLabel">
                  #{rank + 1}
                </div>
              </div>

              <div className="takeMain">
                <div className="epMeta mb-1">
                  <span className="chip">{t.sport}</span>
                  {(usage.get(t.id)?.currentOwnerUseCount ?? 0) > 0 && (
                    <span className="chip">Used by you {usage.get(t.id)!.currentOwnerUseCount}×</span>
                  )}
                  {t.status === "approved" && t.researchBrief && <span className="chip chipSuccess">Ready</span>}
                  {t.status === "pending" && <span className="chip chipAccent">New</span>}
                  <span>{fmtDate(t.createdAt)}</span>
                </div>
                <div className="epTitle takeTitle">{t.title}</div>
                {t.summary && (
                  <div className="takeSummary">
                    {t.summary}
                  </div>
                )}
              </div>

              <div className="takeAxes">
                {[
                  ["Controversy", t.controversyScore],
                  ["Star power", t.starPowerScore],
                  ["Betting heat", t.bettingRelevanceScore],
                  ["Freshness", t.recencyScore],
                ].map(([label, v]) => (
                  <div key={label as string} className="axisRow takeAxisRow">
                    <span className="takeAxisLabel">{label}</span>
                    <div className="scoreBarTrack takeBarTrack">
                      <div className="scoreBarFill" style={{ "--bar-w": `${Math.min(100, Number(v))}%` } as React.CSSProperties} />
                    </div>
                    <strong className="takeAxisLabel">{Math.round(Number(v))}</strong>
                  </div>
                ))}
              </div>

              <Link href={`/studio/create?topic=${t.id}`} className="btnPrimary u-noShrink">
                Use it →
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
