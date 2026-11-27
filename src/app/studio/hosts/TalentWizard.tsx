"use client";

// Create or edit a host in five steps:
//   Identity → Personality → Performance → Voice → Final review.
//
// Same fields and the same save actions as before; only the grouping changed.
// Every step stays mounted (hidden, not removed) so nothing typed, uploaded or
// designed is lost when moving between steps — including the voice takes.

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ROLE_PRESETS,
  defaultHostStudioSettings,
  type HostStudioSettings,
} from "@/lib/hosts/hostStudioProfile";
import {
  TRAIT_LABELS,
  personalityRead,
  personalityRecommendations,
  roleLabel,
  talentReadiness,
  type ReadinessIssue,
} from "@/lib/hosts/castingFit";
import { PlayButton } from "../StudioAudio";
import {
  assignExistingFishVoice,
  cloneHostVoice,
  createStudioHost,
  saveDesignedHostVoice,
  saveStudioHost,
} from "./actions";
import VoiceDesigner, { type VoiceDesignSelection } from "./VoiceDesigner";
import {
  PLACEHOLDER_USER_VOICE,
  type PreviewScenario,
  type StudioHostInput,
  type VoiceSetupMode,
} from "./constants";
import { Recommendations } from "./TalentInsights";
import {
  linesToText,
  previewLines,
  scenarioLabels,
  textToLines,
  useHostPreview,
  voiceReady,
  voiceSourceLabel,
  type StudioHostVM,
} from "./talentModel";

const STEPS = ["Identity", "Personality", "Performance", "Voice", "Final review"] as const;

function ChoiceRow<T extends string>({ title, help, value, options, onChange }: {
  title: string;
  help?: string;
  value: T | "";
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="hostChoiceRow" role="group" aria-label={title}>
      <div className="hostChoiceTitle">{title}</div>
      {help && <div className="hostChoiceHelp">{help}</div>}
      <div className="hostBtnRow">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            className={value === option.value ? "btnPrimary" : "btnGhost"}
            onClick={() => onChange(option.value)}
            data-wide="true"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ReviewRow({ label, children, onEdit }: { label: string; children: React.ReactNode; onEdit: () => void }) {
  return (
    <div className="talentFact">
      <dt>{label}</dt>
      <dd>
        {children}
        <button type="button" className="advLink talentFactEdit" onClick={onEdit}>Change</button>
      </dd>
    </div>
  );
}

function listOrNone(lines: string[]): string {
  return lines.length ? lines.join(" · ") : "None";
}

export default function TalentWizard({ mode, host, onClose }: {
  mode: "edit" | "create";
  host: StudioHostVM | null;
  /** Called with the saved host's id after a save; with nothing on cancel. */
  onClose: (savedHostId?: string) => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(host?.name || "");
  const [settings, setSettings] = useState<HostStudioSettings>(host?.settings || defaultHostStudioSettings());
  const hostHasVoice = !!host && voiceReady(host.ttsVoiceId);
  const [voiceMode, setVoiceMode] = useState<VoiceSetupMode>(hostHasVoice ? "existing" : "design");
  const [existingVoiceId, setExistingVoiceId] = useState(hostHasVoice ? host!.ttsVoiceId : "");
  // Starts on what is actually stored. An undocumented voice stays visibly
  // undocumented until someone chooses, rather than being stamped "licensed".
  const [existingSource, setExistingSource] = useState(host?.voiceSource || "");
  const [existingNote, setExistingNote] = useState(host?.voiceProvenanceNote || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [designSelection, setDesignSelection] = useState<VoiceDesignSelection | null>(null);

  const [cloneFiles, setCloneFiles] = useState<File[]>([]);
  const [cloneTranscript, setCloneTranscript] = useState("");
  const [cloneConsent, setCloneConsent] = useState(false);
  const [cloneSource, setCloneSource] = useState<"owned" | "licensed">("owned");

  const [scenario, setScenario] = useState<PreviewScenario>("hello");
  const [previewText, setPreviewText] = useState(previewLines.hello);
  const preview = useHostPreview(host?.id ?? "new");

  const setSetting = <K extends keyof HostStudioSettings>(key: K, value: HostStudioSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));

  // ---- What this save will do, and what stands in its way -----------------
  const willHaveVoice = voiceMode === "design" ? !!designSelection || hostHasVoice
    : voiceMode === "clone" ? cloneFiles.length > 0 || hostHasVoice
      : voiceMode === "existing" ? voiceReady(existingVoiceId)
        : hostHasVoice;
  const resultingSource = voiceMode === "design" && designSelection ? "synthetic-stock"
    : voiceMode === "clone" && cloneFiles.length > 0 ? cloneSource
      : voiceMode === "existing" ? existingSource
        : host?.voiceSource || "";

  const voiceIssues: ReadinessIssue[] = [];
  if (voiceMode === "design" && !designSelection) {
    voiceIssues.push({ id: "design-pick", level: "blocker", text: "Voice: no take is picked. Create takes and pick one in the Voice step, or choose \"Choose later\"." });
  }
  if (voiceMode === "clone" && cloneFiles.length === 0) {
    voiceIssues.push({ id: "clone-files", level: "blocker", text: "Voice: add at least one voice recording, or choose a different voice option." });
  }
  if (voiceMode === "clone" && !cloneConsent) {
    voiceIssues.push({ id: "clone-consent", level: "blocker", text: "Voice: confirm that you own the voice or have written permission." });
  }
  if (voiceMode === "existing" && !voiceReady(existingVoiceId)) {
    voiceIssues.push({ id: "existing-id", level: "blocker", text: "Voice: enter a valid 32-character Fish voice ID, or choose a different voice option." });
  }
  if (voiceMode === "existing" && voiceReady(existingVoiceId) && !existingSource) {
    voiceIssues.push({ id: "existing-source", level: "blocker", text: "Voice provenance is undocumented. In the Voice step, choose who owns or licenses this voice." });
  }
  const issues = [
    ...talentReadiness({ name, settings, willHaveVoice, voiceSource: resultingSource || (voiceMode === "existing" ? "pending" : "") }),
    ...voiceIssues,
  ];
  const blockers = issues.filter((issue) => issue.level === "blocker");
  const warnings = issues.filter((issue) => issue.level === "warning");
  const recommendations = personalityRecommendations(settings);

  const hostInput = (voiceId?: string): StudioHostInput => ({
    name,
    settings,
    ttsProvider: "fish",
    ttsVoiceId: voiceId || (hostHasVoice ? host!.ttsVoiceId : PLACEHOLDER_USER_VOICE),
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
    if (blockers.length > 0) { setStep(STEPS.length - 1); return; }
    setBusy(true); setError(null);
    try {
      const hostId = await persistPersonality();
      if (!hostId) return;

      if (voiceMode === "design") {
        if (!designSelection) throw new Error("Create takes and pick one, or choose \"Choose later\".");
        const result = await saveDesignedHostVoice(hostId, {
          title: `${name || "Host"} — designed voice`,
          audioBase64: designSelection.audioBase64,
          previewText: designSelection.testLine,
          instruction: designSelection.description,
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

      router.refresh();
      onClose(hostId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this host.");
    } finally {
      setBusy(false);
    }
  };

  const previewVoiceId = voiceMode === "existing" ? existingVoiceId : host?.ttsVoiceId || "";
  const playPreview = () => preview.request(
    { provider: "fish", voiceId: previewVoiceId, name, settings, scenario, line: previewText },
    `${name || "Host"} — ${scenarioLabels[scenario].toLowerCase()}`,
  );

  const last = STEPS.length - 1;
  const saveLabel = busy ? "Saving…" : mode === "create" ? "Create host" : "Save host";

  return (
    <section className="studioCard talentWizard" aria-label={mode === "create" ? "Create a host" : `Edit ${host?.name}`}>
      <div className="hostWizardHead">
        <h2 className="sectionTitle m-0">{mode === "create" ? "Create a host" : `Edit ${host?.name}`}</h2>
        <span className="provVoice">Nothing is saved until you press {mode === "create" ? "Create host" : "Save host"}.</span>
      </div>

      <ol className="talentSteps" aria-label="Steps">
        {STEPS.map((title, index) => (
          <li key={title}>
            <button type="button" className="talentStepBtn" aria-current={step === index ? "step" : undefined} onClick={() => setStep(index)}>
              <span className="talentStepNum" aria-hidden="true">{index + 1}</span>
              {title}
              {index === last && blockers.length > 0 && <span className="talentStepFlag">{blockers.length} to fix</span>}
            </button>
          </li>
        ))}
      </ol>

      {/* ---------------- 1. Identity ---------------- */}
      <div className="talentStep" hidden={step !== 0}>
        <label className="hostField">
          <span className="fieldLabel">Host name</span>
          <input className="advSelect" value={name} placeholder={'e.g. Marcus "Money" Ellison'} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="mt-4" role="group" aria-label="What kind of host are they?">
          <div className="fieldLabel">What kind of host are they?</div>
          <div className="hostPresetGrid">
            {(Object.entries(ROLE_PRESETS) as Array<[HostStudioSettings["rolePreset"], (typeof ROLE_PRESETS)[HostStudioSettings["rolePreset"]]]>).map(([key, preset]) => (
              <button key={key} type="button" aria-pressed={settings.rolePreset === key} className={settings.rolePreset === key ? "btnPrimary" : "btnGhost"} onClick={() => setSetting("rolePreset", key)} data-tallish="true">
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
        <label className="hostField hostFieldNarrow mt-4">
          <span className="fieldLabel">Casting priority (1–10)</span>
          <span className="hostFieldHint">Higher priority takes the lead chair. This is not volume.</span>
          <input className="advSelect" type="number" min={1} max={10} value={settings.castPriority} onChange={(event) => setSetting("castPriority", Number(event.target.value))} />
        </label>
      </div>

      {/* ---------------- 2. Personality ---------------- */}
      <div className="talentStep" hidden={step !== 1}>
        <p className="advNote">How they think and argue. This shapes what the script writer gives them to say.</p>
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
            <span className="fieldLabel">Optional favorite phrases</span>
            <textarea className="advSelect" rows={4} value={linesToText(settings.catchphrases)} onChange={(event) => setSetting("catchphrases", textToLines(event.target.value))} placeholder="Use sparingly. Leave blank for most hosts." />
          </label>
          <label className="hostField">
            <span className="fieldLabel">Extra behavior notes (advanced)</span>
            <textarea className="advSelect" rows={4} value={settings.extraInstructions} onChange={(event) => setSetting("extraInstructions", event.target.value)} />
          </label>
        </div>

        <div className="mt-6">
          <Recommendations recommendations={recommendations} draft />
        </div>
      </div>

      {/* ---------------- 3. Performance ---------------- */}
      <div className="talentStep" hidden={step !== 2}>
        <p className="advNote">How they deliver a line. This shapes the voice direction, not the words.</p>
        <ChoiceRow title="Energy" value={settings.energy} onChange={(value) => setSetting("energy", value)} options={[
          { value: "calm", label: "Calm" }, { value: "conversational", label: "Conversational" }, { value: "big", label: "Big energy" },
        ]} />
        <ChoiceRow title="Speaking speed" value={settings.pace} onChange={(value) => setSetting("pace", value)} options={[
          { value: "easy", label: "Easy" }, { value: "natural", label: "Natural" }, { value: "fast", label: "Fast" },
        ]} />
        <ChoiceRow title="Pauses" value={settings.pauses} onChange={(value) => setSetting("pauses", value)} options={[
          { value: "tight", label: "Tight" }, { value: "natural", label: "Natural" }, { value: "spacious", label: "Spacious" },
        ]} />
        <ChoiceRow title="What happens under pressure?" value={settings.pressure} onChange={(value) => setSetting("pressure", value)} options={[
          { value: "louder_faster", label: "Louder + faster" }, { value: "quieter_sharper", label: "Quieter + sharper" }, { value: "louder_slower", label: "Louder + slower" },
        ]} />
        <label className="hostField mt-4">
          <span className="fieldLabel">Never sound like… (one per line)</span>
          <textarea className="advSelect" rows={4} value={linesToText(settings.prohibitedTraits)} onChange={(event) => setSetting("prohibitedTraits", textToLines(event.target.value))} placeholder={'a robot\nan announcer\nan audiobook narrator'} />
        </label>

        {/* Preview: hear these performance choices on the host's current voice. */}
        <div className="talentPreviewBox mt-6" role="group" aria-label="Preview">
          <div className="hostChoiceTitle">Hear the host in a real situation</div>
          <div className="hostChoiceHelp">Each preview is one request to the voice engine, made only when you press play.</div>
          <div className="hostBtnRow">
            {(["hello", "disagree", "pressure"] as PreviewScenario[]).map((value) => (
              <button key={value} type="button" aria-pressed={scenario === value} className={scenario === value ? "btnPrimary" : "btnGhost"} onClick={() => { setScenario(value); setPreviewText(previewLines[value]); }}>
                {scenarioLabels[value]}
              </button>
            ))}
          </div>
          <label className="hostField mt-4">
            <span className="fieldLabel">Preview words</span>
            <textarea className="advSelect" rows={3} value={previewText} onChange={(event) => setPreviewText(event.target.value)} />
          </label>
          {voiceMode === "design" && designSelection ? (
            <div className="advNote mt-4">The selected designed voice is playable in the Voice step. Save the host to test that new voice with all three behavior situations.</div>
          ) : voiceReady(previewVoiceId) ? (
            <div className="hostBtnRow mt-4">
              {preview.track && <PlayButton track={preview.track} className="playBtn playBtn--sm" />}
              <button type="button" className="btnGhost" onClick={playPreview} disabled={preview.busy}>
                {preview.busy ? "Making preview…" : "▶ Play this situation"}
              </button>
            </div>
          ) : (
            <div className="advNote mt-4">This host has no saved voice yet, so there is nothing to preview with. Add one in the Voice step and save.</div>
          )}
          {preview.error && <div className="gateResult gate-err mt-3" role="status">{preview.error}</div>}
        </div>
      </div>

      {/* ---------------- 4. Voice ---------------- */}
      <div className="talentStep" hidden={step !== 3}>
        <p className="advNote">
          Voice is what the host physically sounds like. It is separate from personality, so changing a voice never erases the character.
          {hostHasVoice && <> Current voice: <strong>{voiceSourceLabel(host!.voiceSource) || "provenance undocumented"}</strong>.</>}
        </p>
        <div className="hostModeGrid mt-4" role="group" aria-label="Voice option">
          {([
            ["design", "Design a new voice", "Describe it, hear three choices, and pick one."],
            ["clone", "Clone my voice", "Upload your voice or a voice you have permission to use."],
            ["existing", hostHasVoice ? "Keep or attach a voice" : "Use an existing voice", hostHasVoice ? "Keep the current voice and document its permission, or attach another." : "Attach a Fish voice you already own or license."],
            ["later", hostHasVoice ? "Leave the voice as it is" : "Choose later", hostHasVoice ? "Save the character only. The voice and its record are not touched." : "Save the character now. Audio stays blocked until a voice is added."],
          ] as Array<[VoiceSetupMode, string, string]>).map(([value, title, help]) => (
            <button key={value} type="button" aria-pressed={voiceMode === value} className={voiceMode === value ? "btnPrimary" : "btnGhost"} onClick={() => setVoiceMode(value)} data-tall="true">
              <strong className="hostModeTitle">{title}</strong>
              <span className="hostModeHelp">{help}</span>
            </button>
          ))}
        </div>

        <div className="mt-6" hidden={voiceMode !== "design"}>
          <VoiceDesigner
            hostName={name}
            brief={host?.voiceBrief ?? null}
            pace={settings.pace}
            onSelectionChange={setDesignSelection}
            footer={designSelection && <div className="gateResult gate-ok mt-4">Take {designSelection.take} will be saved as this host&apos;s voice when you save the host. Its record will read &ldquo;Designed voice&rdquo;.</div>}
          />
        </div>

        <div className="mt-6" hidden={voiceMode !== "clone"}>
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

        <div className="mt-6" hidden={voiceMode !== "existing"}>
          {!hostHasVoice && <div className="advNote">This is the advanced path. Most users should design or clone a voice instead.</div>}
          <label className="hostField mt-4"><span className="fieldLabel">Fish voice ID</span><input className="advSelect" value={existingVoiceId} onChange={(event) => setExistingVoiceId(event.target.value)} placeholder="32-character voice ID" /></label>
          <ChoiceRow title="Permission" help="Who owns or licensed this voice. Required: a voice with no record is flagged as undocumented." value={existingSource} onChange={setExistingSource} options={[
            { value: "owned", label: "I own it" }, { value: "licensed", label: "Licensed" }, { value: "synthetic-stock", label: "Designed / stock" },
          ]} />
          {voiceReady(existingVoiceId) && !existingSource && (
            <div className="gateResult gate-err mt-3" role="status">⚠ Provenance undocumented. Choose one of the three options above.</div>
          )}
          <label className="hostField mt-4"><span className="fieldLabel">Permission or source note</span><textarea className="advSelect" rows={2} value={existingNote} onChange={(event) => setExistingNote(event.target.value)} /></label>
        </div>

        {voiceMode === "later" && (
          <div className="advNote mt-4">
            {hostHasVoice
              ? "The current voice stays attached, and its permission record is left exactly as stored."
              : "The host can be saved, but script-to-audio production will remain blocked until a real voice is attached."}
          </div>
        )}
      </div>

      {/* ---------------- 5. Final review ---------------- */}
      <div className="talentStep" hidden={step !== last}>
        {blockers.length > 0 ? (
          <div className="talentIssues" role="status">
            <div className="hostChoiceTitle">Fix before saving</div>
            <ul>
              {blockers.map((issue) => (
                <li key={issue.id}><span className="statusPill statusPill--err">Blocking</span> {issue.text}</li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="gateResult gate-ok" role="status">✓ Nothing is blocking this save.</div>
        )}
        {warnings.length > 0 && (
          <div className="talentIssues mt-4">
            <div className="hostChoiceTitle">Saved as is, but worth knowing</div>
            <ul>
              {warnings.map((issue) => (
                <li key={issue.id}><span className="statusPill statusPill--warn">Warning</span> {issue.text}</li>
              ))}
            </ul>
          </div>
        )}

        <dl className="talentFacts mt-6">
          <ReviewRow label="Name" onEdit={() => setStep(0)}>{name.trim() || "Not set"}</ReviewRow>
          <ReviewRow label="Role" onEdit={() => setStep(0)}>{roleLabel(settings)}</ReviewRow>
          <ReviewRow label="Belief" onEdit={() => setStep(0)}>{settings.belief.trim() || "Not set"}</ReviewRow>
          <ReviewRow label="Casting priority" onEdit={() => setStep(0)}>{settings.castPriority} of 10</ReviewRow>
          <ReviewRow label="Personality" onEdit={() => setStep(1)}>
            {TRAIT_LABELS.humor[settings.humor]} · interrupts: {TRAIT_LABELS.interruptions[settings.interruptions].toLowerCase()} · concedes: {TRAIT_LABELS.concessions[settings.concessions].toLowerCase()} · finish: {TRAIT_LABELS.finish[settings.finish].toLowerCase()}
          </ReviewRow>
          <ReviewRow label="They often" onEdit={() => setStep(1)}>{listOrNone(settings.argumentPatterns)}</ReviewRow>
          <ReviewRow label="Never say" onEdit={() => setStep(1)}>{listOrNone(settings.bannedPhrases)}</ReviewRow>
          <ReviewRow label="Favorite phrases" onEdit={() => setStep(1)}>{listOrNone(settings.catchphrases)}</ReviewRow>
          {settings.extraInstructions.trim() && <ReviewRow label="Extra notes" onEdit={() => setStep(1)}>{settings.extraInstructions}</ReviewRow>}
          <ReviewRow label="Performance" onEdit={() => setStep(2)}>
            {TRAIT_LABELS.energy[settings.energy]} · {TRAIT_LABELS.pace[settings.pace].toLowerCase()} pace · {TRAIT_LABELS.pauses[settings.pauses].toLowerCase()} pauses · under pressure: {TRAIT_LABELS.pressure[settings.pressure].toLowerCase()}
          </ReviewRow>
          <ReviewRow label="Never sound like" onEdit={() => setStep(2)}>{listOrNone(settings.prohibitedTraits)}</ReviewRow>
          <ReviewRow label="Voice" onEdit={() => setStep(3)}>
            {voiceMode === "design" ? (designSelection ? `New designed voice (take ${designSelection.take})` : "Design a new voice: no take picked")
              : voiceMode === "clone" ? (cloneFiles.length ? `Clone from ${cloneFiles.length} recording(s)` : "Clone: no recordings added")
                : voiceMode === "existing" ? (voiceReady(existingVoiceId) ? (hostHasVoice && existingVoiceId === host!.ttsVoiceId ? "Keep the current voice" : "Attach an existing Fish voice") : "Existing voice: no valid ID")
                  : hostHasVoice ? "Current voice, unchanged" : "No voice yet"}
          </ReviewRow>
          <ReviewRow label="Voice provenance" onEdit={() => setStep(3)}>
            {!willHaveVoice ? "Not applicable until there is a voice" : voiceSourceLabel(resultingSource) || "⚠ Undocumented"}
          </ReviewRow>
        </dl>

        <p className="talentRead mt-4"><strong>How this host will read:</strong> {personalityRead(settings)}</p>
        {recommendations.length > 0 && (
          <p className="advNote mt-3">
            {recommendations.length} personality suggestion{recommendations.length === 1 ? "" : "s"} (optional).{" "}
            <button type="button" className="advLink" onClick={() => setStep(1)}>See them in Personality</button>
          </p>
        )}
      </div>

      {error && <div className="gateResult gate-err mt-4 mb-4" role="alert">{error}</div>}

      <div className="hostWizardFoot">
        {step > 0 && <button type="button" className="btnGhost" onClick={() => setStep((value) => value - 1)}>Back</button>}
        {step < last && <button type="button" className="btnPrimary" onClick={() => setStep((value) => value + 1)}>Next: {STEPS[step + 1]}</button>}
        {step < last && <button type="button" className="btnGhost" onClick={() => setStep(last)}>Review and save</button>}
        {step === last && (
          <button type="button" className="btnPrimary" onClick={save} disabled={busy || blockers.length > 0}>
            {saveLabel}
          </button>
        )}
        <button type="button" className="btnGhost u-mlAuto" onClick={() => onClose()} disabled={busy}>Cancel</button>
      </div>
    </section>
  );
}
