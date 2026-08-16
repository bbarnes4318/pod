import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Version-skew protection. A tab loaded before a deploy keeps posting Server
  // Action IDs from the old build; the new server has never seen them and
  // answers "Failed to find Server Action", so the button is simply dead until
  // the user thinks to hard-reload. With a deployment id set, Next stamps
  // assets with `?dpl=` and sends `x-nextjs-deployment-id` back, and the client
  // reloads itself on a mismatch instead of failing.
  //
  // Undefined rather than "" when unset: an empty id would be stamped onto
  // every asset and compare equal across different builds, which is the broken
  // behaviour wearing a fix's clothes. The Dockerfile bakes the value in — see
  // the note there about why build and runtime must read the same one.
  deploymentId: process.env.NEXT_DEPLOYMENT_ID || undefined,
  experimental: {
    serverActions: {
      // Sound-design asset uploads (themes, beds, SFX packs) go through a
      // server action; the 1MB default can't fit an MP3.
      bodySizeLimit: "40mb",
    },
  },
};

export default nextConfig;
