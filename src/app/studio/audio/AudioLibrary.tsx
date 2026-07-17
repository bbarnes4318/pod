"use client";

// Owner audio-library client (Prompt 6). Previews play through the AUTHORIZED
// /api/audio-assets/<id>/preview route — never a storage URL. All rules are
// server-side; this surface only presents them.

import { useMemo, useRef, useState, useTransition } from "react";
import type { SafeAudioAssetDto } from "@/lib/services/audioAssetAccess";
import { archiveMyAudioAsset, restoreMyAudioAsset, uploadMyAudioAsset } from "./actions";

type Filter = "all" | "mine" | "system" | "archived" | "needs_rights" | "failed";

const FILTER_LABELS: Record<Filter, string> = {
  all: "All",
  mine: "My Library",
  system: "System Library",
  archived: "Archived",
  needs_rights: "Needs Rights Review",
  failed: "Failed",
};

const KINDS = ["theme_intro", "theme_outro", "bed", "stinger", "sfx", "highlight"];
const SFX_CATEGORIES = ["laugh", "crowd", "airhorn", "buzzer", "rimshot", "whoosh", "impact"];

function fmtDuration(ms: number | null): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export default function AudioLibrary(props: {
  initialAssets: SafeAudioAssetDto[];
  podcasts: Array<{ id: string; name: string }>;
  usage: Record<string, number>;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [status, setStatus] = useState<string>("");
  const [pending, startTransition] = useTransition();
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [uploadScope, setUploadScope] = useState<"owner_private" | "podcast_private">("owner_private");
  const [uploadKind, setUploadKind] = useState("stinger");

  const assets = props.initialAssets;
  const visible = useMemo(() => {
    switch (filter) {
      case "mine": return assets.filter((a) => (a.scope === "owner_private" || a.scope === "podcast_private") && !a.isArchived);
      case "system": return assets.filter((a) => a.scope === "shared_system" && !a.isArchived);
      case "archived": return assets.filter((a) => a.isArchived);
      case "needs_rights": return assets.filter((a) => ["pending", "rejected", "expired", "revoked"].includes(a.rightsStatus) || a.legacyScopeReviewRequired);
      case "failed": return assets.filter((a) => a.processingStatus === "failed");
      default: return assets.filter((a) => !a.isArchived);
    }
  }, [assets, filter]);

  const togglePreview = (asset: SafeAudioAssetDto) => {
    const el = audioRef.current;
    if (!el) return;
    if (playingId === asset.id) {
      el.pause();
      setPlayingId(null);
      return;
    }
    el.src = asset.previewPath; // authorized route — never a storage URL
    el.play().then(() => setPlayingId(asset.id)).catch(() => setStatus("Preview failed to play."));
  };

  const onUpload = (formData: FormData) => {
    setStatus("Uploading and validating…");
    startTransition(async () => {
      const res = await uploadMyAudioAsset(formData);
      if (res.success) {
        setStatus("Upload complete — the asset is ready.");
        formRef.current?.reset();
      } else {
        setStatus(res.error ?? "Upload failed.");
      }
    });
  };

  return (
    <div data-testid="audio-library">
      <audio ref={audioRef} onEnded={() => setPlayingId(null)} data-testid="preview-audio" />
      {/* Screen-reader-visible processing/status line; also visible text. */}
      <p aria-live="polite" role="status" data-testid="library-status" style={{ minHeight: "1.2em" }}>
        {pending ? "Working…" : status}
      </p>

      <nav aria-label="Library filters" style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "0.75rem 0" }}>
        {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            data-testid={`filter-${f}`}
          >
            {FILTER_LABELS[f]}
          </button>
        ))}
      </nav>

      <section aria-label="Upload a new asset" style={{ border: "1px solid var(--border, #444)", borderRadius: 8, padding: "1rem", marginBottom: "1.25rem" }}>
        <h2 style={{ marginTop: 0 }}>Upload audio</h2>
        <form ref={formRef} action={onUpload} data-testid="upload-form">
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <label>Name <input name="name" required maxLength={200} data-testid="upload-name" /></label>
            <label>Kind{" "}
              <select name="kind" value={uploadKind} onChange={(e) => setUploadKind(e.target.value)} data-testid="upload-kind">
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            {uploadKind === "sfx" && (
              <label>SFX category{" "}
                <select name="category" data-testid="upload-category">
                  {SFX_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            )}
            <label>Scope{" "}
              <select name="scope" value={uploadScope} onChange={(e) => setUploadScope(e.target.value as never)} data-testid="upload-scope">
                <option value="owner_private">My library (all my shows)</option>
                <option value="podcast_private">One show only</option>
              </select>
            </label>
            {uploadScope === "podcast_private" && (
              <label>Show{" "}
                <select name="podcastId" data-testid="upload-podcast">
                  {props.podcasts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            )}
            <label>License name <input name="licenseName" placeholder="e.g. Original recording" data-testid="upload-license" /></label>
            <label>License status{" "}
              <select name="licenseStatus" defaultValue="original">
                {["original", "licensed", "public_domain", "cc0"].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label>Tags (comma-separated) <input name="tags" /></label>
            <label>Audio file <input type="file" name="file" accept="audio/*" required data-testid="upload-file" /></label>
            <label>Rights document (PDF/PNG/JPEG, optional) <input type="file" name="rightsDocument" accept=".pdf,.png,.jpg,.jpeg" /></label>
          </div>
          <label style={{ display: "block", margin: "8px 0" }}>
            <input type="checkbox" name="rightsConfirmed" value="true" data-testid="upload-rights" />{" "}
            I confirm I hold the rights to use this audio in podcast production.
          </label>
          <label style={{ display: "block", margin: "8px 0" }}>Rights notes <input name="rightsNotes" style={{ width: "100%" }} /></label>
          <button type="submit" disabled={pending} data-testid="upload-submit">Upload</button>
        </form>
      </section>

      <table style={{ width: "100%", borderCollapse: "collapse" }} data-testid="asset-table">
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th>Name</th><th>Kind</th><th>Source</th><th>Duration</th><th>License</th><th>Rights</th><th>Status</th><th>Used</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr><td colSpan={9} data-testid="empty-state">Nothing here yet.</td></tr>
          )}
          {visible.map((a) => (
            <tr key={a.id} data-testid={`asset-${a.id}`} style={{ borderTop: "1px solid var(--border, #333)" }}>
              <td>{a.name}{a.isArchived ? " (archived)" : ""}</td>
              <td>{a.kind}{a.category ? `/${a.category}` : ""}</td>
              <td>{a.scopeLabel}</td>
              <td>{fmtDuration(a.durationMs)}</td>
              <td>{a.licenseStatus}</td>
              <td>
                {a.rightsStatus}
                {["pending", "rejected", "expired", "revoked"].includes(a.rightsStatus) && (
                  <strong> — needs review</strong>
                )}
              </td>
              <td>{a.processingStatus}</td>
              <td>{props.usage[a.id] ?? 0}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                <button type="button" onClick={() => togglePreview(a)} aria-pressed={playingId === a.id} data-testid={`preview-${a.id}`}>
                  {playingId === a.id ? "Stop" : "Preview"}
                </button>{" "}
                {a.scope !== "shared_system" && !a.isArchived && (
                  <button type="button" disabled={pending} data-testid={`archive-${a.id}`}
                    onClick={() => startTransition(async () => { const r = await archiveMyAudioAsset(a.id); setStatus(r.success ? "Archived." : r.error ?? "Failed."); })}>
                    Archive
                  </button>
                )}
                {a.scope !== "shared_system" && a.isArchived && (
                  <button type="button" disabled={pending} data-testid={`restore-${a.id}`}
                    onClick={() => startTransition(async () => { const r = await restoreMyAudioAsset(a.id); setStatus(r.success ? "Restored." : r.error ?? "Failed."); })}>
                    Restore
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
