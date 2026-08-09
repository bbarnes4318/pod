import React from "react";
import StudioPageHeader from "../../StudioPageHeader";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { qualityOf, fmtDuration, fmtDate, statusChip, nextActionFor } from "../../lib";
import { getEpisodeTranscriptVM } from "@/lib/services/transcriptView";
import { getEpisodeMixVM } from "@/lib/services/mixView";
import StudioPlayer, { PlayerChapter, HostSpan } from "./StudioPlayer";
import EpisodeWorkspace, { WorkspaceTab } from "./EpisodeWorkspace";
import EditorialGatePanel from "./EditorialGatePanel";
import RoleTracePanel from "./RoleTracePanel";
import TranscriptWorkspace from "../../TranscriptWorkspace";
import MixView from "../../MixView";
import EpisodeDiversityPanel from "./EpisodeDiversityPanel";
import PublishPanel from "../../PublishPanel";
import AdvancedProducer, { AppliedVoice } from "../../AdvancedProducer";
import SocialClipPanel from "../../SocialClipPanel";
import ProductionConsole from "../../ProductionConsole";
import StartDebateButton from "./StartDebateButton";
import { getCreateProgressVM } from "@/lib/services/createProgress";
import { DEFAULT_PAUSE_MS, DEFAULT_SEGMENT_GAP_MS, DEFAULT_TOPIC_GAP_MS } from "@/lib/audio/pauseTiming";

export const dynamic = "force-dynamic";

// Gap estimates mirroring the assembly defaults — the exact stitched
// timeline isn't persisted, so chapter/host positions are close
// approximations (within ~a second on a typical episode).
const GAP = { ...DEFAULT_PAUSE_MS, segment: DEFAULT_SEGMENT_GAP_MS, topic: DEFAULT_TOPIC_GAP_MS };

export default async function EpisodePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const episode = await db.episode.findUnique({
    where: { id },
    include: {
      scripts: { orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!episode) notFound();

  const script = episode.scripts[0] ?? null;
  const q = qualityOf(script);
  const segments: any[] = (script?.content as any)?.segments ?? [];

  // Cache-bust the audio URL with the episode's updatedAt. Every re-mix
  // OVERWRITES the same deterministic storage key (…/final/…-v1.mp3), so the
  // URL never changes — and the browser/player happily replays the first
  // cached copy, which is why a re-mixed episode can sound identical forever
  // even though the S3 bytes changed. updatedAt advances on every stitch, so
  // this forces a fresh fetch of exactly the render that just completed.
  const bustedAudioUrl = episode.audioUrl
    ? `${episode.audioUrl}${episode.audioUrl.includes("?") ? "&" : "?"}v=${Math.floor(new Date(episode.updatedAt).getTime() / 1000)}`
    : null;

  // Editable transcript + citations + fact-check view-model (real data).
  const transcriptVm = script ? await getEpisodeTranscriptVM(id) : null;
  // Mix / timeline view-model (real per-line audio + sound-design plan).
  const mixVm = script ? await getEpisodeMixVM(id) : null;

  const audioSegments = script
    ? await db.audioSegment.findMany({ where: { scriptId: script.id }, select: { lineIndex: true, durationMs: true, hostId: true } })
    : [];
  const durByLine = new Map(audioSegments.map((s) => [s.lineIndex, s.durationMs || 4000]));

  // The two-host cast for coloring comes from THIS episode's real, resolved
  // cast (mixVm resolves Episode.hostIds, highest-intensity first) — never a
  // hardcoded host name. Neutral fallback only if the episode has no cast yet.
  const hostA = mixVm?.hostA ?? { id: null as string | null, name: "Host 1" };
  const hostB = mixVm?.hostB ?? { id: null as string | null, name: "Host 2" };

  // ---- Advanced Producer: the APPLIED (persisted) producer settings ----
  // findUnique (include, not select) returns all scalar Episode fields, so the
  // real persisted inputs are already on `episode`.
  const soundDesign = (episode.soundDesign as any) || {};
  const appliedStyle: string | null = typeof soundDesign.style === "string" ? soundDesign.style : null;
  const appliedDensity: string | null = typeof soundDesign.sfxDensity === "string" ? soundDesign.sfxDensity : null;
  const voiceOverrides = (episode.ttsVoiceOverrides as Record<string, any>) || {};
  const overrideKeys = Object.keys(voiceOverrides);
  const overrideHosts = overrideKeys.length
    ? await db.aiHost.findMany({
        where: { OR: [{ id: { in: overrideKeys } }, { slug: { in: overrideKeys } }] },
        select: { id: true, slug: true, name: true },
      })
    : [];
  const nameFor = (key: string) =>
    overrideHosts.find((h) => h.id === key || h.slug === key)?.name ?? key;
  const appliedVoices: AppliedVoice[] = overrideKeys
    .map((k) => ({ host: nameFor(k), provider: voiceOverrides[k]?.provider ?? "", voiceId: voiceOverrides[k]?.voiceId ?? "" }))
    .filter((v) => v.voiceId);
  // A re-mix re-splices already-voiced lines (the stitcher re-measures each
  // clip's duration itself), so it must NOT require every AudioSegment row to
  // carry a durationMs — some ready, playable rows legitimately don't. A
  // finished episode (has audioUrl) is always re-mixable; otherwise any voiced
  // line for this script version is enough.
  const canRemix = !!episode.audioUrl || audioSegments.length > 0;

  // ---- Build the approximate timeline for chapters + host strip ----
  const chapters: PlayerChapter[] = [];
  const rawSpans: { hostSlot: 0 | 1; startMs: number; endMs: number }[] = [];
  let cursor = 0;
  segments.forEach((seg, segIdx) => {
    if (segIdx > 0) cursor += seg.type === "topic" ? GAP.topic : GAP.segment;
    chapters.push({
      title: seg.title || seg.type,
      type: seg.type,
      startFrac: cursor, // convert to fraction after total is known
    });
    (seg.lines || []).forEach((line: any, li: number) => {
      if (li > 0) {
        const pb = line.pauseBefore as keyof typeof GAP;
        cursor += line.isInterruption ? -200 : GAP[pb] ?? GAP.beat;
        if (cursor < 0) cursor = 0;
      }
      const dur = durByLine.get(line.lineIndex) ?? 4000;
      // Slot the line to host B (blue) by matching THIS episode's cast — by
      // host id first, then by the cast's actual name — else host A (orange).
      const slot: 0 | 1 =
        line.speakerHostId && hostB.id && line.speakerHostId === hostB.id ? 1
        : hostB.name && line.speakerName === hostB.name ? 1 : 0;
      const prev = rawSpans[rawSpans.length - 1];
      if (prev && prev.hostSlot === slot && cursor - prev.endMs < 1500) {
        prev.endMs = cursor + dur;
      } else {
        rawSpans.push({ hostSlot: slot, startMs: cursor, endMs: cursor + dur });
      }
      cursor += dur;
    });
  });
  const totalMs = Math.max(1, cursor);
  const chaptersFrac = chapters.map((c) => ({ ...c, startFrac: Math.min(0.999, (c.startFrac as number) / totalMs) }));
  const hostSpans: HostSpan[] = rawSpans.map((s) => ({
    hostSlot: s.hostSlot,
    startFrac: s.startMs / totalMs,
    endFrac: Math.min(1, s.endMs / totalMs),
  }));

  const chip = statusChip(episode.status);
  const action = nextActionFor(episode);

  // Seed the production console server-side so it paints with real progress
  // instead of a skeleton.
  //
  // The console used to be the `else` branch of "is there audio yet" — which
  // meant the moment a master existed the pipeline went invisible, even though
  // show notes, chapters and cover art are still being written after it, and a
  // re-mix runs the mix stage again on an episode that already has audio. The
  // console is now the page's spine and runs alongside the player until the
  // pipeline is genuinely finished. The three terminal statuses are the ones
  // productionStageForStatus maps to "done", so skipping the read for them
  // costs a finished episode exactly what it cost before: nothing.
  const PIPELINE_FINISHED = new Set(["content_ready", "publish_ready", "published"]);
  const progressVm = PIPELINE_FINISHED.has(episode.status) ? null : await getCreateProgressVM(episode.id);
  const showConsole = !episode.audioUrl || (progressVm ? !progressVm.done : false);

  // ---- Overview tab: quality breakdown + quick actions (the calm landing) ----
  const overviewNode = (
    <div className="grid2">
      {q ? (
        <div className="studioCard">
          <div className="sectionTitle mb-4">Quality breakdown</div>
          {Object.entries(q.axes).map(([axis, v]) => (
            <div key={axis} className="axisRow">
              <span className="u-caps">{axis}</span>
              <div className="scoreBarTrack">
                <div className="scoreBarFill" style={{ "--bar-w": `${(v.score / v.max) * 100}%` } as React.CSSProperties} />
              </div>
              <strong>{v.score}/{v.max}</strong>
            </div>
          ))}
          <div className="epNoteSmall mt-4">
            Want it higher? Regenerate the script — the gate keeps only stronger output.
          </div>
        </div>
      ) : (
        <div className="studioCard">
          <div className="sectionTitle mb-3">Where this episode stands</div>
          <p className="epNote">
            This episode is in the <strong className="u-strong">{action.stage.toLowerCase()}</strong> stage.
            Use the tabs above to edit the transcript, produce the audio, or publish once it&apos;s ready.
          </p>
        </div>
      )}

      {/* The editorial verdict and the role-by-role writing trace, shown BEFORE
          any TTS money is spent. Until now both existed only inside
          Script.content JSON, so a producer clicking "Record voices" could not
          see that the script was held, or that it had been written by the
          emergency fallback rather than the creative pipeline. */}
      <EditorialGatePanel
        episodeId={episode.id}
        gate={(script?.content as any)?.editorialGate ?? null}
        provenance={(script?.content as any)?.pipelineProvenance ?? null}
        invariants={(script?.content as any)?.productionInvariants ?? null}
        humanRelease={(script?.content as any)?.humanRelease ?? null}
        legacyRelease={(script?.content as any)?.legacyRelease ?? null}
      />
      <RoleTracePanel trace={(script?.content as any)?.pipelineProvenance?.roleTrace ?? null} />

      <div className="studioCard">
        <div className="sectionTitle mb-4">Quick actions</div>
        <div className="epStack">
          {bustedAudioUrl && (
            <a href={bustedAudioUrl} download className="btnGhost">⬇ Download MP3</a>
          )}
          <Link href="/rss" className="btnGhost">🔗 Public RSS feed</Link>
          {/* Ops-level shortcuts — kept reachable but visually secondary */}
          {script && (
            <details className="epOpsDetails">
              <summary>Advanced / ops shortcuts</summary>
              <div className="epStack mt-3">
                {episode.status !== "published" && (
                  <Link href={`/admin/rss/${script.id}`} className="btnGhost">📡 Publish to feed (ops)</Link>
                )}
                <Link href={`/admin/final-audio/${script.id}`} className="btnGhost">🎛 Remix / regenerate audio</Link>
                <Link href={`/admin/scripts/${script.id}`} className="btnGhost">📝 Open script in ops</Link>
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );

  // ---- Assemble tabs, skipping any panel that has no data for this episode ----
  const tabs: WorkspaceTab[] = [
    { key: "overview", label: "Overview", hint: "Score & actions", node: overviewNode },
  ];
  if (transcriptVm && script) {
    tabs.push({
      key: "transcript",
      label: "Transcript",
      hint: "Edit & fact-check",
      node: (
        <TranscriptWorkspace episodeId={episode.id} initialVm={transcriptVm} showPublish canRevoice={mixVm?.fullyVoiced ?? false} />
      ),
    });
  }
  if (script) {
    tabs.push({
      key: "produce",
      label: "Produce",
      hint: "Voices & mix",
      node: (
        <div className="epStackWide">
          <AdvancedProducer
            episodeId={episode.id}
            canRemix={canRemix}
            appliedProvider={episode.ttsProvider ?? null}
            appliedVoices={appliedVoices}
            appliedStyle={appliedStyle}
            appliedDensity={appliedDensity}
          />
          {mixVm && (
            <div>
              <div className="sectionHead mt-0">
                <h2 className="sectionTitle">Mix & timeline</h2>
              </div>
              <MixView episodeId={episode.id} initialVm={mixVm} />
            </div>
          )}
          {/* PR 4: safe sound-diversity decisions for the latest render. */}
          <EpisodeDiversityPanel episodeId={episode.id} />
        </div>
      ),
    });
    tabs.push({
      key: "promote",
      label: "Promote",
      hint: "Social clip",
      node: <SocialClipPanel episodeId={episode.id} />,
    });
    tabs.push({
      key: "publish",
      label: "Publish",
      hint: "Assets & go live",
      node: <PublishPanel episodeId={episode.id} />,
    });
  }

  return (
    <div className="fadeUp">
      {/* ---- Anchor: identity, score, and the player stay fixed above the tabs ---- */}
      <StudioPageHeader
        title={episode.title}
        breadcrumb={[{ label: "Episodes", href: "/studio/episodes" }]}
        actions={
          q ? (
            <span title={`Episode quality ${q.total} out of 100`}>
              <span>{q.total}</span>
              <span>/100</span>
            </span>
          ) : undefined
        }
        status={
          <>
            <span className={`chip ${chip.kind === "accent" ? "chipAccent" : chip.kind === "success" ? "chipSuccess" : ""}`}>{chip.label}</span>
            <span>{fmtDuration(episode.durationSeconds)}</span>
            <span>{fmtDate(episode.updatedAt)}</span>
          </>
        }
      />

      {episode.audioUrl && (
        <StudioPlayer
          episodeId={episode.id}
          audioUrl={bustedAudioUrl!}
          title={episode.title}
          chapters={chaptersFrac}
          hostSpans={hostSpans}
          hostNames={[hostA.name, hostB.name]}
        />
      )}

      {/* The live rundown. It polls real pipeline state, so the page never needs
          a manual refresh to move forward, and the first read is done on the
          server so it paints already-populated. */}
      {showConsole && (
        <div className={episode.audioUrl ? "mt-6" : undefined}>
          <ProductionConsole episodeId={episode.id} initialVm={progressVm ?? undefined} />
        </div>
      )}

      {/* ---- Everything else, organized into one focused tab at a time ---- */}
      <div className="mt-6">
        <EpisodeWorkspace tabs={tabs} />
      </div>

      {/* ---- The action bar ----
          One place, always on screen, that says what this episode needs next.
          Before this the next step lived wherever that step's panel happened to
          be, so "what do I do now" was answered by scrolling. Sticky rather
          than fixed: it takes its own space at the end of the document, so it
          can never cover the last row of a panel. */}
      <div className="epActionBar" data-testid="episode-action-bar">
        <div className="epActionBarWhat">
          <span className="epActionBarStage">{action.stage}</span>
          <span className="epActionBarStatus">{chip.label}</span>
        </div>
        <div className="epActionBarDo">
          {bustedAudioUrl && (
            <a href={bustedAudioUrl} download className="btnGhost">Download MP3</a>
          )}
          {/* nextActionFor points some statuses at the episode page itself —
              which, ON that page, is a button that navigates nowhere. For an
              unstarted draft the honest control is the one that actually starts
              the work; for anything else already sitting on its own target,
              the console below is the answer and a second dead button is not. */}
          {action.href === `/studio/episodes/${episode.id}` ? (
            episode.status === "draft" && !script ? (
              <StartDebateButton episodeId={episode.id} />
            ) : null
          ) : (
            <Link href={action.href} className="btnPrimary" data-testid="episode-next-action">
              {action.label}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
