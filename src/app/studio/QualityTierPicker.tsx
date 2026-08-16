"use client";

// Quality tier picker — which models write this show.
//
// Three real options backed by measured routing (see qualityTiers.ts): Free,
// Balanced, Premium. Every number shown here is measured rather than marketed —
// costs priced against a real episode's token counts, durations from live
// provider probes.
//
// THE ONE RULE THIS COMPONENT EXISTS TO ENFORCE: the free tier's slowness is
// visible BEFORE the choice is committed, not discovered afterwards. Its writers
// answer in ~50s and ~32s per call against roughly 1s on Opus, so a free episode
// spends eight to ten minutes in the writing stages. A user who picks it without
// being told will conclude the app has hung — and nothing on screen would
// contradict them. Cost is recoverable information; a ten-minute silent wait is
// not.
//
// So: the duration sits in the option row itself, the warning renders inline on
// the selected card (never a tooltip, never behind a hover), and the confirm
// button restates the wait. tierBadge() already orders duration before price for
// any warned tier; this component must not re-order it.

import React, { useState } from "react";
import {
  QUALITY_TIERS,
  type QualityTier,
  tierBadge,
  tierInfo,
} from "../../lib/providers/llm/qualityTiers";

export interface QualityTierPickerProps {
  /** Currently persisted tier, or null when the show has never chosen one. */
  value: QualityTier | null;
  /** Persist the choice. Should resolve once saved. */
  onChange: (tier: QualityTier) => Promise<void> | void;
  /** Admin surfaces pass true to reveal the routing detail behind each tier. */
  showRoutingDetail?: boolean;
  disabled?: boolean;
}

export default function QualityTierPicker({
  value,
  onChange,
  showRoutingDetail = false,
  disabled = false,
}: QualityTierPickerProps) {
  const [pending, setPending] = useState<QualityTier | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The tier whose detail is shown: what the user is hovering toward, else what
  // is saved. Never a hardcoded default — an unchosen show shows no selection
  // rather than pretending Balanced was picked.
  const [preview, setPreview] = useState<QualityTier | null>(null);
  const focused = preview ?? value;

  async function choose(tier: QualityTier) {
    if (disabled || pending) return;
    setError(null);
    setPending(tier);
    try {
      await onChange(tier);
    } catch (err) {
      setError((err as Error)?.message || "Could not save that choice.");
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="tier-picker" aria-labelledby="tier-picker-heading">
      <header>
        <h3 id="tier-picker-heading">Writing quality</h3>
        <p className="sub">Which models write this show&apos;s dialogue. You can change this any time.</p>
      </header>

      <div className="options" role="radiogroup" aria-labelledby="tier-picker-heading">
        {QUALITY_TIERS.map((tier) => {
          const info = tierInfo(tier);
          const selected = value === tier;
          const busy = pending === tier;
          return (
            <button
              key={tier}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled || !!pending}
              className={`option${selected ? " selected" : ""}`}
              onClick={() => choose(tier)}
              onMouseEnter={() => setPreview(tier)}
              onMouseLeave={() => setPreview(null)}
              onFocus={() => setPreview(tier)}
              onBlur={() => setPreview(null)}
            >
              <span className="name">
                {info.label}
                {busy ? <span className="busy" aria-live="polite"> saving…</span> : null}
              </span>
              {/* tierBadge puts DURATION FIRST for any tier carrying a speed
                  warning, so Free reads "~8-12 min · Free". Do not reformat. */}
              <span className="badge">{tierBadge(tier)}</span>
              <span className="summary">{info.summary}</span>
            </button>
          );
        })}
      </div>

      {focused ? (
        <div className="detail" aria-live="polite">
          {/* INLINE, not a tooltip. A warning the user must hover to see is a
              warning the user will not see. */}
          {tierInfo(focused).speedWarning ? (
            <p className="warn">
              <strong>Slower:</strong> {tierInfo(focused).speedWarning}
            </p>
          ) : null}
          <dl>
            <div>
              <dt>Writers</dt>
              <dd>{tierInfo(focused).writers}</dd>
            </div>
            <div>
              <dt>Dialogue</dt>
              <dd>{tierInfo(focused).qualityNote}</dd>
            </div>
            {showRoutingDetail ? (
              <div>
                <dt>Routing profile</dt>
                <dd>
                  <code>{tierInfo(focused).profile}</code>
                  {tierInfo(focused).billable ? " · bills your API accounts" : " · no model spend"}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}

      {value === null ? (
        <p className="unset">
          No tier chosen yet — this show uses the system default until you pick one.
        </p>
      ) : null}

      {error ? <p className="error" role="alert">{error}</p> : null}

      <style jsx>{`
        .tier-picker { display: flex; flex-direction: column; gap: 12px; }
        h3 { margin: 0; font-size: 15px; font-weight: 600; }
        .sub { margin: 2px 0 0; font-size: 13px; opacity: 0.75; }
        .options { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
        .option {
          display: flex; flex-direction: column; gap: 4px; text-align: left;
          padding: 12px; border-radius: 10px; cursor: pointer;
          border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
          background: var(--surface-2, transparent); color: inherit;
        }
        .option:hover:not(:disabled) { border-color: var(--accent, #6aa1ff); }
        .option:disabled { opacity: 0.6; cursor: default; }
        .option.selected { border-color: var(--accent, #6aa1ff); box-shadow: inset 0 0 0 1px var(--accent, #6aa1ff); }
        .name { font-weight: 600; font-size: 14px; }
        .busy { font-weight: 400; opacity: 0.7; font-size: 12px; }
        .badge { font-size: 12px; font-variant-numeric: tabular-nums; opacity: 0.85; }
        .summary { font-size: 12px; opacity: 0.7; line-height: 1.35; }
        .detail { border-radius: 10px; padding: 10px 12px; background: var(--surface-2, rgba(127, 127, 127, 0.08)); }
        .warn {
          margin: 0 0 8px; font-size: 13px; line-height: 1.4;
          padding: 8px 10px; border-radius: 8px;
          background: rgba(220, 150, 40, 0.14);
          border: 1px solid rgba(220, 150, 40, 0.4);
        }
        dl { margin: 0; display: flex; flex-direction: column; gap: 6px; }
        dl > div { display: grid; grid-template-columns: 92px 1fr; gap: 8px; }
        dt { font-size: 12px; opacity: 0.65; }
        dd { margin: 0; font-size: 13px; }
        code { font-size: 12px; }
        .unset, .error { margin: 0; font-size: 12px; }
        .unset { opacity: 0.7; }
        .error { color: #d66; }
      `}</style>
    </section>
  );
}
