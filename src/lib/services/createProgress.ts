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

import { evaluateDownstreamBlock } from "@/lib/services/scriptEditorialGate";
import { evaluateBusinessRelease } from "@/lib/business/businessVerification";
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

/** One episode's progress, for the episode's own console (includes the line window). */
export async function getCreateProgressVM(episodeId: string): Promise<CreateProgressVM> {
  const out = await readProgress([episodeId], true);
  return out.get(episodeId) ?? emptyVM(episodeId, Date.now(), { ok: false, error: "Episode not found." });
}

/**
 * Progress for MANY episodes in a fixed number of queries (six), whatever the
 * count. Studio Home and the activity menu used to call the single read once
 * per episode (about ten queries each) and so had to stop at eight episodes.
 *
 * Every id asked for is in the result. An episode that does not exist, or whose
 * read threw, comes back `ok: false` — callers must treat that as "unknown",
 * never as "running". `recentLines` is left empty: lists do not show it.
 */
export async function getCreateProgressBatch(episodeIds: string[]): Promise<Map<string, CreateProgressVM>> {
  return readProgress([...new Set(episodeIds)], false);
}

function emptyVM(episodeId: string, nowMs: number, over: Partial<CreateProgressVM>): CreateProgressVM {
  return {
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
  };
}

async function readProgress(ids: string[], withLines: boolean): Promise<Map<string, CreateProgressVM>> {
  const nowMs = Date.now();
  const out = new Map<string, CreateProgressVM>();
  if (ids.length === 0) return out;

  const episodes = await db.episode.findMany({
    where: { id: { in: ids } },
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
  const scriptIds = episodes.map((e) => e.scripts[0]?.id).filter((x): x is string => !!x);

  // ---- Real per-stage job history, one query for every episode -------------
  // JobLog.input identifies the episode differently per job type (worker.ts):
  // generate:script carries episodeId, everything downstream carries scriptId.
  // Newest first, so the first row seen for a (job type, id) pair is the latest.
  const jobByKey = new Map<string, StageJobSnapshot>();
  const jobStages = PRODUCTION_STAGES.filter((s) => s.jobType && s.matchBy);
  try {
    const or = jobStages.flatMap((stage) =>
      (stage.matchBy === "episodeId" ? episodes.map((e) => e.id) : scriptIds).map((idValue) => ({
        jobType: stage.jobType!,
        input: { path: [stage.matchBy!], equals: idValue },
      }))
    );
    const rows = or.length
      ? await db.jobLog.findMany({
          where: { OR: or },
          orderBy: { createdAt: "desc" },
          select: { jobType: true, input: true, status: true, error: true, createdAt: true, updatedAt: true },
        })
      : [];
    for (const row of rows) {
      const input = (row.input ?? {}) as Record<string, unknown>;
      for (const field of ["episodeId", "scriptId"] as const) {
        const idValue = input[field];
        if (typeof idValue !== "string") continue;
        const key = `${row.jobType}|${field}|${idValue}`;
        if (!jobByKey.has(key)) {
          jobByKey.set(key, {
            status: row.status,
            error: row.error,
            createdAtMs: row.createdAt.getTime(),
            updatedAtMs: row.updatedAt.getTime(),
          });
        }
      }
    }
  } catch {
    // A missing or unreadable log must not blank the whole console.
  }

  // ---- Real voicing progress, counted per script ---------------------------
  const [segCounts, sceneCounts, readyRows, renders, typicals] = await Promise.all([
    scriptIds.length
      ? db.audioSegment.groupBy({ by: ["scriptId", "status"], where: { scriptId: { in: scriptIds } }, _count: { _all: true } })
      : [],
    // Scene render mode writes DialogueSceneAudio instead of AudioSegment.
    scriptIds.length
      ? db.dialogueSceneAudio.groupBy({ by: ["scriptId", "status"], where: { scriptId: { in: scriptIds } }, _count: { _all: true } })
      : [],
    // Which lines are recorded: only the episode's own console shows them.
    withLines && scriptIds.length
      ? db.audioSegment.findMany({ where: { scriptId: { in: scriptIds }, status: "ready" }, select: { scriptId: true, lineIndex: true } })
      : [],
    // The stitcher's own render row is the most reliable mix timing + failure.
    db.episodeAudioRender
      .findMany({
        where: { episodeId: { in: episodes.map((e) => e.id) } },
        orderBy: { renderVersion: "desc" },
        select: { episodeId: true, status: true, startedAt: true, failureReason: true },
      })
      .catch(() => []),
    getTypicalDurations(nowMs),
  ]);
  const tally = (rows: { scriptId: string; status: string; _count: { _all: number } }[]) => {
    const m = new Map<string, { ready: number; failed: number; any: number }>();
    for (const r of rows) {
      const t = m.get(r.scriptId) ?? { ready: 0, failed: 0, any: 0 };
      t.any += r._count._all;
      if (r.status === "ready") t.ready += r._count._all;
      if (r.status === "failed") t.failed += r._count._all;
      m.set(r.scriptId, t);
    }
    return m;
  };
  const segs = tally(segCounts);
  const scenes = tally(sceneCounts);
  const latestRender = new Map<string, (typeof renders)[number]>();
  for (const r of renders) if (!latestRender.has(r.episodeId)) latestRender.set(r.episodeId, r);

  for (const episode of episodes) {
    try {
      out.set(episode.id, deriveOne(episode));
    } catch (err) {
      out.set(episode.id, emptyVM(episode.id, nowMs, { ok: false, error: err instanceof Error ? err.message : "Progress could not be read." }));
    }
  }
  for (const id of ids) if (!out.has(id)) out.set(id, emptyVM(id, nowMs, { ok: false, error: "Episode not found." }));
  return out;

  function deriveOne(episode: (typeof episodes)[number]): CreateProgressVM {
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

    const jobs = new Map<string, StageJobSnapshot>();
    for (const stage of jobStages) {
      const idValue = stage.matchBy === "episodeId" ? episode.id : scriptRow?.id;
      const job = idValue ? jobByKey.get(`${stage.jobType}|${stage.matchBy}|${idValue}`) : undefined;
      if (job) jobs.set(stage.key, job);
    }

    let voicing: VoicingProgress | null = null;
    const voicedIndexes = new Set<number>();
    let voicedCount = 0;
    if (scriptRow) {
      const seg = segs.get(scriptRow.id) ?? { ready: 0, failed: 0, any: 0 };
      voicedCount = seg.ready;
      for (const r of readyRows) if (r.scriptId === scriptRow.id) voicedIndexes.add(r.lineIndex);
      if (seg.any > 0 || lineCount > 0) {
        voicing = { done: seg.ready, total: lineCount > 0 ? lineCount : null, failed: seg.failed, unit: "lines" };
      }
      // Scenes are a COUNT with no denominator — the planner decides the scene
      // count as it goes, so there is no honest total to divide by.
      const scene = scenes.get(scriptRow.id);
      if (seg.any === 0 && scene && scene.any > 0) voicing = { done: scene.ready, total: null, failed: 0, unit: "scenes" };
    }

    const render = latestRender.get(episode.id);
    const mixStartedAtMs = render?.status === "running" ? render.startedAt.getTime() : null;
    const mixFailureReason = render?.status === "failed" ? render.failureReason ?? null : null;

    // A stage that a release gate refuses is WAITING ON A PERSON, not running.
    let releaseBlock: string | null = null;
    if (scriptRow && (episode.status === "fact_checked" || episode.status === "audio_segments_ready")) {
      const stageJob = episode.status === "fact_checked" ? "tts:generate-segments" : "audio:stitch-final";
      const editorial = evaluateDownstreamBlock(scriptRow.content);
      const business = evaluateBusinessRelease(scriptRow.content, stageJob);
      if (editorial.blocked) releaseBlock = "Waiting for your editorial release: read the script, then press Release for production.";
      else if (!business.allowed) releaseBlock = `Waiting for the fact-check: ${business.reasons[0] ?? "it hasn't passed yet."}`;
    }

    const derived = deriveProduction({
      releaseBlock,
      status: episode.status,
      hasScript: !!scriptRow,
      nowMs,
      episodeUpdatedAtMs: episode.updatedAt.getTime(),
      jobs,
      voicing,
      typicalMsByJobType: typicals,
      mixStartedAtMs,
      mixFailureReason,
    });

    // ---- The streaming window (episode console only) -----------------------
    // Anchored on the voicing frontier: the last few lines actually recorded,
    // plus the next few waiting their turn, so the list advances as the worker
    // works. Before any line is voiced it is simply the top of the script.
    const TRAIL = 5;
    const LEAD = 3;
    let recentLines: ProgressLineVM[] = [];
    if (withLines) {
      const frontier = scriptLines.reduce((last, ln, i) => (voicedIndexes.has(ln.lineIndex) ? i : last), -1);
      const from = frontier < 0 ? 0 : Math.max(0, frontier - (TRAIL - 1));
      recentLines = scriptLines.slice(from, frontier < 0 ? TRAIL + LEAD : frontier + 1 + LEAD).map((ln) => ({
        lineIndex: ln.lineIndex,
        speaker: ln.speaker,
        // Trimmed for the wire: this is a ticker, not the transcript.
        text: ln.text.length > 220 ? `${ln.text.slice(0, 219).trimEnd()}…` : ln.text,
        voiced: voicedIndexes.has(ln.lineIndex),
      }));
    }

    return emptyVM(episode.id, nowMs, {
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
      voicedCount: withLines ? voicedIndexes.size : voicedCount,
      audioUrl: episode.audioUrl,
      durationSeconds: episode.durationSeconds,
    });
  }
}
