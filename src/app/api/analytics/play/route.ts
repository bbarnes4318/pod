import { NextResponse } from "next/server";
import { recordPlayEvent } from "@/lib/services/analyticsService";

export const dynamic = "force-dynamic";

// In-app player play-event beacon (Step 9b). The player POSTs { episodeId } when
// playback starts; we record an IAB-deduped "play" event (privacy-safe — the
// raw IP is hashed for dedup and dropped, only a coarse app bucket + optional
// geo-header country are kept). Fire-and-forget: always 204, never blocks the
// player, and unknown episodes are simply ignored inside recordPlayEvent.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const episodeId = typeof body?.episodeId === "string" ? body.episodeId : "";
    if (episodeId) {
      await recordPlayEvent({ episodeId, kind: "play", source: "player", headers: req.headers });
    }
  } catch {
    /* tracking must never surface an error to the player */
  }
  return new NextResponse(null, { status: 204 });
}
