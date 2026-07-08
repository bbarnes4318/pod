"use client";

// Advanced Producer — Episode-detail power-user layer (progressive disclosure).
//
// This is the SAME episode object, revealed under an "Advanced" toggle. Every
// control maps to a REAL pipeline input, verified against the generation code:
//   • Script re-gen  → regenerateEpisodeScript(id, _, {scriptStyle, maxWords,
//                       targetDurationMinutes}) → queueScriptGenerationJob →
//                       scriptService reads all three from the prompt.
//   • Re-mix         → mixEpisode(id, {productionStyle, sfxDensity}) →
//                       queueFinalAudioStitchJob (override > Episode.soundDesign
//                       > default) → audioStitchingService.
//   • Voices/sound   → shown as the APPLIED (persisted) producer settings.
// Controls with no backing input (fact-check strictness, pronunciation lexicon,
// per-episode sourcing filters) are honest read-only notes, never dead sliders.

import React, { useState } from "react";
import { regenerateEpisodeScript, mixEpisode } from "../app/create/actions";

const DENSITY_PRESETS = [
  { key: "tight", label: "Tight", words: 1600 },
  { key: "standard", label: "Standard", words: 2200 },
  { key: "meaty", label: "Meaty", words: 2800 },
] as const;
const STYLES = [
  { key: "heated-debate", label: "Heated debate" },
  { key: "balanced-analysis", label: "Analysis" },
  { key: "sports-radio", label: "Sports radio" },
] as const;
const PROD_LEVELS = [
  { key: "clean", label: "Clean" },
  { key: "light", label: "Light" },
  { key: "full", label: "Full" },
] as const;
const DENSITIES = [
  { key: "subtle", label: "Subtle" },
  { key: "medium", label: "Medium" },
  { key: "hype", label: "Hype" },
] as const;

export interface AppliedVoice { host: string; provider: string; voiceId: string }

export default function AdvancedProducer({
  episodeId,
  canRemix,
  appliedProvider,
  appliedVoices,
  appliedStyle,
  appliedDensity,
}: {
  episodeId: string;
  canRemix: boolean;
  appliedProvider: string | null;
  appliedVoices: AppliedVoice[];
  appliedStyle: string | null;
  appliedDensity: string | null;
}) {
  const [open, setOpen] = useState(false);

  // Script re-gen state
  const [scriptStyle, setScriptStyle] = useState<string>("");
  const [maxWords, setMaxWords] = useState<number | null>(null);
  // Re-mix state
  const [prodLevel, setProdLevel] = useState<string>(appliedStyle ?? "");
  const [density, setDensity] = useState<string>(appliedDensity ?? "");

  const [busy, setBusy] = useState<null | "script" | "mix">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (which: "script" | "mix", fn: () => Promise<any>, ok: string) => {
    setBusy(which); setMsg(null); setErr(null);
    try {
      const res: any = await fn();
      if (res?.success === false) setErr(res.error || "That didn't work.");
      else setMsg(ok);
    } catch (e: any) {
      setErr(e?.message || "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  const regen = () =>
    run(
      "script",
      () =>
        regenerateEpisodeScript(episodeId, undefined, {
          scriptStyle: (scriptStyle || undefined) as any,
          maxWords: maxWords ?? undefined,
        }),
      "Rewriting the script with your settings — watch the transcript update."
    );

  const remix = () =>
    run(
      "mix",
      () =>
        mixEpisode(episodeId, {
          productionStyle: (prodLevel || undefined) as any,
          sfxDensity: (density || undefined) as any,
        }),
      "Re-mixing with the new sound level — the player will refresh when it lands."
    );

  return (
    <div className="studioCard advCard">
      <div className="advCardHead">
        <div>
          <div className="sectionTitle" style={{ margin: 0 }}>Advanced producer</div>
          <div className="advCardSub">Per-stage control on this same episode — every knob drives real generation.</div>
        </div>
        <button
          type="button"
          className={`advToggle${open ? " on" : ""}`}
          onClick={() => setOpen(!open)}
          aria-pressed={open}
          aria-expanded={open}
        >
          <span className="advDot" /> Advanced
        </button>
      </div>

      {open && (
        <>
          {(msg || err) && (
            <div className={`gateResult ${err ? "gate-err" : "gate-ok"}`} style={{ marginBottom: "0.8rem" }}>
              {err || msg}
            </div>
          )}
          <div className="advWrap" style={{ borderTop: "none", paddingTop: 0, marginTop: 0 }}>
            {/* SCRIPT — real re-generation */}
            <section className="advPanel">
              <div className="advPanelHead">Script — regenerate</div>
              <div className="advField">
                <div className="fieldLabel">Format <span className="advParam">scriptStyle</span></div>
                <div className="segRow">
                  {STYLES.map((s) => (
                    <button key={s.key} type="button" className={`segBtn${scriptStyle === s.key ? " on" : ""}`} onClick={() => setScriptStyle(s.key)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="advField">
                <div className="fieldLabel">Density <span className="advParam">maxWords</span></div>
                <div className="segRow">
                  {DENSITY_PRESETS.map((d) => (
                    <button key={d.key} type="button" className={`segBtn${maxWords === d.words ? " on" : ""}`} onClick={() => setMaxWords(d.words)}>
                      {d.label}
                    </button>
                  ))}
                  <button type="button" className={`segBtn${maxWords === null ? " on" : ""}`} onClick={() => setMaxWords(null)}>Auto</button>
                </div>
              </div>
              <button type="button" className="btnPrimary" style={{ width: "100%", marginTop: "0.4rem" }} onClick={regen} disabled={busy === "script"}>
                {busy === "script" ? "Rewriting…" : "Regenerate script"}
              </button>
              <p className="advNote">Runs the real script job. The fact-check gate re-runs on approval — a rewrite never bypasses it.</p>
            </section>

            {/* SOUND — real re-mix */}
            <section className="advPanel">
              <div className="advPanelHead">Sound — re-mix</div>
              <div className="advField">
                <div className="fieldLabel">Level <span className="advParam">productionStyle</span></div>
                <div className="segRow">
                  {PROD_LEVELS.map((p) => (
                    <button key={p.key} type="button" className={`segBtn${prodLevel === p.key ? " on" : ""}`} onClick={() => setProdLevel(p.key)}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="advField">
                <div className="fieldLabel">Density <span className="advParam">sfxDensity</span></div>
                <div className="segRow">
                  {DENSITIES.map((d) => (
                    <button key={d.key} type="button" className={`segBtn${density === d.key ? " on" : ""}`} onClick={() => setDensity(d.key)}>
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
              <button type="button" className="btnPrimary" style={{ width: "100%", marginTop: "0.4rem" }} onClick={remix} disabled={busy === "mix" || !canRemix}>
                {busy === "mix" ? "Re-mixing…" : "Re-mix audio"}
              </button>
              <p className="advNote">
                {canRemix
                  ? "Re-splices the existing voiced lines at the chosen level — no re-synthesis."
                  : "Available once the episode's lines are voiced."}
              </p>
            </section>

            {/* VOICES — applied (persisted) settings */}
            <section className="advPanel">
              <div className="advPanelHead">Voices — applied</div>
              <div className="advField">
                <div className="fieldLabel">Engine <span className="advParam">ttsProvider</span></div>
                <div className="advApplied">{appliedProvider || "host / env default"}</div>
              </div>
              {appliedVoices.length > 0 && (
                <div className="advField">
                  <div className="fieldLabel">Per-host voice <span className="advParam">ttsVoiceOverrides</span></div>
                  {appliedVoices.map((v) => (
                    <div key={v.host} className="advVoiceRow">
                      <span className="advVoiceHost">{v.host}</span>
                      <span className="advApplied" style={{ flex: 1 }}>{v.provider}: {v.voiceId}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="advNote">Set at build time. To change a voice, re-voice a line in the Mix step (per-line TTS). No pronunciation-lexicon input exists in the TTS path.</p>
            </section>

            {/* FACT-CHECK — honest read-only */}
            <section className="advPanel">
              <div className="advPanelHead">Fact-check</div>
              <div className="advLockRow">
                <span className="advLock">🔒 On</span>
                <span>Block publish on unresolved claims</span>
              </div>
              <p className="advNote">Always-on hard gate; cannot be weakened. The fact-check service is deterministic — there is no strictness-level input to expose.</p>
            </section>

            {/* SOURCING — honest note */}
            <section className="advPanel advPanelWide">
              <div className="advPanelHead">Sourcing</div>
              <p className="advNote">
                Vertical / league / debate-score / team filters (<span className="advParam">verticals</span>, <span className="advParam">leagueIds</span>, <span className="advParam">minDebateScore</span>, <span className="advParam">teamNames</span>) steer topic auto-selection at create time — they don&apos;t re-source a finished episode. No recency-window, betting-intensity threshold, or source allow/deny input exists in the pipeline.
              </p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
