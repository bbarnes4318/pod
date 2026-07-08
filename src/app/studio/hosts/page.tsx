import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

function arr(val: unknown): string[] {
  return Array.isArray(val) ? (val as string[]) : [];
}

export default async function HostsPage() {
  const hosts = await db.aiHost.findMany({ orderBy: { createdAt: "asc" } });

  return (
    <div className="fadeUp">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h1 className="pageTitle">The hosts</h1>
          <p className="pageSub" style={{ marginBottom: 0 }}>
            Two personalities engineered to collide. Their worldviews, patterns, and voices drive every episode.
          </p>
        </div>
        <Link href="/admin/voices" className="btnGhost">🎙 Browse & assign voices</Link>
      </div>

      <div className="grid2" style={{ marginTop: "2rem" }}>
        {hosts.map((host, i) => {
          // Two-host colour alternation keys off roster position, not a host
          // name — the second chair reads blue, the first orange.
          const isSecond = i % 2 === 1;
          const accent = isSecond ? "#58a6ff" : "var(--accent-color)";
          return (
            <div key={host.id} className="studioCard" style={{ borderTop: `3px solid ${accent}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
                <div>
                  <div className="displayTitle" style={{ fontSize: "1.8rem", color: accent }}>{host.name}</div>
                  <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginTop: 4 }}>{host.role}</div>
                </div>
                <span className={`chip ${host.isActive ? "chipSuccess" : ""}`}>{host.isActive ? "On air" : "Benched"}</span>
              </div>

              {/* Intensity dial */}
              <div className="axisRow" style={{ margin: "1rem 0" }}>
                <span>Intensity</span>
                <div className="scoreBarTrack">
                  <div className="scoreBarFill" style={{ width: `${host.intensityLevel * 10}%`, background: isSecond ? "linear-gradient(90deg,#2b6cb0,#58a6ff)" : undefined }} />
                </div>
                <strong>{host.intensityLevel}/10</strong>
              </div>

              <p style={{ fontSize: "0.88rem", lineHeight: 1.6, color: "var(--text-primary)", marginBottom: "1rem" }}>
                {host.worldview}
              </p>

              {arr(host.catchphrases).length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "1rem" }}>
                  {arr(host.catchphrases).slice(0, 5).map((c, i) => (
                    <span key={i} className="chip" style={{ textTransform: "none", letterSpacing: 0 }}>&ldquo;{c}&rdquo;</span>
                  ))}
                </div>
              )}

              <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
                <Link href={`/admin/personalities/${host.id}`} className="btnGhost">Edit personality</Link>
                <Link href="/admin/voices" className="btnGhost">Change voice</Link>
              </div>
              <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", marginTop: "0.75rem", fontFamily: "var(--font-mono)" }}>
                voice: {host.ttsProvider} · {host.ttsVoiceId.slice(0, 18)}{host.ttsVoiceId.length > 18 ? "…" : ""}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
