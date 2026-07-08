"use server";

// Plan selection (Step 9c). MANUAL tier control — the sanctioned "set an
// account's tier" mechanism for now. NO payment processor, NO charge, NO card
// handling: this simply writes User.plan (the exact field a future billing
// webhook would update). Signed-in, self-scoped.

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/currentUser";
import { setUserPlanId } from "@/lib/services/entitlementService";
import { isPlanId } from "@/lib/plans";

export async function selectPlan(plan: string) {
  const user = await currentUser();
  if (!user) return { success: false as const, error: "Please sign in." };
  if (!isPlanId(plan)) return { success: false as const, error: "Unknown plan." };
  const res = await setUserPlanId(user.id, plan);
  if (!res.ok) return { success: false as const, error: res.error || "Couldn't change plan." };
  revalidatePath("/studio/plan");
  revalidatePath("/studio/create");
  return { success: true as const, plan };
}
