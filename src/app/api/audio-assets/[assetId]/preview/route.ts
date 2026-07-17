// Authorized audio-asset preview (Prompt 6).
//
// Private storage URLs never reach a browser: this route authenticates the
// actor (studio session OR admin Basic auth), authorizes the asset through
// the canonical access service, and PROXIES the object bytes with safe
// headers. Unauthorized assets answer 404 — existence never leaks. The
// storage provider currently has no genuine short-lived signed URLs, so we
// proxy rather than pretend.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { isAdminRequest, adminIdentity } from "@/lib/adminAuth";
import { getAccessibleAudioAsset, type AudioAssetActor } from "@/lib/services/audioAssetAccess";
import { getStorageProvider } from "@/lib/providers/storage/factory";

export const dynamic = "force-dynamic";

async function resolveActor(): Promise<AudioAssetActor | null> {
  const user = await currentUser();
  if (user) return { kind: "user", userId: user.id };
  if (await isAdminRequest()) return { kind: "admin", adminIdentity: adminIdentity() };
  return null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const actor = await resolveActor();
  if (!actor) return new NextResponse(null, { status: 401 });

  // UUID shape only — never a path, never a URL.
  if (!/^[a-zA-Z0-9-]{10,64}$/.test(assetId)) return new NextResponse(null, { status: 404 });

  const asset = await getAccessibleAudioAsset(db, actor, assetId);
  if (!asset || (!asset.storageKey && !asset.audioUrl)) return new NextResponse(null, { status: 404 });

  let body: Buffer;
  try {
    const obj = await getStorageProvider().getObject({ key: asset.storageKey ?? undefined, url: asset.audioUrl });
    body = obj.body;
  } catch {
    // Provider errors can carry credentials — never forward them.
    return new NextResponse(null, { status: 502 });
  }
  if (!body || body.length === 0) return new NextResponse(null, { status: 404 });

  const headers: Record<string, string> = {
    "Content-Type": asset.mimeType || "audio/mpeg",
    // Inline playback, but a fixed server-derived filename — never user input.
    "Content-Disposition": `inline; filename="preview-${asset.id}.audio"`,
    // Private assets must never enter shared caches.
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  };

  // Range support for browser <audio> scrubbing.
  const range = req.headers.get("range");
  if (range) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), body.length - 1) : body.length - 1;
      if (start <= end && start < body.length) {
        const slice = body.subarray(start, end + 1);
        return new NextResponse(new Uint8Array(slice), {
          status: 206,
          headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${body.length}`, "Content-Length": String(slice.length) },
        });
      }
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${body.length}` } });
    }
  }

  return new NextResponse(new Uint8Array(body), { status: 200, headers: { ...headers, "Content-Length": String(body.length) } });
}
