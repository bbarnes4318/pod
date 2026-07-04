"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { createHost, updateHost, getCartesiaVoices, getElevenLabsVoices } from "./actions";

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

interface HostFormProps {
  initialData?: {
    id: string;
    name: string;
    slug: string;
    role: string;
    worldview: string;
    speakingStyle: string;
    catchphrases: any;
    likes: any;
    dislikes: any;
    argumentPatterns: any;
    bannedPhrases: any;
    ttsProvider: string;
    ttsVoiceId: string;
    intensityLevel: number;
    isActive: boolean;
  };
}

export default function HostForm({ initialData }: HostFormProps) {
  const router = useRouter();
  const isEdit = !!initialData;

  const joinArray = (val: any): string => {
    if (Array.isArray(val)) return val.join("\n");
    return "";
  };

  const [name, setName] = useState(initialData?.name || "");
  const [slug, setSlug] = useState(initialData?.slug || "");
  const [role, setRole] = useState(initialData?.role || "");
  const [worldview, setWorldview] = useState(initialData?.worldview || "");
  const [speakingStyle, setSpeakingStyle] = useState(initialData?.speakingStyle || "");
  
  // Newline separated string states
  const [catchphrasesRaw, setCatchphrasesRaw] = useState(joinArray(initialData?.catchphrases));
  const [likesRaw, setLikesRaw] = useState(joinArray(initialData?.likes));
  const [dislikesRaw, setDislikesRaw] = useState(joinArray(initialData?.dislikes));
  const [argumentPatternsRaw, setArgumentPatternsRaw] = useState(joinArray(initialData?.argumentPatterns));
  const [bannedPhrasesRaw, setBannedPhrasesRaw] = useState(joinArray(initialData?.bannedPhrases));

  const [ttsProvider, setTtsProvider] = useState(initialData?.ttsProvider || "stub");
  const [ttsVoiceId, setTtsVoiceId] = useState(initialData?.ttsVoiceId || "stub-voice-id");
  const [intensityLevel, setIntensityLevel] = useState(initialData?.intensityLevel || 5);
  const [isActive, setIsActive] = useState(initialData ? initialData.isActive : true);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cartesiaVoices, setCartesiaVoices] = useState<any[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [audioPreview, setAudioPreview] = useState<HTMLAudioElement | null>(null);

  // ElevenLabs voice browser state
  const [elevenVoices, setElevenVoices] = useState<VoiceOption[]>([]);
  const [loadingEleven, setLoadingEleven] = useState(false);
  const [elevenError, setElevenError] = useState<string | null>(null);
  const [voiceSearch, setVoiceSearch] = useState("");
  const [genderFilter, setGenderFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");

  React.useEffect(() => {
    if (ttsProvider.toLowerCase() === "cartesia" && cartesiaVoices.length === 0) {
      setLoadingVoices(true);
      getCartesiaVoices().then((res) => {
        if (res.success && res.voices) {
          setCartesiaVoices(res.voices);
        }
        setLoadingVoices(false);
      });
    }
  }, [ttsProvider, cartesiaVoices.length]);

  React.useEffect(() => {
    if (ttsProvider.toLowerCase() === "elevenlabs" && elevenVoices.length === 0 && !loadingEleven) {
      setLoadingEleven(true);
      setElevenError(null);
      getElevenLabsVoices().then((res) => {
        if (res.success && res.voices) {
          setElevenVoices(res.voices as VoiceOption[]);
        } else {
          setElevenError(res.error || "Failed to load ElevenLabs voices.");
        }
        setLoadingEleven(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsProvider]);

  const handlePlayPreview = (previewUrl: string, voiceId: string) => {
    if (audioPreview) {
      audioPreview.pause();
    }

    if (playingVoiceId === voiceId) {
      setPlayingVoiceId(null);
      setAudioPreview(null);
      return;
    }

    const audio = new Audio(previewUrl);
    audio.play();
    setPlayingVoiceId(voiceId);
    setAudioPreview(audio);

    audio.onended = () => {
      setPlayingVoiceId(null);
      setAudioPreview(null);
    };
  };

  // Auto-generate slug from name if not editing
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setName(val);
    if (!isEdit) {
      const generatedSlug = val
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "") // Remove special chars
        .replace(/\s+/g, "-") // Replace spaces with hyphens
        .replace(/-+/g, "-"); // Remove double hyphens
      setSlug(generatedSlug);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const formData = {
      name,
      slug,
      role,
      worldview,
      speakingStyle,
      catchphrasesRaw,
      likesRaw,
      dislikesRaw,
      argumentPatternsRaw,
      bannedPhrasesRaw,
      ttsProvider,
      ttsVoiceId,
      intensityLevel: Number(intensityLevel),
      isActive,
    };

    const res = isEdit
      ? await updateHost(initialData.id, formData)
      : await createHost(formData);

    if (res.success) {
      router.push("/admin/personalities");
      router.refresh();
    } else {
      setError(res.error || "An error occurred while saving the profile.");
      setLoading(false);
    }
  };

  const filteredEleven = elevenVoices.filter((v) => {
    const q = voiceSearch.trim().toLowerCase();
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
  const elevenGenders = Array.from(
    new Set(elevenVoices.map((v) => (v.gender || "").toLowerCase()).filter(Boolean))
  ).sort();
  const elevenCategories = Array.from(
    new Set(elevenVoices.map((v) => (v.category || "").toLowerCase()).filter(Boolean))
  ).sort();
  const selectedEleven = elevenVoices.find((v) => v.id === ttsVoiceId);

  return (
    <div className="panel" style={{ maxWidth: "800px", margin: "0 auto" }}>
      <div className="panelHeader">
        <h3 className="panelTitle">{isEdit ? `Edit Host: ${initialData.name}` : "Create New AI Host Personality"}</h3>
      </div>
      <div className="panelContent">
        {error && (
          <div className="alertCard alertDanger" style={{ marginBottom: "1.5rem" }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="formGrid">
            {/* Name */}
            <div className="formGroup">
              <label className="label" htmlFor="name">Name</label>
              <input
                type="text"
                id="name"
                className="input"
                placeholder="e.g. Max Voltage"
                value={name}
                onChange={handleNameChange}
                disabled={loading}
                required
              />
            </div>

            {/* Slug */}
            <div className="formGroup">
              <label className="label" htmlFor="slug">Slug</label>
              <input
                type="text"
                id="slug"
                className="input"
                placeholder="e.g. max-voltage"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                disabled={loading}
                required
              />
              <span className="helperText">Unique identifier used for files and routing. Only lowercase, numbers, and dashes.</span>
            </div>

            {/* Role */}
            <div className="formGroup formSpanTwo">
              <label className="label" htmlFor="role">Role Summary</label>
              <input
                type="text"
                id="role"
                className="input"
                placeholder="e.g. Loud legacy-driven debate host"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                disabled={loading}
                required
              />
            </div>

            {/* Worldview */}
            <div className="formGroup formSpanTwo">
              <label className="label" htmlFor="worldview">Worldview / Core Philosophy</label>
              <textarea
                id="worldview"
                className="textarea"
                placeholder="Describe what values this host fights for, what metrics they support or hate..."
                value={worldview}
                onChange={(e) => setWorldview(e.target.value)}
                disabled={loading}
                required
              />
            </div>

            {/* Speaking Style */}
            <div className="formGroup formSpanTwo">
              <label className="label" htmlFor="speakingStyle">Speaking & Debate Style</label>
              <textarea
                id="speakingStyle"
                className="textarea"
                style={{ minHeight: "80px" }}
                placeholder="Loud and emotional? Condescending and methodical? How do they construct arguments?"
                value={speakingStyle}
                onChange={(e) => setSpeakingStyle(e.target.value)}
                disabled={loading}
                required
              />
            </div>

            {/* Catchphrases */}
            <div className="formGroup">
              <label className="label" htmlFor="catchphrases">Catchphrases</label>
              <textarea
                id="catchphrases"
                className="textarea"
                placeholder="Rings talk!&#10;spreadsheet managers!&#10;Check the legacy!"
                value={catchphrasesRaw}
                onChange={(e) => setCatchphrasesRaw(e.target.value)}
                disabled={loading}
              />
              <span className="helperText">One catchphrase per line.</span>
            </div>

            {/* Banned Phrases */}
            <div className="formGroup">
              <label className="label" htmlFor="bannedPhrases">Banned Phrases</label>
              <textarea
                id="bannedPhrases"
                className="textarea"
                placeholder="according to my regression model&#10;Championship DNA"
                value={bannedPhrasesRaw}
                onChange={(e) => setBannedPhrasesRaw(e.target.value)}
                disabled={loading}
              />
              <span className="helperText">One phrase per line. What this host will never say.</span>
            </div>

            {/* Likes */}
            <div className="formGroup">
              <label className="label" htmlFor="likes">Loves/Likes Topics</label>
              <textarea
                id="likes"
                className="textarea"
                placeholder="High stakes&#10;Playoff pressure&#10;Fighter grit"
                value={likesRaw}
                onChange={(e) => setLikesRaw(e.target.value)}
                disabled={loading}
              />
              <span className="helperText">One topic per line.</span>
            </div>

            {/* Dislikes */}
            <div className="formGroup">
              <label className="label" htmlFor="dislikes">Hates/Dislikes Topics</label>
              <textarea
                id="dislikes"
                className="textarea"
                placeholder="Spreadsheets&#10;Expected efficiency&#10;Box-score scouting"
                value={dislikesRaw}
                onChange={(e) => setDislikesRaw(e.target.value)}
                disabled={loading}
              />
              <span className="helperText">One topic per line.</span>
            </div>

            {/* Argument Patterns */}
            <div className="formGroup formSpanTwo">
              <label className="label" htmlFor="argumentPatterns">Argument Patterns</label>
              <textarea
                id="argumentPatterns"
                className="textarea"
                placeholder="Compare ring counts between players&#10;Patronize emotional arguments as mathematically illiterate&#10;Highlight shot-quality or net efficiency data"
                value={argumentPatternsRaw}
                onChange={(e) => setArgumentPatternsRaw(e.target.value)}
                disabled={loading}
              />
              <span className="helperText">One pattern per line. Describes how they structure their logic.</span>
            </div>

            {/* TTS Provider */}
            <div className="formGroup">
              <label className="label" htmlFor="ttsProvider">TTS Provider</label>
              <select
                id="ttsProvider"
                className="select"
                value={ttsProvider}
                onChange={(e) => setTtsProvider(e.target.value)}
                disabled={loading}
                required
                style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", border: "1px solid var(--border-color)", backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
              >
                <option value="stub">stub</option>
                <option value="boson">boson</option>
                <option value="cartesia">cartesia</option>
                <option value="elevenlabs">elevenlabs</option>
                <option value="openai">openai</option>
              </select>
            </div>

            {/* TTS Voice ID */}
            <div className="formGroup" style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <label className="label" htmlFor="ttsVoiceId">TTS Voice ID</label>
              {ttsProvider.toLowerCase() === "cartesia" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {loadingVoices ? (
                    <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Loading Cartesia voices...</div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "0.5rem", alignItems: "center" }}>
                      <select
                        id="ttsVoiceId"
                        className="select"
                        value={ttsVoiceId}
                        onChange={(e) => setTtsVoiceId(e.target.value)}
                        disabled={loading}
                        required
                        style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", border: "1px solid var(--border-color)", backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
                      >
                        <option value="">-- Select Cartesia Voice --</option>
                        {cartesiaVoices.map((voice) => (
                          <option key={voice.id} value={voice.id}>
                            {voice.name} ({voice.gender || "neutral"}, {voice.language || "en"})
                          </option>
                        ))}
                      </select>
                      
                      {(() => {
                        const selectedVoice = cartesiaVoices.find((v) => v.id === ttsVoiceId);
                        if (selectedVoice?.preview_url) {
                          return (
                            <button
                              type="button"
                              onClick={() => handlePlayPreview(selectedVoice.preview_url, selectedVoice.id)}
                              className="editButton"
                              style={{ whiteSpace: "nowrap", padding: "0.5rem 1rem", backgroundColor: playingVoiceId === selectedVoice.id ? "var(--warning-color)" : "var(--accent-color)", color: "#fff", borderColor: "transparent", borderRadius: "6px", cursor: "pointer" }}
                            >
                              {playingVoiceId === selectedVoice.id ? "⏸ Pause" : "🔊 Preview"}
                            </button>
                          );
                        }
                        return null;
                      })()}
                    </div>
                  )}
                </div>
              ) : ttsProvider.toLowerCase() === "elevenlabs" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                  {loadingEleven ? (
                    <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Loading ElevenLabs voices…</div>
                  ) : elevenError ? (
                    <>
                      <div className="alertCard alertDanger" style={{ fontSize: "0.8rem" }}>
                        {elevenError}
                      </div>
                      {/* Fallback: still allow pasting a voice ID manually */}
                      <input
                        type="text"
                        id="ttsVoiceId"
                        className="input"
                        placeholder="Paste an ElevenLabs voice ID"
                        value={ttsVoiceId}
                        onChange={(e) => setTtsVoiceId(e.target.value)}
                        disabled={loading}
                        required
                      />
                    </>
                  ) : (
                    <>
                      {/* Filter bar */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "0.5rem" }}>
                        <input
                          type="text"
                          className="input"
                          placeholder="🔍 Search by name, accent, use case…"
                          value={voiceSearch}
                          onChange={(e) => setVoiceSearch(e.target.value)}
                          disabled={loading}
                        />
                        <select
                          className="select"
                          value={genderFilter}
                          onChange={(e) => setGenderFilter(e.target.value)}
                          disabled={loading}
                          style={{ padding: "0.5rem", borderRadius: "6px", border: "1px solid var(--border-color)", backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
                        >
                          <option value="">All genders</option>
                          {elevenGenders.map((g) => (
                            <option key={g} value={g}>{g}</option>
                          ))}
                        </select>
                        <select
                          className="select"
                          value={categoryFilter}
                          onChange={(e) => setCategoryFilter(e.target.value)}
                          disabled={loading}
                          style={{ padding: "0.5rem", borderRadius: "6px", border: "1px solid var(--border-color)", backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
                        >
                          <option value="">All types</option>
                          {elevenCategories.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>

                      <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                        {filteredEleven.length} of {elevenVoices.length} voices
                        {selectedEleven ? ` · selected: ${selectedEleven.name}` : " · none selected"}
                      </div>

                      {/* Scrollable voice list */}
                      <div style={{ maxHeight: "320px", overflowY: "auto", border: "1px solid var(--border-color)", borderRadius: "8px" }}>
                        {filteredEleven.length === 0 ? (
                          <div style={{ padding: "1rem", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                            No voices match these filters.
                          </div>
                        ) : (
                          filteredEleven.map((voice) => {
                            const isSelected = voice.id === ttsVoiceId;
                            const meta = [voice.gender, voice.accent, voice.age, voice.category, voice.useCase]
                              .filter(Boolean)
                              .join(" · ");
                            return (
                              <div
                                key={voice.id}
                                onClick={() => !loading && setTtsVoiceId(voice.id)}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: "0.75rem",
                                  padding: "0.6rem 0.75rem",
                                  cursor: loading ? "default" : "pointer",
                                  borderBottom: "1px solid var(--border-color)",
                                  backgroundColor: isSelected ? "var(--accent-color)" : "transparent",
                                  color: isSelected ? "#fff" : "var(--text-primary)",
                                }}
                              >
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontWeight: 600, fontSize: "0.9rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                                    {isSelected ? "✓ " : ""}{voice.name}
                                  </div>
                                  {meta && (
                                    <div style={{ fontSize: "0.72rem", opacity: 0.8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                      {meta}
                                    </div>
                                  )}
                                </div>
                                {voice.preview_url && (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); handlePlayPreview(voice.preview_url!, voice.id); }}
                                    style={{
                                      whiteSpace: "nowrap",
                                      padding: "0.35rem 0.7rem",
                                      borderRadius: "6px",
                                      border: "1px solid transparent",
                                      cursor: "pointer",
                                      fontSize: "0.8rem",
                                      backgroundColor: playingVoiceId === voice.id ? "var(--warning-color)" : (isSelected ? "rgba(255,255,255,0.25)" : "var(--bg-primary)"),
                                      color: isSelected ? "#fff" : "var(--text-primary)",
                                    }}
                                  >
                                    {playingVoiceId === voice.id ? "⏸ Stop" : "🔊 Preview"}
                                  </button>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                      {!ttsVoiceId && (
                        <span className="helperText" style={{ color: "var(--warning-color)" }}>
                          Select a voice above to assign it to this host.
                        </span>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <input
                  type="text"
                  id="ttsVoiceId"
                  className="input"
                  placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
                  value={ttsVoiceId}
                  onChange={(e) => setTtsVoiceId(e.target.value)}
                  disabled={loading}
                  required
                />
              )}
            </div>

            {/* Intensity Level Slider */}
            <div className="formGroup formSpanTwo">
              <label className="label">Intensity Level ({intensityLevel})</label>
              <div className="intensityContainer">
                <input
                  type="range"
                  min="1"
                  max="10"
                  className="rangeInput"
                  style={{ accentColor: "var(--accent-color)" }}
                  value={intensityLevel}
                  onChange={(e) => setIntensityLevel(Number(e.target.value))}
                  disabled={loading}
                />
                <span className="intensityValue">{intensityLevel}</span>
              </div>
              <span className="helperText">From 1 (calm, analytical) to 10 (screaming, hyper-emotional).</span>
            </div>

            {/* Active Switch Toggle */}
            <div className="formGroup formSpanTwo" style={{ marginTop: "0.5rem" }}>
              <label className="switchContainer">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  disabled={loading}
                  style={{
                    width: "36px",
                    height: "18px",
                    accentColor: "var(--accent-color)",
                    cursor: "pointer",
                  }}
                />
                <span className="switchLabel">Active Personality</span>
              </label>
              <span className="helperText" style={{ marginLeft: "2.75rem", marginTop: "-0.25rem" }}>
                Inactive hosts will be excluded from script generation. We do not delete host records to protect history.
              </span>
            </div>
          </div>

          {/* Form Actions */}
          <div className="formActions">
            <button
              type="button"
              className="buttonSecondary"
              onClick={() => router.push("/admin/personalities")}
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="buttonPrimary"
              disabled={loading}
            >
              {loading ? "Saving..." : isEdit ? "Update Profile" : "Create Host"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
