"use client";

// Shared view-model, labels and client hooks for the Talent Studio modules
// (library, card, profile, five-step workflow). Not a "use server" file.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { HostStudioSettings } from "@/lib/hosts/hostStudioProfile";
import type { HostVoiceBrief } from "@/lib/hosts/voiceBriefs";
import { isRealVoiceId } from "@/lib/hosts/castingFit";
import { useStudioAudio, type StudioTrack } from "../StudioAudio";
import { auditionHostVoice, cloneHostToRoster } from "./actions";
import type { PreviewScenario } from "./constants";

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
  /** The written Fish voice brief, for catalog characters. */
  voiceBrief: HostVoiceBrief | null;
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

export const voiceReady = isRealVoiceId;

export const previewLines: Record<PreviewScenario, string> = {
  hello: "Alright, let's get into it. I know exactly which part of this story does not add up.",
  disagree: "No—hold on. That sounds clean because you skipped the person who paid for the decision.",
  pressure: "That's the excuse. Now tell me who chose it, and who had to live with it.",
};

export const scenarioLabels: Record<PreviewScenario, string> = {
  hello: "Normal conversation",
  disagree: "Disagreeing",
  pressure: "Under pressure",
};

export function voiceSourceLabel(source: string): string {
  return source === "synthetic-stock" ? "Designed voice" : source === "owned" ? "Owned voice" : source === "licensed" ? "Licensed voice" : "";
}

export function providerLabel(provider: string): string {
  return provider === "fish" ? "Fish Audio" : provider;
}

export function usageLabel(count: number): string {
  return `Used in ${count} episode${count === 1 ? "" : "s"}.`;
}

export function linesToText(lines: string[]): string {
  return lines.join("\n");
}

export function textToLines(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

/**
 * A real voice preview: one call to the voice engine (`auditionHostVoice`),
 * played through the Studio's own player. It costs a provider call, so it only
 * ever runs from a click. The last result is kept so it can be replayed with
 * the play button without asking the engine again.
 */
export function useHostPreview(key: string) {
  const { toggle } = useStudioAudio();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [track, setTrack] = useState<StudioTrack | null>(null);
  const sequence = useRef(0);

  const request = async (input: Parameters<typeof auditionHostVoice>[0], title: string): Promise<boolean> => {
    setBusy(true); setError(null);
    const result = await auditionHostVoice(input);
    setBusy(false);
    if (!result.success) {
      setError(result.error || "Couldn't play this voice.");
      return false;
    }
    sequence.current += 1;
    const next: StudioTrack = {
      id: `talent-preview:${key}:${sequence.current}`,
      src: result.audioDataUrl,
      title,
      subtitle: "Voice preview · not saved",
      href: "/studio/hosts",
    };
    setTrack(next);
    toggle(next);
    return true;
  };

  return { busy, error, track, request };
}

/**
 * EDIT, WHATEVER IT TAKES.
 *
 * A house-cast host is shared (ownerId null), so it genuinely cannot be edited
 * in place — one account's rewrite would change the character for everybody.
 * That constraint is real. What was NOT real was making the user solve it: a
 * new account owns nothing, so if Edit only appeared on owned hosts, the whole
 * roster it starts with would show no Edit button at all.
 *
 * So Edit is offered on every host and always opens the workflow. When the
 * host is shared, the fork happens on the way there: clone it, then open the
 * COPY. The user is told what happened rather than asked to arrange it.
 */
export function useEditHost(host: StudioHostVM, onEdit: (hostId?: string) => void) {
  const router = useRouter();
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editHost = async () => {
    if (host.canEdit) {
      onEdit();
      return;
    }
    setCloning(true); setError(null);
    const result = await cloneHostToRoster(host.id);
    if (!result.success) {
      setError(result.error);
      setCloning(false);
      return;
    }
    // Open the copy BEFORE refreshing: the refreshed list is what carries the
    // new host, and the page needs to already know that is the one being edited.
    onEdit(result.hostId);
    router.refresh();
    setCloning(false);
  };

  return { editHost, cloning, error };
}
