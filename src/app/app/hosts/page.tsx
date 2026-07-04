import React from "react";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const HOST_STYLE: Record<string, { solid: string; soft: string; tint: string; deep: string; tagline: string }> = {
  "Max Voltage": { solid: "#E86A5E", soft: "#F8D9D5", tint: "#FDF1EF", deep: "#9C3B32", tagline: "The heart. Loud, loyal, allergic to spreadsheets." },
  "Dr. Linebreak": { solid: "#3E7BD6", soft: "#D5E2F7", tint: "#F0F5FD", deep: "#26518F", tagline: "The brain. Calm, surgical, married to the numbers." },
};

function arr(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

export default async function HostsPage() {
  const hosts = await db.aiHost.findMany({ orderBy: { createdAt: "asc" } }).catch(() => [] as any[]);

  return (
    <>
      <div className="uTopbar">
        <h1 className="uPageTitle">The hosts</h1>
      </div>
      <div className="uContent">
        <p style={{ color: "var(--u-ink-2)", fontSize: "0.9rem", marginBottom: "1.8rem", maxWidth: 560 }}>
          Two synthetic personalities built to collide. Every episode is their argument.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "1.2rem", maxWidth: 900 }}>
          {hosts.map((host) => {
            const s = HOST_STYLE[host.name] ?? HOST_STYLE["Max Voltage"];
            return (
              <div key={host.id} style={{ background: "var(--u-surface)", border: "1px solid var(--u-hairline)", borderRadius: 18, overflow: "hidden" }}>
                <div style={{ background: `linear-gradient(140deg, ${s.soft}, ${s.tint})`, padding: "1.6rem 1.5rem 1.2rem" }}>
                  <div style={{ width: 58, height: 58, borderRadius: "50%", background: s.solid, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.5rem", fontWeight: 800, marginBottom: "0.9rem" }}>
                    {host.name.split(" ").map((w: string) => w[0]).join("")}
                  </div>
                  <div style={{ fontSize: "1.35rem", fontWeight: 800, letterSpacing: "-0.015em" }}>{host.name}</div>
                  <div style={{ fontSize: "0.85rem", color: s.deep, fontWeight: 600, marginTop: 3 }}>{s.tagline}</div>
                </div>
                <div style={{ padding: "1.2rem 1.5rem 1.5rem" }}>
                  <p style={{ fontSize: "0.87rem", lineHeight: 1.6, color: "var(--u-ink-2)", marginBottom: "1rem", display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {host.worldview}
                  </p>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "1rem" }}>
                    <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--u-ink-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Intensity</span>
                    <div style={{ flex: 1, height: 6, borderRadius: 4, background: "var(--u-hairline)" }}>
                      <div style={{ width: `${host.intensityLevel * 10}%`, height: "100%", borderRadius: 4, background: s.solid }} />
                    </div>
                    <span style={{ fontSize: "0.78rem", fontWeight: 700, color: s.deep }}>{host.intensityLevel}/10</span>
                  </div>
                  {arr(host.catchphrases).length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                      {arr(host.catchphrases).slice(0, 4).map((c, i) => (
                        <span key={i} className="uHeat" style={{ background: s.tint, color: s.deep, fontWeight: 600, fontSize: "0.74rem" }}>
                          &ldquo;{c}&rdquo;
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
