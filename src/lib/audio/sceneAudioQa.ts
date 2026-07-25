// Scene-aware audio QA.
//
// HONEST LABELS ONLY. These checks are:
//   - technical QA          (empty/truncated/duplicate payload signals)
//   - transcript-fidelity QA (only when an external transcription service is
//                             configured — otherwise reported as not_run,
//                             NEVER as passed)
//   - timing QA             (timing-map presence/shape)
//   - identity-consistency indicators (voice-map/provider/model consistency)
// None of them measure "human-ness" — that judgment belongs to human listening
// (the audition harness exists for exactly that).
//
// Pure: rows in, report out. No DB, no ffmpeg, no network.

export type SceneQaStatus = "pass" | "warning" | "fail" | "not_run";

export interface SceneQaCheck {
  name: string;
  kind: "technical" | "transcript_fidelity" | "timing" | "identity_consistency";
  status: SceneQaStatus;
  value: string;
  detail: string;
}

export interface SceneRowForQa {
  sceneIndex: number;
  status: string;
  selected: boolean;
  renderUnit: string;
  provider: string;
  model: string;
  requestFingerprint: string;
  lineIndexes: number[];
  durationMs: number | null;
  audioUrl: string | null;
  timingStatus: string;
  voiceMap: Record<string, string>;
  characterCount?: number;
}

export interface SceneQaReport {
  passed: boolean;
  checks: SceneQaCheck[];
}

// Speech averages roughly 12-18 chars/sec; these WIDE bounds only catch
// catastrophic truncation or runaway output, not delivery style.
const MIN_MS_PER_CHAR = 20;  // faster than any real read → suspicious
const MAX_MS_PER_CHAR = 350; // slower than any real read → suspicious

export function analyzeSceneAudioRows(opts: {
  scenes: SceneRowForQa[];
  /** Every approved line index the plan covers, in order. */
  expectedLineIndexes: number[];
  /** The single provider the episode's cast resolved to. */
  expectedProvider?: string;
  /** Do downstream consumers (social clips) need timing maps? */
  timingRequired?: boolean;
  transcriptQaEnabled?: boolean;
}): SceneQaReport {
  const { scenes, expectedLineIndexes } = opts;
  const checks: SceneQaCheck[] = [];
  const push = (c: SceneQaCheck) => checks.push(c);

  // --- technical: coverage (no dropped/duplicated lines across scenes) ---
  const covered = scenes.flatMap((s) => s.lineIndexes);
  const coveredSet = new Set(covered);
  const missing = expectedLineIndexes.filter((i) => !coveredSet.has(i));
  const dup = covered.length !== coveredSet.size;
  push({
    name: "Scene coverage of approved lines",
    kind: "technical",
    status: missing.length === 0 && !dup ? "pass" : "fail",
    value: `${covered.length}/${expectedLineIndexes.length} lines${dup ? " (duplicates!)" : ""}${missing.length ? `, missing ${missing.slice(0, 5).join(",")}` : ""}`,
    detail: "Every approved line must be performed exactly once across the selected scenes.",
  });

  // --- technical: empty / unready audio ---
  const unready = scenes.filter((s) => s.status !== "ready" || !s.audioUrl);
  push({
    name: "All selected scenes have audio",
    kind: "technical",
    status: unready.length === 0 ? "pass" : "fail",
    value: unready.length === 0 ? "all ready" : `${unready.length} scene(s) unready`,
    detail: "A selected scene without ready audio blocks the stitch.",
  });

  // --- technical: truncation / runaway duration heuristic ---
  const durationSuspects: string[] = [];
  for (const s of scenes) {
    if (!s.durationMs || !s.characterCount) continue;
    const msPerChar = s.durationMs / Math.max(1, s.characterCount);
    if (msPerChar < MIN_MS_PER_CHAR) durationSuspects.push(`scene ${s.sceneIndex}: ${Math.round(msPerChar)}ms/char (possible truncation/missing final words)`);
    if (msPerChar > MAX_MS_PER_CHAR) durationSuspects.push(`scene ${s.sceneIndex}: ${Math.round(msPerChar)}ms/char (unexpectedly long)`);
  }
  push({
    name: "Scene duration vs text length (truncation heuristic)",
    kind: "technical",
    status: durationSuspects.length === 0 ? "pass" : "warning",
    value: durationSuspects.length === 0 ? "all within wide bounds" : durationSuspects.join("; "),
    detail: "A crude bound (20-350ms/char) that only catches catastrophic truncation or runaway generation — it does NOT measure delivery quality.",
  });

  // --- technical: duplicate payload fingerprints across DIFFERENT scenes ---
  const byFp = new Map<string, number[]>();
  for (const s of scenes) {
    const list = byFp.get(s.requestFingerprint) ?? [];
    list.push(s.sceneIndex);
    byFp.set(s.requestFingerprint, list);
  }
  const dupFp = [...byFp.entries()].filter(([, v]) => new Set(v).size > 1);
  push({
    name: "No duplicate scene fingerprints",
    kind: "technical",
    status: dupFp.length === 0 ? "pass" : "fail",
    value: dupFp.length === 0 ? "unique" : dupFp.map(([fp, v]) => `${fp.slice(0, 8)}→scenes ${[...new Set(v)].join(",")}`).join("; "),
    detail: "Two different scenes sharing one request fingerprint means the same audio was (or will be) reused for different dialogue.",
  });

  // --- identity consistency: provider/model uniformity + voice map sanity ---
  const providers = new Set(scenes.map((s) => s.provider));
  const providerOk = providers.size <= 1 && (!opts.expectedProvider || providers.has(opts.expectedProvider) || scenes.length === 0);
  push({
    name: "Provider/model consistency",
    kind: "identity_consistency",
    status: providerOk ? "pass" : "fail",
    value: [...providers].join(", ") || "none",
    detail: "A finished episode must not silently mix engines across scenes (an approved mixed_fallback records itself explicitly).",
  });
  const emptyVoice = scenes.filter((s) => Object.values(s.voiceMap).some((v) => !v || v.includes("stub")));
  push({
    name: "Voice map integrity",
    kind: "identity_consistency",
    status: emptyVoice.length === 0 ? "pass" : "fail",
    value: emptyVoice.length === 0 ? "all speakers mapped" : `${emptyVoice.length} scene(s) with missing/stub voices`,
    detail: "Every speaker in a scene must map to the exact voice id that was sent.",
  });

  // --- timing QA ---
  const withTiming = scenes.filter((s) => s.timingStatus && s.timingStatus !== "timing_unavailable");
  push({
    name: "Scene timing maps",
    kind: "timing",
    status: opts.timingRequired
      ? withTiming.length === scenes.length ? "pass" : "fail"
      : withTiming.length === scenes.length ? "pass" : "warning",
    value: `${withTiming.length}/${scenes.length} scenes have timing`,
    detail: opts.timingRequired
      ? "Caption-synced consumers require real timing for every scene; fabricated timestamps are prohibited."
      : "Without timing maps, caption-synced social clips will honestly refuse instead of fabricating timestamps.",
  });

  // --- transcript fidelity (external service required) ---
  push({
    name: "Transcript fidelity (names/numbers preserved)",
    kind: "transcript_fidelity",
    status: opts.transcriptQaEnabled ? "warning" : "not_run",
    value: opts.transcriptQaEnabled ? "configured but no verifier wired in this build" : "not_run (TTS_TRANSCRIPT_QA_ENABLED=false)",
    detail: "Requires a configured external transcription service; reported as not_run when absent — NEVER as passed.",
  });

  return { passed: checks.every((c) => c.status !== "fail"), checks };
}
