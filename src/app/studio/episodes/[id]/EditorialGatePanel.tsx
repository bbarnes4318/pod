// The editorial verdict, made visible BEFORE any TTS money is spent.
//
// Until now the gate verdict, its reasons, and the pipeline path that produced
// the script existed only inside Script.content JSON — `src/app/**` contained
// zero references to `editorialGate`. A producer clicking "Record voices" had
// no way to know the script was on hold, or that it had been written by the
// emergency single-shot fallback rather than the creative pipeline.

import type { ScriptEditorialGateResult, ScriptPipelineProvenance } from "@/lib/services/scriptEditorialGate";
import type { InvariantReport } from "@/lib/services/productionInvariants";

export interface EditorialGatePanelProps {
  gate?: Partial<ScriptEditorialGateResult> | null;
  provenance?: ScriptPipelineProvenance | null;
  invariants?: InvariantReport | null;
  humanRelease?: { approvedBy?: string; approvedAt?: string; approvedDecision?: string } | null;
  /** The durable ScriptLegacyRelease row, when a pre-cutover script was let
   *  through for in-flight compatibility. Shown prominently because it means
   *  this episode reached production WITHOUT a quality verdict. */
  legacyRelease?: {
    id?: string;
    createdAt?: string;
    actorKind?: string;
    actorId?: string | null;
    permittedStages?: string[];
    reason?: string;
  } | null;
}

const DECISION_COPY: Record<string, { label: string; tone: string; blurb: string }> = {
  pass: {
    label: "Pass",
    tone: "gate-pass",
    blurb: "Cleared for automatic production.",
  },
  review: {
    label: "Review",
    tone: "gate-review",
    blurb: "Automatic production is paused. A person has to decide before voices are recorded.",
  },
  hold: {
    label: "Hold",
    tone: "gate-hold",
    blurb: "Blocked. This script will not reach TTS until it is fixed or explicitly released.",
  },
};

function pathCopy(path?: string): { label: string; warn: boolean } {
  if (path === "outline_driven") return { label: "Outline-driven creative pipeline", warn: false };
  if (path === "single_shot_fallback") return { label: "Single-shot emergency fallback", warn: true };
  return { label: path || "unknown", warn: true };
}

export default function EditorialGatePanel({ gate, provenance, invariants, humanRelease, legacyRelease }: EditorialGatePanelProps) {
  if (!gate?.decision) {
    return (
      <section className="studio-panel gate-panel gate-hold">
        <h3>Editorial gate</h3>
        <p>
          This script carries no editorial verdict. It has never been evaluated, so production will refuse it.
        </p>
      </section>
    );
  }

  const copy = DECISION_COPY[gate.decision] || DECISION_COPY.hold;
  const path = pathCopy(provenance?.path);
  const failedStages = (provenance?.stages || []).filter((s) => s.status === "failed");
  const m = invariants?.measurements;

  return (
    <section className={`studio-panel gate-panel ${copy.tone}`}>
      <header>
        <h3>Editorial gate</h3>
        <span className="gate-badge">{copy.label}</span>
      </header>
      <p className="gate-blurb">{copy.blurb}</p>

      <dl className="gate-provenance">
        <dt>Written by</dt>
        <dd className={path.warn ? "gate-warn" : undefined}>
          {path.label}
          {provenance?.fallbackReason ? ` — ${provenance.fallbackReason}` : ""}
        </dd>
        <dt>Private agendas</dt>
        <dd>{provenance?.privateAgendaCount ?? 0} packet(s)</dd>
        <dt>Cold-open tournament</dt>
        <dd>{provenance?.coldOpenTournamentRan ? "ran" : "did not run"}</dd>
        <dt>Character writer passes</dt>
        <dd>{provenance?.characterWriterPassesRan ?? 0}</dd>
        <dt>Independent judge</dt>
        <dd className={provenance?.judgeRan ? undefined : "gate-warn"}>
          {provenance?.judgeRan ? "ran" : "did not run"}
        </dd>
      </dl>

      {failedStages.length > 0 && (
        <div className="gate-stages">
          <h4>Failed creative stages</h4>
          <ul>
            {failedStages.map((s) => (
              <li key={s.name}>
                <code>{s.name}</code>
                {s.detail ? ` — ${s.detail}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {m && (
        <div className="gate-measurements">
          <h4>Measured</h4>
          <ul>
            <li>Cold open: {m.coldOpenWords} spoken words across {m.coldOpenLines} lines</li>
            <li>Strict alternation: {(m.strictAlternationRatio * 100).toFixed(1)}%</li>
            <li>
              Lines per host:{" "}
              {Object.entries(m.perSpeakerLines).map(([k, v]) => `${k} ${v}`).join(" · ")}
            </li>
            <li>Position swaps detected: {m.positionSwapCount}</li>
          </ul>
        </div>
      )}

      {Array.isArray(gate.failedCriticalAxes) && gate.failedCriticalAxes.length > 0 && (
        <div className="gate-axes">
          <h4>Failed critical axes</h4>
          <p>These fail on their own merit and are not averaged into the overall score.</p>
          <ul>
            {gate.failedCriticalAxes.map((axis) => (
              <li key={axis}><code>{axis}</code></li>
            ))}
          </ul>
        </div>
      )}

      {Array.isArray(gate.reasons) && gate.reasons.length > 0 && (
        <div className="gate-reasons">
          <h4>Why</h4>
          <ol>
            {gate.reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ol>
        </div>
      )}

      {legacyRelease?.id && (
        <div className="gate-legacy-release gate-warn">
          <h4>Legacy compatibility release</h4>
          <p>
            This script reached production <strong>without a quality verdict</strong>. It was written before the
            editorial gate had authority, so a scoped compatibility release let it finish.
          </p>
          <dl>
            <dt>Release</dt>
            <dd><code>{legacyRelease.id}</code>{legacyRelease.createdAt ? ` · ${legacyRelease.createdAt}` : ""}</dd>
            <dt>Released by</dt>
            <dd>{legacyRelease.actorKind === "system" ? `automatic rollout (${legacyRelease.actorId})` : legacyRelease.actorId || "unknown"}</dd>
            <dt>Permits</dt>
            <dd>{(legacyRelease.permittedStages || []).join(", ") || "—"}</dd>
          </dl>
          {legacyRelease.reason && <p className="gate-legacy-reason">{legacyRelease.reason}</p>}
          <p>
            Run <code>npm run gate:reevaluate -- --script &lt;id&gt;</code> to replace this release with a real verdict.
          </p>
        </div>
      )}

      {humanRelease?.approvedBy && (
        <p className="gate-release">
          Released by {humanRelease.approvedBy}
          {humanRelease.approvedAt ? ` on ${humanRelease.approvedAt}` : ""}
          {humanRelease.approvedDecision ? ` (acknowledged a “${humanRelease.approvedDecision}” verdict)` : ""}.
        </p>
      )}
    </section>
  );
}
