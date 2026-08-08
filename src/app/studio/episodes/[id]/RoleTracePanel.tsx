// The role-by-role writing trace, made visible.
//
// A producer looking at a script can already see the editorial verdict
// (EditorialGatePanel). What they could not see is WHO WROTE IT: which of the
// seven roles ran, which model actually served each one, and whether the model
// that answered was the model the router asked for. That last distinction is the
// point of this panel. A silent fallback — host B's writer quietly answered by
// the same model as host A's because its own chain was unreachable — produces a
// script that fails `hostDistinctness` for a reason nothing on the page explains.
// Here it is on the page.
//
// Styling follows EditorialGatePanel: a `studio-panel` section, a tone class on
// the wrapper, `<dl>` for facts and `<ul>` for findings. Colours are inlined
// rather than left to a class, because the one thing this panel must never do is
// render a failed required role as ordinary text.

import type { SevenRoleTraceRecord, RoleStageRecord } from "@/lib/services/scriptRoles";

export interface RoleTracePanelProps {
  trace?: SevenRoleTraceRecord | null;
}

const TONE = {
  ok: { fg: "#1f7a4d", bg: "rgba(31,122,77,0.10)", border: "rgba(31,122,77,0.35)", label: "ok" },
  failed: { fg: "#a3131b", bg: "rgba(163,19,27,0.12)", border: "rgba(163,19,27,0.55)", label: "FAILED" },
  skipped: { fg: "#7a6a1f", bg: "rgba(122,106,31,0.10)", border: "rgba(122,106,31,0.35)", label: "skipped" },
} as const;

function ms(value: number): string {
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function modelCopy(role: RoleStageRecord): { text: string; warn: boolean } {
  const requested = `${role.requestedProvider}/${role.requestedModel}`;
  if (role.actualProvider === null || role.actualModel === null) {
    // Never claim the requested model ran. "Unobserved" is a real answer.
    return {
      text: `requested ${requested} — actual model NOT OBSERVED`,
      warn: true,
    };
  }
  const actual = `${role.actualProvider}/${role.actualModel}`;
  if (role.fallbackFired) return { text: `requested ${requested} → served by ${actual}`, warn: true };
  return { text: `${actual} (as requested)`, warn: false };
}

export default function RoleTracePanel({ trace }: RoleTracePanelProps) {
  if (!trace || !Array.isArray(trace.roles) || trace.roles.length === 0) {
    return (
      <section className="studio-panel role-trace-panel">
        <h3>Writing roles</h3>
        <p>
          This script carries no role trace. It was not written by the seven-role pipeline, so there is no
          record of which model wrote which host.
        </p>
      </section>
    );
  }

  const holding = trace.holdingRoles || [];
  const blocked = holding.length > 0 || Boolean(trace.pipelineError);
  const fallbacks = trace.roles.filter((r) => r.fallbackFired);
  const unobserved = trace.roles.filter(
    (r) => r.status === "ok" && (r.actualModel === null || r.actualProvider === null)
  );

  return (
    <section
      className={`studio-panel role-trace-panel ${blocked ? "gate-hold" : "gate-pass"}`}
      style={{ borderLeft: `4px solid ${blocked ? TONE.failed.border : TONE.ok.border}` }}
    >
      <header>
        <h3>Writing roles</h3>
        <span className="gate-badge">
          {trace.roles.filter((r) => r.status === "ok").length}/{trace.roles.length} ran
        </span>
      </header>

      {blocked ? (
        <p
          className="gate-blurb gate-warn"
          style={{ color: TONE.failed.fg, fontWeight: 700 }}
        >
          {holding.length > 0
            ? `Required role${holding.length === 1 ? "" : "s"} failed: ${holding.join(", ")}. Production is held.`
            : `The pipeline failed after the roles ran: ${trace.pipelineError}`}
        </p>
      ) : (
        <p className="gate-blurb">
          Every required role completed. Seven separate stages wrote, repaired and judged this script.
        </p>
      )}

      <ol className="role-trace-list" style={{ listStyle: "none", margin: "1rem 0 0", padding: 0 }}>
        {trace.roles.map((role) => {
          const tone = TONE[role.status];
          const failedRequired = role.status === "failed" && role.required;
          const model = modelCopy(role);
          return (
            <li
              key={role.role}
              className={`role-trace-row role-${role.status}`}
              style={{
                border: `1px solid ${failedRequired ? TONE.failed.border : tone.border}`,
                borderLeft: `6px solid ${failedRequired ? TONE.failed.fg : tone.border}`,
                background: failedRequired ? TONE.failed.bg : tone.bg,
                borderRadius: 6,
                padding: "0.7rem 0.9rem",
                marginBottom: "0.55rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", flexWrap: "wrap" }}>
                <strong style={{ minWidth: "1.6rem" }}>{role.order}/7</strong>
                <strong>{role.label}</strong>
                <code style={{ opacity: 0.75 }}>{role.role}</code>
                <span
                  style={{
                    color: tone.fg,
                    fontWeight: failedRequired ? 800 : 600,
                    textTransform: failedRequired ? "uppercase" : "none",
                    letterSpacing: failedRequired ? "0.04em" : undefined,
                  }}
                >
                  {tone.label}
                </span>
                <span style={{ opacity: 0.7 }}>
                  {role.required ? "required" : "optional"}
                  {role.status === "ok" || role.durationMs > 0 ? ` · ${ms(role.durationMs)}` : ""}
                </span>
              </div>

              {failedRequired && (
                <p style={{ color: TONE.failed.fg, fontWeight: 700, margin: "0.45rem 0 0" }}>
                  This role is REQUIRED. Its failure holds production: {role.error || "no reason recorded"}
                </p>
              )}
              {role.status === "failed" && !role.required && (
                <p style={{ margin: "0.45rem 0 0" }}>
                  Optional role failed (does not hold production): {role.error || "no reason recorded"}
                </p>
              )}
              {role.status === "skipped" && (
                <p style={{ margin: "0.45rem 0 0", opacity: 0.85 }}>{role.error || "did not run"}</p>
              )}

              <dl
                className="role-trace-facts"
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: "0.15rem 0.7rem",
                  margin: "0.5rem 0 0",
                  fontSize: "0.82rem",
                }}
              >
                <dt>Routed as</dt>
                <dd style={{ margin: 0 }}>
                  <code>{role.llmRole}</code>
                </dd>
                <dt>Model</dt>
                <dd style={{ margin: 0, color: model.warn ? TONE.failed.fg : undefined, fontWeight: model.warn ? 600 : undefined }}>
                  {model.text}
                </dd>
                <dt>Observation</dt>
                <dd style={{ margin: 0, opacity: 0.85 }}>
                  {role.modelObservation === "unobserved"
                    ? "no observation — the serving model is unknown, not assumed"
                    : role.modelObservation === "cost_ledger"
                    ? "cost ledger (the recorded API call)"
                    : "provider report"}
                </dd>
                <dt>Fallback</dt>
                <dd style={{ margin: 0, color: role.fallbackFired ? TONE.failed.fg : undefined }}>
                  {role.fallbackFired
                    ? `FIRED — ${role.fallbackReason || "no reason recorded"}`
                    : "none — the requested candidate served the call"}
                </dd>
                <dt>Chain</dt>
                <dd style={{ margin: 0, opacity: 0.75 }}>{role.candidateChain.join(" → ") || "—"}</dd>
                <dt>Artifacts</dt>
                <dd style={{ margin: 0, opacity: 0.75 }}>
                  in {role.inputArtifacts.length} · out {role.outputArtifacts.length}
                  {role.outputArtifacts.length > 0
                    ? ` (${role.outputArtifacts.map((a) => a.id).join(", ")})`
                    : ""}
                </dd>
              </dl>

              {role.violations.length > 0 && (
                <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.1rem" }}>
                  {role.violations.map((violation, i) => (
                    <li key={i} style={{ fontSize: "0.82rem" }}>
                      <code>{violation.kind}</code> — {violation.detail}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>

      {fallbacks.length > 0 && (
        <div className="role-trace-fallbacks">
          <h4>Fallbacks fired</h4>
          <p>
            These roles were not served by the model the router asked for. Two host writers that fall back onto
            the same model are two hosts written by one mind.
          </p>
          <ul>
            {fallbacks.map((role) => (
              <li key={role.role}>
                <code>{role.role}</code> — {role.fallbackReason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {unobserved.length > 0 && (
        <div className="role-trace-unobserved">
          <h4>Serving model not observed</h4>
          <p>
            These roles completed, but nothing recorded which model answered. The record says so rather than
            naming the requested model.
          </p>
          <ul>
            {unobserved.map((role) => (
              <li key={role.role}>
                <code>{role.role}</code> — requested {role.requestedProvider}/{role.requestedModel}
              </li>
            ))}
          </ul>
        </div>
      )}

      {trace.violations.length > 0 && (
        <div className="role-trace-violations">
          <h4>Structural violations</h4>
          <p>
            Guard findings, not opinions: each one is a rule the pipeline enforced on the data a role returned.
          </p>
          <ul>
            {trace.violations.map((violation, i) => (
              <li key={i}>
                <code>
                  {violation.role}/{violation.kind}
                </code>{" "}
                — {violation.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
