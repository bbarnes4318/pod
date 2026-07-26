// Deployment stage policy for hosted trial endpoints.
//
// NODE_ENV is the WRONG signal for this decision: development and staging
// deployments routinely run production builds, so gating NVIDIA on
// NODE_ENV=production would disable it in exactly the environments it is meant
// for. APP_DEPLOYMENT_STAGE states the operator's intent directly.
//
//   development | staging — hosted NVIDIA endpoints fully permitted, silently.
//   live                  — hosted NVIDIA endpoints STILL PERMITTED, with an
//                           advisory that hosted access is a trial service
//                           whose capacity, terms and availability should be
//                           reviewed before customer traffic begins.
//
// The advisory never changes a provider, never disables a route, and never
// blocks a deploy. The launch decision belongs to the operator.

import { readRoutingEnv } from "./routingEnv";

export type DeploymentStage = "development" | "staging" | "live";

export const DEPLOYMENT_STAGES: DeploymentStage[] = ["development", "staging", "live"];

/** Unset or unrecognized → development (the application's current stage). */
export function activeDeploymentStage(): DeploymentStage {
  const raw = (readRoutingEnv("APP_DEPLOYMENT_STAGE") || "").trim().toLowerCase();
  if ((DEPLOYMENT_STAGES as string[]).includes(raw)) return raw as DeploymentStage;
  return "development";
}

/** Providers whose hosted endpoints are trial/free-tier services. */
export const TRIAL_HOSTED_PROVIDERS = ["nvidia", "zai"] as const;

export function isTrialHostedProvider(provider: string): boolean {
  return (TRIAL_HOSTED_PROVIDERS as readonly string[]).includes(provider.toLowerCase());
}

export interface StageAdvisory {
  stage: DeploymentStage;
  /** Advisory text, or null when nothing needs saying. */
  message: string | null;
  /** Always false — the stage never disables a provider. */
  blocksTrialProviders: false;
}

/**
 * Advisory for a resolved role map. `providersInUse` is the set of providers the
 * active profile would actually call.
 */
export function stageAdvisory(providersInUse: string[]): StageAdvisory {
  const stage = activeDeploymentStage();
  const trial = [...new Set(providersInUse.map((p) => p.toLowerCase()))].filter(isTrialHostedProvider);
  if (stage !== "live" || trial.length === 0) {
    return { stage, message: null, blocksTrialProviders: false };
  }
  return {
    stage,
    message:
      `APP_DEPLOYMENT_STAGE=live and the active routing profile calls hosted trial endpoints (${trial.join(", ")}). ` +
      `Hosted NVIDIA NIM and Z.ai free access are intended for development, prototyping and evaluation: review capacity, ` +
      `rate limits, data-handling terms and availability guarantees before customer traffic begins. ` +
      `Nothing has been disabled or re-routed — set LLM_ROUTING_PROFILE=legacy to return to the paid providers, or keep ` +
      `this profile deliberately.`,
    blocksTrialProviders: false,
  };
}
