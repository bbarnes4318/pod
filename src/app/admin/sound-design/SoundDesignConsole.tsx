"use client";

// Sound Design console: manage the royalty-free/licensed asset library
// (S3-backed, license tracked per asset), pick the show's theme/stingers/
// bed, seed the starter sports pack, and upload rights-gated game
// highlights.

import React, { useState } from "react";
import {
  classifyLegacyAsset,
  deleteAudioAsset,
  fetchSoundDesignData,
  seedStarterSoundPack,
  setAssetActive,
  updateSoundDesignConfig,
  uploadAudioAsset,
} from "./actions";
import {
  ASSET_KINDS,
  ASSET_KIND_LABELS,
  AssetKind,
  PRODUCTION_STYLES,
  PRODUCTION_STYLE_LABELS,
  SFX_CATEGORIES,
  SFX_DENSITIES,
  SFX_DENSITY_LABELS,
} from "@/lib/audio/soundDesignShared";
import "../scripts/scripts.css";

interface Asset {
  id: string;
  name: string;
  kind: string;
  category: string | null;
  tags: string[];
  audioUrl: string; // the AUTHORIZED preview route, not a storage URL
  durationMs: number | null;
  license: string;
  licenseNote: string | null;
  rightsConfirmed: boolean;
  isActive: boolean;
  source: string;
  scope: string;
  legacyScopeReviewRequired: boolean;
  isArchived: boolean;
  licenseStatus: string;
  rightsStatus: string;
  createdAt: string;
}

interface ShowConfig {
  themeIntroAssetId: string | null;
  themeOutroAssetId: string | null;
  bedAssetId: string | null;
  stingerAssetIds: string[];
  defaultStyle: string;
  defaultSfxDensity: string;
}

const EMPTY_CONFIG: ShowConfig = {
  themeIntroAssetId: null,
  themeOutroAssetId: null,
  bedAssetId: null,
  stingerAssetIds: [],
  defaultStyle: "full",
  defaultSfxDensity: "subtle",
};

export default function SoundDesignConsole({
  initialAssets,
  initialConfig,
  loadError,
}: {
  initialAssets: Asset[];
  initialConfig: ShowConfig | null;
  loadError: string | null;
}) {
  const [assets, setAssets] = useState<Asset[]>(initialAssets);
  const [config, setConfig] = useState<ShowConfig>(initialConfig || EMPTY_CONFIG);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(
    loadError ? { type: "error", text: loadError } : null
  );

  // Upload form state
  const [upName, setUpName] = useState("");
  const [upKind, setUpKind] = useState<AssetKind>("sfx");
  const [upCategory, setUpCategory] = useState("crowd");
  const [upTags, setUpTags] = useState("");
  const [upLicense, setUpLicense] = useState("");
  const [upLicenseNote, setUpLicenseNote] = useState("");
  const [upRights, setUpRights] = useState(false);
  const [upFile, setUpFile] = useState<File | null>(null);

  const refresh = async () => {
    const res = await fetchSoundDesignData();
    if (res.success) {
      if (res.assets) setAssets(res.assets as Asset[]);
      setConfig((res.config as ShowConfig) || EMPTY_CONFIG);
    }
  };

  const handleSeed = async () => {
    setBusy(true);
    setMessage(null);
    const res = await seedStarterSoundPack();
    if (res.success) {
      setMessage({ type: "success", text: `Starter sports pack seeded (${res.seededCount} original, fully-synthesized assets).` });
      await refresh();
    } else {
      setMessage({ type: "error", text: res.error || "Seeding failed." });
    }
    setBusy(false);
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!upFile) {
      setMessage({ type: "error", text: "Pick an audio file first." });
      return;
    }
    setBusy(true);
    setMessage(null);
    const fd = new FormData();
    fd.set("name", upName);
    fd.set("kind", upKind);
    fd.set("category", upKind === "sfx" ? upCategory : "");
    fd.set("tags", upTags);
    fd.set("license", upLicense);
    fd.set("licenseNote", upLicenseNote);
    fd.set("rightsConfirmed", upRights ? "true" : "false");
    fd.set("file", upFile);
    const res = await uploadAudioAsset(fd);
    if (res.success) {
      setMessage({ type: "success", text: `Asset "${upName}" uploaded.` });
      setUpName(""); setUpTags(""); setUpLicense(""); setUpLicenseNote(""); setUpRights(false); setUpFile(null);
      await refresh();
    } else {
      setMessage({ type: "error", text: res.error || "Upload failed." });
    }
    setBusy(false);
  };

  const handleConfigSave = async () => {
    setBusy(true);
    setMessage(null);
    const res = await updateSoundDesignConfig(config);
    setMessage(
      res.success
        ? { type: "success", text: "Show sound configuration saved." }
        : { type: "error", text: res.error || "Failed to save config." }
    );
    setBusy(false);
  };

  const handleToggle = async (asset: Asset) => {
    setBusy(true);
    const res = await setAssetActive(asset.id, !asset.isActive);
    if (res.success) await refresh();
    else setMessage({ type: "error", text: res.error || "Failed." });
    setBusy(false);
  };

  const handleDelete = async (asset: Asset) => {
    if (!window.confirm(`Delete asset "${asset.name}"? Episodes already rendered keep their audio.`)) return;
    setBusy(true);
    const res = await deleteAudioAsset(asset.id);
    if (res.success) await refresh();
    else setMessage({ type: "error", text: res.error || "Failed." });
    setBusy(false);
  };

  const byKind = (kind: string) => assets.filter((a) => a.kind === kind);
  const activeByKind = (kind: string) => byKind(kind).filter((a) => a.isActive);
  const assetName = (id: string | null) => assets.find((a) => a.id === id)?.name || "—";

  const toggleStinger = (id: string) => {
    setConfig((c) => ({
      ...c,
      stingerAssetIds: c.stingerAssetIds.includes(id)
        ? c.stingerAssetIds.filter((s) => s !== id)
        : [...c.stingerAssetIds, id],
    }));
  };

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      <div className="personalitiesHeader">
        <div className="titleGroup">
          <h2>Sound Design</h2>
          <p>
            Post-production layer: theme, stingers, ducked music bed, and reaction SFX mixed around the dialogue.
            Every asset must be royalty-free or licensed — the license is tracked per asset.
          </p>
        </div>
        <button className="buttonPrimary" onClick={handleSeed} disabled={busy}>
          {busy ? "Working…" : "Seed Starter Sports Pack"}
        </button>
      </div>

      {message && (
        <div className={`alertCard ${message.type === "success" ? "alertSuccess" : "alertDanger"}`} style={{ marginBottom: "1rem" }}>
          {message.text}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(280px, 1fr)", gap: "1.5rem", alignItems: "start" }}>
        {/* Asset library */}
        <div>
          {ASSET_KINDS.map((kind) => {
            const list = byKind(kind);
            return (
              <div key={kind} className="editorPanel" style={{ padding: "1rem", marginBottom: "1rem" }}>
                <div className="panelTitle" style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>{ASSET_KIND_LABELS[kind]}s ({list.length})</span>
                </div>
                {kind === "highlight" && (
                  <div className="alertCard alertWarning" style={{ margin: "0.5rem 0", fontSize: "0.78rem" }}>
                    <strong>Rights-gated:</strong> game-highlight / crowd audio may only be uploaded from a cleared or
                    licensed source, or audio you own. Do <strong>not</strong> pull broadcast audio from the open web.
                    Unconfirmed clips are never mixed into an episode.
                  </div>
                )}
                {list.length === 0 ? (
                  <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", padding: "0.5rem 0" }}>
                    {kind === "sfx"
                      ? "No SFX yet. Seed the starter pack, or upload licensed reactions (laughter must be uploaded — it is not synthesizable and is never faked)."
                      : "None yet — seed the starter pack or upload one."}
                  </div>
                ) : (
                  list.map((a) => (
                    <div
                      key={a.id}
                      style={{
                        display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap",
                        padding: "0.5rem 0", borderTop: "1px solid var(--border-color)",
                      }}
                    >
                      <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>
                          {a.name}
                          {a.category && <span className="refBadge" style={{ marginLeft: "0.4rem", fontSize: "0.65rem" }}>{a.category}</span>}
                          {!a.isActive && <span className="badge badgeFailed" style={{ marginLeft: "0.4rem", fontSize: "0.6rem" }}>inactive</span>}
                          {a.kind === "highlight" && (
                            <span className={`badge ${a.rightsConfirmed ? "badgeCompleted" : "badgeFailed"}`} style={{ marginLeft: "0.4rem", fontSize: "0.6rem" }}>
                              {a.rightsConfirmed ? "rights confirmed" : "rights NOT confirmed"}
                            </span>
                          )}
                          {a.scope === "legacy_global" && (
                            <span className="badge badgeFailed" style={{ marginLeft: "0.4rem", fontSize: "0.6rem" }} data-testid={`legacy-${a.id}`}>
                              ownership review required
                            </span>
                          )}
                          {a.isArchived && <span className="badge badgeFailed" style={{ marginLeft: "0.4rem", fontSize: "0.6rem" }}>archived</span>}
                        </div>
                        <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }} title={a.licenseNote || undefined}>
                          {a.durationMs ? `${(a.durationMs / 1000).toFixed(1)}s · ` : ""}
                          {a.source} · {a.license}
                        </div>
                      </div>
                      <audio src={a.audioUrl} controls preload="none" style={{ height: "26px", width: "180px" }} />
                      <button className="editButton" style={{ fontSize: "0.7rem" }} onClick={() => handleToggle(a)} disabled={busy}>
                        {a.isActive ? "Deactivate" : "Activate"}
                      </button>
                      <button className="btnReset" style={{ fontSize: "0.7rem", color: "var(--error-color)" }} onClick={() => handleDelete(a)} disabled={busy}>
                        Archive
                      </button>
                      {a.scope === "legacy_global" && (
                        <button
                          className="editButton"
                          style={{ fontSize: "0.7rem" }}
                          disabled={busy}
                          data-testid={`classify-${a.id}`}
                          onClick={async () => {
                            if (!confirm(`Classify "${a.name}" as a SHARED SYSTEM asset? Only do this if it is provably platform content.`)) return;
                            setBusy(true);
                            const res = await classifyLegacyAsset(a.id, { scope: "shared_system" });
                            if (!res.success) alert(res.error);
                            await refresh();
                            setBusy(false);
                          }}
                        >
                          Classify as system
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>

        {/* Right column: show config + upload */}
        <div className="sideControls">
          <div className="controlsPanel">
            <div className="panelTitle">Show Sound Configuration</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              <div className="formGroup" style={{ marginBottom: 0 }}>
                <label className="label" style={{ fontSize: "0.72rem" }}>Intro theme</label>
                <select className="select" value={config.themeIntroAssetId || ""} disabled={busy}
                  onChange={(e) => setConfig((c) => ({ ...c, themeIntroAssetId: e.target.value || null }))}>
                  <option value="">None</option>
                  {activeByKind("theme_intro").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="formGroup" style={{ marginBottom: 0 }}>
                <label className="label" style={{ fontSize: "0.72rem" }}>Outro theme</label>
                <select className="select" value={config.themeOutroAssetId || ""} disabled={busy}
                  onChange={(e) => setConfig((c) => ({ ...c, themeOutroAssetId: e.target.value || null }))}>
                  <option value="">None</option>
                  {activeByKind("theme_outro").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="formGroup" style={{ marginBottom: 0 }}>
                <label className="label" style={{ fontSize: "0.72rem" }}>Music bed (ducked under speech)</label>
                <select className="select" value={config.bedAssetId || ""} disabled={busy}
                  onChange={(e) => setConfig((c) => ({ ...c, bedAssetId: e.target.value || null }))}>
                  <option value="">None</option>
                  {activeByKind("bed").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="formGroup" style={{ marginBottom: 0 }}>
                <label className="label" style={{ fontSize: "0.72rem" }}>Stinger set ({config.stingerAssetIds.length} selected)</label>
                {activeByKind("stinger").length === 0 ? (
                  <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>No stingers available.</div>
                ) : (
                  activeByKind("stinger").map((a) => (
                    <label key={a.id} style={{ display: "flex", gap: "0.4rem", alignItems: "center", fontSize: "0.78rem", cursor: "pointer" }}>
                      <input type="checkbox" checked={config.stingerAssetIds.includes(a.id)} onChange={() => toggleStinger(a.id)} disabled={busy} />
                      {a.name}
                    </label>
                  ))
                )}
              </div>
              <div className="formGroup" style={{ marginBottom: 0 }}>
                <label className="label" style={{ fontSize: "0.72rem" }}>Default production style</label>
                <select className="select" value={config.defaultStyle} disabled={busy}
                  onChange={(e) => setConfig((c) => ({ ...c, defaultStyle: e.target.value }))}>
                  {PRODUCTION_STYLES.map((s) => <option key={s} value={s}>{PRODUCTION_STYLE_LABELS[s]}</option>)}
                </select>
              </div>
              <div className="formGroup" style={{ marginBottom: 0 }}>
                <label className="label" style={{ fontSize: "0.72rem" }}>Default SFX density</label>
                <select className="select" value={config.defaultSfxDensity} disabled={busy}
                  onChange={(e) => setConfig((c) => ({ ...c, defaultSfxDensity: e.target.value }))}>
                  {SFX_DENSITIES.map((d) => <option key={d} value={d}>{SFX_DENSITY_LABELS[d]}</option>)}
                </select>
              </div>
              <button className="buttonPrimary" onClick={handleConfigSave} disabled={busy} style={{ width: "100%" }}>
                Save Configuration
              </button>
              <div style={{ fontSize: "0.68rem", color: "var(--text-secondary)" }}>
                Current: intro “{assetName(config.themeIntroAssetId)}”, outro “{assetName(config.themeOutroAssetId)}”, bed “{assetName(config.bedAssetId)}”.
              </div>
            </div>
          </div>

          {/* Upload */}
          <div className="controlsPanel">
            <div className="panelTitle">Upload Asset</div>
            <form onSubmit={handleUpload} style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              <input type="text" className="input" placeholder="Name" value={upName} onChange={(e) => setUpName(e.target.value)} required disabled={busy} />
              <select className="select" value={upKind} onChange={(e) => setUpKind(e.target.value as AssetKind)} disabled={busy}>
                {ASSET_KINDS.map((k) => <option key={k} value={k}>{ASSET_KIND_LABELS[k]}</option>)}
              </select>
              {upKind === "sfx" && (
                <select className="select" value={upCategory} onChange={(e) => setUpCategory(e.target.value)} disabled={busy}>
                  {SFX_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
              <input type="text" className="input" placeholder="Tags (comma-separated)" value={upTags} onChange={(e) => setUpTags(e.target.value)} disabled={busy} />
              <input type="text" className="input" placeholder="License (required, e.g. 'CC0', 'Licensed — invoice #123')" value={upLicense} onChange={(e) => setUpLicense(e.target.value)} required disabled={busy} />
              <input type="text" className="input" placeholder="License note / attribution (optional)" value={upLicenseNote} onChange={(e) => setUpLicenseNote(e.target.value)} disabled={busy} />
              <input type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac" className="input" onChange={(e) => setUpFile(e.target.files?.[0] || null)} disabled={busy} />
              {upKind === "highlight" && (
                <label style={{ display: "flex", gap: "0.45rem", alignItems: "flex-start", fontSize: "0.75rem", cursor: "pointer" }}>
                  <input type="checkbox" checked={upRights} onChange={(e) => setUpRights(e.target.checked)} style={{ marginTop: "0.15rem" }} />
                  <span>
                    I affirm this clip is from a cleared/licensed source or my own recording, and I hold the rights to
                    use it in published episodes. (Required — unconfirmed highlights are never mixed in.)
                  </span>
                </label>
              )}
              <button type="submit" className="buttonPrimary" disabled={busy || (upKind === "highlight" && !upRights)} style={{ width: "100%" }}>
                {busy ? "Uploading…" : "Upload"}
              </button>
              <div style={{ fontSize: "0.68rem", color: "var(--text-secondary)" }}>
                Royalty-free or licensed audio only. Copyrighted music/SFX and off-the-web broadcast audio are not allowed.
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
