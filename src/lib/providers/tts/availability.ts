// Which TTS engines this deployment can actually reach.
//
// The Production step used to offer ElevenLabs, Cartesia, OpenAI and Fish Audio
// unconditionally. On this deployment only Fish is configured, so three of the
// four choices were accepted at selection and could only fail later — after the
// customer had already paid for a script. An option you cannot fulfil is not a
// choice, it is a trap.
//
// Server-only: it reads env. The picker receives the resolved list as props.

import "server-only";

export interface TtsEngineOption {
  /** The value stored on the episode / passed to the worker. "" = host default. */
  key: string;
  label: string;
  /** False when this deployment has no credentials for it. */
  available: boolean;
  /** Shown next to a disabled option so the absence is explained, not mysterious. */
  reason?: string;
}

const ENGINES: { key: string; label: string; envVar: string }[] = [
  { key: "fish", label: "Fish Audio", envVar: "FISH_API_KEY" },
  { key: "elevenlabs", label: "ElevenLabs", envVar: "ELEVENLABS_API_KEY" },
  { key: "cartesia", label: "Cartesia", envVar: "CARTESIA_API_KEY" },
  { key: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY" },
];

/** The engine list for the UI: host default first, then every engine, each
 *  flagged with whether this deployment can actually use it. */
export function ttsEngineOptions(): TtsEngineOption[] {
  return [
    { key: "", label: "Auto (host default)", available: true },
    ...ENGINES.map((e) => {
      const available = !!(process.env[e.envVar] || "").trim();
      return {
        key: e.key,
        label: e.label,
        available,
        reason: available ? undefined : "Not configured on this deployment",
      };
    }),
  ];
}

/** True when an explicitly requested engine can be used. "" (host default) is
 *  always allowed — the host's own provider is resolved downstream. */
export function isTtsEngineAvailable(key: string | null | undefined): boolean {
  if (!key) return true;
  const found = ENGINES.find((e) => e.key === key);
  if (!found) return false;
  return !!(process.env[found.envVar] || "").trim();
}
