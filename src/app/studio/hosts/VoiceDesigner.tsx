"use client";

import React, { useRef, useState } from "react";
import { designHostVoice } from "./actions";
import { FISH_VOICE_DESCRIPTION_MAX, FISH_VOICE_TEST_LINE_MAX } from "@/lib/providers/tts/fishVoiceLimits";
import type { HostVoiceBrief } from "@/lib/hosts/voiceBriefs";

/**
 * Create a host's voice with Fish Voice Design, inside the app.
 *
 * Describe the voice (a catalog character arrives with its brief already
 * written), hear three takes speaking the character's own test line, keep
 * asking for more until one is right, pick it. The parent decides what "save"
 * means: the host card saves the voice on its own; the full editor saves it
 * after the rest of the character.
 */

export type DesignedTake = {
  key: string;
  round: number;
  take: number;
  audioBase64: string;
  audioDataUrl: string;
  durationMs: number;
  /** The exact words that produced this take. Editing the form afterwards
   *  must not change what gets saved with it. */
  description: string;
  testLine: string;
};

export type VoiceDesignSelection = DesignedTake;

const MAX_KEPT_TAKES = 12;

const DEFAULT_TEST_LINE = "Alright, let's get into it. This story has one detail nobody wants to say out loud.";

const QUICK = {
  gender: ["Woman", "Man", "Neutral"],
  age: ["Young adult", "Middle-aged", "Older"],
  sound: ["Low and deep", "Warm and natural", "Bright and clear", "Raspy and weathered"],
  delivery: ["Calm", "Conversational", "High energy", "Authoritative"],
} as const;

function quickDescription(q: { gender: string; age: string; sound: string; delivery: string; accent: string }): string {
  const accent = q.accent.trim() ? ` ${q.accent.trim()} accent.` : "";
  return `${q.age} ${q.gender.toLowerCase()} podcast host voice. ${q.sound}. ${q.delivery} delivery, like a real person talking, not an announcer or audiobook narrator.${accent}`;
}

function seconds(ms: number): string {
  if (!ms || ms < 0) return "";
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function VoiceDesigner({ hostName, brief, pace, onSelectionChange, footer }: {
  hostName: string;
  brief: HostVoiceBrief | null;
  pace: "easy" | "natural" | "fast";
  onSelectionChange: (selection: VoiceDesignSelection | null) => void;
  /** Rendered under the takes, e.g. the card's save button. */
  footer?: React.ReactNode;
}) {
  const [quick, setQuick] = useState({ gender: "Man", age: "Middle-aged", sound: "Warm and natural", delivery: "Conversational", accent: "General American" });
  const [description, setDescription] = useState(brief?.description ?? quickDescription(quick));
  const [testLine, setTestLine] = useState(brief?.testLine ?? DEFAULT_TEST_LINE);
  const [takes, setTakes] = useState<DesignedTake[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());

  const descriptionTooLong = description.trim().length > FISH_VOICE_DESCRIPTION_MAX;
  const testLineTooLong = testLine.trim().length > FISH_VOICE_TEST_LINE_MAX;
  const canDesign = !busy && description.trim().length > 0 && !descriptionTooLong && !testLineTooLong;

  const setQuickField = (key: keyof typeof quick, value: string) => {
    const next = { ...quick, [key]: value };
    setQuick(next);
    setDescription(quickDescription(next));
  };

  const design = async () => {
    if (!canDesign) return;
    setBusy(true); setError(null);
    const speed = pace === "fast" ? 1.08 : pace === "easy" ? 0.94 : 1;
    const words = { description: description.trim(), testLine: testLine.trim() };
    const nextRound = round + 1;
    setRound(nextRound);
    // Three one-take calls at once; each take appears as soon as Fish returns it.
    let landed = 0;
    const errors: string[] = [];
    await Promise.all([1, 2, 3].map(async (takeNumber) => {
      const result = await designHostVoice({ instruction: words.description, previewText: words.testLine, speed })
        .catch((e: unknown) => ({ success: false as const, error: e instanceof Error ? e.message : "Voice design failed." }));
      if (!result.success) { errors.push(result.error); return; }
      const fresh: DesignedTake[] = result.candidates.map((candidate) => ({
        key: `${nextRound}-${takeNumber}-${candidate.id}`,
        round: nextRound,
        take: ++landed,
        audioBase64: candidate.audioBase64,
        audioDataUrl: `data:audio/wav;base64,${candidate.audioBase64}`,
        durationMs: candidate.durationMs,
        ...words,
      }));
      setTakes((current) => {
        // Newest round first; never drop the take the user picked.
        const kept = [...fresh, ...current];
        const picked = kept.find((candidate) => candidate.key === selectedKey);
        const trimmed = kept.slice(0, MAX_KEPT_TAKES);
        return picked && !trimmed.includes(picked) ? [...trimmed.slice(0, MAX_KEPT_TAKES - 1), picked] : trimmed;
      });
    }));
    if (errors.length === 3) setError(errors[0]);
    else if (errors.length) setError(`${3 - errors.length} of 3 takes came back. ${errors[0]}`);
    setBusy(false);
  };

  const togglePlay = (key: string) => {
    const audio = audioRefs.current.get(key);
    if (!audio) return;
    audioRefs.current.forEach((other, otherKey) => { if (otherKey !== key) { other.pause(); other.currentTime = 0; } });
    if (audio.paused) {
      audio.currentTime = 0;
      void audio.play().then(() => setPlayingKey(key)).catch(() => setPlayingKey(null));
    } else {
      audio.pause();
      setPlayingKey(null);
    }
  };

  const pick = (take: DesignedTake) => {
    const next = selectedKey === take.key ? null : take;
    setSelectedKey(next ? next.key : null);
    onSelectionChange(next);
  };

  const rounds = [...new Set(takes.map((take) => take.round))];

  return (
    <div className="voiceDesigner">
      <div className="voiceDesignerIntro">
        <div>
          <div className="voiceDesignerTitle">Create {hostName ? `${hostName}'s` : "a"} voice</div>
          <div className="voiceDesignerSub">
            Fish designs three takes from the description. Play them, ask for more if none is right, then keep one.
          </div>
        </div>
        {brief && <span className="chip chipSuccess voiceBriefChip">Voice brief written for {hostName}</span>}
      </div>

      {!brief && (
        <div className="voiceQuickGrid">
          {(Object.keys(QUICK) as Array<keyof typeof QUICK>).map((key) => (
            <div key={key} className="voiceQuickRow">
              <span className="voiceQuickLabel">{key === "gender" ? "Voice" : key[0].toUpperCase() + key.slice(1)}</span>
              <div className="hostBtnRow">
                {QUICK[key].map((option) => (
                  <button key={option} type="button" className={quick[key] === option ? "btnPrimary" : "btnGhost"} onClick={() => setQuickField(key, option)}>
                    {option}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <label className="voiceQuickRow">
            <span className="voiceQuickLabel">Accent</span>
            <input className="advSelect" value={quick.accent} onChange={(event) => setQuickField("accent", event.target.value)} />
          </label>
        </div>
      )}

      <label className="hostField mt-4">
        <span className="voiceFieldHead">
          <span className="fieldLabel">Describe the voice</span>
          <span className={`voiceCount ${descriptionTooLong ? "voiceCountOver" : ""}`}>{description.trim().length}/{FISH_VOICE_DESCRIPTION_MAX}</span>
        </span>
        <span className="hostFieldHint">
          {brief
            ? "Written for this character. Edit anything you like before creating takes."
            : "The buttons above write a starting description. Change the words freely."}
        </span>
        <textarea className="advSelect" rows={brief ? 6 : 3} value={description} onChange={(event) => setDescription(event.target.value)} />
        {brief && description !== brief.description && (
          <button type="button" className="advLink voiceReset" onClick={() => setDescription(brief.description)}>Restore the original brief</button>
        )}
      </label>

      <label className="hostField mt-4">
        <span className="voiceFieldHead">
          <span className="fieldLabel">What each take says</span>
          <span className={`voiceCount ${testLineTooLong ? "voiceCountOver" : ""}`}>{testLine.trim().length}/{FISH_VOICE_TEST_LINE_MAX}</span>
        </span>
        <textarea className="advSelect" rows={3} value={testLine} onChange={(event) => setTestLine(event.target.value)} />
        {testLineTooLong && <span className="voiceCountOver hostFieldHint">Fish allows {FISH_VOICE_TEST_LINE_MAX} characters here. Shorten the line.</span>}
      </label>

      <div className="voiceDesignActions">
        <button type="button" className="btnPrimary" onClick={design} disabled={!canDesign}>
          {busy && <span className="btnSpin" aria-hidden="true" />}
          {busy ? "Designing takes…" : takes.length ? "Create 3 more takes" : "Create 3 takes"}
        </button>
        {busy && <span className="voiceDesignWait">Fish is designing three voices. Each one appears as soon as it's ready.</span>}
      </div>

      {error && <div className="gateResult gate-err mt-3">{error}</div>}

      {busy && takes.length === 0 && (
        <div className="voiceTakeGrid" aria-hidden="true">
          {[1, 2, 3].map((n) => <div key={n} className="voiceTake voiceTakeSkeleton" />)}
        </div>
      )}

      {rounds.map((roundNumber) => (
        <div key={roundNumber} className="voiceRound">
          {rounds.length > 1 && <div className="voiceRoundLabel">Round {roundNumber}</div>}
          <div className="voiceTakeGrid">
            {takes.filter((take) => take.round === roundNumber).sort((a, b) => a.take - b.take).map((take) => {
              const isSelected = take.key === selectedKey;
              const isPlaying = take.key === playingKey;
              return (
                <div key={take.key} className="voiceTake" data-selected={isSelected ? "true" : undefined} data-playing={isPlaying ? "true" : undefined}>
                  <div className="voiceTakeHead">
                    <span className="voiceTakeName">Take {take.take}</span>
                    <span className="voiceTakeTime">{seconds(take.durationMs)}</span>
                  </div>
                  <button type="button" className="voicePlay" onClick={() => togglePlay(take.key)} aria-label={isPlaying ? `Stop take ${take.take}` : `Play take ${take.take}`}>
                    <span className="voicePlayIcon" aria-hidden="true">{isPlaying ? "❚❚" : "▶"}</span>
                    <span className={`eq ${isPlaying ? "" : "paused"}`} aria-hidden="true"><span /><span /><span /><span /><span /></span>
                  </button>
                  <audio
                    ref={(element) => { if (element) audioRefs.current.set(take.key, element); else audioRefs.current.delete(take.key); }}
                    src={take.audioDataUrl}
                    preload="auto"
                    onEnded={() => setPlayingKey((current) => (current === take.key ? null : current))}
                    onPause={() => setPlayingKey((current) => (current === take.key ? null : current))}
                  />
                  <button type="button" className={isSelected ? "btnPrimary" : "btnGhost"} onClick={() => pick(take)}>
                    {isSelected ? "✓ This one" : "Use this voice"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {footer}
    </div>
  );
}
