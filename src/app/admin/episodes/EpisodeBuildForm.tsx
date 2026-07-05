"use client";

import React, { useState, useEffect } from "react";
import { triggerEpisodeBuild, createEpisodeFromSelectedTopics, fetchEligibleTopics, fetchActiveDebateHosts } from "./actions";
import TtsVoicePicker, { PickerHost, VoicePicks, buildVoiceOverrides } from "../components/TtsVoicePicker";
import { TTS_PROVIDER_LABELS } from "@/lib/providers/tts/providerIds";

interface EligibleTopic {
  id: string;
  title: string;
  sport: string;
  leagueId: string | null;
  debateScore: number;
  evidenceCount: number;
}

interface FormProps {
  onBuildSuccess: () => void;
  isLlmStub: boolean;
}

export default function EpisodeBuildForm({ onBuildSuccess, isLlmStub }: FormProps) {
  const [buildMode, setBuildMode] = useState<"auto" | "manual">("auto");

  // Filters for both auto and manual loading
  const [leagueId, setLeagueId] = useState("");
  const [sport, setSport] = useState("");
  const [minDebateScore, setMinDebateScore] = useState(70);
  const [targetTopicCount, setTargetTopicCount] = useState(3);

  // Manual inputs
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedTopicIds, setSelectedTopicIds] = useState<string[]>([]);

  // Voice engine + per-host voice picks pinned on the episode at build time.
  // "default" = studio default (host-profile/env chain, no episode pin).
  const [ttsEngine, setTtsEngine] = useState("default");
  const [voicePicks, setVoicePicks] = useState<VoicePicks>({});
  const [voiceHosts, setVoiceHosts] = useState<PickerHost[]>([
    { slug: "max-voltage", name: "Max Voltage" },
    { slug: "dr-linebreak", name: "Dr. Linebreak" },
  ]);

  useEffect(() => {
    fetchActiveDebateHosts().then((res) => {
      if (res.success && res.hosts && res.hosts.length > 0) {
        setVoiceHosts(res.hosts.map((h) => ({ slug: h.slug, name: h.name })));
      }
    });
  }, []);

  // Reset picks when the engine changes — voice ids don't cross engines.
  const [picksEngine, setPicksEngine] = useState(ttsEngine);
  if (picksEngine !== ttsEngine) {
    setPicksEngine(ttsEngine);
    setVoicePicks({});
  }

  const voiceSelection = () => {
    if (ttsEngine === "default") return { ttsProvider: undefined, ttsVoiceOverrides: undefined };
    return {
      ttsProvider: ttsEngine,
      ttsVoiceOverrides: buildVoiceOverrides(ttsEngine, voicePicks),
    };
  };

  const [eligibleTopics, setEligibleTopics] = useState<EligibleTopic[]>([]);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Fetch eligible topics whenever filters change to populate manual builder
  const loadEligibleTopics = async () => {
    setLoadingTopics(true);
    const res = await fetchEligibleTopics({
      leagueId: leagueId || undefined,
      sport: sport || undefined,
      minDebateScore,
    });
    if (res.success && res.topics) {
      setEligibleTopics(res.topics);
    } else {
      setEligibleTopics([]);
    }
    setLoadingTopics(false);
  };

  useEffect(() => {
    loadEligibleTopics();
    setSelectedTopicIds([]);
  }, [leagueId, sport, minDebateScore]);

  const handleToggleTopic = (topicId: string) => {
    setSelectedTopicIds((prev) => {
      if (prev.includes(topicId)) {
        return prev.filter((id) => id !== topicId);
      } else {
        return [...prev, topicId];
      }
    });
  };

  const handleAutoBuildSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);

    const res = await triggerEpisodeBuild({
      leagueId: leagueId || undefined,
      sport: sport || undefined,
      minDebateScore,
      targetTopicCount,
      title: title || undefined,
      description: description || undefined,
      ...voiceSelection(),
    });

    if (res.success) {
      setMessage({
        type: "success",
        text: `Episode build job queued! Job ID: ${res.jobId}. Reloading list...`,
      });
      setTimeout(() => {
        onBuildSuccess();
        setTitle("");
        setDescription("");
        setMessage(null);
      }, 1500);
    } else {
      setMessage({
        type: "error",
        text: res.error || "Failed to queue build job.",
      });
    }
    setSubmitting(false);
  };

  const handleManualBuildSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedTopicIds.length === 0) {
      setMessage({ type: "error", text: "Select at least 1 topic candidate." });
      return;
    }

    setSubmitting(true);
    setMessage(null);

    const { ttsProvider, ttsVoiceOverrides } = voiceSelection();
    const res = await createEpisodeFromSelectedTopics(
      selectedTopicIds,
      title || undefined,
      description || undefined,
      ttsProvider,
      ttsVoiceOverrides
    );

    if (res.success) {
      setMessage({
        type: "success",
        text: `Draft episode created directly! Episode ID: ${res.episodeId}.`,
      });
      setTimeout(() => {
        onBuildSuccess();
        setSelectedTopicIds([]);
        setTitle("");
        setDescription("");
        setMessage(null);
      }, 1500);
    } else {
      setMessage({
        type: "error",
        text: res.error || "Failed to build draft episode.",
      });
    }
    setSubmitting(false);
  };

  return (
    <div className="builderPanel">
      <div className="builderTitle">Assemble Episode</div>

      {/* Build Mode Selector tabs */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem" }}>
        <button
          onClick={() => {
            setBuildMode("auto");
            setMessage(null);
          }}
          className={buildMode === "auto" ? "buttonPrimary" : "btnReset"}
          style={{ flexGrow: 1, padding: "0.5rem" }}
        >
          Auto-Build
        </button>
        <button
          onClick={() => {
            setBuildMode("manual");
            setMessage(null);
          }}
          className={buildMode === "manual" ? "buttonPrimary" : "btnReset"}
          style={{ flexGrow: 1, padding: "0.5rem" }}
        >
          Manual Selection
        </button>
      </div>

      {/* Common Filters Section */}
      <div className="sectionGroup">
        <span className="sectionGroupLabel">Eligible Topic Filters</span>
        <div className="formGrid">
          <div className="formGroup" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="leagueFilter">League</label>
            <select
              id="leagueFilter"
              className="select"
              value={leagueId}
              onChange={(e) => setLeagueId(e.target.value)}
              disabled={submitting}
            >
              <option value="">All Leagues</option>
              <option value="NFL">NFL</option>
              <option value="NBA">NBA</option>
              <option value="MLB">MLB</option>
              <option value="NCAAF">NCAAF</option>
              <option value="NCAAB">NCAAB</option>
              <option value="MMA">MMA</option>
            </select>
          </div>

          <div className="formGroup" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="sportFilter">Sport Name</label>
            <input
              id="sportFilter"
              type="text"
              className="input"
              value={sport}
              onChange={(e) => setSport(e.target.value)}
              placeholder="e.g. Football"
              disabled={submitting}
            />
          </div>
        </div>

        <div className="formGroup">
          <label className="label" htmlFor="minScoreFilter">Minimum Debate Score ({minDebateScore})</label>
          <input
            id="minScoreFilter"
            type="range"
            min="1"
            max="100"
            style={{ accentColor: "var(--accent-color)" }}
            className="rangeInput"
            value={minDebateScore}
            onChange={(e) => setMinDebateScore(Number(e.target.value))}
            disabled={submitting}
          />
        </div>
      </div>

      {/* Inputs (Title & Description) */}
      <div className="sectionGroup">
        <span className="sectionGroupLabel">Episode Meta (Optional)</span>
        <div className="formGroup">
          <label className="label" htmlFor="epTitle">Episode Title</label>
          <input
            id="epTitle"
            type="text"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Defaults to: Take Machine — [Tag] Debate Briefing — Date"
            disabled={submitting}
          />
        </div>

        <div className="formGroup">
          <label className="label" htmlFor="epDesc">Internal Description</label>
          <textarea
            id="epDesc"
            className="textarea"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Defaults to plain draft description"
            disabled={submitting}
          />
        </div>
      </div>

      {/* Voice Engine & per-host Voice IDs (pinned on the episode) */}
      <div className="sectionGroup">
        <span className="sectionGroupLabel">Voice Engine &amp; Voices</span>
        <div className="formGroup">
          <label className="label" htmlFor="ttsEngine">Voice Engine</label>
          <select
            id="ttsEngine"
            className="select"
            value={ttsEngine}
            onChange={(e) => setTtsEngine(e.target.value)}
            disabled={submitting}
          >
            <option value="default">Studio default (host profiles / env)</option>
            <option value="elevenlabs">{TTS_PROVIDER_LABELS.elevenlabs}</option>
            <option value="cartesia">{TTS_PROVIDER_LABELS.cartesia}</option>
            <option value="boson">{TTS_PROVIDER_LABELS.boson}</option>
            <option value="fish">{TTS_PROVIDER_LABELS.fish}</option>
            <option value="openai">{TTS_PROVIDER_LABELS.openai}</option>
          </select>
        </div>
        {ttsEngine !== "default" && (
          <TtsVoicePicker
            provider={ttsEngine}
            hosts={voiceHosts}
            value={voicePicks}
            onChange={setVoicePicks}
            disabled={submitting}
          />
        )}
      </div>

      {/* Auto Mode Inputs */}
      {buildMode === "auto" && (
        <form onSubmit={handleAutoBuildSubmit}>
          <div className="formGroup">
            <label className="label" htmlFor="targetCount">Target Topic Count ({targetTopicCount})</label>
            <input
              id="targetCount"
              type="number"
              min="1"
              max="10"
              className="input"
              value={targetTopicCount}
              onChange={(e) => setTargetTopicCount(Number(e.target.value))}
              disabled={submitting}
              required
            />
          </div>

          <button
            type="submit"
            className="buttonPrimary"
            style={{ width: "100%" }}
            disabled={submitting}
          >
            {submitting ? "Queueing Build Job..." : "Auto-Build Episode"}
          </button>
        </form>
      )}

      {/* Manual Mode Inputs */}
      {buildMode === "manual" && (
        <form onSubmit={handleManualBuildSubmit}>
          <div className="sectionGroup">
            <span className="sectionGroupLabel">Select Topics In Order ({selectedTopicIds.length})</span>
            {loadingTopics ? (
              <div style={{ color: "var(--text-secondary)", padding: "1rem", fontSize: "0.8rem" }}>Loading eligible topics...</div>
            ) : eligibleTopics.length === 0 ? (
              <div style={{ color: "var(--text-secondary)", padding: "1rem", fontSize: "0.8rem", fontStyle: "italic" }}>
                No eligible brief-ready topics match current filters.
              </div>
            ) : (
              <div className="topicSelectionBox">
                {eligibleTopics.map((topic) => {
                  const selectIndex = selectedTopicIds.indexOf(topic.id);
                  const isChecked = selectIndex !== -1;

                  return (
                    <div
                      key={topic.id}
                      onClick={() => handleToggleTopic(topic.id)}
                      className={`topicSelectRow ${isChecked ? "topicSelectRowChecked" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {}} // Handled by row click
                        style={{ cursor: "pointer" }}
                      />
                      <span style={{ fontWeight: 600 }}>{topic.title}</span>

                      {isChecked && (
                        <span className="orderIndicator">{selectIndex + 1}</span>
                      )}

                      <span className="topicRowMeta">
                        {topic.leagueId || topic.sport} • {Math.round(topic.debateScore)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <button
            type="submit"
            className="buttonPrimary"
            style={{ width: "100%" }}
            disabled={submitting || selectedTopicIds.length === 0}
          >
            {submitting ? "Creating Episode..." : "Build Selected Episode"}
          </button>
        </form>
      )}

      {message && (
        <div
          className={`alertCard ${message.type === "success" ? "alertSuccess" : "alertDanger"}`}
          style={{ marginTop: "1.25rem", marginBottom: 0 }}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
