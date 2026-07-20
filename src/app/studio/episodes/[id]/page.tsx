import React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { qualityOf, fmtDuration, fmtDate, statusChip, nextActionFor } from "../../lib";
import { getEpisodeTranscriptVM } from "@/lib/services/transcriptView";
import { getEpisodeMixVM } from "@/lib/services/mixView";
import StudioPlayer, { PlayerChapter, HostSpan } from "./StudioPlayer";
import EpisodeWorkspace, { WorkspaceTab } from "./EpisodeWorkspace";
import TranscriptWorkspace from "../../TranscriptWorkspace";
import MixView from "../../MixView";
import EpisodeDiversityPanel from "./EpisodeDiversityPanel";
import PublishPanel from "../../PublishPanel";
import AdvancedProducer, { AppliedVoice } from "../../AdvancedProducer";
import SocialClipPanel from "../../SocialClipPanel";
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
  const action = nextActionFor(episode, script?.id);

  // ---- Overview tab: quality breakdown + quick actions (the calm landing) ----
  const overviewNode = (
    <div className="grid2">
      {q ? (
        <div className="studioCard">
          <div className="sectionTitle" style={{ marginBottom: "0.9rem" }}>Quality breakdown</div>
          {Object.entries(q.axes).map(([axis, v]) => (
            <div key={axis} className="axisRow">
              <span style={{ textTransform: "capitalize" }}>{axis}</span>
              <div className="scoreBarTrack">
                <div className="scoreBarFill" style={{ width: `${(v.score / v.max) * 100}%` }} />
              </div>
              <strong>{v.score}/{v.max}</strong>
            </div>
          ))}
          <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.9rem" }}>
            Want it higher? Regenerate the script — the gate keeps only stronger output.
          </div>
        </div>
      ) : (
        <div className="studioCard">
          <div className="sectionTitle" style={{ marginBottom: "0.6rem" }}>Where this episode stands</div>
          <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>
            This episode is in the <strong style={{ color: "var(--text)" }}>{action.stage.toLowerCase()}</strong> stage.
            Use the tabs above to edit the transcript, produce the audio, or publish once it&apos;s ready.
          </p>
        </div>
      )}

      <div className="studioCard">
        <div className="sectionTitle" style={{ marginBottom: "0.9rem" }}>Quick actions</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {bustedAudioUrl && (
            <a href={bustedAudioUrl} download className="btnGhost">⬇ Download MP3</a>
          )}
          <Link href="/rss" className="btnGhost">🔗 Public RSS feed</Link>
          {/* Ops-level shortcuts — kept reachable but visually secondary */}
          {script && (
            <details className="epOpsDetails">
              <summary>Advanced / ops shortcuts</summary>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", marginTop: "0.7rem" }}>
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
        <div style={{ display: "flex", flexDirection: "column", gap: "1.75rem" }}>
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
              <div className="sectionHead" style={{ marginTop: 0 }}>
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
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1.5rem", flexWrap: "wrap", marginBottom: "1.5rem" }}>
        <div style={{ minWidth: 0, maxWidth: 760 }}>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.6rem" }}>
            <span className={`chip ${chip.kind === "accent" ? "chipAccent" : chip.kind === "success" ? "chipSuccess" : ""}`}>{chip.label}</span>
            <span className="chip">{fmtDuration(episode.durationSeconds)}</span>
            <span className="chip">{fmtDate(episode.updatedAt)}</span>
          </div>
          <h1 className="pageTitle" style={{ marginBottom: 0 }}>{episode.title}</h1>
        </div>
        {q && (
          <div className="studioCard" style={{ padding: "0.9rem 1.2rem", textAlign: "center" }}>
            <div className="scoreBadge" style={{ fontSize: "2.2rem" }}>{q.total}<small> /100</small></div>
            <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", marginTop: 2 }}>episode quality</div>
          </div>
        )}
      </div>

      {episode.audioUrl ? (
        <StudioPlayer
          episodeId={episode.id}
          audioUrl={bustedAudioUrl!}
          title={episode.title}
          chapters={chaptersFrac}
          hostSpans={hostSpans}
          hostNames={[hostA.name, hostB.name]}
        />
      ) : (
        <div className="studioCard" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>No audio yet</div>
            <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>This episode is still in the {action.stage.toLowerCase()} stage.</div>
          </div>
          <Link href={action.href} className="btnPrimary">{action.label} →</Link>
        </div>
      )}

      {/* ---- Everything else, organized into one focused tab at a time ---- */}
      <div style={{ marginTop: "1.75rem" }}>
        <EpisodeWorkspace tabs={tabs} />
      </div>
    </div>
  );
}
