# Security notes

## Audio assets (Prompt 6)

- **Isolation:** all access flows through `audioAssetAccess.ts`. Cross-owner
  reads/assignments answer NOT FOUND (no existence leak); admin does not see
  private user libraries; duplicate-hash checks are visibility-scoped.
- **Uploads:** magic-byte + ffprobe validation (MP3/WAV/FLAC/M4A only),
  server-side sha256, bounded sizes, per-kind duration caps, trusted storage
  keys (client filenames never become paths), server-owned temp files.
  Rights documents: PDF/PNG/JPEG only, attachment-only delivery.
- **Delivery:** private storage URLs never reach browsers for assets; the
  authorized preview route proxies bytes (`private, no-store`, nosniff,
  range-capable). No signed-URL support exists in the provider, so none is
  claimed.
- **Immutability:** a DB trigger freezes contentHash/storageKey/audioUrl on
  ready assets; replacement = supersession; render history survives asset
  edits, archives, and profile changes.
- **Rights:** expired/revoked/rejected rights or licenses block new renders
  and re-renders at BOTH assign and render time; highlights are hard-gated
  and never auto-selected; existing produced audio is never retroactively
  deleted.
- **Logging:** production asset paths must not log audio URLs, storage keys,
  signed URLs, or rights-document keys — enforced by a static contract test
  in `test:audio-upload-security`.
- **Known pre-existing gaps (tracked, NOT introduced here):** episode
  masters and per-line segments still play from raw public bucket URLs
  (pre-Prompt-6 behavior); the worker logs the Redis URL at boot (separate
  fix); `/studio/episodes/[id]` reads are login-gated but not owner-scoped
  (pre-existing).
