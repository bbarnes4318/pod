"use client";

// Voice-engine picker for the create flow. Each engine renders the hosts'
// emotional delivery in its own tag language behind the scenes (ElevenLabs
// [tags], Boson <|tokens|>, Fish inline cues) — the listener just picks a
// sound.

import React, { useState, useTransition } from "react";
import { setVoiceEngine } from "./voiceActions";

const ENGINES: { id: string; label: string; hint: string }[] = [
  { id: "default", label: "Studio default", hint: "Whatever the studio has dialed in" },
  { id: "elevenlabs", label: "ElevenLabs", hint: "Signature broadcast voices" },
  { id: "boson", label: "Boson AI", hint: "Expressive emotion engine" },
  { id: "fish", label: "Fish Audio", hint: "Natural multilingual delivery" },
];

export default function VoicePicker({ current }: { current: string }) {
  const [selected, setSelected] = useState(current);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const pick = (id: string) => {
    if (pending || id === selected) return;
    startTransition(async () => {
      const res = await setVoiceEngine(id);
      if (res.ok) {
        setSelected(id);
        setNote(res.message);
      } else {
        setNote(res.message);
      }
    });
  };

  return (
    <section style={{ marginBottom: "1.8rem" }} aria-label="Voice engine">
      <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--u-ink-2)", marginBottom: "0.55rem", letterSpacing: "0.04em", textTransform: "uppercase" }}>
        Voice engine
      </div>
      <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
        {ENGINES.map((e) => {
          const active = selected === e.id;
          return (
            <button
              key={e.id}
              onClick={() => pick(e.id)}
              disabled={pending}
              title={e.hint}
              style={{
                border: active ? "1px solid var(--u-brand)" : "1px solid var(--u-hairline-2)",
                background: active ? "var(--u-brand-soft)" : "var(--u-surface)",
                color: active ? "var(--u-brand)" : "var(--u-ink-2)",
                fontWeight: 700,
                fontSize: "0.82rem",
                borderRadius: 999,
                padding: "0.5rem 1.05rem",
                cursor: pending ? "wait" : "pointer",
                opacity: pending && !active ? 0.6 : 1,
              }}
            >
              {active ? "● " : ""}{e.label}
            </button>
          );
        })}
      </div>
      {note && <p style={{ fontSize: "0.75rem", color: "var(--u-ink-3)", marginTop: "0.5rem" }}>{note}</p>}
    </section>
  );
}
