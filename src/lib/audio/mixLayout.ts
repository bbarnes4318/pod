// Pure timeline layout for the mix view (no DB): where each line sits, which
// recording voices it, and which master file a job produced. Exported for tests.

import { DEFAULT_PAUSE_MS, DEFAULT_SEGMENT_GAP_MS, DEFAULT_TOPIC_GAP_MS } from "./pauseTiming";
import type { MixLineVM, MixSegmentVM } from "../services/mixView";

// Gap model mirroring the stitch/assembly defaults (same table the player uses).
const GAP: Record<string, number> = { ...DEFAULT_PAUSE_MS, segment: DEFAULT_SEGMENT_GAP_MS, topic: DEFAULT_TOPIC_GAP_MS };

/** Rough duration estimate for a not-yet-voiced line so its block still renders. */
export function estimateMs(text: string): number {
  const words = (text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(900, Math.round((words / 2.6) * 1000)); // ~2.6 words/sec
}
/** The master file a stitch / line-regen job produced (line regen nests it under stitch). */
export function jobOutputFile(output: unknown): string | null {
  const o = output as any;
  const f = o?.finalAudioUrl ?? o?.stitch?.finalAudioUrl;
  return typeof f === "string" && f ? f : null;
}

type SceneRow = { sceneIndex: number; firstLineIndex: number; lastLineIndex: number; lineIndexes: unknown; durationMs: number | null; timingStatus: string; timingMap: unknown; selected: boolean; audioUrl: string | null };

/**
 * Place every script line on the timeline. Pure (exported for the self-check).
 * - A line inside a SELECTED ready scene take is voiced by that scene. The scene
 *   occupies its REAL duration; lines inside it use the provider/alignment
 *   timing map when there is one (exact), otherwise share the scene's real
 *   length in proportion to their words (approximate, and marked so).
 * - Other lines use their own clip's real duration, or a word-count estimate.
 * - Gaps between lines/segments follow the stitcher's defaults (approximate).
 */
export function layoutLines(
  rawSegments: any[],
  audioByLine: Map<number, { status: string; audioUrl: string | null; durationMs: number | null }>,
  sceneRows: SceneRow[],
): MixSegmentVM[] {
  const sceneByLine = new Map<number, SceneRow>();
  for (const s of sceneRows) {
    if (!s.selected || !s.audioUrl || !s.durationMs) continue;
    const idxs = Array.isArray(s.lineIndexes) ? (s.lineIndexes as unknown[]).filter((n): n is number => typeof n === "number") : [];
    for (const i of idxs.length ? idxs : range(s.firstLineIndex, s.lastLineIndex)) sceneByLine.set(i, s);
  }
  // Word estimates for every line, so a scene's real length can be shared out.
  const est = new Map<number, number>();
  let n = 0;
  for (const seg of rawSegments) for (const ln of seg?.lines || []) { const idx = typeof ln?.lineIndex === "number" ? ln.lineIndex : n; est.set(idx, estimateMs(String(ln?.text || ""))); n++; }
  const sceneEst = new Map<SceneRow, number>();
  for (const [i, s] of sceneByLine) sceneEst.set(s, (sceneEst.get(s) ?? 0) + (est.get(i) ?? 0));

  const timingOf = (s: SceneRow, idx: number) => {
    if (s.timingStatus === "timing_unavailable" || !Array.isArray(s.timingMap)) return null;
    const t = (s.timingMap as any[]).find((x) => x && x.lineIndex === idx && typeof x.startMs === "number" && typeof x.endMs === "number" && x.endMs > x.startMs);
    return t ? { startMs: t.startMs as number, endMs: t.endMs as number } : null;
  };

  const out: MixSegmentVM[] = [];
  let cursor = 0;
  let lineTotal = 0;
  let open: { scene: SceneRow; start: number; estBefore: number } | null = null;
  rawSegments.forEach((seg: any, segIdx: number) => {
    const lines: MixLineVM[] = [];
    (seg?.lines || []).forEach((ln: any, li: number) => {
      const idx = typeof ln?.lineIndex === "number" ? ln.lineIndex : lineTotal;
      const scene = sceneByLine.get(idx) ?? null;
      const insideOpenScene = !!(scene && open && open.scene === scene);
      if (!insideOpenScene) {
        if (open) { cursor = open.start + (open.scene.durationMs ?? 0); open = null; }
        if (li === 0 && segIdx > 0) cursor += seg?.type === "topic" ? GAP.topic : GAP.segment;
        else if (li > 0) { const pb = String(ln?.pauseBefore || "beat"); cursor += ln?.isInterruption ? 0 : GAP[pb] ?? GAP.beat; }
        if (scene) open = { scene, start: cursor, estBefore: 0 };
      }
      const audio = audioByLine.get(idx);
      const lineReady = audio?.status === "ready" && !!audio.audioUrl;
      let startMs: number, durationMs: number, approx: boolean;
      if (scene && open) {
        const t = timingOf(scene, idx);
        const total = sceneEst.get(scene) || 1;
        const e = est.get(idx) ?? 0;
        if (t) { startMs = open.start + t.startMs; durationMs = t.endMs - t.startMs; approx = false; }
        else { startMs = open.start + ((scene.durationMs ?? 0) * open.estBefore) / total; durationMs = ((scene.durationMs ?? 0) * e) / total; approx = true; }
        open.estBefore += e;
      } else {
        startMs = cursor;
        durationMs = lineReady && audio!.durationMs && audio!.durationMs > 0 ? audio!.durationMs : est.get(idx) ?? estimateMs(String(ln?.text || ""));
        approx = true; // gaps between clips are the stitcher's defaults, not measured
        cursor += durationMs;
      }
      const voicedBy = scene ? "scene" : lineReady ? "line" : null;
      lines.push({
        lineIndex: idx,
        speaker: String(ln?.speakerName || ""),
        textShort: String(ln?.text || "").slice(0, 120),
        startMs: Math.round(startMs),
        durationMs: Math.max(1, Math.round(durationMs)),
        status: scene ? "ready" : audio?.status || "none",
        hasAudio: voicedBy !== null,
        audioUrl: lineReady ? audio!.audioUrl : null,
        tone: ln?.tone ?? null,
        energy: ln?.energy ?? null,
        dirty: ln?.dirty === true,
        voicedBy,
        sceneIndex: scene?.sceneIndex ?? null,
        approx,
      });
      lineTotal++;
    });
    out.push({ title: String(seg?.title || seg?.type || "Segment"), type: String(seg?.type || "segment"), lines });
  });
  return out;
}

function range(a: number, b: number): number[] { const r: number[] = []; for (let i = a; i <= b; i++) r.push(i); return r; }
