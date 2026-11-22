"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AdvancedSection, BusinessAnswers, ProfileFinding } from "@/lib/business/profileSchema";
import { reviewFinding, runBusinessDiscovery, saveBusinessAnswers } from "../businessActions";

const PROVENANCE_CHIP: Record<ProfileFinding["provenance"], { label: string; cls: string }> = {
  SOURCE_VERIFIED: { label: "Verified", cls: "chip chipSuccess" },
  USER_CONFIRMED: { label: "You confirmed", cls: "chip chipAccent" },
  AI_INFERRED: { label: "Inferred", cls: "chip" },
  UNKNOWN: { label: "Unknown", cls: "chip" },
};

export function DiscoveryButton({ podcastId, status, hasRun }: { podcastId: string; status: string; hasRun: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const busy = pending || status === "running";
  return (
    <span className="bizRow">
      {msg && <span className="bizNote" role="status">{msg}</span>}
      <button
        className="btnPrimary"
        disabled={busy}
        data-testid="run-business-discovery"
        onClick={() =>
          start(async () => {
            setMsg(null);
            const res = await runBusinessDiscovery(podcastId);
            setMsg(res.success
              ? `${res.added} new finding${res.added === 1 ? "" : "s"}${res.skipped.length ? ` · couldn't read ${res.skipped.length} page(s)` : ""}`
              : res.error);
            router.refresh();
          })
        }
      >
        {busy ? "Reading your business…" : hasRun ? "Re-run discovery" : "Run discovery"}
      </button>
    </span>
  );
}

export function FindingRow({ podcastId, finding }: { podcastId: string; finding: ProfileFinding }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(finding.value);
  const [error, setError] = useState<string | null>(null);
  const chip = PROVENANCE_CHIP[finding.provenance];
  const act = (action: "accept" | "reject" | "edit") =>
    start(async () => {
      setError(null);
      const res = await reviewFinding(podcastId, finding.id, action, action === "edit" ? value : undefined);
      if (!res.success) return setError(res.error);
      setEditing(false);
      router.refresh();
    });

  return (
    <div className={pending ? "bizFinding isPending" : "bizFinding"}>
      <div className="bizFindingHead">
        {editing ? (
          <textarea className="textarea bizFindingEdit" maxLength={1000} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Edit finding" />
        ) : (
          <span className="bizFindingValue">{finding.value}</span>
        )}
        <span className="bizFindingActions">
          <span className={chip.cls}>{chip.label}</span>
          {finding.status === "accepted" && <span className="chip chipSuccess">Kept</span>}
          {editing ? (
            <>
              <button className="btnPrimary" disabled={pending} onClick={() => act("edit")}>Save</button>
              <button className="btnGhost" disabled={pending} onClick={() => { setEditing(false); setValue(finding.value); }}>Cancel</button>
            </>
          ) : (
            <>
              {finding.status === "pending" && <button className="btnGhost" disabled={pending} onClick={() => act("accept")}>Keep</button>}
              <button className="btnGhost" disabled={pending} onClick={() => setEditing(true)}>Edit</button>
              <button className="btnGhost" disabled={pending} onClick={() => act("reject")}>Reject</button>
            </>
          )}
        </span>
      </div>
      {finding.evidenceQuote && (
        <div className="bizQuote">
          &ldquo;{finding.evidenceQuote}&rdquo;
          {finding.sourceUrl && <> — <a href={finding.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">{new URL(finding.sourceUrl).pathname || "/"}</a></>}
        </div>
      )}
      {error && <div role="alert" className="gateResult gate-err">{error}</div>}
    </div>
  );
}

export function AdvancedAnswersForm({
  podcastId, version, sections, initial,
}: { podcastId: string; version: number; sections: AdvancedSection[]; initial: BusinessAnswers }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [fields, setFields] = useState<Record<string, string>>(initial.fields);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = () =>
    start(async () => {
      const res = await saveBusinessAnswers(podcastId, { fields, followups: initial.followups }, version);
      setMsg(res.success ? { ok: true, text: "Saved." } : { ok: false, text: res.error });
      if (res.success) router.refresh();
    });

  return (
    <div className="bizStackTight">
      {sections.map((s, i) => (
        <details key={s.key} open={i === 0} className="bizDetails">
          <summary>
            {s.title}
            <span className="bizDetailsWhy">{s.why}</span>
          </summary>
          <div className="bizDetailsBody">
            {s.fields.map((f) => (
              <label key={f.key}>
                <span className="fieldLabel">{f.label}</span>
                <textarea
                  className="textarea bizAnswer"
                  maxLength={4000}
                  value={fields[f.key] ?? ""}
                  onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
                />
                {f.help && <span className="bizNote">{f.help}</span>}
              </label>
            ))}
          </div>
        </details>
      ))}
      <div className="bizRow">
        <button className="btnPrimary" disabled={pending} onClick={save}>{pending ? "Saving…" : "Save answers"}</button>
        {msg && <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "bizNote" : "bizError"}>{msg.text}</span>}
      </div>
    </div>
  );
}
