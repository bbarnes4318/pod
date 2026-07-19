"use client";

// Admin: SYSTEM-DEFAULT variant pools (PR 2 review, Blocker 2) + per-asset
// CUE METADATA editor (Blocker 3). Ordinary interactions; a sticky action
// footer keeps Save clickable. Never shows storage URLs/keys.

import { useMemo, useState, useTransition } from "react";
import type { SystemSoundData, SystemPreviewExample } from "./actions";
import { saveSystemSound, previewSystemSoundResolution, updateAssetCueMetadata } from "./actions";
import type { SoundAssignmentInput } from "@/lib/services/podcastSoundProfile";
import { ROLE_CUE_FAMILIES } from "@/lib/audio/sonicIdentity";

const METADATA_STATE_HINT: Record<string, string> = {
  unclassified: "no metadata",
  suggested: "proposed — NOT authoritative",
  verified: "authoritative for hard compatibility",
};

type Row = { assetId: string; enabled: boolean; cueFamily: string | null; weight: number; isBrandedMotif: boolean; gainDb: number | null; fadeInMs: number | null; fadeOutMs: number | null; allowedFormatIds: string[]; prohibitedFormatIds: string[] };
const ROLES: Array<{ role: string; label: string; kinds: string[]; testid: string }> = [
  { role: "intro", label: "System intro variants", kinds: ["theme_intro"], testid: "sys-pool-intro" },
  { role: "outro", label: "System outro variants", kinds: ["theme_outro"], testid: "sys-pool-outro" },
  { role: "bed", label: "System beds", kinds: ["bed"], testid: "sys-pool-bed" },
  { role: "stinger", label: "System transitions", kinds: ["stinger"], testid: "sys-pool-stinger" },
  { role: "reaction", label: "System reactions", kinds: ["sfx"], testid: "sys-pool-reaction" },
];
const KIND_ROLE: Record<string, string> = { theme_intro: "intro", theme_outro: "outro", bed: "bed", stinger: "stinger", sfx: "reaction" };
const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export default function SystemSoundPools({ data }: { data: SystemSoundData }) {
  const assets = useMemo(() => data.assets ?? [], [data.assets]);
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const initial = data.assignments ?? [];
  const [version, setVersion] = useState(data.configVersion ?? 1);
  const [pools, setPools] = useState<Record<string, Row[]>>(() =>
    Object.fromEntries(ROLES.map((r) => [r.role, initial.filter((a) => a.role === r.role).sort((x, y) => x.orderIndex - y.orderIndex).map((a) => ({
      assetId: a.assetId, enabled: a.enabled, cueFamily: a.cueFamily, weight: a.weight, isBrandedMotif: a.isBrandedMotif,
      gainDb: a.gainDb, fadeInMs: a.fadeInMs, fadeOutMs: a.fadeOutMs, allowedFormatIds: a.allowedFormatIds ?? [], prohibitedFormatIds: a.prohibitedFormatIds ?? [],
    }))])));
  const [status, setStatus] = useState("");
  const [conflict, setConflict] = useState(false);
  const [examples, setExamples] = useState<SystemPreviewExample[] | null>(null);
  const [pending, startTransition] = useTransition();

  const options = (kinds: string[]) => assets.filter((a) => kinds.includes(a.kind) && !a.isArchived && a.processingStatus === "ready");
  const setPool = (role: string, rows: Row[]) => setPools((p) => ({ ...p, [role]: rows }));

  const pool = (cfg: (typeof ROLES)[number]) => {
    const rows = pools[cfg.role] ?? [];
    const fams = ROLE_CUE_FAMILIES[cfg.role] ?? [];
    return (
      <fieldset style={{ margin: "8px 0" }} data-testid={cfg.testid}>
        <legend>{cfg.label}</legend>
        <select aria-label={`Add to ${cfg.label}`} value="" data-testid={`${cfg.testid}-add`}
          onChange={(e) => { if (!e.target.value) return; if (rows.some((r) => r.assetId === e.target.value)) { setStatus("Already in the pool."); return; }
            setPool(cfg.role, [...rows, { assetId: e.target.value, enabled: true, cueFamily: null, weight: 1, isBrandedMotif: false, gainDb: null, fadeInMs: null, fadeOutMs: null, allowedFormatIds: [], prohibitedFormatIds: [] }]); }}>
          <option value="">Add a system variant…</option>
          {options(cfg.kinds).map((a) => <option key={a.id} value={a.id}>{a.name} — {a.scope}</option>)}
        </select>
        <ol>
          {rows.map((r, i) => {
            const meta = byId.get(r.assetId);
            const upd = (patch: Partial<Row>) => setPool(cfg.role, rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <li key={r.assetId} data-testid={`${cfg.testid}-row-${r.assetId}`}>
                <label><input type="checkbox" checked={r.enabled} onChange={(e) => upd({ enabled: e.target.checked })} aria-label={`Enabled ${meta?.name}`} /> {meta?.name ?? r.assetId}</label>{" "}
                <label>family <select value={r.cueFamily ?? ""} onChange={(e) => upd({ cueFamily: e.target.value || null })} aria-label={`Family for ${meta?.name}`}>
                  <option value="">(none)</option>{fams.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>{" "}
                <label>weight <input type="number" min={0} max={100} step={1} style={{ width: 60 }} value={r.weight} aria-label={`Weight for ${meta?.name}`} onChange={(e) => upd({ weight: e.target.value === "" ? 1 : Number(e.target.value) })} /></label>{" "}
                <label><input type="checkbox" checked={r.isBrandedMotif} onChange={(e) => upd({ isBrandedMotif: e.target.checked })} aria-label={`Motif ${meta?.name}`} /> motif</label>{" "}
                <label>gain <input type="number" min={-24} max={6} step={0.5} style={{ width: 60 }} value={r.gainDb ?? ""} aria-label={`Gain for ${meta?.name}`} onChange={(e) => upd({ gainDb: e.target.value === "" ? null : Number(e.target.value) })} /></label>{" "}
                <label>formats <input type="text" placeholder="all" style={{ width: 110 }} value={r.allowedFormatIds.join(",")} aria-label={`Formats for ${meta?.name}`} onChange={(e) => upd({ allowedFormatIds: csv(e.target.value) })} /></label>{" "}
                <button type="button" onClick={() => i > 0 && setPool(cfg.role, rows.map((x, j) => (j === i - 1 ? rows[i] : j === i ? rows[i - 1] : x)))} aria-label={`Move ${meta?.name} up`}>↑</button>{" "}
                <button type="button" onClick={() => i < rows.length - 1 && setPool(cfg.role, rows.map((x, j) => (j === i + 1 ? rows[i] : j === i ? rows[i + 1] : x)))} aria-label={`Move ${meta?.name} down`}>↓</button>{" "}
                <button type="button" onClick={() => setPool(cfg.role, rows.filter((_, j) => j !== i))} aria-label={`Remove ${meta?.name}`}>Remove</button>
              </li>
            );
          })}
        </ol>
      </fieldset>
    );
  };

  const save = () => {
    const assignments: SoundAssignmentInput[] = [];
    for (const cfg of ROLES) (pools[cfg.role] ?? []).forEach((r, i) => assignments.push({ assetId: r.assetId, role: cfg.role as never, orderIndex: i, enabled: r.enabled, cueFamily: r.cueFamily, weight: r.weight, isBrandedMotif: r.isBrandedMotif, gainDb: r.gainDb, fadeInMs: r.fadeInMs, fadeOutMs: r.fadeOutMs, allowedFormatIds: r.allowedFormatIds, prohibitedFormatIds: r.prohibitedFormatIds }));
    setStatus("Saving…");
    startTransition(async () => {
      const res = await saveSystemSound({ expectedVersion: version, assignments });
      if (res.success) { setVersion(res.configVersion!); setConflict(false); setStatus("System pools saved. New episodes on the house sound will rotate among these variants."); }
      else { setConflict(!!res.conflict); setStatus(res.error ?? "Save failed."); }
    });
  };
  const preview = () => { setStatus("Resolving…"); startTransition(async () => { const res = await previewSystemSoundResolution(); if (res.success) { setExamples(res.examples ?? []); setStatus(res.note ?? ""); } else setStatus(res.error ?? "Preview failed."); }); };

  return (
    <section data-testid="system-sound-pools" style={{ marginTop: 24 }}>
      <h2>System-default variant pools</h2>
      <p aria-live="polite" role="status" data-testid="sys-status" style={{ minHeight: "1.2em" }}>{pending ? "Working…" : status}</p>
      {conflict && <p role="alert" data-testid="sys-conflict">Reload — the system configuration changed elsewhere.</p>}
      {ROLES.map((cfg) => <div key={cfg.role}>{pool(cfg)}</div>)}

      <div data-testid="sys-actions" style={{ position: "sticky", bottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)", zIndex: 1, marginTop: 16, padding: "10px 0", background: "var(--surface, #fff)", borderTop: "1px solid var(--border, #e5e5e5)" }}>
        <button type="button" onClick={save} disabled={pending} data-testid="sys-save">Save system pools</button>{" "}
        <button type="button" onClick={preview} disabled={pending} data-testid="sys-preview">Preview system resolution</button>
      </div>

      {examples && (
        <div data-testid="sys-preview-examples">
          {examples.map((ex, i) => (
            <div key={ex.seed} data-testid={`sys-preview-example-${i}`} style={{ border: "1px solid var(--border,#ccc)", padding: 6, margin: "4px 0" }}>
              Intro <strong>{ex.intro ?? "(none)"}</strong> · Outro <strong>{ex.outro ?? "(none)"}</strong> · Bed <strong>{ex.bed ?? "(none)"}</strong>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ marginTop: 28 }}>Cue metadata (admin review)</h2>
      <p><em>Only <strong>verified</strong> metadata is authoritative for hard compatibility. Suggested is proposed only; unclassified carries none.</em></p>
      <div data-testid="cue-metadata-editor">
        {assets.map((a) => <MetadataRow key={a.id} asset={a} onStatus={setStatus} />)}
      </div>
    </section>
  );
}

function MetadataRow({ asset, onStatus }: { asset: NonNullable<SystemSoundData["assets"]>[number]; onStatus: (s: string) => void }) {
  const initial = (asset.cueMetadata ?? {}) as { cueFamily?: string; genre?: string; moods?: string[]; energy?: string; instrumentation?: string[]; suitability?: { intro?: boolean; underSpeech?: boolean } };
  const role = KIND_ROLE[asset.kind];
  const fams = ROLE_CUE_FAMILIES[role] ?? [];
  const [cueFamily, setCueFamily] = useState(initial.cueFamily ?? "");
  const [genre, setGenre] = useState(initial.genre ?? "");
  const [moods, setMoods] = useState((initial.moods ?? []).join(","));
  const [instrumentation, setInstr] = useState((initial.instrumentation ?? []).join(","));
  const [state, setState] = useState(asset.metadataState);
  const [pending, startTransition] = useTransition();

  const save = () => {
    onStatus("Saving metadata…");
    startTransition(async () => {
      const res = await updateAssetCueMetadata({ assetId: asset.id, metadataState: state, cueMetadata: { cueFamily: cueFamily || null, genre: genre || null, moods: csv(moods), instrumentation: csv(instrumentation) } });
      onStatus(res.success ? "Metadata saved." : res.error ?? "Metadata save failed.");
    });
  };

  return (
    <div data-testid={`meta-row-${asset.id}`} style={{ borderBottom: "1px solid var(--border,#eee)", padding: "6px 0" }}>
      <strong>{asset.name}</strong> — {asset.kind} · {asset.scope} · {asset.processingStatus} · rights {asset.rightsStatus} · license {asset.licenseStatus}{asset.isArchived ? " · ARCHIVED" : ""}{" "}
      <label>family <select value={cueFamily} onChange={(e) => setCueFamily(e.target.value)} data-testid={`meta-family-${asset.id}`}>
        <option value="">(none)</option>{fams.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>{" "}
      <label>genre <input type="text" style={{ width: 90 }} value={genre} onChange={(e) => setGenre(e.target.value)} data-testid={`meta-genre-${asset.id}`} /></label>{" "}
      <label>moods <input type="text" style={{ width: 90 }} value={moods} onChange={(e) => setMoods(e.target.value)} aria-label={`Moods ${asset.name}`} /></label>{" "}
      <label>instr <input type="text" style={{ width: 90 }} value={instrumentation} onChange={(e) => setInstr(e.target.value)} aria-label={`Instrumentation ${asset.name}`} /></label>{" "}
      <label>state <select value={state} onChange={(e) => setState(e.target.value)} data-testid={`meta-state-${asset.id}`}>
        <option value="unclassified">unclassified</option><option value="suggested">suggested</option><option value="verified">verified</option></select></label>{" "}
      <button type="button" onClick={save} disabled={pending} data-testid={`meta-save-${asset.id}`}>Save metadata</button>
      <span style={{ fontSize: "0.85em", color: "var(--muted,#666)" }}> {METADATA_STATE_HINT[state] ?? ""}</span>
    </div>
  );
}
