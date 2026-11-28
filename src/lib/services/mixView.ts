// Mix / timeline view-model for an episode. Surfaces the REAL per-line audio
// (AudioSegment rows) plus the REAL sound-design plan (the ProductionPlan cue
// sheet the stitcher persists) so the UI can draw a dialogue lane, a music-bed
// lane, and cue markers. Nothing here synthesizes or mocks audio.

import { db } from "@/lib/db";
import { measuredFromJobOutput, type MixMeasuredVM } from "@/lib/audio/measuredQa";

export type { MixMeasuredVM };
import { parseEpisodeSoundDesign } from "@/lib/audio/soundDesignShared";
import { jobOutputFile, layoutLines } from "@/lib/audio/mixLayout";


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
  /** How this line is voiced: its own clip, inside a performed scene, or not at all. */
  voicedBy: "line" | "scene" | null;
  /** The selected scene recording that performs this line, if any. */
  sceneIndex: number | null;
  /** true when startMs/durationMs are estimated rather than measured. */
  approx: boolean;
}

/** A selected, ready scene recording (DialogueSceneAudio). Its duration is real. */
export interface MixSceneVM {
  sceneIndex: number;
  firstLineIndex: number;
  lastLineIndex: number;
  startMs: number;
  durationMs: number;
  /** provider_timestamps | forced_alignment | stt_alignment | timing_unavailable */
  timingStatus: string;
  /** How many candidate takes exist for this scene (ready ones). */
  candidates: number;
  engine: string;
}

/** A finished render of the episode (EpisodeAudioRender, succeeded). */
export interface MixRenderVM {
  renderVersion: number;
  renderMode: string;
  productionStyle: string | null;
  completedAt: string | null;
  /** This render's file is the one Episode.audioUrl points at (played here, and public once published). */
  isCurrent: boolean;
  /** Measured by ffmpeg on THIS render's file; null when its job record carried none. */
  measured: MixMeasuredVM | null;
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
  /** Where the dialogue audio lives: per-line clips, performed scenes, both, or none yet. */
  voicing: "none" | "lines" | "scenes" | "mixed";
  scenes: MixSceneVM[];
  /** Newest first, at most 5. */
  renders: MixRenderVM[];
  /** A finished render newer than the one being played exists (e.g. a re-mix of a
   *  published episode that has not been re-published yet). */
  newerRenderPending: boolean;
  /** Lines whose text changed after they were voiced (need re-voicing). */
  staleLines: number;
  /**
   * MEASURED by ffmpeg (ebur128 / silencedetect) on the rendered master, read
   * from the render's own job record — ONLY the job whose output file is the
   * one being played (episodeAudioUrl). Null otherwise: a measurement of an
   * older, newer or failed render is never shown against this file.
   */
  measured: MixMeasuredVM | null;
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
    voicing: "none",
    scenes: [],
    renders: [],
    newerRenderPending: false,
    staleLines: 0,
    measured: null,
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

  // Real audio, from BOTH places it can live: per-line clips (AudioSegment) and
  // performed scenes (DialogueSceneAudio, the selected ready take per scene).
  // Reading only AudioSegment calls a scene-voiced episode empty.
  const [segRows, sceneRows] = await Promise.all([
    db.audioSegment.findMany({
      where: { scriptId: script.id },
      select: { lineIndex: true, status: true, audioUrl: true, durationMs: true },
    }),
    db.dialogueSceneAudio.findMany({
      where: { scriptId: script.id, status: "ready" },
      select: { sceneIndex: true, firstLineIndex: true, lastLineIndex: true, lineIndexes: true, durationMs: true, timingStatus: true, timingMap: true, selected: true, provider: true, model: true, audioUrl: true },
    }),
  ]);
  const audioByLine = new Map<number, { status: string; audioUrl: string | null; durationMs: number | null }>();
  for (const s of segRows) audioByLine.set(s.lineIndex, { status: s.status, audioUrl: s.audioUrl, durationMs: s.durationMs });
  base.segments = layoutLines(rawSegments, audioByLine, sceneRows);
  const allLines = base.segments.flatMap((s) => s.lines);
  const scenesOut = new Map<number, MixSceneVM>();
  for (const r of sceneRows) {
    if (!r.selected || !r.audioUrl) continue;
    const first = allLines.find((l) => l.sceneIndex === r.sceneIndex);
    scenesOut.set(r.sceneIndex, {
      sceneIndex: r.sceneIndex, firstLineIndex: r.firstLineIndex, lastLineIndex: r.lastLineIndex,
      startMs: first?.startMs ?? 0, durationMs: r.durationMs ?? 0, timingStatus: r.timingStatus,
      candidates: sceneRows.filter((x) => x.sceneIndex === r.sceneIndex).length, engine: `${r.provider} ${r.model}`.trim(),
    });
  }
  base.scenes = [...scenesOut.values()].sort((a, b) => a.sceneIndex - b.sceneIndex);
  const last = allLines[allLines.length - 1];
  base.totalMs = Math.max(1, last ? last.startMs + last.durationMs : 1, ...base.scenes.map((s) => s.startMs + s.durationMs));
  const byLine = allLines.filter((l) => l.voicedBy === "line").length;
  const byScene = allLines.filter((l) => l.voicedBy === "scene").length;
  base.fullyVoiced = allLines.length > 0 && byLine + byScene === allLines.length;
  base.voicing = byLine && byScene ? "mixed" : byScene ? "scenes" : byLine ? "lines" : "none";
  base.staleLines = allLines.filter((l) => l.dirty && l.hasAudio).length;

  // Real cue sheet: pull the ProductionPlan the stitcher persisted in the latest
  // audio:stitch-final / audio:regenerate-line JobLog for this script.
  const startByLine = new Map<number, number>();
  for (const seg of base.segments) for (const l of seg.lines) startByLine.set(l.lineIndex, l.startMs);
  try {
    // Scoped to this script in the query (JSON path filter) instead of scanning
    // the latest 25 logs across every episode; failed runs (whose output has no
    // plan) are skipped.
    const [logs, renders] = await Promise.all([
      db.jobLog.findMany({
        where: {
          jobType: { in: ["audio:stitch-final", "audio:regenerate-line"] },
          status: { in: ["completed", "completed_with_errors"] },
          input: { path: ["scriptId"], equals: script.id },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { output: true, createdAt: true },
      }),
      db.episodeAudioRender.findMany({
        where: { episodeId: episode.id, status: "succeeded" },
        orderBy: { renderVersion: "desc" },
        take: 5,
        select: { renderVersion: true, renderMode: true, productionStyle: true, completedAt: true, outputAudioUrl: true },
      }),
    ]);
    // Every measurement and cue sheet is keyed by the FILE its job produced.
    const byFile = new Map<string, { output: unknown; createdAt: Date }>();
    for (const l of logs) { const f = jobOutputFile(l.output); if (f && !byFile.has(f)) byFile.set(f, l); }
    const forFile = (f: string | null) => (f ? byFile.get(f) ?? null : null);
    const match = forFile(episode.audioUrl);
    base.measured = match ? measuredFromJobOutput(match.output, match.createdAt) : null;
    base.renders = renders.map((r) => {
      const j = forFile(r.outputAudioUrl);
      return {
        renderVersion: r.renderVersion, renderMode: r.renderMode, productionStyle: r.productionStyle,
        completedAt: r.completedAt?.toISOString() ?? null,
        isCurrent: !!r.outputAudioUrl && r.outputAudioUrl === episode.audioUrl,
        measured: j ? measuredFromJobOutput(j.output, j.createdAt) : null,
      };
    });
    const currentIdx = base.renders.findIndex((r) => r.isCurrent);
    base.newerRenderPending = currentIdx > 0;
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
