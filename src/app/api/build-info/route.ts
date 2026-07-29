import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Public, secret-free deployment identity. This lets the browser prove which
 * WEB container is serving the UI instead of trusting a deploy screen or a
 * successful worker rollout.
 */
export async function GET() {
  return NextResponse.json(
    {
      service: "take-machine-web",
      sourceCommit: process.env.SOURCE_COMMIT || process.env.NEXT_PUBLIC_BUILD_SHA || "unknown",
      branch: process.env.COOLIFY_BRANCH || "unknown",
      container: process.env.COOLIFY_CONTAINER_NAME || "unknown",
      release: "show-forge-visible-v1",
      capabilities: {
        showForge: true,
        hostStudio: true,
        frozenStorylineAssignments: true,
      },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
