"use server";

// AI Quick Start: one model call that RECOMMENDS a show configuration.
// It saves nothing. Accepting a proposal calls the same createPodcast /
// createBusinessPodcast actions as the Custom path, so validation, plan caps
// and ownership stamping are identical.

import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { businessPodcastsEnabledFor } from "@/lib/business/intelligenceType";
import { assertCanCreatePodcast } from "@/lib/services/entitlementService";
import { getRoleLLMProvider } from "@/lib/providers/llm/factory";
import { roleHasRealProvider } from "@/lib/providers/llm/routing";
import { categoryOf, describeFailure, isBillingCategory, isConfigurationCategory } from "@/lib/providers/llm/errors";
import {
  QUICK_START_JSON_SCHEMA,
  buildQuickStartPrompt,
  normalizeQuickStartProposal,
  validateQuickStartShape,
  type QuickStartProposal,
} from "@/lib/shows/quickStart";

// The global (Sonnet-class) structured role, the same one the business
// follow-up questions use from a server action. Not the script writer.
const ROLE = "topic_classification" as const;

type Result =
  | { success: true; proposal: QuickStartProposal }
  | { success: false; error: string; unavailable?: boolean };

export async function recommendShowSetup(descriptionRaw: string): Promise<Result> {
  const user = await currentUser();
  if (!user) return { success: false, error: "Please sign in to create a show." };

  const description = String(descriptionRaw ?? "").trim().slice(0, 1200);
  if (description.length < 15) return { success: false, error: "Describe the show in a sentence or two first." };

  // Don't spend a model call on a show the plan won't allow.
  const gate = await assertCanCreatePodcast(user.id);
  if (!gate.ok) return { success: false, error: gate.error };

  if (!roleHasRealProvider(ROLE)) {
    return { success: false, unavailable: true, error: "The AI recommendation isn't available on this deployment. Use Custom to build the show yourself." };
  }

  // Same host visibility rule the create action enforces.
  const hosts = await db.aiHost.findMany({
    where: { isActive: true, isArchived: false, OR: [{ ownerId: user.id }, { ownerId: null }] },
    orderBy: { name: "asc" },
    select: { id: true, name: true, role: true },
  });
  const allowBusiness = businessPodcastsEnabledFor(user);

  let raw: unknown;
  try {
    const { systemPrompt, prompt } = buildQuickStartPrompt({ description, hosts, allowBusiness });
    raw = await getRoleLLMProvider(ROLE).generateStructuredOutput({
      systemPrompt,
      prompt,
      jsonSchema: QUICK_START_JSON_SCHEMA as unknown as Record<string, any>,
      validate: validateQuickStartShape,
      temperature: 0.4,
      maxTokens: 2000,
    });
  } catch (err) {
    console.error("[quick-start] recommendation failed:", describeFailure(err));
    const category = categoryOf(err);
    const error = isBillingCategory(category)
      ? "The AI provider account is out of credit, so no recommendation could be made. Use Custom to build the show yourself."
      : isConfigurationCategory(category)
        ? "The AI provider isn't set up correctly on this deployment. Use Custom to build the show yourself."
        : category === "structured_output_invalid_after_repair"
          ? "The recommendation came back unreadable. Try again, or use Custom."
          : "The recommendation couldn't be made right now. Try again in a moment, or use Custom.";
    return { success: false, unavailable: true, error };
  }

  return { success: true, proposal: normalizeQuickStartProposal(raw, { description, hosts, allowBusiness }) };
}
