"use client";

import React, { useEffect, useState } from "react";
import { getElevenLabsVoices } from "../personalities/actions";
import { assignElevenLabsVoiceToHost } from "./actions";

interface Host {
  id: string;
  name: string;
  ttsProvider: string;
  ttsVoiceId: string;
  isActive: boolean;
}

interface VoiceOption {
  id: string;
  name: string;
  category?: string;
  gender?: string;
  accent?: string;
  age?: string;
  useCase?: string;
  description?: string;
  preview_url?: string | null;
}

export default function VoicesConsole({ hosts: initialHosts }: { hosts: Host[] }) {
  const [hosts, setHosts] = useState<Host[]>(initialHosts);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [genderFilter, setGenderFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");

  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const [assigningKey, setAssigningKey] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    getElevenLabsVoices().then((res) => {
      if (res.success && res.voices) {
        setVoices(res.voices as VoiceOption[]);
      } else {
        setError(res.error || "Failed to load ElevenLabs voices.");
      }
      setLoading(false);
    });
  }, []);

  const playPreview = (url: string, id: string) => {
    if (audio) audio.pause();
    if (playingVoiceId === id) {
      setPlayingVoiceId(null);
      setAudio(null);
      return;
    }
    const a = new Audio(url);
    a.play();
    setPlayingVoiceId(id);
    setAudio(a);
    a.onended = () => {
      setPlayingVoiceId(null);
      setAudio(null);
    };
  };

  const assign = async (host: Host, voice: VoiceOption) => {
    setAssigningKey(`${host.id}:${voice.id}`);
    setToast(null);
    const res = await assignElevenLabsVoiceToHost(host.id, voice.id);
    if (res.success) {
      setHosts((prev) =>
        prev.map((h) => (h.id === host.id ? { ...h, ttsProvider: "elevenlabs", ttsVoiceId: voice.id } : h))
      );
      setToast({ ok: true, msg: `“${voice.name}” assigned to ${host.name}.` });
    } else {
      setToast({ ok: false, msg: res.error || "Failed to assign voice." });
    }
    setAssigningKey(null);
  };

  const filtered = voices.filter((v) => {
    const q = search.trim().toLowerCase();
    const matchesSearch =
      !q ||
      v.name.toLowerCase().includes(q) ||
      (v.description || "").toLowerCase().includes(q) ||
      (v.accent || "").toLowerCase().includes(q) ||
      (v.useCase || "").toLowerCase().includes(q);
    const matchesGender = !genderFilter || (v.gender || "").toLowerCase() === genderFilter;
    const matchesCategory = !categoryFilter || (v.category || "").toLowerCase() === categoryFilter;
    return matchesSearch && matchesGender && matchesCategory;
  });

  const genders = Array.from(new Set(voices.map((v) => (v.gender || "").toLowerCase()).filter(Boolean))).sort();
  const categories = Array.from(new Set(voices.map((v) => (v.category || "").toLowerCase()).filter(Boolean))).sort();
  const voiceName = (id: string) => voices.find((v) => v.id === id)?.name;
  const activeHosts = hosts.filter((h) => h.isActive);

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      <div className="personalitiesHeader">
        <div className="titleGroup">
          <h2>ElevenLabs Voices</h2>
          <p>Preview any voice and assign it to a host with one click. Assigning sets that host&apos;s TTS engine to ElevenLabs.</p>
        </div>
      </div>

      {/* Current host assignments */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1rem", marginBottom: "1.5rem" }}>
        {hosts.map((h) => {
          const name = voiceName(h.ttsVoiceId);
          const usingEleven = h.ttsProvider.toLowerCase() === "elevenlabs";
          return (
            <div key={h.id} className="panel" style={{ padding: "1rem" }}>
              <div style={{ fontWeight: 700, marginBottom: "0.25rem" }}>{h.name}</div>
              <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                Engine: <strong style={{ color: usingEleven ? "var(--accent-color)" : "var(--text-primary)" }}>{h.ttsProvider}</strong>
              </div>
              <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}>
                Voice: <strong style={{ color: "var(--text-primary)" }}>{name || h.ttsVoiceId || "—"}</strong>
              </div>
            </div>
          );
        })}
      </div>

      {toast && (
        <div className={`alertCard ${toast.ok ? "alertSuccess" : "alertDanger"}`} style={{ marginBottom: "1rem" }}>
          {toast.msg}
        </div>
      )}

      {loading ? (
        <div style={{ color: "var(--text-secondary)" }}>Loading ElevenLabs voices…</div>
      ) : error ? (
        <div className="alertCard alertDanger">
          {error}
          <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
            Set <code>ELEVENLABS_API_KEY</code> in the environment to browse voices.
          </div>
        </div>
      ) : (
        <>
          {/* Filter bar */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "0.5rem", marginBottom: "0.5rem" }}>
            <input
              type="text"
              className="input"
              placeholder="🔍 Search by name, accent, use case…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="select"
              value={genderFilter}
              onChange={(e) => setGenderFilter(e.target.value)}
              style={{ padding: "0.5rem", borderRadius: "6px", border: "1px solid var(--border-color)", backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
            >
              <option value="">All genders</option>
              {genders.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
            <select
              className="select"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              style={{ padding: "0.5rem", borderRadius: "6px", border: "1px solid var(--border-color)", backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
            >
              <option value="">All types</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginBottom: "0.5rem" }}>
            {filtered.length} of {voices.length} voices
          </div>

          {/* Voice list */}
          <div style={{ border: "1px solid var(--border-color)", borderRadius: "8px", overflow: "hidden" }}>
            {filtered.length === 0 ? (
              <div style={{ padding: "1rem", color: "var(--text-secondary)" }}>No voices match these filters.</div>
            ) : (
              filtered.map((voice) => {
                const meta = [voice.gender, voice.accent, voice.age, voice.category, voice.useCase].filter(Boolean).join(" · ");
                const assignedHosts = activeHosts.filter((h) => h.ttsVoiceId === voice.id && h.ttsProvider.toLowerCase() === "elevenlabs");
                return (
                  <div
                    key={voice.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.75rem",
                      padding: "0.7rem 0.9rem",
                      borderBottom: "1px solid var(--border-color)",
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                      <div style={{ fontWeight: 600, display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        {voice.name}
                        {assignedHosts.map((h) => (
                          <span key={h.id} className="tag" style={{ backgroundColor: "var(--accent-color)", color: "#fff", fontSize: "0.65rem" }}>
                            ✓ {h.name}
                          </span>
                        ))}
                      </div>
                      {meta && <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>{meta}</div>}
                    </div>

                    {voice.preview_url && (
                      <button
                        type="button"
                        onClick={() => playPreview(voice.preview_url!, voice.id)}
                        className="editButton"
                        style={{
                          whiteSpace: "nowrap",
                          padding: "0.4rem 0.8rem",
                          borderRadius: "6px",
                          cursor: "pointer",
                          border: "1px solid var(--border-color)",
                          backgroundColor: playingVoiceId === voice.id ? "var(--warning-color)" : "var(--bg-primary)",
                          color: "var(--text-primary)",
                        }}
                      >
                        {playingVoiceId === voice.id ? "⏸ Stop" : "🔊 Preview"}
                      </button>
                    )}

                    {activeHosts.map((h) => {
                      const busy = assigningKey === `${h.id}:${voice.id}`;
                      const already = h.ttsVoiceId === voice.id && h.ttsProvider.toLowerCase() === "elevenlabs";
                      return (
                        <button
                          key={h.id}
                          type="button"
                          disabled={busy || already}
                          onClick={() => assign(h, voice)}
                          className="buttonPrimary"
                          style={{
                            whiteSpace: "nowrap",
                            padding: "0.4rem 0.8rem",
                            borderRadius: "6px",
                            fontSize: "0.8rem",
                            cursor: already ? "default" : "pointer",
                            opacity: already ? 0.5 : 1,
                          }}
                        >
                          {busy ? "Assigning…" : already ? `In use: ${h.name}` : `Use for ${h.name}`}
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
