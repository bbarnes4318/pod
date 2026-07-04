import React from "react";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { stripAudioTags } from "@/lib/audio/speechText";
import { accentFor } from "../../accent";
import { emojiForTitle, fmtMin, fmtDay, friendlyStage } from "../../lib";
import EpisodeDetail, { DetailChapter, DetailSegment } from "./EpisodeDetail";

export const dynamic = "force-dynamic";

// Gap estimates mirroring assembly defaults — chapter starts are close
// approximations (the exact stitched timeline isn't persisted).
const GAP = { none: 80, beat: 300, breath: 650, long: 1100, segment: 850, topic: 1200 } as const;

export default async function UserEpisodePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const episode = await db.episode.findUnique({
    where: { id },
    include: { scripts: { orderBy: { version: "desc" }, take: 1, select: { id: true, content: true } } },
  }).catch(() => null);
  if (!episode) notFound();

  const script = episode.scripts[0] ?? null;
  const segments: any[] = (script?.content as any)?.segments ?? [];
  const audioSegments = script
    ? await db.audioSegment.findMany({ where: { scriptId: script.id }, select: { lineIndex: true, durationMs: true } }).catch(() => [])
    : [];
  const durByLine = new Map(audioSegments.map((s) => [s.lineIndex, s.durationMs || 4000]));

  // Approximate chapter timeline
  const chapters: (DetailChapter & { _ms: number })[] = [];
  let cursor = 0;
  segments.forEach((seg, segIdx) => {
    if (segIdx > 0) cursor += seg.type === "topic" ? GAP.topic : GAP.segment;
    chapters.push({ title: seg.title || seg.type, startFrac: 0, startSec: 0, _ms: cursor });
    (seg.lines || []).forEach((line: any, li: number) => {
      if (li > 0) {
        const pb = line.pauseBefore as keyof typeof GAP;
        cursor += line.isInterruption ? -200 : GAP[pb] ?? GAP.beat;
        if (cursor < 0) cursor = 0;
      }
      cursor += durByLine.get(line.lineIndex) ?? 4000;
    });
  });
  const totalMs = Math.max(1, cursor);
  const chaptersOut: DetailChapter[] = chapters.map((c) => ({
    title: c.title,
    startFrac: Math.min(0.999, c._ms / totalMs),
    startSec: Math.round((episode.durationSeconds || totalMs / 1000) * (c._ms / totalMs)),
  }));

  const transcript: DetailSegment[] = segments.map((seg) => ({
    title: seg.title || seg.type,
    lines: (seg.lines || []).map((l: any) => ({
      speaker: l.speakerName === "Dr. Linebreak" ? ("DOC" as const) : ("MAX" as const),
      text: stripAudioTags(String(l.text || "")),
    })),
  }));

  const a = accentFor(episode.title);
  const emoji = emojiForTitle(episode.title);
  const stage = friendlyStage(episode.status);

  return (
    <>
      <div className="uTopbar">
        <h1 className="uPageTitle" style={{ fontSize: "1.15rem", color: "var(--u-ink-2)", fontWeight: 650 }}>
          Episode
        </h1>
      </div>
      <EpisodeDetail
        track={
          episode.audioUrl
            ? { id: episode.id, title: episode.title, audioUrl: episode.audioUrl, accentSolid: a.solid, accentSoft: a.soft, coverEmoji: emoji }
            : null
        }
        emoji={emoji}
        accent={{ solid: a.solid, soft: a.soft, tint: a.tint, deep: a.deep }}
        meta={["Max Voltage & Dr. Linebreak", fmtMin(episode.durationSeconds), fmtDay(episode.updatedAt)]}
        title={episode.title}
        chapters={episode.audioUrl ? chaptersOut : []}
        transcript={transcript}
        stageLabel={episode.audioUrl ? null : stage.label}
      />
    </>
  );
}
