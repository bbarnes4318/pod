// Operator-only route to regenerate a script through the pipeline and read the
// structured result back — used to prove the script-quality prompt fixes.
// Enqueues the same worker job the normal path uses (so the worker's updated
// generateScriptForEpisode runs), never runs generation inline (LLM calls would
// exceed the HTTP timeout). Basic-auth gated by proxy.ts on /admin/*, re-verified
// here. Read/enqueue only — the sole write is an opt-in status reset so a
// finished episode can be re-scripted for the proof.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyAdminAuthHeader } from "@/lib/adminBasicAuth";
import { queueScriptGenerationJob } from "@/lib/queue/podcastQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!verifyAdminAuthHeader(req.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const eps = await db.episode.findMany({
    where: { topics: { some: {} } },
    include: { _count: { select: { scripts: true, topics: true } } },
    orderBy: { createdAt: "desc" },
    take: 40,
  });
  return NextResponse.json({
    success: true,
    episodes: eps.map((e) => ({ id: e.id, title: e.title, status: e.status, topics: e._count.topics, scripts: e._count.scripts })),
  });
}

export async function POST(req: NextRequest) {
  if (!verifyAdminAuthHeader(req.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const body: any = await req.json().catch(() => ({}));
  const episodeId: string = body?.episodeId;
  if (!episodeId) return NextResponse.json({ success: false, error: "episodeId required" }, { status: 400 });

  if (body.action === "job") {
    const job = await db.jobLog.findFirst({
      where: { jobType: "generate:script", input: { path: ["episodeId"], equals: episodeId } },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({
      success: true,
      job: job
        ? {
            id: job.id,
            status: job.status,
            error: job.error,
            createdAt: job.createdAt.toISOString(),
            output: job.output ? (job.output as any) : null,
          }
        : null,
    });
  }

  if (body.action === "content") {
    const script = await db.script.findFirst({ where: { episodeId }, orderBy: { version: "desc" } });
    if (!script) return NextResponse.json({ success: false, error: "no script yet" });
    return NextResponse.json({
      success: true,
      version: script.version,
      status: script.status,
      content: typeof script.content === "object" && script.content !== null ? (script.content as any) : {},
    });
  }

  // default: enqueue a regenerate. Opt-in status reset so an already-produced
  // episode can be re-scripted for the proof.
  if (body.reset === true) {
    const ep = await db.episode.findUnique({ where: { id: episodeId }, select: { status: true } });
    if (ep && ep.status !== "draft" && ep.status !== "script_draft") {
      await db.episode.update({ where: { id: episodeId }, data: { status: "script_draft" } });
    }
  }
  try {
    const job = await queueScriptGenerationJob({ episodeId, forceRegenerate: true });
    return NextResponse.json({ success: true, jobId: job.id });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || "enqueue failed" }, { status: 500 });
  }
}
