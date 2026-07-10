// Operator-only route to drive the approve -> fact-check -> TTS chain over HTTPS.
// Same rationale as /admin/render-proof: Coolify 4.1.2 has no container exec and
// the approve/fact-check/TTS server actions are bound to the admin React pages
// (their action ids can't be invoked without a browser session), so this route
// calls the SAME underlying services the UI calls, server-side, over HTTPS.
//
// It invokes the existing services ONLY — it never re-implements, weakens, or
// force-passes any gate:
//   - "approve"   -> approveEpisodeLatestScript(episodeId): the real safety gate
//                    (evidence coverage, unsafe/unsupported claims, host balance,
//                    line count). A blocked approval returns its exact reasons and
//                    stops; nothing downstream runs.
//   - "factcheck" -> enqueues the same fact-check job the UI enqueues, polls the
//                    JobLog to a terminal state, returns the raw result. Only
//                    advances episode -> fact_checked when the script is already
//                    approved AND the check passes (enforced inside the service).
//   - "voices"    -> enqueues the same TTS job, polls to terminal, returns
//                    per-line ready/failed counts.
//   - "status"    -> episode status, latest script version + approval state,
//                    latest fact-check result, per-line TTS readiness.
//   - "poll"      -> re-read the latest JobLog of a jobType for a scriptId
//                    (so a long TTS run can be polled without re-enqueuing).
//
// Basic-auth gated by proxy.ts on /admin/*, plus a re-verify here. Read/enqueue
// + the single synchronous approve service; no other writes.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyAdminAuthHeader } from "@/lib/adminBasicAuth";
import { approveEpisodeLatestScript } from "@/lib/services/scriptApproval";
import {
  queueFactCheckJob,
  queueTtsSegmentGenerationJob,
} from "@/lib/queue/podcastQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FACTCHECK_TERMINAL = new Set(["completed", "failed"]);
const TTS_TERMINAL = new Set(["completed", "completed_with_errors", "failed"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Latest JobLog for (jobType, scriptId), optionally only those created at/after
 *  `since` so we never read a stale prior run. */
async function latestJob(jobType: string, scriptId: string, since?: Date) {
  const job = await db.jobLog.findFirst({
    where: {
      jobType,
      input: { path: ["scriptId"], equals: scriptId },
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    output: job.output ? (job.output as any) : null,
  };
}

/** Poll a JobLog to a terminal state within a bounded wall-clock budget. */
async function pollToTerminal(
  jobType: string,
  scriptId: string,
  terminal: Set<string>,
  since: Date,
  waitMs: number
) {
  const deadline = Date.now() + waitMs;
  let job = await latestJob(jobType, scriptId, since);
  while (Date.now() < deadline) {
    job = await latestJob(jobType, scriptId, since);
    if (job && terminal.has(job.status)) return { pending: false as const, job };
    await sleep(3000);
  }
  job = await latestJob(jobType, scriptId, since);
  if (job && terminal.has(job.status)) return { pending: false as const, job };
  return { pending: true as const, job };
}

async function scriptWithEpisode(scriptId: string) {
  return db.script.findUnique({
    where: { id: scriptId },
    include: { episode: { select: { id: true, status: true } } },
  });
}

async function latestVersionForEpisode(episodeId: string) {
  const s = await db.script.findFirst({
    where: { episodeId },
    orderBy: { version: "desc" },
    select: { id: true, version: true },
  });
  return s;
}

export async function POST(req: NextRequest) {
  if (!verifyAdminAuthHeader(req.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const body: any = await req.json().catch(() => ({}));
  const action: string = body?.action || "status";
  // Accept an explicit scriptId, or an episodeId (we resolve its latest script).
  // The latter is how an operator drives an episode whose newest script hasn't
  // been rendered yet (so its id isn't discoverable via /admin/render-proof).
  let scriptId: string | undefined = body?.scriptId;
  const episodeIdIn: string | undefined = body?.episodeId;
  if (!scriptId && !episodeIdIn) {
    return NextResponse.json({ success: false, error: "scriptId or episodeId required" }, { status: 400 });
  }

  // Clamp the in-route poll budget so we never hang a proxy connection.
  const waitMs = Math.min(Math.max(Number(body?.waitMs) || 55000, 0), 280000);
  const force = body?.force === true;

  let script = scriptId ? await scriptWithEpisode(scriptId) : null;
  if (!script && episodeIdIn) {
    const latest = await db.script.findFirst({
      where: { episodeId: episodeIdIn },
      orderBy: { version: "desc" },
      include: { episode: { select: { id: true, status: true } } },
    });
    script = latest;
    scriptId = latest?.id;
  }
  if (!script || !script.episode || !scriptId) {
    return NextResponse.json({ success: false, error: "Script (or its episode) not found." }, { status: 404 });
  }
  const episodeId = script.episode.id;
  const resolvedScriptId = scriptId;

  // -- status ---------------------------------------------------------------
  if (action === "status") {
    const latest = await latestVersionForEpisode(episodeId);
    const factCheck = await db.factCheckResult.findFirst({
      where: { scriptId },
      orderBy: { checkedAt: "desc" },
      select: { status: true, checkedAt: true },
    });
    const segs = (script.content as any)?.segments || [];
    const lineIndexes: number[] = [];
    for (const s of segs) for (const l of s.lines || []) lineIndexes.push(l.lineIndex);
    const ready = await db.audioSegment.findMany({
      where: { scriptId, status: "ready", NOT: { audioUrl: null } },
      select: { lineIndex: true },
    });
    const readyLineSet = new Set(ready.map((r) => r.lineIndex));
    return NextResponse.json({
      success: true,
      episode: { id: episodeId, status: script.episode.status },
      script: {
        id: script.id,
        version: script.version,
        status: script.status,
        isLatest: latest?.id === script.id,
        latestVersion: latest?.version ?? null,
      },
      factCheck: factCheck
        ? { status: factCheck.status, checkedAt: factCheck.checkedAt.toISOString() }
        : null,
      tts: { totalLines: lineIndexes.length, readyLines: readyLineSet.size },
    });
  }

  // -- poll (re-read latest job without enqueuing) --------------------------
  if (action === "poll") {
    const jobType: string = body?.jobType;
    if (!jobType) return NextResponse.json({ success: false, error: "jobType required for poll" }, { status: 400 });
    return NextResponse.json({ success: true, job: await latestJob(jobType, scriptId) });
  }

  // -- approve (the real gate, unmodified) ----------------------------------
  if (action === "approve") {
    const latest = await latestVersionForEpisode(episodeId);
    if (latest && latest.id !== script.id) {
      return NextResponse.json({
        success: false,
        error: `Refusing to approve: script v${script.version} is not the latest (latest is v${latest.version}, ${latest.id}).`,
      }, { status: 409 });
    }
    // approveEpisodeLatestScript runs the identical safety gate the UI uses. A
    // blocked script returns { success:false, reasons:[...] } and changes nothing.
    const result = await approveEpisodeLatestScript(episodeId);
    return NextResponse.json({ action: "approve", ...result }, { status: result.success ? 200 : 422 });
  }

  // -- factcheck ------------------------------------------------------------
  if (action === "factcheck") {
    if (script.status !== "approved") {
      return NextResponse.json({
        success: false,
        error: `Refusing to fact-check: script status is '${script.status}', not 'approved'. Approve first.`,
      }, { status: 409 });
    }
    const since = new Date();
    const enqueued = await queueFactCheckJob({ scriptId, forceRecheck: force });
    const { pending, job } = await pollToTerminal("fact-check:script", scriptId, FACTCHECK_TERMINAL, since, waitMs);
    const result = await db.factCheckResult.findFirst({
      where: { scriptId },
      orderBy: { checkedAt: "desc" },
      select: { status: true, checkedAt: true },
    });
    return NextResponse.json({
      action: "factcheck",
      scriptId: resolvedScriptId,
      success: !pending,
      pending,
      enqueuedJobId: enqueued.id,
      job,
      factCheckResult: result
        ? { status: result.status, checkedAt: result.checkedAt.toISOString() }
        : null,
      note: pending ? "Still running; re-check with {action:'poll', jobType:'fact-check:script'}." : undefined,
    });
  }

  // -- voices ---------------------------------------------------------------
  if (action === "voices") {
    if (script.status !== "approved") {
      return NextResponse.json({
        success: false,
        error: `Refusing to generate voices: script status is '${script.status}', not 'approved'.`,
      }, { status: 409 });
    }
    const since = new Date();
    const enqueued = await queueTtsSegmentGenerationJob({ scriptId, forceRegenerate: force });
    const { pending, job } = await pollToTerminal("tts:generate-segments", scriptId, TTS_TERMINAL, since, waitMs);
    const out = job?.output || null;
    return NextResponse.json({
      action: "voices",
      scriptId: resolvedScriptId,
      success: !pending,
      pending,
      enqueuedJobId: enqueued.id,
      jobStatus: job?.status ?? null,
      counts: out
        ? {
            totalLines: out.selectedLineCount ?? null,
            readyCount: out.readyCount ?? null,
            failedCount: out.failedCount ?? null,
            skippedReadyCount: out.skippedReadyCount ?? null,
            createdSegmentCount: out.createdSegmentCount ?? null,
            providerLineCounts: out.providerLineCounts ?? null,
          }
        : null,
      failedLines: out?.failedLines ?? null,
      job,
      note: pending ? "Still running; re-check with {action:'poll', jobType:'tts:generate-segments'}." : undefined,
    });
  }

  return NextResponse.json({ success: false, error: `Unknown action '${action}'.` }, { status: 400 });
}
