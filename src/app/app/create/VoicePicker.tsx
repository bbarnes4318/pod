"use client";

// Voice-engine picker for the create flow. The choice applies to the next
// episode you produce: it is persisted on that episode, so every TTS run
// (and re-run) for it uses the same engine. "Studio default" leaves the
// episode unpinned — per-host engine, then the TTS_PROVIDER env default.
// Each engine renders emotional delivery in its own tag language behind the
// scenes (ElevenLabs [tags], Boson <|tokens|>, Fish inline cues) — the
// listener just picks a sound.

import React from "react";

const ENGINES: { id: string; label: string; hint: string }[] = [
  { id: "default", label: "Studio default", hint: "Whatever the studio has dialed in" },
  { id: "elevenlabs", label: "ElevenLabs", hint: "Signature broadcast voices" },
  { id: "cartesia", label: "Cartesia", hint: "Fast, crisp studio voices" },
  { id: "openai", label: "OpenAI", hint: "Clean conversational voices" },
  { id: "boson", label: "Boson AI", hint: "Expressive emotion engine" },
  { id: "fish", label: "Fish Audio", hint: "Natural multilingual delivery" },
];

export default function VoicePicker({
  value,
  onChange,
  defaultHint,
}: {
  value: string;
  onChange: (id: string) => void;
  /** What "Studio default" currently resolves to, e.g. "Boson AI". */
  defaultHint: string;
}) {
  return (
    <section style={{ marginBottom: "1.8rem" }} aria-label="Voice engine">
      <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--u-ink-2)", marginBottom: "0.55rem", letterSpacing: "0.04em", textTransform: "uppercase" }}>
        Voice engine
      </div>
      <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
        {ENGINES.map((e) => {
          const active = value === e.id;
          return (
            <button
              key={e.id}
              onClick={() => onChange(e.id)}
              title={e.id === "default" ? `${e.hint} — currently ${defaultHint}` : e.hint}
              style={{
                border: active ? "1px solid var(--u-brand)" : "1px solid var(--u-hairline-2)",
                background: active ? "var(--u-brand-soft)" : "var(--u-surface)",
                color: active ? "var(--u-brand)" : "var(--u-ink-2)",
                fontWeight: 700,
                fontSize: "0.82rem",
                borderRadius: 999,
                padding: "0.5rem 1.05rem",
                cursor: "pointer",
              }}
            >
              {active ? "● " : ""}{e.label}
            </button>
          );
        })}
      </div>
      <p style={{ fontSize: "0.75rem", color: "var(--u-ink-3)", marginTop: "0.5rem" }}>
        {value === "default"
          ? `New episodes use the studio default (${defaultHint}).`
          : `New episodes you produce will be voiced by ${ENGINES.find((e) => e.id === value)?.label ?? value}.`}
      </p>
    </section>
  );
}
