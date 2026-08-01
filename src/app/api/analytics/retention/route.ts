import { NextResponse } from "next/server";
import { LISTENER_MILESTONES, recordListenerSignal, type ListenerMilestone } from "@/lib/services/listenerLearningService";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body.episodeId !== "string" || typeof body.sessionId !== "string") return new NextResponse(null, { status: 204 });
    if (!LISTENER_MILESTONES.includes(body.milestone as ListenerMilestone)) return new NextResponse(null, { status: 204 });
    await recordListenerSignal({ episodeId: body.episodeId, sessionId: body.sessionId, milestone: body.milestone, positionSeconds: body.positionSeconds, durationSeconds: body.durationSeconds, value: body.value, headers: req.headers });
  } catch { /* analytics never breaks playback */ }
  return new NextResponse(null, { status: 204 });
}
