// E2E-ONLY fault-injection seam.
//
// Completely INERT unless E2E_TEST_MODE === "1", which the Playwright harness
// sets on the dev server it spawns and which is never set in production. Every
// entry point re-checks the env, so the flag cannot be flipped (or read as true)
// by a normal deployment even if the route were somehow reached.

// Next bundles route handlers and server actions separately, so plain module
// scope is NOT shared between them. Hang the flag off globalThis (the same
// pattern this repo uses for its Prisma/Redis singletons) so the arming route
// and the action see one value within the single dev-server process.
const g = globalThis as unknown as { __podE2EForceStartDebateFailure?: boolean };

/** True only inside the Playwright harness's app process. */
export function e2eEnabled(): boolean {
  return process.env.E2E_TEST_MODE === "1";
}

/** Arm/disarm the simulated startDebate failure. No-op outside E2E mode. */
export function setForceStartDebateFailure(on: boolean): boolean {
  if (!e2eEnabled()) return false;
  g.__podE2EForceStartDebateFailure = on;
  return true;
}

/** Whether startDebate should return a structured failure right now. */
export function shouldFailStartDebate(): boolean {
  return e2eEnabled() && !!g.__podE2EForceStartDebateFailure;
}

/**
 * Stub the BullMQ/Redis enqueue in E2E only. Redis is an EXTERNAL boundary and
 * the harness runs without it; everything else in the action (auth, ownership,
 * the failure seam, revalidation) still executes for real. Inert in production.
 */
export function shouldStubQueue(): boolean {
  return e2eEnabled();
}
