import React from "react";
import { currentUser } from "@/lib/currentUser";
import { getEntitlementSummary } from "@/lib/services/entitlementService";
import { PLANS, PLAN_ORDER } from "@/lib/plans";
import PlanClient from "./PlanClient";

export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const user = await currentUser(); // the /studio layout already gates sign-in

  const summary = user ? await getEntitlementSummary(user.id) : null;
  const plans = PLAN_ORDER.map((id) => PLANS[id]);

  return (
    <PlanClient
      plans={plans}
      currentPlanId={summary?.plan.id ?? "free"}
      usage={summary?.usage ?? null}
      podcastCount={summary?.podcastCount ?? 0}
    />
  );
}
