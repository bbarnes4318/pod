"use client";

import { useCallback, useMemo, useRef, useState } from "react";
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
import {
  AppPage,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
} from "@/components/studio";
import { Drawer } from "@/components/studio/OverlayPrimitives";
import styles from "./HostStudioProduction.module.css";

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

function voiceReady(voiceId: string): boolean {
  return /^[0-9a-f]{32}$/i.test(voiceId);
}

function linesToText(lines: string[]): string {
  return lines.join("\n");
}

function textToLines(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
}

export default function HostStudioProduction({ hosts }: { hosts: StudioHostVM[] }) {
  const active = useMemo(() => hosts.filter(host => !host.isArchived), [hosts]);
  const archived = useMemo(() => hosts.filter(host => host.isArchived), [hosts]);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const editingHost = hosts.find(host => host.id === editingId) ?? null;
  const closeEditor = useCallback(() => { setCreating(false); setEditingId(null); }, []);

  return <AppPage>
    <PageHeader
      title="Host Studio"
      description="Build who each host is, how they behave under pressure, and how they sound—without exposing voice-engine jargon."
      actions={<Button variant="primary" size="prominent" onClick={() => { setEditingId(null); setCreating(true); }}>Create a host</Button>}
    />

    <div className={styles.explainer}>
      <strong>Personality</strong> controls what a host believes and says. <strong>Voice</strong> controls the physical sound. They stay separate so changing a voice never erases the character.
    </div>

    {active.length === 0 ? (
      <EmptyState title="No hosts yet" description="Create a host or copy a starter personality into your roster." action={<Button variant="primary" onClick={() => setCreating(true)}>Create your first host</Button>} />
    ) : (
      <div className={styles.grid}>
        {active.map(host => <HostCard key={host.id} host={host} onEdit={() => { setCreating(false); setEditingId(host.id); }} />)}
      </div>
    )}

    {archived.length > 0 && <section className={styles.archivedSection}>
      <button type="button" className={styles.archivedToggle} onClick={() => setShowArchived(value => !value)} aria-expanded={showArchived}>
        {showArchived ? "Hide" : "Show"} archived hosts ({archived.length})
      </button>
      {showArchived && <div className={styles.archivedGrid}>{archived.map(host => <ArchivedCard key={host.id} host={host} />)}</div>}
    </section>}

    <Drawer
      open={creating || !!editingHost}
      onClose={closeEditor}
      title={creating ? "Create a host" : `Edit ${editingHost?.name ?? "host"}`}
      description="Four focused steps keep personality, performance, voice, and preview decisions clear."
    >
      {(creating || editingHost) && <HostEditor key={creating ? "create" : editingHost!.id} mode={creating ? "create" : "edit"} host={editingHost} onClose={closeEditor} />}
    </Drawer>
  </AppPage>;
}

function HostCard({ host, onEdit }: { host: StudioHostVM; onEdit: () => void }) {
  const router = useRouter();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [busy, setBusy] = useState<null | "play" | "archive" | "clone">(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const play = async () => {
    setBusy("play"); setError(null); setMessage(null);
    const result = await auditionHostVoice({ provider: host.ttsProvider, voiceId: host.ttsVoiceId, name: host.name, settings: host.settings, scenario: "hello" });
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
    if (!result.success) setError(result.error); else router.refresh();
    setBusy(null);
  };

  const doClone = async () => {
    setBusy("clone"); setError(null);
    const result = await cloneHostToRoster(host.id);
    if (!result.success) setError(result.error);
    else { setMessage("Copied to your roster. Your editable version is ready."); router.refresh(); }
    setBusy(null);
  };

  return <Card className={styles.hostCard}>
    <div className={styles.cardHead}>
      <div className={styles.identity}><h2>{host.name}</h2><p>{host.role}</p></div>
      <div className={styles.statuses}><StatusBadge tone={host.isActive ? "success" : "neutral"}>{host.isActive ? "On air" : "Benched"}</StatusBadge>{host.isShared && <StatusBadge>Starter</StatusBadge>}</div>
    </div>
    <div className={styles.traits}>
      <span>{labels.energy[host.settings.energy]}</span><span>{labels.pace[host.settings.pace]}</span><span>{labels.humor[host.settings.humor]}</span><span>{labels.pressure[host.settings.pressure]}</span>
    </div>
    <p className={styles.belief}>{host.settings.belief}</p>
    <div className={styles.voiceRow}><StatusBadge tone={voiceReady(host.ttsVoiceId) ? "success" : "warning"}>{voiceReady(host.ttsVoiceId) ? "Voice ready" : "Voice needed"}</StatusBadge><span>{host.episodeCount} episode{host.episodeCount === 1 ? "" : "s"}</span></div>
    {(message || error) && <p className={error ? styles.error : styles.success} role={error ? "alert" : "status"}>{error || message}</p>}
    <div className={styles.cardActions}>
      <Button variant="secondary" size="compact" onClick={play} disabled={busy === "play" || !voiceReady(host.ttsVoiceId)}>{busy === "play" ? "Making preview…" : "Hear voice"}</Button>
      {host.canEdit ? <Button variant="ghost" size="compact" onClick={onEdit}>Edit</Button> : <Button variant="ghost" size="compact" onClick={doClone} disabled={busy === "clone"}>{busy === "clone" ? "Copying…" : "Copy and customize"}</Button>}
      {host.canEdit && <details className={styles.more}><summary aria-label={`More actions for ${host.name}`}>•••</summary><div className={styles.moreMenu}><button type="button" onClick={doArchive} disabled={busy === "archive"}>{busy === "archive" ? "Archiving…" : "Archive"}</button></div></details>}
    </div>
    <audio ref={audioRef} preload="none" />
  </Card>;
}

function SettingSelect<K extends keyof HostStudioSettings>({ label, name, value, options, onChange }: { label: string; name: K; value: HostStudioSettings[K]; options: Record<string, string>; onChange: (name: K, value: HostStudioSettings[K]) => void }) {
  return <Field label={label}><Select value={String(value)} onChange={event => onChange(name, event.target.value as HostStudioSettings[K])}>{Object.entries(options).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</Select></Field>;
}

function HostEditor({ mode, host, onClose }: { mode: "edit" | "create"; host: StudioHostVM | null; onClose: () => void }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(host?.name || "");
  const [settings, setSettings] = useState<HostStudioSettings>(host?.settings || defaultHostStudioSettings());
  const [voiceMode, setVoiceMode] = useState<VoiceSetupMode>(host && voiceReady(host.ttsVoiceId) ? "existing" : "design");
  const [existingVoiceId, setExistingVoiceId] = useState(host?.ttsVoiceId && voiceReady(host.ttsVoiceId) ? host.ttsVoiceId : "");
  const [existingSource, setExistingSource] = useState(host?.voiceSource || "licensed");
  const [existingNote, setExistingNote] = useState(host?.voiceProvenanceNote || "");
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
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const steps = ["Who they are", "How they act", "Voice", "Preview"];
  const selected = selectedCandidate === null ? null : candidates[selectedCandidate] || null;
  const setSetting = <K extends keyof HostStudioSettings>(key: K, value: HostStudioSettings[K]) => setSettings(current => ({ ...current, [key]: value }));
  const designInstruction = `${voiceAge} ${voiceGender.toLowerCase()} voice. ${voiceSound}. ${voiceDelivery} delivery. ${voiceAccent} accent. ${voiceExtra}`.trim();

  const hostInput = (voiceId?: string): StudioHostInput => ({
    name,
    settings,
    ttsProvider: "fish",
    ttsVoiceId: voiceId || (host?.ttsVoiceId && voiceReady(host.ttsVoiceId) ? host.ttsVoiceId : PLACEHOLDER_USER_VOICE),
    voiceSource: host?.voiceSource || "",
    voiceProvenanceNote: host?.voiceProvenanceNote || "",
  });

  const persistPersonality = async (): Promise<string | null> => {
    const result = mode === "create" ? await createStudioHost(hostInput(voiceMode === "existing" ? existingVoiceId : undefined)) : await saveStudioHost(host!.id, hostInput(voiceMode === "existing" ? existingVoiceId : undefined));
    if (!result.success) { setError(result.error); return null; }
    return result.hostId;
  };

  const save = async () => {
    if (!name.trim()) { setError("Give the host a name."); setStep(0); return; }
    setBusy("save"); setError(null); setMessage(null);
    try {
      const hostId = await persistPersonality();
      if (!hostId) return;
      if (voiceMode === "design") {
        if (!selected) throw new Error("Choose one of the designed voices, or select Choose later.");
        const result = await saveDesignedHostVoice(hostId, { title: `${name || "Host"} designed voice`, audioBase64: selected.audioBase64, previewText: designText, instruction: designInstruction });
        if (!result.success) throw new Error(result.error);
      } else if (voiceMode === "clone") {
        if (cloneFiles.length === 0) throw new Error("Add at least one voice recording.");
        if (!cloneConsent) throw new Error("Confirm that you own the voice or have written permission.");
        const formData = new FormData();
        cloneFiles.forEach(file => formData.append("voiceSamples", file));
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
    } finally { setBusy(null); }
  };

  const generateDesign = async () => {
    setBusy("design"); setError(null); setMessage(null); setCandidates([]); setSelectedCandidate(null);
    const speed = settings.pace === "fast" ? 1.1 : settings.pace === "easy" ? 0.92 : 1;
    const result = await designHostVoice({ instruction: designInstruction, previewText: designText, speed });
    if (result.success) { setCandidates(result.candidates as DesignedCandidate[]); setMessage("Three real voice choices are ready. Play them and choose one."); }
    else setError(result.error);
    setBusy(null);
  };

  const playPreview = async () => {
    setBusy("preview"); setError(null); setMessage(null);
    if (voiceMode === "design" && selected && previewAudioRef.current) {
      previewAudioRef.current.src = selected.audioDataUrl;
      await previewAudioRef.current.play().catch(() => undefined);
      setMessage("Playing the selected designed voice.");
      setBusy(null);
      return;
    }
    const voiceId = voiceMode === "existing" ? existingVoiceId : host?.ttsVoiceId || "";
    const result = await auditionHostVoice({ provider: "fish", voiceId, name, settings, scenario, line: previewText });
    if (result.success && previewAudioRef.current) { previewAudioRef.current.src = result.audioDataUrl; await previewAudioRef.current.play().catch(() => undefined); setMessage("Playing this host with the selected behavior."); }
    else setError("error" in result ? result.error : "Could not make the preview.");
    setBusy(null);
  };

  return <div className={styles.editorWorkspace}>
    <div className={styles.editorMain}>
      <nav className={styles.editorSteps} aria-label="Host creation steps">{steps.map((title, index) => <button key={title} type="button" className={step === index ? styles.currentStep : index < step ? styles.completeStep : ""} onClick={() => setStep(index)}><span>{index < step ? "✓" : index + 1}</span>{title}</button>)}</nav>

      {step === 0 && <div className={styles.fields}>
        <Field label="Host name"><Input autoFocus value={name} placeholder={'Marcus "Money" Ellison'} onChange={event => setName(event.target.value)} /></Field>
        <div><h3>What kind of host are they?</h3><div className={styles.choiceGrid}>{(Object.entries(ROLE_PRESETS) as Array<[HostStudioSettings["rolePreset"], (typeof ROLE_PRESETS)[HostStudioSettings["rolePreset"]]]>).map(([key, preset]) => <button key={key} type="button" className={settings.rolePreset === key ? styles.selectedChoice : ""} onClick={() => setSetting("rolePreset", key)}><strong>{preset.label}</strong></button>)}</div></div>
        {settings.rolePreset === "custom" && <Field label="Describe their job on the show"><Input value={settings.customRole} onChange={event => setSetting("customRole", event.target.value)} placeholder="A blunt former coach who hates excuses" /></Field>}
        <Field label="What do they believe?" help="Write it like you are explaining the person to a friend."><Textarea value={settings.belief} onChange={event => setSetting("belief", event.target.value)} placeholder="They believe owners always blame the cheapest person first…" /></Field>
      </div>}

      {step === 1 && <div className={styles.fields}>
        <div className={styles.formGrid}>
          <SettingSelect label="Energy" name="energy" value={settings.energy} options={labels.energy} onChange={setSetting} />
          <SettingSelect label="Speaking speed" name="pace" value={settings.pace} options={labels.pace} onChange={setSetting} />
          <SettingSelect label="Humor" name="humor" value={settings.humor} options={labels.humor} onChange={setSetting} />
          <SettingSelect label="Interruptions" name="interruptions" value={settings.interruptions} options={labels.interruptions} onChange={setSetting} />
          <SettingSelect label="Concessions" name="concessions" value={settings.concessions} options={labels.concessions} onChange={setSetting} />
          <SettingSelect label="Argument finish" name="finish" value={settings.finish} options={labels.finish} onChange={setSetting} />
          <SettingSelect label="Under pressure" name="pressure" value={settings.pressure} options={labels.pressure} onChange={setSetting} />
          <SettingSelect label="Pauses" name="pauses" value={settings.pauses} options={labels.pauses} onChange={setSetting} />
          <SettingSelect label="Voice variation" name="fishCreativity" value={settings.fishCreativity} options={labels.fishCreativity} onChange={setSetting} />
        </div>
        <div className={styles.formGrid}>
          <Field label="They often…" help="One argument habit per line."><Textarea value={linesToText(settings.argumentPatterns)} onChange={event => setSetting("argumentPatterns", textToLines(event.target.value))} /></Field>
          <Field label="Never say…" help="One banned phrase per line."><Textarea value={linesToText(settings.bannedPhrases)} onChange={event => setSetting("bannedPhrases", textToLines(event.target.value))} /></Field>
          <Field label="Never sound like…"><Textarea value={linesToText(settings.prohibitedTraits)} onChange={event => setSetting("prohibitedTraits", textToLines(event.target.value))} /></Field>
          <Field label="Optional favorite phrases"><Textarea value={linesToText(settings.catchphrases)} onChange={event => setSetting("catchphrases", textToLines(event.target.value))} /></Field>
        </div>
        <details><summary>Advanced instructions</summary><div className={styles.advanced}><Field label="Extra behavior notes"><Textarea value={settings.extraInstructions} onChange={event => setSetting("extraInstructions", event.target.value)} /></Field><Field label="Casting priority (1–10)" help="Higher priority takes the lead chair. This is not volume."><Input type="number" min={1} max={10} value={settings.castPriority} onChange={event => setSetting("castPriority", Number(event.target.value))} /></Field></div></details>
      </div>}

      {step === 2 && <div className={styles.fields}>
        <div className={styles.choiceGrid}>{([
          ["design", "Design a new voice", "Describe it, hear three choices, and select one."],
          ["clone", "Clone my voice", "Upload your voice or a voice you have permission to use."],
          ["existing", "Use an existing voice", "Attach a Fish voice you already own or license."],
          ["later", "Choose later", "Save the character now and attach a voice before production."],
        ] as Array<[VoiceSetupMode, string, string]>).map(([value, title, help]) => <button key={value} type="button" className={voiceMode === value ? styles.selectedChoice : ""} onClick={() => setVoiceMode(value)}><strong>{title}</strong><span>{help}</span></button>)}</div>

        {voiceMode === "design" && <div className={styles.fields}>
          <div className={styles.formGrid}><Field label="Voice"><Select value={voiceGender} onChange={event => setVoiceGender(event.target.value)}><option>Woman</option><option>Man</option><option>Neutral</option></Select></Field><Field label="Age"><Select value={voiceAge} onChange={event => setVoiceAge(event.target.value)}><option>Young adult</option><option>Middle-aged</option><option>Older</option></Select></Field><Field label="Sound"><Select value={voiceSound} onChange={event => setVoiceSound(event.target.value)}><option>Low and deep</option><option>Warm and natural</option><option>Bright and clear</option><option>Raspy and weathered</option></Select></Field><Field label="Delivery"><Select value={voiceDelivery} onChange={event => setVoiceDelivery(event.target.value)}><option>Calm</option><option>Conversational</option><option>High energy</option><option>Authoritative</option></Select></Field></div>
          <div className={styles.formGrid}><Field label="Accent"><Input value={voiceAccent} onChange={event => setVoiceAccent(event.target.value)} /></Field><Field label="Additional voice notes"><Input value={voiceExtra} onChange={event => setVoiceExtra(event.target.value)} placeholder="Light smoker's edge, no announcer sound…" /></Field></div>
          <Field label="Words used to test the voice"><Textarea maxLength={150} value={designText} onChange={event => setDesignText(event.target.value)} /></Field>
          <Button variant="primary" onClick={generateDesign} disabled={busy === "design"}>{busy === "design" ? "Creating choices…" : "Create 3 voice choices"}</Button>
          {candidates.length > 0 && <div className={styles.candidateGrid}>{candidates.map((candidate, index) => <Card key={candidate.id} className={selectedCandidate === index ? styles.selectedCandidate : ""}><strong>Choice {index + 1}</strong><audio controls src={candidate.audioDataUrl} /><Button variant={selectedCandidate === index ? "primary" : "secondary"} size="compact" onClick={() => setSelectedCandidate(index)}>{selectedCandidate === index ? "Selected" : "Use this voice"}</Button></Card>)}</div>}
        </div>}

        {voiceMode === "clone" && <div className={styles.fields}><p className={styles.note}>Record one person in a quiet room. Ten seconds works; 30–60 seconds usually sounds more natural. Add up to three recordings.</p><Field label="Voice recordings"><Input type="file" accept="audio/*" multiple onChange={event => setCloneFiles(Array.from(event.target.files || []).slice(0, 3))} /></Field><Field label="What was said?" help="Optional, but an exact transcript improves the model."><Textarea value={cloneTranscript} onChange={event => setCloneTranscript(event.target.value)} /></Field><Field label="Whose voice is this?"><Select value={cloneSource} onChange={event => setCloneSource(event.target.value as "owned" | "licensed")}><option value="owned">My voice</option><option value="licensed">I have permission</option></Select></Field><label className={styles.consent}><input type="checkbox" checked={cloneConsent} onChange={event => setCloneConsent(event.target.checked)} /><span>I confirm that this is my voice or I have written permission from the speaker to clone and use it.</span></label></div>}

        {voiceMode === "existing" && <div className={styles.fields}><p className={styles.note}>This advanced path attaches a Fish voice you already control.</p><Field label="Fish voice ID"><Input value={existingVoiceId} onChange={event => setExistingVoiceId(event.target.value)} placeholder="32-character voice ID" /></Field><Field label="Permission"><Select value={existingSource} onChange={event => setExistingSource(event.target.value)}><option value="owned">I own it</option><option value="licensed">Licensed</option><option value="synthetic-stock">Designed or stock</option></Select></Field><Field label="Permission or source note"><Textarea value={existingNote} onChange={event => setExistingNote(event.target.value)} /></Field></div>}
        {voiceMode === "later" && <p className={styles.note}>The host can be saved now, but audio production remains blocked until a real voice is attached.</p>}
      </div>}

      {step === 3 && <div className={styles.fields}><div className={styles.scenarios}>{(["hello", "disagree", "pressure"] as PreviewScenario[]).map(value => <button key={value} type="button" className={scenario === value ? styles.selectedScenario : ""} onClick={() => { setScenario(value); setPreviewText(previewLines[value]); }}>{value === "hello" ? "Normal conversation" : value === "disagree" ? "Disagreeing" : "Under pressure"}</button>)}</div><Field label="Preview words"><Textarea value={previewText} onChange={event => setPreviewText(event.target.value)} /></Field><Button variant="primary" onClick={playPreview} disabled={busy === "preview" || (voiceMode !== "design" && !(voiceMode === "existing" ? voiceReady(existingVoiceId) : host && voiceReady(host.ttsVoiceId)))}>{busy === "preview" ? "Making preview…" : "Play this situation"}</Button><audio ref={previewAudioRef} preload="none" /></div>}

      {(message || error) && <p className={error ? styles.editorError : styles.editorSuccess} role={error ? "alert" : "status"}>{error || message}</p>}
      <footer className={styles.editorActions}><Button variant="ghost" onClick={onClose}>Cancel</Button><div>{step > 0 && <Button variant="ghost" onClick={() => setStep(value => value - 1)}>Back</Button>}{step < 3 && <Button variant="secondary" onClick={() => setStep(value => value + 1)}>Continue</Button>}<Button variant="primary" onClick={save} disabled={busy === "save"}>{busy === "save" ? "Saving…" : mode === "create" ? "Create host" : "Save host"}</Button></div></footer>
    </div>

    <aside className={styles.summary} aria-label="Host preview summary"><span>Live summary</span><h3>{name || "Untitled host"}</h3><p>{settings.belief || "Add the belief that drives this host's point of view."}</p><dl><div><dt>Role</dt><dd>{settings.rolePreset === "custom" ? settings.customRole || "Custom" : ROLE_PRESETS[settings.rolePreset].label}</dd></div><div><dt>Energy</dt><dd>{labels.energy[settings.energy]}</dd></div><div><dt>Pace</dt><dd>{labels.pace[settings.pace]}</dd></div><div><dt>Humor</dt><dd>{labels.humor[settings.humor]}</dd></div><div><dt>Pressure</dt><dd>{labels.pressure[settings.pressure]}</dd></div><div><dt>Voice</dt><dd>{voiceMode === "later" ? "Choose later" : voiceMode === "design" ? selected ? "Designed voice selected" : "Design in progress" : voiceMode === "clone" ? `${cloneFiles.length} recording${cloneFiles.length === 1 ? "" : "s"}` : voiceReady(existingVoiceId) ? "Existing voice ready" : "Existing voice needed"}</dd></div></dl></aside>
  </div>;
}

function ArchivedCard({ host }: { host: StudioHostVM }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const referenced = host.episodeCount > 0 || host.segmentCount > 0;
  const restore = async () => { setBusy(true); const result = await unarchiveHost(host.id); if (!result.success) setError(result.error); else router.refresh(); setBusy(false); };
  const remove = async () => { setBusy(true); const result = await deleteHostSafely(host.id); if (!result.success) setError(result.error); else router.refresh(); setBusy(false); };
  return <Card className={styles.archivedCard}><div><h3>{host.name}</h3><p>{host.role}</p></div><span>{host.episodeCount} episode{host.episodeCount === 1 ? "" : "s"}</span>{error && <p className={styles.error} role="alert">{error}</p>}{host.canEdit ? <div><Button variant="secondary" size="compact" onClick={restore} disabled={busy}>Restore</Button>{!referenced && <Button variant="destructive" size="compact" onClick={remove} disabled={busy}>Delete</Button>}</div> : <StatusBadge>Shared host</StatusBadge>}</Card>;
}
