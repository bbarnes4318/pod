"use client";

// Character Studio — hosts as editable recurring characters with documented
// voice provenance, real per-line auditions, and safe (soft) archiving.
//
// Every control is backed by a real server action (./actions):
//   • saveStudioHost   — persists the character bible + voice assignment +
//                        voiceSource / voiceProvenanceNote (validated voice ids).
//   • auditionHostVoice — synthesizes a REAL sample in the assigned voice via
//                        getTTSProvider().synthesizeSpeech (Step 5's primitive).
//   • archiveHost / unarchiveHost / deleteHostSafely — orphan-safe lifecycle.
// The two-colour slot mechanism keys off roster POSITION, never a host name.

import React, { useMemo, useRef, useState } from "react";
import {
  saveStudioHost,
  auditionHostVoice,
  archiveHost,
  unarchiveHost,
  deleteHostSafely,
} from "./actions";
import { VOICE_SOURCES, STUDIO_TTS_PROVIDERS, type StudioHostInput } from "./constants";

export interface StudioHostVM {
  id: string;
  name: string;
  role: string;
  worldview: string;
  speakingStyle: string;
  catchphrases: string[];
  boundaries: string[];
  intensityLevel: number;
  ttsProvider: string;
  ttsVoiceId: string;
  voiceSource: string;
  voiceProvenanceNote: string;
  isActive: boolean;
  isArchived: boolean;
  episodeCount: number;
  segmentCount: number;
}

const SOURCE_LABEL: Record<string, string> = {
  owned: "Owned",
  licensed: "Licensed",
  "synthetic-stock": "Synthetic / stock",
};

const OPENAI_HINT = "e.g. onyx, echo, nova, alloy";
function voiceHint(provider: string): string {
  if (provider === "openai") return OPENAI_HINT;
  if (provider === "fish") return "32-character hex reference id";
  if (provider === "elevenlabs") return "ElevenLabs voice id";
  if (provider === "stub") return "(stub placeholder — not auditionable)";
  return "provider voice id";
}

export default function CharacterStudio({ hosts }: { hosts: StudioHostVM[] }) {
  const active = useMemo(() => hosts.filter((h) => !h.isArchived), [hosts]);
  const archived = useMemo(() => hosts.filter((h) => h.isArchived), [hosts]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  return (
    <div className="fadeUp">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h1 className="pageTitle">Character Studio</h1>
          <p className="pageSub" style={{ marginBottom: 0 }}>
            Your recurring characters — worldview, voice, and documented provenance. Edit anyone; archive retires them without touching past episodes.
          </p>
        </div>
      </div>

      {/* Two-host casting reality — reported honestly, not faked. */}
      <div className="advNote" style={{ marginTop: "0.9rem", maxWidth: 720 }}>
        An episode is cast with exactly <strong>two</strong> hosts (the debate format). You can keep a whole roster here, but casting a third/guest into a single episode isn&apos;t supported by the generation path yet — that needs its own step.
      </div>

      <div className="grid2" style={{ marginTop: "1.5rem" }}>
        {active.map((host, i) => (
          <HostCard
            key={host.id}
            host={host}
            slot={i % 2}
            editing={editingId === host.id}
            onEdit={() => setEditingId(host.id)}
            onCloseEdit={() => setEditingId(null)}
          />
        ))}
      </div>

      {active.length === 0 && (
        <div className="emptyNote" style={{ marginTop: "1.5rem" }}>No active hosts. Restore one from the archive below, or create hosts in the personalities console.</div>
      )}

      {archived.length > 0 && (
        <div style={{ marginTop: "2rem" }}>
          <button type="button" className="advLink" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide" : "Show"} archived hosts ({archived.length})
          </button>
          {showArchived && (
            <div className="grid2" style={{ marginTop: "1rem" }}>
              {archived.map((host) => (
                <ArchivedCard key={host.id} host={host} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Active host card — provenance badge, audition, edit, archive.       */
/* ------------------------------------------------------------------ */
function HostCard({
  host, slot, editing, onEdit, onCloseEdit,
}: {
  host: StudioHostVM;
  slot: number;
  editing: boolean;
  onEdit: () => void;
  onCloseEdit: () => void;
}) {
  const accent = slot === 1 ? "var(--host-doc)" : "var(--host-max)";
  const provenanceUndocumented = !host.voiceSource;

  const [busy, setBusy] = useState<null | "audition" | "archive">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const audition = async () => {
    setBusy("audition"); setMsg(null); setErr(null);
    try {
      const res: any = await auditionHostVoice({
        provider: host.ttsProvider,
        voiceId: host.ttsVoiceId,
        name: host.name,
        role: host.role,
        speakingStyle: host.speakingStyle,
        intensityLevel: host.intensityLevel,
      });
      if (res?.success && res.audioDataUrl && audioRef.current) {
        audioRef.current.src = res.audioDataUrl;
        await audioRef.current.play().catch(() => {});
        setMsg("Playing a real sample in the assigned voice.");
      } else {
        setErr(res?.error || "Couldn't audition this voice.");
      }
    } finally {
      setBusy(null);
    }
  };

  const doArchive = async () => {
    setBusy("archive"); setErr(null);
    const res: any = await archiveHost(host.id);
    if (res?.success === false) setErr(res.error);
    setBusy(null);
  };

  if (editing) {
    return <HostEditor host={host} accent={accent} onClose={onCloseEdit} />;
  }

  return (
    <div className="studioCard" style={{ borderTop: `3px solid ${accent}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
        <div style={{ minWidth: 0 }}>
          <div className="displayTitle" style={{ fontSize: "1.6rem", color: accent }}>{host.name}</div>
          <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginTop: 4 }}>{host.role}</div>
        </div>
        <span className={`chip ${host.isActive ? "chipSuccess" : ""}`}>{host.isActive ? "On air" : "Benched"}</span>
      </div>

      {/* Voice provenance — prominent risk badge when undocumented. */}
      <div className="provRow">
        {provenanceUndocumented ? (
          <span className="provBadge provRisk">⚠ Undocumented voice provenance</span>
        ) : (
          <span className="provBadge provOk">✓ {SOURCE_LABEL[host.voiceSource] ?? host.voiceSource}</span>
        )}
        <span className="provVoice">{host.ttsProvider} · {host.ttsVoiceId.slice(0, 16)}{host.ttsVoiceId.length > 16 ? "…" : ""}</span>
      </div>

      <div className="axisRow" style={{ margin: "0.9rem 0" }}>
        <span>Intensity</span>
        <div className="scoreBarTrack"><div className="scoreBarFill" style={{ width: `${host.intensityLevel * 10}%`, background: accent }} /></div>
        <strong>{host.intensityLevel}/10</strong>
      </div>

      <p style={{ fontSize: "0.86rem", lineHeight: 1.55, color: "var(--text-primary)", marginBottom: "0.9rem" }}>{host.worldview}</p>

      {host.catchphrases.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.9rem" }}>
          {host.catchphrases.slice(0, 5).map((c, i) => (
            <span key={i} className="chip" style={{ textTransform: "none", letterSpacing: 0 }}>&ldquo;{c}&rdquo;</span>
          ))}
        </div>
      )}

      {(msg || err) && <div className={`gateResult ${err ? "gate-err" : "gate-ok"}`} style={{ marginBottom: "0.7rem" }}>{err || msg}</div>}

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button type="button" className="btnPrimary" onClick={audition} disabled={busy === "audition"}>
          {busy === "audition" ? "Synthesizing…" : "▶ Play sample"}
        </button>
        <button type="button" className="btnGhost" onClick={onEdit}>Edit character</button>
        <button type="button" className="btnGhost" onClick={doArchive} disabled={busy === "archive"} style={{ marginLeft: "auto" }}>
          {busy === "archive" ? "…" : "Archive"}
        </button>
      </div>
      <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: "0.6rem" }}>
        In {host.episodeCount} episode{host.episodeCount === 1 ? "" : "s"}.
      </div>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} preload="none" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inline character editor.                                            */
/* ------------------------------------------------------------------ */
function HostEditor({ host, accent, onClose }: { host: StudioHostVM; accent: string; onClose: () => void }) {
  const [form, setForm] = useState<StudioHostInput>({
    name: host.name,
    role: host.role,
    worldview: host.worldview,
    speakingStyle: host.speakingStyle,
    catchphrasesRaw: host.catchphrases.join("\n"),
    boundariesRaw: host.boundaries.join("\n"),
    intensityLevel: host.intensityLevel,
    ttsProvider: host.ttsProvider,
    ttsVoiceId: host.ttsVoiceId,
    voiceSource: host.voiceSource,
    voiceProvenanceNote: host.voiceProvenanceNote,
  });
  const [busy, setBusy] = useState<null | "save" | "test">(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const set = <K extends keyof StudioHostInput>(k: K, v: StudioHostInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy("save"); setErr(null); setMsg(null);
    const res: any = await saveStudioHost(host.id, form);
    if (res?.success) { setMsg("Saved."); onClose(); }
    else setErr(res?.error || "Save failed.");
    setBusy(null);
  };

  // Audition the UNSAVED form assignment — try before you commit.
  const test = async () => {
    setBusy("test"); setErr(null); setMsg(null);
    try {
      const res: any = await auditionHostVoice({
        provider: form.ttsProvider,
        voiceId: form.ttsVoiceId,
        name: form.name,
        role: form.role,
        speakingStyle: form.speakingStyle,
        intensityLevel: form.intensityLevel,
      });
      if (res?.success && res.audioDataUrl && audioRef.current) {
        audioRef.current.src = res.audioDataUrl;
        await audioRef.current.play().catch(() => {});
        setMsg("Playing this voice.");
      } else setErr(res?.error || "Couldn't audition this voice.");
    } finally { setBusy(null); }
  };

  return (
    <div className="studioCard advPanelWide" style={{ borderTop: `3px solid ${accent}` }}>
      <div className="advPanelHead">Edit character</div>

      <div className="hostFormGrid">
        <label className="hostField">
          <span className="fieldLabel">Name</span>
          <input className="advSelect" value={form.name} placeholder={'e.g. Marcus "Money" Ellison'} onChange={(e) => set("name", e.target.value)} />
        </label>
        <label className="hostField">
          <span className="fieldLabel">Role</span>
          <input className="advSelect" value={form.role} placeholder="e.g. Loud, legacy-driven debate host" onChange={(e) => set("role", e.target.value)} />
        </label>
        <label className="hostField hostFieldWide">
          <span className="fieldLabel">Worldview</span>
          <textarea className="advSelect" rows={3} value={form.worldview} onChange={(e) => set("worldview", e.target.value)} />
        </label>
        <label className="hostField hostFieldWide">
          <span className="fieldLabel">Speaking style / verbal tics</span>
          <textarea className="advSelect" rows={3} value={form.speakingStyle} onChange={(e) => set("speakingStyle", e.target.value)} />
        </label>
        <label className="hostField">
          <span className="fieldLabel">Catchphrases (one per line)</span>
          <textarea className="advSelect" rows={4} value={form.catchphrasesRaw} onChange={(e) => set("catchphrasesRaw", e.target.value)} />
        </label>
        <label className="hostField">
          <span className="fieldLabel">Boundaries — never say (one per line)</span>
          <textarea className="advSelect" rows={4} value={form.boundariesRaw} onChange={(e) => set("boundariesRaw", e.target.value)} />
        </label>
        <label className="hostField">
          <span className="fieldLabel">Intensity (1–10)</span>
          <input type="number" min={1} max={10} className="advSelect" value={form.intensityLevel} onChange={(e) => set("intensityLevel", Number(e.target.value))} />
        </label>
      </div>

      {/* Voice assignment */}
      <div className="advPanelHead" style={{ marginTop: "1.2rem" }}>Voice</div>
      <div className="hostFormGrid">
        <label className="hostField">
          <span className="fieldLabel">TTS engine <span className="advParam">ttsProvider</span></span>
          <select className="advSelect" value={form.ttsProvider} onChange={(e) => set("ttsProvider", e.target.value)}>
            {STUDIO_TTS_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="hostField">
          <span className="fieldLabel">Voice id <span className="advParam">ttsVoiceId</span></span>
          <input className="advSelect" value={form.ttsVoiceId} placeholder={voiceHint(form.ttsProvider)} onChange={(e) => set("ttsVoiceId", e.target.value)} />
        </label>
      </div>

      {/* Voice provenance — the legal safeguard. */}
      <div className="advPanelHead" style={{ marginTop: "1.2rem" }}>
        Voice provenance {!form.voiceSource && <span className="provBadge provRisk" style={{ marginLeft: "0.5rem" }}>⚠ undocumented</span>}
      </div>
      <div className="hostFormGrid">
        <label className="hostField">
          <span className="fieldLabel">Source <span className="advParam">voiceSource</span></span>
          <select className="advSelect" value={form.voiceSource} onChange={(e) => set("voiceSource", e.target.value)}>
            <option value="">— not documented —</option>
            {VOICE_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="hostField hostFieldWide">
          <span className="fieldLabel">Provenance note (license id / consent record / source) <span className="advParam">voiceProvenanceNote</span></span>
          <textarea className="advSelect" rows={2} value={form.voiceProvenanceNote} placeholder="e.g. ElevenLabs Pro license #… / signed voice-consent on file" onChange={(e) => set("voiceProvenanceNote", e.target.value)} />
        </label>
      </div>

      {(msg || err) && <div className={`gateResult ${err ? "gate-err" : "gate-ok"}`} style={{ margin: "0.9rem 0" }}>{err || msg}</div>}

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "1rem" }}>
        <button type="button" className="btnPrimary" onClick={save} disabled={busy === "save"}>{busy === "save" ? "Saving…" : "Save character"}</button>
        <button type="button" className="btnGhost" onClick={test} disabled={busy === "test"}>{busy === "test" ? "Synthesizing…" : "▶ Test this voice"}</button>
        <button type="button" className="btnGhost" onClick={onClose} style={{ marginLeft: "auto" }}>Cancel</button>
      </div>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} preload="none" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Archived host card — restore, or delete only when unreferenced.     */
/* ------------------------------------------------------------------ */
function ArchivedCard({ host }: { host: StudioHostVM }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const referenced = host.episodeCount > 0 || host.segmentCount > 0;

  const restore = async () => {
    setBusy(true); setErr(null);
    const res: any = await unarchiveHost(host.id);
    if (res?.success === false) setErr(res.error);
    setBusy(false);
  };
  const del = async () => {
    setBusy(true); setErr(null);
    const res: any = await deleteHostSafely(host.id);
    if (res?.success === false) setErr(res.error);
    setBusy(false);
  };

  return (
    <div className="studioCard" style={{ opacity: 0.85, borderTop: "3px solid var(--border-hover)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem" }}>
        <div>
          <div className="displayTitle" style={{ fontSize: "1.3rem" }}>{host.name}</div>
          <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{host.role}</div>
        </div>
        <span className="chip">Archived</span>
      </div>
      <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", margin: "0.6rem 0" }}>
        In {host.episodeCount} episode{host.episodeCount === 1 ? "" : "s"}{host.segmentCount > 0 ? ` · ${host.segmentCount} audio segments` : ""} — preserved.
      </div>
      {err && <div className="gateResult gate-err" style={{ marginBottom: "0.6rem" }}>{err}</div>}
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button type="button" className="btnGhost" onClick={restore} disabled={busy}>Restore</button>
        {referenced ? (
          <span className="advNote" style={{ margin: 0, alignSelf: "center" }}>Can&apos;t delete — referenced by episodes (protected).</span>
        ) : (
          <button type="button" className="btnGhost" onClick={del} disabled={busy} style={{ color: "var(--error-text)" }}>Delete permanently</button>
        )}
      </div>
    </div>
  );
}
