// Render-detail sound-diversity panel (PR 4, operator visibility). Server
// component: reads the episode's latest SUCCEEDED render (its stored plan +
// diagnostics) and the frozen v6 diversity context. Safe: engine/mode/
// fingerprints/reasons/counts only — never URLs, storage keys, local paths,
// credentials, or another podcast's history. Renders nothing when there is no
// diversity data.

import { db } from "@/lib/db";

interface RoleDecision { role: string; selectedAssetId: string | null; reason: string; poolSize: number; eligibleCount: number; assetStreak: number; familyStreak: number; relaxations: string[]; candidates: Array<{ assetId: string; excluded: boolean; exclusionReason: string | null }> }
interface FrozenDecision { selectedIntro: RoleDecision | null; selectedOutro: RoleDecision | null; selectedBed: RoleDecision | null; motifDecision: { action: string; recentRate: number; minimumRate: number; maximumRate: number; reason: string } | null; relaxations: string[]; warnings: string[]; fingerprint: string }
interface CtxDiag { version: number; policyVersion: number; rolloutMode: string; historyFingerprint: string; fingerprint: string; decision: FrozenDecision }
interface CueDecision { role: string; lineIndex: number; selectedAssetId: string | null; selectedFamily: string | null; reason: string; relaxations: string[] }
interface StoredPlan { cueDiversityDecisions?: CueDecision[]; cueSequence?: string[]; sequenceSimilarity?: { maxSimilarity: number; threshold: number; overThreshold: boolean; comparisons: number; relaxation: string | null } }
interface PostTtsDiag { planningEngine?: string; planningVersion?: number; diversity?: { renderMode?: string; contextSource?: string; diversityFingerprint?: string } }

function Row({ label, children, testid }: { label: string; children: React.ReactNode; testid?: string }) {
  return <div style={{ display: "flex", gap: 8, padding: "2px 0", flexWrap: "wrap" }}><span style={{ minWidth: 210, opacity: 0.7 }}>{label}</span><span data-testid={testid}>{children}</span></div>;
}
function RoleBlock({ d }: { d: RoleDecision | null }) {
  if (!d) return null;
  const excluded = d.candidates.filter((c) => c.excluded);
  return (
    <div data-testid={`diversity-role-${d.role}`} style={{ margin: "4px 0", paddingLeft: 10, borderLeft: "2px solid var(--u-hairline-2, #e5e5e5)" }}>
      <div><strong>{d.role}</strong>: {d.selectedAssetId ?? "(none)"} — {d.reason}</div>
      <div style={{ opacity: 0.8, fontSize: "0.9em" }}>candidates {d.eligibleCount}/{d.poolSize} · asset streak {d.assetStreak} · family streak {d.familyStreak}{d.relaxations.length ? ` · relaxed: ${d.relaxations.join(", ")}` : ""}</div>
      {excluded.length > 0 && <div style={{ opacity: 0.7, fontSize: "0.9em" }}>excluded: {excluded.map((c) => `${c.assetId} (${c.exclusionReason ?? "?"})`).join("; ")}</div>}
    </div>
  );
}

export default async function EpisodeDiversityPanel({ episodeId }: { episodeId: string }) {
  const [render, episode] = await Promise.all([
    db.episodeAudioRender.findFirst({ where: { episodeId, status: "succeeded" }, orderBy: { renderVersion: "desc" }, select: { plan: true, diagnostics: true } }).catch(() => null),
    db.episode.findUnique({ where: { id: episodeId }, select: { configurationSnapshot: true } }).catch(() => null),
  ]);
  if (!render) return null;
  const diag = (render.diagnostics as { postTts?: PostTtsDiag } | null)?.postTts;
  const plan = render.plan as StoredPlan | null;
  const ctx = (episode?.configurationSnapshot as { production?: { diversityContext?: CtxDiag } } | null)?.production?.diversityContext ?? null;
  const engine = diag?.planningEngine ?? null;
  if (!diag?.diversity && !ctx) return null;
  const isReproduce = engine === "stored_plan_reproduce";
  const source = diag?.diversity?.contextSource;
  const dec = ctx?.decision ?? null;
  const seq = plan?.sequenceSimilarity;

  return (
    <section data-testid="episode-diversity" aria-label="Sound diversity" style={{ border: "1px solid var(--u-hairline-2, var(--border, #e5e5e5))", borderRadius: 8, padding: 12, marginTop: 12 }}>
      <h3 style={{ margin: "0 0 8px" }}>Sound diversity</h3>

      <Row label="Post-TTS engine"><strong data-testid="diversity-engine">{engine ?? "—"}</strong></Row>
      <Row label="Diversity engine version">{dec ? `decision v${(ctx?.version ?? "?")} / policy v${ctx?.policyVersion ?? "?"}` : "—"}</Row>
      <Row label="Configured mode" testid="diversity-configured-mode">{ctx?.rolloutMode ?? "—"}</Row>
      <Row label="Effective mode" testid="diversity-mode">{diag?.diversity?.renderMode ?? "off"}</Row>
      <Row label="Configuration used" testid="diversity-config-source">
        <strong>{isReproduce ? "stored plan (reproduce) — replayed verbatim" : source === "frozen" ? "frozen (this episode's snapshot)" : source === "current" ? "current podcast config (remix)" : source ?? "—"}</strong>
      </Row>
      {diag?.diversity?.diversityFingerprint && <Row label="Diversity fingerprint"><code data-testid="diversity-fingerprint">{diag.diversity.diversityFingerprint.slice(0, 16)}…</code></Row>}
      {ctx?.historyFingerprint && <Row label="History fingerprint"><code>{ctx.historyFingerprint.slice(0, 16)}…</code></Row>}

      {dec && (
        <div data-testid="diversity-selections" style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 600 }}>Selection decisions</div>
          <RoleBlock d={dec.selectedIntro} />
          <RoleBlock d={dec.selectedOutro} />
          <RoleBlock d={dec.selectedBed} />
        </div>
      )}

      {dec?.motifDecision && (
        <Row label="Branded motif" testid="diversity-motif">
          {dec.motifDecision.action} — rate {dec.motifDecision.recentRate.toFixed(2)} (band {dec.motifDecision.minimumRate}–{dec.motifDecision.maximumRate}); {dec.motifDecision.reason}
        </Row>
      )}

      {plan?.cueDiversityDecisions && plan.cueDiversityDecisions.length > 0 && (
        <div data-testid="diversity-cue-decisions" style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 600 }}>Cue diversity ({plan.cueDiversityDecisions.length})</div>
          {plan.cueDiversityDecisions.map((c, i) => (
            <div key={i} style={{ fontSize: "0.9em", opacity: 0.85 }}>{c.role}@line{c.lineIndex}: {c.selectedAssetId ?? "(empty)"}{c.selectedFamily ? ` [${c.selectedFamily}]` : ""} — {c.reason}{c.relaxations.length ? ` · relaxed: ${c.relaxations.join(", ")}` : ""}</div>
          ))}
        </div>
      )}

      {seq && (
        <Row label="Sequence similarity" testid="diversity-sequence">
          max {seq.maxSimilarity.toFixed(2)} vs threshold {seq.threshold.toFixed(2)} ({seq.comparisons} compared){seq.overThreshold ? " — OVER" : " — under"}{seq.relaxation ? ` · ${seq.relaxation}` : ""}
        </Row>
      )}
      {plan?.cueSequence && plan.cueSequence.length > 0 && <Row label="Cue sequence" testid="diversity-cue-sequence"><code style={{ fontSize: "0.85em" }}>{plan.cueSequence.join(" › ")}</code></Row>}

      <Row label="Relaxations" testid="diversity-relaxations">{dec?.relaxations && dec.relaxations.length ? dec.relaxations.join(", ") : "none"}</Row>
      {dec?.warnings && dec.warnings.length > 0 && <Row label="Warnings" testid="diversity-warnings">{dec.warnings.join("; ")}</Row>}
    </section>
  );
}
