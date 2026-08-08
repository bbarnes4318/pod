"use client";

// Listener-learning console: the whole closed loop on one page —
// what was collected, what it aggregates to (with sample size and a confidence
// indicator on every number), which bounded preferences learning is allowed to
// touch, which rules it can never touch, and the versioned promote/rollback
// history with the evidence that caused each change.

import React, { useMemo, useState } from "react";
import {
  fetchLearningData,
  purgeExpiredLearningData,
  recomputeLearningAggregates,
  rollbackPolicy,
  runPolicyCycle,
  type LearningViewData,
} from "./actions";
import "../scripts/scripts.css";

const CONFIDENCE_COLOR: Record<string, string> = {
  low: "var(--error-color)",
  moderate: "var(--warning-color, #b8860b)",
  high: "var(--success-color, #2e7d32)",
};

function formatValue(mean: number, unit: string): string {
  if (unit === "usd_per_minute") return `$${mean.toFixed(3)}/min`;
  return `${(mean * 100).toFixed(1)}%`;
}

export default function LearningDashboard({ initial }: { initial: LearningViewData }) {
  const [data, setData] = useState<LearningViewData>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(
    initial.error ? { type: "error", text: initial.error } : null
  );
  const [rollbackReason, setRollbackReason] = useState("");

  const refresh = async (podcastId?: string | null) => {
    const next = await fetchLearningData(podcastId ?? data.podcastId);
    setData(next);
  };

  const run = async (label: string, fn: () => Promise<{ success: boolean; message?: string; error?: string }>) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fn();
      setMessage(
        res.success
          ? { type: "success", text: res.message || `${label} complete.` }
          : { type: "error", text: res.error || `${label} failed.` }
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const byScope = useMemo(() => {
    const map = new Map<string, LearningViewData["aggregates"]>();
    for (const kind of data.scopeKinds) map.set(kind, []);
    for (const row of data.aggregates) {
      const list = map.get(row.scopeKind);
      if (list) list.push(row);
    }
    return map;
  }, [data.aggregates, data.scopeKinds]);

  const activeVersionRow = data.policyVersions.find((v) => v.version === data.activeVersion) ?? null;

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      <div className="personalitiesHeader">
        <div className="titleGroup">
          <h2>Listener Learning</h2>
          <p>
            The closed loop: consented, hashed listener signals and production-side measurements are stored as{" "}
            <strong>raw attributable events</strong>, rolled up into <strong>derived aggregates</strong> (recomputable at
            any time), and used to promote a <strong>versioned, per-show</strong> production policy that can only move
            bounded preferences — never evidence, safety, or character rules. Raw events are purged{" "}
            {data.retentionDays} days after collection.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <select
            className="toneSelector"
            value={data.podcastId ?? ""}
            disabled={busy || !data.shows.length}
            onChange={async (e) => {
              setBusy(true);
              await refresh(e.target.value);
              setBusy(false);
            }}
          >
            {data.shows.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="buttonPrimary" disabled={busy || !data.podcastId} onClick={() => run("Policy cycle", () => runPolicyCycle(data.podcastId!))}>
            {busy ? "Working…" : "Run learning cycle"}
          </button>
        </div>
      </div>

      {message && (
        <div className={`alertCard ${message.type === "success" ? "alertSuccess" : "alertDanger"}`} style={{ marginBottom: "1rem" }}>
          {message.text}
        </div>
      )}

      {!data.shows.length && (
        <div className="alertCard alertWarning">No shows exist yet — there is nothing to learn from.</div>
      )}

      {/* ---------------- collection summary ---------------- */}
      <div className="editorPanel" style={{ padding: "1rem", marginBottom: "1rem" }}>
        <div className="panelTitle">Collection — {data.podcastName || "no show selected"}</div>
        <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", fontSize: "0.82rem", padding: "0.5rem 0" }}>
          <span>
            <strong>{data.rawEventCount}</strong> raw events
          </span>
          <span>
            <strong>{data.consentedEventCount}</strong> carrying an explicit consent flag
          </span>
          <span>
            <strong>{data.aggregates.length}</strong> derived aggregate rows
          </span>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button className="editButton" disabled={busy || !data.podcastId} onClick={() => run("Recompute", () => recomputeLearningAggregates(data.podcastId!))}>
            Recompute aggregates from raw events
          </button>
          <button className="editButton" disabled={busy} onClick={() => run("Purge", async () => {
            const res = await purgeExpiredLearningData();
            return { success: res.success, message: res.success ? `Purged ${res.removed} expired raw events.` : undefined, error: res.error };
          })}>
            Purge expired raw events
          </button>
        </div>
        <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", marginTop: "0.5rem" }}>
          Aggregates are derived — deleting and recomputing them changes nothing. The raw events are the record.
        </div>
      </div>

      {/* ---------------- the 14 signals ---------------- */}
      <div className="editorPanel" style={{ padding: "1rem", marginBottom: "1rem" }}>
        <div className="panelTitle">Signals ({data.signals.length})</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "0.4rem", fontSize: "0.78rem", paddingTop: "0.5rem" }}>
          {data.signals.map((s) => (
            <div key={s.key} style={{ borderTop: "1px solid var(--border-color)", padding: "0.35rem 0" }}>
              <div style={{ fontWeight: 600 }}>{s.label}</div>
              <div style={{ color: "var(--text-secondary)", fontSize: "0.7rem" }}>
                {s.source} · {s.direction === "higher_better" ? "higher is better" : "lower is better"}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ---------------- breakdowns ---------------- */}
      {data.scopeKinds.map((kind) => {
        const rows = byScope.get(kind) ?? [];
        return (
          <div key={kind} className="editorPanel" style={{ padding: "1rem", marginBottom: "1rem" }}>
            <div className="panelTitle">
              By {kind.replace(/_/g, " ")} ({rows.length})
            </div>
            {rows.length === 0 ? (
              <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)", padding: "0.5rem 0" }}>
                No measured events attributed to this dimension yet.
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                      <th style={{ padding: "0.3rem 0.5rem" }}>{kind.replace(/_/g, " ")}</th>
                      <th style={{ padding: "0.3rem 0.5rem" }}>Signal</th>
                      <th style={{ padding: "0.3rem 0.5rem" }}>Value</th>
                      <th style={{ padding: "0.3rem 0.5rem" }}>n</th>
                      <th style={{ padding: "0.3rem 0.5rem" }}>±95%</th>
                      <th style={{ padding: "0.3rem 0.5rem" }}>Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.scopeKey}:${r.signalKey}`} style={{ borderTop: "1px solid var(--border-color)" }}>
                        <td style={{ padding: "0.3rem 0.5rem", fontFamily: "monospace", fontSize: "0.72rem" }}>{r.scopeKey}</td>
                        <td style={{ padding: "0.3rem 0.5rem" }}>{r.signalLabel}</td>
                        <td style={{ padding: "0.3rem 0.5rem", fontWeight: 600 }}>{formatValue(r.mean, r.unit)}</td>
                        <td style={{ padding: "0.3rem 0.5rem" }}>{r.sampleSize}</td>
                        <td style={{ padding: "0.3rem 0.5rem" }}>
                          {r.unit === "usd_per_minute" ? r.marginOfError.toFixed(3) : `${(r.marginOfError * 100).toFixed(1)}pp`}
                        </td>
                        <td style={{ padding: "0.3rem 0.5rem" }}>
                          <span className="badge" style={{ background: "transparent", color: CONFIDENCE_COLOR[r.confidence], border: `1px solid ${CONFIDENCE_COLOR[r.confidence]}`, fontSize: "0.62rem" }}>
                            {r.confidence}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {/* ---------------- policy ---------------- */}
      <div className="editorPanel" style={{ padding: "1rem", marginBottom: "1rem" }}>
        <div className="panelTitle">Production policy — {data.podcastName || "—"} (v{data.activeVersion ?? "—"})</div>

        <div className="alertCard alertWarning" style={{ margin: "0.5rem 0", fontSize: "0.76rem" }}>
          <strong>Promotion gate:</strong> ≥{data.thresholds.minSamplePerArm} observations per arm, ≥
          {data.thresholds.minTotalSample} in total, an effect of at least {data.thresholds.minEffect}, |z| ≥{" "}
          {data.thresholds.minZScore}, and a winning arm already at &quot;{data.thresholds.minConfidence}&quot; confidence.
          Callers may tighten these; an attempt to loosen them is ignored.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "1rem" }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: "0.8rem", marginBottom: "0.3rem" }}>Adjustable (bounded)</div>
            {data.adjustableFields.map((f) => (
              <div key={f.field} style={{ borderTop: "1px solid var(--border-color)", padding: "0.3rem 0", fontSize: "0.75rem" }}>
                <div style={{ fontWeight: 600 }}>{f.label}</div>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.68rem" }}>{f.bound}</div>
                <div style={{ fontFamily: "monospace", fontSize: "0.68rem" }}>
                  {JSON.stringify(activeVersionRow?.preferences?.[f.field] ?? null)}
                </div>
              </div>
            ))}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: "0.8rem", marginBottom: "0.3rem" }}>
              Immutable — evidence, safety, character
            </div>
            <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", marginBottom: "0.3rem" }}>
              Learning can never write these. A proposal that names one is rejected with code{" "}
              <code>immutable_field</code>, and the pipeline reads them from code, not from the stored row.
            </div>
            {data.immutableFields.map((f) => (
              <div key={f} style={{ fontFamily: "monospace", fontSize: "0.68rem", padding: "0.12rem 0" }}>
                🔒 {f}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ---------------- versions ---------------- */}
      <div className="editorPanel" style={{ padding: "1rem", marginBottom: "1rem" }}>
        <div className="panelTitle" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span>Policy versions ({data.policyVersions.length})</span>
          <span style={{ display: "flex", gap: "0.4rem" }}>
            <input
              className="toneSelector"
              placeholder="Rollback reason"
              value={rollbackReason}
              onChange={(e) => setRollbackReason(e.target.value)}
              style={{ fontSize: "0.72rem" }}
            />
            <button
              className="btnReset"
              style={{ fontSize: "0.72rem", color: "var(--error-color)" }}
              disabled={busy || !data.podcastId}
              onClick={() => run("Rollback", () => rollbackPolicy(data.podcastId!, rollbackReason))}
            >
              Roll back one version
            </button>
          </span>
        </div>
        {data.policyVersions.length === 0 ? (
          <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)", padding: "0.5rem 0" }}>
            No policy versions yet — this show is still on the baseline.
          </div>
        ) : (
          data.policyVersions.map((v) => {
            const evidence = v.evidence as {
              episodeIds?: string[];
              cohorts?: string[];
              winner?: { scopeKey?: string; sampleSize?: number; confidence?: string };
              challenger?: { scopeKey?: string; sampleSize?: number };
              zScore?: number;
              changedFields?: string[];
            };
            return (
              <div key={v.version} style={{ borderTop: "1px solid var(--border-color)", padding: "0.5rem 0", fontSize: "0.78rem" }}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                  <strong>v{v.version}</strong>
                  <span className={`badge ${v.status === "active" ? "badgeCompleted" : "badgeFailed"}`} style={{ fontSize: "0.6rem" }}>
                    {v.status}
                  </span>
                  <span style={{ color: "var(--text-secondary)", fontSize: "0.7rem" }}>
                    {new Date(v.promotedAt).toLocaleString()} · {v.promotedBy || "—"}
                    {v.promotedFromVersion != null ? ` · from v${v.promotedFromVersion}` : ""}
                  </span>
                </div>
                <div style={{ padding: "0.2rem 0" }}>{v.rationale}</div>
                {(evidence?.episodeIds?.length || evidence?.cohorts?.length) && (
                  <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>
                    Caused by {evidence.episodeIds?.length ?? 0} episode(s)
                    {evidence.cohorts?.length ? ` · cohorts: ${evidence.cohorts.join(", ")}` : ""}
                    {evidence.winner?.scopeKey
                      ? ` · ${evidence.winner.scopeKey} (n=${evidence.winner.sampleSize}) beat ${evidence.challenger?.scopeKey} (n=${evidence.challenger?.sampleSize})`
                      : ""}
                    {typeof evidence.zScore === "number" ? ` · z=${evidence.zScore.toFixed(2)}` : ""}
                  </div>
                )}
                {evidence?.changedFields?.length ? (
                  <div style={{ fontFamily: "monospace", fontSize: "0.68rem" }}>changed: {evidence.changedFields.join(", ")}</div>
                ) : null}
                {v.rolledBackAt && (
                  <div style={{ fontSize: "0.7rem", color: "var(--error-color)" }}>
                    Rolled back {new Date(v.rolledBackAt).toLocaleString()} by {v.rolledBackBy || "—"} — {v.rolledBackReason}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* ---------------- decisions ---------------- */}
      <div className="editorPanel" style={{ padding: "1rem" }}>
        <div className="panelTitle">Decision log ({data.decisions.length})</div>
        {data.decisions.length === 0 ? (
          <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)", padding: "0.5rem 0" }}>
            No promotion attempts recorded yet.
          </div>
        ) : (
          data.decisions.map((d, i) => (
            <div key={`${d.decidedAt}-${i}`} style={{ borderTop: "1px solid var(--border-color)", padding: "0.35rem 0", fontSize: "0.76rem" }}>
              <span className={`badge ${d.outcome === "promoted" ? "badgeCompleted" : "badgeFailed"}`} style={{ fontSize: "0.6rem", marginRight: "0.4rem" }}>
                {d.outcome}
              </span>
              <code style={{ fontSize: "0.68rem" }}>{d.code}</code> — {d.reason}
              <div style={{ fontSize: "0.68rem", color: "var(--text-secondary)" }}>
                {new Date(d.decidedAt).toLocaleString()} · {d.actor || "—"}
                {d.resultingVersion != null ? ` · v${d.resultingVersion}` : ""}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
