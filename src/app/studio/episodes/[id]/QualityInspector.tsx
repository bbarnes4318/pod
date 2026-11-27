"use client";

// The one place that says what is stopping this episode, and what is merely
// worth a look. Every item opens the stage (and the script line) where it is
// fixed. The list is read from the real gates (see lib/services/qualityInspector);
// it never decides anything itself.

import React, { useCallback, useEffect, useState } from "react";
import { getEpisodeQuality, revoiceStaleLines } from "../../../app/create/actions";
import type { QualityItem, QualityReport } from "@/lib/services/qualityInspector";
import "./workspace.css";

/** Other panels announce a change with this so the report re-reads itself. */
export const QUALITY_CHANGED = "studio:quality-changed";

const hrefFor = (item: QualityItem) => (item.lineIndex !== null ? `#line-${item.lineIndex}` : `#${item.tab}`);
const WHERE: Record<QualityItem["tab"], string> = { transcript: "Script", produce: "Audio and mix", publish: "Release" };

function Group({ title, items, tone }: { title: string; items: QualityItem[]; tone: "blocker" | "warning" }) {
  if (items.length === 0) return null;
  return (
    <section className="qiGroup" aria-label={title}>
      <h3 className="qiGroupTitle">
        <span className={`statusPill statusPill--${tone === "blocker" ? "err" : "warn"}`}>{title}</span>
        <span className="sectionCount">{items.length}</span>
      </h3>
      <ul className="qiList">
        {items.map((item) => (
          <li key={item.id}>
            <a className="qiItem" href={hrefFor(item)}>
              <span className="qiArea">{item.area}</span>
              <span className="qiBody">
                <span className="qiTitle">{item.title}</span>
                {item.detail && <span className="qiDetail">{item.detail}</span>}
              </span>
              <span className="qiGo">{item.lineIndex !== null ? `Line ${item.lineIndex + 1}` : WHERE[item.tab]}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function QualityInspector({ episodeId, initial }: { episodeId: string; initial?: QualityReport }) {
  const [report, setReport] = useState<QualityReport | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setReport(await getEpisodeQuality(episodeId));
    } catch {
      setNote("The quality report could not be refreshed. Showing the last one.");
    }
  }, [episodeId]);

  useEffect(() => {
    if (!initial) void refresh();
    const onChange = () => void refresh();
    window.addEventListener(QUALITY_CHANGED, onChange);
    return () => window.removeEventListener(QUALITY_CHANGED, onChange);
  }, [initial, refresh]);

  const revoice = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res: any = await revoiceStaleLines(episodeId);
      setNote(
        res?.success === false
          ? res.error
          : `Re-voicing ${res.queued} line${res.queued === 1 ? "" : "s"}. Each is recorded again and the mix is rebuilt.${res.remaining ? ` ${res.remaining} more are waiting: run this again when these finish.` : ""}`
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!report) return <div className="studioCard qiCard"><p className="stageHint m-0">Checking quality…</p></div>;
  if (!report.ok) return <div className="studioCard qiCard"><p className="noteWarn m-0" role="note">The quality report is unavailable: {report.error}</p></div>;

  const clean = report.blockers.length === 0 && report.warnings.length === 0;
  return (
    <div className="studioCard qiCard" data-testid="quality-inspector">
      <div className="qiHead">
        <h2 className="sectionTitle m-0">Quality and release check</h2>
        <button type="button" className="btnSubtle btnSm" onClick={() => void refresh()}>Check again</button>
      </div>
      <p className="qiSummary" role="status">
        {clean
          ? "Nothing is blocking this episode and there are no warnings."
          : report.blockers.length > 0
            ? `${report.blockers.length} thing${report.blockers.length === 1 ? "" : "s"} must be fixed before this episode can be released${report.warnings.length ? `, and ${report.warnings.length} worth a look` : ""}.`
            : `Nothing is blocking this episode. ${report.warnings.length} thing${report.warnings.length === 1 ? " is" : "s are"} worth a look.`}
      </p>
      {note && <p className="createAlert" role="status">{note}</p>}
      {report.staleAudioLines.length > 0 && (
        <div className="qiAction">
          <span>{report.staleAudioLines.length} recorded line{report.staleAudioLines.length === 1 ? " was" : "s were"} edited after voicing.</span>
          <button type="button" className="btnPrimary btnSm" onClick={revoice} disabled={busy} aria-busy={busy}>
            {busy ? "Queuing…" : `Re-voice ${report.staleAudioLines.length === 1 ? "it" : "them"}`}
          </button>
        </div>
      )}
      <Group title="Must fix" items={report.blockers} tone="blocker" />
      <Group title="Worth a look" items={report.warnings} tone="warning" />
    </div>
  );
}
