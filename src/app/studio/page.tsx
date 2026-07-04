import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import { scoreTopicTalkability } from "@/lib/services/talkabilityService";
import { nextActionFor, qualityOf, fmtDuration, fmtDate, FINISHED_STATUSES, statusChip } from "./lib";

export const dynamic = "force-dynamic";

export default async function StudioHome() {
  const [hotTopics, recentScripts, libraryEpisodes, onDeck] = await Promise.all([
    // The hottest available material — ranked by debate score, enriched for talkability
    db.topicCandidate.findMany({
      where: { status: { in: ["approved", "pending"] } },
      include: { researchBrief: true },
      orderBy: { debateScore: "desc" },
      take: 4,
    }),
    // Recent scripts carrying the 0-100 quality rubric
    db.script.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, createdAt: true, content: true, episode: { select: { title: true } } },
    }),
    // Finished audio for the library strip
    db.episode.findMany({
      where: { status: { in: FINISHED_STATUSES }, audioUrl: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: 6,
      include: { scripts: { orderBy: { version: "desc" }, take: 1, select: { id: true, content: true } } },
    }),
    // The episode currently in flight
    db.episode.findFirst({
      where: { status: { notIn: [...FINISHED_STATUSES, "failed"] } },
      orderBy: { updatedAt: "desc" },
      include: { scripts: { orderBy: { version: "desc" }, take: 1, select: { id: true } } },
    }),
  ]);

  const rankedTakes = hotTopics
    .map((t) => ({
      topic: t,
      talk: scoreTopicTalkability({
        title: t.title,
        summary: t.summary,
        createdAt: t.createdAt,
        brief: t.researchBrief as any,
      }),
    }))
    .sort((a, b) => b.talk.total - a.talk.total);

  const scored = recentScripts
    .map((s) => ({ script: s, q: qualityOf(s) }))
    .filter((x) => x.q !== null) as { script: (typeof recentScripts)[number]; q: NonNullable<ReturnType<typeof qualityOf>> }[];

  const latestQ = scored[0]?.q ?? null;
  const avgRecent = scored.length
    ? Math.round(scored.slice(0, 3).reduce((a, x) => a + x.q.total, 0) / Math.min(3, scored.length))
    : null;

  const deckAction = onDeck ? nextActionFor(onDeck, onDeck.scripts[0]?.id) : null;

  return (
    <div className="fadeUp">
      <h1 className="pageTitle">
        What are we <span style={{ color: "var(--accent-color)" }}>arguing</span> tonight?
      </h1>
      <p className="pageSub">
        Pick a take, and the studio handles the rest — research, script, voices, mix.
      </p>

      {/* ---- ON DECK: the in-flight episode, one clear next move ---- */}
      {onDeck && deckAction && (
        <div className="studioCard" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1.25rem", flexWrap: "wrap", borderColor: "rgba(255,90,31,0.35)" }}>
          <div style={{ minWidth: 0 }}>
            <div className="chip chipAccent" style={{ marginBottom: "0.5rem" }}>On deck · {deckAction.stage}</div>
            <div className="epTitle" style={{ fontSize: "1.15rem" }}>{onDeck.title}</div>
            <div className="epMeta" style={{ marginTop: "0.3rem" }}>
              <span>{statusChip(onDeck.status).label}</span>
              <span>·</span>
              <span>updated {fmtDate(onDeck.updatedAt)}</span>
            </div>
          </div>
          <Link href={deckAction.href} className="btnPrimary">
            {deckAction.label} →
          </Link>
        </div>
      )}

      {/* ---- HOT TAKES: the fastest path to the next episode ---- */}
      <div className="sectionHead">
        <h2 className="sectionTitle">Tonight&apos;s hottest takes</h2>
        <Link href="/studio/takes" className="sectionAction">All takes →</Link>
      </div>
      {rankedTakes.length === 0 ? (
        <div className="emptyNote">
          No takes on the board yet. <Link href="/admin/topics" style={{ color: "var(--accent-color)" }}>Generate topics</Link> from the latest sports data to get started.
        </div>
      ) : (
        <div className="grid2">
          {rankedTakes.map(({ topic, talk }) => (
            <div key={topic.id} className="studioCard">
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="epMeta" style={{ marginBottom: "0.35rem" }}>
                    <span className="chip">{topic.sport}</span>
                    {topic.status === "approved" && <span className="chip chipSuccess">Ready</span>}
                  </div>
                  <div className="epTitle" style={{ fontSize: "1.05rem" }}>{topic.title}</div>
                </div>
                <div className="scoreBadge" title="Talkability — how argue-worthy this take is right now">
                  {talk.total}<small> /100</small>
                </div>
              </div>

              {/* WHY it's hot — the score breakdown as a visual */}
              <div style={{ margin: "0.85rem 0 1rem" }}>
                {[
                  ["Controversy", topic.controversyScore],
                  ["Star power", topic.starPowerScore],
                  ["Betting heat", topic.bettingRelevanceScore],
                  ["Freshness", topic.recencyScore],
                ].map(([label, v]) => (
                  <div key={label as string} className="axisRow">
                    <span>{label}</span>
                    <div className="scoreBarTrack">
                      <div className="scoreBarFill" style={{ width: `${Math.min(100, Number(v))}%` }} />
                    </div>
                    <strong>{Math.round(Number(v))}</strong>
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", gap: "0.6rem" }}>
                <Link href={`/studio/create?topic=${topic.id}`} className="btnPrimary" style={{ flex: 1 }}>
                  Make this episode
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- QUALITY PULSE ---- */}
      <div className="sectionHead">
        <h2 className="sectionTitle">Quality pulse</h2>
        <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          Every script is scored 0–100 before it&apos;s voiced
        </span>
      </div>
      {scored.length === 0 ? (
        <div className="emptyNote">No scored scripts yet — your first generated script will show its quality breakdown here.</div>
      ) : (
        <div className="grid2">
          <div className="studioCard">
            <div style={{ display: "flex", alignItems: "baseline", gap: "1rem", marginBottom: "0.75rem" }}>
              <span className="scoreBadge" style={{ fontSize: "2.6rem" }}>
                {latestQ!.total}<small> /100 latest</small>
              </span>
              {avgRecent !== null && (
                <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                  {avgRecent} avg over last {Math.min(3, scored.length)}
                </span>
              )}
            </div>
            {Object.entries(latestQ!.axes).map(([axis, v]) => (
              <div key={axis} className="axisRow">
                <span style={{ textTransform: "capitalize" }}>{axis}</span>
                <div className="scoreBarTrack">
                  <div className="scoreBarFill" style={{ width: `${(v.score / v.max) * 100}%` }} />
                </div>
                <strong>{v.score}/{v.max}</strong>
              </div>
            ))}
          </div>

          <div className="studioCard">
            <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.9rem" }}>
              Recent scripts
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: "8px", height: "110px" }}>
              {scored.slice(0, 8).reverse().map(({ script, q }) => (
                <Link
                  key={script.id}
                  href={`/admin/scripts/${script.id}`}
                  title={`${script.episode?.title ?? "Script"} — ${q.total}/100`}
                  style={{
                    flex: 1,
                    height: `${q.total}%`,
                    borderRadius: "4px 4px 0 0",
                    background: "linear-gradient(180deg, var(--wave-warm), var(--wave-hot))",
                    opacity: 0.9,
                    minWidth: "14px",
                  }}
                />
              ))}
            </div>
            <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", marginTop: "0.5rem" }}>
              oldest → newest · tap a bar to open the script
            </div>
          </div>
        </div>
      )}

      {/* ---- LIBRARY ---- */}
      <div className="sectionHead">
        <h2 className="sectionTitle">Latest episodes</h2>
        <Link href="/studio/episodes" className="sectionAction">Full library →</Link>
      </div>
      {libraryEpisodes.length === 0 ? (
        <div className="emptyNote">No finished episodes yet — your first mix lands here with a player and its score.</div>
      ) : (
        <div className="grid3">
          {libraryEpisodes.map((ep) => {
            const q = qualityOf(ep.scripts[0]);
            const chip = statusChip(ep.status);
            return (
              <div key={ep.id} className="studioCard epCard">
                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem" }}>
                  <span className={`chip ${chip.kind === "accent" ? "chipAccent" : chip.kind === "success" ? "chipSuccess" : ""}`}>{chip.label}</span>
                  {q && <span className="scoreBadge" style={{ fontSize: "1.15rem" }}>{q.total}<small>/100</small></span>}
                </div>
                <Link href={`/studio/episodes/${ep.id}`} className="epTitle" style={{ color: "var(--text-primary)" }}>
                  {ep.title}
                </Link>
                <div className="epMeta">
                  <span>{fmtDuration(ep.durationSeconds)}</span>
                  <span>·</span>
                  <span>{fmtDate(ep.updatedAt)}</span>
                </div>
                <Link href={`/studio/episodes/${ep.id}`} className="btnGhost" style={{ justifyContent: "center" }}>
                  ▶ Listen
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
