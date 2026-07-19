"use client";

// Podcast Sound & Branding client (PR 2: SONIC IDENTITY + VARIANT POOLS).
// Every role (intro/outro/bed/transition/reaction) is a weighted, ordered POOL
// of variants with a cue family, branded-motif flag, and optional format
// restrictions. A sonic-identity section declares the show's creative identity.
// A deterministic "Preview Resolution" shows three example future episodes
// without creating any. Previews use the authorized route (never storage URLs);
// a stale save shows a reload banner instead of clobbering.

import { useMemo, useState, useTransition } from "react";
import type { PodcastSoundData, PreviewExample } from "./actions";
import { savePodcastSound, previewPodcastSoundResolution } from "./actions";
import type { SoundAssignmentInput } from "@/lib/services/podcastSoundProfile";
import {
  PACES, INTENSITIES, BROADCAST_STYLES, TRANSITION_FREQUENCIES, BED_POLICIES, VOICE_OVER_MUSIC_POLICIES,
  ROLE_CUE_FAMILIES, ALL_CUE_FAMILIES, type SonicIdentity, DEFAULT_SONIC_IDENTITY,
} from "@/lib/audio/sonicIdentity";

type Row = {
  assetId: string; enabled: boolean; cueFamily: string | null; weight: number; isBrandedMotif: boolean;
  gainDb: number | null; fadeInMs: number | null; fadeOutMs: number | null;
  allowedFormatIds: string[]; prohibitedFormatIds: string[];
};
const ROLES: Array<{ role: string; label: string; kinds: string[]; testid: string }> = [
  { role: "intro", label: "Intro variants", kinds: ["theme_intro"], testid: "pool-intro" },
  { role: "outro", label: "Outro variants", kinds: ["theme_outro"], testid: "pool-outro" },
  { role: "bed", label: "Beds", kinds: ["bed"], testid: "pool-bed" },
  { role: "stinger", label: "Transitions", kinds: ["stinger"], testid: "pool-stinger" },
  { role: "reaction", label: "Reactions", kinds: ["sfx"], testid: "pool-reaction" },
];

const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export default function SoundBranding({ podcastId, data }: { podcastId: string; data: PodcastSoundData }) {
  const assets = useMemo(() => data.assets ?? [], [data.assets]);
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const initial = data.assignments ?? [];
  const toRow = (a: (typeof initial)[number]): Row => ({
    assetId: a.assetId, enabled: a.enabled, cueFamily: a.cueFamily, weight: a.weight, isBrandedMotif: a.isBrandedMotif,
    gainDb: a.gainDb, fadeInMs: a.fadeInMs, fadeOutMs: a.fadeOutMs,
    allowedFormatIds: a.allowedFormatIds ?? [], prohibitedFormatIds: a.prohibitedFormatIds ?? [],
  });
  const pickRows = (role: string) => initial.filter((a) => a.role === role).sort((x, y) => x.orderIndex - y.orderIndex).map(toRow);

  const [mode, setMode] = useState(data.production?.soundProfileMode ?? "system_default");
  const [version, setVersion] = useState(data.configVersion ?? 1);
  const [pools, setPools] = useState<Record<string, Row[]>>(() =>
    Object.fromEntries(ROLES.map((r) => [r.role, pickRows(r.role)])));
  const [introEnabled, setIntroEnabled] = useState(data.production?.defaultIntroEnabled ?? true);
  const [outroEnabled, setOutroEnabled] = useState(data.production?.defaultOutroEnabled ?? true);
  const [cooldownScope, setCooldownScope] = useState(data.production?.cooldownScope ?? "podcast");
  const [loudness, setLoudness] = useState(data.production?.targetLoudnessLufs?.toString() ?? "");
  const [id, setId] = useState<SonicIdentity>(data.sonicIdentity ?? DEFAULT_SONIC_IDENTITY);
  const [status, setStatus] = useState("");
  const [conflict, setConflict] = useState(false);
  const [examples, setExamples] = useState<PreviewExample[] | null>(null);
  const [pending, startTransition] = useTransition();

  const setPool = (role: string, rows: Row[]) => setPools((p) => ({ ...p, [role]: rows }));
  const options = (kinds: string[]) => assets.filter((a) => kinds.includes(a.kind) && !a.isArchived && a.processingStatus === "ready" && a.scope !== "legacy_global" && a.kind !== "highlight");
  const patchId = (patch: Partial<SonicIdentity>) => setId((cur) => ({ ...cur, ...patch }));

  const variantPool = (cfg: (typeof ROLES)[number]) => {
    const rows = pools[cfg.role] ?? [];
    const families = ROLE_CUE_FAMILIES[cfg.role] ?? [];
    return (
      <fieldset style={{ margin: "8px 0" }} data-testid={cfg.testid}>
        <legend>{cfg.label}</legend>
        <select aria-label={`Add to ${cfg.label}`} value="" data-testid={`${cfg.testid}-add`}
          onChange={(e) => {
            if (!e.target.value) return;
            if (rows.some((r) => r.assetId === e.target.value)) { setStatus("Already in the pool."); return; }
            setPool(cfg.role, [...rows, { assetId: e.target.value, enabled: true, cueFamily: null, weight: 1, isBrandedMotif: false, gainDb: null, fadeInMs: null, fadeOutMs: null, allowedFormatIds: [], prohibitedFormatIds: [] }]);
          }}>
          <option value="">Add a variant…</option>
          {options(cfg.kinds).map((a) => <option key={a.id} value={a.id}>{a.name} — {a.scopeLabel}</option>)}
        </select>
        <ol>
          {rows.map((r, i) => {
            const meta = byId.get(r.assetId);
            const upd = (patch: Partial<Row>) => setPool(cfg.role, rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <li key={r.assetId} data-testid={`${cfg.testid}-row-${r.assetId}`}>
                <label><input type="checkbox" checked={r.enabled} onChange={(e) => upd({ enabled: e.target.checked })} aria-label={`Enabled ${meta?.name ?? r.assetId}`} /> {meta?.name ?? r.assetId}</label>
                {meta?.isArchived && <strong> — archived: replace this asset</strong>}
                {meta && meta.rightsStatus && meta.rightsStatus !== "not_required" && meta.rightsStatus !== "confirmed" && <strong> — rights {meta.rightsStatus}</strong>}
                {" "}
                <label>family <select value={r.cueFamily ?? ""} onChange={(e) => upd({ cueFamily: e.target.value || null })} aria-label={`Cue family for ${meta?.name ?? r.assetId}`}>
                  <option value="">(none)</option>
                  {families.map((f) => <option key={f} value={f}>{f}</option>)}
                </select></label>{" "}
                <label>weight <input type="number" min={0} max={100} step={1} style={{ width: 60 }} value={r.weight} aria-label={`Weight for ${meta?.name ?? r.assetId}`}
                  onChange={(e) => upd({ weight: e.target.value === "" ? 1 : Number(e.target.value) })} /></label>{" "}
                <label><input type="checkbox" checked={r.isBrandedMotif} onChange={(e) => upd({ isBrandedMotif: e.target.checked })} aria-label={`Branded motif ${meta?.name ?? r.assetId}`} /> motif</label>{" "}
                <label>gain <input type="number" min={-24} max={6} step={0.5} style={{ width: 60 }} value={r.gainDb ?? ""} aria-label={`Gain for ${meta?.name ?? r.assetId}`}
                  onChange={(e) => upd({ gainDb: e.target.value === "" ? null : Number(e.target.value) })} /></label>{" "}
                <label>formats <input type="text" placeholder="all" style={{ width: 120 }} value={r.allowedFormatIds.join(",")} aria-label={`Allowed formats for ${meta?.name ?? r.assetId}`}
                  onChange={(e) => upd({ allowedFormatIds: csv(e.target.value) })} /></label>{" "}
                <button type="button" onClick={() => i > 0 && setPool(cfg.role, rows.map((x, j) => (j === i - 1 ? rows[i] : j === i ? rows[i - 1] : x)))} aria-label={`Move ${meta?.name} up`}>↑</button>{" "}
                <button type="button" onClick={() => i < rows.length - 1 && setPool(cfg.role, rows.map((x, j) => (j === i + 1 ? rows[i] : j === i ? rows[i + 1] : x)))} aria-label={`Move ${meta?.name} down`}>↓</button>{" "}
                <button type="button" onClick={() => setPool(cfg.role, rows.filter((_, j) => j !== i))} aria-label={`Remove ${meta?.name}`}>Remove</button>
                {meta && <> <PreviewButton path={meta.previewPath} /></>}
              </li>
            );
          })}
        </ol>
      </fieldset>
    );
  };

  const buildAssignments = (): SoundAssignmentInput[] => {
    const out: SoundAssignmentInput[] = [];
    for (const cfg of ROLES) {
      (pools[cfg.role] ?? []).forEach((r, i) => out.push({
        assetId: r.assetId, role: cfg.role as never, orderIndex: i, enabled: r.enabled,
        cueFamily: r.cueFamily, weight: r.weight, isBrandedMotif: r.isBrandedMotif,
        gainDb: r.gainDb, fadeInMs: r.fadeInMs, fadeOutMs: r.fadeOutMs,
        allowedFormatIds: r.allowedFormatIds, prohibitedFormatIds: r.prohibitedFormatIds,
      }));
    }
    return out;
  };

  const save = () => {
    setStatus("Saving…");
    startTransition(async () => {
      try {
        const res = await savePodcastSound({
          podcastId, expectedVersion: version,
          soundProfileMode: mode as never, cooldownScope: cooldownScope as never,
          targetLoudnessLufs: loudness === "" ? null : Number(loudness),
          defaultIntroEnabled: introEnabled, defaultOutroEnabled: outroEnabled,
          assignments: mode === "custom" ? buildAssignments() : [],
          sonicIdentity: id,
        });
        if (res.success) { setVersion(res.configVersion!); setConflict(false); setStatus("Saved. New episodes use this profile; existing episodes keep the sound they were made with."); }
        else { setConflict(!!res.conflict); setStatus(res.error ?? "Save failed."); }
      } catch { setStatus("Save failed — try again."); }
    });
  };

  const preview = () => {
    setStatus("Resolving preview…");
    startTransition(async () => {
      const res = await previewPodcastSoundResolution(podcastId);
      if (res.success) { setExamples(res.examples ?? []); setStatus(res.note ?? ""); }
      else { setStatus(res.error ?? "Preview failed."); }
    });
  };

  const enumSelect = (label: string, field: keyof SonicIdentity, opts: readonly string[], testid: string) => (
    <label style={{ display: "block" }}>{label}{" "}
      <select data-testid={testid} value={(id[field] as string) ?? ""} onChange={(e) => patchId({ [field]: e.target.value || null } as Partial<SonicIdentity>)}>
        <option value="">(unset)</option>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );

  return (
    <div data-testid="sound-branding">
      <p aria-live="polite" role="status" data-testid="sound-status" style={{ minHeight: "1.2em" }}>{pending ? "Working…" : status}</p>
      {conflict && (
        <p role="alert" data-testid="sound-conflict" style={{ border: "1px solid var(--border, #a33)", padding: 8 }}>
          Someone else changed this show&apos;s configuration. Reload the page to continue from the latest version.
        </p>
      )}

      <fieldset>
        <legend>Sound profile</legend>
        {["system_default", "custom", "clean"].map((m) => (
          <label key={m} style={{ display: "block" }}>
            <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} data-testid={`mode-${m}`} />{" "}
            {m === "system_default" ? "House sound (shared system profile)" : m === "custom" ? "Custom (this show's own sonic identity)" : "Clean (dialogue only)"}
          </label>
        ))}
      </fieldset>

      {mode === "custom" && (
        <>
          <fieldset data-testid="sonic-identity">
            <legend>Sonic identity</legend>
            <label style={{ display: "block" }}>Primary genre <input type="text" data-testid="identity-genre" value={id.primaryGenre ?? ""} onChange={(e) => patchId({ primaryGenre: e.target.value || null })} /></label>
            <label style={{ display: "block" }}>Moods (comma) <input type="text" data-testid="identity-moods" value={id.moods.join(",")} onChange={(e) => patchId({ moods: csv(e.target.value) })} /></label>
            {enumSelect("Pace", "pace", PACES, "identity-pace")}
            {enumSelect("Intensity", "intensity", INTENSITIES, "identity-intensity")}
            {enumSelect("Broadcast style", "broadcastStyle", BROADCAST_STYLES, "identity-broadcast")}
            {enumSelect("Transition frequency", "transitionFrequency", TRANSITION_FREQUENCIES, "identity-transitionfreq")}
            {enumSelect("Max effects intensity", "maximumEffectsIntensity", INTENSITIES, "identity-maxfx")}
            {enumSelect("Bed policy", "bedPolicy", BED_POLICIES, "identity-bedpolicy")}
            {enumSelect("Voice-over-music", "voiceOverMusicPolicy", VOICE_OVER_MUSIC_POLICIES, "identity-vom")}
            <label style={{ display: "block" }}>Min music gap ms <input type="number" min={0} max={120000} data-testid="identity-mingap" value={id.minimumMusicGapMs ?? ""} onChange={(e) => patchId({ minimumMusicGapMs: e.target.value === "" ? null : Number(e.target.value) })} /></label>
            <label style={{ display: "block" }}>Max music gap ms <input type="number" min={0} max={120000} data-testid="identity-maxgap" value={id.maximumMusicGapMs ?? ""} onChange={(e) => patchId({ maximumMusicGapMs: e.target.value === "" ? null : Number(e.target.value) })} /></label>
            <label style={{ display: "block" }}><input type="checkbox" checked={id.humorEffectsAllowed} onChange={(e) => patchId({ humorEffectsAllowed: e.target.checked })} data-testid="identity-humor" /> Humor/comedy effects allowed</label>
            <label style={{ display: "block" }}><input type="checkbox" checked={id.crowdEffectsAllowed} onChange={(e) => patchId({ crowdEffectsAllowed: e.target.checked })} data-testid="identity-crowd" /> Crowd/arena effects allowed</label>
            <label style={{ display: "block" }}><input type="checkbox" checked={id.underSpeechEffectsAllowed} onChange={(e) => patchId({ underSpeechEffectsAllowed: e.target.checked })} data-testid="identity-underspeech" /> Under-speech effects allowed</label>
            <label style={{ display: "block" }}>Prohibited cue families
              <select multiple data-testid="identity-prohibited-families" value={id.prohibitedCueFamilies}
                onChange={(e) => patchId({ prohibitedCueFamilies: Array.from(e.target.selectedOptions).map((o) => o.value) })} style={{ minWidth: 180 }}>
                {ALL_CUE_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <label style={{ display: "block" }}>Prohibited formats (comma) <input type="text" data-testid="identity-prohibited-formats" value={id.prohibitedFormatIds.join(",")} onChange={(e) => patchId({ prohibitedFormatIds: csv(e.target.value) })} /></label>
          </fieldset>

          <section aria-label="Variant pools">
            <label style={{ display: "block" }}><input type="checkbox" checked={introEnabled} onChange={(e) => setIntroEnabled(e.target.checked)} data-testid="intro-enabled" /> Intro enabled</label>
            <label style={{ display: "block" }}><input type="checkbox" checked={outroEnabled} onChange={(e) => setOutroEnabled(e.target.checked)} data-testid="outro-enabled" /> Outro enabled</label>
            {ROLES.map((cfg) => <div key={cfg.role}>{variantPool(cfg)}</div>)}
          </section>
        </>
      )}

      <fieldset>
        <legend>Rotation &amp; loudness</legend>
        <label style={{ display: "block" }}>Cooldown scope{" "}
          <select value={cooldownScope} onChange={(e) => setCooldownScope(e.target.value)} data-testid="cooldown-scope">
            <option value="podcast">This show only (default)</option>
            <option value="owner">All my shows</option>
          </select>
        </label>
        <label style={{ display: "block" }}>Target loudness (LUFS, empty = default -16){" "}
          <input type="number" min={-30} max={-8} step={0.5} value={loudness} onChange={(e) => setLoudness(e.target.value)} data-testid="loudness" />
        </label>
      </fieldset>

      {data.resolvedProfile?.containsLegacyCompatAssets && (
        <p data-testid="legacy-warning"><strong>Note:</strong> the current house sound includes pre-ownership legacy assets pending admin review.</p>
      )}
      {data.resolvedProfile && data.resolvedProfile.excluded.length > 0 && (
        <p role="alert" data-testid="excluded-warning">
          <strong>Needs attention:</strong> {data.resolvedProfile.excluded.length} configured asset(s) are currently unusable
          ({data.resolvedProfile.excluded.map((e) => `${e.role}: ${e.reason}`).join("; ")}) and will be left out of new episodes until replaced.
        </p>
      )}

      {/* Sticky action footer — sits ABOVE the fixed persistent player bar (and
          the mobile safe-area inset) so Save/Preview are always genuinely
          clickable by mouse and keyboard, never intercepted by the player. */}
      <div
        data-testid="sound-actions"
        style={{
          position: "sticky",
          bottom: "calc(var(--u-player-h, 72px) + env(safe-area-inset-bottom, 0px) + 12px)",
          zIndex: 1,
          marginTop: 16,
          padding: "10px 0",
          background: "var(--u-surface, var(--surface, #fff))",
          borderTop: "1px solid var(--u-hairline-2, var(--border, #e5e5e5))",
        }}
      >
        <button type="button" onClick={save} disabled={pending} data-testid="sound-save">Save sound profile</button>{" "}
        <button type="button" onClick={preview} disabled={pending} data-testid="sound-preview">Preview resolution</button>
      </div>

      {examples && (
        <section data-testid="preview-examples" aria-label="Preview resolutions">
          <p><em>Example future episode resolutions (each real episode&apos;s selection is frozen at creation):</em></p>
          {examples.map((ex, i) => (
            <div key={ex.seed} data-testid={`preview-example-${i}`} style={{ border: "1px solid var(--border,#ccc)", padding: 8, margin: "6px 0" }}>
              <div>Intro: <strong>{ex.intro ?? "(none)"}</strong> — {ex.introReason}</div>
              <div>Outro: <strong>{ex.outro ?? "(none)"}</strong> — {ex.outroReason}</div>
              <div>Bed: <strong>{ex.bed ?? "(none)"}</strong> — {ex.bedReason}</div>
              <div>Transition families: {ex.transitionFamilies.join(", ") || "—"}</div>
              <div>Reaction families: {ex.reactionFamilies.join(", ") || "—"}</div>
              {ex.exclusions.length > 0 && <div>Excluded: {ex.exclusions.map((e) => `${e.role}: ${e.reason}`).join("; ")}</div>}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function PreviewButton({ path }: { path: string }) {
  const [playing, setPlaying] = useState<HTMLAudioElement | null>(null);
  return (
    <button type="button" aria-pressed={!!playing}
      onClick={() => {
        if (playing) { playing.pause(); setPlaying(null); return; }
        const el = new Audio(path); // authorized preview route — never a storage URL
        el.onended = () => setPlaying(null);
        el.play().then(() => setPlaying(el)).catch(() => setPlaying(null));
      }}>
      {playing ? "Stop" : "Preview"}
    </button>
  );
}
