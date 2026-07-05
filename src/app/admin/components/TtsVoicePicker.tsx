"use client";

// Per-host voice pickers for a chosen voice engine, shared by the episode
// build form and the audio segment console.
//
// - ElevenLabs / Cartesia: browse the account's voice list (search, preview
//   where a preview URL exists) or type a voice ID manually.
// - Boson: manual voice ID ("default" is valid); no stable public voice-list
//   endpoint, so we don't fake one.
// - Fish: manual reference_id (32-hex); same story on listing.
// - OpenAI: fixed set of voice names.
// - Stub / no engine: renders nothing.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { getElevenLabsVoices, getCartesiaVoices } from "../personalities/actions";
import { FISH_REFERENCE_ID_RE, OPENAI_TTS_VOICE_NAMES } from "@/lib/providers/tts/providerIds";

export interface PickerHost {
  slug: string;
  name: string;
}

export interface VoicePick {
  voiceId: string;
  voiceName?: string;
}

export type VoicePicks = Record<string, VoicePick>;

interface BrowseVoice {
  id: string;
  name: string;
  preview_url?: string | null;
  gender?: string;
  accent?: string;
  language?: string;
  category?: string;
  description?: string;
}

const BROWSABLE = new Set(["elevenlabs", "cartesia"]);

export default function TtsVoicePicker({
  provider,
  hosts,
  value,
  onChange,
  disabled = false,
}: {
  /** Resolved engine id these picks are for (elevenlabs, boson, ...). */
  provider: string;
  hosts: PickerHost[];
  value: VoicePicks;
  onChange: (next: VoicePicks) => void;
  disabled?: boolean;
}) {
  const [voices, setVoices] = useState<BrowseVoice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(() => BROWSABLE.has(provider));
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Reset the browse state when the engine changes (render-time reset, not
  // an effect, so there's no flash of the previous engine's list).
  const [lastProvider, setLastProvider] = useState(provider);
  if (lastProvider !== provider) {
    setLastProvider(provider);
    setVoices([]);
    setVoicesError(null);
    setSearch("");
    setLoadingVoices(BROWSABLE.has(provider));
  }

  useEffect(() => {
    if (!BROWSABLE.has(provider)) return;

    let cancelled = false;
    const fetcher = provider === "elevenlabs" ? getElevenLabsVoices : getCartesiaVoices;
    fetcher().then((res: { success: boolean; voices?: unknown; error?: string }) => {
      if (cancelled) return;
      if (res.success && Array.isArray(res.voices)) {
        setVoices(res.voices as BrowseVoice[]);
      } else {
        setVoicesError(res.error || "Failed to load voice list — manual voice ID entry still works.");
      }
      setLoadingVoices(false);
    });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const filteredVoices = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return voices;
    return voices.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        (v.description || "").toLowerCase().includes(q) ||
        (v.accent || "").toLowerCase().includes(q) ||
        (v.gender || "").toLowerCase().includes(q)
    );
  }, [voices, search]);

  const setPick = (slug: string, pick: VoicePick) => {
    onChange({ ...value, [slug]: pick });
  };

  const playPreview = (url: string, id: string) => {
    if (audioRef.current) audioRef.current.pause();
    if (playingId === id) {
      setPlayingId(null);
      audioRef.current = null;
      return;
    }
    const a = new Audio(url);
    a.play();
    a.onended = () => setPlayingId(null);
    audioRef.current = a;
    setPlayingId(id);
  };

  if (!provider || provider === "stub") return null;

  const idLabel =
    provider === "fish" ? "Fish reference_id" : provider === "boson" ? "Boson voice ID" : "Voice ID";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {BROWSABLE.has(provider) && (
        <>
          {loadingVoices ? (
            <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>Loading voice list…</div>
          ) : voicesError ? (
            <div style={{ fontSize: "0.75rem", color: "var(--warning-color)" }}>{voicesError}</div>
          ) : (
            <input
              type="text"
              className="input"
              placeholder="🔍 Filter voices by name, accent…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              disabled={disabled}
            />
          )}
        </>
      )}

      {hosts.map((host) => {
        const pick = value[host.slug] || { voiceId: "" };
        const selectedVoice = voices.find((v) => v.id === pick.voiceId);
        const fishInvalid =
          provider === "fish" && pick.voiceId.trim() !== "" && !FISH_REFERENCE_ID_RE.test(pick.voiceId.trim());

        return (
          <div key={host.slug} className="formGroup" style={{ marginBottom: 0 }}>
            <label className="label" style={{ fontSize: "0.75rem" }}>
              {host.name} — {idLabel}
            </label>

            {BROWSABLE.has(provider) && voices.length > 0 && (
              <div style={{ display: "flex", gap: "0.35rem", marginBottom: "0.35rem" }}>
                <select
                  className="select"
                  style={{ flex: 1, minWidth: 0 }}
                  value={selectedVoice ? pick.voiceId : ""}
                  onChange={(e) => {
                    const v = voices.find((vv) => vv.id === e.target.value);
                    if (v) setPick(host.slug, { voiceId: v.id, voiceName: v.name });
                  }}
                  disabled={disabled}
                >
                  <option value="">Browse {filteredVoices.length} voices…</option>
                  {filteredVoices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                      {[v.gender, v.accent || v.language].filter(Boolean).length > 0
                        ? ` (${[v.gender, v.accent || v.language].filter(Boolean).join(", ")})`
                        : ""}
                    </option>
                  ))}
                </select>
                {selectedVoice?.preview_url && (
                  <button
                    type="button"
                    className="editButton"
                    style={{ fontSize: "0.75rem", whiteSpace: "nowrap" }}
                    onClick={() => playPreview(selectedVoice.preview_url!, selectedVoice.id)}
                    disabled={disabled}
                  >
                    {playingId === selectedVoice.id ? "⏸ Stop" : "🔊 Preview"}
                  </button>
                )}
              </div>
            )}

            {provider === "openai" ? (
              <select
                className="select"
                value={pick.voiceId}
                onChange={(e) => setPick(host.slug, { voiceId: e.target.value })}
                disabled={disabled}
              >
                <option value="">Default (env / alloy)</option>
                {OPENAI_TTS_VOICE_NAMES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                className="input"
                style={fishInvalid ? { borderColor: "var(--error-color)" } : undefined}
                placeholder={
                  provider === "boson"
                    ? "Boson voice ID (or 'default')"
                    : provider === "fish"
                    ? "Fish reference_id (32-hex)"
                    : `Paste ${idLabel} or pick above`
                }
                value={pick.voiceId}
                onChange={(e) => {
                  const id = e.target.value;
                  const matched = voices.find((v) => v.id === id.trim());
                  setPick(host.slug, { voiceId: id, ...(matched ? { voiceName: matched.name } : {}) });
                }}
                disabled={disabled}
              />
            )}

            {pick.voiceName && pick.voiceId && (
              <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}>
                Selected: {pick.voiceName}
              </div>
            )}
            {provider === "fish" && (
              <div
                style={{
                  fontSize: "0.7rem",
                  color: fishInvalid ? "var(--error-color)" : "var(--text-secondary)",
                  marginTop: "0.2rem",
                }}
              >
                Fish reference IDs are usually 32-hex IDs{fishInvalid ? " — this doesn't look like one." : "."}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>
        Leave a field empty to use the host default / env voice for this engine.
      </div>
    </div>
  );
}

/**
 * Build the provider-tagged overrides map the server actions expect from the
 * picker's raw picks. Returns undefined when nothing was picked.
 */
export function buildVoiceOverrides(
  provider: string,
  picks: VoicePicks
): Record<string, { provider: string; voiceId: string; voiceName?: string }> | undefined {
  if (!provider || provider === "stub") return undefined;
  const out: Record<string, { provider: string; voiceId: string; voiceName?: string }> = {};
  for (const [slug, pick] of Object.entries(picks)) {
    const voiceId = pick.voiceId.trim();
    if (!voiceId) continue;
    out[slug] = { provider, voiceId, ...(pick.voiceName ? { voiceName: pick.voiceName } : {}) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
