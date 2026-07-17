"use client";

// Podcast Sound & Branding client (Prompt 6). Explicit move buttons for pool
// ordering (keyboard-operable), previews via the authorized route, archived/
// rights warnings in text (never color-only), and configuration-version
// conflict handling: a stale save shows a reload banner instead of clobbering.

import { useMemo, useState, useTransition } from "react";
import type { PodcastSoundData } from "./actions";
import { savePodcastSound } from "./actions";
import type { SoundAssignmentInput } from "@/lib/services/podcastSoundProfile";

type Row = { assetId: string; gainDb: number | null; fadeInMs: number | null; fadeOutMs: number | null };

export default function SoundBranding({ podcastId, data }: { podcastId: string; data: PodcastSoundData }) {
  const assets = data.assets ?? [];
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const initial = data.assignments ?? [];
  const pick = (role: string) => initial.filter((a) => a.role === role).sort((x, y) => x.orderIndex - y.orderIndex);

  const [mode, setMode] = useState(data.production?.soundProfileMode ?? "system_default");
  const [version, setVersion] = useState(data.configVersion ?? 1);
  const [intro, setIntro] = useState<Row | null>(pick("intro")[0] ?? null);
  const [outro, setOutro] = useState<Row | null>(pick("outro")[0] ?? null);
  const [bed, setBed] = useState<Row | null>(pick("bed")[0] ?? null);
  const [stingers, setStingers] = useState<Row[]>(pick("stinger"));
  const [reactions, setReactions] = useState<Row[]>(pick("reaction"));
  const [cooldownScope, setCooldownScope] = useState(data.production?.cooldownScope ?? "podcast");
  const [loudness, setLoudness] = useState(data.production?.targetLoudnessLufs?.toString() ?? "");
  const [status, setStatus] = useState("");
  const [conflict, setConflict] = useState(false);
  const [pending, startTransition] = useTransition();

  const options = (kinds: string[]) => assets.filter((a) => kinds.includes(a.kind) && !a.isArchived && a.processingStatus === "ready" && a.scope !== "legacy_global" && a.kind !== "highlight");

  const singleton = (label: string, kinds: string[], value: Row | null, set: (r: Row | null) => void, testid: string) => (
    <label style={{ display: "block", margin: "8px 0" }}>
      {label}{" "}
      <select
        value={value?.assetId ?? ""}
        onChange={(e) => set(e.target.value ? { assetId: e.target.value, gainDb: null, fadeInMs: null, fadeOutMs: null } : null)}
        data-testid={testid}
      >
        <option value="">(none)</option>
        {options(kinds).map((a) => (
          <option key={a.id} value={a.id}>{a.name} — {a.scopeLabel}</option>
        ))}
      </select>
      {value && byId.get(value.assetId) && (
        <span> <PreviewButton path={byId.get(value.assetId)!.previewPath} /></span>
      )}
    </label>
  );

  const pool = (label: string, kinds: string[], rows: Row[], set: (r: Row[]) => void, testid: string) => (
    <fieldset style={{ margin: "8px 0" }}>
      <legend>{label}</legend>
      <select
        aria-label={`Add to ${label}`}
        value=""
        onChange={(e) => {
          if (!e.target.value) return;
          if (rows.some((r) => r.assetId === e.target.value)) { setStatus("Already in the pool."); return; }
          set([...rows, { assetId: e.target.value, gainDb: null, fadeInMs: null, fadeOutMs: null }]);
        }}
        data-testid={`${testid}-add`}
      >
        <option value="">Add an asset…</option>
        {options(kinds).map((a) => <option key={a.id} value={a.id}>{a.name} — {a.scopeLabel}</option>)}
      </select>
      <ol>
        {rows.map((r, i) => {
          const meta = byId.get(r.assetId);
          return (
            <li key={r.assetId} data-testid={`${testid}-row-${r.assetId}`}>
              {meta?.name ?? r.assetId}
              {meta?.isArchived && <strong> — archived: replace this asset</strong>}
              {" "}
              <label>gain dB <input type="number" min={-24} max={6} step={0.5} style={{ width: 70 }}
                value={r.gainDb ?? ""} aria-label={`Gain for ${meta?.name ?? r.assetId}`}
                onChange={(e) => set(rows.map((x, j) => j === i ? { ...x, gainDb: e.target.value === "" ? null : Number(e.target.value) } : x))} /></label>{" "}
              <label>fade in ms <input type="number" min={0} max={10000} step={50} style={{ width: 80 }}
                value={r.fadeInMs ?? ""} aria-label={`Fade in for ${meta?.name ?? r.assetId}`}
                onChange={(e) => set(rows.map((x, j) => j === i ? { ...x, fadeInMs: e.target.value === "" ? null : Number(e.target.value) } : x))} /></label>{" "}
              <button type="button" onClick={() => i > 0 && set(rows.map((x, j) => j === i - 1 ? rows[i] : j === i ? rows[i - 1] : x))} aria-label={`Move ${meta?.name} up`}>↑</button>{" "}
              <button type="button" onClick={() => i < rows.length - 1 && set(rows.map((x, j) => j === i + 1 ? rows[i] : j === i ? rows[i + 1] : x))} aria-label={`Move ${meta?.name} down`}>↓</button>{" "}
              <button type="button" onClick={() => set(rows.filter((_, j) => j !== i))} aria-label={`Remove ${meta?.name}`}>Remove</button>
              {meta && <> <PreviewButton path={meta.previewPath} /></>}
            </li>
          );
        })}
      </ol>
    </fieldset>
  );

  const save = () => {
    const assignments: SoundAssignmentInput[] = [];
    if (mode === "custom") {
      if (intro) assignments.push({ ...intro, role: "intro" });
      if (outro) assignments.push({ ...outro, role: "outro" });
      if (bed) assignments.push({ ...bed, role: "bed" });
      stingers.forEach((s, i) => assignments.push({ ...s, role: "stinger", orderIndex: i }));
      reactions.forEach((s, i) => assignments.push({ ...s, role: "reaction", orderIndex: i }));
    }
    setStatus("Saving…");
    startTransition(async () => {
      const res = await savePodcastSound({
        podcastId,
        expectedVersion: version,
        soundProfileMode: mode as never,
        cooldownScope: cooldownScope as never,
        targetLoudnessLufs: loudness === "" ? null : Number(loudness),
        assignments,
      });
      if (res.success) {
        setVersion(res.configVersion!);
        setConflict(false);
        setStatus("Saved. New episodes will use this profile; existing episodes keep the sound they were made with.");
      } else {
        setConflict(!!res.conflict);
        setStatus(res.error ?? "Save failed.");
      }
    });
  };

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
            {m === "system_default" ? "House sound (shared system profile)" : m === "custom" ? "Custom (this show's own assets)" : "Clean (dialogue only)"}
          </label>
        ))}
      </fieldset>

      {mode === "custom" && (
        <section aria-label="Custom assignments">
          {singleton("Intro theme", ["theme_intro"], intro, setIntro, "assign-intro")}
          {singleton("Outro theme", ["theme_outro"], outro, setOutro, "assign-outro")}
          {singleton("Music bed", ["bed"], bed, setBed, "assign-bed")}
          {pool("Stinger pool", ["stinger"], stingers, setStingers, "pool-stinger")}
          {pool("Reaction SFX pool", ["sfx"], reactions, setReactions, "pool-reaction")}
        </section>
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

      <button type="button" onClick={save} disabled={pending} data-testid="sound-save">Save sound profile</button>
    </div>
  );
}

function PreviewButton({ path }: { path: string }) {
  const [playing, setPlaying] = useState<HTMLAudioElement | null>(null);
  return (
    <button
      type="button"
      aria-pressed={!!playing}
      onClick={() => {
        if (playing) { playing.pause(); setPlaying(null); return; }
        const el = new Audio(path); // authorized preview route — never a storage URL
        el.onended = () => setPlaying(null);
        el.play().then(() => setPlaying(el)).catch(() => setPlaying(null));
      }}
    >
      {playing ? "Stop" : "Preview"}
    </button>
  );
}
