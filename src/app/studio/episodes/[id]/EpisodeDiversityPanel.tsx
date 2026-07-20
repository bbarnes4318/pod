// Render-detail sound-diversity panel (PR 4, operator visibility). Server
// component: reads the episode's latest SUCCEEDED render diagnostics + the
// frozen v6 diversity context. Safe: engine/mode/fingerprints/reasons/counts
// only — never URLs, storage keys, local paths, credentials, or another
// podcast's history. Renders nothing when the episode has no diversity data.

import { db } from "@/lib/db";

interface DiversityDiag {
  renderMode?: string;
  contextSource?: string;
  cueDiversityDecisions?: number;
  contextVersion?: number;
  policyVersion?: number;
  selectionMode?: string;
  introReason?: string | null;
  outroReason?: string | null;
  bedReason?: string | null;
  motifAction?: string | null;
  motifRate?: number | null;
  relaxations?: string[];
  diversityFingerprint?: string | null;
}

export default async function EpisodeDiversityPanel({ episodeId }: { episodeId: string }) {
  const render = await db.episodeAudioRender
    .findFirst({ where: { episodeId, status: "succeeded" }, orderBy: { renderVersion: "desc" }, select: { renderMode: true, diagnostics: true } })
    .catch(() => null);
  if (!render) return null;
  const diag = (render.diagnostics as { postTts?: { planningEngine?: string; planningVersion?: number; diversity?: DiversityDiag } } | null)?.postTts;
  const d = diag?.diversity;
  const engine = diag?.planningEngine ?? null;
  // Only show the panel when there is diversity/post-TTS data to show.
  if (!d && engine == null) return null;
  const isReproduce = engine === "stored_plan_reproduce";
  const usedFrozen = d?.contextSource === "frozen";

  const row = (label: string, value: React.ReactNode, testid?: string) => (
    <div style={{ display: "flex", gap: 8, padding: "2px 0" }}>
      <span style={{ minWidth: 200, opacity: 0.7 }}>{label}</span>
      <span data-testid={testid}>{value}</span>
    </div>
  );

  return (
    <section data-testid="episode-diversity" aria-label="Sound diversity" style={{ border: "1px solid var(--u-hairline-2, var(--border, #e5e5e5))", borderRadius: 8, padding: 12, marginTop: 12 }}>
      <h3 style={{ margin: "0 0 8px" }}>Sound diversity</h3>
      {row("Post-TTS engine", <strong data-testid="diversity-engine">{engine ?? "—"}</strong>)}
      {row("Diversity mode", <strong data-testid="diversity-mode">{d?.renderMode ?? d?.selectionMode ?? "off"}</strong>)}
      {row(
        "Configuration used",
        isReproduce
          ? <span data-testid="diversity-config-source"><strong>stored plan (reproduce)</strong> — replayed verbatim, no re-selection</span>
          : <span data-testid="diversity-config-source"><strong>{usedFrozen ? "frozen (from this episode's snapshot)" : d?.contextSource === "current" ? "current podcast config (remix)" : "—"}</strong></span>,
        undefined,
      )}
      {d?.diversityFingerprint && row("Diversity fingerprint", <code data-testid="diversity-fingerprint">{d.diversityFingerprint.slice(0, 16)}…</code>)}
      {d?.policyVersion != null && row("Policy version", String(d.policyVersion))}
      {d?.introReason && row("Intro selection", d.introReason, "diversity-intro-reason")}
      {d?.outroReason && row("Outro selection", d.outroReason, "diversity-outro-reason")}
      {d?.bedReason && row("Bed selection", d.bedReason, "diversity-bed-reason")}
      {d?.motifAction && row("Branded motif", <span data-testid="diversity-motif">{d.motifAction}{d.motifRate != null ? ` (recent rate ${d.motifRate.toFixed(2)})` : ""}</span>)}
      {typeof d?.cueDiversityDecisions === "number" && row("Cue diversity decisions", String(d.cueDiversityDecisions), "diversity-cue-count")}
      {row("Relaxations", (d?.relaxations && d.relaxations.length ? d.relaxations.join(", ") : "none"), "diversity-relaxations")}
    </section>
  );
}
