"use client";

import { useState } from "react";
import type { PlanConfig } from "@/lib/plans";
import type { EpisodeUsage } from "@/lib/services/entitlementService";
import { selectPlan } from "./actions";
import { AppPage, PageHeader, Card, StatusBadge, ProgressBar, Button, ErrorState } from "@/components/studio";

export default function PlanClient({ plans, currentPlanId, usage, podcastCount }: { plans: PlanConfig[]; currentPlanId: string; usage: EpisodeUsage | null; podcastCount: number }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const current = plans.find(plan => plan.id === currentPlanId) ?? plans[0];
  const usedPct = usage?.limit ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  const atCap = !!usage && usage.limit !== null && usage.used >= usage.limit;
  const change = async (planId: string) => {
    setBusy(planId); setErr(null);
    const result = await selectPlan(planId);
    if (result?.success === false) setErr(result.error);
    setBusy(null);
    if (result?.success) window.location.reload();
  };

  return <AppPage>
    <PageHeader title="Plan and usage" description="See current production usage and compare the limits and capabilities available to your workspace." />
    <Card className="planProductionCurrent"><div><span className="epMeta">Current plan</span><h2>{current.name}</h2><p>{current.priceLabel}</p></div><div className="planProductionUsage"><div className="planProductionUsageHead"><span>Episodes {usage ? `· ${usage.periodLabel}` : "this period"}</span><strong>{usage?.used ?? 0}{usage?.limit !== null && usage?.limit !== undefined ? ` / ${usage.limit}` : " / ∞"}</strong></div><ProgressBar value={usage?.limit !== null && usage?.limit !== undefined ? usedPct : 4} label="Episode usage" /><div className="epMeta">Shows: {podcastCount}{current.maxPodcasts !== null ? ` / ${current.maxPodcasts}` : " / ∞"}</div>{atCap && <p className="planProductionWarning">This period’s episode allowance is fully used.</p>}</div></Card>
    {err && <ErrorState title="Plan change failed" description={err} />}
    <div className="planProductionGrid">{plans.map(plan => { const isCurrent = plan.id === currentPlanId; return <Card key={plan.id} className={`planProductionCard${isCurrent ? " isCurrent" : ""}`}><div className="planProductionCardHead"><h2>{plan.name}</h2>{isCurrent && <StatusBadge tone="success">Current</StatusBadge>}</div><strong className="planProductionPrice">{plan.priceLabel}</strong><p className="planProductionBlurb">{plan.blurb}</p><ul>{plan.features.map(feature => <li key={feature}>{feature}</li>)}</ul><Button variant={isCurrent ? "secondary" : "primary"} disabled={isCurrent || busy === plan.id} onClick={() => change(plan.id)}>{isCurrent ? "Current plan" : busy === plan.id ? "Updating…" : `Choose ${plan.name}`}</Button></Card>; })}</div>
  </AppPage>;
}
