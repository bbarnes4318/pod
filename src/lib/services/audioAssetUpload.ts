// Secure authenticated audio-asset upload pipeline (Prompt 6).
//
// NOTHING from the client is trusted: not the filename, not the MIME type,
// not the claimed duration. The server validates magic bytes, probes the
// media with ffprobe, computes sha256 itself, generates the storage key from
// trusted identifiers, and enforces per-kind size/duration limits. A failed
// upload leaves no temp file and no selectable asset.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import type { PrismaClient } from "@prisma/client";
import { getStorageProvider } from "@/lib/providers/storage/factory";
import {
  createAudioAsset,
  findDuplicateInScope,
  recordAssetAuditEvent,
  type AudioAssetActor,
} from "./audioAssetAccess";

// ---------------------------------------------------------------------------
// Limits (env-tunable, safe defaults).
// ---------------------------------------------------------------------------
export const AUDIO_ASSET_MAX_BYTES = () => Number(process.env.AUDIO_ASSET_MAX_BYTES) || 35 * 1024 * 1024;
export const AUDIO_ASSET_MAX_DURATION_SECONDS = () => Number(process.env.AUDIO_ASSET_MAX_DURATION_SECONDS) || 15 * 60;
export const HIGHLIGHT_MAX_DURATION_SECONDS = () => Number(process.env.HIGHLIGHT_MAX_DURATION_SECONDS) || 60;
export const RIGHTS_DOCUMENT_MAX_BYTES = () => Number(process.env.RIGHTS_DOCUMENT_MAX_BYTES) || 10 * 1024 * 1024;

/** Stricter per-kind duration caps: nobody uploads an hour as a "stinger". */
const KIND_MAX_DURATION_SECONDS: Record<string, number> = {
  stinger: 30,
  sfx: 20,
  theme_intro: 120,
  theme_outro: 120,
  bed: 15 * 60,
};

// ---------------------------------------------------------------------------
// Magic-byte validation: the actual content decides, never the extension or
// the browser MIME. Only formats the ffmpeg environment genuinely accepts.
// ---------------------------------------------------------------------------
type SniffResult = { format: "mp3" | "wav" | "flac" | "m4a"; mimeType: string; ext: string };

export function sniffAudioFormat(buf: Buffer): SniffResult | null {
  if (buf.length < 12) return null;
  // WAV: RIFF....WAVE
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WAVE") {
    return { format: "wav", mimeType: "audio/wav", ext: "wav" };
  }
  // FLAC
  if (buf.slice(0, 4).toString("ascii") === "fLaC") {
    return { format: "flac", mimeType: "audio/flac", ext: "flac" };
  }
  // M4A/AAC (ISO BMFF): ....ftyp
  if (buf.slice(4, 8).toString("ascii") === "ftyp") {
    return { format: "m4a", mimeType: "audio/mp4", ext: "m4a" };
  }
  // MP3: ID3 tag or MPEG frame sync (0xFFEx/0xFFFx)
  if (buf.slice(0, 3).toString("ascii") === "ID3") {
    return { format: "mp3", mimeType: "audio/mpeg", ext: "mp3" };
  }
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    return { format: "mp3", mimeType: "audio/mpeg", ext: "mp3" };
  }
  return null;
}

/** Rights documents: PDF / PNG / JPEG only — never HTML/SVG/executables. */
export function sniffRightsDocument(buf: Buffer): { mimeType: string; ext: string } | null {
  if (buf.length < 8) return null;
  if (buf.slice(0, 5).toString("ascii") === "%PDF-") return { mimeType: "application/pdf", ext: "pdf" };
  if (buf[0] === 0x89 && buf.slice(1, 4).toString("ascii") === "PNG") return { mimeType: "image/png", ext: "png" };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mimeType: "image/jpeg", ext: "jpg" };
  return null;
}

function ffprobeMeta(filePath: string) {
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
  const out = execFileSync(ffprobePath, [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=sample_rate,channels,codec_name:format=duration,bit_rate",
    "-of", "json", filePath,
  ], { encoding: "utf8" });
  const j = JSON.parse(out);
  const stream = j.streams?.[0];
  const format = j.format ?? {};
  if (!stream) throw new Error("no audio stream");
  return {
    durationMs: format.duration ? Math.round(parseFloat(format.duration) * 1000) : null,
    sampleRate: stream.sample_rate ? parseInt(stream.sample_rate, 10) : null,
    channelCount: typeof stream.channels === "number" ? stream.channels : null,
    bitrateKbps: format.bit_rate ? Math.round(parseInt(format.bit_rate, 10) / 1000) : null,
  };
}

export type UploadError =
  | { code: "invalid_name" }
  | { code: "invalid_kind"; kind: string }
  | { code: "empty_file" }
  | { code: "file_too_large"; maxBytes: number }
  | { code: "unsupported_format" } // magic bytes not an accepted audio format
  | { code: "not_decodable" }      // ffprobe refused it
  | { code: "duration_too_long"; maxSeconds: number }
  | { code: "duplicate_asset"; existingAssetId: string; existingName: string }
  | { code: "rights_document_invalid" }
  | { code: "rights_document_too_large"; maxBytes: number }
  | { code: "storage_failed" }
  | { code: string; [k: string]: unknown }; // access-service errors pass through

export interface UploadAudioAssetInput {
  name: string;
  kind: string;
  category?: string | null;
  tags?: string[];
  scope: "shared_system" | "owner_private" | "podcast_private";
  podcastId?: string | null;
  bytes: Buffer;
  originalFilename?: string;
  licenseStatus?: string;
  licenseName?: string | null;
  rightsStatus?: string;
  rightsNotes?: string | null;
  /** Optional supporting document (PDF/PNG/JPEG), stored privately. */
  rightsDocument?: Buffer | null;
}

const AUDIO_KINDS = new Set(["theme_intro", "theme_outro", "stinger", "bed", "sfx", "highlight"]);

/**
 * Validate + store + register an uploaded audio asset for the actor.
 * Returns the new asset id, or a structured error. Duplicate bytes within the
 * actor's OWN visibility are reported; another owner's identical bytes are
 * never revealed (the check is visibility-scoped by construction).
 */
export async function uploadAudioAsset(
  dbi: PrismaClient,
  actor: AudioAssetActor,
  input: UploadAudioAssetInput
): Promise<{ ok: true; assetId: string; deduped?: false } | { ok: false; error: UploadError }> {
  const name = input.name?.trim();
  if (!name || name.length > 200) return { ok: false, error: { code: "invalid_name" } };
  if (!AUDIO_KINDS.has(input.kind)) return { ok: false, error: { code: "invalid_kind", kind: input.kind } };
  if (!input.bytes || input.bytes.length === 0) return { ok: false, error: { code: "empty_file" } };
  const maxBytes = AUDIO_ASSET_MAX_BYTES();
  if (input.bytes.length > maxBytes) return { ok: false, error: { code: "file_too_large", maxBytes } };

  // 1. Magic bytes — the content decides, never the extension/browser MIME.
  const sniff = sniffAudioFormat(input.bytes);
  if (!sniff) return { ok: false, error: { code: "unsupported_format" } };

  // 2. ffprobe on a SERVER-OWNED temp path (raw filenames never touch disk).
  const tmpPath = path.join(os.tmpdir(), `asset-upload-${crypto.randomUUID()}.${sniff.ext}`);
  let meta: ReturnType<typeof ffprobeMeta>;
  try {
    fs.writeFileSync(tmpPath, input.bytes);
    meta = ffprobeMeta(tmpPath);
  } catch {
    return { ok: false, error: { code: "not_decodable" } };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
  }

  // 3. Duration limits (global + stricter per kind).
  const maxSeconds = Math.min(
    input.kind === "highlight" ? HIGHLIGHT_MAX_DURATION_SECONDS() : AUDIO_ASSET_MAX_DURATION_SECONDS(),
    KIND_MAX_DURATION_SECONDS[input.kind] ?? Infinity
  );
  if (meta.durationMs != null && meta.durationMs > maxSeconds * 1000) {
    return { ok: false, error: { code: "duration_too_long", maxSeconds } };
  }

  // 4. Content hash + visibility-scoped dedupe (no cross-owner leak).
  const contentHash = crypto.createHash("sha256").update(input.bytes).digest("hex");
  const dup = await findDuplicateInScope(dbi, actor, contentHash);
  if (dup) return { ok: false, error: { code: "duplicate_asset", existingAssetId: dup.id, existingName: dup.name } };

  // 5. Rights document (optional): PDF/PNG/JPEG only, private storage.
  let rightsDocumentStorageKey: string | null = null;
  let rightsDocBytes: Buffer | null = null;
  let rightsDocMime = "";
  if (input.rightsDocument && input.rightsDocument.length > 0) {
    const docMax = RIGHTS_DOCUMENT_MAX_BYTES();
    if (input.rightsDocument.length > docMax) return { ok: false, error: { code: "rights_document_too_large", maxBytes: docMax } };
    const docSniff = sniffRightsDocument(input.rightsDocument);
    if (!docSniff) return { ok: false, error: { code: "rights_document_invalid" } };
    rightsDocBytes = input.rightsDocument;
    rightsDocMime = docSniff.mimeType;
  }

  // 6. Storage keys from TRUSTED identifiers only.
  const assetId = crypto.randomUUID();
  const storageKey =
    input.scope === "shared_system"
      ? `audio-assets/system/${assetId}/source.${sniff.ext}`
      : input.scope === "podcast_private"
        ? `audio-assets/podcasts/${input.podcastId}/${assetId}/source.${sniff.ext}`
        : `audio-assets/owners/${actor.kind === "user" ? actor.userId : "system"}/${assetId}/source.${sniff.ext}`;

  const storage = getStorageProvider();
  let uploadedUrl: string;
  try {
    const uploaded = await storage.putObject({ key: storageKey, body: input.bytes, contentType: sniff.mimeType });
    uploadedUrl = uploaded.url;
    if (rightsDocBytes) {
      rightsDocumentStorageKey = `audio-assets/rights/${assetId}/document.${sniffRightsDocument(rightsDocBytes)!.ext}`;
      await storage.putObject({ key: rightsDocumentStorageKey, body: rightsDocBytes, contentType: rightsDocMime });
    }
  } catch {
    // Never leak provider errors (they can carry credentials/URLs).
    return { ok: false, error: { code: "storage_failed" } };
  }

  // 7. Register through the canonical access service (scope authority etc.).
  const created = await createAudioAsset(dbi, actor, {
    name,
    kind: input.kind,
    category: input.category ?? null,
    tags: input.tags ?? [],
    scope: input.scope,
    podcastId: input.podcastId ?? null,
    audioUrl: uploadedUrl,
    storageKey,
    contentHash,
    mimeType: sniff.mimeType,
    fileSizeBytes: input.bytes.length,
    durationMs: meta.durationMs,
    sampleRate: meta.sampleRate,
    channelCount: meta.channelCount,
    bitrateKbps: meta.bitrateKbps,
    originalFilename: (input.originalFilename ?? "").slice(0, 200) || null,
    licenseStatus: input.licenseStatus,
    licenseName: input.licenseName,
    rightsStatus: input.rightsStatus,
    rightsNotes: input.rightsNotes,
    allowedUse: "podcast_production",
  });
  if (!created.ok) return { ok: false, error: created.error as UploadError };

  if (rightsDocumentStorageKey) {
    await dbi.audioAsset.update({ where: { id: created.assetId }, data: { rightsDocumentStorageKey } });
  }
  await recordAssetAuditEvent(dbi, created.assetId, "upload_completed", actor, {
    kind: input.kind, sizeBytes: input.bytes.length, format: sniff.format,
  });
  return { ok: true, assetId: created.assetId };
}
