// Mix / timeline view-model for an episode. Surfaces the REAL per-line audio
// (AudioSegment rows) plus the REAL sound-design plan (the ProductionPlan cue
// sheet the stitcher persists) so the UI can draw a dialogue lane, a music-bed
// lane, and cue markers. Nothing here synthesizes or mocks audio.

import { db } from "@/lib/db";
import { parseEpisodeSoundDesign } from "@/lib/audio/soundDesignShared";
import { DEFAULT_PAUSE_MS, DEFAULT_SEGMENT_GAP_MS, DEFAULT_TOPIC_GAP_MS } from "@/lib/audio/pauseTiming";

// Gap model mirroring the stitch/assembly defaults so block positions line up
// with the rendered timeline within ~a second (same table the player uses).
const GAP: Record<string, number> = { ...DEFAULT_PAUSE_MS, segment: DEFAULT_SEGMENT_GAP_MS, topic: DEFAULT_TOPIC_GAP_MS };

export interface MixLineVM {
  lineIndex: number;
  speaker: string;
  textShort: string;
  startMs: number;
  durationMs: number;
  status: string; // AudioSegment status: pending | processing | ready | failed | (none)
  hasAudio: boolean;
  audioUrl: string | null;
  tone: string | null;
  energy: string | null;
  dirty: boolean;
}

export interface MixSegmentVM {
  title: string;
  type: string;
  lines: MixLineVM[];
}

export interface MixCueVM {
  type: string; // stinger | bed_change | reaction | intro | outro | silence | highlight_slot
  lineIndex: number;
  label: string;
  startMs: number;
}

export interface MixVM {
  ok: boolean;
  error?: string;
  scriptId: string | null;
  episodeStatus: string | null;
  episodeAudioUrl: string | null;
  durationSeconds: number | null;
  totalMs: number;
  hostA: { id: string | null; name: string };
  hostB: { id: string | null; name: string };
  /** Prompt 7: the FULL cast in seat order (1-4); hostA/hostB = first seats. */
  cast: Array<{ id: string | null; name: string }>;
  segments: MixSegmentVM[];
  bed: { present: boolean; style: string | null; sfxDensity: string | null };
  cues: MixCueVM[];
  /** True once every line has ready audio (a re-splice/line-regen is possible). */
  fullyVoiced: boolean;
}

/** Rough duration estimate for a not-yet-voiced line so its block still renders. */
function estimateMs(text: string): number {
  const words = (text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(900, Math.round((words / 2.6) * 1000)); // ~2.6 words/sec
}

export async function getEpisodeMixVM(episodeId: string): Promise<MixVM> {
  const empty = (error?: string): MixVM => ({
    ok: !error,
    error,
    scriptId: null,
    episodeStatus: null,
    episodeAudioUrl: null,
    durationSeconds: null,
    totalMs: 1,
    hostA: { id: null, name: "Host 1" },
    hostB: { id: null, name: "Host 2" },
    cast: [{ id: null, name: "Host 1" }, { id: null, name: "Host 2" }],
    segments: [],
    bed: { present: false, style: null, sfxDensity: null },
    cues: [],
    fullyVoiced: false,
  });

  const episode = await db.episode.findUnique({
    where: { id: episodeId },
    select: {
      id: true,
      status: true,
      audioUrl: true,
      durationSeconds: true,
      soundDesign: true,
      hostIds: true,
      scripts: { orderBy: { version: "desc" }, take: 1, select: { id: true, content: true } },
    },
  });
  if (!episode) return empty("Episode not found.");
  const script = episode.scripts[0] ?? null;
  const base = empty();
  base.scriptId = script?.id ?? null;
  base.episodeStatus = episode.status;
  base.episodeAudioUrl = episode.audioUrl;
  base.durationSeconds = episode.durationSeconds;

  const sd = parseEpisodeSoundDesign(episode.soundDesign);
  base.bed = {
    present: sd.style === "full", // a ducked music bed is only mixed in "full" style
    style: sd.style ?? null,
    sfxDensity: sd.sfxDensity ?? null,
  };

  const hostRows = episode.hostIds?.length
    ? await db.aiHost.findMany({ where: { id: { in: episode.hostIds } }, select: { id: true, name: true, intensityLevel: true } })
    : await db.aiHost.findMany({ where: { isActive: true, isArchived: false }, orderBy: { intensityLevel: "desc" }, take: 2, select: { id: true, name: true, intensityLevel: true } });
  const sorted = [...hostRows].sort((a, b) => b.intensityLevel - a.intensityLevel);
  if (sorted[0]) base.hostA = { id: sorted[0].id, name: sorted[0].name };
  if (sorted[1]) base.hostB = { id: sorted[1].id, name: sorted[1].name };
  const castSeats = (episode.hostIds?.length
    ? episode.hostIds.map((id) => hostRows.find((h) => h.id === id)).filter((h): h is NonNullable<typeof h> => !!h)
    : sorted
  ).map((h) => ({ id: h.id as string | null, name: h.name }));
  if (castSeats.length > 0) base.cast = castSeats;

  if (!script) return base;
  const content = (script.content as any) || {};
  const rawSegments: any[] = Array.isArray(content.segments) ? content.segments : [];

  // Real per-line audio.
  const segRows = await db.audioSegment.findMany({
    where: { scriptId: script.id },
    select: { lineIndex: true, status: true, audioUrl: true, durationMs: true },
  });
  const audioByLine = new Map<number, { status: string; audioUrl: string | null; durationMs: number | null }>();
  for (const s of segRows) audioByLine.set(s.lineIndex, { status: s.status, audioUrl: s.audioUrl, durationMs: s.durationMs });

  const segments: MixSegmentVM[] = [];
  let cursor = 0;
  let lineTotal = 0;
  let voicedLines = 0;
  rawSegments.forEach((seg: any, segIdx: number) => {
    if (segIdx > 0) cursor += seg?.type === "topic" ? GAP.topic : GAP.segment;
    const lines: MixLineVM[] = [];
    (seg?.lines || []).forEach((ln: any, li: number) => {
      const idx = typeof ln?.lineIndex === "number" ? ln.lineIndex : lineTotal;
      if (li > 0) {
        const pb = String(ln?.pauseBefore || "beat");
        cursor += ln?.isInterruption ? Math.max(0, -200) : GAP[pb] ?? GAP.beat;
      }
      const audio = audioByLine.get(idx);
      const dur = audio?.durationMs && audio.durationMs > 0 ? audio.durationMs : estimateMs(String(ln?.text || ""));
      const ready = audio?.status === "ready" && !!audio.audioUrl;
      if (ready) voicedLines++;
      lines.push({
        lineIndex: idx,
        speaker: String(ln?.speakerName || ""),
        textShort: String(ln?.text || "").slice(0, 120),
        startMs: cursor,
        durationMs: dur,
        status: audio?.status || "none",
        hasAudio: ready,
        audioUrl: ready ? audio!.audioUrl : null,
        tone: ln?.tone ?? null,
        energy: ln?.energy ?? null,
        dirty: ln?.dirty === true,
      });
      cursor += dur;
      lineTotal++;
    });
    segments.push({ title: String(seg?.title || seg?.type || "Segment"), type: String(seg?.type || "segment"), lines });
  });
  base.segments = segments;
  base.totalMs = Math.max(1, cursor);
  base.fullyVoiced = lineTotal > 0 && voicedLines === lineTotal;

  // Real cue sheet: pull the ProductionPlan the stitcher persisted in the latest
  // audio:stitch-final / audio:regenerate-line JobLog for this script.
  const startByLine = new Map<number, number>();
  for (const seg of segments) for (const l of seg.lines) startByLine.set(l.lineIndex, l.startMs);
  try {
    const logs = await db.jobLog.findMany({
      where: { jobType: { in: ["audio:stitch-final", "audio:regenerate-line"] } },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { input: true, output: true },
    });
    const match = logs.find((l) => (l.input as any)?.scriptId === script.id && (l.output as any));
    const plan = (match?.output as any)?.productionPlan || (match?.output as any)?.stitch?.productionPlan;
    const cues = Array.isArray(plan?.cues) ? plan.cues : [];
    base.cues = cues
      .filter((c: any) => c && typeof c.lineIndex === "number")
      .map((c: any) => ({
        type: String(c.type || "cue"),
        lineIndex: c.lineIndex,
        label: String(c.assetName || c.category || c.type || "cue"),
        startMs: startByLine.get(c.lineIndex) ?? 0,
      }));
  } catch {
    base.cues = [];
  }

  return base;
}
