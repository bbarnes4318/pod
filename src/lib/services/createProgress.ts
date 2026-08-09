// Live production progress for the studio Production Console.
//
// This module is the I/O half: it reads what the pipeline has actually done and
// hands a snapshot to the pure rules in lib/studio/productionProgress.ts, which
// decide what the user is told. Nothing here simulates or extrapolates.
//
// HONESTY POLICY (the same rule episodeEstimate.ts follows):
//   * Only `voices` has real sub-progress — the TTS worker writes one
//     AudioSegment row per line as it goes. Every other stage is a single
//     atomic write at the end, so the console shows elapsed time against this
//     deployment's own median and never a fabricated percentage.
//   * The voicing denominator is the SCRIPT's line count, not
//     count(AudioSegment). Rows are created lazily (ttsSegmentService.ts:317),
//     so counting rows would read "1 of 2 = 50%" when 2 of 120 lines exist.
//   * Failure comes from the stage's JobLog, never from Episode.status — the
//     worker rolls the status back on failure instead of writing "failed".

import { db } from "@/lib/db";
import { PRODUCTION_STAGES } from "@/lib/createFlow";
import {
  deriveProduction,
  type ProgressStageVM,
  type StageJobSnapshot,
  type VoicingProgress,
} from "@/lib/studio/productionProgress";

export type { ProgressStageVM } from "@/lib/studio/productionProgress";

/**
 * One line of the script as the console streams it. This is a READ of what has
 * already been written — the script rows that exist and the AudioSegment rows
 * that are `ready` — never a prediction of what is coming. A line is `voiced`
 * only when its own segment row says ready.
 */
export interface ProgressLineVM {
  lineIndex: number;
  speaker: string;
  text: string;
  voiced: boolean;
}

export interface CreateProgressVM {
  ok: boolean;
  error?: string;
  episodeId: string;
  title: string;
  status: string;
  /** Current stage key, or "done". */
  stage: string;
  stages: ProgressStageVM[];
  /** Present-tense headline for the active stage. */
  headline: string;
  done: boolean;
  /** True when the pipeline is waiting on the USER, not on a worker. */
  awaitingUser: boolean;
  /** Set when the active stage's job failed — the episode is stopped, not slow. */
  failure: { stage: string; label: string; message: string; atIso: string } | null;
  /** True when no job was ever picked up and nothing has moved for a while. */
  stalled: boolean;
  script: { id: string; lineCount: number; estMinutes: number | null; quality: number | null } | null;
  /**
   * A short window of the script around the voicing frontier — the last few
   * lines that have been recorded plus the next few waiting. Empty until a
   * script exists. Windowed rather than complete: the full transcript already
   * has its own tab, and the console only needs to show that work is landing.
   */
  recentLines: ProgressLineVM[];
  /** Total lines the window is drawn from, so the console can say "12 of 148". */
  voicedCount: number;
  audioUrl: string | null;
  durationSeconds: number | null;
  /** How long the client should wait before polling again, in ms. 0 = stop. */
  pollAfterMs: number;
  /** Server clock at read time. */
  nowIso: string;
}

/* ---------------------------------------------------------------------------
 * Typical stage durations — the median of recent COMPLETED runs of each job
 * type. This is the only estimate the console shows and it comes entirely from
 * this deployment's own history; with no history we return nothing and the UI
 * omits the comparison rather than inventing one.
 * ------------------------------------------------------------------------ */

const TYPICALS_TTL_MS = 5 * 60 * 1000;
let typicalsCache: { at: number; value: Map<string, number> } | null = null;

async function getTypicalDurations(nowMs: number): Promise<Map<string, number>> {
  if (typicalsCache && nowMs - typicalsCache.at < TYPICALS_TTL_MS) return typicalsCache.value;

  const jobTypes = PRODUCTION_STAGES.map((s) => s.jobType).filter((t): t is string => !!t);
  const out = new Map<string, number>();
  try {
    const rows = await db.jobLog.findMany({
      where: { jobType: { in: jobTypes }, status: { in: ["completed", "completed_with_errors"] } },
      orderBy: { createdAt: "desc" },
      take: 400,
      select: { jobType: true, createdAt: true, updatedAt: true },
    });
    const byType = new Map<string, number[]>();
    for (const r of rows) {
      const ms = r.updatedAt.getTime() - r.createdAt.getTime();
      // Drop clock skew and rows whose terminal write never landed.
      if (!Number.isFinite(ms) || ms <= 0 || ms > 60 * 60 * 1000) continue;
      const list = byType.get(r.jobType) ?? [];
      list.push(ms);
      byType.set(r.jobType, list);
    }
    for (const [type, list] of byType) {
      // Need a few samples before claiming a "typical" — one slow cold start
      // shouldn't become the number every user is measured against.
      if (list.length < 3) continue;
      const sorted = list.sort((a, b) => a - b);
      out.set(type, sorted[Math.floor(sorted.length / 2)]);
    }
  } catch {
    // History is a nicety; never let it break the live read.
  }
  typicalsCache = { at: nowMs, value: out };
  return out;
}

export async function getCreateProgressVM(episodeId: string): Promise<CreateProgressVM> {
  const nowMs = Date.now();
  const base = (over: Partial<CreateProgressVM>): CreateProgressVM => ({
    ok: true,
    episodeId,
    title: "",
    status: "",
    stage: "script",
    stages: [],
    headline: "Working…",
    done: false,
    awaitingUser: false,
    failure: null,
    stalled: false,
    script: null,
    recentLines: [],
    voicedCount: 0,
    audioUrl: null,
    durationSeconds: null,
    pollAfterMs: 4000,
    nowIso: new Date(nowMs).toISOString(),
    ...over,
  });

  const episode = await db.episode.findUnique({
    where: { id: episodeId },
    select: {
      id: true,
      title: true,
      status: true,
      audioUrl: true,
      durationSeconds: true,
      updatedAt: true,
      scripts: { orderBy: { version: "desc" }, take: 1, select: { id: true, content: true } },
    },
  });
  if (!episode) return base({ ok: false, error: "Episode not found." });

  const scriptRow = episode.scripts[0] ?? null;

  // Line count from the script content — the honest voicing denominator.
  let lineCount = 0;
  let estMinutes: number | null = null;
  let quality: number | null = null;
  // The script's lines in order, kept only long enough to cut the console's
  // streaming window out of them. Never returned whole.
  const scriptLines: { lineIndex: number; speaker: string; text: string }[] = [];
  if (scriptRow) {
    // Script.content is untyped Json; read defensively rather than trust a shape.
    const content = (scriptRow.content ?? {}) as {
      segments?: { lines?: { text?: string; lineIndex?: unknown; speakerName?: unknown }[] }[];
      estimatedDurationMinutes?: unknown;
      quality?: { total?: unknown };
    };
    for (const seg of Array.isArray(content.segments) ? content.segments : []) {
      for (const ln of seg?.lines ?? []) {
        if (!ln?.text) continue;
        // lineIndex is what the TTS worker keys AudioSegment rows on, so it is
        // the only correct join key. Fall back to the running ordinal for older
        // scripts written before the field existed.
        scriptLines.push({
          lineIndex: typeof ln.lineIndex === "number" ? ln.lineIndex : lineCount,
          speaker: typeof ln.speakerName === "string" ? ln.speakerName : "",
          text: ln.text,
        });
        lineCount++;
      }
    }
    estMinutes = typeof content.estimatedDurationMinutes === "number" ? content.estimatedDurationMinutes : null;
    quality = typeof content.quality?.total === "number" ? content.quality.total : null;
  }

  // ---- Real per-stage job history -----------------------------------------
  // JobLog.input identifies the episode differently per job type (worker.ts):
  // generate:script carries episodeId, everything downstream carries scriptId.
  const jobs = new Map<string, StageJobSnapshot>();
  await Promise.all(
    PRODUCTION_STAGES.map(async (stage) => {
      if (!stage.jobType || !stage.matchBy) return;
      const idValue = stage.matchBy === "episodeId" ? episode.id : scriptRow?.id;
      if (!idValue) return;
      try {
        const row = await db.jobLog.findFirst({
          where: { jobType: stage.jobType, input: { path: [stage.matchBy], equals: idValue } },
          orderBy: { createdAt: "desc" },
          select: { status: true, error: true, createdAt: true, updatedAt: true },
        });
        if (row) {
          jobs.set(stage.key, {
            status: row.status,
            error: row.error,
            createdAtMs: row.createdAt.getTime(),
            updatedAtMs: row.updatedAt.getTime(),
          });
        }
      } catch {
        // A missing or unreadable log must not blank the whole console.
      }
    })
  );

  // ---- Real voicing progress ----------------------------------------------
  let voicing: VoicingProgress | null = null;
  const voicedIndexes = new Set<number>();
  if (scriptRow) {
    const [readyRows, failed, rowCount] = await Promise.all([
      // The ready rows do double duty: their count is the voicing numerator and
      // their lineIndexes mark which script lines the console may show as
      // recorded. One read, not two.
      db.audioSegment.findMany({ where: { scriptId: scriptRow.id, status: "ready" }, select: { lineIndex: true } }),
      db.audioSegment.count({ where: { scriptId: scriptRow.id, status: "failed" } }),
      db.audioSegment.count({ where: { scriptId: scriptRow.id } }),
    ]);
    const ready = readyRows.length;
    for (const r of readyRows) voicedIndexes.add(r.lineIndex);
    if (rowCount > 0 || lineCount > 0) {
      voicing = { done: ready, total: lineCount > 0 ? lineCount : null, failed, unit: "lines" };
    }
    // Scene render mode writes DialogueSceneAudio instead of AudioSegment, so
    // the line counters stay at zero. Report scenes as a COUNT with no
    // denominator — the planner decides the scene count as it goes, so there is
    // no honest total to divide by.
    if (rowCount === 0) {
      const [sceneReady, sceneAny] = await Promise.all([
        db.dialogueSceneAudio.count({ where: { scriptId: scriptRow.id, status: "ready" } }),
        db.dialogueSceneAudio.count({ where: { scriptId: scriptRow.id } }),
      ]);
      if (sceneAny > 0) voicing = { done: sceneReady, total: null, failed: 0, unit: "scenes" };
    }
  }

  // The stitcher's own render row is the most reliable mix timing + failure.
  let mixStartedAtMs: number | null = null;
  let mixFailureReason: string | null = null;
  try {
    const render = await db.episodeAudioRender.findFirst({
      where: { episodeId: episode.id },
      orderBy: { renderVersion: "desc" },
      select: { status: true, startedAt: true, failureReason: true },
    });
    if (render?.status === "running") mixStartedAtMs = render.startedAt.getTime();
    if (render?.status === "failed") mixFailureReason = render.failureReason ?? null;
  } catch {
    /* optional */
  }

  const derived = deriveProduction({
    status: episode.status,
    hasScript: !!scriptRow,
    nowMs,
    episodeUpdatedAtMs: episode.updatedAt.getTime(),
    jobs,
    voicing,
    typicalMsByJobType: await getTypicalDurations(nowMs),
    mixStartedAtMs,
    mixFailureReason,
  });

  // ---- The streaming window ------------------------------------------------
  // Anchored on the voicing frontier: the last few lines actually recorded, plus
  // the next few waiting their turn, so the list advances as the worker works.
  // Before any line is voiced the window is simply the top of the script, which
  // is the honest thing to show the moment the writing lands.
  const TRAIL = 5;
  const LEAD = 3;
  const frontier = scriptLines.reduce(
    (last, ln, i) => (voicedIndexes.has(ln.lineIndex) ? i : last),
    -1
  );
  const from = frontier < 0 ? 0 : Math.max(0, frontier - (TRAIL - 1));
  const recentLines: ProgressLineVM[] = scriptLines
    .slice(from, frontier < 0 ? TRAIL + LEAD : frontier + 1 + LEAD)
    .map((ln) => ({
      lineIndex: ln.lineIndex,
      speaker: ln.speaker,
      // Trimmed for the wire: this is a ticker, not the transcript, and the
      // full text is one tab away.
      text: ln.text.length > 220 ? `${ln.text.slice(0, 219).trimEnd()}…` : ln.text,
      voiced: voicedIndexes.has(ln.lineIndex),
    }));

  return base({
    title: episode.title,
    status: episode.status,
    stage: derived.stage,
    stages: derived.stages,
    headline: derived.headline,
    done: derived.done,
    awaitingUser: derived.awaitingUser,
    failure: derived.failure,
    stalled: derived.stalled,
    pollAfterMs: derived.pollAfterMs,
    script: scriptRow ? { id: scriptRow.id, lineCount, estMinutes, quality } : null,
    recentLines,
    voicedCount: voicedIndexes.size,
    audioUrl: episode.audioUrl,
    durationSeconds: episode.durationSeconds,
  });
}
