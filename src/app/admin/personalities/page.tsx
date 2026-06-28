import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import HostStatusToggle from "./HostStatusToggle";
import "./personalities.css";

// Force Next.js to server-render on demand
export const dynamic = "force-dynamic";

export default async function PersonalitiesPage() {
  const hosts = await db.aiHost.findMany({
    orderBy: { createdAt: "asc" },
  });

  const getArray = (val: any): string[] => {
    if (Array.isArray(val)) return val as string[];
    return [];
  };

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Title Header */}
      <div className="personalitiesHeader">
        <div className="titleGroup">
          <h2>AI Host Personalities</h2>
          <p>Configure worldviews, debate style rules, and TTS engine settings for the on-air hosts.</p>
        </div>
        <Link href="/admin/personalities/new" className="buttonPrimary" style={{ textDecoration: "none" }}>
          + Add New Host
        </Link>
      </div>

      {hosts.length === 0 ? (
        <div className="panel" style={{ textAlign: "center", padding: "3rem" }}>
          <p style={{ color: "#94a3b8", fontSize: "1.1rem" }}>No AI Hosts registered in the database.</p>
          <p style={{ color: "#64748b", fontSize: "0.9rem", marginTop: "0.5rem" }}>
            Run the prisma seed script or click "+ Add New Host" to configure one.
          </p>
        </div>
      ) : (
        <div className="hostGrid">
          {hosts.map((host) => {
            const catchphrases = getArray(host.catchphrases);
            const likes = getArray(host.likes);
            const dislikes = getArray(host.dislikes);
            const argumentPatterns = getArray(host.argumentPatterns);
            const bannedPhrases = getArray(host.bannedPhrases);

            return (
              <div className="hostCard" key={host.id}>
                {/* Card Top Title Block */}
                <div className="hostCardHeader">
                  <div>
                    <h3 className="hostName">{host.name}</h3>
                    <div className="hostRole">{host.role}</div>
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "#64748b", fontFamily: "var(--font-mono)" }}>
                    slug: <span style={{ color: "#e2e8f0" }}>{host.slug}</span>
                  </div>
                </div>

                {/* Card Main Body Specs */}
                <div className="hostBody">
                  {/* Worldview */}
                  <div className="hostSection">
                    <span className="sectionLabel">Worldview</span>
                    <p className="sectionText">{host.worldview}</p>
                  </div>

                  {/* Speaking Style */}
                  <div className="hostSection">
                    <span className="sectionLabel">Speaking Style</span>
                    <p className="sectionText">{host.speakingStyle}</p>
                  </div>

                  {/* Catchphrases */}
                  {catchphrases.length > 0 && (
                    <div className="hostSection">
                      <span className="sectionLabel">Catchphrases</span>
                      <div className="tagContainer">
                        {catchphrases.map((item, idx) => (
                          <span className="tag" key={idx}>“{item}”</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Likes / Dislikes split row */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                    {likes.length > 0 && (
                      <div className="hostSection">
                        <span className="sectionLabel">Likes</span>
                        <div className="tagContainer">
                          {likes.map((item, idx) => (
                            <span className="tag" key={idx} style={{ color: "#10b981" }}>{item}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {dislikes.length > 0 && (
                      <div className="hostSection">
                        <span className="sectionLabel">Dislikes</span>
                        <div className="tagContainer">
                          {dislikes.map((item, idx) => (
                            <span className="tag" key={idx} style={{ color: "#ef4444" }}>{item}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Argument Patterns */}
                  {argumentPatterns.length > 0 && (
                    <div className="hostSection">
                      <span className="sectionLabel">Argument Patterns</span>
                      <ul style={{ listStyleType: "square", paddingLeft: "1.2rem", fontSize: "0.9rem", color: "#cbd5e1" }}>
                        {argumentPatterns.map((item, idx) => (
                          <li key={idx} style={{ marginBottom: "0.25rem" }}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Banned Phrases */}
                  {bannedPhrases.length > 0 && (
                    <div className="hostSection">
                      <span className="sectionLabel">Banned Phrases</span>
                      <div className="tagContainer">
                        {bannedPhrases.map((item, idx) => (
                          <span className="tag tagBanned" key={idx}>{item}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* TTS & Level Specs */}
                  <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: "1rem", borderTop: "1px solid #161f30", paddingTop: "1rem", marginTop: "auto" }}>
                    <div className="hostSection">
                      <span className="sectionLabel">TTS Engine</span>
                      <span style={{ fontSize: "0.85rem", color: "#94a3b8", fontFamily: "var(--font-mono)" }}>
                        {host.ttsProvider} / {host.ttsVoiceId}
                      </span>
                    </div>
                    <div className="hostSection">
                      <span className="sectionLabel">Intensity Level</span>
                      <span style={{ fontSize: "0.85rem", fontWeight: "700", color: "#38bdf8", fontFamily: "var(--font-mono)" }}>
                        {host.intensityLevel} / 10
                      </span>
                    </div>
                  </div>
                </div>

                {/* Footer Toolbar */}
                <div className="hostCardFooter">
                  <HostStatusToggle hostId={host.id} initialStatus={host.isActive} />
                  <Link href={`/admin/personalities/${host.id}`} className="editButton" style={{ textDecoration: "none" }}>
                    Edit Profile
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
