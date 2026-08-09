import React from "react";
import StudioPageHeader from "./StudioPageHeader";
import Link from "next/link";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { ownerScope } from "@/lib/ownerScope";
import { scoreTopicTalkability } from "@/lib/services/talkabilityService";
import { activeTopicCutoff } from "@/lib/services/topicFreshness";
import { fmtDuration, fmtDate, FINISHED_STATUSES, statusChip } from "./lib";
import { loadStudioDraft } from "@/lib/services/studioDraft";

export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ *
 * The Board — the login-gated /studio home. It elevates the material
 * the studio already ranks (topicCandidate by debateScore, enriched
 * with the deterministic talkability score) into a scannable grid of
 * trending takes, each one click away from the real generation flow.
 * No data here is invented: takes, scores, "why now", episodes, and
 * the feed-health read are all pulled straight from the database.
 * ------------------------------------------------------------------ */

// Production surfaces show only topics the pipeline can actually use. Pending
// editorial submissions belong in the review surface, not beside a Generate
// button that will reject them.
const AVAILABLE = ["approved"] as const;

/** Heat tiers over the 0-100 talkability score. Meaning is carried by an
 *  icon + a text label + color together — never color alone — and Signal
 *  Orange is deliberately NOT used here (it's reserved for Generate / live). */
function heatTier(total: number): { key: string; label: string } {
  if (total >= 70) return { key: "blazing", label: "Blazing" };
  if (total >= 45) return { key: "hot", label: "Hot" };
  return { key: "warm", label: "Warm" };
}

/** Human "3h ago" / "2d ago" from a timestamp. */
function agoLabel(d: Date | string): string {
  const ms = Date.now() - new Date(d).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/** Feed health from the real take pool: how many are available and how fresh
 *  the newest one is. Returned as an icon+label+color status, plus detail. */
function feedHealth(poolCount: number, newestAt: Date | null): {
  tone: "ok" | "warn" | "err";
  label: string;
  detail: string;
} {
  if (poolCount === 0 || !newestAt) {
    return { tone: "err", label: "Feed quiet", detail: "No takes waiting — generate topics to refill the board" };
  }
  const ageHrs = (Date.now() - new Date(newestAt).getTime()) / 3600000;
  const detail = `${poolCount} take${poolCount === 1 ? "" : "s"} ready · newest ${agoLabel(newestAt)}`;
  if (ageHrs <= 24 && poolCount >= 4) return { tone: "ok", label: "Feed healthy", detail };
  if (ageHrs <= 72) return { tone: "warn", label: "Feed cooling", detail };
  return { tone: "warn", label: "Feed stale", detail };
}

function FlameIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3c1.6 3.2 4.2 4.7 4.2 8.2A4.2 4.2 0 0 1 12 15.4a4.2 4.2 0 0 1-4.2-4.2c0-1.3.4-2.4 1.1-3.2.2 1.1.9 1.8 1.6 2C10.6 8 10.5 5.3 12 3Z" />
      <path d="M12 21a5 5 0 0 0 5-5c0-1.6-.8-2.9-1.7-3.9.1 2.3-1.3 3.6-2.6 4.1.4-1.3.1-2.7-1.2-4-1.2 1-2 2.3-2 3.8a5 5 0 0 0 4.5 5Z" opacity="0.55" />
    </svg>
  );
}

export default async function StudioBoard() {
  // The takes pool is deliberately shared (it is the deployment's candidate
  // stories); EPISODES are not — they were previously listed unscoped, so the
  // board showed a new account other people's work.
  const viewer = await currentUser();
  const freshAfter = activeTopicCutoff();
  const freshWhere = { status: { in: [...AVAILABLE] }, createdAt: { gte: freshAfter } };
  const [takes, poolCount, newest, recentEpisodes] = await Promise.all([
    // The ranked take pool — reuse the EXISTING ranking (debateScore desc).
    db.topicCandidate.findMany({
      where: freshWhere,
      include: { researchBrief: true },
      orderBy: { debateScore: "desc" },
      take: 12,
    }),
    db.topicCandidate.count({ where: freshWhere }),
    db.topicCandidate.findFirst({
      where: freshWhere,
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    // Real episodes — most recently touched, whatever their stage.
    db.episode.findMany({
      where: ownerScope(viewer),
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: { id: true, title: true, status: true, audioUrl: true, durationSeconds: true, updatedAt: true },
    }),
  ]);

  // Enrich each take with the studio's existing talkability score (the "heat").
  const cards = takes.map((t) => {
    const talk = scoreTopicTalkability({
      title: t.title,
      summary: t.summary,
      createdAt: t.createdAt,
      brief: t.researchBrief as any,
    });
    const whyNow = (t.researchBrief?.whyMattersNow?.trim() || t.summary?.trim() || "") || null;
    return {
      id: t.id,
      title: t.title,
      sport: t.sport,
      status: t.status,
      heat: talk.total,
      tier: heatTier(talk.total),
      whyNow,
    };
  });

  const feed = feedHealth(poolCount, newest?.createdAt ?? null);

  // An unfinished rundown is real work the studio is already holding, and the
  // board was the one screen that never mentioned it — you had to remember you
  // had a draft and go to Create to find out. The draft is autosaved
  // server-side, so this is a read of what is already there.
  const draft = viewer ? await loadStudioDraft(viewer.id) : null;
  const draftStepLabel: Record<string, string> = {
    show: "choosing a show", topics: "picking topics", hosts: "choosing hosts",
    production: "setting production", review: "ready to create",
  };
  const draftSummary = draft
    ? draft.mode === "automatic"
      ? `${draft.targetTopicCount} topics chosen for you`
      : draft.selectedTopicIds.length
        ? `${draft.selectedTopicIds.length} topic${draft.selectedTopicIds.length === 1 ? "" : "s"} picked`
        : "nothing picked yet"
    : null;

  return (
    <div className="fadeUp">
      {/* ---------------- Hero: title, feed health, big Generate CTA --------- */}
      <StudioPageHeader
        title="The Board"
        subtitle="Tonight's hottest takes, ranked by debate heat."
        status={
          <span className={`statusPill statusPill--${feed.tone}`} title={feed.detail} role="status">
            {feed.label}
          </span>
        }
      />

      {/* ---------------- Unfinished rundown -------------------------------- */}
      {draft && (
        <Link href="/studio/create" className="studioCard boardResume clickable" data-testid="board-resume">
          <span className="boardResumeMark" aria-hidden="true">▸</span>
          <span className="boardResumeText">
            <span className="boardResumeTitle">{draft.title?.trim() || "Untitled episode"}</span>
            <span className="boardResumeMeta">
              You left off {draftStepLabel[draft.activeStep] ?? "building"} · {draftSummary}
            </span>
          </span>
          <span className="boardResumeGo">Pick up where you left off</span>
        </Link>
      )}

      {/* ---------------- Trending takes grid ------------------------------- */}
      <div className="sectionHead">
        <h2 className="sectionTitle">Trending takes</h2>
        <Link href="/studio/takes" className="sectionAction">All takes →</Link>
      </div>

      {cards.length === 0 ? (
        <div className="emptyNote boardEmpty">
          <div className="boardEmptyTitle">The board is clear</div>
          <p className="boardResumeNote">
            No takes are waiting yet. Kick off your first episode and the studio will
            pull in fresh sports material, research it, and write the debate.
          </p>
          <Link href="/studio/create" className="btnPrimary">Generate your first episode</Link>
        </div>
      ) : (
        <div className="boardGrid">
          {cards.map((c) => (
            <article key={c.id} className="studioCard boardCard">
              <div className="boardCardTop">
                <span className="chip">{c.sport}</span>
                <span className={`heatBadge heat-${c.tier.key}`} title={`Debate heat ${c.heat} of 100`}>
                  <FlameIcon />
                  <span className="heatLabel">{c.tier.label}</span>
                  <span className="heatScore" aria-label={`heat ${c.heat} of 100`}>{c.heat}</span>
                </span>
              </div>

              <h3 className="epTitle boardCardTitle">{c.title}</h3>

              {c.whyNow && (
                <p className="boardWhy">
                  <span className="boardWhyLabel">Why now</span>
                  {c.whyNow}
                </p>
              )}

              <div className="boardCardFoot">
                <Link href={`/studio/create?topic=${c.id}`} className="btnPrimary boardGenBtn">
                  Generate Episode
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* ---------------- Recent episodes strip ----------------------------- */}
      <div className="sectionHead">
        <h2 className="sectionTitle">Recent episodes</h2>
        <Link href="/studio/episodes" className="sectionAction">Full library →</Link>
      </div>

      {recentEpisodes.length === 0 ? (
        <div className="emptyNote">
          No episodes yet — your first one lands here the moment you generate it.
        </div>
      ) : (
        <div className="boardStrip">
          {recentEpisodes.map((ep) => {
            const chip = statusChip(ep.status);
            const isLive = ep.status === "published";
            const isReady = FINISHED_STATUSES.includes(ep.status) && !!ep.audioUrl;
            const tone = isLive ? "live" : isReady ? "ok" : ep.status === "failed" ? "err" : "warn";
            return (
              <Link key={ep.id} href={`/studio/episodes/${ep.id}`} className="studioCard boardEpCard clickable">
                <span className={`statusPill statusPill--${tone}`}>{chip.label}</span>
                <span className="boardEpTitle">{ep.title}</span>
                <span className="boardEpMeta">
                  {isReady && <span>{fmtDuration(ep.durationSeconds)}</span>}
                  {isReady && <span aria-hidden="true">·</span>}
                  <span>{fmtDate(ep.updatedAt)}</span>
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
