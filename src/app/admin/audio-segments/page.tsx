import React from "react";
import { db } from "@/lib/db";
import Link from "next/link";
import "../scripts/scripts.css";

export const dynamic = "force-dynamic";

interface SearchParams {
  status?: string;
  episodeStatus?: string;
  provider?: string;
  search?: string;
}

interface PageProps {
  searchParams: Promise<SearchParams>;
}

export default async function AudioSegmentsDashboardPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const statusFilter = params.status || "";
  const episodeStatusFilter = params.episodeStatus || "";
  const providerFilter = params.provider || "";
  const searchFilter = params.search || "";

  // Query all scripts that are approved
  const where: any = {
    status: "approved",
  };

  if (statusFilter) {
    where.status = statusFilter;
  }
  if (episodeStatusFilter || searchFilter) {
    where.episode = {};
    if (episodeStatusFilter) {
      where.episode.status = episodeStatusFilter;
    }
    if (searchFilter) {
      where.episode.title = { contains: searchFilter, mode: "insensitive" };
    }
  }

  const scripts = await db.script.findMany({
    where,
    include: {
      episode: true,
      audioSegments: true,
      factCheckResults: {
        orderBy: { checkedAt: "desc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const list = scripts.map((s) => {
    const latestFactCheck = s.factCheckResults[0];
    const totalLines = Array.isArray((s.content as any)?.segments)
      ? (s.content as any).segments.reduce((acc: number, seg: any) => acc + (seg.lines?.length || 0), 0)
      : 0;

    const readyCount = s.audioSegments.filter((a) => a.status === "ready").length;
    const failedCount = s.audioSegments.filter((a) => a.status === "failed").length;
    const pendingCount = s.audioSegments.filter((a) => a.status === "pending" || a.status === "processing").length;

    // Load active host config for provider check
    const provider = s.audioSegments[0]?.audioUrl
      ? "TTS Run"
      : process.env.TTS_PROVIDER || "stub";

    return {
      id: s.id,
      episodeId: s.episodeId,
      episodeTitle: s.episode.title,
      episodeStatus: s.episode.status,
      version: s.version,
      status: s.status,
      latestFactCheckStatus: latestFactCheck ? latestFactCheck.status : "missing",
      totalLines,
      readyCount,
      failedCount,
      pendingCount,
      provider,
    };
  });

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Header */}
      <div className="scriptsHeader">
        <div>
          <h2 className="pageTitle">TTS Dialogue Audio Segments</h2>
          <p className="pageDesc">
            Generate and manage separate high-fidelity voice lines for hosts Max Voltage and Dr. Linebreak.
          </p>
        </div>
      </div>

      {/* Filters Form */}
      <form method="GET" className="panel" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr auto", gap: "1rem", alignItems: "end", padding: "1.25rem", marginBottom: "1.5rem" }}>
        <div className="formGroup" style={{ marginBottom: 0 }}>
          <label className="label">Search Episode Title</label>
          <input
            type="text"
            name="search"
            defaultValue={searchFilter}
            className="input"
            placeholder="Search..."
          />
        </div>

        <div className="formGroup" style={{ marginBottom: 0 }}>
          <label className="label">Episode Status</label>
          <select name="episodeStatus" defaultValue={episodeStatusFilter} className="select">
            <option value="">All Statuses</option>
            <option value="fact_checked">Fact Checked</option>
            <option value="audio_segments_ready">Audio Segments Ready</option>
            <option value="completed">Completed</option>
          </select>
        </div>

        <div className="formGroup" style={{ marginBottom: 0 }}>
          <label className="label">TTS Provider</label>
          <select name="provider" defaultValue={providerFilter} className="select">
            <option value="">All Providers</option>
            <option value="elevenlabs">ElevenLabs</option>
            <option value="cartesia">Cartesia</option>
            <option value="openai">OpenAI TTS</option>
            <option value="boson">Boson</option>
            <option value="stub">Stub</option>
          </select>
        </div>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button type="submit" className="buttonPrimary" style={{ padding: "0.5rem 1.25rem" }}>
            Filter
          </button>
          <Link href="/admin/audio-segments" className="btnReset" style={{ padding: "0.5rem 1.25rem", textDecoration: "none", fontSize: "0.85rem" }}>
            Reset
          </Link>
        </div>
      </form>

      {/* Table */}
      {list.length === 0 ? (
        <div className="emptyState">
          <div className="emptyStateTitle">No audio segments found.</div>
          <div className="emptyStateDesc">
            Generate TTS only after script approval and passed fact check. Go to the <Link href="/admin/scripts" style={{ color: "var(--accent-color)", textDecoration: "underline" }}>Script Review</Link> console to approve a script.
          </div>
        </div>
      ) : (
        <div className="tableContainer">
          <table className="table">
            <thead>
              <tr>
                <th>Episode Title</th>
                <th style={{ width: "80px", textAlign: "center" }}>Version</th>
                <th>Episode Status</th>
                <th>Fact Check</th>
                <th>Default Provider</th>
                <th style={{ textAlign: "center" }}>Dialogue Lines</th>
                <th style={{ textAlign: "center" }}>Ready</th>
                <th style={{ textAlign: "center" }}>Failed</th>
                <th style={{ textAlign: "center" }}>Pending</th>
                <th style={{ width: "120px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((item) => {
                return (
                  <tr key={item.id}>
                    <td>
                      <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{item.episodeTitle}</span>
                    </td>
                    <td style={{ textAlign: "center", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                      v{item.version}
                    </td>
                    <td>
                      <span className="refBadge" style={{ fontSize: "0.75rem" }}>{item.episodeStatus}</span>
                    </td>
                    <td>
                      <span className={`badge ${
                        item.latestFactCheckStatus === "passed"
                          ? "badgeCompleted"
                          : item.latestFactCheckStatus === "failed"
                          ? "badgeFailed"
                          : "badgePending"
                      }`}>
                        {item.latestFactCheckStatus}
                      </span>
                    </td>
                    <td style={{ fontSize: "0.85rem", color: "var(--text-primary)", textTransform: "capitalize" }}>
                      {item.provider}
                    </td>
                    <td style={{ textAlign: "center", fontWeight: 700 }}>
                      {item.totalLines}
                    </td>
                    <td style={{ textAlign: "center", color: item.readyCount === item.totalLines ? "var(--success-color)" : "var(--text-primary)", fontWeight: 700 }}>
                      {item.readyCount}
                    </td>
                    <td style={{ textAlign: "center", color: item.failedCount > 0 ? "var(--error-color)" : "var(--text-primary)", fontWeight: 600 }}>
                      {item.failedCount}
                    </td>
                    <td style={{ textAlign: "center", color: item.pendingCount > 0 ? "var(--warning-color)" : "var(--text-secondary)", fontWeight: 600 }}>
                      {item.pendingCount}
                    </td>
                    <td>
                      <Link href={`/admin/audio-segments/${item.id}`} className="editButton" style={{ display: "inline-block", fontSize: "0.8rem", padding: "0.25rem 0.6rem", textDecoration: "none" }}>
                        Console
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
