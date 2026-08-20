"use client";

import React, { useMemo, useRef, useState } from "react";
import StudioPageHeader from "../StudioPageHeader";
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
      <StudioPageHeader
        title="Hosts"
        subtitle="Who your hosts are, how they behave, and how they sound."
        actions={
          <button type="button" className="btnPrimary" onClick={() => setCreating((value) => !value)}>
            {creating ? "Close" : "Create a host"}
          </button>
        }
      />

      <details className="studioNoteDisclosure">
        <summary>How personality and voice differ</summary>
        <p>
          <strong>Personality</strong> controls what the host believes and says. <strong>Voice</strong> controls what
          the host physically sounds like. Hosts keeps those separate so changing a voice never erases the character.
        </p>
      </details>

      {creating && (
        <div className="mt-6">
          <HostEditor mode="create" host={null} accent="var(--host-a)" onClose={() => setCreating(false)} />
        </div>
      )}

      <div className="grid2 mt-6">
        {active.map((host, index) => (
          <HostCard
            key={host.id}
            host={host}
            accent={index % 2 === 0 ? "var(--host-a)" : "var(--host-b)"}
            editing={editingId === host.id}
            // A shared starter cannot be edited in place, so "Edit host" forks it
            // first and hands back the COPY's id — which is the card that must
            // open, not the starter that was clicked.
            onEdit={(hostId) => setEditingId(hostId ?? host.id)}
            onCloseEdit={() => setEditingId(null)}
          />
        ))}
      </div>

      {active.length === 0 && <div className="emptyNote mt-6">No hosts yet. Create one above, or open a starter host and edit it.</div>}

      {archived.length > 0 && (
        <div className="mt-8">
          <button type="button" className="advLink" onClick={() => setShowArchived((value) => !value)}>
            {showArchived ? "Hide" : "Show"} archived hosts ({archived.length})
          </button>
          {showArchived && <div className="grid2 mt-4">{archived.map((host) => <ArchivedCard key={host.id} host={host} />)}</div>}
        </div>
      )}
    </div>
  );
}

function HostCard({ host, accent, editing, onEdit, onCloseEdit }: {
  host: StudioHostVM;
  accent: string;
  editing: boolean;
  /** Called with the id of the host to open. Omitted = this card's own host. */
  onEdit: (hostId?: string) => void;
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

  /**
   * EDIT, WHATEVER IT TAKES.
   *
   * A starter host is shared (ownerId null), so it genuinely cannot be edited in
   * place — one account's rewrite would change the character for everybody. That
   * constraint is real. What was NOT real was making the user solve it.
   *
   * The card used to offer "Copy and customize" on shared hosts and "Edit host"
   * on owned ones, so the entire roster a new account starts with — every host
   * they can actually see — showed no Edit button at all. The reasonable
   * conclusion, and the one that was reached, is that this app cannot edit a
   * host. A capability nobody can find is a capability that does not exist.
   *
   * So the button always says "Edit host" and always opens the editor. When the
   * host is shared, the fork happens on the way there: clone it, then open the
   * COPY. The user is told what happened rather than asked to arrange it.
   */
  const editHost = async () => {
    if (host.canEdit) {
      onEdit();
      return;
    }
    setBusy("clone"); setError(null);
    const result = await cloneHostToRoster(host.id);
    if (!result.success) {
      setError(result.error);
      setBusy(null);
      return;
    }
    setMessage(`Made your own copy of ${host.name} — opening it now. The starter stays as it was.`);
    // Open the copy BEFORE refreshing: the refreshed list is what renders the
    // new card, and it needs to already know that card is the one being edited.
    onEdit(result.hostId);
    router.refresh();
    setBusy(null);
  };

  return (
    <div className="studioCard hostCard" style={{ "--host-accent": accent } as React.CSSProperties}>
      <div className="hostCardHead">
        <div>
          <div className="displayTitle hostCardName">{host.name}</div>
          <div className="hostCardRole">{host.role}</div>
        </div>
        <div className="hostCardAside">
          <span className={`chip ${host.isActive ? "chipSuccess" : ""}`}>{host.isActive ? "On air" : "Benched"}</span>
          {host.isShared && <span className="chip">Starter</span>}
        </div>
      </div>

      <div className="hostChipRow">
        <span className="chip">{labels.energy[host.settings.energy]}</span>
        <span className="chip">{labels.pace[host.settings.pace]}</span>
        <span className="chip">{labels.humor[host.settings.humor]}</span>
        <span className="chip">{labels.pressure[host.settings.pressure]}</span>
      </div>

      <p className="hostBelief">{host.settings.belief}</p>

      <div className={`provRow ${voiceReady(host.ttsVoiceId) ? "" : "gate-err"}`}>
        <span className={`provBadge ${voiceReady(host.ttsVoiceId) ? "provOk" : "provRisk"}`}>
          {voiceReady(host.ttsVoiceId) ? "✓ Voice ready" : "Voice needed"}
        </span>
        {host.voiceSource && <span className="provVoice">{host.voiceSource === "synthetic-stock" ? "Designed voice" : host.voiceSource === "owned" ? "Owned voice" : "Licensed voice"}</span>}
      </div>

      {(message || error) && <div className={`gateResult mt-3 mb-3 ${error ? "gate-err" : "gate-ok"}`}>{error || message}</div>}

      <div className="hostCardActions">
        <button type="button" className="btnPrimary" onClick={play} disabled={busy === "play" || !voiceReady(host.ttsVoiceId)}>
          {busy === "play" ? "Making preview…" : "▶ Hear host"}
        </button>
        {/* Present on EVERY card, owned or shared — see editHost for why. */}
        <button type="button" className="btnGhost" onClick={editHost} disabled={busy === "clone"}>
          {busy === "clone" ? "Making your copy…" : "Edit host"}
        </button>
        {host.canEdit && (
          <button type="button" className="btnGhost u-mlAuto" onClick={doArchive} disabled={busy === "archive"}>
            Archive
          </button>
        )}
      </div>
      <div className="hostCardUsage">Used in {host.episodeCount} episode{host.episodeCount === 1 ? "" : "s"}.</div>
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
    <div className="hostChoiceRow">
      <div className="hostChoiceTitle">{title}</div>
      {help && <div className="hostChoiceHelp">{help}</div>}
      <div className="hostBtnRow">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? "btnPrimary" : "btnGhost"}
            onClick={() => onChange(option.value)}
            title={option.help}
            data-wide="true"
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
    <div className="studioCard advPanelWide hostCard" style={{ "--host-accent": accent } as React.CSSProperties}>
      <div className="hostWizardHead">
        <div className="advPanelHead">{mode === "create" ? "Create a host" : `Edit ${host?.name}`}</div>
        <div className="hostChipRow m-0">
          {steps.map((title, index) => (
            <button key={title} type="button" className={step === index ? "btnPrimary" : "btnGhost"} onClick={() => setStep(index)}>
              {index + 1}. {title}
            </button>
          ))}
        </div>
      </div>

      {step === 0 && (
        <div className="mt-4">
          <label className="hostField">
            <span className="fieldLabel">Host name</span>
            <input className="advSelect" value={name} placeholder={'e.g. Marcus "Money" Ellison'} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="mt-4">
            <div className="fieldLabel">What kind of host are they?</div>
            <div className="hostPresetGrid">
              {(Object.entries(ROLE_PRESETS) as Array<[HostStudioSettings["rolePreset"], (typeof ROLE_PRESETS)[HostStudioSettings["rolePreset"]]]>).map(([key, preset]) => (
                <button key={key} type="button" className={settings.rolePreset === key ? "btnPrimary" : "btnGhost"} onClick={() => setSetting("rolePreset", key)} data-tallish="true">
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          {settings.rolePreset === "custom" && (
            <label className="hostField mt-4">
              <span className="fieldLabel">Describe their job on the show</span>
              <input className="advSelect" value={settings.customRole} onChange={(event) => setSetting("customRole", event.target.value)} placeholder="A blunt former coach who hates excuses" />
            </label>
          )}
          <label className="hostField mt-4">
            <span className="fieldLabel">What do they believe?</span>
            <span className="hostFieldHint">Write it like you are explaining the person to a friend.</span>
            <textarea className="advSelect" rows={4} value={settings.belief} onChange={(event) => setSetting("belief", event.target.value)} placeholder="They believe owners always blame the cheapest person first..." />
          </label>
        </div>
      )}

      {step === 1 && (
        <div className="mt-2">
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

          <div className="hostFormGrid mt-4">
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

          <details className="mt-4">
            <summary className="advLink">Advanced instructions</summary>
            <label className="hostField mt-2">
              <span className="fieldLabel">Extra behavior notes</span>
              <textarea className="advSelect" rows={4} value={settings.extraInstructions} onChange={(event) => setSetting("extraInstructions", event.target.value)} />
            </label>
            <label className="hostField hostFieldNarrow mt-2">
              <span className="fieldLabel">Casting priority (1–10)</span>
              <span className="hostFieldHint">Higher priority takes the lead chair. This is not volume.</span>
              <input className="advSelect" type="number" min={1} max={10} value={settings.castPriority} onChange={(event) => setSetting("castPriority", Number(event.target.value))} />
            </label>
          </details>
        </div>
      )}

      {step === 2 && (
        <div className="mt-4">
          <div className="hostModeGrid">
            {([
              ["design", "Design a new voice", "Describe it, hear three choices, and pick one."],
              ["clone", "Clone my voice", "Upload your voice or a voice you have permission to use."],
              ["existing", "Use an existing voice", "Attach a Fish voice you already own or license."],
              ["later", "Choose later", "Save the character now. Audio stays blocked until a voice is added."],
            ] as Array<[VoiceSetupMode, string, string]>).map(([value, title, help]) => (
              <button key={value} type="button" className={voiceMode === value ? "btnPrimary" : "btnGhost"} onClick={() => setVoiceMode(value)} data-tall="true">
                <strong className="hostModeTitle">{title}</strong>
                <span className="hostModeHelp">{help}</span>
              </button>
            ))}
          </div>

          {voiceMode === "design" && (
            <div className="mt-6">
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
              <div className="hostFormGrid mt-4">
                <label className="hostField"><span className="fieldLabel">Accent</span><input className="advSelect" value={voiceAccent} onChange={(event) => setVoiceAccent(event.target.value)} /></label>
                <label className="hostField"><span className="fieldLabel">Anything else?</span><input className="advSelect" value={voiceExtra} onChange={(event) => setVoiceExtra(event.target.value)} placeholder="Light smoker's edge, no announcer sound..." /></label>
                <label className="hostField hostFieldWide"><span className="fieldLabel">Words used to test the voice</span><textarea className="advSelect" rows={3} maxLength={150} value={designText} onChange={(event) => setDesignText(event.target.value)} /></label>
              </div>
              <button type="button" className="btnPrimary" onClick={generateDesign} disabled={busy === "design"}>{busy === "design" ? "Creating choices…" : "Create 3 voice choices"}</button>

              {candidates.length > 0 && (
                <div className="hostCandidateGrid">
                  {candidates.map((candidate, index) => (
                    <div key={candidate.id} className="studioCard" data-selected={selectedCandidate === index ? "true" : undefined}>
                      <strong>Choice {index + 1}</strong>
                      <audio controls src={candidate.audioDataUrl} className="hostAudition" />
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
            <div className="mt-6">
              <div className="advNote mb-4">
                Record in a quiet room with one person speaking. At least 10 seconds works; 30–60 seconds usually sounds more natural. Add up to three recordings.
              </div>
              <label className="hostField">
                <span className="fieldLabel">Voice recordings</span>
                <input type="file" accept="audio/*" multiple onChange={(event) => setCloneFiles(Array.from(event.target.files || []).slice(0, 3))} />
                <span className="hostFieldHint">{cloneFiles.length ? `${cloneFiles.length} recording(s) selected` : "No recordings selected"}</span>
              </label>
              <label className="hostField mt-4">
                <span className="fieldLabel">What was said? (optional)</span>
                <textarea className="advSelect" rows={3} value={cloneTranscript} onChange={(event) => setCloneTranscript(event.target.value)} placeholder="Paste the exact words from the recording when available." />
              </label>
              <ChoiceRow title="Whose voice is this?" value={cloneSource} onChange={setCloneSource} options={[
                { value: "owned", label: "My voice" }, { value: "licensed", label: "I have permission" },
              ]} />
              <label className="hostConsentRow">
                <input type="checkbox" checked={cloneConsent} onChange={(event) => setCloneConsent(event.target.checked)} />
                <span>I confirm that this is my voice or I have written permission from the speaker to clone and use it.</span>
              </label>
            </div>
          )}

          {voiceMode === "existing" && (
            <div className="mt-6">
              <div className="advNote">This is the advanced path. Most users should design or clone a voice instead.</div>
              <label className="hostField mt-4"><span className="fieldLabel">Fish voice ID</span><input className="advSelect" value={existingVoiceId} onChange={(event) => setExistingVoiceId(event.target.value)} placeholder="32-character voice ID" /></label>
              <ChoiceRow title="Permission" value={existingSource} onChange={setExistingSource} options={[
                { value: "owned", label: "I own it" }, { value: "licensed", label: "Licensed" }, { value: "synthetic-stock", label: "Designed / stock" },
              ]} />
              <label className="hostField"><span className="fieldLabel">Permission or source note</span><textarea className="advSelect" rows={2} value={existingNote} onChange={(event) => setExistingNote(event.target.value)} /></label>
            </div>
          )}

          {voiceMode === "later" && <div className="advNote mt-4">The host can be saved, but script-to-audio production will remain blocked until a real voice is attached.</div>}
        </div>
      )}

      {step === 3 && (
        <div className="mt-4">
          <div className="hostChoiceTitle mb-2">Hear the host in a real situation</div>
          <div className="hostBtnRow">
            {(["hello", "disagree", "pressure"] as PreviewScenario[]).map((value) => (
              <button key={value} type="button" className={scenario === value ? "btnPrimary" : "btnGhost"} onClick={() => { setScenario(value); setPreviewText(previewLines[value]); }}>
                {value === "hello" ? "Normal conversation" : value === "disagree" ? "Disagreeing" : "Under pressure"}
              </button>
            ))}
          </div>
          <label className="hostField mt-4">
            <span className="fieldLabel">Preview words</span>
            <textarea className="advSelect" rows={4} value={previewText} onChange={(event) => setPreviewText(event.target.value)} />
          </label>
          {voiceMode === "design" && selected ? (
            <div className="advNote mt-4">The selected designed voice is playable in the Voice step. Save the host to test that new voice with all three behavior situations.</div>
          ) : (
            <button type="button" className="btnPrimary" onClick={playPreview} disabled={busy === "preview" || !(voiceMode === "existing" ? voiceReady(existingVoiceId) : host && voiceReady(host.ttsVoiceId))}>
              {busy === "preview" ? "Making preview…" : "▶ Play this situation"}
            </button>
          )}
          <audio ref={previewAudioRef} preload="none" />
        </div>
      )}

      {(message || error) && <div className={`gateResult mt-4 mb-4 ${error ? "gate-err" : "gate-ok"}`}>{error || message}</div>}

      <div className="hostWizardFoot">
        {step > 0 && <button type="button" className="btnGhost" onClick={() => setStep((value) => value - 1)}>Back</button>}
        {step < 3 && <button type="button" className="btnPrimary" onClick={() => setStep((value) => value + 1)}>Next</button>}
        <button type="button" className="btnPrimary u-mlAuto" onClick={save} disabled={busy === "save"}>
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
    <div className="studioCard hostCard hostCardArchived">
      <div className="displayTitle hostCardNameSm">{host.name}</div>
      <div className="hostCardRole">{host.role}</div>
      <div className="hostCardUsage mt-3 mb-3">Used in {host.episodeCount} episode{host.episodeCount === 1 ? "" : "s"}.</div>
      {error && <div className="gateResult gate-err">{error}</div>}
      {host.canEdit ? (
        <div className="hostBtnRow">
          <button type="button" className="btnGhost" onClick={restore} disabled={busy}>Restore</button>
          {!referenced && <button type="button" className="btnGhost" onClick={remove} disabled={busy} data-danger="true">Delete</button>}
        </div>
      ) : <span className="advNote">Shared host — read only.</span>}
    </div>
  );
}
