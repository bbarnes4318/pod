"use client";

import React, { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ROLE_PRESETS,
  defaultHostStudioSettings,
  type HostStudioSettings,
} from "@/lib/hosts/hostStudioProfile";
import {
  archiveHost,
  assignExistingFishVoice,
  auditionHostVoice,
  cloneHostToRoster,
  cloneHostVoice,
  createStudioHost,
  deleteHostSafely,
  designHostVoice,
  saveDesignedHostVoice,
  saveStudioHost,
  unarchiveHost,
} from "./actions";
import {
  PLACEHOLDER_USER_VOICE,
  type PreviewScenario,
  type StudioHostInput,
  type VoiceSetupMode,
} from "./constants";

export interface StudioHostVM {
  id: string;
  name: string;
  role: string;
  worldview: string;
  speakingStyle: string;
  catchphrases: string[];
  boundaries: string[];
  argumentPatterns: string[];
  settings: HostStudioSettings;
  ttsProvider: string;
  ttsVoiceId: string;
  voiceSource: string;
  voiceProvenanceNote: string;
  isActive: boolean;
  isArchived: boolean;
  episodeCount: number;
  segmentCount: number;
  isShared: boolean;
  ownedByMe: boolean;
  canEdit: boolean;
}

type DesignedCandidate = {
  id: string;
  index: number;
  audioBase64: string;
  audioDataUrl: string;
  sampleRate: number;
  durationMs: number;
};

const previewLines: Record<PreviewScenario, string> = {
  hello: "Alright, let's get into it. I know exactly which part of this story does not add up.",
  disagree: "No—hold on. That sounds clean because you skipped the person who paid for the decision.",
  pressure: "That's the excuse. Now tell me who chose it, and who had to live with it.",
};

const labels = {
  energy: { calm: "Calm", conversational: "Conversational", big: "Big energy" },
  pace: { easy: "Easy", natural: "Natural", fast: "Fast" },
  humor: { serious: "Serious", dry: "Dry humor", playful: "Playful" },
  interruptions: { waits: "Waits", sometimes: "Sometimes", jumps_in: "Jumps in" },
  concessions: { gracious: "Gracious", thoughtful: "Thoughtful", stubborn: "Stubborn" },
  finish: { none: "No punch line", sharp: "Sharp", theatrical: "Big finish" },
  pressure: { louder_faster: "Louder + faster", quieter_sharper: "Quieter + sharper", louder_slower: "Louder + slower" },
  pauses: { tight: "Tight", natural: "Natural", spacious: "Spacious" },
  fishCreativity: { steady: "Steady", natural: "Natural", expressive: "Expressive" },
} as const;

function linesToText(lines: string[]): string {
  return lines.join("\n");
}

function textToLines(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

function voiceReady(voiceId: string): boolean {
  return /^[0-9a-f]{32}$/i.test(voiceId);
}

export default function CharacterStudio({ hosts }: { hosts: StudioHostVM[] }) {
  const active = useMemo(() => hosts.filter((host) => !host.isArchived), [hosts]);
  const archived = useMemo(() => hosts.filter((host) => host.isArchived), [hosts]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  return (
    <div className="fadeUp">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h1 className="pageTitle">Host Studio</h1>
          <p className="pageSub" style={{ marginBottom: 0, maxWidth: 760 }}>
            Build who your hosts are, how they behave, and how they sound. No prompt writing or voice-engine knowledge required.
          </p>
        </div>
        <button type="button" className="btnPrimary" onClick={() => setCreating((value) => !value)}>
          {creating ? "Close" : "+ Create a host"}
        </button>
      </div>

      <div className="advNote" style={{ marginTop: "0.9rem", maxWidth: 820 }}>
        <strong>Personality</strong> controls what the host believes and says. <strong>Voice</strong> controls what the host physically sounds like. Host Studio keeps those separate so changing a voice never erases the character.
      </div>

      {creating && (
        <div style={{ marginTop: "1.2rem" }}>
          <HostEditor mode="create" host={null} accent="var(--host-a)" onClose={() => setCreating(false)} />
        </div>
      )}

      <div className="grid2" style={{ marginTop: "1.5rem" }}>
        {active.map((host, index) => (
          <HostCard
            key={host.id}
            host={host}
            accent={index % 2 === 0 ? "var(--host-a)" : "var(--host-b)"}
            editing={editingId === host.id}
            onEdit={() => setEditingId(host.id)}
            onCloseEdit={() => setEditingId(null)}
          />
        ))}
      </div>

      {active.length === 0 && <div className="emptyNote" style={{ marginTop: "1.5rem" }}>No hosts yet. Create one above or copy a starter host.</div>}

      {archived.length > 0 && (
        <div style={{ marginTop: "2rem" }}>
          <button type="button" className="advLink" onClick={() => setShowArchived((value) => !value)}>
            {showArchived ? "Hide" : "Show"} archived hosts ({archived.length})
          </button>
          {showArchived && <div className="grid2" style={{ marginTop: "1rem" }}>{archived.map((host) => <ArchivedCard key={host.id} host={host} />)}</div>}
        </div>
      )}
    </div>
  );
}

function HostCard({ host, accent, editing, onEdit, onCloseEdit }: {
  host: StudioHostVM;
  accent: string;
  editing: boolean;
  onEdit: () => void;
  onCloseEdit: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "play" | "archive" | "clone">(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  if (editing && host.canEdit) return <HostEditor mode="edit" host={host} accent={accent} onClose={onCloseEdit} />;

  const play = async () => {
    setBusy("play"); setError(null); setMessage(null);
    const result = await auditionHostVoice({
      provider: host.ttsProvider,
      voiceId: host.ttsVoiceId,
      name: host.name,
      settings: host.settings,
      scenario: "hello",
    });
    if (result.success && result.audioDataUrl && audioRef.current) {
      audioRef.current.src = result.audioDataUrl;
      await audioRef.current.play().catch(() => undefined);
      setMessage("Playing this host in normal conversation.");
    } else setError("error" in result ? result.error : "Couldn't play this voice.");
    setBusy(null);
  };

  const doArchive = async () => {
    setBusy("archive"); setError(null);
    const result = await archiveHost(host.id);
    if (!result.success) setError(result.error);
    else router.refresh();
    setBusy(null);
  };

  const doClone = async () => {
    setBusy("clone"); setError(null);
    const result = await cloneHostToRoster(host.id);
    if (!result.success) setError(result.error);
    else { setMessage("Copied to your roster. Your editable version is ready."); router.refresh(); }
    setBusy(null);
  };

  return (
    <div className="studioCard" style={{ borderTop: `3px solid ${accent}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
        <div>
          <div className="displayTitle" style={{ fontSize: "1.55rem", color: accent }}>{host.name}</div>
          <div style={{ fontSize: "0.84rem", color: "var(--text-secondary)", marginTop: 4 }}>{host.role}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
          <span className={`chip ${host.isActive ? "chipSuccess" : ""}`}>{host.isActive ? "On air" : "Benched"}</span>
          {host.isShared && <span className="chip">Starter</span>}
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "0.9rem 0" }}>
        <span className="chip">{labels.energy[host.settings.energy]}</span>
        <span className="chip">{labels.pace[host.settings.pace]}</span>
        <span className="chip">{labels.humor[host.settings.humor]}</span>
        <span className="chip">{labels.pressure[host.settings.pressure]}</span>
      </div>

      <p style={{ fontSize: "0.86rem", lineHeight: 1.55, color: "var(--text-primary)" }}>{host.settings.belief}</p>

      <div className={`provRow ${voiceReady(host.ttsVoiceId) ? "" : "gate-err"}`}>
        <span className={`provBadge ${voiceReady(host.ttsVoiceId) ? "provOk" : "provRisk"}`}>
          {voiceReady(host.ttsVoiceId) ? "✓ Voice ready" : "Voice needed"}
        </span>
        {host.voiceSource && <span className="provVoice">{host.voiceSource === "synthetic-stock" ? "Designed voice" : host.voiceSource === "owned" ? "Owned voice" : "Licensed voice"}</span>}
      </div>

      {(message || error) && <div className={`gateResult ${error ? "gate-err" : "gate-ok"}`} style={{ margin: "0.8rem 0" }}>{error || message}</div>}

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.9rem" }}>
        <button type="button" className="btnPrimary" onClick={play} disabled={busy === "play" || !voiceReady(host.ttsVoiceId)}>
          {busy === "play" ? "Making preview…" : "▶ Hear host"}
        </button>
        {host.canEdit ? (
          <>
            <button type="button" className="btnGhost" onClick={onEdit}>Edit host</button>
            <button type="button" className="btnGhost" onClick={doArchive} disabled={busy === "archive"} style={{ marginLeft: "auto" }}>Archive</button>
          </>
        ) : (
          <button type="button" className="btnGhost" onClick={doClone} disabled={busy === "clone"} style={{ marginLeft: "auto" }}>
            {busy === "clone" ? "Copying…" : "Copy and customize"}
          </button>
        )}
      </div>
      <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: "0.6rem" }}>Used in {host.episodeCount} episode{host.episodeCount === 1 ? "" : "s"}.</div>
      <audio ref={audioRef} preload="none" />
    </div>
  );
}

function ChoiceRow<T extends string>({ title, help, value, options, onChange }: {
  title: string;
  help?: string;
  value: T;
  options: Array<{ value: T; label: string; help?: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div style={{ padding: "0.9rem 0", borderBottom: "1px solid var(--border-color)" }}>
      <div style={{ fontWeight: 700, marginBottom: 3 }}>{title}</div>
      {help && <div style={{ color: "var(--text-muted)", fontSize: "0.76rem", marginBottom: 8 }}>{help}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? "btnPrimary" : "btnGhost"}
            onClick={() => onChange(option.value)}
            title={option.help}
            style={{ minWidth: 110 }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function HostEditor({ mode, host, accent, onClose }: {
  mode: "edit" | "create";
  host: StudioHostVM | null;
  accent: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(host?.name || "");
  const [settings, setSettings] = useState<HostStudioSettings>(host?.settings || defaultHostStudioSettings());
  const [voiceMode, setVoiceMode] = useState<VoiceSetupMode>(host && voiceReady(host.ttsVoiceId) ? "existing" : "design");
  const [existingVoiceId, setExistingVoiceId] = useState(host?.ttsVoiceId && voiceReady(host.ttsVoiceId) ? host.ttsVoiceId : "");
  const [existingSource, setExistingSource] = useState(host?.voiceSource || "licensed");
  const [existingNote, setExistingNote] = useState(host?.voiceProvenanceNote || "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [voiceGender, setVoiceGender] = useState("Man");
  const [voiceAge, setVoiceAge] = useState("Middle-aged");
  const [voiceSound, setVoiceSound] = useState("Warm and natural");
  const [voiceDelivery, setVoiceDelivery] = useState("Conversational");
  const [voiceAccent, setVoiceAccent] = useState("General American");
  const [voiceExtra, setVoiceExtra] = useState("");
  const [designText, setDesignText] = useState("Alright, let's get into it. This story has one detail nobody wants to say out loud.");
  const [candidates, setCandidates] = useState<DesignedCandidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<number | null>(null);

  const [cloneFiles, setCloneFiles] = useState<File[]>([]);
  const [cloneTranscript, setCloneTranscript] = useState("");
  const [cloneConsent, setCloneConsent] = useState(false);
  const [cloneSource, setCloneSource] = useState<"owned" | "licensed">("owned");

  const [scenario, setScenario] = useState<PreviewScenario>("hello");
  const [previewText, setPreviewText] = useState(previewLines.hello);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const setSetting = <K extends keyof HostStudioSettings>(key: K, value: HostStudioSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));

  const designInstruction = `${voiceAge} ${voiceGender.toLowerCase()} voice. ${voiceSound}. ${voiceDelivery} delivery. ${voiceAccent} accent. ${voiceExtra}`.trim();
  const selected = selectedCandidate === null ? null : candidates[selectedCandidate] || null;

  const hostInput = (voiceId?: string): StudioHostInput => ({
    name,
    settings,
    ttsProvider: "fish",
    ttsVoiceId: voiceId || (host?.ttsVoiceId && voiceReady(host.ttsVoiceId) ? host.ttsVoiceId : PLACEHOLDER_USER_VOICE),
    voiceSource: host?.voiceSource || "",
    voiceProvenanceNote: host?.voiceProvenanceNote || "",
  });

  const persistPersonality = async (): Promise<string | null> => {
    const result = mode === "create"
      ? await createStudioHost(hostInput(voiceMode === "existing" ? existingVoiceId : undefined))
      : await saveStudioHost(host!.id, hostInput(voiceMode === "existing" ? existingVoiceId : undefined));
    if (!result.success) { setError(result.error); return null; }
    return result.hostId;
  };

  const save = async () => {
    setBusy("save"); setError(null); setMessage(null);
    try {
      const hostId = await persistPersonality();
      if (!hostId) return;

      if (voiceMode === "design") {
        if (!selected) throw new Error("Choose one of the designed voices, or select Save voice later.");
        const result = await saveDesignedHostVoice(hostId, {
          title: `${name || "Host"} designed voice`,
          audioBase64: selected.audioBase64,
          previewText: designText,
          instruction: designInstruction,
        });
        if (!result.success) throw new Error(result.error);
      } else if (voiceMode === "clone") {
        if (cloneFiles.length === 0) throw new Error("Add at least one voice recording.");
        if (!cloneConsent) throw new Error("Confirm that you own the voice or have written permission.");
        const formData = new FormData();
        cloneFiles.forEach((file) => formData.append("voiceSamples", file));
        formData.append("transcript", cloneTranscript);
        formData.append("consent", "true");
        formData.append("voiceSource", cloneSource);
        formData.append("title", `${name || "Host"} voice`);
        const result = await cloneHostVoice(hostId, formData);
        if (!result.success) throw new Error(result.error);
      } else if (voiceMode === "existing") {
        const result = await assignExistingFishVoice(hostId, { voiceId: existingVoiceId, source: existingSource, note: existingNote });
        if (!result.success) throw new Error(result.error);
      }

      setMessage("Host saved.");
      router.refresh();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this host.");
    } finally {
      setBusy(null);
    }
  };

  const generateDesign = async () => {
    setBusy("design"); setError(null); setMessage(null); setCandidates([]); setSelectedCandidate(null);
    const speed = settings.pace === "fast" ? 1.1 : settings.pace === "easy" ? 0.92 : 1;
    const result = await designHostVoice({ instruction: designInstruction, previewText: designText, speed });
    if (result.success) {
      setCandidates(result.candidates as DesignedCandidate[]);
      setMessage("Three real voice choices are ready. Play them and choose one.");
    } else setError(result.error);
    setBusy(null);
  };

  const playPreview = async () => {
    setBusy("preview"); setError(null); setMessage(null);
    const voiceId = voiceMode === "existing" ? existingVoiceId : host?.ttsVoiceId || "";
    const result = await auditionHostVoice({ provider: "fish", voiceId, name, settings, scenario, line: previewText });
    if (result.success && previewAudioRef.current) {
      previewAudioRef.current.src = result.audioDataUrl;
      await previewAudioRef.current.play().catch(() => undefined);
      setMessage("Playing this host with the selected behavior.");
    } else setError("error" in result ? result.error : "Could not make the preview.");
    setBusy(null);
  };

  const steps = ["Who they are", "How they act", "Voice", "Preview"];

  return (
    <div className="studioCard advPanelWide" style={{ borderTop: `3px solid ${accent}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div className="advPanelHead">{mode === "create" ? "Create a host" : `Edit ${host?.name}`}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {steps.map((title, index) => (
            <button key={title} type="button" className={step === index ? "btnPrimary" : "btnGhost"} onClick={() => setStep(index)}>
              {index + 1}. {title}
            </button>
          ))}
        </div>
      </div>

      {step === 0 && (
        <div style={{ marginTop: "1rem" }}>
          <label className="hostField">
            <span className="fieldLabel">Host name</span>
            <input className="advSelect" value={name} placeholder={'e.g. Marcus "Money" Ellison'} onChange={(event) => setName(event.target.value)} />
          </label>
          <div style={{ marginTop: "1rem" }}>
            <div className="fieldLabel">What kind of host are they?</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginTop: 8 }}>
              {(Object.entries(ROLE_PRESETS) as Array<[HostStudioSettings["rolePreset"], (typeof ROLE_PRESETS)[HostStudioSettings["rolePreset"]]]>).map(([key, preset]) => (
                <button key={key} type="button" className={settings.rolePreset === key ? "btnPrimary" : "btnGhost"} onClick={() => setSetting("rolePreset", key)} style={{ minHeight: 54 }}>
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          {settings.rolePreset === "custom" && (
            <label className="hostField" style={{ marginTop: "1rem" }}>
              <span className="fieldLabel">Describe their job on the show</span>
              <input className="advSelect" value={settings.customRole} onChange={(event) => setSetting("customRole", event.target.value)} placeholder="A blunt former coach who hates excuses" />
            </label>
          )}
          <label className="hostField" style={{ marginTop: "1rem" }}>
            <span className="fieldLabel">What do they believe?</span>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Write it like you are explaining the person to a friend.</span>
            <textarea className="advSelect" rows={4} value={settings.belief} onChange={(event) => setSetting("belief", event.target.value)} placeholder="They believe owners always blame the cheapest person first..." />
          </label>
        </div>
      )}

      {step === 1 && (
        <div style={{ marginTop: "0.5rem" }}>
          <ChoiceRow title="Energy" value={settings.energy} onChange={(value) => setSetting("energy", value)} options={[
            { value: "calm", label: "Calm" }, { value: "conversational", label: "Conversational" }, { value: "big", label: "Big energy" },
          ]} />
          <ChoiceRow title="Speaking speed" value={settings.pace} onChange={(value) => setSetting("pace", value)} options={[
            { value: "easy", label: "Easy" }, { value: "natural", label: "Natural" }, { value: "fast", label: "Fast" },
          ]} />
          <ChoiceRow title="Humor" value={settings.humor} onChange={(value) => setSetting("humor", value)} options={[
            { value: "serious", label: "Serious" }, { value: "dry", label: "Dry" }, { value: "playful", label: "Playful" },
          ]} />
          <ChoiceRow title="Do they interrupt?" value={settings.interruptions} onChange={(value) => setSetting("interruptions", value)} options={[
            { value: "waits", label: "Waits" }, { value: "sometimes", label: "Sometimes" }, { value: "jumps_in", label: "Jumps in" },
          ]} />
          <ChoiceRow title="How do they admit the other host is right?" value={settings.concessions} onChange={(value) => setSetting("concessions", value)} options={[
            { value: "gracious", label: "Gracious" }, { value: "thoughtful", label: "Thinks it through" }, { value: "stubborn", label: "Grudging" },
          ]} />
          <ChoiceRow title="How do they finish an argument?" value={settings.finish} onChange={(value) => setSetting("finish", value)} options={[
            { value: "none", label: "No punch line" }, { value: "sharp", label: "Short + sharp" }, { value: "theatrical", label: "Big finish" },
          ]} />
          <ChoiceRow title="What happens under pressure?" value={settings.pressure} onChange={(value) => setSetting("pressure", value)} options={[
            { value: "louder_faster", label: "Louder + faster" }, { value: "quieter_sharper", label: "Quieter + sharper" }, { value: "louder_slower", label: "Louder + slower" },
          ]} />
          <ChoiceRow title="Pauses" value={settings.pauses} onChange={(value) => setSetting("pauses", value)} options={[
            { value: "tight", label: "Tight" }, { value: "natural", label: "Natural" }, { value: "spacious", label: "Spacious" },
          ]} />
          <ChoiceRow title="Voice variation" help="More expressive creates more variation between takes. It does not change the character's beliefs." value={settings.fishCreativity} onChange={(value) => setSetting("fishCreativity", value)} options={[
            { value: "steady", label: "Steady" }, { value: "natural", label: "Natural" }, { value: "expressive", label: "Expressive" },
          ]} />

          <div className="hostFormGrid" style={{ marginTop: "1rem" }}>
            <label className="hostField">
              <span className="fieldLabel">They often… (one habit per line)</span>
              <textarea className="advSelect" rows={5} value={linesToText(settings.argumentPatterns)} onChange={(event) => setSetting("argumentPatterns", textToLines(event.target.value))} placeholder={'Challenges the other host\nUses one concrete example\nAsks who benefited'} />
            </label>
            <label className="hostField">
              <span className="fieldLabel">Never say… (one phrase per line)</span>
              <textarea className="advSelect" rows={5} value={linesToText(settings.bannedPhrases)} onChange={(event) => setSetting("bannedPhrases", textToLines(event.target.value))} placeholder={'At the end of the day\nThe reality is'} />
            </label>
            <label className="hostField">
              <span className="fieldLabel">Never sound like… (one per line)</span>
              <textarea className="advSelect" rows={4} value={linesToText(settings.prohibitedTraits)} onChange={(event) => setSetting("prohibitedTraits", textToLines(event.target.value))} placeholder={'a robot\nan announcer\nan audiobook narrator'} />
            </label>
            <label className="hostField">
              <span className="fieldLabel">Optional favorite phrases</span>
              <textarea className="advSelect" rows={4} value={linesToText(settings.catchphrases)} onChange={(event) => setSetting("catchphrases", textToLines(event.target.value))} placeholder="Use sparingly. Leave blank for most hosts." />
            </label>
          </div>

          <details style={{ marginTop: "1rem" }}>
            <summary className="advLink">Advanced instructions</summary>
            <label className="hostField" style={{ marginTop: 8 }}>
              <span className="fieldLabel">Extra behavior notes</span>
              <textarea className="advSelect" rows={4} value={settings.extraInstructions} onChange={(event) => setSetting("extraInstructions", event.target.value)} />
            </label>
            <label className="hostField" style={{ marginTop: 8, maxWidth: 240 }}>
              <span className="fieldLabel">Casting priority (1–10)</span>
              <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>Higher priority takes the lead chair. This is not volume.</span>
              <input className="advSelect" type="number" min={1} max={10} value={settings.castPriority} onChange={(event) => setSetting("castPriority", Number(event.target.value))} />
            </label>
          </details>
        </div>
      )}

      {step === 2 && (
        <div style={{ marginTop: "1rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
            {([
              ["design", "Design a new voice", "Describe it, hear three choices, and pick one."],
              ["clone", "Clone my voice", "Upload your voice or a voice you have permission to use."],
              ["existing", "Use an existing voice", "Attach a Fish voice you already own or license."],
              ["later", "Choose later", "Save the character now. Audio stays blocked until a voice is added."],
            ] as Array<[VoiceSetupMode, string, string]>).map(([value, title, help]) => (
              <button key={value} type="button" className={voiceMode === value ? "btnPrimary" : "btnGhost"} onClick={() => setVoiceMode(value)} style={{ minHeight: 90, textAlign: "left" }}>
                <strong style={{ display: "block" }}>{title}</strong>
                <span style={{ display: "block", fontSize: "0.74rem", marginTop: 5, opacity: 0.85 }}>{help}</span>
              </button>
            ))}
          </div>

          {voiceMode === "design" && (
            <div style={{ marginTop: "1.2rem" }}>
              <ChoiceRow title="Voice" value={voiceGender} onChange={setVoiceGender} options={[
                { value: "Woman", label: "Woman" }, { value: "Man", label: "Man" }, { value: "Neutral", label: "Neutral" },
              ]} />
              <ChoiceRow title="Age" value={voiceAge} onChange={setVoiceAge} options={[
                { value: "Young adult", label: "Young adult" }, { value: "Middle-aged", label: "Middle-aged" }, { value: "Older", label: "Older" },
              ]} />
              <ChoiceRow title="Sound" value={voiceSound} onChange={setVoiceSound} options={[
                { value: "Low and deep", label: "Low + deep" }, { value: "Warm and natural", label: "Warm" }, { value: "Bright and clear", label: "Bright" }, { value: "Raspy and weathered", label: "Raspy" },
              ]} />
              <ChoiceRow title="Delivery" value={voiceDelivery} onChange={setVoiceDelivery} options={[
                { value: "Calm", label: "Calm" }, { value: "Conversational", label: "Conversational" }, { value: "High energy", label: "High energy" }, { value: "Authoritative", label: "Authoritative" },
              ]} />
              <div className="hostFormGrid" style={{ marginTop: "1rem" }}>
                <label className="hostField"><span className="fieldLabel">Accent</span><input className="advSelect" value={voiceAccent} onChange={(event) => setVoiceAccent(event.target.value)} /></label>
                <label className="hostField"><span className="fieldLabel">Anything else?</span><input className="advSelect" value={voiceExtra} onChange={(event) => setVoiceExtra(event.target.value)} placeholder="Light smoker's edge, no announcer sound..." /></label>
                <label className="hostField hostFieldWide"><span className="fieldLabel">Words used to test the voice</span><textarea className="advSelect" rows={3} maxLength={150} value={designText} onChange={(event) => setDesignText(event.target.value)} /></label>
              </div>
              <button type="button" className="btnPrimary" onClick={generateDesign} disabled={busy === "design"}>{busy === "design" ? "Creating choices…" : "Create 3 voice choices"}</button>

              {candidates.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10, marginTop: "1rem" }}>
                  {candidates.map((candidate, index) => (
                    <div key={candidate.id} className="studioCard" style={{ border: selectedCandidate === index ? `2px solid ${accent}` : undefined }}>
                      <strong>Choice {index + 1}</strong>
                      <audio controls src={candidate.audioDataUrl} style={{ width: "100%", margin: "0.7rem 0" }} />
                      <button type="button" className={selectedCandidate === index ? "btnPrimary" : "btnGhost"} onClick={() => setSelectedCandidate(index)}>
                        {selectedCandidate === index ? "✓ Selected" : "Use this voice"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {voiceMode === "clone" && (
            <div style={{ marginTop: "1.2rem" }}>
              <div className="advNote" style={{ marginBottom: "1rem" }}>
                Record in a quiet room with one person speaking. At least 10 seconds works; 30–60 seconds usually sounds more natural. Add up to three recordings.
              </div>
              <label className="hostField">
                <span className="fieldLabel">Voice recordings</span>
                <input type="file" accept="audio/*" multiple onChange={(event) => setCloneFiles(Array.from(event.target.files || []).slice(0, 3))} />
                <span style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>{cloneFiles.length ? `${cloneFiles.length} recording(s) selected` : "No recordings selected"}</span>
              </label>
              <label className="hostField" style={{ marginTop: "1rem" }}>
                <span className="fieldLabel">What was said? (optional)</span>
                <textarea className="advSelect" rows={3} value={cloneTranscript} onChange={(event) => setCloneTranscript(event.target.value)} placeholder="Paste the exact words from the recording when available." />
              </label>
              <ChoiceRow title="Whose voice is this?" value={cloneSource} onChange={setCloneSource} options={[
                { value: "owned", label: "My voice" }, { value: "licensed", label: "I have permission" },
              ]} />
              <label style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "0.9rem", border: "1px solid var(--border-color)", borderRadius: 8 }}>
                <input type="checkbox" checked={cloneConsent} onChange={(event) => setCloneConsent(event.target.checked)} />
                <span>I confirm that this is my voice or I have written permission from the speaker to clone and use it.</span>
              </label>
            </div>
          )}

          {voiceMode === "existing" && (
            <div style={{ marginTop: "1.2rem" }}>
              <div className="advNote">This is the advanced path. Most users should design or clone a voice instead.</div>
              <label className="hostField" style={{ marginTop: "1rem" }}><span className="fieldLabel">Fish voice ID</span><input className="advSelect" value={existingVoiceId} onChange={(event) => setExistingVoiceId(event.target.value)} placeholder="32-character voice ID" /></label>
              <ChoiceRow title="Permission" value={existingSource} onChange={setExistingSource} options={[
                { value: "owned", label: "I own it" }, { value: "licensed", label: "Licensed" }, { value: "synthetic-stock", label: "Designed / stock" },
              ]} />
              <label className="hostField"><span className="fieldLabel">Permission or source note</span><textarea className="advSelect" rows={2} value={existingNote} onChange={(event) => setExistingNote(event.target.value)} /></label>
            </div>
          )}

          {voiceMode === "later" && <div className="advNote" style={{ marginTop: "1rem" }}>The host can be saved, but script-to-audio production will remain blocked until a real voice is attached.</div>}
        </div>
      )}

      {step === 3 && (
        <div style={{ marginTop: "1rem" }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Hear the host in a real situation</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(["hello", "disagree", "pressure"] as PreviewScenario[]).map((value) => (
              <button key={value} type="button" className={scenario === value ? "btnPrimary" : "btnGhost"} onClick={() => { setScenario(value); setPreviewText(previewLines[value]); }}>
                {value === "hello" ? "Normal conversation" : value === "disagree" ? "Disagreeing" : "Under pressure"}
              </button>
            ))}
          </div>
          <label className="hostField" style={{ marginTop: "1rem" }}>
            <span className="fieldLabel">Preview words</span>
            <textarea className="advSelect" rows={4} value={previewText} onChange={(event) => setPreviewText(event.target.value)} />
          </label>
          {voiceMode === "design" && selected ? (
            <div className="advNote" style={{ marginTop: "1rem" }}>The selected designed voice is playable in the Voice step. Save the host to test that new voice with all three behavior situations.</div>
          ) : (
            <button type="button" className="btnPrimary" onClick={playPreview} disabled={busy === "preview" || !(voiceMode === "existing" ? voiceReady(existingVoiceId) : host && voiceReady(host.ttsVoiceId))}>
              {busy === "preview" ? "Making preview…" : "▶ Play this situation"}
            </button>
          )}
          <audio ref={previewAudioRef} preload="none" />
        </div>
      )}

      {(message || error) && <div className={`gateResult ${error ? "gate-err" : "gate-ok"}`} style={{ margin: "1rem 0" }}>{error || message}</div>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "1.2rem", paddingTop: "1rem", borderTop: "1px solid var(--border-color)" }}>
        {step > 0 && <button type="button" className="btnGhost" onClick={() => setStep((value) => value - 1)}>Back</button>}
        {step < 3 && <button type="button" className="btnPrimary" onClick={() => setStep((value) => value + 1)}>Next</button>}
        <button type="button" className="btnPrimary" onClick={save} disabled={busy === "save"} style={{ marginLeft: "auto" }}>
          {busy === "save" ? "Saving…" : mode === "create" ? "Create host" : "Save host"}
        </button>
        <button type="button" className="btnGhost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function ArchivedCard({ host }: { host: StudioHostVM }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const referenced = host.episodeCount > 0 || host.segmentCount > 0;
  const restore = async () => { setBusy(true); const result = await unarchiveHost(host.id); if (!result.success) setError(result.error); else router.refresh(); setBusy(false); };
  const remove = async () => { setBusy(true); const result = await deleteHostSafely(host.id); if (!result.success) setError(result.error); else router.refresh(); setBusy(false); };
  return (
    <div className="studioCard" style={{ opacity: 0.85, borderTop: "3px solid var(--border-hover)" }}>
      <div className="displayTitle" style={{ fontSize: "1.3rem" }}>{host.name}</div>
      <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{host.role}</div>
      <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", margin: "0.6rem 0" }}>Used in {host.episodeCount} episode{host.episodeCount === 1 ? "" : "s"}.</div>
      {error && <div className="gateResult gate-err">{error}</div>}
      {host.canEdit ? (
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btnGhost" onClick={restore} disabled={busy}>Restore</button>
          {!referenced && <button type="button" className="btnGhost" onClick={remove} disabled={busy} style={{ color: "var(--error-text)" }}>Delete</button>}
        </div>
      ) : <span className="advNote">Shared host — read only.</span>}
    </div>
  );
}
