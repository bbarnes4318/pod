import React from "react";
import { ALL_ACCENTS } from "../accent";

// Living style guide for the user surface. Everything on /app derives from
// what's on this page.

export const dynamic = "force-static";

export default function StyleGuide() {
  return (
    <>
      <div className="uTopbar">
        <h1 className="uPageTitle">Style guide</h1>
      </div>
      <div className="uContent" style={{ maxWidth: 880 }}>
        <p style={{ color: "var(--u-ink-2)", fontSize: "0.92rem", lineHeight: 1.6, marginBottom: "2rem" }}>
          Light, spacious, typography-led. Color belongs to <strong>content</strong>, not chrome:
          each episode and topic derives its own accent; the single brand blue is reserved for
          navigation and primary CTAs.
        </p>

        {/* Canvas */}
        <h2 className="uSectionTitle" style={{ marginBottom: "0.8rem" }}>Canvas & neutrals</h2>
        <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap", marginBottom: "2rem" }}>
          {[
            ["Canvas", "#FCFCFD"], ["Surface", "#FFFFFF"], ["Hairline", "#EEF0F3"],
            ["Ink", "#16181D"], ["Ink 2", "#6B7280"], ["Ink 3", "#9AA0AB"], ["Brand", "#3B5BFF"],
          ].map(([name, hex]) => (
            <div key={name} style={{ textAlign: "center", fontSize: "0.72rem", color: "var(--u-ink-2)" }}>
              <div style={{ width: 76, height: 52, borderRadius: 10, background: hex, border: "1px solid var(--u-hairline-2)", marginBottom: 5 }} />
              <strong style={{ display: "block", color: "var(--u-ink)" }}>{name}</strong>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.66rem" }}>{hex}</span>
            </div>
          ))}
        </div>

        {/* Content-derived accents */}
        <h2 className="uSectionTitle" style={{ marginBottom: "0.4rem" }}>Content-derived accents</h2>
        <p style={{ color: "var(--u-ink-2)", fontSize: "0.85rem", marginBottom: "0.9rem", lineHeight: 1.55 }}>
          <code style={{ background: "var(--u-canvas)", padding: "1px 6px", borderRadius: 5, border: "1px solid var(--u-hairline)" }}>
            accentFor(title)
          </code>{" "}
          hashes the item&apos;s title into a curated eight-hue wheel; topics anchor to their sport
          (basketball→coral, football→ocean, soccer→teal…). Each accent ships three strengths:
          <em> tint</em> (cover washes), <em>soft</em> (chips, tracks), <em>solid</em> (play buttons,
          played waveform).
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "0.8rem", marginBottom: "2rem" }}>
          {ALL_ACCENTS.map((a) => (
            <div key={a.name} style={{ border: "1px solid var(--u-hairline)", borderRadius: 12, overflow: "hidden", background: "#fff" }}>
              <div style={{ height: 44, background: `linear-gradient(135deg, ${a.soft}, ${a.tint})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ width: 26, height: 26, borderRadius: "50%", background: a.solid, display: "inline-block" }} />
              </div>
              <div style={{ padding: "0.5rem 0.7rem", fontSize: "0.72rem" }}>
                <strong style={{ textTransform: "capitalize" }}>{a.name}</strong>
                <span style={{ color: "var(--u-ink-3)", marginLeft: 6, fontFamily: "var(--font-mono)", fontSize: "0.64rem" }}>{a.solid}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Type scale */}
        <h2 className="uSectionTitle" style={{ marginBottom: "0.8rem" }}>Type scale — Inter</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.55rem", marginBottom: "2rem", background: "#fff", border: "1px solid var(--u-hairline)", borderRadius: 14, padding: "1.2rem 1.4rem" }}>
          <div style={{ fontSize: "2.15rem", fontWeight: 800, letterSpacing: "-0.022em" }}>Hero title · 34/800/-2%</div>
          <div style={{ fontSize: "1.7rem", fontWeight: 800, letterSpacing: "-0.02em" }}>Page title · 27/800</div>
          <div style={{ fontSize: "1.05rem", fontWeight: 750 }}>Section title · 17/750</div>
          <div style={{ fontSize: "0.9rem", fontWeight: 700 }}>Card title · 14.5/700</div>
          <div style={{ fontSize: "0.9rem", color: "var(--u-ink-2)" }}>Body · 14.5/400 · #6B7280</div>
          <div style={{ fontSize: "0.75rem", color: "var(--u-ink-3)" }}>Meta · 12/400 · #9AA0AB</div>
        </div>

        {/* Buttons */}
        <h2 className="uSectionTitle" style={{ marginBottom: "0.8rem" }}>Buttons</h2>
        <div style={{ display: "flex", gap: "0.8rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.6rem" }}>
          <button className="uPlayLg" style={{ background: "var(--u-brand)" }}>Primary CTA</button>
          <button className="uPlayLg" style={{ background: ALL_ACCENTS[0].solid }}>▶ Play (accent)</button>
          <button className="uGhostBtn">Secondary</button>
          <button className="uRecordBtn">Record this</button>
        </div>
        <p style={{ color: "var(--u-ink-3)", fontSize: "0.78rem", marginBottom: "2rem" }}>
          Brand blue = global actions only. Play buttons always wear their episode&apos;s accent.
        </p>

        {/* Card anatomy */}
        <h2 className="uSectionTitle" style={{ marginBottom: "0.8rem" }}>Card anatomy</h2>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "2rem" }}>
          {ALL_ACCENTS.slice(0, 3).map((a, i) => (
            <div key={a.name} className="uEpCard" style={{ width: 218 }}>
              <div className="uEpCover" style={{ background: `linear-gradient(135deg, ${a.soft}, ${a.tint} 70%)` }}>
                <span style={{ fontSize: "2.2rem" }}>{["🏀", "🏈", "⚽"][i]}</span>
              </div>
              <div className="uEpTitle">Sample episode title over two lines exactly</div>
              <div className="uEpMeta"><span style={{ color: a.deep, fontWeight: 700 }}>Max & Doc</span><span>·</span><span>12 min</span></div>
            </div>
          ))}
        </div>

        {/* Player anatomy */}
        <h2 className="uSectionTitle" style={{ marginBottom: "0.8rem" }}>Player bar</h2>
        <p style={{ color: "var(--u-ink-2)", fontSize: "0.85rem", lineHeight: 1.55, marginBottom: "1rem" }}>
          Persistent, quiet, bottom-fixed: cover thumb (accent tint) → title + speaking-host dot →
          transport (±15s, accent play) → waveform scrubber whose <strong>played portion takes the
          episode&apos;s accent</strong> → tabular timecode. Space bar toggles play anywhere.
        </p>
        <div style={{ border: "1px dashed var(--u-hairline-2)", borderRadius: 12, padding: "0.6rem", color: "var(--u-ink-3)", fontSize: "0.78rem", marginBottom: "3rem" }}>
          Live below ⬇ — pick any playable episode on Discover and the bar activates.
        </div>
      </div>
    </>
  );
}
