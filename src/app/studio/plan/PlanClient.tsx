"use client";

// Plan & usage surface (Step 9c). Shows the current plan, REAL usage this period
// (episodes generated / cap, from actual Episode rows), and the tier ladder with
// what each unlocks. Switching plans is a manual, no-charge placeholder for a
// future billing integration — labelled as such.

import React, { useState } from "react";
import type { PlanConfig } from "@/lib/plans";
import type { EpisodeUsage } from "@/lib/services/entitlementService";
import { selectPlan } from "./actions";

export default function PlanClient({
  plans, currentPlanId, usage, podcastCount,
}: {
  plans: PlanConfig[];
  currentPlanId: string;
  usage: EpisodeUsage | null;
  podcastCount: number;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const current = plans.find((p) => p.id === currentPlanId) ?? plans[0];

  const usedPct =
    usage && usage.limit ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  const atCap = usage && usage.limit !== null && usage.used >= usage.limit;

  const change = async (planId: string) => {
    setBusy(planId); setErr(null);
    const res: any = await selectPlan(planId);
    if (res?.success === false) setErr(res.error);
    setBusy(null);
    // Server revalidates; a soft reload reflects the new plan + usage limits.
    if (res?.success) window.location.reload();
  };

  return (
    <div className="fadeUp">
      <h1 className="pageTitle">Plan &amp; usage</h1>
      <p className="pageSub">Your tier, what you&apos;ve used this month, and what each plan unlocks.</p>

      {/* Current plan + real usage */}
      <div className="studioCard planCurrent">
        <div>
          <div className="planCurLabel">Current plan</div>
          <div className="planCurName">{current.name}</div>
          <div className="planCurPrice">{current.priceLabel}</div>
        </div>
        <div className="planUsage">
          <div className="planUsageHead">
            <span>Episodes this period{usage ? ` · ${usage.periodLabel}` : ""}</span>
            <strong>
              {usage ? usage.used : 0}
              {usage && usage.limit !== null ? ` / ${usage.limit}` : " / ∞"}
            </strong>
          </div>
          <div className="scoreBarTrack">
            <div className={`scoreBarFill${atCap ? " planCapHit" : ""}`} style={{ width: `${usage && usage.limit !== null ? usedPct : 6}%` }} />
          </div>
          {atCap && <div className="planCapNote">You&apos;ve hit this month&apos;s cap — generation is blocked until you upgrade or it resets.</div>}
          <div className="planUsageSub">Podcasts: {podcastCount}{current.maxPodcasts !== null ? ` / ${current.maxPodcasts}` : " / ∞"}</div>
        </div>
      </div>

      {err && <div className="gateResult gate-err" style={{ marginTop: "1rem" }}>{err}</div>}

      {/* Tier ladder */}
      <div className="planGrid">
        {plans.map((p) => {
          const isCurrent = p.id === currentPlanId;
          return (
            <div key={p.id} className={`studioCard planCard${isCurrent ? " planCardCurrent" : ""}`}>
              <div className="planCardHead">
                <span className="planCardName">{p.name}</span>
                {isCurrent && <span className="chip chipSuccess">Current</span>}
              </div>
              <div className="planCardPrice">{p.priceLabel}</div>
              <p className="planCardBlurb">{p.blurb}</p>
              <ul className="planFeatures">
                {p.features.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
              <button
                type="button"
                className={isCurrent ? "btnGhost" : "btnPrimary"}
                disabled={isCurrent || busy === p.id}
                onClick={() => change(p.id)}
                style={{ width: "100%", marginTop: "auto" }}
              >
                {isCurrent ? "Your plan" : busy === p.id ? "Switching…" : `Switch to ${p.name}`}
              </button>
            </div>
          );
        })}
      </div>

      <p className="anFoot">
        Billing isn&apos;t live yet — switching here is a manual placeholder that sets your tier so you can see limits + gating change. A real payment processor would write the same <code>User.plan</code> field via webhook. No card handling, no charges.
      </p>
    </div>
  );
}
