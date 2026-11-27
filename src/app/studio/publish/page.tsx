import React from "react";
import StudioPageHeader from "../StudioPageHeader";
import Link from "next/link";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { ownerScope } from "@/lib/ownerScope";
import { isOwnerAccount } from "@/lib/services/entitlementService";
import { validateEpisodeForRss } from "@/lib/services/rssPublishingService";
import { getEpisodeTranscriptVM } from "@/lib/services/transcriptView";
import { fmtDate, fmtDuration, statusChip, bustAudioUrl } from "../lib";
import { PlayButton } from "../StudioAudio";
import Pager from "../Pager";
import "../library.css";

export const dynamic = "force-dynamic";

// ponytail: the release gate is read per episode (validateEpisodeForRss loads
// the script, its audio rows and hosts; the claims gate loads the transcript).
// There is no batched form of either service, so the queue is paginated at 8
// instead. Upgrade path: a batch entry point in rssPublishingService.
const PAGE_SIZE = 8;

/** Post-audio, not yet live: the episodes a release decision applies to. */
const QUEUE_STATUSES = ["audio_ready", "content_generating", "content_ready", "publish_ready"];

type GateChecks = Awaited<ReturnType<typeof validateEpisodeForRss>>["checks"];

/**
 * One line per requirement the release gate enforces. This table only NAMES
 * the gate's own check keys and says where each is fixed; whether a
 * requirement is met is read from validateEpisodeForRss().checks, never
 * re-derived here. The Record type makes a new gate check a compile error
 * until it is listed.
 */
const REQUIREMENTS: Record<keyof GateChecks, { label: string; fix: string | null; where: string }> = {
  scriptExists: { label: "Script exists", fix: "#transcript", where: "Script" },
  scriptApproved: { label: "Script approved", fix: "#transcript", where: "Script" },
  factCheckPassed: { label: "Fact check passed", fix: "#transcript", where: "Script" },
  gamblingComplianceOk: { label: "Responsible-gambling requirement (betting content)", fix: "#publish", where: "Release" },
  allAudioSegmentsReady: { label: "Every line voiced", fix: "#produce", where: "Audio and mix" },
  episodeAudioUrlExists: { label: "Final mix exists", fix: "#produce", where: "Audio and mix" },
  episodeDurationValid: { label: "Duration recorded", fix: "#produce", where: "Audio and mix" },
  audioFileSizeResolved: { label: "Audio file size known", fix: "#produce", where: "Audio and mix" },
  audioMimeTypeValid: { label: "Audio is an MP3", fix: "#produce", where: "Audio and mix" },
  noPlaceholderVoice: { label: "Every host has a real voice", fix: "/studio/hosts", where: "Talent" },
  episodeTitleExists: { label: "Title", fix: "#publish", where: "Release" },
  episodeLongShowNotesExists: { label: "Show notes", fix: "#publish", where: "Release" },
  episodeTranscriptUrlExists: { label: "Transcript file", fix: "#publish", where: "Release" },
  noPlaceholderMetadata: { label: "No placeholder text in the title, description or notes", fix: "#publish", where: "Release" },
  episodeStatusValid: { label: "Packaged for release", fix: "#publish", where: "Release" },
  episodeExists: { label: "Episode linked to its script", fix: null, where: "" },
  rssGuidValid: { label: "Feed identifier", fix: null, where: "" },
  podcastConfigValid: { label: "Feed settings (set by whoever runs this deployment)", fix: null, where: "" },
};

interface Item { state: "blocker" | "warning"; label: string; detail?: string; fix: string | null; where: string }

export default async function PublishPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  // Owner-scoped. This page used to read every account's finished episodes.
  const user = await currentUser();
  const scope = ownerScope(user);
  const requestedPage = Math.max(1, Math.floor(Number((await searchParams).page)) || 1);

  const queueWhere = { AND: [scope, { status: { in: QUEUE_STATUSES } }] };
  const queueTotal = await db.episode.count({ where: queueWhere });
  const pageCount = Math.max(1, Math.ceil(queueTotal / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);

  const [queue, published] = await Promise.all([
    db.episode.findMany({
      where: queueWhere,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, title: true, status: true, durationSeconds: true, audioUrl: true, updatedAt: true,
        rssImageUrl: true, description: true, rssSummary: true,
        podcast: { select: { name: true } },
        scripts: { orderBy: { version: "desc" }, take: 1, select: { id: true } },
      },
    }),
    db.episode.findMany({
      where: { AND: [scope, { status: "published" }] },
      orderBy: { publishedAt: "desc" },
      take: 12,
      select: { id: true, title: true, durationSeconds: true, publishedAt: true, updatedAt: true },
    }),
  ]);

  // The gate, read-only, for the episodes on this page only.
  const cards = await Promise.all(queue.map(async (ep) => {
    const scriptId = ep.scripts[0]?.id ?? null;
    const items: Item[] = [];
    let met: string[] = [];
    let gateReasons: string[] = [];
    let canPublish = false;
    let gateError: string | null = null;

    if (!scriptId) {
      items.push({ state: "blocker", label: "There is no script yet", fix: "#transcript", where: "Script" });
    } else {
      try {
        // Validate the action the Publish button will actually perform, the
        // same choice getPublishState makes: a content_ready episode is
        // promoted by the button itself, so it is checked as "prepare".
        const [gate, vm] = await Promise.all([
          validateEpisodeForRss(scriptId, ep.status === "content_ready" ? "prepare" : "publish"),
          getEpisodeTranscriptVM(ep.id),
        ]);
        canPublish = !!gate.eligible;
        gateReasons = gate.errorReasons ?? [];
        for (const key of Object.keys(REQUIREMENTS) as (keyof GateChecks)[]) {
          const req = REQUIREMENTS[key];
          if (gate.checks[key]) met.push(req.label);
          else items.push({ state: "blocker", label: req.label, fix: req.fix, where: req.where });
        }
        // The claims gate. The transcript's own Publish refuses on it; the
        // release gate above only requires a passed fact check. So when the
        // fact check HAS passed and claims are still open, it is shown as a
        // warning, not dressed up as a blocker the Release button enforces.
        if (vm.ok && !vm.gate.canPublish) {
          const open = [
            vm.gate.unresolvedCount > 0 ? `${vm.gate.unresolvedCount} unresolved claim${vm.gate.unresolvedCount === 1 ? "" : "s"}` : "",
            vm.gate.dirtyCount > 0 ? `${vm.gate.dirtyCount} edited line${vm.gate.dirtyCount === 1 ? "" : "s"} not re-checked` : "",
          ].filter(Boolean).join(", ");
          if (open) {
            items.push({
              state: gate.checks.factCheckPassed ? "warning" : "blocker",
              label: "Claims review",
              detail: open,
              fix: "#transcript",
              where: "Script",
            });
          }
        } else if (vm.ok) {
          met.push("Claims review");
        }
      } catch (err) {
        gateError = (err as Error)?.message || "unknown error";
        met = [];
      }
    }

    // Not gate requirements: stored fields that are simply empty.
    if (!ep.rssImageUrl) items.push({ state: "warning", label: "No episode cover art", detail: "Not required by the release gate.", fix: "#publish", where: "Release" });
    if (!(ep.rssSummary || ep.description)) items.push({ state: "warning", label: "No episode summary", detail: "Not required by the release gate.", fix: "#publish", where: "Release" });

    return { ep, items, met, gateReasons, canPublish, gateError };
  }));

  const feedUrl = process.env.PODCAST_RSS_URL || "/rss";

  return (
    <div className="fadeUp">
      <StudioPageHeader
        title="Publishing"
        subtitle="What each finished episode still needs before it can go on the feed."
        status={<span className="sectionCount">{queueTotal.toLocaleString()} waiting</span>}
      />

      <div className="studioCard pubBar mb-6">
        <div>
          <div className="u-semibold mb-1">Public feed</div>
          <div className="pubFeedUrl">{feedUrl}</div>
        </div>
        <div className="pubActions">
          <a href="/rss" target="_blank" rel="noopener noreferrer" className="btnGhost">Open RSS</a>
          {!!user && isOwnerAccount(user) && <Link href="/admin/rss" className="btnGhost">Feed console</Link>}
        </div>
      </div>

      <div className="sectionHead"><h2 className="sectionTitle">Waiting to go live</h2></div>
      {cards.length === 0 ? (
        <div className="emptyNote">Nothing is waiting. An episode appears here once its audio is mixed, with the list of what it needs to be released.</div>
      ) : (
        <div className="relList">
          {cards.map(({ ep, items, met, gateReasons, canPublish, gateError }) => {
            const href = `/studio/episodes/${ep.id}`;
            const blockers = items.filter((i) => i.state === "blocker");
            const warnings = items.filter((i) => i.state === "warning");
            const fixHref = (fix: string) => (fix.startsWith("#") ? `${href}${fix}` : fix);
            return (
              <article className="relCard" key={ep.id} data-state={gateError ? "unknown" : canPublish ? "ready" : "blocked"} aria-label={ep.title}>
                <header className="relHead">
                  {ep.audioUrl && (
                    <PlayButton
                      className="playBtn playBtn--sm"
                      track={{ id: ep.id, src: bustAudioUrl(ep.audioUrl, ep.updatedAt), title: ep.title, subtitle: ep.podcast?.name ?? undefined, href }}
                    />
                  )}
                  <div className="relWhat">
                    <Link href={href} className="relTitle">{ep.title}</Link>
                    <span className="relMeta">
                      {ep.podcast?.name ?? "Standalone episode"} · {statusChip(ep.status).label} · {fmtDuration(ep.durationSeconds)}
                    </span>
                  </div>
                  <div className="relVerdict">
                    {gateError ? (
                      <span className="factPill fact-warn"><span className="factGlyph" aria-hidden="true">!</span>Could not check</span>
                    ) : canPublish ? (
                      <span className="factPill fact-ok"><span className="factGlyph" aria-hidden="true">✓</span>Ready to publish</span>
                    ) : (
                      <span className="factPill fact-err"><span className="factGlyph" aria-hidden="true">✕</span>{blockers.length} blocker{blockers.length === 1 ? "" : "s"}</span>
                    )}
                    <Link href={`${href}#publish`} className={canPublish ? "btnPrimary btnSm" : "btnGhost btnSm"}>
                      {canPublish ? "Review and publish" : "Open release"}
                    </Link>
                  </div>
                </header>

                {gateError && <p className="relNote">Could not check release readiness: {gateError}</p>}

                {items.length > 0 && (
                  <ul className="relItems">
                    {[...blockers, ...warnings].map((item, i) => (
                      <li key={i} className="relItem" data-state={item.state}>
                        <span className="relGlyph" aria-hidden="true">{item.state === "blocker" ? "✕" : "!"}</span>
                        <span className="relItemText">
                          <span className="relItemKind">{item.state === "blocker" ? "Blocker" : "Warning"}</span>
                          {item.label}
                          {item.detail && <span className="relItemDetail">{item.detail}</span>}
                        </span>
                        {item.fix && <Link href={fixHref(item.fix)} className="btnSubtle btnSm">Fix in {item.where}</Link>}
                      </li>
                    ))}
                  </ul>
                )}

                {gateReasons.length > 0 && (
                  <details className="relDetails">
                    <summary>What the release gate reported ({gateReasons.length})</summary>
                    <ul>
                      {gateReasons.slice(0, 20).map((r, i) => <li key={i}>{r}</li>)}
                      {gateReasons.length > 20 && <li>and {gateReasons.length - 20} more. Open the episode to see them all.</li>}
                    </ul>
                  </details>
                )}
                {met.length > 0 && (
                  <details className="relDetails">
                    <summary>{met.length} requirement{met.length === 1 ? "" : "s"} met</summary>
                    <ul className="relMet">
                      {met.map((label) => <li key={label}><span aria-hidden="true">✓ </span>{label}</li>)}
                    </ul>
                  </details>
                )}
              </article>
            );
          })}
        </div>
      )}
      <Pager page={page} pageCount={pageCount} total={queueTotal} noun="episodes waiting" hrefFor={(p) => (p > 1 ? `/studio/publish?page=${p}` : "/studio/publish")} />

      <div className="sectionHead"><h2 className="sectionTitle">Live on the feed</h2></div>
      {published.length === 0 ? (
        <div className="emptyNote">No published episodes yet. Your first release will show here.</div>
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
