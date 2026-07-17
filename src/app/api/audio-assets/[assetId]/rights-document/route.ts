// Authorized rights-document download (Prompt 6). Documents are private
// supporting evidence for licensing: only the asset's manager (owner, or
// admin for system/legacy assets) may fetch them, always as an ATTACHMENT —
// never rendered inline, never as executable content.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { isAdminRequest, adminIdentity } from "@/lib/adminAuth";
import { getAccessibleAudioAsset, type AudioAssetActor } from "@/lib/services/audioAssetAccess";
import { getStorageProvider } from "@/lib/providers/storage/factory";

export const dynamic = "force-dynamic";

const SAFE_DOC_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

export async function GET(_req: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  let actor: AudioAssetActor | null = null;
  const user = await currentUser();
  if (user) actor = { kind: "user", userId: user.id };
  else if (await isAdminRequest()) actor = { kind: "admin", adminIdentity: adminIdentity() };
  if (!actor) return new NextResponse(null, { status: 401 });
  if (!/^[a-zA-Z0-9-]{10,64}$/.test(assetId)) return new NextResponse(null, { status: 404 });

  const asset = await getAccessibleAudioAsset(db, actor, assetId);
  // Managers only: an ordinary user must OWN the asset (shared-system docs are
  // admin-managed).
  const mayRead =
    asset &&
    asset.rightsDocumentStorageKey &&
    (actor.kind === "admin" ? asset.scope !== "owner_private" && asset.scope !== "podcast_private" : asset.ownerId === actor.userId);
  if (!mayRead) return new NextResponse(null, { status: 404 });

  let body: Buffer;
  try {
    const obj = await getStorageProvider().getObject({ key: asset.rightsDocumentStorageKey! });
    body = obj.body;
  } catch {
    return new NextResponse(null, { status: 502 });
  }
  const ext = asset.rightsDocumentStorageKey!.slice(asset.rightsDocumentStorageKey!.lastIndexOf("."));
  const contentType = SAFE_DOC_TYPES[ext] ?? "application/octet-stream";
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="rights-${asset.id}${ext}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(body.length),
    },
  });
}
