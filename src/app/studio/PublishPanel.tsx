"use client";

// Step 6 — Publishing panel. Surfaces the per-podcast feed + download URLs,
// auto-generated title options + cover art, the responsible-gambling compliance
// status, and the hard Publish button. The publish gate is enforced server-side
// (validateEpisodeForRss: fact-check + gambling compliance); this panel only
// reflects it.

import React, { useCallback, useEffect, useState } from "react";
import { getPublishState, preparePublishAssets, setEpisodeTitle, publishOwnedEpisode } from "../app/create/actions";

type PublishState = Awaited<ReturnType<typeof getPublishState>>;
type PrepareResult = Awaited<ReturnType<typeof preparePublishAssets>>;

export default function PublishPanel({ episodeId, origin }: { episodeId: string; origin?: string }) {
  const [st, setSt] = useState<PublishState | null>(null);
  const [assets, setAssets] = useState<Extract<PrepareResult, { success: true }> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const [reasons, setReasons] = useState<string[] | null>(null);

  const refresh = useCallback(async () => {
    const s = (await getPublishState(episodeId)) as PublishState;
    setSt(s);
  }, [episodeId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (!st) return <div className="stageHint">Loading publish status…</div>;
  if (!st.ok) return <div className="emptyNote">{st.error}</div>;

  const base = origin || "";
  const feedUrl = `${base}${st.feedPath}`;
  const downloadUrl = `${base}${st.downloadPath}`;

  const run = async (key: string, fn: () => Promise<any>) => {
    setBusy(key); setNote(null); setReasons(null);
    try {
      const res: any = await fn();
      if (res?.success === false) {
        setNote({ ok: false, msg: res.error || "That didn't work." });
        if (Array.isArray(res.reasons)) setReasons(res.reasons);
      } else if (key === "publish") {
        setNote({ ok: true, msg: "Published to the feed." });
        await refresh();
      } else if (key === "prepare") {
        setAssets(res);
        setNote({ ok: true, msg: "Assets ready." });
        await refresh();
      } else {
        await refresh();
      }
    } finally { setBusy(null); }
  };

  const c = st.compliance;
  const titleOptions = assets?.titleOptions ?? st.titleOptions;
  const coverUrl = assets?.coverArtUrl ?? st.coverArtUrl;

  return (
    <div className="pubPanel">
      {note && <div className={`gateResult ${note.ok ? "gate-ok" : "gate-err"}`} role="alert">{note.msg}</div>}

      {/* Compliance status — icon + label + colour, never colour alone */}
      <div className="studioCard">
        <div className="sectionTitle" style={{ marginBottom: "0.7rem" }}>Compliance</div>
        {st.betting ? (
          <>
            <div className="factSummary">
              <span className="factPill fact-warn"><span className="factGlyph" aria-hidden="true">!</span>Betting content</span>
              {c.disclaimerPresent ? (
                <span className="factPill fact-ok"><span className="factGlyph" aria-hidden="true">✓</span>Disclaimer present</span>
              ) : (
                <span className="factPill fact-err"><span className="factGlyph" aria-hidden="true">✕</span>Disclaimer missing</span>
              )}
              {c.prohibited.length === 0 ? (
                <span className="factPill fact-ok"><span className="factGlyph" aria-hidden="true">✓</span>Language clean</span>
              ) : (
                <span className="factPill fact-err"><span className="factGlyph" aria-hidden="true">✕</span>{c.prohibited.length} prohibited phrase{c.prohibited.length === 1 ? "" : "s"}</span>
              )}
            </div>
            {c.prohibited.length > 0 && (
              <ul className="createReasons">{c.prohibited.map((p, i) => <li key={i}>{p.label}: “{p.match}”</li>)}</ul>
            )}
            <p className="stageHint" style={{ marginTop: "0.6rem" }}>
              Responsible-gambling disclaimer + 1-800-GAMBLER is a hard publish requirement here. &quot;Prepare assets&quot; injects it into the show notes.
            </p>
          </>
        ) : (
          <div className="factSummary">
            <span className="factPill fact-ok"><span className="factGlyph" aria-hidden="true">✓</span>No betting content — no gambling gate</span>
          </div>
        )}
      </div>

      {/* Auto-assets */}
      <div className="studioCard">
        <div className="sectionTitle" style={{ marginBottom: "0.7rem" }}>Assets</div>
        <div className="pubAssets">
          <div className="pubCover">
            {coverUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={coverUrl} alt="Episode cover art" />
            ) : (
              <div className="pubCoverEmpty">No cover yet</div>
            )}
          </div>
          <div className="pubAssetsMain">
            <div className="fieldLabel">Title options</div>
            <div className="pubTitles">
              {titleOptions.map((t, i) => (
                <button key={i} className="pubTitleBtn" disabled={busy === "title"} onClick={() => run("title", () => setEpisodeTitle(episodeId, t))} title="Use this title">
                  {t}
                </button>
              ))}
            </div>
            <div className="stageHint" style={{ marginTop: "0.5rem" }}>Current: <strong>{st.title}</strong></div>
            <button className="btnGhost" style={{ marginTop: "0.8rem" }} disabled={busy === "prepare"} onClick={() => run("prepare", () => preparePublishAssets(episodeId, { regenerateCover: !!coverUrl }))}>
              {busy === "prepare" ? "Preparing…" : coverUrl ? "Regenerate assets" : "Prepare assets (cover + disclaimer)"}
            </button>
            {!st.hasShowNotes && <p className="stageHint" style={{ marginTop: "0.5rem" }}>Show notes aren&apos;t generated yet — finish the Assets stage first.</p>}
          </div>
        </div>
      </div>

      {/* Distribution */}
      <div className="studioCard">
        <div className="sectionTitle" style={{ marginBottom: "0.7rem" }}>Distribution</div>
        <div className="pubUrlRow">
          <span className="pubUrlLabel">RSS feed</span>
          <code className="pubUrl">{feedUrl}</code>
          <a className="btnGhost pubUrlBtn" href={st.feedPath} target="_blank" rel="noopener noreferrer">Open</a>
        </div>
        <div className="pubUrlRow">
          <span className="pubUrlLabel">Download MP3</span>
          <code className="pubUrl">{downloadUrl}</code>
          <a className="btnGhost pubUrlBtn" href={st.downloadPath} target="_blank" rel="noopener noreferrer" aria-disabled={!st.published}>Download</a>
        </div>
        {!st.published && <p className="stageHint">The feed + download go live once you publish.</p>}
      </div>

      {/* The hard gate */}
      <div className="studioCard publishGate" style={{ borderColor: "var(--border)" }}>
        {st.published ? (
          <div className="factPill fact-ok" style={{ alignSelf: "flex-start" }}><span className="factGlyph" aria-hidden="true">✓</span>Published & live on the feed</div>
        ) : (
          <>
            <button className="btnPrimary" disabled={busy === "publish"} onClick={() => run("publish", () => publishOwnedEpisode(episodeId))}>
              {busy === "publish" ? "Publishing…" : "Publish to feed"}
            </button>
            {reasons && reasons.length > 0 && (
              <div className="gateReasons" role="status">
                <strong>Publish blocked:</strong>
                <ul className="createReasons">{reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
            )}
            <p className="stageHint" style={{ margin: 0 }}>Enforces the fact-check gate and, for betting content, the responsible-gambling gate — server-side.</p>
          </>
        )}
      </div>
    </div>
  );
}
